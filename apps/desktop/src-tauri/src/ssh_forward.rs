#![cfg_attr(not(test), allow(dead_code))]
//! Forwarding over an authenticated session (P0 probes for C08, C16, C18):
//! local port forwarding, a SOCKS5 dynamic forward and jump-host hops. Every
//! hop is a separate SSH session pinned to its own confirmed host key. No UI
//! or persistence yet; callers own the sessions.
use super::{connect_pinned, observe_host_key, Credential, KeyCheck, Request};
use russh::{client, keys::PublicKey};
use std::{
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr},
    sync::Arc,
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::watch,
    task::{JoinHandle, JoinSet},
};

const MAX_CONNECTIONS: usize = 64;
const HANDSHAKE: Duration = Duration::from_secs(5);

/// Where accepted local connections are sent.
#[derive(Clone)]
pub(crate) enum Target {
    /// `ssh -L`: always the same remote host and port.
    Fixed { host: String, port: u16 },
    /// `ssh -D`: the client names the destination with SOCKS5 CONNECT.
    Socks5,
}

/// A running listener. Dropping it without `stop` leaves the task running.
pub(crate) struct Forward {
    pub(crate) local: SocketAddr,
    stop: watch::Sender<bool>,
    task: JoinHandle<()>,
}

impl Forward {
    /// Stops listening and closes every forwarded connection and channel.
    pub(crate) async fn stop(self) {
        self.stop.send_replace(true);
        let _ = self.task.await;
    }
}

/// Listens on a loopback address and relays each connection through a new
/// `direct-tcpip` channel of `session`.
pub(crate) async fn listen(
    session: Arc<client::Handle<KeyCheck>>,
    bind: SocketAddr,
    target: Target,
) -> Result<Forward, String> {
    if !bind.ip().is_loopback() {
        return Err("P0 forwarding listens on loopback addresses only".into());
    }
    let listener = TcpListener::bind(bind)
        .await
        .map_err(|error| format!("Cannot listen on {bind}: {}", error.kind()))?;
    let local = listener
        .local_addr()
        .map_err(|_| "Listener address unavailable")?;
    let (stop, mut stopped) = watch::channel(false);
    let task = tokio::spawn(async move {
        let mut connections = JoinSet::new();
        loop {
            tokio::select! {
                biased;
                _ = stopped.changed() => break,
                Some(_) = connections.join_next(), if !connections.is_empty() => {}
                accepted = listener.accept() => {
                    let Ok((client, origin)) = accepted else { break };
                    if connections.len() >= MAX_CONNECTIONS {
                        continue; // dropping `client` refuses it
                    }
                    let (session, target) = (session.clone(), target.clone());
                    connections.spawn(async move { relay(&session, client, origin, &target).await });
                }
            }
        }
        // Dropping the tasks drops their sockets and channel streams.
        connections.abort_all();
        while connections.join_next().await.is_some() {}
    });
    Ok(Forward { local, stop, task })
}

async fn relay(
    session: &client::Handle<KeyCheck>,
    mut client: TcpStream,
    origin: SocketAddr,
    target: &Target,
) -> Result<(), String> {
    let (host, port) = match target {
        Target::Fixed { host, port } => (host.clone(), *port),
        Target::Socks5 => tokio::time::timeout(HANDSHAKE, socks5_request(&mut client))
            .await
            .map_err(|_| "SOCKS5 handshake timed out")??,
    };
    let channel = session
        .channel_open_direct_tcpip(
            host,
            port.into(),
            origin.ip().to_string(),
            origin.port().into(),
        )
        .await;
    let socks = matches!(target, Target::Socks5);
    let channel = match channel {
        Ok(channel) => channel,
        Err(_) => {
            if socks {
                // 0x05: connection refused by the destination side.
                let _ = client.write_all(&[5, 5, 0, 1, 0, 0, 0, 0, 0, 0]).await;
            }
            return Err("Remote side refused the forwarded connection".into());
        }
    };
    if socks {
        client
            .write_all(&[5, 0, 0, 1, 0, 0, 0, 0, 0, 0])
            .await
            .map_err(|_| "SOCKS5 client disconnected")?;
    }
    pump(channel, client).await;
    Ok(())
}

