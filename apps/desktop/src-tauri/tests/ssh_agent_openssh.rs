//! Agent forwarding (C10) against system OpenSSH: `Ssh::open_with_agent`,
//! the method the `ssh_open` command calls, opens two real OpenSSH shells,
//! and the remote `ssh-add -l` reaches the local agent only on the one that
//! opted in. Ignored: `tests/fixtures/ssh-terminal/agent-client.test.mjs`
//! starts the fixture in `--agent` mode and a private, temporary
//! `ssh-agent` holding one generated key, and points `SSH_AUTH_SOCK` of this
//! process (only) at it. The user's agent and keys are never used.
#![cfg(unix)]
use new_windterm_desktop::{
    pty::{EventSink, PtyEvent},
    ssh::{Credential, Request, Ssh},
};
use std::{sync::Arc, time::Duration};
use tokio::sync::mpsc;

/// What `ssh-add` prints when `SSH_AUTH_SOCK` names no agent.
const NO_AGENT: &str = "Could not open a connection to your authentication agent";
/// The fixture's `agent-list` command ends with this line.
const STATUS: &str = "P0_AGENT_STATUS ";

fn env(name: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| panic!("{name} is not set; run the Node runner"))
}

fn id() -> String {
    uuid::Uuid::new_v4().to_string()
}

/// One remote `agent-list`: `ssh-add -l -E sha256` and the shell's view.
#[derive(Debug)]
struct Listing {
    /// `$SSH_AUTH_SOCK` in the remote shell, empty when unset.
    socket: String,
    /// Each output line of `ssh-add -l`.
    lines: Vec<String>,
    /// Its exit status.
    status: String,
}

/// An open terminal; data is acknowledged as the xterm front end does.
struct Screen {
    service: Arc<Ssh>,
    id: String,
    events: mpsc::UnboundedReceiver<PtyEvent>,
    output: Vec<u8>,
    exit: Option<Option<u32>>,
}

impl Screen {
    fn text(&self, start: usize) -> String {
        String::from_utf8_lossy(&self.output[start..]).into_owned()
    }

    /// Waits until the output after `start` satisfies `done`.
    async fn until(&mut self, start: usize, what: &str, done: impl Fn(&str) -> bool) {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
        while !done(&self.text(start)) {
            let event = tokio::time::timeout_at(deadline, self.events.recv())
                .await
                .unwrap_or_else(|_| panic!("missing {what}; got {:?}", self.text(start)))
                .expect("terminal event stream ended");
            match event {
                PtyEvent::Data { sequence, data, .. } => {
                    self.output.extend_from_slice(&data);
                    // Once the terminal has ended, a late ACK has nothing to release.
                    let _ = self.service.ack("main", &self.id, sequence);
                }
                PtyEvent::Exit { code, .. } => {
                    self.exit = Some(code);
                    assert!(done(&self.text(start)), "exited {code:?} before {what}");
                }
                PtyEvent::Error { message, .. } => panic!("terminal error: {message}"),
            }
        }
    }

    fn write(&self, line: &str) {
        self.service
            .write("main", &self.id, format!("{line}\r").into_bytes())
            .unwrap_or_else(|error| panic!("write {line:?}: {error}"));
    }

    /// Runs the fixture's `agent-list` and parses its marked lines. PTY
    /// lines end in CR LF; the markers never appear in the typed command.
    async fn list(&mut self) -> Listing {
        let start = self.output.len();
        self.write("agent-list");
        let ended = |text: &str| {
            text.split_once(STATUS)
                .is_some_and(|(_, rest)| rest.contains('\n'))
        };
        self.until(start, "the agent listing", ended).await;
        let text = self.text(start);
        let field = |line: &str, marker: &str| {
            line.strip_prefix(marker)
                .map(|value| value.trim_end_matches(['\r', '\n']).to_owned())
        };
        let mut listing = Listing {
            socket: String::new(),
            lines: Vec::new(),
            status: String::new(),
        };
        for line in text.split('\n') {
            if let Some(value) = field(line, "P0_AGENT_SOCKET ") {
                listing.socket = value;
            } else if let Some(value) = field(line, "P0_AGENT_LINE ") {
                listing.lines.push(value);
            } else if let Some(value) = field(line, STATUS) {
                listing.status = value;
            }
        }
        listing
    }

