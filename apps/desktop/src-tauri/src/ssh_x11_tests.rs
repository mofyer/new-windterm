//! X11 forwarding: setup checks, DISPLAY and xauth handling, and the loopback
//! russh fixture against a fake X server. `real_openssh_x11_forwarding` needs
//! OpenSSH, Xvfb and xauth: tests/fixtures/ssh-terminal/x11-client.test.mjs.
use super::*;
use crate::pty::PtyEvent;
use crate::ssh::{
    connect_routed,
    forward::fixture::{x11_setup, Fixture},
    Credential, Request,
};
use std::sync::atomic::{AtomicUsize, Ordering};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const REAL: [u8; COOKIE_LEN] = [
    0xa0, 0xa1, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xab, 0xac, 0xad, 0xae, 0xaf,
];
/// A setup with an 18-byte name and a 16-byte cookie.
const SETUP_LEN: usize = 48;

fn id() -> String {
    uuid::Uuid::new_v4().to_string()
}

#[test]
fn setups_in_both_byte_orders_carry_the_cookie_at_the_same_place() {
    let fake = [7; COOKIE_LEN];
    for order in *b"Bl" {
        let setup = x11_setup(order, PROTOCOL, &fake);
        assert_eq!(setup.len(), SETUP_LEN);
        for cut in 0..setup.len() {
            assert_eq!(check(&setup[..cut], &fake), Check::Incomplete, "{cut}");
        }
        assert_eq!(check(&setup, &fake), Check::Valid(32..48));
        let pipelined = [&setup[..], b"PING"].concat();
        assert_eq!(check(&pipelined, &fake), Check::Valid(32..48));
    }
}

#[test]
fn setups_without_exactly_the_fake_cookie_are_refused() {
    let fake = [7; COOKIE_LEN];
    let refused = |setup: Vec<u8>| assert_eq!(check(&setup, &fake), Check::Refused);
    refused(x11_setup(b'l', PROTOCOL, &[8; COOKIE_LEN]));
    refused(x11_setup(b'B', b"MIT-MAGIC-COOKIE-2", &fake));
    refused(x11_setup(b'l', b"XDM-AUTHORIZATION-1", &fake));
    refused(x11_setup(b'l', b"", b""));
    refused(x11_setup(b'l', PROTOCOL, &fake[..8]));
    let mut order = x11_setup(b'l', PROTOCOL, &fake);
    order[0] = b'X';
    refused(order);
    // Lengths encoded in the other byte order than the one declared.
    let mut swapped = x11_setup(b'l', PROTOCOL, &fake);
    swapped[0] = b'B';
    refused(swapped);
    // Decided from the header: a huge declared cookie is not waited for.
    let mut header = x11_setup(b'l', PROTOCOL, &fake)[..HEADER].to_vec();
    header[8..10].copy_from_slice(&u16::MAX.to_le_bytes());
    refused(header);
    assert!(same(&fake, &fake) && !same(&fake, &[7; 15]) && !same(&fake, &[6; 16]));
}

#[cfg(unix)]
#[test]
fn display_values_map_to_sockets_ports_and_xauth_names() {
    let unix = |path: &str| Endpoint::Unix(path.into());
    let cases = [
        (":0", unix("/tmp/.X11-unix/X0"), ":0"),
        (":12.3", unix("/tmp/.X11-unix/X12"), ":12.3"),
        ("unix:5", unix("/tmp/.X11-unix/X5"), "unix:5"),
        (
            "localhost:10.0",
            Endpoint::Tcp("localhost".into(), 6010),
            "unix:10.0",
        ),
        (
            "x11.example:2",
            Endpoint::Tcp("x11.example".into(), 6002),
            "x11.example:2",
        ),
        (
            "/private/tmp/com.apple.launchd.AbC/org.xquartz:0",
            unix("/private/tmp/com.apple.launchd.AbC/org.xquartz:0"),
            "/private/tmp/com.apple.launchd.AbC/org.xquartz:0",
        ),
        (
            "/private/tmp/com.apple.launchd.AbC/org.xquartz:0.1",
            unix("/private/tmp/com.apple.launchd.AbC/org.xquartz:0"),
            "/private/tmp/com.apple.launchd.AbC/org.xquartz:0.1",
        ),
    ];
    for (value, endpoint, auth_name) in cases {
        assert_eq!(
            parse_display(value).unwrap(),
            (endpoint, auth_name.to_string()),
            "{value}"
        );
    }
}