/// Moves bytes between a channel and `io` in both directions, honouring
/// half-close: local EOF sends channel EOF, channel EOF shuts down the local
/// write side, and the channel closes once both directions finished. Uses the
/// split `wait`/`data` halves, the same I/O path as the terminal, so EOF and
/// close are explicit rather than implied by stream shutdown.
async fn pump<S>(channel: russh::Channel<client::Msg>, io: S)
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Send,
{
    let (mut from_remote, to_remote) = channel.split();
    let (mut local_read, mut local_write) = tokio::io::split(io);
    let upstream = async {
        let mut buffer = [0; 32 * 1024];
        while let Ok(n) = local_read.read(&mut buffer).await {
            if n == 0 || to_remote.data(&buffer[..n]).await.is_err() {
                break;
            }
        }
        let _ = to_remote.eof().await;
    };
    let downstream = async {
        while let Some(message) = from_remote.wait().await {
            match message {
                russh::ChannelMsg::Data { data } => {
                    if local_write.write_all(&data).await.is_err() {
                        break;
                    }
                }
                russh::ChannelMsg::Eof | russh::ChannelMsg::Close => break,
                _ => {}
            }
        }
        let _ = local_write.shutdown().await;
    };
    tokio::join!(upstream, downstream);
    let _ = to_remote.close().await;
}

/// An in-memory stream backed by `channel`, for running SSH over a jump hop.
fn pipe(channel: russh::Channel<client::Msg>) -> tokio::io::DuplexStream {
    let (ours, theirs) = tokio::io::duplex(64 * 1024);
    tokio::spawn(pump(channel, theirs));
    ours
}

/// Minimal SOCKS5 (RFC 1928): no authentication, CONNECT only.
async fn socks5_request(client: &mut TcpStream) -> Result<(String, u16), String> {
    let invalid = || "Invalid SOCKS5 request".to_string();
    let mut header = [0; 2];
    client
        .read_exact(&mut header)
        .await
        .map_err(|_| invalid())?;
    let mut methods = vec![0; header[1] as usize];
    client
        .read_exact(&mut methods)
        .await
        .map_err(|_| invalid())?;
    if header[0] != 5 || !methods.contains(&0) {
        let _ = client.write_all(&[5, 0xff]).await;
        return Err("SOCKS5 client offered no supported method".into());
    }
    client.write_all(&[5, 0]).await.map_err(|_| invalid())?;
    let mut request = [0; 4];
    client
        .read_exact(&mut request)
        .await
        .map_err(|_| invalid())?;
    if request[0] != 5 {
        return Err(invalid());
    }
    // Read the whole request before any reply, so an error reply is not lost
    // to a reset caused by closing with unread bytes.
    let host = match request[3] {
        1 => {
            let mut octets = [0; 4];
            client
                .read_exact(&mut octets)
                .await
                .map_err(|_| invalid())?;
            IpAddr::V4(Ipv4Addr::from(octets)).to_string()
        }
        4 => {
            let mut octets = [0; 16];
            client
                .read_exact(&mut octets)
                .await
                .map_err(|_| invalid())?;
            IpAddr::V6(Ipv6Addr::from(octets)).to_string()
        }
        3 => {
            let mut length = [0; 1];
            client
                .read_exact(&mut length)
                .await
                .map_err(|_| invalid())?;
            let mut name = vec![0; length[0] as usize];
            client.read_exact(&mut name).await.map_err(|_| invalid())?;
            String::from_utf8(name).map_err(|_| invalid())?
        }
        _ => return Err(invalid()),
    };
    let mut port = [0; 2];
    client.read_exact(&mut port).await.map_err(|_| invalid())?;
    if request[1] != 1 {
        // 0x07: command not supported (only CONNECT).
        let _ = client.write_all(&[5, 7, 0, 1, 0, 0, 0, 0, 0, 0]).await;
        let _ = client.shutdown().await;
        return Err("Only SOCKS5 CONNECT is supported".into());
    }
    Ok((host, u16::from_be_bytes(port)))
}