    async fn exit_code(&mut self) -> Option<u32> {
        let start = self.output.len();
        self.write("exit");
        let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
        while self.exit.is_none() {
            match tokio::time::timeout_at(deadline, self.events.recv())
                .await
                .unwrap_or_else(|_| panic!("exit deadline exceeded; got {:?}", self.text(start)))
                .expect("terminal event stream ended")
            {
                PtyEvent::Data { sequence, data, .. } => {
                    self.output.extend_from_slice(&data);
                    let _ = self.service.ack("main", &self.id, sequence);
                }
                PtyEvent::Exit { code, .. } => self.exit = Some(code),
                PtyEvent::Error { message, .. } => panic!("terminal error: {message}"),
            }
        }
        self.exit.unwrap()
    }
}

/// Probes, checks the fixture's fingerprint, and opens a terminal on it.
async fn open(service: &Arc<Ssh>, agent: bool) -> Screen {
    let scope = service.context("main").unwrap();
    let request = Request {
        host: env("P0_SSH_FIXTURE_HOST"),
        port: env("P0_SSH_FIXTURE_PORT")
            .parse()
            .expect("P0_SSH_FIXTURE_PORT is a port"),
        username: env("P0_SSH_FIXTURE_USER"),
        private_key_path: env("P0_SSH_FIXTURE_KEY"),
    };
    let challenge = service
        .probe("main", &id(), request, &scope)
        .await
        .unwrap_or_else(|error| panic!("probe: {error}"));
    assert_eq!(challenge.fingerprint, env("P0_SSH_FIXTURE_FINGERPRINT"));
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
        .await
        .unwrap_or_else(|error| panic!("open with agent={agent}: {error}"));
    let mut screen = Screen {
        service: service.clone(),
        id,
        events,
        output: Vec::new(),
        exit: None,
    };
    screen
        .until(0, "the fixture prompt", |text| {
            text.contains("P0_INTERACTIVE_READY")
        })
        .await;
    screen
}

fn assert_unreachable(listing: &Listing, fingerprint: &str) {
    assert_eq!(listing.socket, "", "{listing:?}");
    assert_eq!(listing.status, "2", "{listing:?}");
    assert!(
        listing.lines.iter().any(|line| line.contains(NO_AGENT)),
        "{listing:?}"
    );
    assert!(
        !listing.lines.iter().any(|line| line.contains(fingerprint)),
        "{listing:?}"
    );
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires OpenSSH and a private ssh-agent; run tests/fixtures/ssh-terminal/agent-client.test.mjs"]
async fn real_openssh_agent_forwarding_is_opt_in() {
    let fingerprint = env("P0_AGENT_FINGERPRINT");
    assert!(fingerprint.starts_with("SHA256:"), "{fingerprint}");
    let service = Arc::new(Ssh::default());

    // Off by default: sshd sets no SSH_AUTH_SOCK, so ssh-add finds no agent.
    let mut plain = open(&service, false).await;
    let off = plain.list().await;
    println!("P0_AGENT_EVIDENCE off {off:?}");
    assert_unreachable(&off, &fingerprint);

    // Opted in: sshd binds a listener, and every channel it opens for it is
    // relayed to the private agent, whose single key the remote side lists.
    let mut forwarded = open(&service, true).await;
    let on = forwarded.list().await;
    println!("P0_AGENT_EVIDENCE on {on:?}");
    assert_eq!(on.status, "0", "{on:?}");
    assert!(on.socket.starts_with('/'), "{on:?}");
    assert_eq!(on.lines.len(), 1, "{on:?}");
    assert!(on.lines[0].contains(&fingerprint), "{on:?}");
    assert!(on.lines[0].ends_with("(ED25519)"), "{on:?}");
    // The runner checks where sshd put it and that sshd removed it.
    println!("P0_AGENT_SOCKET {}", on.socket);

    // The other connection still has no agent while this one forwards.
    let still = plain.list().await;
    assert_unreachable(&still, &fingerprint);

    assert_eq!(forwarded.exit_code().await, Some(7));
    assert_eq!(plain.exit_code().await, Some(7));
}
