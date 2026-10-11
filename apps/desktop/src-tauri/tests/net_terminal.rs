//! Telnet and raw TCP terminals against in-test TCP servers on loopback.
//! These servers are protocol fixtures, not a real telnetd or network device.
use new_windterm_desktop::{
    net_terminal::{Kind, NetTerminals, Target},
    pty::{EventSink, PtyEvent},
};
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::mpsc,
    time::Instant,
};

const IAC: u8 = 255;
const DONT: u8 = 254;
const DO: u8 = 253;
const WONT: u8 = 252;
const WILL: u8 = 251;
const SB: u8 = 250;
const SE: u8 = 240;
const ECHO: u8 = 1;
const SGA: u8 = 3;
const TTYPE: u8 = 24;
const NAWS: u8 = 31;
const TTYPE_IS: u8 = 0;
const TTYPE_SEND: u8 = 1;

const BUDGET: usize = 64 * 1024;
const BLOCKS: usize = 64;

fn id() -> String {
    uuid::Uuid::new_v4().to_string()
}

fn target(kind: Kind, port: u16) -> Target {
    Target {
        kind,
        host: "127.0.0.1".into(),
        port,
    }
}

fn events() -> (EventSink, mpsc::UnboundedReceiver<PtyEvent>) {
    let (sender, receiver) = mpsc::unbounded_channel();
    let sink: EventSink = Arc::new(move |event| sender.send(event).map_err(|e| e.to_string()));
    (sink, receiver)
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    needle.is_empty() || haystack.windows(needle.len()).any(|w| w == needle)
}

/// What a test server observed from the client.
#[derive(Default, Debug)]
struct Log {
    data: Vec<u8>,
    naws: Vec<(u16, u16)>,
    ttype: Vec<String>,
    eofs: usize,
    written: usize,
}
type Shared = Arc<Mutex<Log>>;

async fn wait(log: &Shared, what: &str, done: impl Fn(&Log) -> bool) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while !done(&log.lock().unwrap()) {
        assert!(
            Instant::now() < deadline,
            "server never saw {what}: {:?}",
            log.lock().unwrap()
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

/// The front end's side of one terminal: collects output and ACKs it in order.
struct Client {
    id: String,
    events: mpsc::UnboundedReceiver<PtyEvent>,
    output: Vec<u8>,
}

impl Client {
    async fn open(
        service: &Arc<NetTerminals>,
        kind: Kind,
        port: u16,
        cols: u16,
        rows: u16,
    ) -> Self {
        let (sink, events) = events();
        let id = service
            .open("main", &id(), target(kind, port), cols, rows, sink)
            .await
            .unwrap();
        Self {
            id,
            events,
            output: Vec::new(),
        }
    }

    async fn until(&mut self, service: &NetTerminals, wanted: &[u8]) {
        let deadline = Instant::now() + Duration::from_secs(10);
        while !contains(&self.output, wanted) {
            let event = tokio::time::timeout_at(deadline, self.events.recv())
                .await
                .unwrap_or_else(|_| {
                    panic!(
                        "missing {:?}; output {:?}",
                        String::from_utf8_lossy(wanted),
                        String::from_utf8_lossy(&self.output)
                    )
                })
                .expect("terminal event stream ended");
            match event {
                PtyEvent::Data { sequence, data, .. } => {
                    self.output.extend_from_slice(&data);
                    service.ack("main", &self.id, sequence).unwrap();
                }
                event => panic!("unexpected {event:?}"),
            }
        }
    }

    /// ACKs remaining output and returns the closing event.
    async fn end(&mut self, service: &NetTerminals) -> PtyEvent {
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                match self
                    .events
                    .recv()
                    .await
                    .expect("terminal event stream ended")
                {
                    PtyEvent::Data { sequence, data, .. } => {
                        self.output.extend_from_slice(&data);
                        let _ = service.ack("main", &self.id, sequence);
                    }
                    event => return event,
                }
            }
        })
        .await
        .expect("terminal did not close")
    }
}

#[derive(Default)]
enum ServerState {
    #[default]
    Data,
    Iac,
    Verb(u8),
    Sub,
    SubIac,
}

/// Minimal server-side Telnet decoder for the fixture.
#[derive(Default)]
struct ServerParser {
    state: ServerState,
    sub: Vec<u8>,
}

