//! Ways to reach an SSH server other than a direct TCP connection (P0 for
//! C07, C19, C20): an HTTP CONNECT proxy, a SOCKS5 proxy and a ProxyCommand.
//! Each yields a byte stream that `ssh_route.rs` hands to the pinned SSH
//! handshake, so host-key pinning and authentication are unchanged. Nothing
//! is saved; proxy secrets are copied only into zeroized buffers.
use std::{
    io::{Read, Write},
    net::IpAddr,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt, DuplexStream},
    net::{TcpStream, ToSocketAddrs},
};
use zeroize::Zeroizing;

const MAX_RESPONSE_HEADER: usize = 8 * 1024;
pub(crate) const MAX_ARGUMENTS: usize = 64;

fn base64(input: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(input.len().div_ceil(3) * 4);
    for chunk in input.chunks(3) {
        let n = chunk
            .iter()
            .enumerate()
            .fold(0u32, |n, (i, b)| n | (u32::from(*b) << (16 - 8 * i)));
        for i in 0..4 {
            out.push(if i <= chunk.len() {
                TABLE[(n >> (18 - 6 * i)) as usize & 63] as char
            } else {
                '='
            });
        }
    }
    out
}

fn authority(host: &str, port: u16) -> String {
    match host.parse::<IpAddr>() {
        Ok(IpAddr::V6(_)) => format!("[{host}]:{port}"),
        _ => format!("{host}:{port}"),
    }
}

/// `CONNECT host:port` through an HTTP proxy, optionally with Basic auth.
/// Errors never quote the proxy's reason phrase, which could echo a secret.
pub(crate) async fn http_connect(
    proxy: impl ToSocketAddrs,
    host: &str,
    port: u16,
    basic: Option<(&str, &str)>,
) -> Result<TcpStream, String> {
    // The host is written into the request line; CR/LF or spaces would
    // inject headers or split the line.
    if host.is_empty() || host.bytes().any(|b| b <= b' ' || b == 0x7f) {
        return Err("Host name contains invalid characters".into());
    }
    let mut stream = TcpStream::connect(proxy)
        .await
        .map_err(|_| "HTTP proxy is unreachable")?;
    let target = authority(host, port);
    // Buffers holding the secret are sized up front: a reallocation would
    // free a copy without zeroizing it.
    let encoded = basic.map(|(user, password)| {
        let mut pair = Zeroizing::new(String::with_capacity(user.len() + password.len() + 1));
        pair.push_str(user);
        pair.push(':');
        pair.push_str(password);
        Zeroizing::new(base64(pair.as_bytes()))
    });
    const AUTH: &str = "Proxy-Authorization: Basic ";
    let secret_len = encoded.as_ref().map_or(0, |e| AUTH.len() + e.len() + 2);
    let mut request = Zeroizing::new(String::with_capacity(2 * target.len() + 40 + secret_len));
    request.push_str("CONNECT ");
    request.push_str(&target);
    request.push_str(" HTTP/1.1\r\nHost: ");
    request.push_str(&target);
    request.push_str("\r\n");
    if let Some(encoded) = &encoded {
        request.push_str(AUTH);
        request.push_str(encoded);
        request.push_str("\r\n");
    }
    request.push_str("\r\n");
    stream
        .write_all(request.as_bytes())
        .await
        .map_err(|_| "HTTP proxy closed the connection")?;
    // Read byte by byte so no tunnelled bytes are consumed with the header.
    let mut header = Vec::new();
    while !header.ends_with(b"\r\n\r\n") {
        if header.len() >= MAX_RESPONSE_HEADER {
            return Err("HTTP proxy response header exceeds 8 KiB".into());
        }
        let byte = stream
            .read_u8()
            .await
            .map_err(|_| "HTTP proxy closed the connection")?;
        header.push(byte);
    }
    let status_line = String::from_utf8_lossy(&header);
    let status_line = status_line.lines().next().unwrap_or_default();
    let code = status_line.split(' ').nth(1).unwrap_or_default();
    if !status_line.starts_with("HTTP/1.")
        || code.len() != 3
        || !code.bytes().all(|b| b.is_ascii_digit())
    {
        return Err("HTTP proxy sent an invalid response".into());
    }
    if code != "200" {
        return Err(format!("HTTP proxy refused the tunnel (status {code})"));
    }
    Ok(stream)
}

