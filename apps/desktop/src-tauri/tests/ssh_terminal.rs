#[path = "support/ssh_terminal_fixture.rs"]
mod fixture;
use new_windterm_desktop::{
    pty::{EventSink, PtyEvent},
    ssh::{Challenge, Credential, Request, Ssh, Trust},
};
use std::{
    sync::{atomic::Ordering, Arc},
    time::{Duration, Instant},
};
use tokio::sync::mpsc;
use zeroize::Zeroizing;
static TEST_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
fn id() -> String {
    uuid::Uuid::new_v4().to_string()
}
fn request(server: &fixture::Fixture) -> Request {
    Request {
        host: "127.0.0.1".into(),
        port: server.port,
        username: "fixture".into(),
        private_key_path: server.key_path.to_string_lossy().into(),
    }
}
async fn open(server: &fixture::Fixture, service: &Arc<Ssh>) -> (String, mpsc::Receiver<PtyEvent>) {
    let scope = service.context("main").unwrap();
    let challenge = service
        .probe("main", &id(), request(server), &scope)
        .await
        .unwrap();
    assert_eq!(challenge.fingerprint, server.fingerprint());
    let (sender, receiver) = mpsc::channel(128);
    let sink: EventSink = Arc::new(move |event| {
        sender
            .try_send(event)
            .map_err(|_| "test event queue full".into())
    });
    let opened = service
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
    (opened, receiver)
}
// Search each possible start position once, retaining only the overlap that
// could form a marker across two SSH output blocks. The comparison count is
// test-harness evidence, not application or terminal-content instrumentation.
fn scan_new_marker(bytes: &[u8], previous_len: usize, marker: &[u8]) -> (Option<usize>, usize) {
    assert!(!marker.is_empty());
    let start = previous_len.saturating_sub(marker.len() - 1);
    let mut compared = 0;
    for (offset, window) in bytes[start..].windows(marker.len()).enumerate() {
        compared += 1;
        if window == marker {
            return (Some(start + offset), compared);
        }
    }
    (None, compared)
}