#[test]
fn unusable_display_values_are_refused() {
    let long = format!("{}:0", "a".repeat(600));
    for value in [
        "",
        "0",
        ":",
        ":x",
        ":0.x",
        ":0.",
        "-oops:0",
        "host name:0",
        "host\n:0",
        ":123456",
        "h:59536",
        "host:0:1",
        "[::1]:0",
        long.as_str(),
    ] {
        assert_eq!(parse_display(value).unwrap_err(), BAD_DISPLAY, "{value:?}");
    }
    assert_eq!(
        parse_display("h:59535").unwrap().0,
        Endpoint::Tcp("h".into(), 65535)
    );
    #[cfg(not(unix))]
    assert_eq!(
        parse_display(":3").unwrap().0,
        Endpoint::Tcp("127.0.0.1".into(), 6003)
    );
}

#[test]
fn xauth_output_yields_the_first_mit_cookie() {
    let cookie = "a0a1a2a3a4a5a6a7a8a9aaabacadaeaf";
    let listed = format!(
        "host/unix:0  XDM-AUTHORIZATION-1  00112233\nhost/unix:0  MIT-MAGIC-COOKIE-1  {cookie}\nhost/unix:0  MIT-MAGIC-COOKIE-1  {}\n",
        "0".repeat(32)
    );
    assert_eq!(&*parse_xauth(listed.as_bytes()).unwrap(), &REAL);
    // Malformed entries are skipped, not taken as the answer.
    let later = format!(
        "h/unix:0  MIT-MAGIC-COOKIE-1  +f{}\n{listed}",
        "0".repeat(30)
    );
    assert_eq!(&*parse_xauth(later.as_bytes()).unwrap(), &REAL);
    for bad in [
        String::new(),
        "host/unix:0  MIT-MAGIC-COOKIE-1".into(),
        "host/unix:0  MIT-MAGIC-COOKIE-1  a0a1a2a3a4a5a6a7".into(),
        "host/unix:0  MIT-MAGIC-COOKIE-1  zz".into(),
        format!("host/unix:0  MIT-MAGIC-COOKIE-1  +f{}", "0".repeat(30)),
        format!("host/unix:0  MIT-MAGIC-COOKIE-1  {cookie}0"),
    ] {
        assert_eq!(parse_xauth(bad.as_bytes()).unwrap_err(), NO_COOKIE, "{bad}");
    }
    assert_eq!(parse_xauth(&[0xff, 0xfe]).unwrap_err(), NO_COOKIE);
    assert_eq!(hex(&REAL), cookie);
    assert_eq!(unhex(&cookie.to_uppercase()).unwrap().as_slice(), &REAL);
}

/// System programs stand in for xauth, so no test script is written and
/// executed (which can race with other tests' forks on Linux).
#[cfg(unix)]
#[test]
fn xauth_runs_without_a_shell_and_is_bounded() {
    let wait = Duration::from_secs(5);
    // The display is one argument after `list`; nothing is interpreted.
    let echoed = run_xauth(Path::new("/bin/echo"), ":7; echo injected", wait).unwrap();
    assert_eq!(echoed.as_slice(), b"list :7; echo injected\n");
    assert_eq!(
        run_xauth(Path::new("/usr/bin/false"), ":0", wait).unwrap_err(),
        XAUTH_FAILED
    );
    let started = Instant::now();
    let flood = run_xauth(Path::new("/usr/bin/yes"), ":0", wait).unwrap_err();
    assert_eq!(flood, "xauth output exceeds 64 KiB");
    // Cut short at the output limit, not at the 5 s deadline.
    assert!(
        started.elapsed() < Duration::from_millis(4500),
        "flood was not cut short"
    );
    assert_eq!(
        run_xauth(Path::new("/nonexistent/xauth"), ":0", wait).unwrap_err(),
        XAUTH_FAILED
    );
}

