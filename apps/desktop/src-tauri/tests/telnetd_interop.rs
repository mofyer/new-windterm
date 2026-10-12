//! Interop with a real telnetd: Apple remote_cmds telnetd (Homebrew
//! `telnetd` 308) run as the current non-root user, one process per test,
//! fed a loopback socket inetd style. The tests are `#[ignore]`d so a plain
//! `cargo test` never starts telnetd; run them with
//! `cargo test --locked --manifest-path apps/desktop/src-tauri/Cargo.toml \
//!   --all-features --test telnetd_interop -- --ignored`.
//! Each test prints `skipped:` and passes when telnetd is missing or the
//! user is root. telnetd runs a harness program instead of login(1); see
//! `support/telnetd.rs`.
#![cfg(unix)]
#[path = "support/telnetd.rs"]
mod telnetd;

use new_windterm_desktop::{
    net_terminal::{Kind, NetTerminals, Target},
    pty::{EventSink, PtyEvent},
    telnet::Codec,
};
use std::{sync::Arc, time::Duration};
use telnetd::{
    assert_no_repeats, commands, count, find, loopback_pair, naws, Command, Program, Recorder,
    Telnetd, BINARY, DO, DONT, ECHO, IAC, NAWS, SGA, TTYPE, WILL, WONT,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
    sync::mpsc,
    time::Instant,
};

const WAIT: Duration = Duration::from_secs(10);
const QUIET: Duration = Duration::from_millis(300);

/// What the client sends in reply to telnetd's opening requests, in order.
/// The order follows telnetd 308's requests; another telnetd may differ.
fn expected_replies(cols: u16, rows: u16) -> Vec<Command> {
    const TSPEED: u8 = 32;
    const XDISPLOC: u8 = 35;
    const OLD_ENVIRON: u8 = 36;
    const NEW_ENVIRON: u8 = 39;
    const STATUS: u8 = 5;
    const LINEMODE: u8 = 34;
    const LFLOW: u8 = 33;
    const TIMING_MARK: u8 = 6;
    let mut ttype = vec![TTYPE, 0];
    ttype.extend_from_slice(b"xterm-256color");
    let mut size = vec![NAWS];
    size.extend(cols.to_be_bytes().into_iter().chain(rows.to_be_bytes()));
    vec![
        Command::Verb(WILL, TTYPE),
        Command::Verb(WONT, TSPEED),
        Command::Verb(WONT, XDISPLOC),
        Command::Verb(WONT, NEW_ENVIRON),
        Command::Verb(WONT, OLD_ENVIRON),
        Command::Sub(ttype),
        Command::Verb(DO, SGA),
        Command::Verb(WONT, ECHO),
        Command::Verb(WONT, LINEMODE),
        Command::Verb(WILL, NAWS),
        Command::Sub(size),
        Command::Verb(DONT, STATUS),
        Command::Verb(WONT, LFLOW),
        Command::Verb(DO, ECHO),
        Command::Verb(WONT, TIMING_MARK),
    ]
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    find(haystack, needle).is_some()
}

fn text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

/// Drives [`Codec`] directly over a socket to telnetd.
struct Driver {
    socket: TcpStream,
    codec: Codec,
    size: (u16, u16),
    naws_agreed: bool,
    /// Bytes before `DO NAWS` at which a resize was tried (and sent nothing).
    early_resizes: usize,
    received: Vec<u8>,
    data: Vec<u8>,
    sent: Vec<u8>,
    eof: bool,
}

impl Driver {
    fn new(socket: std::net::TcpStream, cols: u16, rows: u16) -> Self {
        socket.set_nonblocking(true).unwrap();
        Self {
            socket: TcpStream::from_std(socket).unwrap(),
            codec: Codec::new("xterm-256color", cols, rows),
            size: (cols, rows),
            naws_agreed: false,
            early_resizes: 0,
            received: Vec::new(),
            data: Vec::new(),
            sent: Vec::new(),
            eof: false,
        }
    }

    async fn send(&mut self, bytes: &[u8]) {
        self.sent.extend_from_slice(bytes);
        self.socket.write_all(bytes).await.unwrap();
    }

    /// Sends terminal input through the codec; returns the wire bytes.
    async fn input(&mut self, input: &[u8]) -> Vec<u8> {
        let wire = self.codec.send(input);
        self.send(&wire).await;
        wire
    }

    async fn resize(&mut self, cols: u16, rows: u16) {
        self.size = (cols, rows);
        let update = self.codec.resize(cols, rows);
        assert!(!update.is_empty(), "no NAWS update after negotiation");
        self.send(&update).await;
    }

