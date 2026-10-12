//! Runs Apple's telnetd (Homebrew `telnetd`, remote_cmds) as the current
//! non-root user, inetd style: each test hands telnetd one end of a loopback
//! TCP connection as its stdin and stdout, so nothing listens beyond the
//! test's own 127.0.0.1 sockets. telnetd normally execs the setuid-root
//! `/usr/bin/login`; every test passes `-p` with a harness-written program
//! instead, so no process here gains root.
use std::{
    fs,
    net::{TcpListener, TcpStream},
    os::{
        fd::OwnedFd,
        unix::fs::{DirBuilderExt, PermissionsExt},
    },
    path::{Path, PathBuf},
    process::{self, Child, ExitStatus, Stdio},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    sync::watch,
    task::JoinHandle,
};

pub const IAC: u8 = 255;
pub const DONT: u8 = 254;
pub const DO: u8 = 253;
pub const WONT: u8 = 252;
pub const WILL: u8 = 251;
pub const SB: u8 = 250;
pub const SE: u8 = 240;
pub const ECHO: u8 = 1;
pub const SGA: u8 = 3;
pub const BINARY: u8 = 0;
pub const TTYPE: u8 = 24;
pub const NAWS: u8 = 31;

const CANDIDATES: &[&str] = &[
    "/opt/homebrew/opt/telnetd/sbin/telnetd",
    "/usr/local/opt/telnetd/sbin/telnetd",
];

/// The telnetd to test, or `None` (with the reason printed) to skip.
pub fn binary() -> Option<PathBuf> {
    // SAFETY: geteuid has no preconditions and cannot fail.
    if unsafe { libc::geteuid() } == 0 {
        eprintln!("skipped: refusing to run telnetd as root");
        return None;
    }
    let path = match std::env::var_os("P0_TELNETD") {
        Some(path) => PathBuf::from(path),
        None => CANDIDATES
            .iter()
            .map(PathBuf::from)
            .find(|path| path.exists())
            .unwrap_or_else(|| PathBuf::from(CANDIDATES[0])),
    };
    if !path.is_file() {
        eprintln!(
            "skipped: telnetd not found at {} (macOS: `brew install telnetd`, or set P0_TELNETD)",
            path.display()
        );
        return None;
    }
    Some(path)
}

/// What telnetd runs on the pty in place of login(1). Each program first
/// records its PID so the harness can show it ended.
#[derive(Clone, Copy)]
pub enum Program {
    /// Prompts like login(1): `login: `, then `Password:` with the tty's
    /// echo off; reports what it read, prints `Login incorrect` and exits.
    Login,
    /// Puts the pty in raw mode, prints `READY`, hex-dumps the next `n`
    /// bytes it receives as `HEX:<hex>:END`, then prints
    /// `a CR NUL b CR 0xFF c CR LF`.
    Dump(usize),
    /// An interactive /bin/sh with a UTF-8 locale and the prompt `p0$ `.
    Shell,
}

impl Program {
    fn script(self, pid_file: &Path) -> String {
        let body = match self {
            Self::Login => "printf 'login: '\nIFS= read -r user\n/bin/stty -echo\n\
                 printf 'Password:'\nIFS= read -r pass\n/bin/stty echo\n\
                 printf '\\nuser=[%s] pass-len=%s\\nLogin incorrect\\n' \"$user\" \"${#pass}\"\n\
                 exit 1\n"
                .to_string(),
            Self::Dump(count) => format!(
                "/bin/stty raw -echo\nprintf 'READY\\r\\n'\nprintf 'HEX:'\n\
                 /usr/bin/head -c {count} | /usr/bin/od -An -tx1 -v | /usr/bin/tr -d ' \\n'\n\
                 printf ':END\\r\\n'\nprintf 'a\\r\\000b\\r\\377c\\r\\n'\n"
            ),
            Self::Shell => "LC_ALL=en_US.UTF-8 PS1='p0$ ' exec /bin/sh -i\n".to_string(),
        };
        format!("#!/bin/sh\necho $$ > '{}'\n{body}", pid_file.display())
    }
}