/// A local X server stand-in: records each 48-byte setup, then echoes.
struct FakeX {
    endpoint: Endpoint,
    setups: Arc<Mutex<Vec<Vec<u8>>>>,
    connections: Arc<AtomicUsize>,
    ended: Arc<AtomicUsize>,
    task: tokio::task::JoinHandle<()>,
    directory: Option<std::path::PathBuf>,
}

impl FakeX {
    /// On a Unix socket where there are any, else on loopback TCP.
    async fn start() -> Self {
        let setups = Arc::new(Mutex::new(Vec::new()));
        let connections = Arc::new(AtomicUsize::new(0));
        let ended = Arc::new(AtomicUsize::new(0));
        let (records, opened, closed) = (setups.clone(), connections.clone(), ended.clone());
        let serve = move |stream| {
            opened.fetch_add(1, Ordering::SeqCst);
            tokio::spawn(Self::serve(stream, records.clone(), closed.clone()));
        };
        #[cfg(unix)]
        {
            let directory = std::env::temp_dir().join(format!("p0x11-{}", &id()[..8]));
            std::fs::create_dir(&directory).unwrap();
            let path = directory.join("X0");
            let listener = tokio::net::UnixListener::bind(&path).unwrap();
            let task = tokio::spawn(async move {
                while let Ok((stream, _)) = listener.accept().await {
                    serve(Box::new(stream) as Box<dyn Duplex>);
                }
            });
            Self {
                endpoint: Endpoint::Unix(path),
                setups,
                connections,
                ended,
                task,
                directory: Some(directory),
            }
        }
        #[cfg(not(unix))]
        {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let port = listener.local_addr().unwrap().port();
            let task = tokio::spawn(async move {
                while let Ok((stream, _)) = listener.accept().await {
                    serve(Box::new(stream) as Box<dyn Duplex>);
                }
            });
            Self {
                endpoint: Endpoint::Tcp("127.0.0.1".into(), port),
                setups,
                connections,
                ended,
                task,
                directory: None,
            }
        }
    }

    async fn serve(
        stream: Box<dyn Duplex>,
        setups: Arc<Mutex<Vec<Vec<u8>>>>,
        ended: Arc<AtomicUsize>,
    ) {
        let (mut read, mut write) = tokio::io::split(stream);
        let mut setup = vec![0; SETUP_LEN];
        if read.read_exact(&mut setup).await.is_ok() {
            setups.lock().unwrap().push(setup);
            let mut buffer = [0; 4096];
            while let Ok(n) = read.read(&mut buffer).await {
                if n == 0 || write.write_all(&buffer[..n]).await.is_err() {
                    break;
                }
            }
        }
        ended.fetch_add(1, Ordering::SeqCst);
    }

    fn display(&self, limit: usize) -> LocalDisplay {
        LocalDisplay::fixed(self.endpoint.clone(), REAL, limit)
    }

