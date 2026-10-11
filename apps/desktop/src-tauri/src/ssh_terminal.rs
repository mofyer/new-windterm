//! Interactive SSH channel transport. Host trust remains in the parent service.
use super::*;
use crate::pty::{EventSink, PtyEvent};
use tokio::sync::{mpsc, Notify};

const CHUNK: usize = 4096;
const BUDGET: usize = 64 * 1024;
const BLOCKS: usize = 64;
const ACK_WAIT: Duration = Duration::from_secs(15);

#[derive(Default)]
struct Flow {
    sequence: u64,
    acknowledged: u64,
    bytes: usize,
    pending: VecDeque<(u64, usize, Instant)>,
}
impl Flow {
    fn reserve(&mut self, bytes: usize) -> Option<u64> {
        if bytes == 0
            || bytes > CHUNK
            || self.bytes + bytes > BUDGET
            || self.pending.len() >= BLOCKS
        {
            return None;
        }
        self.sequence += 1;
        self.bytes += bytes;
        self.pending
            .push_back((self.sequence, bytes, Instant::now()));
        Some(self.sequence)
    }
    fn ack(&mut self, sequence: u64) -> Result<(), String> {
        if sequence == 0 || sequence > self.sequence {
            return Err("Invalid SSH acknowledgement".into());
        }
        if sequence <= self.acknowledged {
            return Ok(());
        }
        if sequence != self.acknowledged + 1 {
            return Err("Out-of-order SSH acknowledgement".into());
        }
        let (_, bytes, _) = self.pending.pop_front().ok_or("Missing SSH output block")?;
        self.bytes -= bytes;
        self.acknowledged = sequence;
        Ok(())
    }
    fn deadline(&self) -> Option<tokio::time::Instant> {
        self.pending
            .front()
            .map(|(_, _, at)| tokio::time::Instant::from_std(*at + ACK_WAIT))
    }
}

