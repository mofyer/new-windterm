//! Connection routes against the loopback russh fixture: HTTP CONNECT and
//! SOCKS5 test proxies, a ProxyCommand and a jump host. Each test shows that
//! the probe and every later operation crossed the same route.
#[path = "support/ssh_terminal_fixture.rs"]
#[allow(dead_code)]
mod fixture;
#[path = "support/test_proxy.rs"]
#[allow(dead_code)]
mod test_proxy;
use new_windterm_desktop::{
    pty::{EventSink, PtyEvent},
    ssh::{Challenge, Credential, Request, RouteSpec, RouteSummary, Ssh, Stage, Trust},
};
use std::{
    sync::{atomic::Ordering, Arc},
    time::Duration,
};
use tokio::sync::mpsc;
use zeroize::Zeroizing;

// Tests share the process-wide private key reader capacity.
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

fn secret(text: &str) -> Option<Zeroizing<String>> {
    Some(Zeroizing::new(text.into()))
}

fn http(proxy: &test_proxy::Proxy, login: Option<(&str, &str)>) -> RouteSpec {
    RouteSpec::HttpConnect {
        host: "127.0.0.1".into(),
        port: proxy.address.port(),
        username: login.map(|(user, _)| user.into()),
        password: login.and_then(|(_, password)| secret(password)),
    }
}

fn socks5(proxy: &test_proxy::Proxy, login: Option<(&str, &str)>) -> RouteSpec {
    RouteSpec::Socks5 {
        host: "127.0.0.1".into(),
        port: proxy.address.port(),
        username: login.map(|(user, _)| user.into()),
        password: login.and_then(|(_, password)| secret(password)),
    }
}

fn jump(server: &fixture::Fixture) -> RouteSpec {
    RouteSpec::Jump {
        host: "127.0.0.1".into(),
        port: server.port,
        username: "fixture".into(),
        private_key_path: server.key_path.to_string_lossy().into(),
    }
}

async fn probe(service: &Ssh, server: &fixture::Fixture, route: RouteSpec) -> Challenge {
    let scope = service.context("main").unwrap();
    service
        .probe_via("main", &id(), request(server), route, &scope)
        .await
        .unwrap()
}

async fn check(service: &Ssh, token: &str) -> Result<u32, String> {
    let scope = service.context("main").unwrap();
    service
        .accept_with("main", &id(), token, &scope, Credential::default())
        .await
        .map(|output| output.exit_code)
}

/// Opens a terminal on a confirmed challenge, waits for the prompt and exits.
async fn shell(service: &Arc<Ssh>, token: &str) -> Option<u32> {
    let scope = service.context("main").unwrap();
    let (sender, mut events) = mpsc::channel(128);
    let sink: EventSink = Arc::new(move |event| {
        sender
            .try_send(event)
            .map_err(|_| "test event queue full".into())
    });
    let session = service
        .open("main", &id(), token, &scope, 80, 24, sink)
        .await
        .unwrap();
    let mut seen = Vec::new();
    let mut exited = None;
    let mut sent = false;
    let result = tokio::time::timeout(Duration::from_secs(10), async {
        while let Some(event) = events.recv().await {
            match event {
                PtyEvent::Data { sequence, data, .. } => {
                    seen.extend(data);
                    service.ack("main", &session, sequence).unwrap();
                    if !sent && seen.ends_with(b"> ") {
                        sent = true;
                        service.write("main", &session, b"exit\n".to_vec()).unwrap();
                    }
                }
                PtyEvent::Exit { code, .. } => {
                    exited = code;
                    break;
                }
                PtyEvent::Error { message, .. } => panic!("terminal error: {message}"),
            }
        }
    })
    .await;
    assert!(result.is_ok(), "terminal did not exit");
    exited
}