impl ServerParser {
    /// Returns decoded client data and negotiation replies.
    fn feed(&mut self, input: &[u8], log: &Shared) -> (Vec<u8>, Vec<u8>) {
        use ServerState::*;
        let (mut data, mut reply) = (Vec::new(), Vec::new());
        for &byte in input {
            self.state = match (std::mem::take(&mut self.state), byte) {
                (Data, IAC) => Iac,
                (Data, byte) => {
                    data.push(byte);
                    Data
                }
                (Iac, IAC) => {
                    data.push(IAC);
                    Data
                }
                (Iac, WILL | WONT | DO | DONT) => Verb(byte),
                (Iac, SB) => {
                    self.sub.clear();
                    Sub
                }
                (Iac, _) => Data,
                (Verb(WILL), TTYPE) => {
                    reply.extend_from_slice(&[IAC, SB, TTYPE, TTYPE_SEND, IAC, SE]);
                    Data
                }
                (Verb(_), _) => Data,
                (Sub, IAC) => SubIac,
                (Sub, byte) => {
                    self.sub.push(byte);
                    Sub
                }
                (SubIac, SE) => {
                    let mut log = log.lock().unwrap();
                    match self.sub.as_slice() {
                        [NAWS, w1, w0, h1, h0] => log.naws.push((
                            u16::from_be_bytes([*w1, *w0]),
                            u16::from_be_bytes([*h1, *h0]),
                        )),
                        [TTYPE, TTYPE_IS, name @ ..] => {
                            log.ttype.push(String::from_utf8_lossy(name).into())
                        }
                        other => panic!("unexpected subnegotiation {other:?}"),
                    }
                    Data
                }
                (SubIac, byte) => {
                    self.sub.push(byte); // IAC IAC inside SB
                    Sub
                }
            };
        }
        (data, reply)
    }
}

/// A Telnet server that offers ECHO and SGA, asks for NAWS and TTYPE, echoes
/// decoded data (escaping 0xFF) and hangs up after the line `quit`.
async fn telnet_server() -> (u16, Shared) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let log = Shared::default();
    let shared = log.clone();
    tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let greeting = [
            IAC, WILL, ECHO, IAC, WILL, SGA, IAC, DO, NAWS, IAC, DO, TTYPE,
        ];
        stream.write_all(&greeting).await.unwrap();
        stream.write_all(b"READY\r\n").await.unwrap();
        let mut parser = ServerParser::default();
        let mut buffer = [0; 4096];
        loop {
            let count = stream.read(&mut buffer).await.unwrap_or(0);
            if count == 0 {
                shared.lock().unwrap().eofs += 1;
                return;
            }
            let (data, mut out) = parser.feed(&buffer[..count], &shared);
            for &byte in &data {
                out.push(byte);
                if byte == IAC {
                    out.push(IAC);
                }
            }
            stream.write_all(&out).await.unwrap();
            let quit = {
                let mut log = shared.lock().unwrap();
                log.data.extend_from_slice(&data);
                log.data.ends_with(b"quit\r\n")
            };
            if quit {
                let _ = stream.shutdown().await;
                return;
            }
        }
    });
    (port, log)
}

#[derive(Clone, Copy)]
enum Raw {
    /// Echoes every byte unchanged until the client closes.
    Echo,
    /// Writes this many pattern bytes, then closes its sending side.
    Flood(usize),
    /// Says goodbye and closes.
    Hangup,
    /// Keeps the connection open but never reads from it.
    Silent,
}

fn pattern(index: usize) -> u8 {
    (index % 251) as u8
}

async fn raw_server(mode: Raw) -> (u16, Shared) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let log = Shared::default();
    let shared = log.clone();
    tokio::spawn(async move {
        loop {
            let (stream, _) = listener.accept().await.unwrap();
            tokio::spawn(raw_connection(stream, mode, shared.clone()));
        }
    });
    (port, log)
}

