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
                        let handler = Handler { public_key: public_key.clone(), auth: auth.clone(), active: count.clone(), denial: denied.clone(), forwards: forwarded.clone(), shells: Default::default(), round: 0, output: None };
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
    output: Option<JoinHandle<()>>,
}
impl Drop for Handler {
    fn drop(&mut self) {
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
