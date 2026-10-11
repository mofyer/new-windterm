//! Interactive keyboard-interactive against the loopback russh fixture, which
//! asks "Password: " (no echo) and then "Verification code: " (echo). The
//! prompt sink stands in for the WebView channel; answers use `auth_respond`
//! exactly as the `ssh_auth_respond` command does. No PAM or OpenSSH involved.
#[path = "support/ssh_terminal_fixture.rs"]
#[allow(dead_code)]
mod fixture;
use new_windterm_desktop::{
    pty::{EventSink, PtyEvent},
    ssh::{AuthPrompt, Credential, Login, PromptSink, Request, Ssh},
};
use std::{
    sync::{atomic::Ordering, Arc},
    time::{Duration, Instant},
};
use tokio::sync::mpsc;
use zeroize::Zeroizing;

static TEST_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
const REJECTED: &str = "SSH keyboard-interactive authentication rejected";

fn id() -> String {
    uuid::Uuid::new_v4().to_string()
}

fn request(server: &fixture::Fixture) -> Request {
    Request {
        host: "127.0.0.1".into(),
        port: server.port,
        username: "fixture".into(),
        private_key_path: String::new(),
    }
}

fn answers(items: &[&str]) -> Vec<Zeroizing<String>> {
    items
        .iter()
        .map(|s| Zeroizing::new(s.to_string()))
        .collect()
}

/// A prompted login whose rounds arrive on the returned receiver.
fn prompted() -> (Login, mpsc::UnboundedReceiver<AuthPrompt>) {
    let (sender, events) = mpsc::unbounded_channel();
    let sink: PromptSink = Arc::new(move |prompt| sender.send(prompt).map_err(|e| e.to_string()));
    let login = Login {
        credential: Credential::KeyboardInteractivePrompted {},
        prompts: Some(sink),
    };
    (login, events)
}

async fn next(events: &mut mpsc::UnboundedReceiver<AuthPrompt>) -> AuthPrompt {
    tokio::time::timeout(Duration::from_secs(5), events.recv())
        .await
        .expect("no keyboard-interactive round arrived")
        .expect("prompt channel closed")
}