async fn raw_connection(mut stream: TcpStream, mode: Raw, log: Shared) {
    match mode {
        Raw::Echo => {}
        Raw::Flood(total) => {
            let mut sent = 0;
            while sent < total {
                let block: Vec<u8> = (sent..total.min(sent + 64 * 1024)).map(pattern).collect();
                if stream.write_all(&block).await.is_err() {
                    return;
                }
                sent += block.len();
                log.lock().unwrap().written = sent;
            }
            let _ = stream.shutdown().await;
        }
        Raw::Hangup => {
            let _ = stream.write_all(b"BYE\r\n").await;
            let _ = stream.shutdown().await;
            return;
        }
        Raw::Silent => std::future::pending::<()>().await,
    }
    let mut buffer = [0; 4096];
    loop {
        let count = stream.read(&mut buffer).await.unwrap_or(0);
        if count == 0 {
            log.lock().unwrap().eofs += 1;
            return;
        }
        log.lock().unwrap().data.extend_from_slice(&buffer[..count]);
        if matches!(mode, Raw::Echo) && stream.write_all(&buffer[..count]).await.is_err() {
            return;
        }
    }
}

#[tokio::test]
async fn telnet_negotiates_and_round_trips_utf8_0xff_and_window_size() {
    let (port, log) = telnet_server().await;
    let service = Arc::new(NetTerminals::default());
    let mut client = Client::open(&service, Kind::Telnet, port, 100, 30).await;
    client.until(&service, b"READY\r\n").await;
    wait(&log, "TTYPE and NAWS", |l| {
        l.ttype == ["xterm-256color"] && l.naws == [(100, 30)]
    })
    .await;

    // UTF-8 split inside a character across two writes and two echoes.
    let text = "中文 🌏".as_bytes();
    service
        .write("main", &client.id, text[..2].to_vec())
        .await
        .unwrap();
    service
        .write("main", &client.id, text[2..].to_vec())
        .await
        .unwrap();
    client.until(&service, text).await;
    // 0xFF is data: doubled on the wire both ways, restored at each end.
    let binary = [b'a', 0xFF, b'b', 0xFF, 0xFF];
    service
        .write("main", &client.id, binary.to_vec())
        .await
        .unwrap();
    client.until(&service, &binary).await;
    let typed = [text, &binary].concat();
    wait(&log, "decoded input", |l| l.data == typed).await;
    // Negotiation never reaches the terminal.
    assert_eq!(client.output, [b"READY\r\n".as_slice(), &typed].concat());

    // Resizes reach the server; 255 is escaped inside the NAWS payload.
    service.resize("main", &client.id, 255, 40).unwrap();
    wait(&log, "NAWS update", |l| l.naws.last() == Some(&(255, 40))).await;

    assert!(service
        .write("other", &client.id, b"x".to_vec())
        .await
        .is_err());
    assert!(service.resize("other", &client.id, 90, 30).is_err());
    assert!(service.ack("other", &client.id, 1).is_err());
    assert!(service.close("other", &client.id).is_err());
    assert!(service.write("main", &client.id, Vec::new()).await.is_err());
    assert!(service
        .write("main", &client.id, vec![0; 4097])
        .await
        .is_err());
    assert!(service.resize("main", &client.id, 0, 40).is_err());

    // Enter (CR) is sent as CR LF; the server then hangs up.
    service
        .write("main", &client.id, b"quit\r".to_vec())
        .await
        .unwrap();
    let event = client.end(&service).await;
    assert!(
        matches!(event, PtyEvent::Exit { code: None, .. }),
        "{event:?}"
    );
    assert!(client.output.ends_with(b"quit\r\n"));
    assert!(service
        .write("main", &client.id, b"x".to_vec())
        .await
        .is_err());
    service.ack("main", &client.id, 1).unwrap();
    service.close("main", &client.id).unwrap();
}

#[tokio::test]
async fn raw_tcp_is_byte_transparent_and_local_close_sends_fin() {
    let (port, log) = raw_server(Raw::Echo).await;
    let service = Arc::new(NetTerminals::default());
    let mut client = Client::open(&service, Kind::Raw, port, 80, 24).await;
    let all: Vec<u8> = (0..=255).collect();
    service
        .write("main", &client.id, all.clone())
        .await
        .unwrap();
    let text = "中文 🌏 é\r\n".as_bytes();
    service
        .write("main", &client.id, text[..1].to_vec())
        .await
        .unwrap();
    service
        .write("main", &client.id, text[1..].to_vec())
        .await
        .unwrap();
    // Raw TCP cannot report a window size; nothing is sent.
    service.resize("main", &client.id, 120, 40).unwrap();
    let expected = [all.as_slice(), text].concat();
    client.until(&service, &expected).await;
    assert_eq!(client.output, expected);
    wait(&log, "raw input", |l| l.data == expected).await;

    service.close("main", &client.id).unwrap();
    let event = client.end(&service).await;
    assert!(
        matches!(event, PtyEvent::Exit { code: None, .. }),
        "{event:?}"
    );
    wait(&log, "FIN", |l| l.eofs == 1).await;
    assert_eq!(log.lock().unwrap().data, expected);
    service.close("main", &client.id).unwrap();
}