enum Control {
    Input(Vec<u8>),
    Resize(u16, u16),
}
pub(super) struct Terminal {
    owner: String,
    input: mpsc::Sender<Control>,
    flow: Mutex<Flow>,
    changed: Notify,
}
impl Ssh {
    fn terminal(&self, owner: &str, id: &str) -> Result<Arc<Terminal>, String> {
        let registry = self.registry.lock().map_err(|_| "SSH state unavailable")?;
        let terminal = registry.terminals.get(id).ok_or("SSH terminal is closed")?;
        if terminal.owner != owner {
            return Err("SSH terminal not owned by this window".into());
        }
        Ok(terminal.clone())
    }
    pub fn write(&self, owner: &str, id: &str, data: Vec<u8>) -> Result<(), String> {
        if data.is_empty() || data.len() > CHUNK {
            return Err("SSH input must contain 1 to 4096 bytes".into());
        }
        self.terminal(owner, id)?
            .input
            .try_send(Control::Input(data))
            .map_err(|_| "SSH input queue unavailable".into())
    }
    pub fn resize(&self, owner: &str, id: &str, cols: u16, rows: u16) -> Result<(), String> {
        size(cols, rows)?;
        self.terminal(owner, id)?
            .input
            .try_send(Control::Resize(cols, rows))
            .map_err(|_| "SSH input queue unavailable".into())
    }
    pub fn ack(&self, owner: &str, id: &str, sequence: u64) -> Result<(), String> {
        let terminal = match self.terminal(owner, id) {
            Ok(terminal) => terminal,
            Err(error) => {
                if self
                    .registry
                    .lock()
                    .map_err(|_| "SSH state unavailable")?
                    .completed
                    .iter()
                    .any(|(o, i)| o == owner && i == id)
                {
                    return Ok(());
                }
                return Err(error);
            }
        };
        terminal
            .flow
            .lock()
            .map_err(|_| "SSH flow unavailable")?
            .ack(sequence)?;
        terminal.changed.notify_one();
        Ok(())
    }
    pub fn close(&self, owner: &str, id: &str) -> Result<(), String> {
        self.cancel(owner, id)
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn open(
        self: &Arc<Self>,
        owner: &str,
        id: &str,
        token: &str,
        scope: &str,
        cols: u16,
        rows: u16,
        sink: EventSink,
    ) -> Result<String, String> {
        self.open_with(
            owner,
            id,
            token,
            scope,
            Credential::default(),
            cols,
            rows,
            sink,
        )
        .await
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn open_with(
        self: &Arc<Self>,
        owner: &str,
        id: &str,
        token: &str,
        scope: &str,
        login: impl Into<Login>,
        cols: u16,
        rows: u16,
        sink: EventSink,
    ) -> Result<String, String> {
        let Login {
            credential,
            prompts,
        } = login.into();
        size(cols, rows)?;
        let mut operation = self.start(owner, id, scope)?;
        check_prompts(&credential, prompts.as_ref())?;
        let pending = self.consume(owner, token)?;
        credential.validate(&pending.request)?;
        let clock = Clock::new(DEADLINE);
        let prompter = self.prompter(&operation, prompts, &clock);
        let work = connect(
            pending,
            credential,
            operation.cancel.clone(),
            prompter.as_ref(),
            (cols, rows),
        );
        let connection = tokio::select! {
            biased;
            _ = operation.cancel.changed() => return Err("SSH operation cancelled".into()),
            _ = clock.expired() => return Err("SSH terminal open timed out".into()),
            result = work => result?,
        };
        let (input, receiver) = mpsc::channel(16);
        let terminal = Arc::new(Terminal {
            owner: owner.into(),
            input,
            flow: Mutex::default(),
            changed: Notify::new(),
        });
        {
            let mut registry = self.registry.lock().map_err(|_| "SSH state unavailable")?;
            if *operation.cancel.borrow()
                || registry.shutdown
                || registry.scopes.get(owner).map(String::as_str) != Some(scope)
            {
                return Err("SSH operation cancelled".into());
            }
            registry.terminals.insert(id.into(), terminal.clone());
            operation.handed_off = true;
        }
        let service = self.clone();
        let id = id.to_string();
        let owner = owner.to_string();
        let cancel = operation.cancel.clone();
        tokio::spawn(async move {
            let result = run(&id, connection, terminal, receiver, cancel, &sink).await;
            match result {
                Ok(code) => {
                    let _ = sink(PtyEvent::Exit {
                        id: id.clone(),
                        code,
                    });
                }
                Err(message) => {
                    let _ = sink(PtyEvent::Error {
                        id: id.clone(),
                        message,
                    });
                }
            }
            service.finish(&owner, &id);
        });
        Ok(operation.id.clone())
    }
    fn finish(&self, owner: &str, id: &str) {
        let mut registry = self.registry.lock().unwrap_or_else(|e| e.into_inner());
        registry.terminals.remove(id);
        if let Some(active) = registry.active.remove(id) {
            active.cancel.send_replace(true);
        }
        if registry.completed.len() == MAX_CANCELLED {
            registry.completed.pop_front();
        }
        registry.completed.push_back((owner.into(), id.into()));
    }
}
fn size(cols: u16, rows: u16) -> Result<(), String> {
    if cols == 0 || rows == 0 || cols > 1000 || rows > 1000 {
        return Err("Invalid SSH terminal size".into());
    }
    Ok(())
}
struct Connection {
    _socket: SocketGuard,
    _session: client::Handle<KeyCheck>,
    channel: russh::Channel<client::Msg>,
    initial: Vec<ChannelMsg>,
    rekey_rejected: Arc<std::sync::atomic::AtomicBool>,
}
async fn connect(
    pending: Pending,
    credential: Credential,
    cancel: watch::Receiver<bool>,
    prompter: Option<&Prompter>,
    (cols, rows): (u16, u16),
) -> Result<Connection, String> {
    let rekey_rejected = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let result = async {
        let (socket, stream) = transport(&pending.request).await?;
        let mismatch = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let handler = KeyCheck {
            expected: Some(pending.key),
            observed: Arc::default(),
            mismatch: mismatch.clone(),
            kex_seen: false,
            rekey_rejected: rekey_rejected.clone(),
            routes: Arc::default(),
        };
        let config = Arc::new(client::Config {
            inactivity_timeout: None,
            window_size: 65536,
            maximum_packet_size: 4096,
            channel_buffer_size: 16,
            ..Default::default()
        });
        let mut session = client::connect_stream(config, stream, handler)
            .await
            .map_err(|_| {
                if mismatch.load(std::sync::atomic::Ordering::Relaxed) {
                    "SSH host key changed; authentication was not attempted"
                } else {
                    "SSH handshake failed"
                }
            })?;
        auth::authenticate(
            &mut session,
            &pending.request,
            &credential,
            cancel,
            prompter,
        )
        .await
        .map_err(AuthFailure::message)?;
        let mut channel = session
            .channel_open_session()
            .await
            .map_err(|_| "SSH channel open failed")?;
        channel
            .request_pty(true, "xterm-256color", cols.into(), rows.into(), 0, 0, &[])
            .await
            .map_err(|_| "SSH PTY request failed")?;
        let mut initial = Vec::new();
        reply(&mut channel, &mut initial).await?;
        channel
            .request_shell(true)
            .await
            .map_err(|_| "SSH shell request failed")?;
        reply(&mut channel, &mut initial).await?;
        Ok(Connection {
            _socket: socket,
            _session: session,
            channel,
            initial,
            rekey_rejected: rekey_rejected.clone(),
        })
    }
    .await;
    if rekey_rejected.load(std::sync::atomic::Ordering::SeqCst) {
        return Err(REKEY_ERROR.into());
    }
    result
}

async fn reply(
    channel: &mut russh::Channel<client::Msg>,
    initial: &mut Vec<ChannelMsg>,
) -> Result<(), String> {
    let mut bytes: usize = initial
        .iter()
        .map(|m| match m {
            ChannelMsg::Data { data } | ChannelMsg::ExtendedData { data, .. } => data.len(),
            _ => 0,
        })
        .sum();
    loop {
        match channel.wait().await {
            Some(ChannelMsg::Success) => return Ok(()),
            Some(ChannelMsg::WindowAdjusted { .. }) => {}
            Some(message @ ChannelMsg::Data { .. })
            | Some(message @ ChannelMsg::ExtendedData { ext: 1, .. }) => {
                let length = match &message {
                    ChannelMsg::Data { data } | ChannelMsg::ExtendedData { data, .. } => data.len(),
                    _ => unreachable!(),
                };
                bytes += length;
                if length > CHUNK || bytes > BUDGET || initial.len() >= BLOCKS {
                    return Err("SSH output before shell confirmation exceeds limit".into());
                }
                initial.push(message);
            }
            _ => return Err("SSH PTY or shell request rejected".into()),
        }
    }
}
async fn run(
    id: &str,
    connection: Connection,
    terminal: Arc<Terminal>,
    mut input: mpsc::Receiver<Control>,
    mut cancel: watch::Receiver<bool>,
    sink: &EventSink,
) -> Result<Option<u32>, String> {
    let Connection {
        _socket,
        _session,
        channel,
        initial,
        rekey_rejected,
    } = connection;
    let (mut read, write) = channel.split();
    let mut output_cancel = cancel.clone();
    // Keep draining russh's channel so its shared transport loop can service
    // input. This bounded bridge fails closed on overload instead of silently
    // discarding bytes or indefinitely blocking the protocol worker.
    let (bridge, mut messages) = mpsc::channel(64);
    let reader = async {
        for message in initial {
            bridge
                .try_send(message)
                .map_err(|_| "SSH initial output queue exhausted")?;
            tokio::task::yield_now().await;
        }
        while let Some(message) = read.wait().await {
            match &message {
                ChannelMsg::Data { data } | ChannelMsg::ExtendedData { data, .. }
                    if data.len() > CHUNK =>
                {
                    return Err("SSH peer exceeded the negotiated packet limit".into())
                }
                _ => {}
            }
            bridge
                .try_send(message)
                .map_err(|_| "SSH output consumer is too slow; bounded receive queue exhausted")?;
            tokio::task::yield_now().await;
        }
        drop(bridge);
        std::future::pending::<Result<Option<u32>, String>>().await
    };
    let output = async {
        let mut exit = None;
        loop {
            let deadline = terminal
                .flow
                .lock()
                .map_err(|_| "SSH flow unavailable")?
                .deadline();
            let timeout = async {
                match deadline {
                    Some(at) => tokio::time::sleep_until(at).await,
                    None => std::future::pending().await,
                }
            };
            let message = tokio::select! {
                biased;
                _ = output_cancel.changed() => return Ok(None),
                _ = timeout => {
                    if terminal.flow.lock().map_err(|_| "SSH flow unavailable")?.deadline().is_some_and(|at| at <= tokio::time::Instant::now()) {
                        return Err("SSH output acknowledgement timed out".into());
                    }
                    continue;
                },
                _ = terminal.changed.notified() => continue,
                message = messages.recv() => message,
            };
            match message {
                Some(ChannelMsg::Data { data })
                | Some(ChannelMsg::ExtendedData { data, ext: 1 }) => {
                    for chunk in data.chunks(CHUNK) {
                        loop {
                            let notified = terminal.changed.notified();
                            let (sequence, deadline) = {
                                let mut flow =
                                    terminal.flow.lock().map_err(|_| "SSH flow unavailable")?;
                                (flow.reserve(chunk.len()), flow.deadline())
                            };
                            if let Some(sequence) = sequence {
                                sink(PtyEvent::Data {
                                    id: id.into(),
                                    sequence,
                                    data: chunk.to_vec(),
                                })
                                .map_err(|_| "SSH event delivery failed")?;
                                break;
                            }
                            tokio::select! {
                                biased;
                                _ = output_cancel.changed() => return Ok(None),
                                _ = tokio::time::sleep_until(deadline.ok_or("SSH flow unavailable")?) => {
                                    if terminal.flow.lock().map_err(|_| "SSH flow unavailable")?.deadline().is_some_and(|at| at <= tokio::time::Instant::now()) {
                                        return Err("SSH output acknowledgement timed out".into());
                                    }
                                },
                                _ = notified => {}
                            }
                        }
                    }
                }
                Some(ChannelMsg::ExitStatus { exit_status }) => exit = Some(exit_status),
                Some(ChannelMsg::Close) | None => return Ok(exit),
                Some(ChannelMsg::ExitSignal { .. }) => {
                    return Err("SSH process terminated by signal".into())
                }
                Some(ChannelMsg::Failure) | Some(ChannelMsg::ExtendedData { .. }) => {
                    return Err("SSH channel request failed".into())
                }
                _ => {}
            }
        }
    };
    let controls = async {
        while let Some(control) = input.recv().await {
            let action = async {
                match control {
                    Control::Input(data) => write.data(data.as_slice()).await,
                    Control::Resize(cols, rows) => {
                        write.window_change(cols.into(), rows.into(), 0, 0).await
                    }
                }
            };
            tokio::time::timeout(DEADLINE, action)
                .await
                .map_err(|_| "SSH input timed out")?
                .map_err(|_| "SSH input failed")?;
        }
        Ok(None)
    };
    let result = tokio::select! {
        biased;
        _ = cancel.changed() => Ok(None),
        result = output => result,
        result = controls => result,
        result = reader => result,
    };
    if rekey_rejected.load(std::sync::atomic::Ordering::SeqCst) {
        return Err(REKEY_ERROR.into());
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn flow_is_bounded_ordered_and_duplicates_are_idempotent() {
        let mut flow = Flow::default();
        for n in 1..=16 {
            assert_eq!(flow.reserve(CHUNK), Some(n));
        }
        assert_eq!(flow.bytes, BUDGET);
        assert_eq!(flow.reserve(1), None);
        assert!(flow.ack(2).is_err());
        assert!(flow.ack(0).is_err());
        flow.ack(1).unwrap();
        flow.ack(1).unwrap();
        assert_eq!(flow.bytes, BUDGET - CHUNK);
        assert_eq!(flow.reserve(CHUNK), Some(17));
        let mut flow = Flow::default();
        for _ in 0..BLOCKS {
            assert!(flow.reserve(1).is_some());
        }
        assert_eq!(flow.reserve(1), None);
        assert!(flow.deadline().is_some());
    }
    #[test]
    fn invalid_dimensions_are_rejected() {
        assert!(size(0, 24).is_err());
        assert!(size(80, 1001).is_err());
        assert!(size(80, 24).is_ok());
    }

    /// Collects terminal events in order and acknowledges every data chunk,
    /// as the xterm front end does.
    struct Screen {
        events: tokio::sync::mpsc::UnboundedReceiver<PtyEvent>,
        output: Vec<u8>,
        exit: Option<Option<u32>>,
    }

    impl Screen {
        async fn until(&mut self, service: &Ssh, id: &str, marker: &str) {
            let wanted = |screen: &Self| String::from_utf8_lossy(&screen.output).contains(marker);
            let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
            while !wanted(self) {
                let event = tokio::time::timeout_at(deadline, self.events.recv())
                    .await
                    .unwrap_or_else(|_| {
                        panic!(
                            "missing {marker:?}; tail: {:?}",
                            String::from_utf8_lossy(
                                &self.output[self.output.len().saturating_sub(600)..]
                            )
                        )
                    })
                    .expect("terminal event stream ended");
                match event {
                    PtyEvent::Data { sequence, data, .. } => {
                        self.output.extend_from_slice(&data);
                        service.ack("main", id, sequence).unwrap();
                    }
                    PtyEvent::Exit { code, .. } => self.exit = Some(code),
                    PtyEvent::Error { message, .. } => panic!("terminal error: {message}"),
                }
            }
        }

        async fn exit_code(&mut self, service: &Ssh, id: &str) -> Option<u32> {
            let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
            while self.exit.is_none() {
                match tokio::time::timeout_at(deadline, self.events.recv())
                    .await
                    .expect("exit deadline exceeded")
                    .expect("terminal event stream ended")
                {
                    PtyEvent::Data { sequence, data, .. } => {
                        self.output.extend_from_slice(&data);
                        let _ = service.ack("main", id, sequence);
                    }
                    PtyEvent::Exit { code, .. } => self.exit = Some(code),
                    PtyEvent::Error { message, .. } => panic!("terminal error: {message}"),
                }
            }
            self.exit.unwrap()
        }
    }

    /// Real system OpenSSH sshd with a PTY and an interactive OS shell wrapper.
    /// Markers are server output only; none appears in the typed commands.
    #[tokio::test(flavor = "multi_thread")]
    #[ignore = "requires the OpenSSH PTY fixture; run tests/fixtures/ssh-terminal/rust-client.test.mjs"]
    async fn real_openssh_interactive_shell() {
        let env = |name: &str| std::env::var(name).unwrap();
        let id = || uuid::Uuid::new_v4().to_string();
        // The saved store is handed back to the runner, which checks that
        // system OpenSSH accepts it under StrictHostKeyChecking.
        let store = std::path::PathBuf::from(env("P0_SSH_TRUST_STORE"));
        let service = Arc::new(Ssh::with_known_hosts(store));
        let scope = service.context("main").unwrap();
        let request = || Request {
            host: env("P0_SSH_FIXTURE_HOST"),
            port: env("P0_SSH_FIXTURE_PORT").parse().unwrap(),
            username: env("P0_SSH_FIXTURE_USER"),
            private_key_path: env("P0_SSH_FIXTURE_KEY"),
        };
        let challenge = service
            .probe("main", &id(), request(), &scope)
            .await
            .unwrap();
        assert_eq!(challenge.fingerprint, env("P0_SSH_FIXTURE_FINGERPRINT"));
        assert_eq!(challenge.trust, Trust::New);
        service
            .trust_save("main", &challenge.challenge_token)
            .unwrap();
        let (sender, events) = tokio::sync::mpsc::unbounded_channel();
        let sink: EventSink = Arc::new(move |event| sender.send(event).map_err(|e| e.to_string()));
        let terminal = service
            .open(
                "main",
                &id(),
                &challenge.challenge_token,
                &scope,
                100,
                30,
                sink,
            )
            .await
            .unwrap();
        let mut screen = Screen {
            events,
            output: Vec::new(),
            exit: None,
        };
        let write = |text: &str| {
            service
                .write("main", &terminal, text.as_bytes().to_vec())
                .unwrap()
        };

        screen
            .until(&service, &terminal, "P0_INTERACTIVE_READY")
            .await;
        write("printf\r");
        screen
            .until(&service, &terminal, "P0_SSH_TERM_OK 中文 🌏")
            .await;

        // The wrapper starts with `stty rows 24 cols 80`; only a window-change
        // that reached the remote PTY can make it report 40 rows, 120 columns.
        service.resize("main", &terminal, 120, 40).unwrap();
        write("stty size\r");
        screen.until(&service, &terminal, "40 120").await;

        write("generate\r");
        screen
            .until(&service, &terminal, "P0_GENERATOR_BEGIN")
            .await;
        tokio::time::sleep(Duration::from_millis(35)).await;
        write("\x03");
        screen
            .until(&service, &terminal, "P0_SSH_INTERRUPTED")
            .await;
        let text = String::from_utf8_lossy(&screen.output).into_owned();
        let generated = text
            .split("P0_GENERATOR_BEGIN")
            .nth(1)
            .and_then(|tail| tail.split("P0_SSH_INTERRUPTED").next())
            .map_or(0, str::len);
        assert!(generated > 0 && generated < 2 * 1024 * 1024, "{generated}");

        write("exit\r");
        assert_eq!(screen.exit_code(&service, &terminal).await, Some(7));
        let again = service
            .probe("main", &id(), request(), &scope)
            .await
            .unwrap();
        assert_eq!(again.trust, Trust::Known);
        service.reject("main", &again.challenge_token).unwrap();
        let registry = service.registry.lock().unwrap();
        assert!(registry.terminals.is_empty() && registry.active.is_empty());
    }
}