#[tokio::test]
async fn http_proxy_route_is_bound_from_probe_to_command_and_terminal() {
    let _serial = TEST_LOCK.lock().await;
    let mut server = fixture::Fixture::start().await;
    let proxy = test_proxy::start(test_proxy::Kind::Http, Some(("p0", "proxy-secret"))).await;
    let service = Arc::new(Ssh::default());

    let challenge = probe(
        &service,
        &server,
        http(&proxy, Some(("p0", "proxy-secret"))),
    )
    .await;
    assert_eq!(challenge.fingerprint, server.fingerprint());
    assert_eq!(challenge.stage, Stage::Target);
    assert_eq!(
        challenge.route,
        RouteSummary::HttpConnect {
            host: "127.0.0.1".into(),
            port: proxy.address.port(),
            authenticated: true,
        }
    );
    let summary = serde_json::to_string(&challenge.route).unwrap();
    assert!(!summary.contains("proxy-secret") && !summary.contains("p0"));
    assert_eq!(
        proxy.tunnels(),
        [server.port],
        "the probe crossed the proxy"
    );

    // The consumed challenge carries the route: no route argument exists here.
    assert_eq!(check(&service, &challenge.challenge_token).await, Ok(7));
    assert_eq!(proxy.tunnels().len(), 2);

    let terminal = probe(
        &service,
        &server,
        http(&proxy, Some(("p0", "proxy-secret"))),
    )
    .await;
    assert_eq!(shell(&service, &terminal.challenge_token).await, Some(7));
    assert_eq!(proxy.tunnels().len(), 4);

    // A wrong proxy password fails at the proxy, without echoing the secret
    // and before the SSH server sees a connection.
    let before = server.authentications.load(Ordering::SeqCst);
    let scope = service.context("main").unwrap();
    let wrong = service
        .probe_via(
            "main",
            &id(),
            request(&server),
            http(&proxy, Some(("p0", "wrong-proxy-pw"))),
            &scope,
        )
        .await
        .err()
        .unwrap();
    assert_eq!(wrong, "HTTP proxy refused the tunnel (status 407)");
    assert_eq!(proxy.tunnels().len(), 4);
    assert_eq!(server.authentications.load(Ordering::SeqCst), before);
    server.stop().await;
}

#[tokio::test]
async fn socks5_route_carries_the_sftp_connection_and_hides_the_password() {
    let _serial = TEST_LOCK.lock().await;
    let mut server = fixture::Fixture::start().await;
    let proxy = test_proxy::start(test_proxy::Kind::Socks5, Some(("p0", "socks-secret"))).await;
    let service = Arc::new(Ssh::default());

    let challenge = probe(
        &service,
        &server,
        socks5(&proxy, Some(("p0", "socks-secret"))),
    )
    .await;
    assert_eq!(challenge.fingerprint, server.fingerprint());
    assert_eq!(proxy.tunnels(), [server.port]);
    // The fixture has no SFTP server: the open fails after authenticating,
    // which it could only do through the challenge's proxy.
    let before = server.authentications.load(Ordering::SeqCst);
    let scope = service.context("main").unwrap();
    let error = service
        .sftp_open_with(
            "main",
            &id(),
            &challenge.challenge_token,
            &scope,
            Credential::default(),
        )
        .await
        .err()
        .unwrap();
    assert!(error.contains("SFTP"), "{error}");
    assert_eq!(proxy.tunnels(), [server.port, server.port]);
    assert!(server.authentications.load(Ordering::SeqCst) > before);

    let wrong = service
        .probe_via(
            "main",
            &id(),
            request(&server),
            socks5(&proxy, Some(("p0", "wrong-socks-pw"))),
            &scope,
        )
        .await
        .err()
        .unwrap();
    assert_eq!(wrong, "SOCKS5 proxy rejected the username or password");
    // Without a login the guarded proxy offers no acceptable method.
    let refused = service
        .probe_via(
            "main",
            &id(),
            request(&server),
            socks5(&proxy, None),
            &scope,
        )
        .await
        .err()
        .unwrap();
    assert!(refused.contains("authentication method"), "{refused}");
    assert_eq!(proxy.tunnels().len(), 2);
    server.stop().await;
}