async fn token(server: &fixture::Fixture, service: &Ssh, scope: &str) -> String {
    service
        .probe("main", &id(), request(server), scope)
        .await
        .unwrap()
        .challenge_token
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

/// Answers both fixture rounds as the dialog would, checking what is shown.
async fn answer_both(
    service: &Ssh,
    operation: &str,
    events: &mut mpsc::UnboundedReceiver<AuthPrompt>,
    code: &str,
) {
    let first = next(events).await;
    assert_eq!((first.operation_id.as_str(), first.round), (operation, 1));
    assert_eq!(
        (first.name.as_str(), first.instructions.as_str()),
        ("P0 fixture", "Two factors")
    );
    assert_eq!(first.prompts.len(), 1);
    assert_eq!(
        (first.prompts[0].text.as_str(), first.prompts[0].echo),
        ("Password: ", false)
    );
    assert_eq!(first.expires_in_seconds, 120);
    service
        .auth_respond("main", operation, 1, answers(&[fixture::PASSWORD]))
        .unwrap();
    let second = next(events).await;
    assert_eq!(second.round, 2);
    assert_eq!(
        (second.prompts[0].text.as_str(), second.prompts[0].echo),
        ("Verification code: ", true)
    );
    service
        .auth_respond("main", operation, 2, answers(&[code]))
        .unwrap();
}

fn terminal_sink() -> (EventSink, mpsc::Receiver<PtyEvent>) {
    let (sender, events) = mpsc::channel(128);
    let sink: EventSink = Arc::new(move |event| {
        sender
            .try_send(event)
            .map_err(|_| "test event queue full".into())
    });
    (sink, events)
}

/// Reads terminal output until `marker`, acknowledging every block.
async fn until(service: &Ssh, session: &str, events: &mut mpsc::Receiver<PtyEvent>, marker: &str) {
    let mut text = String::new();
    tokio::time::timeout(Duration::from_secs(10), async {
        while !text.contains(marker) {
            match events.recv().await.expect("terminal events ended") {
                PtyEvent::Data { sequence, data, .. } => {
                    text.push_str(&String::from_utf8_lossy(&data));
                    service.ack("main", session, sequence).unwrap();
                }
                PtyEvent::Exit { code, .. } => {
                    assert_eq!(code, Some(7));
                    return;
                }
                PtyEvent::Error { message, .. } => panic!("terminal error: {message}"),
            }
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn prompted_rounds_authenticate_accept_terminal_and_sftp_open() {
    let _serial = TEST_LOCK.lock().await;
    let mut server = fixture::Fixture::start().await;
    let service = Arc::new(Ssh::default());
    let scope = service.context("main").unwrap();

    // Fixed command: both rounds answered through the window, then exit 7.
    let challenge = token(&server, &service, &scope).await;
    let operation = id();
    let (login, mut events) = prompted();
    let task = {
        let (service, operation, scope) = (service.clone(), operation.clone(), scope.clone());
        tokio::spawn(async move {
            service
                .accept_with("main", &operation, &challenge, &scope, login)
                .await
        })
    };
    answer_both(&service, &operation, &mut events, fixture::CODE).await;
    let output = task.await.unwrap().unwrap();
    assert_eq!(
        (output.exit_code, output.stdout.as_slice()),
        (7, fixture::FIXTURE_CHECK)
    );
    // The answered round is gone; the same answer cannot be replayed.
    assert!(service
        .auth_respond("main", &operation, 2, answers(&[fixture::CODE]))
        .is_err());
    drained(&server).await;

    // Interactive terminal tab.
    let challenge = token(&server, &service, &scope).await;
    let operation = id();
    let (login, mut events) = prompted();
    let (sink, mut output) = terminal_sink();
    let task = {
        let (service, operation, scope) = (service.clone(), operation.clone(), scope.clone());
        tokio::spawn(async move {
            service
                .open_with("main", &operation, &challenge, &scope, login, 80, 24, sink)
                .await
        })
    };
    answer_both(&service, &operation, &mut events, fixture::CODE).await;
    let session = task.await.unwrap().unwrap();
    until(&service, &session, &mut output, "> ").await;
    service.write("main", &session, b"exit\n".to_vec()).unwrap();
    until(&service, &session, &mut output, "never printed").await;
    drained(&server).await;

    // SFTP hand-off: authentication succeeds, then this fixture refuses the
    // subsystem. The failure is past authentication, not a rejected answer.
    let before = server.authentications.load(Ordering::SeqCst);
    let challenge = token(&server, &service, &scope).await;
    let operation = id();
    let (login, mut events) = prompted();
    let task = {
        let (service, operation, scope) = (service.clone(), operation.clone(), scope.clone());
        tokio::spawn(async move {
            service
                .sftp_open_with("main", &operation, &challenge, &scope, login)
                .await
        })
    };
    answer_both(&service, &operation, &mut events, fixture::CODE).await;
    let error = task.await.unwrap().err().unwrap();
    assert!(error.starts_with("SFTP subsystem"), "{error}");
    assert_eq!(server.authentications.load(Ordering::SeqCst), before + 1);
    drained(&server).await;
    server.stop().await;
}

#[tokio::test]
async fn wrong_code_is_rejected_by_the_server() {
    let _serial = TEST_LOCK.lock().await;
    let mut server = fixture::Fixture::start().await;
    let service = Arc::new(Ssh::default());
    let scope = service.context("main").unwrap();
    let challenge = token(&server, &service, &scope).await;
    let operation = id();
    let (login, mut events) = prompted();
    let task = {
        let (service, operation, scope) = (service.clone(), operation.clone(), scope.clone());
        tokio::spawn(async move {
            service
                .accept_with("main", &operation, &challenge, &scope, login)
                .await
        })
    };
    answer_both(&service, &operation, &mut events, "000000").await;
    let error = task.await.unwrap().err().unwrap();
    assert_eq!(error, REJECTED);
    assert!(!error.contains("000000") && !error.contains(fixture::PASSWORD));
    assert!(
        events.try_recv().is_err(),
        "no further round after rejection"
    );
    drained(&server).await;
    server.stop().await;
}

#[tokio::test]
async fn cancel_or_reload_during_a_waiting_round_aborts_before_answering() {
    let _serial = TEST_LOCK.lock().await;
    let mut server = fixture::Fixture::start().await;
    let service = Arc::new(Ssh::default());
    for reload in [false, true] {
        let scope = service.context("main").unwrap();
        let challenge = token(&server, &service, &scope).await;
        let operation = id();
        let (login, mut events) = prompted();
        let (sink, _output) = terminal_sink();
        let task = {
            let (service, operation, scope) = (service.clone(), operation.clone(), scope.clone());
            tokio::spawn(async move {
                service
                    .open_with("main", &operation, &challenge, &scope, login, 80, 24, sink)
                    .await
            })
        };
        assert_eq!(next(&mut events).await.round, 1);
        if reload {
            service.close_owner("main");
        } else {
            service.cancel("main", &operation).unwrap();
        }
        let error = tokio::time::timeout(Duration::from_secs(2), task)
            .await
            .unwrap()
            .unwrap()
            .err()
            .unwrap();
        assert_eq!(error, "SSH operation cancelled");
        // Nothing waits any more, and the server never received an answer.
        assert!(service
            .auth_respond("main", &operation, 1, answers(&[fixture::PASSWORD]))
            .is_err());
        assert_eq!(server.authentications.load(Ordering::SeqCst), 0);
        drained(&server).await;
    }
    server.stop().await;
}

#[tokio::test]
async fn unanswered_round_fails_closed_at_its_deadline() {
    let _serial = TEST_LOCK.lock().await;
    let mut server = fixture::Fixture::start().await;
    let service = Arc::new(Ssh::default().with_prompt_deadline(Duration::from_millis(400)));
    let scope = service.context("main").unwrap();
    let challenge = token(&server, &service, &scope).await;
    let operation = id();
    let (login, mut events) = prompted();
    let started = Instant::now();
    let task = {
        let (service, operation, scope) = (service.clone(), operation.clone(), scope.clone());
        tokio::spawn(async move {
            service
                .accept_with("main", &operation, &challenge, &scope, login)
                .await
        })
    };
    assert_eq!(next(&mut events).await.expires_in_seconds, 1);
    let error = task.await.unwrap().err().unwrap();
    assert_eq!(error, "SSH keyboard-interactive prompt timed out");
    assert!(started.elapsed() < Duration::from_secs(5));
    assert!(service
        .auth_respond("main", &operation, 1, answers(&[fixture::PASSWORD]))
        .is_err());
    assert_eq!(server.authentications.load(Ordering::SeqCst), 0);
    drained(&server).await;
    server.stop().await;
}

#[tokio::test]
async fn only_the_starting_window_can_answer_the_current_round() {
    let _serial = TEST_LOCK.lock().await;
    let mut server = fixture::Fixture::start().await;
    let service = Arc::new(Ssh::default());
    let scope = service.context("main").unwrap();

    // Without a way to ask the window, nothing is consumed or connected.
    let challenge = token(&server, &service, &scope).await;
    let refused = service
        .accept_with(
            "main",
            &id(),
            &challenge,
            &scope,
            Credential::KeyboardInteractivePrompted {},
        )
        .await
        .err()
        .unwrap();
    assert_eq!(
        refused,
        "SSH keyboard-interactive prompts need an answer channel"
    );

    // The same challenge is still usable with a channel.
    let operation = id();
    let (login, mut events) = prompted();
    let task = {
        let (service, operation, scope) = (service.clone(), operation.clone(), scope.clone());
        tokio::spawn(async move {
            service
                .accept_with("main", &operation, &challenge, &scope, login)
                .await
        })
    };
    assert_eq!(next(&mut events).await.round, 1);
    let password = || answers(&[fixture::PASSWORD]);
    assert_eq!(
        service
            .auth_respond("other", &operation, 1, password())
            .unwrap_err(),
        "SSH operation not owned by this window"
    );
    assert!(service.cancel("other", &operation).is_err());
    assert!(service
        .auth_respond("main", &operation, 2, password())
        .unwrap_err()
        .contains("no longer current"));
    assert!(service
        .auth_respond(
            "main",
            &operation,
            1,
            answers(&[fixture::PASSWORD, "extra"])
        )
        .unwrap_err()
        .contains("count mismatch"));
    assert!(service
        .auth_respond("main", &id(), 1, password())
        .unwrap_err()
        .contains("No SSH authentication prompt"));
    assert!(service
        .auth_respond("main", "not-a-uuid", 1, password())
        .is_err());
    // None of the refused attempts reached the server or ended the round.
    assert_eq!(server.authentications.load(Ordering::SeqCst), 0);
    service
        .auth_respond("main", &operation, 1, password())
        .unwrap();
    assert_eq!(next(&mut events).await.round, 2);
    assert!(service
        .auth_respond("other", &operation, 2, answers(&[fixture::CODE]))
        .is_err());
    service
        .auth_respond("main", &operation, 2, answers(&[fixture::CODE]))
        .unwrap();
    assert_eq!(task.await.unwrap().unwrap().exit_code, 7);
    drained(&server).await;
    server.stop().await;
}