#[tokio::test]
async fn withheld_acks_stop_reading_and_resume_without_loss() {
    const FLOOD: usize = 16 * 1024 * 1024;
    let (port, log) = raw_server(Raw::Flood(FLOOD)).await;
    let service = Arc::new(NetTerminals::default());
    let (sink, mut events) = events();
    let session = service
        .open("main", &id(), target(Kind::Raw, port), 80, 24, sink)
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(800)).await;
    let mut held = Vec::new();
    while let Ok(event) = events.try_recv() {
        match event {
            PtyEvent::Data { sequence, data, .. } => held.push((sequence, data)),
            event => panic!("unexpected {event:?}"),
        }
    }
    let delivered: usize = held.iter().map(|(_, data)| data.len()).sum();
    assert!(delivered > 0 && delivered <= BUDGET && held.len() <= BLOCKS);
    let written = log.lock().unwrap().written;
    // The server is blocked by TCP flow control, not buffered in this process.
    assert!(written < FLOOD, "server wrote everything: {written}");
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(events.try_recv().is_err(), "output beyond the ACK budget");

    let mut received = Vec::with_capacity(FLOOD);
    for (sequence, data) in held {
        received.extend_from_slice(&data);
        service.ack("main", &session, sequence).unwrap();
    }
    let mut client = Client {
        id: session,
        events,
        output: received,
    };
    let event = client.end(&service).await;
    assert!(
        matches!(event, PtyEvent::Exit { code: None, .. }),
        "{event:?}"
    );
    assert_eq!(client.output.len(), FLOOD);
    assert!(client
        .output
        .iter()
        .enumerate()
        .all(|(index, byte)| *byte == pattern(index)));
    eprintln!("flood: {written} of {FLOOD} bytes written while ACKs were withheld");
}

#[tokio::test]
async fn remote_close_capacity_and_window_reload() {
    let service = Arc::new(NetTerminals::default());
    let (port, _) = raw_server(Raw::Hangup).await;
    let mut client = Client::open(&service, Kind::Raw, port, 80, 24).await;
    let event = client.end(&service).await;
    assert!(
        matches!(event, PtyEvent::Exit { code: None, .. }),
        "{event:?}"
    );
    assert_eq!(client.output, b"BYE\r\n");
    service.close("main", &client.id).unwrap();

    let (port, log) = raw_server(Raw::Echo).await;
    let mut clients = Vec::new();
    for _ in 0..8 {
        clients.push(Client::open(&service, Kind::Raw, port, 80, 24).await);
    }
    let (sink, _events) = events();
    let error = service
        .open("main", &id(), target(Kind::Raw, port), 80, 24, sink)
        .await
        .unwrap_err();
    assert!(error.contains("at most 8"), "{error}");
    service.close_owner("other");
    service
        .write("main", &clients[7].id, b"ping".to_vec())
        .await
        .unwrap();
    clients[7].until(&service, b"ping").await;
    service.close_owner("main");
    for client in &mut clients {
        let event = client.end(&service).await;
        assert!(
            matches!(event, PtyEvent::Exit { code: None, .. }),
            "{event:?}"
        );
    }
    wait(&log, "eight FINs", |l| l.eofs == 8).await;
    // The reloaded window can open terminals again.
    let mut again = Client::open(&service, Kind::Raw, port, 80, 24).await;
    service
        .write("main", &again.id, b"pong".to_vec())
        .await
        .unwrap();
    again.until(&service, b"pong").await;
    service.shutdown();
    assert!(matches!(
        again.end(&service).await,
        PtyEvent::Exit { code: None, .. }
    ));
    let (sink, _events) = events();
    let error = service
        .open("main", &id(), target(Kind::Raw, port), 80, 24, sink)
        .await
        .unwrap_err();
    assert!(error.contains("shutting down"), "{error}");
}

