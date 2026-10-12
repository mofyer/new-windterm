//! Route parsing, binding and secrecy tests; `real_fixture_*` needs OpenSSH.
use super::super::{Pending, Trust};
use super::*;
use std::time::{Duration, Instant};

fn id() -> String {
    uuid::Uuid::new_v4().to_string()
}

fn target() -> Request {
    Request {
        host: "target.example".into(),
        port: 2222,
        username: "fixture".into(),
        private_key_path: String::new(),
    }
}

fn parse(json: &str) -> Result<RouteSpec, serde_json::Error> {
    serde_json::from_str(json)
}

#[test]
fn specs_parse_by_kind_and_reject_unknown_fields() {
    assert!(matches!(
        parse(r#"{"kind":"direct"}"#).unwrap(),
        RouteSpec::Direct {}
    ));
    assert!(parse(r#"{"kind":"direct","password":"x"}"#).is_err());
    assert!(matches!(
        parse(r#"{"kind":"httpConnect","host":"proxy","port":3128,"username":"u","password":"p"}"#)
            .unwrap(),
        RouteSpec::HttpConnect {
            password: Some(_),
            ..
        }
    ));
    assert!(matches!(
        parse(r#"{"kind":"socks5","host":"proxy","port":1080}"#).unwrap(),
        RouteSpec::Socks5 {
            username: None,
            password: None,
            ..
        }
    ));
    assert!(matches!(
        parse(r#"{"kind":"jump","host":"jump","port":22,"username":"u","privateKeyPath":"/k"}"#).unwrap(),
        RouteSpec::Jump { private_key_path, .. } if private_key_path == "/k"
    ));
    // The jump route never carries a secret; it is sent after confirmation.
    assert!(
        parse(r#"{"kind":"jump","host":"j","port":22,"username":"u","password":"x"}"#).is_err()
    );
    assert!(parse(r#"{"kind":"proxyCommand","command":"/bin/nc %h %p"}"#).is_err());
    assert!(parse(r#"{"kind":"shell","command":"nc"}"#).is_err());
}

fn plan(spec: RouteSpec) -> Result<Route, String> {
    match spec.plan(&target())? {
        Plan::Reach(route) => Ok(route),
        Plan::Jump(_) => Err("jump".into()),
    }
}

fn http(user: Option<&str>, password: Option<&str>) -> RouteSpec {
    RouteSpec::HttpConnect {
        host: "proxy.example".into(),
        port: 3128,
        username: user.map(Into::into),
        password: password.map(|p| Zeroizing::new(p.into())),
    }
}

#[test]
fn proxy_inputs_are_bounded_and_summaries_hold_no_secret() {
    let route = plan(http(Some("user"), Some("hunter2"))).unwrap();
    let summary = route.summary();
    assert_eq!(
        summary,
        RouteSummary::HttpConnect {
            host: "proxy.example".into(),
            port: 3128,
            authenticated: true
        }
    );
    let json = serde_json::to_string(&summary).unwrap();
    assert!(
        !json.contains("hunter2") && !json.contains("user"),
        "{json}"
    );
    assert!(plan(http(None, Some("orphan"))).is_err());
    assert!(
        plan(http(Some("a:b"), Some("p"))).is_err(),
        "':' breaks Basic auth"
    );
    assert!(plan(http(Some("a\nb"), None)).is_err());
    assert!(plan(http(Some(&"u".repeat(256)), None)).is_err());
    assert!(plan(http(Some("u"), Some(&"p".repeat(256)))).is_err());
    assert!(plan(http(Some("u"), Some("a\0b"))).is_err());
    let error = plan(http(Some("u"), Some(&"secret-".repeat(40))))
        .err()
        .unwrap();
    assert!(!error.contains("secret-"), "{error}");
    // SOCKS5 allows ':' in the user name (it is length-prefixed) but, per
    // RFC 1929, not an empty password.
    let socks = |password: Option<&str>| RouteSpec::Socks5 {
        host: "proxy".into(),
        port: 1080,
        username: Some("a:b".into()),
        password: password.map(|p| Zeroizing::new(p.into())),
    };
    assert!(plan(socks(Some("p"))).is_ok());
    assert!(plan(socks(None)).is_err() && plan(socks(Some(""))).is_err());
    assert!(
        plan(http(Some("u"), None)).is_ok(),
        "Basic allows an empty password"
    );
    for (host, port) in [
        ("", 1080),
        ("proxy", 0),
        ("-oProxyCommand=x", 1080),
        ("a b", 1),
    ] {
        let spec = RouteSpec::Socks5 {
            host: host.into(),
            port,
            username: None,
            password: None,
        };
        assert!(plan(spec).is_err(), "{host:?}:{port}");
    }
}

/// Any absolute program path: previews and plans never start it.
#[cfg(unix)]
const PROGRAM: &str = "/usr/bin/nc";
#[cfg(windows)]
const PROGRAM: &str = r"C:\Tools\nc.exe";

#[test]
fn proxy_command_runs_only_the_argv_that_was_shown() {
    let command = format!("{PROGRAM} -X connect %h %p");
    let argv = proxy_command_preview(&target(), &command).unwrap();
    assert_eq!(argv, [PROGRAM, "-X", "connect", "target.example", "2222"]);
    let spec = |argv: Vec<String>| RouteSpec::ProxyCommand {
        command: command.clone(),
        argv,
    };
    assert!(matches!(plan(spec(argv.clone())), Ok(Route::Command(ref run)) if *run == argv));
    let mut edited = argv.clone();
    edited[3] = "elsewhere".into();
    assert!(plan(spec(edited))
        .err()
        .unwrap()
        .contains("review it again"));
    // A different target changes %h, so the confirmed argv no longer applies.
    let mut other = target();
    other.host = "other.example".into();
    assert!(RouteSpec::ProxyCommand {
        command: command.clone(),
        argv
    }
    .plan(&other)
    .is_err());
    for bad in [
        "nc %h %p",
        "./nc %h",
        "",
        "   ",
        "/bin/nc %d",
        "/bin/nc 'open",
    ] {
        assert!(proxy_command_preview(&target(), bad).is_err(), "{bad:?}");
    }
    let long = format!("/bin/echo {}", "%h ".repeat(1000));
    assert!(proxy_command_preview(&target(), &long).is_err());
}

#[test]
fn a_jump_route_first_names_the_jump_host_without_credentials() {
    let spec = RouteSpec::Jump {
        host: "jump.example".into(),
        port: 22,
        username: "hop".into(),
        private_key_path: String::new(),
    };
    let Plan::Jump(jump) = spec.plan(&target()).unwrap() else {
        panic!("a jump route must observe the jump host first");
    };
    assert_eq!((jump.host.as_str(), jump.port), ("jump.example", 22));
    let invalid = RouteSpec::Jump {
        host: "jump.example".into(),
        port: 22,
        username: "hop".into(),
        private_key_path: "relative/key".into(),
    };
    assert!(invalid
        .plan(&target())
        .err()
        .unwrap()
        .starts_with("Jump host:"));
}

/// Registers a challenge as `Ssh::challenge` would; `next` marks a jump host's.
fn pending(service: &Ssh, next: Option<Request>, route: Route) -> String {
    let token = id();
    service.registry.lock().unwrap().challenges.insert(
        token.clone(),
        Pending {
            owner: "main".into(),
            request: target(),
            key: vec![1],
            expires: Instant::now() + Duration::from_secs(60),
            public: None,
            trust: Trust::New,
            route,
            next,
        },
    );
    token
}

#[test]
fn jump_and_target_challenges_cannot_stand_in_for_each_other() {
    let service = Ssh::default();
    let jump = pending(&service, Some(target()), Route::Direct);
    assert_eq!(service.consume("main", &jump).err().unwrap(), JUMP_FIRST);
    // A refused challenge stays pending for its own step.
    assert!(service
        .registry
        .lock()
        .unwrap()
        .challenges
        .contains_key(&jump));
    assert!(service.take("main", &jump, Stage::Jump).is_ok());
    let direct = pending(&service, None, Route::Direct);
    assert_eq!(
        service.take("main", &direct, Stage::Jump).err().unwrap(),
        NOT_JUMP
    );
    assert!(service.consume("main", &direct).is_ok());
}

#[test]
fn a_grant_keeps_the_route_and_proxy_login_of_its_challenge() {
    let service = Ssh::default();
    let scope = service.context("main").unwrap();
    let operation = service.start("main", &id(), &scope).unwrap();
    let route = plan(http(Some("user"), Some("hunter2"))).unwrap();
    let summary = route.summary();
    let token = service
        .issue_grant(
            &operation,
            &scope,
            target(),
            vec![1],
            Credential::default(),
            route,
        )
        .unwrap();
    let reused = service.use_grant("main", &token, &scope).unwrap();
    assert_eq!(reused.route.summary(), summary);
    let Route::Http(server) = reused.route else {
        panic!("the grant lost its route");
    };
    assert_eq!(server.login(), Some(("user", "hunter2")));
}

#[tokio::test]
async fn a_jump_step_checks_window_and_credential_before_using_the_challenge() {
    let service = Ssh::default();
    let scope = service.context("main").unwrap();
    let jump = pending(&service, Some(target()), Route::Direct);
    let prompted = Credential::KeyboardInteractivePrompted {};
    let error = service
        .probe_through("main", &id(), &jump, &scope, prompted)
        .await
        .err()
        .unwrap();
    assert_eq!(error, JUMP_PROMPTED);
    let other = service.context("other").unwrap();
    let error = service
        .probe_through("other", &id(), &jump, &other, Credential::Agent {})
        .await
        .err()
        .unwrap();
    assert_eq!(error, "SSH challenge not owned by this window");
    let registry = service.registry.lock().unwrap();
    assert!(registry.challenges.contains_key(&jump) && registry.active.is_empty());
}

/// Read-only SFTP against the isolated OpenSSH fixture through every route:
/// test proxies, `/usr/bin/nc` as ProxyCommand, and the russh fixture as
/// the jump host. Each grant operation reconnects through its route.
#[tokio::test]
#[ignore = "requires the isolated fixture; run tests/fixtures/ssh-sftp/rust-client.test.mjs"]
async fn real_fixture_sftp_through_routes() {
    use super::super::{forward::fixture, proxy::test_proxy};
    let env = |name: &str| std::env::var(name).unwrap();
    let remote = env("P0_SSH_FIXTURE_REMOTE");
    let target = Request {
        host: env("P0_SSH_FIXTURE_HOST"),
        port: env("P0_SSH_FIXTURE_PORT").parse().unwrap(),
        username: env("P0_SSH_FIXTURE_USER"),
        private_key_path: env("P0_SSH_FIXTURE_KEY"),
    };
    let http = test_proxy::start(test_proxy::Kind::Http, Some(("p0", "proxy-secret"))).await;
    let socks = test_proxy::start(test_proxy::Kind::Socks5, Some(("p0", "socks-secret"))).await;
    let mut hop = fixture::Fixture::start().await;
    let secret = |text: &str| Some(Zeroizing::new(text.to_string()));
    let mut routes = vec![
        RouteSpec::HttpConnect {
            host: "127.0.0.1".into(),
            port: http.address.port(),
            username: Some("p0".into()),
            password: secret("proxy-secret"),
        },
        RouteSpec::Socks5 {
            host: "127.0.0.1".into(),
            port: socks.address.port(),
            username: Some("p0".into()),
            password: secret("socks-secret"),
        },
        RouteSpec::Jump {
            host: "127.0.0.1".into(),
            port: hop.port,
            username: "fixture".into(),
            private_key_path: hop.key_path.to_string_lossy().into(),
        },
    ];
    if std::path::Path::new("/usr/bin/nc").exists() {
        let command = "/usr/bin/nc %h %p".to_string();
        let argv = proxy_command_preview(&target, &command).unwrap();
        routes.push(RouteSpec::ProxyCommand { command, argv });
    }
    let service = Ssh::default();
    let scope = service.context("main").unwrap();
    for route in routes {
        let jump = matches!(route, RouteSpec::Jump { .. });
        let mut challenge = service
            .probe_via("main", &id(), target.clone(), route, &scope)
            .await
            .unwrap();
        if jump {
            assert_eq!(challenge.fingerprint, hop.fingerprint());
            challenge = service
                .probe_through(
                    "main",
                    &id(),
                    &challenge.challenge_token,
                    &scope,
                    Credential::default(),
                )
                .await
                .unwrap();
        }
        assert_eq!(challenge.stage, Stage::Target);
        assert_eq!(challenge.fingerprint, env("P0_SSH_FIXTURE_FINGERPRINT"));
        let opened = service
            .sftp_open("main", &id(), &challenge.challenge_token, &scope)
            .await
            .unwrap();
        assert_eq!(opened.listing.path, remote);
        let grant = opened.grant_token;
        let file = format!("{remote}/small-中文.txt");
        let entry = service
            .sftp_metadata("main", &id(), &grant, &scope, file.clone(), None)
            .await
            .unwrap();
        let bytes = service
            .sftp_read("main", &id(), &grant, &scope, file, None)
            .await
            .unwrap();
        assert_eq!(bytes.len() as u64, entry.size);
        assert!(bytes.starts_with(b"P0 SFTP read-only"));
        service.sftp_close("main", &grant).unwrap();
    }
    // Probe, open, metadata and read each crossed the route once.
    assert_eq!(http.tunnels().len(), 4);
    assert_eq!(socks.tunnels().len(), 4);
    assert_eq!(
        hop.forwards.load(std::sync::atomic::Ordering::SeqCst),
        4,
        "jump host relayed the target probe and three SFTP connections"
    );
    hop.stop().await;
}
