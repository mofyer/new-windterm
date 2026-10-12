//! Agent forwarding (C10) through `Ssh::open_with_agent`, the method the
//! `ssh_open` command calls. The peer is the loopback russh fixture, not
//! OpenSSH; the agent is a private, temporary `ssh-agent`, never the user's.
//! This is the only test in its binary because it changes `SSH_AUTH_SOCK`.
//! Unix only: it starts `/usr/bin/ssh-agent` on a Unix socket.
#![cfg(unix)]
#[path = "support/ssh_terminal_fixture.rs"]
#[allow(dead_code)]
mod fixture;
use new_windterm_desktop::{
    pty::{EventSink, PtyEvent},
    ssh::{Credential, Request, Ssh},
};
use std::{
    ffi::{OsStr, OsString},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{atomic::Ordering, Arc},
    time::Duration,
};
use tokio::sync::mpsc;

const SSH_AGENT: &str = "/usr/bin/ssh-agent";
const SSH_ADD: &str = "/usr/bin/ssh-add";

fn id() -> String {
    uuid::Uuid::new_v4().to_string()
}

/// A private `ssh-agent -D` on a temporary socket, stopped when dropped.
struct Agent {
    child: Child,
    socket: PathBuf,
}

impl Agent {
    async fn start(key: &Path) -> Self {
        let socket = std::env::temp_dir().join(format!("p0-c10-{}.sock", &id()[..8]));
        let child = Command::new(SSH_AGENT)
            .args(["-D", "-a"])
            .arg(&socket)
            .stdout(Stdio::null())
            .spawn()
            .unwrap();
        let agent = Self { child, socket };
        for _ in 0..100 {
            if agent.socket.exists() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        let added = Command::new(SSH_ADD)
            .arg(key)
            .env("SSH_AUTH_SOCK", &agent.socket)
            .output()
            .unwrap();
        assert!(
            added.status.success(),
            "{}",
            String::from_utf8_lossy(&added.stderr)
        );
        agent
    }
}

impl Drop for Agent {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_file(&self.socket);
    }
}

/// `SSH_AUTH_SOCK` as this test sets it; the previous value is restored when
/// dropped, also when an assertion fails. Changing the environment while the
/// runtime's threads run is sound here only because this is the sole test in
/// its binary and no other code of the process reads or writes the variable
/// concurrently (the app reads it once per opened terminal).
struct AuthSock(Option<OsString>);

impl AuthSock {
    fn set(value: Option<&OsStr>) -> Self {
        let guard = Self(std::env::var_os("SSH_AUTH_SOCK"));
        guard.change(value);
        guard
    }

    fn change(&self, value: Option<&OsStr>) {
        match value {
            Some(value) => std::env::set_var("SSH_AUTH_SOCK", value),
            None => std::env::remove_var("SSH_AUTH_SOCK"),
        }
    }
}

impl Drop for AuthSock {
    fn drop(&mut self) {
        self.change(self.0.as_deref());
    }
}

/// An open terminal; data is acknowledged as the xterm front end does.
struct Screen {
    service: Arc<Ssh>,
    id: String,
    events: mpsc::UnboundedReceiver<PtyEvent>,
    output: Vec<u8>,
}

impl Screen {
    /// Sends `command` and waits for `marker` in the output after it.
    async fn ask(&mut self, command: &str, marker: &str) {
        let start = self.output.len();
        self.service
            .write("main", &self.id, format!("{command}\r").into_bytes())
            .unwrap();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        while !String::from_utf8_lossy(&self.output[start..]).contains(marker) {
            let event = tokio::time::timeout_at(deadline, self.events.recv())
                .await
                .unwrap_or_else(|_| {
                    panic!(
                        "missing {marker:?}; got {:?}",
                        String::from_utf8_lossy(&self.output[start..])
                    )
                })
                .expect("terminal event stream ended");
            match event {
                PtyEvent::Data { sequence, data, .. } => {
                    self.output.extend_from_slice(&data);
                    let _ = self.service.ack("main", &self.id, sequence);
                }
                PtyEvent::Exit { .. } => panic!("terminal exited"),
                PtyEvent::Error { message, .. } => panic!("terminal error: {message}"),
            }
        }
    }
}

async fn open(
    service: &Arc<Ssh>,
    server: &fixture::Fixture,
    agent: bool,
) -> Result<Screen, String> {
    let scope = service.context("main")?;
    let request = Request {
        host: "127.0.0.1".into(),
        port: server.port,
        username: "fixture".into(),
        private_key_path: server.key_path.to_string_lossy().into(),
    };
    let challenge = service.probe("main", &id(), request, &scope).await?;
    let (sender, events) = mpsc::unbounded_channel();
    let sink: EventSink = Arc::new(move |event| sender.send(event).map_err(|e| e.to_string()));
    let id = service
        .open_with_agent(
            "main",
            &id(),
            &challenge.challenge_token,
            &scope,
            Credential::default(),
            80,
            24,
            sink,
            agent,
        )
        .await?;
    Ok(Screen {
        service: service.clone(),
        id,
        events,
        output: Vec::new(),
    })
}

#[tokio::test(flavor = "multi_thread")]
async fn agent_forwarding_is_opt_in_and_per_connection() {
    if !Path::new(SSH_AGENT).exists() || !Path::new(SSH_ADD).exists() {
        eprintln!("skipped: {SSH_AGENT} or {SSH_ADD} is not installed");
        return;
    }
    let mut server = fixture::Fixture::start().await;
    let agent = Agent::start(&server.key_path).await;
    let auth_sock = AuthSock::set(Some(agent.socket.as_os_str()));
    let service = Arc::new(Ssh::default());

    // Off by default: the server is never asked to forward.
    let mut plain = open(&service, &server, false).await.unwrap();
    plain.ask("agent", "AGENT OFF").await;

    // On for one connection: the server reaches the private agent's key.
    let mut forwarded = open(&service, &server, true).await.unwrap();
    forwarded.ask("agent", "AGENT 1 KEYS").await;
    // The other connection is unaffected while this one forwards.
    plain.ask("agent", "AGENT OFF").await;
    forwarded.ask("agent", "AGENT 1 KEYS").await;
    service.close("main", &forwarded.id).unwrap();

    // A server refusal fails the open instead of continuing without it.
    server.denial.store(5, Ordering::SeqCst);
    let refused = open(&service, &server, true).await.err().unwrap();
    assert_eq!(refused, "SSH server refused agent forwarding");
    server.denial.store(0, Ordering::SeqCst);

    // Without a reachable local agent nothing is authenticated or opened.
    let before = server.authentications.load(Ordering::SeqCst);
    let missing = agent.socket.with_extension("missing");
    for value in [None, Some(missing.as_os_str())] {
        auth_sock.change(value);
        let error = open(&service, &server, true).await.err().unwrap();
        assert!(error.contains("local ssh-agent"), "{error}");
    }
    assert_eq!(server.authentications.load(Ordering::SeqCst), before);

    drop(auth_sock);
    service.close("main", &plain.id).unwrap();
    drop(agent);
    server.stop().await;
}