/// SOCKS5 CONNECT (RFC 1928), with optional username/password (RFC 1929).
pub(crate) async fn socks5_connect(
    proxy: impl ToSocketAddrs,
    host: &str,
    port: u16,
    login: Option<(&str, &str)>,
) -> Result<TcpStream, String> {
    let closed = || "SOCKS5 proxy closed the connection".to_string();
    let mut stream = TcpStream::connect(proxy)
        .await
        .map_err(|_| "SOCKS5 proxy is unreachable")?;
    let greeting: &[u8] = if login.is_some() {
        &[5, 2, 0, 2]
    } else {
        &[5, 1, 0]
    };
    stream.write_all(greeting).await.map_err(|_| closed())?;
    let mut choice = [0; 2];
    stream.read_exact(&mut choice).await.map_err(|_| closed())?;
    match (choice, login) {
        ([5, 0], _) => {}
        ([5, 2], Some((user, password))) => {
            if user.len() > 255 || password.len() > 255 {
                return Err("SOCKS5 username and password are limited to 255 bytes".into());
            }
            // Sized up front so no reallocation leaves an unzeroized copy.
            let mut request = Zeroizing::new(Vec::with_capacity(3 + user.len() + password.len()));
            request.extend_from_slice(&[1, user.len() as u8]);
            request.extend_from_slice(user.as_bytes());
            request.push(password.len() as u8);
            request.extend_from_slice(password.as_bytes());
            stream.write_all(&request).await.map_err(|_| closed())?;
            let mut status = [0; 2];
            stream.read_exact(&mut status).await.map_err(|_| closed())?;
            if status[1] != 0 {
                return Err("SOCKS5 proxy rejected the username or password".into());
            }
        }
        _ => return Err("SOCKS5 proxy requires an unsupported authentication method".into()),
    }
    let mut request = vec![5, 1, 0];
    match host.parse::<IpAddr>() {
        Ok(IpAddr::V4(ip)) => {
            request.push(1);
            request.extend_from_slice(&ip.octets());
        }
        Ok(IpAddr::V6(ip)) => {
            request.push(4);
            request.extend_from_slice(&ip.octets());
        }
        Err(_) => {
            let name = host.as_bytes();
            if name.len() > 255 {
                return Err("SOCKS5 host name exceeds 255 bytes".into());
            }
            request.extend_from_slice(&[3, name.len() as u8]);
            request.extend_from_slice(name);
        }
    }
    request.extend_from_slice(&port.to_be_bytes());
    stream.write_all(&request).await.map_err(|_| closed())?;
    let mut reply = [0; 4];
    stream.read_exact(&mut reply).await.map_err(|_| closed())?;
    if reply[1] != 0 {
        return Err(format!(
            "SOCKS5 proxy could not connect (code {})",
            reply[1]
        ));
    }
    let skip = match reply[3] {
        1 => 4 + 2,
        4 => 16 + 2,
        3 => usize::from(stream.read_u8().await.map_err(|_| closed())?) + 2,
        _ => return Err("SOCKS5 proxy sent an invalid reply".into()),
    };
    let mut bound = vec![0; skip];
    stream.read_exact(&mut bound).await.map_err(|_| closed())?;
    Ok(stream)
}

/// Splits a ProxyCommand into argv without a shell: whitespace separates,
/// single quotes are literal, double quotes allow `\"` and `\\`.
pub(crate) fn split_command(command: &str) -> Result<Vec<String>, String> {
    let mut args = Vec::new();
    let mut current: Option<String> = None;
    let mut chars = command.chars();
    while let Some(c) = chars.next() {
        match c {
            ' ' | '\t' => {
                if let Some(arg) = current.take() {
                    args.push(arg);
                }
            }
            '\'' => {
                let arg = current.get_or_insert_with(String::new);
                loop {
                    match chars.next() {
                        Some('\'') => break,
                        Some(c) => arg.push(c),
                        None => return Err("Unterminated quote in ProxyCommand".into()),
                    }
                }
            }
            '"' => {
                let arg = current.get_or_insert_with(String::new);
                loop {
                    match chars.next() {
                        Some('"') => break,
                        Some('\\') => match chars.next() {
                            Some(c @ ('"' | '\\')) => arg.push(c),
                            Some(c) => {
                                arg.push('\\');
                                arg.push(c);
                            }
                            None => return Err("Unterminated quote in ProxyCommand".into()),
                        },
                        Some(c) => arg.push(c),
                        None => return Err("Unterminated quote in ProxyCommand".into()),
                    }
                }
            }
            c if c.is_control() => return Err("ProxyCommand contains a control character".into()),
            c => current.get_or_insert_with(String::new).push(c),
        }
    }
    args.extend(current);
    if args.is_empty() || args.len() > MAX_ARGUMENTS {
        return Err("ProxyCommand must have 1 to 64 arguments".into());
    }
    Ok(args)
}

