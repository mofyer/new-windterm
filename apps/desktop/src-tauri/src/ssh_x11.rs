//! X11 forwarding (C15) for an interactive SSH terminal. A P0 probe: no UI
//! or IPC yet, and off unless a caller enables it for one connection.
//!
//! The real cookie never leaves this computer. The server is sent a random
//! fake MIT-MAGIC-COOKIE-1; every `x11` channel it opens must begin with an
//! X11 connection setup that carries exactly that fake cookie. Only then is
//! the local display contacted, with the real cookie (from `xauth list`)
//! substituted. A wrong setup closes the channel and the display is never
//! contacted. Unlike `ssh -X`, no X SECURITY "untrusted" cookie is generated:
//! remote X clients get the same rights on the local display as local ones.
//! A `DISPLAY` on a TCP host receives the real cookie in clear, as with `ssh -X`.
use super::{forward, Login, Routes, Ssh, DEADLINE};
use crate::pty::EventSink;
use russh::{client, keys::ssh_key::rand_core::Rng as _, ChannelMsg};
use std::{
    io::Read,
    ops::Range,
    path::Path,
    process::Stdio,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::io::{AsyncRead, AsyncWrite, AsyncWriteExt};
use zeroize::Zeroizing;

/// The only authorization protocol forwarded.
const PROTOCOL_NAME: &str = "MIT-MAGIC-COOKIE-1";
const PROTOCOL: &[u8] = PROTOCOL_NAME.as_bytes();
/// MIT-MAGIC-COOKIE-1 is 128 bits; the fake one has the same length.
const COOKIE_LEN: usize = 16;
/// Concurrent `x11` channels per connection unless a caller lowers it.
pub const MAX_CHANNELS: usize = 32;
/// Fixed part of an X11 connection setup, before the two strings.
const HEADER: usize = 12;
/// Bytes buffered while waiting for a complete setup.
const MAX_SETUP: usize = 64 * 1024;
const CONNECT_WAIT: Duration = Duration::from_secs(5);
const XAUTH_WAIT: Duration = Duration::from_secs(5);
const MAX_XAUTH_OUTPUT: usize = 64 * 1024;
const MAX_DISPLAY: usize = 512;
const X_TCP_BASE: u32 = 6000;
/// Absolute locations only: the app's PATH is not trusted to find xauth.
#[cfg(unix)]
const XAUTH_PATHS: &[&str] = &[
    "/usr/bin/xauth",
    "/usr/X11/bin/xauth",
    "/opt/X11/bin/xauth",
    "/usr/X11R6/bin/xauth",
];
#[cfg(not(unix))]
const XAUTH_PATHS: &[&str] = &[];

const NO_DISPLAY: &str = "X11 forwarding needs a local X server, but DISPLAY is not set";
const BAD_DISPLAY: &str = "X11 forwarding does not support this DISPLAY value";
const NO_XAUTH: &str =
    "X11 forwarding needs xauth to read the local X server's cookie; xauth was not found";
const XAUTH_FAILED: &str = "xauth could not list the local X server's cookie";
const NO_COOKIE: &str = "xauth has no 16-byte MIT-MAGIC-COOKIE-1 for this DISPLAY";
/// Returned when the server answers the `x11-req` with a failure.
pub(super) const REFUSED: &str = "SSH server refused X11 forwarding";

/// Where the local X server listens.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Endpoint {
    #[cfg(unix)]
    Unix(std::path::PathBuf),
    Tcp(String, u16),
}

enum Stream {
    Tcp(tokio::net::TcpStream),
    #[cfg(unix)]
    Unix(tokio::net::UnixStream),
}

impl Endpoint {
    async fn connect(&self) -> std::io::Result<Stream> {
        match self {
            Self::Tcp(host, port) => tokio::net::TcpStream::connect((host.as_str(), *port))
                .await
                .map(Stream::Tcp),
            #[cfg(unix)]
            Self::Unix(path) => tokio::net::UnixStream::connect(path)
                .await
                .map(Stream::Unix),
        }
    }
}

