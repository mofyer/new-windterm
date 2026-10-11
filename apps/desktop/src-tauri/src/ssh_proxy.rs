// P0 probe without a UI consumer; the ProxyCommand test is Unix-only.
#![allow(dead_code)]
//! Ways to reach an SSH server other than a direct TCP connection (P0 probes
//! for C07, C19, C20): an HTTP CONNECT proxy, a SOCKS5 proxy and a
//! ProxyCommand. Each yields a byte stream for `connect_pinned`, so host-key
//! pinning and authentication are unchanged. No UI or saved settings yet.
use std::{
    io::{Read, Write},
    net::{IpAddr, SocketAddr},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt, DuplexStream},
    net::TcpStream,
};

const MAX_RESPONSE_HEADER: usize = 8 * 1024;
const MAX_ARGUMENTS: usize = 64;

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
pub(crate) async fn http_connect(
    proxy: SocketAddr,
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
    let mut request = format!("CONNECT {target} HTTP/1.1\r\nHost: {target}\r\n");
    if let Some((user, password)) = basic {
        request += &format!(
            "Proxy-Authorization: Basic {}\r\n",
            base64(format!("{user}:{password}").as_bytes())
        );
    }
    request += "\r\n";
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
    if !status_line.starts_with("HTTP/1.") || code != "200" {
        return Err(format!(
            "HTTP proxy refused the tunnel: {}",
            status_line.chars().take(80).collect::<String>()
        ));
    }
    Ok(stream)
}

/// SOCKS5 CONNECT (RFC 1928), with optional username/password (RFC 1929).
pub(crate) async fn socks5_connect(
    proxy: SocketAddr,
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
            let mut request = vec![1, user.len() as u8];
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

/// The ProxyCommand process; killed and reaped when dropped.
pub(crate) struct ProxyProcess(std::process::Child);

impl ProxyProcess {
    pub(crate) fn id(&self) -> u32 {
        self.0.id()
    }
}

impl Drop for ProxyProcess {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

/// Runs a ProxyCommand (no shell) and returns a stream over its stdio.
/// Keep the returned process alive as long as the SSH session.
pub(crate) fn proxy_command(
    command: &str,
    host: &str,
    port: u16,
    user: &str,
) -> Result<(DuplexStream, ProxyProcess), String> {
    let argv = split_command(command)?
        .iter()
        .map(|arg| substitute(arg, host, port, user))
        .collect::<Result<Vec<_>, _>>()?;
    let mut child = std::process::Command::new(&argv[0])
        .args(&argv[1..])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|_| "ProxyCommand could not be started")?;
    let (mut stdin, mut stdout) = (child.stdin.take().unwrap(), child.stdout.take().unwrap());
    let process = ProxyProcess(child);
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
mod tests {
    use super::*;
    use crate::ssh::{connect_pinned, forward::fixture, observe_host_key, Credential, Request};
    use std::time::Duration;
    use tokio::net::TcpListener;

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

    /// A test proxy: `accept` decides whether to tunnel, then bytes are relayed.
    async fn proxy(
        kind: &'static str,
        credentials: Option<(&'static str, &'static str)>,
    ) -> SocketAddr {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            while let Ok((mut client, _)) = listener.accept().await {
                tokio::spawn(async move {
                    let target = if kind == "http" {
                        http_proxy(&mut client, credentials).await
                    } else {
                        socks_proxy(&mut client, credentials).await
                    };
                    if let Some(port) = target {
                        let mut upstream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
                        let _ = tokio::io::copy_bidirectional(&mut client, &mut upstream).await;
                    }
                });
            }
        });
        address
    }

    async fn http_proxy(client: &mut TcpStream, credentials: Option<(&str, &str)>) -> Option<u16> {
        let mut header = Vec::new();
        while !header.ends_with(b"\r\n\r\n") {
            header.push(client.read_u8().await.ok()?);
        }
        let text = String::from_utf8(header).ok()?;
        let authorized = credentials.is_none_or(|(user, password)| {
            text.contains(&format!(
                "Proxy-Authorization: Basic {}",
                base64(format!("{user}:{password}").as_bytes())
            ))
        });
        if !authorized {
            let _ = client
                .write_all(b"HTTP/1.1 407 Proxy Authentication Required\r\n\r\n")
                .await;
            return None;
        }
        let port = text
            .split_whitespace()
            .nth(1)?
            .rsplit(':')
            .next()?
            .parse()
            .ok()?;
        client
            .write_all(b"HTTP/1.1 200 Connection established\r\n\r\n")
            .await
            .ok()?;
        Some(port)
    }

    async fn socks_proxy(client: &mut TcpStream, credentials: Option<(&str, &str)>) -> Option<u16> {
        let mut greeting = [0; 2];
        client.read_exact(&mut greeting).await.ok()?;
        let mut methods = vec![0; greeting[1] as usize];
        client.read_exact(&mut methods).await.ok()?;
        if let Some((user, password)) = credentials {
            client.write_all(&[5, 2]).await.ok()?;
            let mut version = [0; 2];
            client.read_exact(&mut version).await.ok()?;
            let mut name = vec![0; version[1] as usize];
            client.read_exact(&mut name).await.ok()?;
            let length = client.read_u8().await.ok()?;
            let mut secret = vec![0; length as usize];
            client.read_exact(&mut secret).await.ok()?;
            let ok = name == user.as_bytes() && secret == password.as_bytes();
            client.write_all(&[1, u8::from(!ok)]).await.ok()?;
            if !ok {
                return None;
            }
        } else {
            client.write_all(&[5, 0]).await.ok()?;
        }
        let mut request = [0; 4];
        client.read_exact(&mut request).await.ok()?;
        let length = if request[3] == 1 {
            4
        } else {
            client.read_u8().await.ok()? as usize
        };
        let mut address = vec![0; length + 2];
        client.read_exact(&mut address).await.ok()?;
        client
            .write_all(&[5, 0, 0, 1, 127, 0, 0, 1, 0, 0])
            .await
            .ok()?;
        Some(u16::from_be_bytes([address[length], address[length + 1]]))
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
        let open = proxy("http", None).await;
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
        let guarded = proxy("http", Some(("p0", "secret"))).await;
        let refused = http_connect(guarded, "127.0.0.1", server.port, None)
            .await
            .err()
            .unwrap();
        assert!(refused.contains("407"), "{refused}");
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
        let open = proxy("socks", None).await;
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
        let guarded = proxy("socks", Some(("p0", "secret"))).await;
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
        // SAFETY: signal 0 only checks whether the reaped pid still exists.
        assert_ne!(
            unsafe { libc::kill(pid as i32, 0) },
            0,
            "ProxyCommand outlived its session"
        );
        assert!(proxy_command("/nonexistent/p0-proxy %h %p", "h", 1, "u").is_err());
        server.stop().await;
    }
}
