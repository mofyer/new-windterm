//! Port forwards of an open SSH terminal, exercised through the same `Ssh`
//! methods the `ssh_forward_*` commands call. The peer is the loopback russh
//! fixture (direct-tcpip and tcpip-forward on 127.0.0.1 only), not OpenSSH.
#[path = "support/ssh_terminal_fixture.rs"]
#[allow(dead_code)]
mod fixture;
use new_windterm_desktop::{
    pty::{EventSink, PtyEvent},
    ssh::{
        terminal::tunnels::{
            ForwardInfo, ForwardKind, ForwardRequest, ForwardStatus, MAX_FORWARDS,
        },
        Request, Ssh,
    },
};
use std::{
    net::SocketAddr,
    sync::{atomic::Ordering, Arc, Mutex},
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::mpsc,
    task::JoinHandle,
};

fn id() -> String {
    uuid::Uuid::new_v4().to_string()
}

type Addresses = Arc<Mutex<Vec<SocketAddr>>>;

/// An open terminal whose output is acknowledged in the background, as the
/// front end does; `ended` yields its exit or error event. At the moment that
/// event is emitted, the sink records which `watch`ed local listeners still
/// accept connections, so teardown must happen before the exit is reported.
struct Open {
    id: String,
    ended: JoinHandle<Option<PtyEvent>>,
    watched: Addresses,
    open_at_exit: Arc<Mutex<Option<Vec<SocketAddr>>>>,
}

impl Open {
    fn watch(&self, address: SocketAddr) {
        self.watched.lock().unwrap().push(address);
    }
}

/// The library allows a few concurrent private-key reads per process; the
/// tests in this binary run in parallel, so their opens take turns.
static OPENING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

async fn open(server: &fixture::Fixture, service: &Arc<Ssh>) -> Open {
    let scope = service.context("main").unwrap();
    let request = Request {
        host: "127.0.0.1".into(),
        port: server.port,
        username: "fixture".into(),
        private_key_path: server.key_path.to_string_lossy().into(),
    };
    let challenge = service.probe("main", &id(), request, &scope).await.unwrap();
    let (sender, mut events) = mpsc::channel(256);
    let watched = Addresses::default();
    let open_at_exit = Arc::new(Mutex::new(None));
    let (listeners, found) = (watched.clone(), open_at_exit.clone());
    let sink: EventSink = Arc::new(move |event| {
        if !matches!(event, PtyEvent::Data { .. }) {
            let accepting = listeners
                .lock()
                .unwrap()
                .iter()
                .copied()
                .filter(|address| {
                    std::net::TcpStream::connect_timeout(address, Duration::from_millis(500))
                        .is_ok()
                })
                .collect();
            *found.lock().unwrap() = Some(accepting);
        }
        sender
            .try_send(event)
            .map_err(|_| "test event queue full".into())
    });
    let opening = OPENING.lock().await;
    let terminal = service
        .open(
            "main",
            &id(),
            &challenge.challenge_token,
            &scope,
            80,
            24,
            sink,
        )
        .await
        .unwrap();
    drop(opening);
    let (acks, session) = (service.clone(), terminal.clone());
    let ended = tokio::spawn(async move {
        while let Some(event) = events.recv().await {
            match event {
                PtyEvent::Data { sequence, .. } => {
                    let _ = acks.ack("main", &session, sequence);
                }
                other => return Some(other),
            }
        }
        None
    });
    Open {
        id: terminal,
        ended,
        watched,
        open_at_exit,
    }
}

async fn ended(open: Open) -> PtyEvent {
    let event = tokio::time::timeout(Duration::from_secs(10), open.ended)
        .await
        .expect("terminal did not end")
        .unwrap()
        .expect("event stream closed without an exit");
    let still_open = open.open_at_exit.lock().unwrap().take().unwrap();
    assert!(
        still_open.is_empty(),
        "listeners still open when the exit was reported: {still_open:?}"
    );
    event
}

fn local(target: u16) -> ForwardRequest {
    ForwardRequest {
        kind: ForwardKind::Local,
        bind_host: "127.0.0.1".into(),
        bind_port: 0,
        target_host: Some("127.0.0.1".into()),
        target_port: Some(target),
    }
}

fn dynamic() -> ForwardRequest {
    ForwardRequest {
        kind: ForwardKind::Dynamic,
        bind_host: "127.0.0.1".into(),
        bind_port: 0,
        target_host: None,
        target_port: None,
    }
}