/// A private (0700) temporary directory, removed on drop.
struct Directory(PathBuf);

impl Directory {
    fn create() -> Self {
        let path = std::env::temp_dir().join(format!("p0-telnetd-{}", uuid::Uuid::new_v4()));
        // Paths are interpolated into single-quoted shell text.
        assert!(!path.to_string_lossy().contains('\''), "{}", path.display());
        fs::DirBuilder::new().mode(0o700).create(&path).unwrap();
        Self(path)
    }
}

impl Drop for Directory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// One telnetd process serving one connection.
pub struct Telnetd {
    child: Child,
    status: Option<ExitStatus>,
    program_ended: bool,
    // Dropped after `Telnetd::drop`, which still reads the PID file.
    directory: Directory,
}

impl Telnetd {
    /// Starts telnetd on `socket` with `args` and `-p <program>`.
    pub fn spawn(binary: &Path, args: &[&str], program: Program, socket: TcpStream) -> Self {
        let directory = Directory::create();
        let script = directory.0.join("program.sh");
        fs::write(&script, program.script(&directory.0.join("program.pid"))).unwrap();
        fs::set_permissions(&script, fs::Permissions::from_mode(0o700)).unwrap();
        let stderr = fs::File::create(directory.0.join("telnetd.stderr")).unwrap();
        let output = socket.try_clone().unwrap();
        let child = process::Command::new(binary)
            .args(args)
            .arg("-p")
            .arg(&script)
            .env_clear()
            .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
            .stdin(Stdio::from(OwnedFd::from(socket)))
            .stdout(Stdio::from(OwnedFd::from(output)))
            .stderr(stderr)
            .spawn()
            .unwrap();
        Self {
            child,
            status: None,
            program_ended: false,
            directory,
        }
    }

    /// The PID the program recorded, once it has started.
    pub fn program_pid(&self) -> Option<libc::pid_t> {
        fs::read_to_string(self.path("program.pid"))
            .ok()?
            .trim()
            .parse()
            .ok()
            .filter(|pid| *pid > 1)
    }

    /// A file in this telnetd's private directory.
    pub fn path(&self, name: &str) -> PathBuf {
        self.directory.0.join(name)
    }

    pub fn stderr(&self) -> String {
        fs::read_to_string(self.path("telnetd.stderr")).unwrap_or_default()
    }

    /// Waits for telnetd itself to exit.
    pub async fn wait_exit(&mut self, timeout: Duration) -> ExitStatus {
        let deadline = Instant::now() + timeout;
        let status = loop {
            if let Some(status) = self.child.try_wait().unwrap() {
                break status;
            }
            assert!(
                Instant::now() < deadline,
                "telnetd did not exit; stderr: {}",
                self.stderr()
            );
            tokio::time::sleep(POLL).await;
        };
        self.status = Some(status);
        status
    }

    /// Waits up to `grace` for the program to end by itself and returns
    /// whether it did. telnetd 308 leaks the pty master (`/dev/ptmx`) into
    /// the program, so closing the connection never hangs the pty up; a
    /// program still running is then ended here with its process group.
    pub async fn end_program(&mut self, grace: Duration) -> bool {
        let pid = self.program_pid().expect("the program never started");
        let by_itself = wait_gone(pid, grace).await;
        if !by_itself {
            stop(pid);
            assert!(
                wait_gone(pid, Duration::from_secs(5)).await,
                "program {pid} survived SIGKILL"
            );
        }
        self.program_ended = true;
        by_itself
    }
}

const POLL: Duration = Duration::from_millis(20);

fn alive(pid: libc::pid_t) -> bool {
    // SAFETY: signal 0 only checks that the process exists.
    unsafe { libc::kill(pid, 0) == 0 }
}

async fn wait_gone(pid: libc::pid_t, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while alive(pid) {
        if Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(POLL).await;
    }
    true
}