/// Reads the next hop's host key through `jump`, for the user to confirm.
pub(crate) async fn observe_through(
    jump: &client::Handle<KeyCheck>,
    host: &str,
    port: u16,
) -> Result<PublicKey, String> {
    let channel = jump
        .channel_open_direct_tcpip(host, port.into(), "127.0.0.1", 0)
        .await
        .map_err(|_| "Jump host refused the connection to the next hop")?;
    observe_host_key(pipe(channel)).await
}

/// `ssh -J`: a new session to `request` through `jump`, pinned to `key` (the
/// next hop's confirmed host key) and authenticated with `credential`.
pub(crate) async fn through(
    jump: &client::Handle<KeyCheck>,
    request: &Request,
    key: Vec<u8>,
    credential: &Credential,
    cancel: watch::Receiver<bool>,
) -> Result<client::Handle<KeyCheck>, String> {
    let channel = jump
        .channel_open_direct_tcpip(request.host.clone(), request.port.into(), "127.0.0.1", 0)
        .await
        .map_err(|_| "Jump host refused the connection to the next hop")?;
    connect_pinned(pipe(channel), request, key, credential, cancel).await
}

#[cfg(test)]
#[path = "../tests/support/ssh_terminal_fixture.rs"]
#[allow(dead_code)]
mod fixture;

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::Ordering;

    fn request(server: &fixture::Fixture) -> Request {
        Request {
            host: "127.0.0.1".into(),
            port: server.port,
            username: "fixture".into(),
            private_key_path: server.key_path.to_string_lossy().into(),
        }
    }

    fn pin(server: &fixture::Fixture) -> Vec<u8> {
        server.host.lock().unwrap().public_key().to_bytes().unwrap()
    }

    async fn session(server: &fixture::Fixture) -> Arc<client::Handle<KeyCheck>> {
        let stream = TcpStream::connect(("127.0.0.1", server.port))
            .await
            .unwrap();
        let (_, cancel) = watch::channel(false);
        Arc::new(
            connect_pinned(
                stream,
                &request(server),
                pin(server),
                &Credential::default(),
                cancel,
            )
            .await
            .unwrap(),
        )
    }

    /// Echo server for forwarded bytes; returns its port.
    async fn echo() -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            while let Ok((mut stream, _)) = listener.accept().await {
                tokio::spawn(async move {
                    let (mut read, mut write) = stream.split();
                    let _ = tokio::io::copy(&mut read, &mut write).await;
                });
            }
        });
        port
    }

    async fn round_trip(mut stream: TcpStream, seed: u8) -> bool {
        let payload: Vec<u8> = (0..256 * 1024)
            .map(|i| (i as u8).wrapping_mul(31).wrapping_add(seed))
            .collect();
        let (mut read, mut write) = stream.split();
        let sent = payload.clone();
        let writer = async move {
            write.write_all(&sent).await.unwrap();
            write.shutdown().await.unwrap();
        };
        let mut received = Vec::new();
        let reader = read.read_to_end(&mut received);
        let (_, read) = tokio::join!(writer, reader);
        read.is_ok() && received == payload
    }

    #[tokio::test]
    async fn local_forward_relays_concurrent_connections_and_stops_cleanly() {
        let mut server = fixture::Fixture::start().await;
        let target = echo().await;
        let ssh = session(&server).await;
        let forward = listen(
            ssh.clone(),
            "127.0.0.1:0".parse().unwrap(),
            Target::Fixed {
                host: "127.0.0.1".into(),
                port: target,
            },
        )
        .await
        .unwrap();
        let local = forward.local;
        let results = futures_join(local, 4).await;
        assert_eq!(results, vec![true; 4]);
        assert_eq!(server.forwards.load(Ordering::SeqCst), 4);

        // The same port cannot be bound twice; the error names the reason.
        let conflict = listen(ssh.clone(), local, Target::Socks5)
            .await
            .err()
            .unwrap();
        assert!(
            conflict.contains("AddrInUse") || conflict.contains("in use"),
            "{conflict}"
        );
        assert!(
            listen(ssh.clone(), "0.0.0.0:0".parse().unwrap(), Target::Socks5)
                .await
                .is_err()
        );

        // A refused destination closes only that client; the listener keeps serving.
        let refused = listen(
            ssh.clone(),
            "127.0.0.1:0".parse().unwrap(),
            Target::Fixed {
                host: "10.255.255.1".into(),
                port: 9,
            },
        )
        .await
        .unwrap();
        let mut client = TcpStream::connect(refused.local).await.unwrap();
        let mut byte = [0; 1];
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(5), client.read(&mut byte))
                .await
                .unwrap()
                .unwrap_or(0),
            0
        );
        refused.stop().await;

        forward.stop().await;
        assert!(
            TcpStream::connect(local).await.is_err(),
            "listener still open after stop"
        );
        server.stop().await;
    }

    async fn futures_join(local: SocketAddr, count: u8) -> Vec<bool> {
        let tasks: Vec<_> = (0..count)
            .map(|seed| {
                tokio::spawn(async move {
                    round_trip(TcpStream::connect(local).await.unwrap(), seed).await
                })
            })
            .collect();
        let mut results = Vec::new();
        for task in tasks {
            results.push(task.await.unwrap());
        }
        results
    }

    #[tokio::test]
    async fn socks5_dynamic_forward_connects_by_ip_and_name() {
        let mut server = fixture::Fixture::start().await;
        let target = echo().await;
        let ssh = session(&server).await;
        let forward = listen(ssh, "127.0.0.1:0".parse().unwrap(), Target::Socks5)
            .await
            .unwrap();
        for request in [
            [&[5u8, 1, 0, 1][..], &[127, 0, 0, 1], &target.to_be_bytes()].concat(),
            [&[5u8, 1, 0, 3, 9][..], b"127.0.0.1", &target.to_be_bytes()].concat(),
        ] {
            let mut client = TcpStream::connect(forward.local).await.unwrap();
            client.write_all(&[5, 1, 0]).await.unwrap();
            let mut method = [0; 2];
            client.read_exact(&mut method).await.unwrap();
            assert_eq!(method, [5, 0]);
            client.write_all(&request).await.unwrap();
            let mut reply = [0; 10];
            client.read_exact(&mut reply).await.unwrap();
            assert_eq!(&reply[..2], &[5, 0]);
            assert!(round_trip(client, 7).await);
        }
        // BIND is refused with "command not supported".
        let mut client = TcpStream::connect(forward.local).await.unwrap();
        client
            .write_all(&[5, 1, 0, 5, 2, 0, 1, 127, 0, 0, 1, 0, 80])
            .await
            .unwrap();
        let mut reply = [0; 12];
        client.read_exact(&mut reply).await.unwrap();
        assert_eq!(&reply[2..4], &[5, 7]);
        forward.stop().await;
        server.stop().await;
    }

    #[tokio::test]
    async fn jump_host_pins_each_hop_independently() {
        let mut jump_server = fixture::Fixture::start().await;
        let mut target_server = fixture::Fixture::start().await;
        let jump = session(&jump_server).await;
        let (_, cancel) = watch::channel(false);

        // The next hop's key is read through the jump host, for confirmation.
        let observed = observe_through(&jump, "127.0.0.1", target_server.port)
            .await
            .unwrap();
        assert_eq!(observed.to_bytes().unwrap(), pin(&target_server));

        let target = request(&target_server);
        let hop = through(
            &jump,
            &target,
            pin(&target_server),
            &Credential::default(),
            cancel.clone(),
        )
        .await
        .unwrap();
        let mut channel = hop.channel_open_session().await.unwrap();
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
        assert_eq!(status, Some(7));

        // A wrong pin for the second hop fails before it authenticates.
        let before = target_server.authentications.load(Ordering::SeqCst);
        let wrong = through(
            &jump,
            &target,
            pin(&jump_server),
            &Credential::default(),
            cancel,
        )
        .await
        .err()
        .unwrap();
        assert!(wrong.contains("host key changed"), "{wrong}");
        assert_eq!(target_server.authentications.load(Ordering::SeqCst), before);
        jump_server.stop().await;
        target_server.stop().await;
    }
}