fn remote(bind_port: u16, target: u16) -> ForwardRequest {
    ForwardRequest {
        kind: ForwardKind::Remote,
        bind_port,
        ..local(target)
    }
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

fn address(info: &ForwardInfo) -> SocketAddr {
    SocketAddr::new(info.bind_host.parse().unwrap(), info.bind_port)
}

/// Sends 128 KiB and expects the same bytes back before EOF.
async fn round_trip(mut stream: TcpStream, seed: u8) -> bool {
    let payload: Vec<u8> = (0..128 * 1024)
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
    let (_, read) = tokio::time::timeout(Duration::from_secs(10), async {
        tokio::join!(writer, reader)
    })
    .await
    .expect("round trip timed out");
    read.is_ok() && received == payload
}

/// SOCKS5 CONNECT to 127.0.0.1:`port`, then a round trip.
async fn socks_round_trip(proxy: SocketAddr, port: u16) -> bool {
    let mut client = TcpStream::connect(proxy).await.unwrap();
    client.write_all(&[5, 1, 0]).await.unwrap();
    let mut method = [0; 2];
    client.read_exact(&mut method).await.unwrap();
    let request = [&[5u8, 1, 0, 1, 127, 0, 0, 1][..], &port.to_be_bytes()].concat();
    client.write_all(&request).await.unwrap();
    let mut reply = [0; 10];
    client.read_exact(&mut reply).await.unwrap();
    method == [5, 0] && reply[..2] == [5, 0] && round_trip(client, 3).await
}

/// A local listener is closed by the time removal returns or the terminal's
/// exit is reported: no waiting, so a listener that only stops later fails.
async fn closed_now(address: SocketAddr) {
    assert!(
        TcpStream::connect(address).await.is_err(),
        "{address} still accepts connections"
    );
}

/// Waits until nothing accepts connections on `address` any more (the
/// server side of a remote forward closes asynchronously).
async fn refused(address: SocketAddr) {
    tokio::time::timeout(Duration::from_secs(3), async {
        while TcpStream::connect(address).await.is_ok() {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("{address} still accepts connections"));
}

async fn wait_for(done: impl FnMut() -> bool) {
    wait_within(Duration::from_secs(3), done).await;
}

async fn wait_within(limit: Duration, mut done: impl FnMut() -> bool) {
    tokio::time::timeout(limit, async {
        while !done() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("condition not reached");
}

#[tokio::test]
async fn local_and_dynamic_forwards_share_the_terminal_connection_and_end_with_it() {
    let mut server = fixture::Fixture::start().await;
    let target = echo().await;
    let service = Arc::new(Ssh::default());
    let terminal = open(&server, &service).await;
    let id = terminal.id.clone();

    let tunnel = service
        .forward_add("main", &id, local(target))
        .await
        .unwrap();
    assert_eq!(tunnel.kind, ForwardKind::Local);
    assert_eq!(tunnel.bind_host, "127.0.0.1");
    assert_ne!(tunnel.bind_port, 0, "the actual bound port is returned");
    assert_eq!(
        (tunnel.target_host.as_deref(), tunnel.target_port),
        (Some("127.0.0.1"), Some(target))
    );
    assert_eq!(
        (tunnel.status, tunnel.connections),
        (ForwardStatus::Active, Some(0))
    );
    let local_address = address(&tunnel);
    let (first, second) = tokio::join!(
        async { round_trip(TcpStream::connect(local_address).await.unwrap(), 1).await },
        async { round_trip(TcpStream::connect(local_address).await.unwrap(), 2).await },
    );
    assert!(first && second);
    assert_eq!(server.forwards.load(Ordering::SeqCst), 2);
    // The probe's connection is gone; the shell and the forwards share one.
    wait_for(|| server.active.load(Ordering::SeqCst) == 1).await;

    // Live connection count: an idle client is counted until it leaves.
    let held = TcpStream::connect(local_address).await.unwrap();
    let count = || service.forward_list("main", &id).unwrap()[0].connections;
    wait_for(|| count() == Some(1)).await;
    drop(held);
    wait_for(|| count() == Some(0)).await;

    let socks = service.forward_add("main", &id, dynamic()).await.unwrap();
    assert_eq!(socks.kind, ForwardKind::Dynamic);
    assert_eq!((&socks.target_host, socks.target_port), (&None, None));
    let socks_address = address(&socks);
    terminal.watch(socks_address);
    assert!(socks_round_trip(socks_address, target).await);
    let listed = service.forward_list("main", &id).unwrap();
    assert_eq!(
        listed.iter().map(|f| f.id.as_str()).collect::<Vec<_>>(),
        [tunnel.id.as_str(), socks.id.as_str()]
    );

    // Removing one forward closes only its listener.
    service
        .forward_remove("main", &id, &tunnel.id)
        .await
        .unwrap();
    closed_now(local_address).await;
    assert!(service
        .forward_remove("main", &id, &tunnel.id)
        .await
        .unwrap_err()
        .contains("not found"));
    assert!(service
        .forward_remove("main", &id, "not-an-id")
        .await
        .is_err());
    assert_eq!(service.forward_list("main", &id).unwrap().len(), 1);

    // The shell still works next to the forwards; its exit ends them.
    service.write("main", &id, b"exit\n".to_vec()).unwrap();
    assert!(matches!(
        ended(terminal).await,
        PtyEvent::Exit { code: Some(7), .. }
    ));
    closed_now(socks_address).await;
    assert!(service.forward_list("main", &id).is_err());
    assert!(service.forward_add("main", &id, dynamic()).await.is_err());
    wait_for(|| server.active.load(Ordering::SeqCst) == 0).await;
    server.stop().await;
}

#[tokio::test]
async fn remote_forward_uses_the_terminal_routes_and_is_cancelled_on_close() {
    let mut server = fixture::Fixture::start().await;
    let target = echo().await;
    let service = Arc::new(Ssh::default());
    let terminal = open(&server, &service).await;
    let id = terminal.id.clone();

    let tunnel = service
        .forward_add("main", &id, remote(0, target))
        .await
        .unwrap();
    assert_eq!(tunnel.kind, ForwardKind::Remote);
    assert_ne!(tunnel.bind_port, 0, "the server-chosen port is returned");
    assert_eq!(tunnel.connections, None);
    let server_side = address(&tunnel);
    assert!(round_trip(TcpStream::connect(server_side).await.unwrap(), 4).await);

    // The same fixed port again is refused before reaching the server, and
    // the existing route keeps working.
    let duplicate = service
        .forward_add("main", &id, remote(tunnel.bind_port, target))
        .await
        .unwrap_err();
    assert!(duplicate.contains("already forwarded"), "{duplicate}");
    assert!(round_trip(TcpStream::connect(server_side).await.unwrap(), 5).await);

    // The fixture only grants 127.0.0.1; a refusal leaves no entry behind.
    let mut wildcard = remote(0, target);
    wildcard.bind_host = "0.0.0.0".into();
    assert!(service
        .forward_add("main", &id, wildcard)
        .await
        .unwrap_err()
        .contains("refused"));
    assert_eq!(service.forward_list("main", &id).unwrap().len(), 1);

    service
        .forward_remove("main", &id, &tunnel.id)
        .await
        .unwrap();
    refused(server_side).await;
    assert!(service.forward_list("main", &id).unwrap().is_empty());

    // Closing the tab cancels the remaining remote forward and closes the
    // local listener before the exit is reported.
    let again = service
        .forward_add("main", &id, remote(0, target))
        .await
        .unwrap();
    let listener = service
        .forward_add("main", &id, local(target))
        .await
        .unwrap();
    terminal.watch(address(&listener));
    service.close("main", &id).unwrap();
    assert!(matches!(
        ended(terminal).await,
        PtyEvent::Exit { code: None, .. }
    ));
    refused(address(&again)).await;
    server.stop().await;
}

#[tokio::test]
async fn owner_validation_and_the_per_session_limit_hold_before_any_listener() {
    let mut server = fixture::Fixture::start().await;
    let target = echo().await;
    let service = Arc::new(Ssh::default());
    let terminal = open(&server, &service).await;
    let id = terminal.id.clone();

    let other = service.forward_add("other", &id, local(target)).await;
    assert!(other.unwrap_err().contains("not owned"));
    assert!(service.forward_list("other", &id).is_err());
    assert!(service.forward_remove("other", &id, &id).await.is_err());
    assert!(service
        .forward_add("main", &self::id(), local(target))
        .await
        .unwrap_err()
        .contains("closed"));

    let mut wildcard = local(target);
    wildcard.bind_host = "0.0.0.0".into();
    let mut named = dynamic();
    named.bind_host = "localhost".into();
    let mut socks_target = dynamic();
    socks_target.target_port = Some(80);
    let mut no_target = local(target);
    no_target.target_host = None;
    let mut zero = local(target);
    zero.target_port = Some(0);
    let mut markup = local(target);
    markup.target_host = Some("<img src=x>".into());
    let mut remote_bind = remote(0, target);
    remote_bind.bind_host = "a b".into();
    for (request, reason) in [
        (wildcard, "loopback"),
        (named, "loopback"),
        (socks_target, "no target"),
        (no_target, "target"),
        (zero, "target"),
        (markup, "target"),
        (remote_bind, "bind address"),
    ] {
        let error = service.forward_add("main", &id, request).await.unwrap_err();
        assert!(error.contains(reason), "{error}");
    }
    assert!(service.forward_list("main", &id).unwrap().is_empty());

    let mut addresses = Vec::new();
    for _ in 0..MAX_FORWARDS {
        let info = service.forward_add("main", &id, dynamic()).await.unwrap();
        terminal.watch(address(&info));
        addresses.push(address(&info));
    }
    let full = service
        .forward_add("main", &id, local(target))
        .await
        .unwrap_err();
    assert!(full.contains(&MAX_FORWARDS.to_string()), "{full}");
    assert_eq!(
        service.forward_list("main", &id).unwrap().len(),
        MAX_FORWARDS
    );

    // A reload (or closed window) of the owner ends every forward.
    service.close_owner("main");
    assert!(matches!(
        ended(terminal).await,
        PtyEvent::Exit { code: None, .. }
    ));
    for address in addresses {
        closed_now(address).await;
    }
    server.stop().await;
}

#[tokio::test]
async fn application_shutdown_closes_listeners_and_remote_forwards() {
    let mut server = fixture::Fixture::start().await;
    let target = echo().await;
    let service = Arc::new(Ssh::default());
    let terminal = open(&server, &service).await;
    let id = terminal.id.clone();
    let listener = service
        .forward_add("main", &id, local(target))
        .await
        .unwrap();
    terminal.watch(address(&listener));
    let granted = service
        .forward_add("main", &id, remote(0, target))
        .await
        .unwrap();
    service.shutdown();
    assert!(matches!(
        ended(terminal).await,
        PtyEvent::Exit { code: None, .. }
    ));
    closed_now(address(&listener)).await;
    refused(address(&granted)).await;
    wait_for(|| server.active.load(Ordering::SeqCst) == 0).await;
    server.stop().await;
}

/// A target that accepts connections and holds them without ever sending;
/// returns its port and the accepted connections.
async fn silent() -> (u16, Arc<Mutex<Vec<TcpStream>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let accepted = Arc::new(Mutex::new(Vec::new()));
    let held = accepted.clone();
    tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            held.lock().unwrap().push(stream);
        }
    });
    (port, accepted)
}

fn alive_tasks() -> usize {
    tokio::runtime::Handle::current()
        .metrics()
        .num_alive_tasks()
}

#[tokio::test]
async fn an_idle_remote_forward_connection_ends_with_the_terminal() {
    let mut server = fixture::Fixture::start().await;
    let (target, accepted) = silent().await;
    let service = Arc::new(Ssh::default());
    let baseline = alive_tasks();
    let terminal = open(&server, &service).await;
    let id = terminal.id.clone();
    let tunnel = service
        .forward_add("main", &id, remote(0, target))
        .await
        .unwrap();
    // Neither end ever sends: only the terminal's end can stop this relay.
    let client = TcpStream::connect(address(&tunnel)).await.unwrap();
    wait_for(|| accepted.lock().unwrap().len() == 1).await;

    service.close("main", &id).unwrap();
    ended(terminal).await;
    let mut relayed = accepted.lock().unwrap().pop().unwrap();
    let read = tokio::time::timeout(Duration::from_secs(3), relayed.read(&mut [0; 1]))
        .await
        .expect("the relay kept the local target connection open");
    assert!(matches!(read, Ok(0) | Err(_)), "{read:?}");
    drop(client);
    wait_for(|| server.active.load(Ordering::SeqCst) == 0).await;
    // No relay task (holding a socket and a channel permit) is left behind.
    wait_for(|| alive_tasks() == baseline).await;
    server.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn additions_racing_the_close_leave_nothing_listening() {
    let mut server = fixture::Fixture::start().await;
    let target = echo().await;
    let service = Arc::new(Ssh::default());
    let terminal = open(&server, &service).await;
    let id = terminal.id.clone();
    let additions: Vec<_> = (0..12)
        .map(|n| {
            let (service, id) = (service.clone(), id.clone());
            let request = match n % 3 {
                0 => local(target),
                1 => dynamic(),
                _ => remote(0, target),
            };
            tokio::spawn(async move { service.forward_add("main", &id, request).await })
        })
        .collect();
    tokio::task::yield_now().await;
    service.close("main", &id).unwrap();
    let mut added = Vec::new();
    for addition in additions {
        match addition.await.unwrap() {
            Ok(info) => added.push(info),
            Err(error) => assert!(error.contains("closed"), "{error}"),
        }
    }
    assert!(matches!(
        ended(terminal).await,
        PtyEvent::Exit { code: None, .. }
    ));
    for info in &added {
        match info.kind {
            ForwardKind::Remote => refused(address(info)).await,
            _ => closed_now(address(info)).await,
        }
    }
    wait_for(|| server.active.load(Ordering::SeqCst) == 0).await;
    server.stop().await;
}

/// A target that writes `limit` bytes (or without end) to each connection,
/// then closes it; returns its port.
async fn flood(limit: Option<usize>) -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        while let Ok((mut stream, _)) = listener.accept().await {
            tokio::spawn(async move {
                let block = vec![b'x'; 64 * 1024];
                let mut left = limit.unwrap_or(usize::MAX);
                while left > 0 {
                    let n = left.min(block.len());
                    if stream.write_all(&block[..n]).await.is_err() {
                        return;
                    }
                    left -= n;
                }
            });
        }
    });
    port
}