#[cfg(unix)]
#[tokio::test]
async fn proxy_command_runs_only_the_argv_the_user_confirmed() {
    let _serial = TEST_LOCK.lock().await;
    if !std::path::Path::new("/usr/bin/nc").exists()
        || !std::path::Path::new("/usr/bin/touch").exists()
    {
        eprintln!("skipped: /usr/bin/nc or /usr/bin/touch is not installed");
        return;
    }
    let mut server = fixture::Fixture::start().await;
    let service = Arc::new(Ssh::default());
    let scope = service.context("main").unwrap();
    let target = request(&server);

    // An argv that differs from the command's preview is refused before
    // anything runs: the marker file is never created.
    let marker = std::env::temp_dir().join(format!("p0-proxy-command-{}", id()));
    let command = format!("/usr/bin/touch {} %h", marker.display());
    let shown = new_windterm_desktop::ssh::proxy_command_preview(&target, &command).unwrap();
    assert_eq!(
        shown,
        ["/usr/bin/touch", &marker.to_string_lossy(), "127.0.0.1"]
    );
    let mut edited = shown.clone();
    edited[2] = "elsewhere".into();
    let refused = service
        .probe_via(
            "main",
            &id(),
            target.clone(),
            RouteSpec::ProxyCommand {
                command: command.clone(),
                argv: edited,
            },
            &scope,
        )
        .await
        .err()
        .unwrap();
    assert!(refused.contains("review it again"), "{refused}");
    // The confirmed argv belongs to one target: another port changes %p.
    let netcat = "/usr/bin/nc %h %p";
    let argv = new_windterm_desktop::ssh::proxy_command_preview(&target, netcat).unwrap();
    let mut elsewhere = target.clone();
    elsewhere.port = server.port.wrapping_add(1).max(1);
    assert!(service
        .probe_via(
            "main",
            &id(),
            elsewhere,
            RouteSpec::ProxyCommand {
                command: netcat.into(),
                argv: argv.clone(),
            },
            &scope,
        )
        .await
        .is_err());
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(!marker.exists(), "an unconfirmed ProxyCommand ran");
    assert_eq!(server.active.load(Ordering::SeqCst), 0);

    // The confirmed argv carries the probe, the command and the terminal.
    let challenge = probe(
        &service,
        &server,
        RouteSpec::ProxyCommand {
            command: netcat.into(),
            argv: argv.clone(),
        },
    )
    .await;
    assert_eq!(challenge.fingerprint, server.fingerprint());
    assert_eq!(
        challenge.route,
        RouteSummary::ProxyCommand { argv: argv.clone() }
    );
    assert_eq!(check(&service, &challenge.challenge_token).await, Ok(7));
    let terminal = probe(
        &service,
        &server,
        RouteSpec::ProxyCommand {
            command: netcat.into(),
            argv,
        },
    )
    .await;
    assert_eq!(shell(&service, &terminal.challenge_token).await, Some(7));
    server.stop().await;
}