    /// Feeds one byte at a time; until NAWS is agreed every byte first
    /// checks that a resize produces nothing for the wire.
    fn feed(&mut self, chunk: &[u8]) -> Vec<u8> {
        let mut reply = Vec::new();
        for &byte in chunk {
            if !self.naws_agreed {
                let early = self.codec.resize(self.size.0, self.size.1);
                assert!(early.is_empty(), "NAWS before negotiation: {early:?}");
                self.early_resizes += 1;
            }
            let received = self.codec.receive(&[byte]);
            if contains(&received.reply, &[IAC, WILL, NAWS]) {
                self.naws_agreed = true;
            }
            self.data.extend(received.data);
            reply.extend(received.reply);
        }
        reply
    }

    /// Reads one chunk before `deadline`; false on timeout.
    async fn read_once(&mut self, deadline: Instant) -> bool {
        let mut buffer = [0; 4096];
        let Ok(read) = tokio::time::timeout_at(deadline, self.socket.read(&mut buffer)).await
        else {
            return false;
        };
        let count = read.unwrap();
        if count == 0 {
            self.eof = true;
            return false;
        }
        self.received.extend_from_slice(&buffer[..count]);
        let reply = self.feed(&buffer[..count]);
        if !reply.is_empty() {
            self.send(&reply).await;
        }
        true
    }

    async fn until(&mut self, what: &str, done: impl Fn(&Self) -> bool) {
        let deadline = Instant::now() + WAIT;
        while !done(self) {
            let progressed = self.read_once(deadline).await;
            assert!(
                progressed || done(self),
                "never saw {what} (eof {}); data {:?}",
                self.eof,
                text(&self.data)
            );
        }
    }

    /// Takes whatever arrives within `period`.
    async fn settle(&mut self, period: Duration) {
        let deadline = Instant::now() + period;
        while !self.eof && self.read_once(deadline).await {}
    }
}

#[tokio::test]
#[ignore = "starts a real telnetd"]
async fn codec_negotiates_with_telnetd_through_both_login_prompts() {
    let Some(binary) = telnetd::binary() else {
        return;
    };
    let (client, server) = loopback_pair();
    // `-D options` makes telnetd report each option event in-band.
    let mut telnetd = Telnetd::spawn(&binary, &["-D", "options"], Program::Login, server);
    let mut driver = Driver::new(client, 100, 30);
    // The last option event and the prompt may arrive in either order.
    driver
        .until("the login prompt", |d| {
            contains(&d.data, b"login: ") && contains(&d.data, b"td: recv wont TIMING MARK")
        })
        .await;
    let log = text(&driver.data);
    for line in [
        "td: recv will TERMINAL TYPE",
        "td: recv suboption TERMINAL-TYPE IS \"xterm-256color\"",
        "td: recv do SUPPRESS GO AHEAD",
        "td: recv will NAWS",
        "td: recv suboption NAWS 0 100 (100) 0 30 (30)",
        "td: send will ECHO",
        "td: recv do ECHO",
    ] {
        assert!(log.contains(line), "telnetd did not report {line:?}: {log}");
    }
    // TTYPE was accepted the first time: telnetd never asked again.
    assert_eq!(count(&driver.data, b"TERMINAL-TYPE SEND"), 1, "{log}");
    assert_eq!(commands(&driver.sent), expected_replies(100, 30));
    assert_no_repeats(&driver.received, "telnetd");
    assert!(driver.early_resizes > 0 && driver.naws_agreed);
    assert!(driver.codec.server_echoes());
    // The banner's CR NUL reaches the terminal as CR; no option bytes leak.
    assert!(contains(&driver.received, b"\r\0\r\nDarwin/BSD ("));
    assert!(contains(&driver.data, b"\r\r\nDarwin/BSD ("));
    assert!(!driver.data.contains(&0) && !driver.data.contains(&IAC));
    // Negotiation has settled: nothing more arrives without input.
    let settled = driver.received.len();
    driver.settle(QUIET).await;
    assert_eq!(driver.received.len(), settled, "{:?}", text(&driver.data));

    driver.resize(132, 43).await;
    driver
        .until("the NAWS update", |d| {
            contains(&d.data, b"td: recv suboption NAWS 0 132 (132) 0 43 (43)")
        })
        .await;
    assert_eq!(naws(&driver.sent), [(100, 30), (132, 43)]);

    // Enter goes out as CR LF; the pty echoes the name once.
    assert_eq!(driver.input(b"alice\r").await, b"alice\r\n");
    driver
        .until("the password prompt", |d| d.data.ends_with(b"Password:"))
        .await;
    assert!(
        driver.data.ends_with(b"alice\r\nPassword:"),
        "{:?}",
        text(&driver.data)
    );
    assert!(driver.codec.server_echoes(), "server echo must stay on");
    driver.input(b"s3cret").await;
    driver.settle(QUIET).await;
    assert!(
        !contains(&driver.data, b"s3cret"),
        "the password was echoed"
    );

    // The program exits after the password; telnetd then hangs up.
    driver.input(b"\r").await;
    driver.until("the hang-up", |d| d.eof).await;
    assert!(driver
        .data
        .ends_with(b"Password:\r\nuser=[alice] pass-len=6\r\nLogin incorrect\r\n"));
    let status = telnetd.wait_exit(WAIT).await;
    assert!(telnetd.end_program(WAIT).await);
    eprintln!("telnetd exited with {status} after the program ended");
}