/// `%h`, `%p`, `%r` and `%%` as in OpenSSH; other `%` sequences are refused.
fn substitute(arg: &str, host: &str, port: u16, user: &str) -> Result<String, String> {
    let mut out = String::new();
    let mut chars = arg.chars();
    while let Some(c) = chars.next() {
        if c != '%' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('h') => out.push_str(host),
            Some('p') => out.push_str(&port.to_string()),
            Some('r') => out.push_str(user),
            Some('%') => out.push('%'),
            _ => return Err("ProxyCommand supports only %h, %p, %r and %%".into()),
        }
    }
    Ok(out)
}

/// The exact argv a ProxyCommand runs: split without a shell, then `%h`,
/// `%p` and `%r` substituted inside each argument. Nothing is started here.
pub(crate) fn prepare(
    command: &str,
    host: &str,
    port: u16,
    user: &str,
) -> Result<Vec<String>, String> {
    split_command(command)?
        .iter()
        .map(|arg| substitute(arg, host, port, user))
        .collect()
}

/// The ProxyCommand process. It runs in its own process group (Unix) or
/// kill-on-close Job Object (Windows), so dropping it ends everything it
/// started, not only the direct child, and then reaps the child.
///
/// Limits: a descendant that leaves the group (`setsid`) survives and can
/// keep the stdout bridge thread blocked until it exits. On Windows the job
/// is assigned just after the child starts, so a grandchild it creates in
/// that instant is outside the job.
pub(crate) struct ProxyProcess {
    // Always `Some` until dropped; taken so a stuck child is reaped elsewhere.
    child: Option<std::process::Child>,
    #[cfg(windows)]
    tree: crate::platform::windows::ProcessTree,
}

impl ProxyProcess {
    #[cfg(all(test, unix))]
    pub(crate) fn id(&self) -> u32 {
        self.child.as_ref().map_or(0, std::process::Child::id)
    }
}

impl Drop for ProxyProcess {
    fn drop(&mut self) {
        let Some(mut child) = self.child.take() else {
            return;
        };
        #[cfg(unix)]
        if let Ok(group) = libc::pid_t::try_from(child.id()) {
            // 0 and 1 would signal this process's own group or every process.
            if group > 1 {
                // SAFETY: the child is not reaped yet, so its pid, which is
                // also its process group id, cannot have been reused.
                unsafe { libc::killpg(group, libc::SIGKILL) };
            }
        }
        #[cfg(windows)]
        self.tree.terminate();
        let _ = child.kill();
        // Drops run on async workers: a child stuck in an uninterruptible
        // wait is reaped on a detached thread instead of blocking one. Its
        // pid stays reserved until then, so the group id is never reused.
        if !matches!(child.try_wait(), Ok(Some(_))) {
            let _ = std::thread::Builder::new()
                .name("proxy-command-reaper".into())
                .spawn(move || {
                    let _ = child.wait();
                });
        }
    }
}

/// Runs a ProxyCommand (no shell) and returns a stream over its stdio.
/// Keep the returned process alive as long as the SSH session.
#[cfg(all(test, unix))]
pub(crate) fn proxy_command(
    command: &str,
    host: &str,
    port: u16,
    user: &str,
) -> Result<(DuplexStream, ProxyProcess), String> {
    spawn(&prepare(command, host, port, user)?)
}

