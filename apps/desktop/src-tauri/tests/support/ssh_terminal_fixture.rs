//! Loopback SSH protocol fixture. No OS shell or child process is executed.
use russh::keys::{ssh_key, Algorithm, HashAlg, PrivateKey, PublicKey};
use russh::{server, Channel, ChannelId, Pty};
use std::{
    net::Shutdown,
    path::PathBuf,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::{
    net::TcpListener,
    sync::watch,
    task::{JoinHandle, JoinSet},
};

pub const PASSWORD: &str = "fixture-password";
pub const PASSPHRASE: &str = "fixture-passphrase";
/// Second keyboard-interactive factor after [`PASSWORD`].
pub const CODE: &str = "123456";
/// Output of the `fixture-check` command, which exits with status 7.
pub const FIXTURE_CHECK: &[u8] = b"P0 fixture check\n";
/// Payload a fixture X client sends after its setup and expects echoed.
pub const X11_PING: &[u8] = b"PING";

/// What a client sent with `x11-req`.
#[derive(Clone, Debug)]
#[allow(dead_code)] // read only by the X11 tests
pub struct X11Request {
    pub single_connection: bool,
    pub protocol: String,
    pub cookie: String,
    pub screen: u32,
}

pub struct Fixture {
    pub port: u16,
    pub key_path: PathBuf,
    /// The same client key, encrypted with [`PASSPHRASE`].
    pub encrypted_key_path: PathBuf,
    pub host: Arc<Mutex<PrivateKey>>,
    pub authentications: Arc<AtomicUsize>,
    pub active: Arc<AtomicUsize>,
    pub denial: Arc<AtomicUsize>,
    pub rekey_limit: Arc<AtomicUsize>,
    /// Accepted direct-tcpip (local forwarding) channels.
    #[allow(dead_code)] // read only by the forwarding tests
    pub forwards: Arc<AtomicUsize>,
    /// Every `x11-req` received. Set `denial` to 4 to refuse them.
    #[allow(dead_code)] // read only by the X11 tests
    pub x11_requests: Arc<Mutex<Vec<X11Request>>>,
    directory: PathBuf,
    cancel: watch::Sender<bool>,
    task: Option<JoinHandle<()>>,
}
struct Socket(std::net::TcpStream);
impl Drop for Socket {
    fn drop(&mut self) {
        let _ = self.0.shutdown(Shutdown::Both);
    }
}
pub fn key() -> PrivateKey {
    PrivateKey::random(&mut russh::keys::key::safe_rng(), Algorithm::Ed25519).unwrap()
}

impl Fixture {
    pub async fn start() -> Self {
        let directory =
            std::env::temp_dir().join(format!("new-windterm-terminal-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&directory).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        let private_key = key();
        assert_eq!(private_key.algorithm(), Algorithm::Ed25519);
        let public_key = private_key.public_key().clone();
        let key_path = directory.join("client_ed25519");
        private_key
            .write_openssh_file(&key_path, ssh_key::LineEnding::LF)
            .unwrap();
        let encrypted_key_path = directory.join("client_ed25519_encrypted");
        private_key
            .encrypt(&mut russh::keys::key::safe_rng(), PASSPHRASE)
            .unwrap()
            .write_openssh_file(&encrypted_key_path, ssh_key::LineEnding::LF)
            .unwrap();
        let host = Arc::new(Mutex::new(key()));
        let authentications = Arc::new(AtomicUsize::new(0));
        let active = Arc::new(AtomicUsize::new(0));
        let denial = Arc::new(AtomicUsize::new(0));
        let rekey_limit = Arc::new(AtomicUsize::new(1 << 30));
        let forwards = Arc::new(AtomicUsize::new(0));
        let forwarded = forwards.clone();
        let x11_requests = Arc::new(Mutex::new(Vec::new()));
        let x11_requested = x11_requests.clone();
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let (cancel, mut cancelled) = watch::channel(false);
        let server_host = host.clone();
        let auth = authentications.clone();
        let count = active.clone();
        let denied = denial.clone();
        let rekey = rekey_limit.clone();
        let task = tokio::spawn(async move {
            let mut connections = JoinSet::new();
            loop {
                tokio::select! {
                    biased;
                    _ = cancelled.changed() => break,
                    Some(_) = connections.join_next(), if !connections.is_empty() => {},
                    accepted = listener.accept() => {
                        let Ok((stream, _)) = accepted else { break; };
                        let socket = stream.into_std().unwrap();
                        let guard = Socket(socket.try_clone().unwrap());
                        let stream = tokio::net::TcpStream::from_std(socket).unwrap();
                        let config = Arc::new(server::Config {
                            keys: vec![server_host.lock().unwrap().clone()],
                            limits: russh::Limits::new(rekey.load(Ordering::SeqCst), rekey.load(Ordering::SeqCst), Duration::from_secs(3600)),
                            inactivity_timeout: Some(Duration::from_secs(30)),
                            auth_rejection_time: Duration::ZERO,
                            auth_rejection_time_initial: Some(Duration::ZERO),
                            ..Default::default()
                        });
                        let handler = Handler { public_key: public_key.clone(), auth: auth.clone(), active: count.clone(), denial: denied.clone(), forwards: forwarded.clone(), shells: Default::default(), round: 0, listeners: Default::default(), agent_requested: false, output: None, x11_requests: x11_requested.clone(), x11_held: Default::default() };
                        count.fetch_add(1, Ordering::SeqCst);
                        connections.spawn(async move {
                            let _guard = guard;
                            if let Ok(session) = server::run_stream(config, stream, handler).await { let _ = session.await; }
                        });
                    }
                }
            }
            connections.abort_all();
            while connections.join_next().await.is_some() {}
        });
        Self {
            port,
            key_path,
            encrypted_key_path,
            host,
            authentications,
            active,
            denial,
            rekey_limit,
            forwards,
            x11_requests,
            directory,
            cancel,
            task: Some(task),
        }
    }
    pub fn fingerprint(&self) -> String {
        self.host
            .lock()
            .unwrap()
            .public_key()
            .fingerprint(HashAlg::Sha256)
            .to_string()
    }
    pub async fn stop(&mut self) {
        self.cancel.send_replace(true);
        if let Some(task) = self.task.take() {
            let _ = task.await;
        }
        let _ = std::fs::remove_dir_all(&self.directory);
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.cancel.send_replace(true);
        if let Some(task) = self.task.take() {
            task.abort();
        }
        let _ = std::fs::remove_dir_all(&self.directory);
    }
}
struct Handler {
    public_key: PublicKey,
    auth: Arc<AtomicUsize>,
    active: Arc<AtomicUsize>,
    denial: Arc<AtomicUsize>,
    forwards: Arc<AtomicUsize>,
    /// Size and pending input line of each line-based shell channel. russh
    /// delivers every channel's data to `Handler::data`, so forwarded bytes
    /// (channels without a PTY) are ignored here.
    shells: std::collections::HashMap<ChannelId, ((u32, u32), Vec<u8>)>,
    /// Keyboard-interactive progress: 0 none, 1 password asked, 2 code asked.
    round: u8,
    /// Remote-forward listeners by bound port.
    listeners: std::collections::HashMap<u32, JoinHandle<()>>,
    /// Whether the client asked for agent forwarding on a session channel.
    agent_requested: bool,
    output: Option<JoinHandle<()>>,
    x11_requests: Arc<Mutex<Vec<X11Request>>>,
    /// X11 channels kept open by `x11 hold` until the connection ends.
    x11_held: Arc<Mutex<Vec<Channel<server::Msg>>>>,
}
impl Drop for Handler {
    fn drop(&mut self) {
        for (_, listener) in self.listeners.drain() {
            listener.abort();
        }
        if let Some(output) = self.output.take() {
            output.abort();
        }
        self.active.fetch_sub(1, Ordering::SeqCst);
    }
}
impl server::Handler for Handler {
    type Error = russh::Error;
    async fn auth_publickey(
        &mut self,
        user: &str,
        key: &PublicKey,
    ) -> Result<server::Auth, Self::Error> {
        self.auth.fetch_add(1, Ordering::SeqCst);
        Ok(
            if user == "fixture" && key.key_data() == self.public_key.key_data() {
                server::Auth::Accept
            } else {
                server::Auth::reject()
            },
        )
    }
    /// Remote forwarding on loopback: each accepted connection is offered back
    /// to the client as a forwarded-tcpip channel and relayed.
    async fn tcpip_forward(
        &mut self,
        address: &str,
        port: &mut u32,
        session: &mut server::Session,
    ) -> Result<bool, Self::Error> {
        let Ok(requested) = u16::try_from(*port) else {
            return Ok(false);
        };
        if address != "127.0.0.1" {
            return Ok(false);
        }
        let Ok(listener) = TcpListener::bind(("127.0.0.1", requested)).await else {
            return Ok(false);
        };
        let bound = u32::from(listener.local_addr().unwrap().port());
        *port = bound;
        let handle = session.handle();
        let address = address.to_string();
        self.listeners.insert(
            bound,
            tokio::spawn(async move {
                while let Ok((mut stream, peer)) = listener.accept().await {
                    let (handle, address) = (handle.clone(), address.clone());
                    tokio::spawn(async move {
                        let opened = handle
                            .channel_open_forwarded_tcpip(
                                address,
                                bound,
                                peer.ip().to_string(),
                                u32::from(peer.port()),
                            )
                            .await;
                        if let Ok(channel) = opened {
                            let mut channel = channel.into_stream();
                            let _ = tokio::io::copy_bidirectional(&mut channel, &mut stream).await;
                        }
                    });
                }
            }),
        );
        Ok(true)
    }
    async fn cancel_tcpip_forward(
        &mut self,
        _address: &str,
        port: u32,
        _session: &mut server::Session,
    ) -> Result<bool, Self::Error> {
        Ok(self
            .listeners
            .remove(&port)
            .map(|listener| listener.abort())
            .is_some())
    }
    /// Recorded, then accepted unless `denial` is 4.
    async fn x11_request(
        &mut self,
        channel: ChannelId,
        single_connection: bool,
        protocol: &str,
        cookie: &str,
        screen: u32,
        session: &mut server::Session,
    ) -> Result<(), Self::Error> {
        self.x11_requests.lock().unwrap().push(X11Request {
            single_connection,
            protocol: protocol.into(),
            cookie: cookie.into(),
            screen,
        });
        if self.denial.load(Ordering::SeqCst) == 4 {
            session.channel_failure(channel)?;
        } else {
            session.channel_success(channel)?;
        }
        Ok(())
    }
    async fn agent_request(
        &mut self,
        _channel: ChannelId,
        _session: &mut server::Session,
    ) -> Result<bool, Self::Error> {
        self.agent_requested = true;
        Ok(true)
    }
    /// Two rounds: password (no echo), then a verification code (echo).
    async fn auth_keyboard_interactive<'a>(
        &'a mut self,
        user: &str,
        _submethods: &str,
        response: Option<server::Response<'a>>,
    ) -> Result<server::Auth, Self::Error> {
        let answer = response.and_then(|mut r| r.next()).map(|b| b.to_vec());
        let partial = |prompt: &'static str, echo: bool| server::Auth::Partial {
            name: "P0 fixture".into(),
            instructions: "Two factors".into(),
            prompts: vec![(prompt.into(), echo)].into(),
        };
        let reply = match (self.round, answer.as_deref()) {
            (0, _) if user == "fixture" => {
                self.round = 1;
                partial("Password: ", false)
            }
            (1, Some(answer)) if answer == PASSWORD.as_bytes() => {
                self.round = 2;
                partial("Verification code: ", true)
            }
            (2, Some(answer)) if answer == CODE.as_bytes() => {
                self.auth.fetch_add(1, Ordering::SeqCst);
                server::Auth::Accept
            }
            _ => {
                self.auth.fetch_add(1, Ordering::SeqCst);
                self.round = 0;
                server::Auth::reject()
            }
        };
        Ok(reply)
    }
    /// Loopback-only local forwarding: bytes are relayed to 127.0.0.1:port.
    async fn channel_open_direct_tcpip(
        &mut self,
        channel: Channel<server::Msg>,
        host_to_connect: &str,
        port_to_connect: u32,
        _originator_address: &str,
        _originator_port: u32,
        reply: server::ChannelOpenHandle,
        _session: &mut server::Session,
    ) -> Result<(), Self::Error> {
        let Ok(port) = u16::try_from(port_to_connect) else {
            return Ok(());
        };
        if host_to_connect != "127.0.0.1" {
            return Ok(()); // dropping the handle rejects the channel
        }
        let Ok(mut target) = tokio::net::TcpStream::connect(("127.0.0.1", port)).await else {
            return Ok(());
        };
        reply.accept().await;
        self.forwards.fetch_add(1, Ordering::SeqCst);
        tokio::spawn(async move {
            let (mut from_client, to_client) = channel.split();
            let (mut target_read, mut target_write) = target.split();
            let upstream = async {
                while let Some(message) = from_client.wait().await {
                    match message {
                        russh::ChannelMsg::Data { data } => {
                            if target_write.write_all(&data).await.is_err() {
                                break;
                            }
                        }
                        russh::ChannelMsg::Eof | russh::ChannelMsg::Close => break,
                        _ => {}
                    }
                }
                let _ = target_write.shutdown().await;
            };
            let downstream = async {
                let mut buffer = [0; 32 * 1024];
                while let Ok(n) = target_read.read(&mut buffer).await {
                    if n == 0 || to_client.data(&buffer[..n]).await.is_err() {
                        break;
                    }
                }
                let _ = to_client.eof().await;
            };
            tokio::join!(upstream, downstream);
            let _ = to_client.close().await;
        });
        Ok(())
    }
    /// Only the fixed verification command runs: fixed output, exit status 7.
    async fn exec_request(
        &mut self,
        channel: ChannelId,
        data: &[u8],
        session: &mut server::Session,
    ) -> Result<(), Self::Error> {
        if data != b"fixture-check" {
            session.channel_failure(channel)?;
            return Ok(());
        }
        session.channel_success(channel)?;
        session.data(channel, FIXTURE_CHECK.to_vec())?;
        session.exit_status_request(channel, 7)?;
        session.eof(channel)?;
        session.close(channel)?;
        Ok(())
    }
    /// No SFTP server here: the request is refused and the channel closed, so
    /// SFTP clients fail right after authentication instead of waiting.
    async fn subsystem_request(
        &mut self,
        channel: ChannelId,
        _name: &str,
        session: &mut server::Session,
    ) -> Result<(), Self::Error> {
        session.channel_failure(channel)?;
        session.close(channel)?;
        Ok(())
    }
    async fn auth_password(
        &mut self,
        user: &str,
        password: &str,
    ) -> Result<server::Auth, Self::Error> {
        self.auth.fetch_add(1, Ordering::SeqCst);
        Ok(if user == "fixture" && password == PASSWORD {
            server::Auth::Accept
        } else {
            server::Auth::reject()
        })
    }
    async fn channel_open_session(
        &mut self,
        _channel: Channel<server::Msg>,
        reply: server::ChannelOpenHandle,
        _session: &mut server::Session,
    ) -> Result<(), Self::Error> {
        reply.accept().await;
        Ok(())
    }
    async fn pty_request(
        &mut self,
        channel: ChannelId,
        term: &str,
        cols: u32,
        rows: u32,
        _width: u32,
        _height: u32,
        _modes: &[(Pty, u32)],
        session: &mut server::Session,
    ) -> Result<(), Self::Error> {
        self.shells.insert(channel, ((cols, rows), Vec::new()));
        if term == "xterm-256color" && self.denial.load(Ordering::SeqCst) != 1 {
            session.channel_success(channel)?;
        } else {
            session.channel_failure(channel)?;
        }
        Ok(())
    }
    async fn shell_request(
        &mut self,
        channel: ChannelId,
        session: &mut server::Session,
    ) -> Result<(), Self::Error> {
        if self.denial.load(Ordering::SeqCst) == 3 {
            return Ok(());
        }
        if self.denial.load(Ordering::SeqCst) == 2 {
            session.channel_failure(channel)?;
            return Ok(());
        }
        session.channel_success(channel)?;
        session.data(channel, b"P0 SSH terminal fixture\r\nCommands: unicode, size, large, burst, exit; Ctrl-C interrupts output\r\n> ".to_vec())?;
        Ok(())
    }
    async fn window_change_request(
        &mut self,
        channel: ChannelId,
        cols: u32,
        rows: u32,
        _width: u32,
        _height: u32,
        _session: &mut server::Session,
    ) -> Result<(), Self::Error> {
        if let Some((size, _)) = self.shells.get_mut(&channel) {
            *size = (cols, rows);
        }
        Ok(())
    }
    async fn data(
        &mut self,
        channel: ChannelId,
        data: &[u8],
        session: &mut server::Session,
    ) -> Result<(), Self::Error> {
        let Some(((cols, rows), line)) = self.shells.get_mut(&channel) else {
            return Ok(()); // forwarded channel data is relayed by its own task
        };
        let size = (*cols, *rows);
        let mut commands = Vec::new();
        for byte in data {
            if *byte == 3 {
                line.clear();
                commands.push(None);
                continue;
            }
            if *byte != b'\r' && *byte != b'\n' {
                if line.len() >= 256 {
                    return Err(russh::Error::Disconnect);
                }
                line.push(*byte);
                continue;
            }
            commands.push(Some(std::mem::take(line)));
        }
        for command in commands {
            let Some(command) = command else {
                if let Some(output) = self.output.take() {
                    output.abort();
                }
                session.data(channel, b"\r\nINTERRUPTED\r\n> ".to_vec())?;
                continue;
            };
            match command.as_slice() {
                b"unicode" => session.data(channel, "中文 🌏\r\n> ".as_bytes().to_vec())?,
                b"size" => session.data(
                    channel,
                    format!("SIZE {} {}\r\n> ", size.0, size.1).into_bytes(),
                )?,
                b"large" | b"burst" => {
                    if let Some(output) = self.output.take() {
                        output.abort();
                    }
                    let handle = session.handle();
                    let paced = command == b"large";
                    self.output = Some(tokio::spawn(async move {
                        for _ in 0..512 {
                            if handle.data(channel, vec![b'X'; 4096]).await.is_err() {
                                return;
                            }
                            if paced {
                                tokio::time::sleep(Duration::from_millis(6)).await;
                            }
                        }
                        let _ = handle.data(channel, b"\r\nLARGE_DONE\r\n> ".to_vec()).await;
                    }));
                }
                b"agent" => {
                    // Asks the client's agent, through a forwarded agent
                    // channel, how many identities it holds.
                    let handle = session.handle();
                    let requested = self.agent_requested;
                    tokio::spawn(async move {
                        let reply = if !requested {
                            "AGENT OFF".to_string()
                        } else {
                            match handle.channel_open_agent().await {
                                Ok(agent) => {
                                    let mut client =
                                        russh::keys::agent::client::AgentClient::connect(
                                            agent.into_stream(),
                                        );
                                    match client.request_identities().await {
                                        Ok(keys) => format!("AGENT {} KEYS", keys.len()),
                                        Err(_) => "AGENT ERROR".into(),
                                    }
                                }
                                Err(_) => "AGENT REFUSED".into(),
                            }
                        };
                        let _ = handle
                            .data(channel, format!("{reply}\r\n> ").into_bytes())
                            .await;
                    });
                }
                b"x11 B" | b"x11 l" | b"x11 bad" | b"x11 hold" => {
                    // Plays a remote X client over a new x11 channel, with
                    // the cookie of the last x11-req (zeros if none).
                    let handle = session.handle();
                    let cookie = self
                        .x11_requests
                        .lock()
                        .unwrap()
                        .last()
                        .and_then(|request| unhex(&request.cookie))
                        .unwrap_or_else(|| vec![0; 16]);
                    let held = self.x11_held.clone();
                    let mode = command[4..].to_vec();
                    tokio::spawn(async move {
                        let reply = x11_client(&handle, &mode, cookie, &held).await;
                        let _ = handle
                            .data(channel, format!("{reply}\r\n> ").into_bytes())
                            .await;
                    });
                }
                b"exit" => {
                    self.shells.remove(&channel);
                    session.exit_status_request(channel, 7)?;
                    session.eof(channel)?;
                    session.close(channel)?;
                    break;
                }
                b"" => {}
                _ => session.data(channel, b"Unknown fixture command\r\n> ".to_vec())?,
            }
        }
        Ok(())
    }
}

/// An X11 connection setup in byte order `order` (`B` or `l`).
pub fn x11_setup(order: u8, name: &[u8], data: &[u8]) -> Vec<u8> {
    let encode = |value: usize| {
        let value = u16::try_from(value).unwrap();
        if order == b'B' {
            value.to_be_bytes()
        } else {
            value.to_le_bytes()
        }
    };
    let mut setup = vec![order, 0];
    setup.extend(encode(11));
    setup.extend(encode(0));
    setup.extend(encode(name.len()));
    setup.extend(encode(data.len()));
    setup.extend([0, 0]);
    setup.extend(name);
    setup.resize(setup.len().next_multiple_of(4), 0);
    setup.extend(data);
    setup.resize(setup.len().next_multiple_of(4), 0);
    setup
}

fn unhex(text: &str) -> Option<Vec<u8>> {
    if !text.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    (0..text.len())
        .step_by(2)
        .map(|at| u8::from_str_radix(text.get(at..at + 2)?, 16).ok())
        .collect()
}

/// `B`/`l`: a valid setup in that byte order, then [`X11_PING`], which must
/// come back. `bad`: a setup with a wrong cookie, which must be closed with
/// no data. `hold`: a valid setup, then the channel is kept open.
async fn x11_client(
    handle: &server::Handle,
    mode: &[u8],
    cookie: Vec<u8>,
    held: &Mutex<Vec<Channel<server::Msg>>>,
) -> String {
    let Ok(mut channel) = handle.channel_open_x11("127.0.0.1", 6010).await else {
        return "X11 REFUSED".into();
    };
    let (order, cookie) = match mode {
        b"B" => (b'B', cookie),
        b"bad" => (b'l', cookie.iter().map(|byte| byte ^ 0x5a).collect()),
        _ => (b'l', cookie),
    };
    let mut setup = x11_setup(order, b"MIT-MAGIC-COOKIE-1", &cookie);
    if mode == b"hold" {
        if channel.data(&setup[..]).await.is_err() {
            return "X11 SEND FAILED".into();
        }
        held.lock().unwrap().push(channel);
        return "X11 HELD".into();
    }
    // Sent in the same packet as the setup, as X clients pipeline requests.
    setup.extend_from_slice(X11_PING);
    if channel.data(&setup[..]).await.is_err() {
        return "X11 SEND FAILED".into();
    }
    let mut received = Vec::new();
    let mut closed = false;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    while received.len() < X11_PING.len() {
        match tokio::time::timeout_at(deadline, channel.wait()).await {
            Ok(Some(russh::ChannelMsg::Data { data })) => received.extend_from_slice(&data),
            Ok(Some(russh::ChannelMsg::Eof | russh::ChannelMsg::Close) | None) => {
                closed = true;
                break;
            }
            Ok(Some(_)) => {}
            Err(_) => break,
        }
    }
    // The X client disconnects, as a finished remote program does.
    let _ = channel.close().await;
    match (closed, received.as_slice()) {
        (true, []) => "X11 CLOSED".into(),
        (_, data) if data == X11_PING => "X11 ECHO PING".into(),
        _ => format!("X11 UNEXPECTED {} BYTES", received.len()),
    }
}