/// The local X server that X11 forwarding reaches, and its real cookie.
pub struct LocalDisplay {
    endpoint: Endpoint,
    cookie: Zeroizing<Vec<u8>>,
    /// Concurrent `x11` channels allowed.
    limit: usize,
}

impl std::fmt::Debug for LocalDisplay {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("LocalDisplay")
            .field("endpoint", &self.endpoint)
            .field("limit", &self.limit)
            .finish_non_exhaustive()
    }
}

impl LocalDisplay {
    /// Resolves `$DISPLAY` and reads its MIT-MAGIC-COOKIE-1 with `xauth
    /// list`, on a blocking thread: xauth may run for up to five seconds.
    pub async fn from_env() -> Result<Self, String> {
        tokio::task::spawn_blocking(Self::from_env_blocking)
            .await
            .map_err(|_| XAUTH_FAILED.to_string())?
    }

    fn from_env_blocking() -> Result<Self, String> {
        let value = std::env::var("DISPLAY").map_err(|_| NO_DISPLAY)?;
        let (endpoint, auth_name) = parse_display(&value)?;
        let program = XAUTH_PATHS
            .iter()
            .map(Path::new)
            .find(|path| path.is_file())
            .ok_or(NO_XAUTH)?;
        let output = run_xauth(program, &auth_name, XAUTH_WAIT)?;
        Ok(Self {
            endpoint,
            cookie: parse_xauth(&output)?,
            limit: MAX_CHANNELS,
        })
    }

    #[cfg(test)]
    pub(crate) fn fixed(endpoint: Endpoint, cookie: [u8; COOKIE_LEN], limit: usize) -> Self {
        Self {
            endpoint,
            cookie: Zeroizing::new(cookie.to_vec()),
            limit,
        }
    }
}

/// X11 forwarding enabled on one connection.
struct Forwarding {
    endpoint: Endpoint,
    real: Zeroizing<Vec<u8>>,
    fake: [u8; COOKIE_LEN],
    channels: Arc<tokio::sync::Semaphore>,
}

/// Whether the server may open `x11` channels on a connection: set by
/// [`request`], cleared with the connection's other routes.
#[derive(Default)]
pub(crate) struct Slot(Mutex<Option<Arc<Forwarding>>>);

impl Slot {
    fn get(&self) -> Option<Arc<Forwarding>> {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    fn set(&self, forwarding: Option<Arc<Forwarding>>) {
        *self.0.lock().unwrap_or_else(|e| e.into_inner()) = forwarding;
    }

    pub(crate) fn clear(&self) {
        self.set(None);
    }
}

/// Enables X11 on `routes` and sends `x11-req` (fake cookie, screen 0, not
/// single-connection) on the session channel. The caller waits for the
/// server's reply before the shell request; a refusal is [`REFUSED`].
pub(super) async fn request(
    channel: &russh::Channel<client::Msg>,
    routes: &Routes,
    display: LocalDisplay,
) -> Result<(), String> {
    let mut fake = [0; COOKIE_LEN];
    russh::keys::key::safe_rng().fill_bytes(&mut fake);
    let cookie = hex(&fake);
    // Routed before the request: the server may open channels as soon as it
    // replies, before the caller sees that reply.
    routes.x11.set(Some(Arc::new(Forwarding {
        endpoint: display.endpoint,
        real: display.cookie,
        fake,
        channels: Arc::new(tokio::sync::Semaphore::new(display.limit)),
    })));
    if channel
        .request_x11(true, false, PROTOCOL_NAME, cookie, 0)
        .await
        .is_err()
    {
        routes.x11.clear();
        return Err("SSH X11 forwarding request failed".into());
    }
    Ok(())
}

/// Handles a server-opened `x11` channel: refused (by dropping `reply`)
/// unless X11 is enabled and below its channel limit.
pub(super) fn accept(
    routes: &Routes,
    channel: russh::Channel<client::Msg>,
    reply: client::ChannelOpenHandle,
) {
    let Some(forwarding) = routes.x11.get() else {
        return;
    };
    let Ok(permit) = forwarding.channels.clone().try_acquire_owned() else {
        return;
    };
    routes.relay(async move {
        let _permit = permit;
        reply.accept().await;
        forwarding.serve(channel).await;
    });
}

impl Forwarding {
    async fn serve(&self, mut channel: russh::Channel<client::Msg>) {
        let setup = tokio::time::timeout(DEADLINE, self.authorize(&mut channel)).await;
        let Ok(Some(setup)) = setup else {
            let _ = channel.close().await;
            return;
        };
        match tokio::time::timeout(CONNECT_WAIT, self.endpoint.connect()).await {
            Ok(Ok(Stream::Tcp(local))) => relay(channel, local, setup).await,
            #[cfg(unix)]
            Ok(Ok(Stream::Unix(local))) => relay(channel, local, setup).await,
            _ => {
                let _ = channel.close().await;
            }
        }
    }