#[tokio::test]
#[ignore = "starts a real telnetd"]
async fn codec_bytes_cross_telnetd_and_its_pty_exactly() {
    let Some(binary) = telnetd::binary() else {
        return;
    };
    let (client, server) = loopback_pair();
    let mut telnetd = Telnetd::spawn(&binary, &["-h"], Program::Dump(9), server);
    let mut driver = Driver::new(client, 80, 24);
    driver
        .until("raw mode", |d| contains(&d.data, b"READY\r\n"))
        .await;
    let input = [b'x', IAC, b'y', b'\r', b'z', b'\r', b'\n', 0, b'w', b'\n'];
    let wire = driver.input(&input).await;
    // IAC is doubled; a bare CR and an existing CR LF both go out as CR LF.
    let expected = [
        b'x', IAC, IAC, b'y', b'\r', b'\n', b'z', b'\r', b'\n', 0, b'w', b'\n',
    ];
    assert_eq!(wire, expected);
    driver.until("the hang-up", |d| d.eof).await;
    // telnetd undoubled the IAC and dropped the LF after each CR, so the raw
    // pty read x FF y CR z CR NUL w LF. telnetd sent each CR not followed by
    // LF as CR NUL and 0xFF doubled; the codec restored the program's bytes.
    assert!(contains(&driver.received, b"a\r\0\0b\r\0\xff\xffc\r\n"));
    assert_eq!(
        driver.data,
        b"READY\r\nHEX:78ff790d7a0d00770a:END\r\na\r\0b\r\xffc\r\n"
    );
    telnetd.wait_exit(WAIT).await;
    assert!(telnetd.end_program(WAIT).await);
}

#[tokio::test]
#[ignore = "starts a real telnetd"]
async fn codec_binary_mode_with_telnetd_keeps_bare_cr_and_cr_nul() {
    let Some(binary) = telnetd::binary() else {
        return;
    };
    let (client, server) = loopback_pair();
    let mut telnetd = Telnetd::spawn(&binary, &["-h"], Program::Dump(6), server);
    let mut driver = Driver::new(client, 80, 24);
    driver
        .until("raw mode", |d| contains(&d.data, b"READY\r\n"))
        .await;
    // telnetd 308 never offers BINARY by itself, so ask for both directions;
    // the codec then sees the same WILL/DO BINARY a server offer would send.
    driver.send(&[IAC, DO, BINARY, IAC, WILL, BINARY]).await;
    driver
        .until("BINARY in both directions", |d| {
            let seen = commands(&d.received);
            seen.contains(&Command::Verb(WILL, BINARY)) && seen.contains(&Command::Verb(DO, BINARY))
        })
        .await;
    // RFC 856: no CR translation in binary mode, but IAC is still doubled.
    assert_eq!(driver.input(b"x\ry\r\n\xff").await, b"x\ry\r\n\xff\xff");
    driver.until("the hang-up", |d| d.eof).await;
    // telnetd passed the input through unchanged and sent the program's
    // CR NUL as is; the NUL is data and must reach the terminal.
    assert!(contains(&driver.received, b"a\r\0b\r\xff\xffc\r\n"));
    assert_eq!(
        driver.data,
        b"READY\r\nHEX:780d790d0aff:END\r\na\r\0b\r\xffc\r\n"
    );
    assert_no_repeats(&driver.received, "telnetd");
    telnetd.wait_exit(WAIT).await;
    assert!(telnetd.end_program(WAIT).await);
}