#[tokio::test]
async fn input_to_a_peer_that_does_not_read_waits_instead_of_failing() {
    const LIMIT: usize = 64 * 1024 * 1024;
    let (port, _log) = raw_server(Raw::Silent).await;
    let service = Arc::new(NetTerminals::default());
    let mut client = Client::open(&service, Kind::Raw, port, 80, 24).await;
    let mut accepted = 0;
    // Socket buffers and the bounded queues fill, then a write waits.
    while accepted < LIMIT {
        let write = service.write("main", &client.id, vec![b'x'; 4096]);
        match tokio::time::timeout(Duration::from_millis(500), write).await {
            Ok(result) => {
                result.unwrap();
                accepted += 4096;
            }
            Err(_) => break,
        }
    }
    assert!(
        accepted > 0 && accepted < LIMIT,
        "input never waited: {accepted}"
    );
    service.close("main", &client.id).unwrap();
    let event = client.end(&service).await;
    assert!(
        matches!(event, PtyEvent::Exit { code: None, .. }),
        "{event:?}"
    );
    let error = service
        .write("main", &client.id, b"x".to_vec())
        .await
        .unwrap_err();
    assert_eq!(error, "Network terminal is closed");
    eprintln!("input: {accepted} bytes accepted before the write waited");
}

#[tokio::test]
async fn refused_and_invalid_targets_fail_without_a_session() {
    let service = Arc::new(NetTerminals::default());
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);
    let open = |target: Target, cols: u16| {
        let service = service.clone();
        async move {
            let (sink, _events) = events();
            service
                .open("main", &id(), target, cols, 24, sink)
                .await
                .unwrap_err()
        }
    };
    assert_eq!(
        open(target(Kind::Raw, port), 80).await,
        "TCP connection failed"
    );
    assert_eq!(
        open(target(Kind::Telnet, port), 80).await,
        "Telnet connection failed"
    );
    let mut bad = target(Kind::Telnet, 23);
    bad.host = "<img src=x>".into();
    assert_eq!(open(bad, 80).await, "Invalid Telnet host or port");
    assert_eq!(
        open(target(Kind::Raw, 0), 80).await,
        "Invalid TCP host or port"
    );
    assert_eq!(
        open(target(Kind::Raw, port), 0).await,
        "Invalid terminal size"
    );
}

/// Linux drops SYNs while a listener's accept queue is full, so `connect`
/// stalls in the kernel. macOS and Windows reset the connection instead; there
/// the test is skipped and the unit tests' never-completing connector covers
/// cancellation during connect.
#[tokio::test]
async fn close_during_a_stalled_tcp_connect_cancels_the_open() {
    let socket = tokio::net::TcpSocket::new_v4().unwrap();
    socket.bind("127.0.0.1:0".parse().unwrap()).unwrap();
    let listener = socket.listen(1).unwrap();
    let address = listener.local_addr().unwrap();
    let mut queued = Vec::new();
    let mut stalled = false;
    for _ in 0..32 {
        match tokio::time::timeout(Duration::from_millis(300), TcpStream::connect(address)).await {
            Ok(Ok(stream)) => queued.push(stream),
            Ok(Err(error)) => {
                eprintln!("skipped: this platform rejects overflowing connects ({error})");
                return;
            }
            Err(_) => {
                stalled = true;
                break;
            }
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    if !stalled {
        eprintln!("skipped: the accept queue never filled");
        return;
    }

    let service = Arc::new(NetTerminals::default());
    let session = id();
    let task = {
        let (service, session) = (service.clone(), session.clone());
        let (sink, _events) = events();
        tokio::spawn(async move {
            service
                .open(
                    "main",
                    &session,
                    target(Kind::Telnet, address.port()),
                    80,
                    24,
                    sink,
                )
                .await
        })
    };
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        let error = service
            .write("main", &session, b"x".to_vec())
            .await
            .unwrap_err();
        if error.contains("not connected yet") {
            break;
        }
        assert!(Instant::now() < deadline, "open never started: {error}");
        tokio::task::yield_now().await;
    }
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(!task.is_finished(), "connect did not stall");
    assert!(service.close("other", &session).is_err());
    service.close("main", &session).unwrap();
    let error = tokio::time::timeout(Duration::from_secs(2), task)
        .await
        .unwrap()
        .unwrap()
        .unwrap_err();
    assert_eq!(error, "Telnet connection cancelled");
    service.close("main", &session).unwrap();
    service.ack("main", &session, 1).unwrap();
    drop(queued);
    drop(listener);
}