    /// Reads the X11 connection setup and returns it with the real cookie in
    /// place of the fake one, followed by any bytes sent after it. `None`
    /// when the channel ends first or the setup is not exactly ours.
    async fn authorize(
        &self,
        channel: &mut russh::Channel<client::Msg>,
    ) -> Option<Zeroizing<Vec<u8>>> {
        let mut setup = Zeroizing::new(Vec::new());
        loop {
            match check(&setup, &self.fake) {
                Check::Valid(cookie) => {
                    setup[cookie].copy_from_slice(&self.real);
                    return Some(setup);
                }
                Check::Refused => return None,
                Check::Incomplete => {}
            }
            match channel.wait().await? {
                ChannelMsg::Data { data } if setup.len() + data.len() <= MAX_SETUP => {
                    setup.extend_from_slice(&data);
                }
                ChannelMsg::Data { .. } | ChannelMsg::Eof | ChannelMsg::Close => return None,
                _ => {}
            }
        }
    }
}

/// Sends the substituted setup, erases it, then relays in both directions.
async fn relay<S>(channel: russh::Channel<client::Msg>, mut local: S, setup: Zeroizing<Vec<u8>>)
where
    S: AsyncRead + AsyncWrite + Send + Unpin,
{
    let sent = tokio::time::timeout(CONNECT_WAIT, local.write_all(&setup)).await;
    // The real cookie is not kept for the life of the X connection.
    drop(setup);
    match sent {
        Ok(Ok(())) => forward::pump(channel, local).await,
        _ => {
            let _ = channel.close().await;
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
enum Check {
    Incomplete,
    Refused,
    /// Where the cookie is in the setup.
    Valid(Range<usize>),
}

/// X11 strings are padded to a multiple of four bytes.
fn padded(length: usize) -> usize {
    length.next_multiple_of(4)
}

/// Checks the start of an X11 connection setup, in either byte order: the
/// protocol name must be MIT-MAGIC-COOKIE-1 and the data exactly `fake`.
fn check(setup: &[u8], fake: &[u8]) -> Check {
    if setup.len() < HEADER {
        return Check::Incomplete;
    }
    let read: fn([u8; 2]) -> u16 = match setup[0] {
        b'B' => u16::from_be_bytes,
        b'l' => u16::from_le_bytes,
        _ => return Check::Refused,
    };
    let name_len = usize::from(read([setup[6], setup[7]]));
    let data_len = usize::from(read([setup[8], setup[9]]));
    // Decided from the header alone, so at most one setup is ever buffered.
    if name_len != PROTOCOL.len() || data_len != fake.len() {
        return Check::Refused;
    }
    let data_start = HEADER + padded(name_len);
    if setup.len() < data_start + padded(data_len) {
        return Check::Incomplete;
    }
    let data = data_start..data_start + data_len;
    if &setup[HEADER..HEADER + name_len] != PROTOCOL || !same(&setup[data.clone()], fake) {
        return Check::Refused;
    }
    Check::Valid(data)
}

/// Compares in time independent of where the inputs differ, as OpenSSH's
/// `timingsafe_bcmp` does for the same check. Every byte is read through a
/// volatile load, which the compiler must perform, so it cannot turn the loop
/// into an early exit (the barrier the `subtle` crate also relies on).
fn same(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    let mut difference = 0u8;
    for (a, b) in left.iter().zip(right) {
        // SAFETY: `a` and `b` are references to initialized bytes in live slices.
        let (a, b) = unsafe { (std::ptr::read_volatile(a), std::ptr::read_volatile(b)) };
        difference |= a ^ b;
    }
    difference == 0
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn unhex(text: &str) -> Option<Zeroizing<Vec<u8>>> {
    // `from_str_radix` alone would also take a sign, as in "+f".
    if !text.len().is_multiple_of(2) || !text.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let mut bytes = Zeroizing::new(Vec::with_capacity(text.len() / 2));
    for pair in text.as_bytes().chunks(2) {
        let pair = std::str::from_utf8(pair).ok()?;
        bytes.push(u8::from_str_radix(pair, 16).ok()?);
    }
    Some(bytes)
}

/// Splits `$DISPLAY` into where to connect and the name `xauth` knows it by.
/// `:n`/`unix:n` is the Unix socket `/tmp/.X11-unix/X<n>` (TCP port 6000+n
/// on loopback where there are no Unix sockets); `/path:n` is a socket path
/// such as XQuartz's; `host:n` is TCP port 6000+n. Any `.screen` is ignored.
fn parse_display(value: &str) -> Result<(Endpoint, String), String> {
    if value.is_empty()
        || value.len() > MAX_DISPLAY
        || value.chars().any(|c| c.is_control() || c.is_whitespace())
    {
        return Err(BAD_DISPLAY.into());
    }
    let colon = value.rfind(':').ok_or(BAD_DISPLAY)?;
    let (host, rest) = (&value[..colon], &value[colon + 1..]);
    let (number_text, screen) = rest.split_once('.').unwrap_or((rest, "0"));
    let (Some(number), Some(_)) = (digits(number_text), digits(screen)) else {
        return Err(BAD_DISPLAY.into());
    };
    let port = || u16::try_from(X_TCP_BASE + number).map_err(|_| BAD_DISPLAY);
    #[cfg(unix)]
    {
        if host.is_empty() || host == "unix" {
            let socket = format!("/tmp/.X11-unix/X{number}");
            return Ok((Endpoint::Unix(socket.into()), value.into()));
        }
        if host.starts_with('/') {
            // The socket's own name ends in ":<n>"; only a screen is dropped.
            let socket = &value[..colon + 1 + number_text.len()];
            return Ok((Endpoint::Unix(socket.into()), value.into()));
        }
    }
    #[cfg(not(unix))]
    if host.is_empty() || host == "unix" {
        return Ok((Endpoint::Tcp("127.0.0.1".into(), port()?), value.into()));
    }
    if !valid_host(host) {
        return Err(BAD_DISPLAY.into());
    }
    // As OpenSSH does: localhost displays are stored by xauth as unix:<n>.
    let auth_name = if host == "localhost" {
        format!("unix:{rest}")
    } else {
        value.into()
    };
    Ok((Endpoint::Tcp(host.into(), port()?), auth_name))
}

fn digits(text: &str) -> Option<u32> {
    if text.is_empty() || text.len() > 5 || !text.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    text.parse().ok()
}

fn valid_host(host: &str) -> bool {
    !host.is_empty()
        && host.len() <= 253
        && !host.starts_with('-')
        && host
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || ".-_".contains(c))
}

/// Runs `program list <display>` without a shell, with only `XAUTHORITY`
/// and `HOME` passed on. Output is bounded and the process is killed once
/// `wait` has passed.
fn run_xauth(program: &Path, display: &str, wait: Duration) -> Result<Zeroizing<Vec<u8>>, String> {
    let deadline = Instant::now() + wait;
    let mut command = std::process::Command::new(program);
    command
        .arg("list")
        .arg(display)
        .env_clear()
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    for name in ["XAUTHORITY", "HOME"] {
        if let Some(value) = std::env::var_os(name) {
            command.env(name, value);
        }
    }
    let mut child = command.spawn().map_err(|_| XAUTH_FAILED)?;
    let Some(mut stdout) = child.stdout.take() else {
        let _ = child.kill();
        let _ = child.wait();
        return Err(XAUTH_FAILED.into());
    };
    let (sender, receiver) = std::sync::mpsc::channel();
    // Detached: if xauth is killed but a child of it kept stdout open, this
    // thread ends only when that child does. xauth itself starts none.
    std::thread::spawn(move || {
        // Sized up front so the cookie is never left in a freed buffer.
        let mut output = Zeroizing::new(Vec::with_capacity(MAX_XAUTH_OUTPUT + 1));
        let read = (&mut stdout)
            .take(MAX_XAUTH_OUTPUT as u64 + 1)
            .read_to_end(&mut output);
        let _ = sender.send(read.map(|_| output));
    });
    let output = receiver.recv_timeout(wait);
    let finished = match &output {
        Ok(Ok(output)) if output.len() <= MAX_XAUTH_OUTPUT => loop {
            match child.try_wait() {
                Ok(Some(status)) => break Some(status),
                Ok(None) if Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(5))
                }
                _ => break None,
            }
        },
        _ => None,
    };
    if finished.is_none() {
        let _ = child.kill();
        let _ = child.wait();
    }
    match (output, finished) {
        (Ok(Ok(output)), Some(status)) if status.success() => Ok(output),
        (Ok(Ok(output)), _) if output.len() > MAX_XAUTH_OUTPUT => {
            Err("xauth output exceeds 64 KiB".into())
        }
        (Err(_), _) | (Ok(Ok(_)), None) => Err("xauth did not finish in time".into()),
        _ => Err(XAUTH_FAILED.into()),
    }
}

/// The first well-formed MIT-MAGIC-COOKIE-1 in `xauth list` output
/// (`<display>  <protocol>  <hex data>` per line).
fn parse_xauth(output: &[u8]) -> Result<Zeroizing<Vec<u8>>, String> {
    let text = std::str::from_utf8(output).map_err(|_| NO_COOKIE)?;
    text.lines()
        .filter_map(|line| {
            let fields: Vec<&str> = line.split_whitespace().collect();
            match fields.as_slice() {
                [_, protocol, data] if protocol.as_bytes() == PROTOCOL => unhex(data),
                _ => None,
            }
        })
        .find(|cookie| cookie.len() == COOKIE_LEN)
        .ok_or_else(|| NO_COOKIE.into())
}

impl Ssh {
    /// [`Ssh::open_with`], also asking the server to forward X11 to `display`
    /// for this terminal only. Fails, and opens nothing, if the server
    /// refuses. Remote X clients are accepted until the terminal ends.
    #[allow(clippy::too_many_arguments)]
    pub async fn open_with_x11(
        self: &Arc<Self>,
        owner: &str,
        id: &str,
        token: &str,
        scope: &str,
        login: impl Into<Login>,
        cols: u16,
        rows: u16,
        sink: EventSink,
        display: LocalDisplay,
    ) -> Result<String, String> {
        self.open_session(
            owner,
            id,
            token,
            scope,
            login,
            (cols, rows),
            sink,
            Some(display),
            None,
        )
        .await
    }
}

#[cfg(test)]
#[path = "ssh_x11_tests.rs"]
mod tests;