/// The front end's side of one terminal: collects output and ACKs it.
struct Client {
    id: String,
    events: mpsc::UnboundedReceiver<PtyEvent>,
    output: Vec<u8>,
}

impl Client {
    async fn open(service: &Arc<NetTerminals>, port: u16, cols: u16, rows: u16) -> Self {
        let (sender, events) = mpsc::unbounded_channel();
        let sink: EventSink = Arc::new(move |event| sender.send(event).map_err(|e| e.to_string()));
        let target = Target {
            kind: Kind::Telnet,
            host: "127.0.0.1".into(),
            port,
        };
        let id = uuid::Uuid::new_v4().to_string();
        let id = service
            .open("main", &id, target, cols, rows, sink)
            .await
            .unwrap();
        Self {
            id,
            events,
            output: Vec::new(),
        }
    }

    async fn write(&self, service: &NetTerminals, data: &[u8]) {
        service
            .write("main", &self.id, data.to_vec())
            .await
            .unwrap();
    }

    /// The end of the output, for failure messages.
    fn tail(&self) -> String {
        text(&self.output[self.output.len().saturating_sub(400)..])
    }

    /// Takes output and ACKs it in order until `done`; returns false if
    /// `period` passes first.
    async fn take(
        &mut self,
        service: &NetTerminals,
        period: Duration,
        done: impl Fn(&[u8]) -> bool,
    ) -> bool {
        let deadline = Instant::now() + period;
        while !done(&self.output) {
            let Ok(event) = tokio::time::timeout_at(deadline, self.events.recv()).await else {
                return false;
            };
            match event.expect("terminal event stream ended") {
                PtyEvent::Data { sequence, data, .. } => {
                    self.output.extend_from_slice(&data);
                    service.ack("main", &self.id, sequence).unwrap();
                }
                event => panic!("unexpected {event:?}; output ends {:?}", self.tail()),
            }
        }
        true
    }

    async fn until(&mut self, service: &NetTerminals, wanted: &[u8]) {
        let found = self
            .take(service, WAIT, |output| contains(output, wanted))
            .await;
        assert!(
            found,
            "missing {:?}; output ends {:?}",
            text(wanted),
            self.tail()
        );
    }

    /// Takes whatever arrives within `period`.
    async fn settle(&mut self, service: &NetTerminals, period: Duration) {
        self.take(service, period, |_| false).await;
    }

    /// ACKs remaining output and returns the closing event.
    async fn end(&mut self, service: &NetTerminals) -> PtyEvent {
        loop {
            let event = tokio::time::timeout(WAIT, self.events.recv())
                .await
                .expect("terminal did not close")
                .expect("terminal event stream ended");
            match event {
                PtyEvent::Data { sequence, data, .. } => {
                    self.output.extend_from_slice(&data);
                    let _ = service.ack("main", &self.id, sequence);
                }
                event => return event,
            }
        }
    }
}