/// Kills a program this harness started together with its process group.
/// telnetd makes the program a session leader on the pty; a PID that is not
/// one (gone, or reused by an unrelated process) is left alone.
fn stop(pid: libc::pid_t) {
    // SAFETY: getsid and kill take plain integers; `pid > 1` was checked
    // when it was read, so `-pid` names exactly that one process group.
    unsafe {
        if libc::getsid(pid) == pid {
            libc::kill(-pid, libc::SIGKILL);
            libc::kill(pid, libc::SIGKILL);
        }
    }
}

impl Drop for Telnetd {
    /// A failed test may leave telnetd or its program running: stop both.
    fn drop(&mut self) {
        if self.status.is_none() && self.child.try_wait().ok().flatten().is_none() {
            let _ = self.child.kill();
            let _ = self.child.wait();
            // A program forked just before the kill records its PID shortly.
            let deadline = Instant::now() + Duration::from_secs(1);
            while self.program_pid().is_none() && Instant::now() < deadline {
                std::thread::sleep(POLL);
            }
        }
        if let Some(pid) = self.program_pid().filter(|_| !self.program_ended) {
            stop(pid);
        }
    }
}

/// A connected loopback TCP pair: (client end, server end).
pub fn loopback_pair() -> (TcpStream, TcpStream) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let client = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
    let (server, _) = listener.accept().unwrap();
    (client, server)
}

/// Bytes seen by [`Recorder`] in each direction.
#[derive(Default, Debug)]
pub struct Wire {
    pub to_server: Vec<u8>,
    pub to_client: Vec<u8>,
    pub client_eof: bool,
    pub server_eof: bool,
    /// The server's `IAC DO NAWS` is being withheld from the client.
    pub holding: bool,
}

/// A loopback proxy between a client and its own telnetd that records every
/// byte and can withhold the server's `IAC DO NAWS` until released.
pub struct Recorder {
    pub port: u16,
    pub telnetd: Telnetd,
    pub wire: Arc<Mutex<Wire>>,
    release: watch::Sender<bool>,
    task: JoinHandle<()>,
}

impl Drop for Recorder {
    fn drop(&mut self) {
        self.task.abort();
    }
}

impl Recorder {
    pub async fn start(binary: &Path, args: &[&str], program: Program, hold_naws: bool) -> Self {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let (upstream, server) = loopback_pair();
        let telnetd = Telnetd::spawn(binary, args, program, server);
        upstream.set_nonblocking(true).unwrap();
        let upstream = tokio::net::TcpStream::from_std(upstream).unwrap();
        let wire = Arc::new(Mutex::new(Wire::default()));
        let (release, released) = watch::channel(!hold_naws);
        let log = wire.clone();
        let task = tokio::spawn(async move {
            let (client, _) = listener.accept().await.unwrap();
            let (client_read, client_write) = client.into_split();
            let (server_read, server_write) = upstream.into_split();
            let up = relay_up(client_read, server_write, log.clone());
            let down = relay_down(server_read, client_write, log, released);
            tokio::join!(up, down);
        });
        Self {
            port,
            telnetd,
            wire,
            release,
            task,
        }
    }

    pub fn release(&self) {
        self.release.send_replace(true);
    }
}

async fn relay_up(
    mut from: tokio::net::tcp::OwnedReadHalf,
    mut to: tokio::net::tcp::OwnedWriteHalf,
    log: Arc<Mutex<Wire>>,
) {
    let mut buffer = [0; 4096];
    loop {
        let count = from.read(&mut buffer).await.unwrap_or(0);
        if count == 0 {
            log.lock().unwrap().client_eof = true;
            let _ = to.shutdown().await;
            return;
        }
        log.lock()
            .unwrap()
            .to_server
            .extend_from_slice(&buffer[..count]);
        if to.write_all(&buffer[..count]).await.is_err() {
            return;
        }
    }
}