#[tokio::test]
async fn jump_route_confirms_the_jump_host_then_the_target() {
    let _serial = TEST_LOCK.lock().await;
    let mut hop = fixture::Fixture::start().await;
    let mut target = fixture::Fixture::start().await;
    let directory = std::env::temp_dir().join(format!("p0-route-trust-{}", id()));
    let service = Arc::new(Ssh::with_known_hosts(directory.join("known_hosts")));
    let scope = service.context("main").unwrap();

    // Step 1: the jump host's own key, reached directly, without credentials.
    let first = probe(&service, &target, jump(&hop)).await;
    assert_eq!(
        (first.stage, first.port, first.trust),
        (Stage::Jump, hop.port, Trust::New)
    );
    assert_eq!(first.fingerprint, hop.fingerprint());
    assert_eq!(first.route, RouteSummary::Direct);
    assert_eq!(hop.authentications.load(Ordering::SeqCst), 0);
    assert_eq!(target.active.load(Ordering::SeqCst), 0);
    // A jump host's challenge never stands in for the target's.
    let early = check(&service, &first.challenge_token).await.err().unwrap();
    assert!(early.contains("jump host"), "{early}");
    service.trust_save("main", &first.challenge_token).unwrap();

    // Step 2: the jump credential is sent only now; the target's key is
    // observed through the jump host.
    let jump_login = Credential::Password {
        password: Zeroizing::new(fixture::PASSWORD.into()),
    };
    let second = service
        .probe_through(
            "main",
            &id(),
            &first.challenge_token,
            &scope,
            jump_login.clone(),
        )
        .await
        .unwrap();
    assert_eq!(
        (second.stage, second.port, second.trust),
        (Stage::Target, target.port, Trust::New)
    );
    assert_eq!(second.fingerprint, target.fingerprint());
    assert_eq!(
        second.route,
        RouteSummary::Jump {
            host: "127.0.0.1".into(),
            port: hop.port,
            username: "fixture".into(),
            fingerprint: hop.fingerprint(),
        }
    );
    let json = serde_json::to_string(&second.route).unwrap();
    assert!(!json.contains(fixture::PASSWORD), "{json}");
    assert_eq!(hop.forwards.load(Ordering::SeqCst), 1);
    // The jump challenge was consumed; a target challenge is not a jump step.
    for token in [&first.challenge_token, &second.challenge_token] {
        assert!(service
            .probe_through("main", &id(), token, &scope, jump_login.clone())
            .await
            .is_err());
    }

    // Later operations reuse the pinned jump host and its credential.
    assert_eq!(check(&service, &second.challenge_token).await, Ok(7));
    assert_eq!(hop.forwards.load(Ordering::SeqCst), 2);
    let again = service
        .probe_via("main", &id(), request(&target), jump(&hop), &scope)
        .await
        .unwrap();
    assert_eq!(
        again.trust,
        Trust::Known,
        "the saved jump host key is reused"
    );
    let terminal = service
        .probe_through(
            "main",
            &id(),
            &again.challenge_token,
            &scope,
            jump_login.clone(),
        )
        .await
        .unwrap();
    assert_eq!(shell(&service, &terminal.challenge_token).await, Some(7));
    assert_eq!(hop.forwards.load(Ordering::SeqCst), 4);

    // A changed jump host key blocks step 2 before any credential is sent.
    let previous = hop.fingerprint();
    *hop.host.lock().unwrap() = fixture::key();
    let changed = service
        .probe_via("main", &id(), request(&target), jump(&hop), &scope)
        .await
        .unwrap();
    assert_eq!(changed.trust, Trust::Changed);
    assert_eq!(
        changed.saved_fingerprint.as_deref(),
        Some(previous.as_str())
    );
    let before = hop.authentications.load(Ordering::SeqCst);
    let blocked = service
        .probe_through("main", &id(), &changed.challenge_token, &scope, jump_login)
        .await
        .err()
        .unwrap();
    assert!(blocked.contains("differs from the saved key"), "{blocked}");
    assert_eq!(hop.authentications.load(Ordering::SeqCst), before);
    hop.stop().await;
    target.stop().await;
    std::fs::remove_dir_all(directory).unwrap();
}

#[tokio::test]
async fn a_jump_host_that_changes_or_refuses_later_fails_before_the_target() {
    let _serial = TEST_LOCK.lock().await;
    let mut hop = fixture::Fixture::start().await;
    let mut target = fixture::Fixture::start().await;
    let service = Arc::new(Ssh::default());
    let scope = service.context("main").unwrap();
    let confirmed = |credential: Credential| {
        let service = service.clone();
        let (target, hop) = (request(&target), jump(&hop));
        let scope = scope.clone();
        async move {
            let first = service
                .probe_via("main", &id(), target, hop, &scope)
                .await
                .unwrap();
            service
                .probe_through("main", &id(), &first.challenge_token, &scope, credential)
                .await
        }
    };

    // A wrong jump password is refused without echoing it or reaching the target.
    let wrong = confirmed(Credential::Password {
        password: Zeroizing::new("wrong-jump-pw".into()),
    })
    .await
    .err()
    .unwrap();
    assert!(
        wrong.starts_with("Jump host:") && !wrong.contains("wrong-jump-pw"),
        "{wrong}"
    );
    assert_eq!(target.active.load(Ordering::SeqCst), 0);
    // Prompted keyboard-interactive cannot log in to a jump host.
    assert!(confirmed(Credential::KeyboardInteractivePrompted {})
        .await
        .err()
        .unwrap()
        .contains("cannot ask"));

    // The jump host's key changes after the target was confirmed: the pinned
    // jump key fails the handshake and the target never authenticates.
    let second = confirmed(Credential::default()).await.unwrap();
    *hop.host.lock().unwrap() = fixture::key();
    let before = target.authentications.load(Ordering::SeqCst);
    let error = check(&service, &second.challenge_token)
        .await
        .err()
        .unwrap();
    assert_eq!(
        error,
        "Jump host key changed; authentication was not attempted"
    );
    assert_eq!(target.authentications.load(Ordering::SeqCst), before);
    hop.stop().await;
    target.stop().await;
}