    async fn until(&self, what: &str, counter: &AtomicUsize, value: usize) {
        let deadline = Instant::now() + Duration::from_secs(5);
        while counter.load(Ordering::SeqCst) != value {
            assert!(
                Instant::now() < deadline,
                "{what}: {}",
                counter.load(Ordering::SeqCst)
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }
}

trait Duplex: AsyncRead + AsyncWrite + Send + Unpin {}
impl<T: AsyncRead + AsyncWrite + Send + Unpin> Duplex for T {}

impl Drop for FakeX {
    fn drop(&mut self) {
        self.task.abort();
        if let Some(directory) = &self.directory {
            let _ = std::fs::remove_dir_all(directory);
        }
    }
}

/// An open terminal and the events it sent, acknowledged as xterm does.
struct Terminal {
    service: Arc<Ssh>,
    id: String,
    events: tokio::sync::mpsc::UnboundedReceiver<PtyEvent>,
    output: Vec<u8>,
    cursor: usize,
    exit: Option<Option<u32>>,
}

fn fixture_request(server: &Fixture) -> Request {
    Request {
        host: "127.0.0.1".into(),
        port: server.port,
        username: "fixture".into(),
        private_key_path: server.key_path.to_string_lossy().into(),
    }
}

async fn open(request: Request, display: Option<LocalDisplay>) -> Result<Terminal, String> {
    open_pinned(request, None, display).await
}

/// Probes `request`, checks the fingerprint if one is given, then opens.
async fn open_pinned(
    request: Request,
    fingerprint: Option<String>,
    display: Option<LocalDisplay>,
) -> Result<Terminal, String> {
    let service = Arc::new(Ssh::default());
    let scope = service.context("main")?;
    let challenge = service.probe("main", &id(), request, &scope).await?;
    if let Some(expected) = fingerprint {
        assert_eq!(challenge.fingerprint, expected);
    }
    let token = challenge.challenge_token;
    let (sender, events) = tokio::sync::mpsc::unbounded_channel();
    let sink: EventSink = Arc::new(move |event| sender.send(event).map_err(|e| e.to_string()));
    let login = Credential::default();
    let id = match display {
        Some(display) => {
            service
                .open_with_x11("main", &id(), &token, &scope, login, 80, 24, sink, display)
                .await?
        }
        None => {
            service
                .open("main", &id(), &token, &scope, 80, 24, sink)
                .await?
        }
    };
    Ok(Terminal {
        service,
        id,
        events,
        output: Vec::new(),
        cursor: 0,
        exit: None,
    })
}

impl Terminal {
    fn write(&self, text: &str) {
        self.service
            .write("main", &self.id, text.as_bytes().to_vec())
            .unwrap();
    }

    async fn next(&mut self, deadline: tokio::time::Instant) {
        let event = tokio::time::timeout_at(deadline, self.events.recv())
            .await
            .unwrap_or_else(|_| panic!("no output; tail: {:?}", self.tail()))
            .expect("terminal event stream ended");
        match event {
            PtyEvent::Data { sequence, data, .. } => {
                self.output.extend_from_slice(&data);
                let _ = self.service.ack("main", &self.id, sequence);
            }
            PtyEvent::Exit { code, .. } => self.exit = Some(code),
            PtyEvent::Error { message, .. } => panic!("terminal error: {message}"),
        }
    }

    fn tail(&self) -> String {
        String::from_utf8_lossy(&self.output[self.output.len().saturating_sub(400)..]).into()
    }

    /// The next whole output line starting with `prefix`, after earlier ones.
    async fn line(&mut self, prefix: &str) -> String {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        loop {
            let text = String::from_utf8_lossy(&self.output[self.cursor..]).into_owned();
            if let Some(start) = text.find(prefix) {
                if let Some(length) = text[start..].find("\r\n") {
                    self.cursor += text[..start + length].len();
                    return text[start..start + length].to_string();
                }
            }
            self.next(deadline).await;
        }
    }

    async fn x11(&mut self, mode: &str) -> String {
        self.write(&format!("x11 {mode}\r"));
        self.line("X11 ").await
    }

    async fn exit_code(&mut self) -> Option<u32> {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        while self.exit.is_none() {
            self.next(deadline).await;
        }
        self.exit.unwrap()
    }
}

#[tokio::test]
async fn a_fake_cookie_is_sent_and_the_real_one_reaches_the_display_in_both_byte_orders() {
    let mut server = Fixture::start().await;
    let x = FakeX::start().await;
    let mut terminal = open(fixture_request(&server), Some(x.display(MAX_CHANNELS)))
        .await
        .unwrap();
    let requests = server.x11_requests.lock().unwrap().clone();
    assert_eq!(requests.len(), 1);
    let request = &requests[0];
    assert_eq!(request.protocol, PROTOCOL_NAME);
    assert!(!request.single_connection);
    assert_eq!(request.screen, 0);
    assert_eq!(request.cookie.len(), 2 * COOKIE_LEN);
    assert!(request.cookie.bytes().all(|b| b.is_ascii_hexdigit()));
    assert_ne!(request.cookie, hex(&REAL));

    assert_eq!(terminal.x11("B").await, "X11 ECHO PING");
    assert_eq!(terminal.x11("l").await, "X11 ECHO PING");
    let setups = x.setups.lock().unwrap().clone();
    assert_eq!(
        setups,
        [
            x11_setup(b'B', PROTOCOL, &REAL),
            x11_setup(b'l', PROTOCOL, &REAL)
        ]
    );

    // Every connection gets its own fake cookie.
    let again = open(fixture_request(&server), Some(x.display(MAX_CHANNELS)))
        .await
        .unwrap();
    let cookies: Vec<_> = server
        .x11_requests
        .lock()
        .unwrap()
        .iter()
        .map(|request| request.cookie.clone())
        .collect();
    assert_eq!(cookies.len(), 2);
    assert_ne!(cookies[0], cookies[1]);
    drop(again);
    terminal.write("exit\r");
    assert_eq!(terminal.exit_code().await, Some(7));
    server.stop().await;
}

#[tokio::test]
async fn a_wrong_cookie_is_closed_before_the_display_is_contacted() {
    let mut server = Fixture::start().await;
    let x = FakeX::start().await;
    let mut terminal = open(fixture_request(&server), Some(x.display(MAX_CHANNELS)))
        .await
        .unwrap();
    assert_eq!(terminal.x11("bad").await, "X11 CLOSED");
    assert_eq!(x.connections.load(Ordering::SeqCst), 0);
    // The forwarding still serves a client with the right cookie.
    assert_eq!(terminal.x11("l").await, "X11 ECHO PING");
    assert_eq!(x.connections.load(Ordering::SeqCst), 1);
    terminal.write("exit\r");
    assert_eq!(terminal.exit_code().await, Some(7));
    server.stop().await;
}

#[tokio::test]
async fn x11_channels_are_refused_unless_enabled_and_accepted() {
    let mut server = Fixture::start().await;
    let x = FakeX::start().await;
    let mut terminal = open(fixture_request(&server), None).await.unwrap();
    assert_eq!(terminal.x11("B").await, "X11 REFUSED");
    assert!(server.x11_requests.lock().unwrap().is_empty());
    assert_eq!(x.connections.load(Ordering::SeqCst), 0);
    terminal.write("exit\r");
    assert_eq!(terminal.exit_code().await, Some(7));

    // A server that refuses x11-req opens no terminal at all.
    server.denial.store(4, Ordering::SeqCst);
    let error = open(fixture_request(&server), Some(x.display(MAX_CHANNELS)))
        .await
        .err()
        .unwrap();
    assert_eq!(error, REFUSED);
    assert_eq!(server.x11_requests.lock().unwrap().len(), 1);
    server.stop().await;
}

#[tokio::test]
async fn x11_channels_are_bounded_and_end_with_the_terminal() {
    let mut server = Fixture::start().await;
    let x = FakeX::start().await;
    let mut terminal = open(fixture_request(&server), Some(x.display(2)))
        .await
        .unwrap();
    assert_eq!(terminal.x11("hold").await, "X11 HELD");
    assert_eq!(terminal.x11("hold").await, "X11 HELD");
    x.until("held connections", &x.connections, 2).await;
    assert_eq!(terminal.x11("hold").await, "X11 REFUSED");
    assert_eq!(terminal.x11("B").await, "X11 REFUSED");
    assert_eq!(x.ended.load(Ordering::SeqCst), 0);
    terminal.write("exit\r");
    assert_eq!(terminal.exit_code().await, Some(7));
    x.until("connections closed with the terminal", &x.ended, 2)
        .await;
    assert_eq!(x.setups.lock().unwrap().len(), 2);
    server.stop().await;
}

/// Reads shell output until `marker`; false after five seconds.
async fn shell_until(channel: &mut russh::Channel<client::Msg>, marker: &str) -> bool {
    let mut seen = Vec::new();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    while let Ok(Some(message)) = tokio::time::timeout_at(deadline, channel.wait()).await {
        match message {
            ChannelMsg::Data { data } => {
                seen.extend_from_slice(&data);
                if String::from_utf8_lossy(&seen).contains(marker) {
                    return true;
                }
            }
            ChannelMsg::Success if marker == "success" => return true,
            _ => {}
        }
    }
    false
}

/// The relay-cancellation watch ends X11 relays while the connection itself
/// stays up, and later x11 channels are refused.
#[tokio::test]
async fn ending_the_routes_ends_x11_relays_on_a_live_connection() {
    let mut server = Fixture::start().await;
    let x = FakeX::start().await;
    let routes = Arc::new(Routes::default());
    let stream = tokio::net::TcpStream::connect(("127.0.0.1", server.port))
        .await
        .unwrap();
    let pin = server.host.lock().unwrap().public_key().to_bytes().unwrap();
    let (_cancel, cancelled) = tokio::sync::watch::channel(false);
    let request = fixture_request(&server);
    let ssh = connect_routed(
        stream,
        &request,
        pin,
        &Credential::default(),
        cancelled,
        routes.clone(),
    )
    .await
    .unwrap();
    let mut channel = ssh.channel_open_session().await.unwrap();
    channel
        .request_pty(true, "xterm-256color", 80, 24, 0, 0, &[])
        .await
        .unwrap();
    assert!(shell_until(&mut channel, "success").await);
    super::request(&channel, &routes, x.display(MAX_CHANNELS))
        .await
        .unwrap();
    assert!(shell_until(&mut channel, "success").await);
    channel.request_shell(true).await.unwrap();
    assert!(shell_until(&mut channel, "> ").await);

    let forwarding = routes.x11.get().unwrap();
    let free = || forwarding.channels.available_permits();
    channel.data(&b"x11 hold\n"[..]).await.unwrap();
    assert!(shell_until(&mut channel, "X11 HELD").await);
    x.until("held connection", &x.connections, 1).await;
    // A channel the remote client closes gives its slot back.
    channel.data(&b"x11 l\n"[..]).await.unwrap();
    assert!(shell_until(&mut channel, "X11 ECHO PING").await);
    let deadline = Instant::now() + Duration::from_secs(5);
    while free() != MAX_CHANNELS - 1 {
        assert!(Instant::now() < deadline, "slot not released: {}", free());
        tokio::time::sleep(Duration::from_millis(10)).await;
    }

    routes.end_relays();
    // The route and its real cookie are dropped at once.
    assert!(routes.x11.get().is_none());
    x.until("relays ended", &x.ended, 2).await;
    assert_eq!(free(), MAX_CHANNELS);
    channel.data(&b"x11 B\n"[..]).await.unwrap();
    assert!(shell_until(&mut channel, "X11 REFUSED").await);
    channel.data(&b"unicode\n"[..]).await.unwrap();
    assert!(
        shell_until(&mut channel, "中文").await,
        "connection ended too"
    );
    assert_eq!(x.connections.load(Ordering::SeqCst), 2);
    server.stop().await;
}

/// System OpenSSH with `X11Forwarding yes` runs `xdpyinfo` remotely through
/// the forwarded display to an Xvfb that requires the real cookie.
#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires OpenSSH, Xvfb and xauth; run tests/fixtures/ssh-terminal/x11-client.test.mjs"]
async fn real_openssh_x11_forwarding() {
    let env = |name: &str| std::env::var(name).unwrap();
    let display = LocalDisplay::from_env().await.unwrap();
    let request = Request {
        host: env("P0_SSH_FIXTURE_HOST"),
        port: env("P0_SSH_FIXTURE_PORT").parse().unwrap(),
        username: env("P0_SSH_FIXTURE_USER"),
        private_key_path: env("P0_SSH_FIXTURE_KEY"),
    };
    let fingerprint = Some(env("P0_SSH_FIXTURE_FINGERPRINT"));
    let mut terminal = open_pinned(request, fingerprint, Some(display))
        .await
        .unwrap();
    terminal.line("P0_INTERACTIVE_READY").await;
    terminal.write("xdpyinfo\r");
    let result = terminal.line("P0_X11_").await;
    println!("{result}");
    assert!(result.starts_with("P0_X11_OK "), "{result}");
    let dimensions = format!("dimensions: {} pixels", env("P0_X11_DIMENSIONS"));
    assert!(result.contains(&dimensions), "{result}");
    // The server's xauth was given the fake cookie, never the real one.
    let remote = terminal.line("P0_X11_REMOTE_COOKIE ").await;
    // PTY lines end in CR.
    let remote = remote
        .trim_start_matches("P0_X11_REMOTE_COOKIE ")
        .trim_end();
    assert_eq!(remote.len(), 2 * COOKIE_LEN, "{remote}");
    let real = env("P0_X11_REAL_COOKIE").to_lowercase();
    assert_ne!(remote.to_lowercase(), real);
    assert!(!String::from_utf8_lossy(&terminal.output).contains(&real));
    terminal.write("exit\r");
    assert_eq!(terminal.exit_code().await, Some(7));
}