#[tokio::test]
async fn a_local_client_that_stops_reading_does_not_stall_the_shared_connection() {
    let mut server = fixture::Fixture::start().await;
    let (target, source) = (echo().await, flood(None).await);
    let service = Arc::new(Ssh::default());
    let terminal = open(&server, &service).await;
    let id = terminal.id.clone();
    let stalled = service
        .forward_add("main", &id, local(source))
        .await
        .unwrap();
    let working = service
        .forward_add("main", &id, local(target))
        .await
        .unwrap();

    // This client never reads, so its relay falls behind the flood. russh
    // keeps granting the server window, so without a bound the relay would
    // hold up every channel of the connection until the client reads.
    let held = TcpStream::connect(address(&stalled)).await.unwrap();
    tokio::time::sleep(Duration::from_millis(500)).await;

    // The relay is disconnected after its stall limit (5 s); other forwards
    // and the shell then work again over the same connection.
    let stream = TcpStream::connect(address(&working)).await.unwrap();
    assert!(
        tokio::time::timeout(Duration::from_secs(15), round_trip(stream, 6))
            .await
            .expect("the shared SSH connection stayed stalled"),
    );
    // With large kernel socket buffers (Linux, Windows) the other forward
    // answers before the stalled relay has even filled up, so its 5 s stall
    // limit may still be running here.
    let stalled_count = || service.forward_list("main", &id).unwrap()[0].connections;
    wait_within(Duration::from_secs(15), || stalled_count() == Some(0)).await;
    drop(held);

    service.write("main", &id, b"exit\n".to_vec()).unwrap();
    assert!(matches!(
        ended(terminal).await,
        PtyEvent::Exit { code: Some(7), .. }
    ));
    server.stop().await;
}

#[tokio::test]
async fn a_slow_local_client_that_keeps_reading_receives_everything() {
    const TOTAL: usize = 2 * 1024 * 1024;
    let mut server = fixture::Fixture::start().await;
    let source = flood(Some(TOTAL)).await;
    let service = Arc::new(Ssh::default());
    let terminal = open(&server, &service).await;
    let id = terminal.id.clone();
    let tunnel = service
        .forward_add("main", &id, local(source))
        .await
        .unwrap();
    // Reads in small steps with pauses, far behind the server, but never
    // stops for as long as the stall limit: nothing is dropped.
    let mut client = TcpStream::connect(address(&tunnel)).await.unwrap();
    let mut buffer = [0; 16 * 1024];
    let mut received = 0;
    tokio::time::timeout(Duration::from_secs(30), async {
        loop {
            let n = client.read(&mut buffer).await.unwrap();
            if n == 0 {
                break;
            }
            assert!(buffer[..n].iter().all(|byte| *byte == b'x'));
            received += n;
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("slow read timed out");
    assert_eq!(received, TOTAL);
    service.close("main", &id).unwrap();
    ended(terminal).await;
    server.stop().await;
}