/// Starts `argv` exactly as given (no shell) and bridges its stdin and
/// stdout to the returned stream. Keep the process as long as the session.
pub(crate) fn spawn(argv: &[String]) -> Result<(DuplexStream, ProxyProcess), String> {
    let (program, args) = argv.split_first().ok_or("ProxyCommand is empty")?;
    let mut command = std::process::Command::new(program);
    command
        .args(args)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());
    // Its own process group: helpers it forks end with the session.
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    // A GUI process must not open a console window for the helper.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = command
        .spawn()
        .map_err(|_| "ProxyCommand could not be started")?;
    let pipes = (child.stdin.take(), child.stdout.take());
    // Without a job the process tree cannot be bounded; refuse to continue.
    #[cfg(windows)]
    let tree = {
        use std::os::windows::io::AsRawHandle;
        match crate::platform::windows::ProcessTree::adopt(child.as_raw_handle()) {
            Ok(tree) => tree,
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("ProxyCommand could not be contained".into());
            }
        }
    };
    let process = ProxyProcess {
        child: Some(child),
        #[cfg(windows)]
        tree,
    };
    let (Some(mut stdin), Some(mut stdout)) = pipes else {
        return Err("ProxyCommand pipes are unavailable".into());
    };
    let (ours, theirs) = tokio::io::duplex(64 * 1024);
    let (mut to_ssh_read, mut to_ssh_write) = tokio::io::split(theirs);
    let runtime = tokio::runtime::Handle::current();
    let reader = runtime.clone();
    // Blocking pipes are bridged on blocking threads; each ends with its pipe.
    tokio::task::spawn_blocking(move || {
        let mut buffer = [0; 32 * 1024];
        while let Ok(n) = stdout.read(&mut buffer) {
            if n == 0
                || reader
                    .block_on(to_ssh_write.write_all(&buffer[..n]))
                    .is_err()
            {
                break;
            }
        }
        let _ = reader.block_on(to_ssh_write.shutdown());
    });
    tokio::task::spawn_blocking(move || {
        let mut buffer = [0; 32 * 1024];
        while let Ok(n) = runtime.block_on(to_ssh_read.read(&mut buffer)) {
            if n == 0 || stdin.write_all(&buffer[..n]).is_err() {
                break;
            }
        }
    });
    Ok((ours, process))
}