async fn eventually(what: &str, check: impl Fn() -> bool) {
    let deadline = Instant::now() + WAIT;
    while !check() {
        assert!(Instant::now() < deadline, "never saw {what}");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

fn mentions_naws(stream: &[u8]) -> bool {
    commands(stream).iter().any(|command| match command {
        Command::Verb(_, option) => *option == NAWS,
        Command::Sub(payload) => payload.first() == Some(&NAWS),
    })
}

#[tokio::test]
#[ignore = "starts a real telnetd"]
async fn net_terminal_logs_in_through_telnetd_and_sees_the_remote_close() {
    let Some(binary) = telnetd::binary() else {
        return;
    };
    let mut recorder = Recorder::start(&binary, &[], Program::Login, true).await;
    let service = Arc::new(NetTerminals::default());
    let mut client = Client::open(&service, recorder.port, 100, 30).await;
    // telnetd has asked for NAWS, but the proxy holds that request back:
    // a resize now must not put anything about NAWS on the wire.
    eventually("the DO NAWS hold", || recorder.wire.lock().unwrap().holding).await;
    service.resize("main", &client.id, 120, 40).unwrap();
    tokio::time::sleep(QUIET).await;
    assert!(!mentions_naws(&recorder.wire.lock().unwrap().to_server));
    recorder.release();
    client.until(&service, b"login: ").await;
    let replies = expected_replies(120, 40);
    eventually("every reply", || {
        commands(&recorder.wire.lock().unwrap().to_server).len() >= replies.len()
    })
    .await;
    {
        let wire = recorder.wire.lock().unwrap();
        // The first NAWS already carries the size from the early resize.
        assert_eq!(naws(&wire.to_server), [(120, 40)]);
        assert_eq!(commands(&wire.to_server), replies);
        assert_no_repeats(&wire.to_server, "client");
        assert_no_repeats(&wire.to_client, "telnetd");
        assert!(contains(&wire.to_client, b"\r\0\r\nDarwin/BSD ("));
    }
    // CR NUL reaches the terminal as CR; the prompt is intact and last.
    assert!(client.output.starts_with(b"\r\r\nDarwin/BSD ("));
    assert!(client.output.ends_with(b")\r\r\n\r\r\nlogin: "));
    assert!(!client.output.contains(&0) && !client.output.contains(&IAC));
    client.settle(&service, QUIET).await;
    assert!(
        client.output.ends_with(b"login: "),
        "output after the prompt"
    );

    service.resize("main", &client.id, 132, 43).unwrap();
    eventually("the NAWS update", || {
        naws(&recorder.wire.lock().unwrap().to_server) == [(120, 40), (132, 43)]
    })
    .await;

    client.write(&service, b"alice\r").await;
    client.until(&service, b"Password:").await;
    assert!(client.output.ends_with(b"login: alice\r\nPassword:"));
    client.write(&service, b"s3cret").await;
    client.settle(&service, QUIET).await;
    assert!(
        client.output.ends_with(b"Password:"),
        "the password was echoed"
    );
    client.write(&service, b"\r").await;
    let event = client.end(&service).await;
    assert!(
        matches!(event, PtyEvent::Exit { code: None, .. }),
        "{event:?}"
    );
    assert!(client
        .output
        .ends_with(b"Password:\r\nuser=[alice] pass-len=6\r\nLogin incorrect\r\n"));
    {
        let wire = recorder.wire.lock().unwrap();
        assert!(contains(&wire.to_server, b"alice\r\ns3cret\r\n"));
        assert!(wire.server_eof);
    }
    recorder.telnetd.wait_exit(WAIT).await;
    assert!(recorder.telnetd.end_program(WAIT).await);
    // Late ACK and close after the remote hang-up are harmless.
    service.ack("main", &client.id, 1).unwrap();
    service.close("main", &client.id).unwrap();
}

#[tokio::test]
#[ignore = "starts a real telnetd"]
async fn net_terminal_drives_a_real_shell_through_telnetd_and_closes_locally() {
    let Some(binary) = telnetd::binary() else {
        return;
    };
    let mut recorder = Recorder::start(&binary, &["-h"], Program::Shell, false).await;
    let service = Arc::new(NetTerminals::default());
    let mut client = Client::open(&service, recorder.port, 100, 30).await;
    client.until(&service, b"p0$ ").await;

    // The pty got the initial NAWS size; TERM came from TTYPE.
    client
        .write(&service, b"stty size; echo \"T=$TERM\"\r")
        .await;
    client
        .until(&service, b"\r\n30 100\r\nT=xterm-256color\r\n")
        .await;
    service.resize("main", &client.id, 132, 43).unwrap();
    eventually("the NAWS update", || {
        naws(&recorder.wire.lock().unwrap().to_server).last() == Some(&(132, 43))
    })
    .await;
    client.write(&service, b"stty size\r").await;
    client.until(&service, b"\r\n43 132\r\n").await;

    // UTF-8 split inside a character is echoed and printed intact.
    let line = "echo 中文🌏é".as_bytes();
    client.write(&service, &line[..6]).await;
    client.write(&service, &line[6..]).await;
    client.write(&service, b"\r").await;
    client
        .until(&service, "中文🌏é\r\n中文🌏é\r\n".as_bytes())
        .await;

    // Output: a bare CR travels as CR NUL and 0xFF doubled, both restored.
    client.write(&service, b"printf 'a\\rb\\377c\\n'\r").await;
    client.until(&service, b"\r\na\rb\xffc\r\n").await;
    assert!(contains(
        &recorder.wire.lock().unwrap().to_client,
        b"a\r\0b\xff\xffc\r\n"
    ));

    // Input: the raw pty receives exactly what was typed, IAC and CR included.
    client
        .write(
            &service,
            b"/bin/stty raw -echo; printf 'R%sW>' A; /usr/bin/head -c 9 | /usr/bin/od -An -tx1 -v \
              | /usr/bin/tr -d ' \\n'; /bin/stty sane; printf '<%s\\n' END\r",
        )
        .await;
    client.until(&service, b"RAW>").await;
    client
        .write(
            &service,
            &[b'x', IAC, b'y', b'\r', b'z', b'\r', b'\n', 0, b'w', b'\n'],
        )
        .await;
    client
        .until(&service, b"RAW>78ff790d7a0d00770a<END\r\n")
        .await;
    assert!(contains(
        &recorder.wire.lock().unwrap().to_server,
        &[b'x', IAC, IAC, b'y', b'\r', b'\n', b'z', b'\r', b'\n', 0, b'w', b'\n'],
    ));
    {
        let wire = recorder.wire.lock().unwrap();
        assert_no_repeats(&wire.to_server, "client");
        assert_no_repeats(&wire.to_client, "telnetd");
    }

    // Local close: the FIN reaches telnetd, which exits.
    service.close("main", &client.id).unwrap();
    let event = client.end(&service).await;
    assert!(
        matches!(event, PtyEvent::Exit { code: None, .. }),
        "{event:?}"
    );
    eventually("the client FIN", || {
        recorder.wire.lock().unwrap().client_eof
    })
    .await;
    let status = recorder.telnetd.wait_exit(WAIT).await;
    // telnetd leaks the pty master into its program, so the shell is not
    // hung up when telnetd exits; the harness ends it (see support).
    let by_itself = recorder.telnetd.end_program(Duration::from_secs(1)).await;
    eprintln!("telnetd exited with {status} on FIN; shell ended by itself: {by_itself}");
    service.close("main", &client.id).unwrap();
}

#[tokio::test]
#[ignore = "starts a real telnetd"]
async fn net_terminal_keeps_bulk_output_exact_and_interrupts_through_telnetd() {
    let Some(binary) = telnetd::binary() else {
        return;
    };
    let mut recorder = Recorder::start(&binary, &["-h"], Program::Shell, false).await;
    // Every byte value plus CR NUL, CR LF, CR IAC, an IAC run and bare CRs;
    // about 240 KiB, so the 64 KiB ACK budget throttles the transfer.
    let block: Vec<u8> = (0..=255)
        .chain([b'\r', 0, b'\r', b'\n', b'\r', IAC, IAC, IAC, b'\r', b'\r'])
        .collect();
    let pattern = block.repeat(900);
    let file = recorder.telnetd.path("pattern.bin");
    std::fs::write(&file, &pattern).unwrap();
    let service = Arc::new(NetTerminals::default());
    let mut client = Client::open(&service, recorder.port, 100, 30).await;
    client.until(&service, b"p0$ ").await;

    // With OPOST off telnetd sends every bare CR as CR NUL and every IAC
    // doubled; the terminal must get the file back byte for byte.
    let command = format!(
        "/bin/stty raw -echo; printf 'B%sN>' EGI; /bin/cat '{}'; /bin/stty sane; printf '<%s\\n' END\r",
        file.display()
    );
    client.write(&service, command.as_bytes()).await;
    client.until(&service, b"<END\r\n").await;
    let start = find(&client.output, b"BEGIN>").expect("no start marker") + 6;
    let end = start + find(&client.output[start..], b"<END\r\n").unwrap();
    let received = &client.output[start..end];
    assert_eq!(received.len(), pattern.len());
    let first_difference = received.iter().zip(&pattern).position(|(a, b)| a != b);
    assert_eq!(first_difference, None, "output differs from the file");
    let wire = recorder.wire.lock().unwrap().to_client.len();
    eprintln!(
        "bulk: {} bytes delivered from {wire} wire bytes",
        pattern.len()
    );

    // Ctrl-C is plain data to telnetd; the pty turns it into SIGINT.
    client.write(&service, b"sleep 30\r").await;
    client.until(&service, b"sleep 30\r\n").await;
    tokio::time::sleep(QUIET).await;
    let prompts = count(&client.output, b"p0$ ");
    let started = Instant::now();
    client.write(&service, &[0x03]).await;
    let interrupted = client
        .take(&service, WAIT, |output| count(output, b"p0$ ") > prompts)
        .await;
    assert!(
        interrupted,
        "sleep was not interrupted: {:?}",
        client.tail()
    );
    assert!(started.elapsed() < Duration::from_secs(5));

    // `exit` ends the shell; telnetd then closes the connection.
    client.write(&service, b"exit\r").await;
    let event = client.end(&service).await;
    assert!(
        matches!(event, PtyEvent::Exit { code: None, .. }),
        "{event:?}"
    );
    recorder.telnetd.wait_exit(WAIT).await;
    assert!(recorder.telnetd.end_program(WAIT).await);
}