async fn until(
    service: &Ssh,
    session: &str,
    events: &mut mpsc::Receiver<PtyEvent>,
    marker: &[u8],
) -> Vec<u8> {
    let mut bytes = Vec::new();
    let started = Instant::now();
    let result = tokio::time::timeout(Duration::from_secs(10), async {
        while let Some(event) = events.recv().await {
            match event {
                PtyEvent::Data { sequence, data, .. } => {
                    let previous_len = bytes.len();
                    bytes.extend(data);
                    service.ack("main", session, sequence).unwrap();
                    if scan_new_marker(&bytes, previous_len, marker).0.is_some() {
                        return;
                    }
                }
                other => panic!("unexpected event {other:?}"),
            }
        }
        panic!("events closed before marker");
    })
    .await;
    assert!(
        result.is_ok(),
        "marker timeout: received_bytes={}, elapsed_ms={:.3}, deadline_ms=10000",
        bytes.len(),
        started.elapsed().as_secs_f64() * 1000.0,
    );
    bytes
}
async fn closed(events: &mut mpsc::Receiver<PtyEvent>, service: &Ssh, session: &str) -> PtyEvent {
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            match events.recv().await.unwrap() {
                PtyEvent::Data { sequence, .. } => {
                    let _ = service.ack("main", session, sequence);
                }
                event => return event,
            }
        }
    })
    .await
    .unwrap()
}
async fn drained(server: &fixture::Fixture) {
    tokio::time::timeout(Duration::from_secs(2), async {
        while server.active.load(Ordering::SeqCst) != 0 {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
}
#[tokio::test]
async fn unicode_resize_exit_and_owner_checks_use_real_ssh() {
    let _serial = TEST_LOCK.lock().await;
    let mut server = fixture::Fixture::start().await;
    let service = Arc::new(Ssh::default());
    let (session, mut events) = open(&server, &service).await;
    until(&service, &session, &mut events, b"> ").await;
    assert!(service
        .write("other", &session, b"exit\n".to_vec())
        .is_err());
    assert!(service.resize("other", &session, 90, 30).is_err());
    assert!(service.ack("other", &session, 1).is_err());
    assert!(service.close("other", &session).is_err());
    assert!(service.write("main", &session, vec![0; 4097]).is_err());
    service
        .write("main", &session, b"unicode\n".to_vec())
        .unwrap();
    let bytes = until(&service, &session, &mut events, b"> ").await;
    assert!(String::from_utf8(bytes).unwrap().contains("中文 🌏"));
    service.resize("main", &session, 129, 37).unwrap();
    service.write("main", &session, b"size\n".to_vec()).unwrap();
    until(&service, &session, &mut events, b"SIZE 129 37").await;
    service.write("main", &session, b"exit\n".to_vec()).unwrap();
    assert!(matches!(
        closed(&mut events, &service, &session).await,
        PtyEvent::Exit { code: Some(7), .. }
    ));
    drained(&server).await;
    service.close("main", &session).unwrap();
    service.ack("main", &session, 1).unwrap();
    server.stop().await;
    assert!(!server.key_path.exists());
}
#[tokio::test]
async fn bounded_two_mib_output_recovers_after_ack_pause_and_interrupts() {
    let _serial = TEST_LOCK.lock().await;
    let mut server = fixture::Fixture::start().await;
    let service = Arc::new(Ssh::default());
    let (session, mut events) = open(&server, &service).await;
    until(&service, &session, &mut events, b"> ").await;
    service
        .write("main", &session, b"large\n".to_vec())
        .unwrap();
    tokio::time::sleep(Duration::from_millis(300)).await;
    let bytes = until(&service, &session, &mut events, b"LARGE_DONE").await;
    assert_eq!(
        bytes.iter().filter(|b| **b == b'X').count(),
        2 * 1024 * 1024
    );
    service
        .write("main", &session, b"large\n".to_vec())
        .unwrap();
    tokio::time::sleep(Duration::from_millis(300)).await;
    service.write("main", &session, vec![3]).unwrap();
    let bytes = until(&service, &session, &mut events, b"INTERRUPTED").await;
    assert!(bytes.iter().filter(|b| **b == b'X').count() < 2 * 1024 * 1024);
    service.close("main", &session).unwrap();
    closed(&mut events, &service, &session).await;
    drained(&server).await;
    server.stop().await;
}
#[tokio::test]
async fn burst_with_prompt_ack_is_not_false_overload() {
    let _serial = TEST_LOCK.lock().await;
    let mut server = fixture::Fixture::start().await;
    let service = Arc::new(Ssh::default());
    let (session, mut events) = open(&server, &service).await;
    until(&service, &session, &mut events, b"> ").await;
    service
        .write("main", &session, b"burst\n".to_vec())
        .unwrap();
    let bytes = until(&service, &session, &mut events, b"LARGE_DONE").await;
    assert_eq!(
        bytes.iter().filter(|b| **b == b'X').count(),
        2 * 1024 * 1024
    );
    service.close("main", &session).unwrap();
    closed(&mut events, &service, &session).await;
    drained(&server).await;
    server.stop().await;
}
#[tokio::test]
async fn slow_consumer_fails_closed_and_reload_closes_socket() {
    let _serial = TEST_LOCK.lock().await;
    let mut server = fixture::Fixture::start().await;
    let service = Arc::new(Ssh::default());
    let (session, mut events) = open(&server, &service).await;
    until(&service, &session, &mut events, b"> ").await;
    service
        .write("main", &session, b"burst\n".to_vec())
        .unwrap();
    tokio::time::sleep(Duration::from_millis(500)).await;
    let mut sent = 0;
    loop {
        match tokio::time::timeout(Duration::from_secs(3), events.recv())
            .await
            .unwrap()
            .unwrap()
        {
            PtyEvent::Data { data, .. } => sent += data.len(),
            PtyEvent::Error { message, .. } => {
                assert!(
                    message.contains("bounded receive queue exhausted"),
                    "{message}"
                );
                break;
            }
            event => panic!("{event:?}"),
        }
    }
    assert!(sent <= 64 * 1024);
    drained(&server).await;
    let (session, mut events) = open(&server, &service).await;
    service.close_owner("main");
    assert!(matches!(
        closed(&mut events, &service, &session).await,
        PtyEvent::Exit { code: None, .. }
    ));
    drained(&server).await;
    server.stop().await;
}
#[tokio::test]
async fn changed_host_and_cancel_before_open_do_not_authenticate() {
    let _serial = TEST_LOCK.lock().await;
    let mut server = fixture::Fixture::start().await;
    let service = Arc::new(Ssh::default());
    let scope = service.context("main").unwrap();
    let challenge = service
        .probe("main", &id(), request(&server), &scope)
        .await
        .unwrap();
    assert_eq!(server.authentications.load(Ordering::SeqCst), 0);
    *server.host.lock().unwrap() = fixture::key();
    let sink: EventSink = Arc::new(|_| Ok(()));
    assert!(service
        .open(
            "main",
            &id(),
            &challenge.challenge_token,
            &scope,
            80,
            24,
            sink.clone()
        )
        .await
        .err()
        .unwrap()
        .contains("host key changed"));
    assert_eq!(server.authentications.load(Ordering::SeqCst), 0);
    let challenge = service
        .probe("main", &id(), request(&server), &scope)
        .await
        .unwrap();
    let operation = id();
    service.cancel("main", &operation).unwrap();
    assert!(service
        .open(
            "main",
            &operation,
            &challenge.challenge_token,
            &scope,
            80,
            24,
            sink.clone()
        )
        .await
        .is_err());
    service.close_owner("main");
    assert!(service
        .open(
            "main",
            &id(),
            &challenge.challenge_token,
            &scope,
            80,
            24,
            sink
        )
        .await
        .is_err());
    assert_eq!(server.authentications.load(Ordering::SeqCst), 0);
    drained(&server).await;
    server.stop().await;
}
#[tokio::test]
async fn withheld_ack_expires_without_additional_network_output() {
    let _serial = TEST_LOCK.lock().await;
    let mut server = fixture::Fixture::start().await;
    let service = Arc::new(Ssh::default());
    let (idle, mut idle_events) = open(&server, &service).await;
    until(&service, &idle, &mut idle_events, b"> ").await;
    let (session, mut events) = open(&server, &service).await;
    let event = events.recv().await.unwrap();
    assert!(matches!(event, PtyEvent::Data { .. }));
    let terminal = tokio::time::timeout(Duration::from_secs(17), events.recv())
        .await
        .unwrap()
        .unwrap();
    assert!(
        matches!(terminal,PtyEvent::Error { message,.. } if message.contains("acknowledgement timed out"))
    );
    assert!(idle_events.try_recv().is_err());
    service.close("main", &idle).unwrap();
    closed(&mut idle_events, &service, &idle).await;
    drained(&server).await;
    service.close("main", &session).unwrap();
    server.stop().await;
}

#[tokio::test]
async fn rejected_pty_and_shell_close_the_transport() {
    let _serial = TEST_LOCK.lock().await;
    let mut server = fixture::Fixture::start().await;
    let service = Arc::new(Ssh::default());
    let scope = service.context("main").unwrap();
    for mode in [1, 2] {
        server.denial.store(mode, Ordering::SeqCst);
        let challenge = service
            .probe("main", &id(), request(&server), &scope)
            .await
            .unwrap();
        let result = service
            .open(
                "main",
                &id(),
                &challenge.challenge_token,
                &scope,
                80,
                24,
                Arc::new(|_| Ok(())),
            )
            .await;
        assert!(result.unwrap_err().contains("request rejected"));
        drained(&server).await;
    }
    server.stop().await;
}

#[tokio::test]
async fn cancelling_inflight_shell_open_releases_socket_and_capacity() {
    let _serial = TEST_LOCK.lock().await;
    let mut server = fixture::Fixture::start().await;
    server.denial.store(3, Ordering::SeqCst);
    let service = Arc::new(Ssh::default());
    let scope = service.context("main").unwrap();
    let challenge = service
        .probe("main", &id(), request(&server), &scope)
        .await
        .unwrap();
    let operation = id();
    let pending_id = operation.clone();
    let pending_service = service.clone();
    let open = tokio::spawn(async move {
        pending_service
            .open(
                "main",
                &pending_id,
                &challenge.challenge_token,
                &scope,
                80,
                24,
                Arc::new(|_| Ok(())),
            )
            .await
    });
    tokio::time::timeout(Duration::from_secs(3), async {
        while server.authentications.load(Ordering::SeqCst) == 0 {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    service.cancel("main", &operation).unwrap();
    assert!(tokio::time::timeout(Duration::from_secs(2), open)
        .await
        .unwrap()
        .unwrap()
        .unwrap_err()
        .contains("cancelled"));
    drained(&server).await;
    server.denial.store(0, Ordering::SeqCst);
    let (session, mut events) = self::open(&server, &service).await;
    service.shutdown();
    closed(&mut events, &service, &session).await;
    drained(&server).await;
    assert!(service.context("main").is_err());
    server.stop().await;
}

#[tokio::test]
async fn server_initiated_rekey_fails_closed_with_reconnect_reason() {
    let _serial = TEST_LOCK.lock().await;
    let mut server = fixture::Fixture::start().await;
    server.rekey_limit.store(64 * 1024, Ordering::SeqCst);
    let service = Arc::new(Ssh::default());
    let (session, mut events) = open(&server, &service).await;
    until(&service, &session, &mut events, b"> ").await;
    service
        .write("main", &session, b"large\n".to_vec())
        .unwrap();
    assert!(
        matches!(closed(&mut events, &service, &session).await, PtyEvent::Error { message, .. } if message == "SSH rekey is not supported in P0; reconnect to verify the host key again")
    );
    drained(&server).await;
    server.stop().await;
}

#[test]
fn incremental_marker_scan_preserves_boundaries_and_linear_work() {
    let marker = b"LARGE_DONE";
    // Exercise every split within the marker, an entirely new marker, and a
    // marker that starts exactly at a block boundary.
    for split in 0..=marker.len() {
        let mut bytes = b"prefix".to_vec();
        bytes.extend(&marker[..split]);
        let (first, first_work) = scan_new_marker(&bytes, 0, marker);
        assert_eq!(first, (split == marker.len()).then_some(6));
        let previous = bytes.len();
        bytes.extend(&marker[split..]);
        let (second, second_work) = scan_new_marker(&bytes, previous, marker);
        assert_eq!(second, (split != marker.len()).then_some(6));
        assert_eq!(first_work + second_work, 7);
        // Appending an unrelated block must not rediscover the old marker.
        let previous = bytes.len();
        bytes.extend(b"tail");
        assert_eq!(scan_new_marker(&bytes, previous, marker).0, None);
    }
    let mut bytes = Vec::new();
    let mut compared = 0;
    for _ in 0..512 {
        let previous = bytes.len();
        bytes.extend([b'X'; 4096]);
        let (found, work) = scan_new_marker(&bytes, previous, marker);
        assert_eq!(found, None);
        compared += work;
    }
    let previous = bytes.len();
    bytes.extend(b"\r\nLARGE_DONE\r\n> ");
    let (found, work) = scan_new_marker(&bytes, previous, marker);
    compared += work;
    assert_eq!(found, Some(2 * 1024 * 1024 + 2));
    assert_eq!(compared, 2 * 1024 * 1024 + 3);
}

async fn probe(server: &fixture::Fixture, service: &Ssh, scope: &str) -> Challenge {
    service
        .probe("main", &id(), request(server), scope)
        .await
        .unwrap()
}

async fn open_and_exit(server: &fixture::Fixture, service: &Arc<Ssh>, scope: &str, token: &str) {
    let (sender, mut events) = mpsc::channel(128);
    let sink: EventSink = Arc::new(move |event| {
        sender
            .try_send(event)
            .map_err(|_| "test event queue full".into())
    });
    let session = service
        .open("main", &id(), token, scope, 80, 24, sink)
        .await
        .unwrap();
    until(service, &session, &mut events, b"> ").await;
    service.write("main", &session, b"exit\n".to_vec()).unwrap();
    assert!(matches!(
        closed(&mut events, service, &session).await,
        PtyEvent::Exit { code: Some(7), .. }
    ));
    drained(server).await;
}

#[tokio::test]
async fn saved_trust_is_reused_and_a_changed_key_needs_explicit_replacement() {
    let _serial = TEST_LOCK.lock().await;
    let mut server = fixture::Fixture::start().await;
    let directory = std::env::temp_dir().join(format!("p0-trust-{}", id()));
    let store = directory.join("known_hosts");
    let service = Arc::new(Ssh::with_known_hosts(store.clone()));
    let scope = service.context("main").unwrap();

    let first = probe(&server, &service, &scope).await;
    assert_eq!(
        (first.trust, first.saved_fingerprint.as_deref()),
        (Trust::New, None)
    );
    assert!(service
        .trust_replace("main", &first.challenge_token)
        .is_err());
    assert!(service.trust_save("other", &first.challenge_token).is_err());
    assert!(
        !store.exists(),
        "nothing is saved before explicit confirmation"
    );
    service.trust_save("main", &first.challenge_token).unwrap();
    let original = server.fingerprint();

    let known = probe(&server, &service, &scope).await;
    assert_eq!(
        (known.trust, known.fingerprint.as_str()),
        (Trust::Known, original.as_str())
    );
    open_and_exit(&server, &service, &scope, &known.challenge_token).await;

    // The server now presents a different key: blocked before authentication.
    *server.host.lock().unwrap() = fixture::key();
    let changed = probe(&server, &service, &scope).await;
    assert_eq!(changed.trust, Trust::Changed);
    assert_eq!(
        changed.saved_fingerprint.as_deref(),
        Some(original.as_str())
    );
    assert_ne!(changed.fingerprint, original);
    let before = server.authentications.load(Ordering::SeqCst);
    let sink: EventSink = Arc::new(|_| Ok(()));
    let refused = service
        .open(
            "main",
            &id(),
            &changed.challenge_token,
            &scope,
            80,
            24,
            sink,
        )
        .await
        .err()
        .unwrap();
    assert!(refused.contains("differs from the saved key"), "{refused}");
    assert!(service
        .trust_save("main", &changed.challenge_token)
        .is_err());
    assert_eq!(server.authentications.load(Ordering::SeqCst), before);

    // Only the separate replace action updates trust; the same challenge then proceeds.
    service
        .trust_replace("main", &changed.challenge_token)
        .unwrap();
    open_and_exit(&server, &service, &scope, &changed.challenge_token).await;
    assert_eq!(probe(&server, &service, &scope).await.trust, Trust::Known);
    let text = std::fs::read_to_string(&store).unwrap();
    assert_eq!(
        text.lines().count(),
        1,
        "replacement must not accumulate keys"
    );

    server.stop().await;
    std::fs::remove_dir_all(directory).unwrap();
}

/// Opens a terminal with `credential` and either exits it (Ok) or returns the
/// open error. A fresh challenge is probed for every attempt.
async fn attempt(
    server: &fixture::Fixture,
    service: &Arc<Ssh>,
    key_path: &std::path::Path,
    credential: Credential,
) -> Result<(), String> {
    let scope = service.context("main").unwrap();
    let mut input = request(server);
    input.private_key_path = key_path.to_string_lossy().into();
    let challenge = service.probe("main", &id(), input, &scope).await.unwrap();
    let (sender, mut events) = mpsc::channel(128);
    let sink: EventSink = Arc::new(move |event| {
        sender
            .try_send(event)
            .map_err(|_| "test event queue full".into())
    });
    let session = service
        .open_with(
            "main",
            &id(),
            &challenge.challenge_token,
            &scope,
            credential,
            80,
            24,
            sink,
        )
        .await?;
    until(service, &session, &mut events, b"> ").await;
    service.write("main", &session, b"exit\n".to_vec()).unwrap();
    assert!(matches!(
        closed(&mut events, service, &session).await,
        PtyEvent::Exit { code: Some(7), .. }
    ));
    drained(server).await;
    Ok(())
}

fn secret(text: &str) -> Option<Zeroizing<String>> {
    Some(Zeroizing::new(text.into()))
}

#[tokio::test]
async fn password_and_passphrase_keys_authenticate_and_wrong_secrets_fail() {
    let _serial = TEST_LOCK.lock().await;
    let mut server = fixture::Fixture::start().await;
    let service = Arc::new(Ssh::default());
    let none = std::path::PathBuf::new();
    let password = |text: &str| Credential::Password {
        password: Zeroizing::new(text.into()),
    };

    attempt(&server, &service, &none, password(fixture::PASSWORD))
        .await
        .unwrap();
    let wrong = attempt(&server, &service, &none, password("not-it")).await;
    assert_eq!(wrong.unwrap_err(), "SSH password authentication rejected");

    let encrypted = server.encrypted_key_path.clone();
    let with = |passphrase| Credential::Key { passphrase };
    attempt(
        &server,
        &service,
        &encrypted,
        with(secret(fixture::PASSPHRASE)),
    )
    .await
    .unwrap();
    // Decryption failures happen locally, before any authentication request.
    let before = server.authentications.load(Ordering::SeqCst);
    let missing = attempt(&server, &service, &encrypted, with(None)).await;
    assert!(missing.unwrap_err().contains("needs a passphrase"));
    let bad = attempt(&server, &service, &encrypted, with(secret("not-it"))).await;
    assert!(bad.unwrap_err().contains("check the passphrase"));
    assert_eq!(server.authentications.load(Ordering::SeqCst), before);

    // Key authentication still requires a path.
    let no_path = attempt(&server, &service, &none, Credential::default()).await;
    assert!(no_path
        .unwrap_err()
        .contains("private key path is required"));
    server.stop().await;
}

/// Uses a private, temporary `ssh-agent`; never the user's agent.
#[cfg(unix)]
#[tokio::test]
async fn agent_authenticates_with_a_loaded_key() {
    let _serial = TEST_LOCK.lock().await;
    if !std::path::Path::new("/usr/bin/ssh-agent").exists() {
        eprintln!("skipped: /usr/bin/ssh-agent is not installed");
        return;
    }
    let mut server = fixture::Fixture::start().await;
    let socket = std::env::temp_dir().join(format!("p0-agent-{}.sock", &id()[..8]));
    let mut agent = std::process::Command::new("/usr/bin/ssh-agent")
        .args(["-D", "-a"])
        .arg(&socket)
        .stdout(std::process::Stdio::null())
        .spawn()
        .unwrap();
    for _ in 0..100 {
        if socket.exists() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let service = Arc::new(Ssh::default());
    let none = std::path::PathBuf::new();
    let previous = std::env::var_os("SSH_AUTH_SOCK");
    std::env::set_var("SSH_AUTH_SOCK", &socket);
    let empty = attempt(&server, &service, &none, Credential::Agent {}).await;
    let added = std::process::Command::new("/usr/bin/ssh-add")
        .arg(&server.key_path)
        .env("SSH_AUTH_SOCK", &socket)
        .output()
        .unwrap();
    let result = attempt(&server, &service, &none, Credential::Agent {}).await;
    match previous {
        Some(value) => std::env::set_var("SSH_AUTH_SOCK", value),
        None => std::env::remove_var("SSH_AUTH_SOCK"),
    }
    let _ = agent.kill();
    let _ = agent.wait();
    let _ = std::fs::remove_file(&socket);
    assert_eq!(empty.unwrap_err(), "SSH agent has no usable keys");
    assert!(
        added.status.success(),
        "{}",
        String::from_utf8_lossy(&added.stderr)
    );
    result.unwrap();
    server.stop().await;
}