async fn relay_down(
    mut from: tokio::net::tcp::OwnedReadHalf,
    mut to: tokio::net::tcp::OwnedWriteHalf,
    log: Arc<Mutex<Wire>>,
    mut released: watch::Receiver<bool>,
) {
    const NEEDLE: [u8; 3] = [IAC, DO, NAWS];
    let mut held = Vec::new();
    let mut buffer = [0; 4096];
    loop {
        let count = from.read(&mut buffer).await.unwrap_or(0);
        if count == 0 {
            log.lock().unwrap().server_eof = true;
            let _ = to.write_all(&held).await;
            let _ = to.shutdown().await;
            return;
        }
        held.extend_from_slice(&buffer[..count]);
        let mut forward = held.len();
        let mut hold = false;
        if !*released.borrow() {
            match find(&held, &NEEDLE) {
                Some(at) => (forward, hold) = (at, true),
                // Keep a trailing IAC or IAC DO: it may start the needle.
                None if held.ends_with(&[IAC, DO]) => forward -= 2,
                None if held.ends_with(&[IAC]) => forward -= 1,
                None => {}
            }
        }
        let now: Vec<u8> = held.drain(..forward).collect();
        log.lock().unwrap().to_client.extend_from_slice(&now);
        if to.write_all(&now).await.is_err() {
            return;
        }
        if hold {
            log.lock().unwrap().holding = true;
            let _ = released.wait_for(|released| *released).await;
            log.lock().unwrap().holding = false;
            let rest = std::mem::take(&mut held);
            log.lock().unwrap().to_client.extend_from_slice(&rest);
            if to.write_all(&rest).await.is_err() {
                return;
            }
        }
    }
}

pub fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

pub fn count(haystack: &[u8], needle: &[u8]) -> usize {
    haystack
        .windows(needle.len())
        .filter(|w| *w == needle)
        .count()
}

/// One Telnet command in a byte stream: `[verb, option]` or an SB payload.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Command {
    Verb(u8, u8),
    Sub(Vec<u8>),
}

/// Splits a Telnet stream into its commands (data bytes are skipped).
pub fn commands(stream: &[u8]) -> Vec<Command> {
    let mut out = Vec::new();
    let mut index = 0;
    while index < stream.len() {
        if stream[index] != IAC || index + 1 >= stream.len() {
            index += 1;
            continue;
        }
        match stream[index + 1] {
            verb @ (WILL | WONT | DO | DONT) if index + 2 < stream.len() => {
                out.push(Command::Verb(verb, stream[index + 2]));
                index += 3;
            }
            SB => {
                let mut payload = Vec::new();
                let mut at = index + 2;
                while at + 1 < stream.len() && !(stream[at] == IAC && stream[at + 1] == SE) {
                    if stream[at] == IAC && stream[at + 1] == IAC {
                        at += 1;
                    }
                    payload.push(stream[at]);
                    at += 1;
                }
                out.push(Command::Sub(payload));
                index = at + 2;
            }
            _ => index += 2,
        }
    }
    out
}

/// NAWS reports in a stream, as (columns, rows).
pub fn naws(stream: &[u8]) -> Vec<(u16, u16)> {
    commands(stream)
        .into_iter()
        .filter_map(|command| match command {
            Command::Sub(payload) => match payload.as_slice() {
                [NAWS, w1, w0, h1, h0] => Some((
                    u16::from_be_bytes([*w1, *w0]),
                    u16::from_be_bytes([*h1, *h0]),
                )),
                _ => None,
            },
            Command::Verb(..) => None,
        })
        .collect()
}

/// Every two-byte option command appears at most once.
pub fn assert_no_repeats(stream: &[u8], side: &str) {
    let verbs: Vec<_> = commands(stream)
        .into_iter()
        .filter(|command| matches!(command, Command::Verb(..)))
        .collect();
    for (index, verb) in verbs.iter().enumerate() {
        assert!(
            !verbs[..index].contains(verb),
            "{side} repeated {verb:?}: {verbs:?}"
        );
    }
}