#[cfg(test)]
#[path = "../tests/support/test_proxy.rs"]
#[allow(dead_code)]
pub(crate) mod test_proxy;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ssh::{connect_pinned, forward::fixture, observe_host_key, Credential, Request};
    use std::time::Duration;

    fn pin(server: &fixture::Fixture) -> Vec<u8> {
        server.host.lock().unwrap().public_key().to_bytes().unwrap()
    }

    /// Authenticates over `stream` and runs `exit` in the fixture shell.
    async fn exit_code<S>(stream: S, server: &fixture::Fixture) -> Option<u32>
    where
        S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
    {
        let request = Request {
            host: "127.0.0.1".into(),
            port: server.port,
            username: "fixture".into(),
            private_key_path: server.key_path.to_string_lossy().into(),
        };
        let (_, cancel) = tokio::sync::watch::channel(false);
        let ssh = connect_pinned(
            stream,
            &request,
            pin(server),
            &Credential::default(),
            cancel,
        )
        .await
        .unwrap();
        let mut channel = ssh.channel_open_session().await.unwrap();
        channel
            .request_pty(true, "xterm", 80, 24, 0, 0, &[])
            .await
            .unwrap();
        channel.request_shell(true).await.unwrap();
        channel.data(&b"exit\n"[..]).await.unwrap();
        let mut status = None;
        while let Some(message) = tokio::time::timeout(Duration::from_secs(10), channel.wait())
            .await
            .unwrap()
        {
            if let russh::ChannelMsg::ExitStatus { exit_status } = message {
                status = Some(exit_status);
            }
        }
        status
    }

    #[test]
    fn helpers_encode_and_split_without_a_shell() {
        assert_eq!(base64(b"user:pass"), "dXNlcjpwYXNz");
        assert_eq!(base64(b"ab"), "YWI=");
        assert_eq!(
            split_command(r#"nc -X connect -x 'proxy host:8080' "%h" %p"#).unwrap(),
            ["nc", "-X", "connect", "-x", "proxy host:8080", "%h", "%p"]
        );
        assert!(split_command("nc 'unterminated").is_err());
        assert!(split_command("").is_err());
        assert_eq!(
            substitute("%r@%h:%p%%", "example", 22, "me").unwrap(),
            "me@example:22%"
        );
        assert!(substitute("%d", "h", 1, "u").is_err());
        // Shell syntax has no meaning: `;` stays a literal argument.
        assert_eq!(split_command("nc %h %p; rm -rf /").unwrap().len(), 6);
    }

    #[tokio::test]
    async fn http_connect_proxy_carries_a_pinned_session_and_reports_refusal() {
        let mut server = fixture::Fixture::start().await;
        let open_proxy = test_proxy::start(test_proxy::Kind::Http, None).await;
        let open = open_proxy.address;
        let observed = observe_host_key(
            http_connect(open, "127.0.0.1", server.port, None)
                .await
                .unwrap(),
        )
        .await
        .unwrap();
        assert_eq!(observed.to_bytes().unwrap(), pin(&server));
        assert_eq!(
            exit_code(
                http_connect(open, "127.0.0.1", server.port, None)
                    .await
                    .unwrap(),
                &server
            )
            .await,
            Some(7)
        );
        let guarded_proxy = test_proxy::start(test_proxy::Kind::Http, Some(("p0", "secret"))).await;
        let guarded = guarded_proxy.address;
        let refused = http_connect(guarded, "127.0.0.1", server.port, None)
            .await
            .err()
            .unwrap();
        assert_eq!(refused, "HTTP proxy refused the tunnel (status 407)");
        // A wrong password is refused without echoing it.
        let wrong = http_connect(guarded, "127.0.0.1", server.port, Some(("p0", "wrong-pw")))
            .await
            .err()
            .unwrap();
        assert!(!wrong.contains("wrong-pw"), "{wrong}");
        assert_eq!(open_proxy.tunnels(), [server.port, server.port]);
        let stream = http_connect(guarded, "127.0.0.1", server.port, Some(("p0", "secret")))
            .await
            .unwrap();
        assert_eq!(exit_code(stream, &server).await, Some(7));
        for host in ["", "a\r\nX-Injected: 1", "a b", "a\0"] {
            let error = http_connect(open, host, server.port, None)
                .await
                .err()
                .unwrap();
            assert!(error.contains("invalid characters"), "{host:?}: {error}");
        }
        server.stop().await;
    }

    #[tokio::test]
    async fn socks5_proxy_with_and_without_login() {
        let mut server = fixture::Fixture::start().await;
        let open_proxy = test_proxy::start(test_proxy::Kind::Socks5, None).await;
        let open = open_proxy.address;
        assert_eq!(
            exit_code(
                socks5_connect(open, "127.0.0.1", server.port, None)
                    .await
                    .unwrap(),
                &server
            )
            .await,
            Some(7)
        );
        let guarded_proxy =
            test_proxy::start(test_proxy::Kind::Socks5, Some(("p0", "secret"))).await;
        let guarded = guarded_proxy.address;
        let wrong = socks5_connect(guarded, "localhost", server.port, Some(("p0", "nope")))
            .await
            .err()
            .unwrap();
        assert!(wrong.contains("rejected"), "{wrong}");
        let stream = socks5_connect(guarded, "localhost", server.port, Some(("p0", "secret")))
            .await
            .unwrap();
        assert_eq!(exit_code(stream, &server).await, Some(7));
        server.stop().await;
    }

    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread")]
    async fn proxy_command_runs_without_a_shell_and_is_killed_on_drop() {
        if !std::path::Path::new("/usr/bin/nc").exists() {
            eprintln!("skipped: /usr/bin/nc is not installed");
            return;
        }
        let mut server = fixture::Fixture::start().await;
        let (stream, process) =
            proxy_command("/usr/bin/nc %h %p", "127.0.0.1", server.port, "fixture").unwrap();
        let pid = process.id();
        assert_eq!(exit_code(stream, &server).await, Some(7));
        drop(process);
        assert!(gone(pid).await, "ProxyCommand outlived its session");
        assert!(proxy_command("/nonexistent/p0-proxy %h %p", "h", 1, "u").is_err());
        server.stop().await;
    }

    /// Whether `pid` disappears (killed and reaped) within two seconds.
    #[cfg(unix)]
    async fn gone(pid: u32) -> bool {
        let pid = libc::pid_t::try_from(pid).unwrap();
        for _ in 0..200 {
            // SAFETY: signal 0 only checks whether the pid still exists.
            if unsafe { libc::kill(pid, 0) } != 0 {
                return true;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        false
    }

    /// A helper the ProxyCommand starts in the background ends with it,
    /// which killing only the direct child would not achieve.
    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread")]
    async fn dropping_a_proxy_command_ends_the_processes_it_started() {
        let argv = ["/bin/sh", "-c", "sleep 300 & echo $!; wait"].map(String::from);
        let (mut stream, process) = spawn(&argv).unwrap();
        let mut line = Vec::new();
        while !line.ends_with(b"\n") {
            let byte = tokio::time::timeout(Duration::from_secs(5), stream.read_u8())
                .await
                .expect("the helper did not report its background pid")
                .unwrap();
            line.push(byte);
        }
        let background: u32 = std::str::from_utf8(&line).unwrap().trim().parse().unwrap();
        let direct = process.id();
        drop(process);
        assert!(gone(direct).await, "the ProxyCommand outlived its session");
        assert!(gone(background).await, "its background helper survived");
    }
}
