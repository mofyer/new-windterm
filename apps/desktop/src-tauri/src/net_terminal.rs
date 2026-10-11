//! Telnet (C02) and raw TCP (C03) terminal sessions over tokio TCP.
//!
//! Output uses the same acknowledged event stream as PTY and SSH terminals
//! (4096-byte blocks, 64 KiB / 64 unacknowledged blocks, 15 s ACK timeout).
//! When the budget is exhausted the socket is simply not read, so TCP pushes
//! back on the peer instead of this process buffering. Telnet negotiation is
//! handled by [`crate::telnet::Codec`]; raw TCP passes bytes unchanged.
//! Sessions belong to the window that opened them. No saved sessions,
//! proxies, TLS or encodings other than the terminal's UTF-8.
use crate::pty::{EventSink, PtyEvent};
use crate::telnet::Codec;
use serde::Deserialize;
use std::{
    collections::{HashMap, VecDeque},
    future::Future,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, MutexGuard,
    },
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
    sync::{mpsc, watch, Notify},
    time::Instant,
};

const CHUNK: usize = 4096;
const BUDGET: usize = 64 * 1024;
const BLOCKS: usize = 64;
const ACK_WAIT: Duration = Duration::from_secs(15);
const CONNECT_WAIT: Duration = Duration::from_secs(15);
const WRITE_WAIT: Duration = Duration::from_secs(15);
const MAX_SESSIONS: usize = 8;
const MAX_TOMBSTONES: usize = 128;
const INPUT_QUEUE: usize = 16;
const OUTGOING_QUEUE: usize = 16;
const TERMINAL_TYPE: &str = "xterm-256color";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Telnet,
    Raw,
}

impl Kind {
    fn label(self) -> &'static str {
        match self {
            Self::Telnet => "Telnet",
            Self::Raw => "TCP",
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Target {
    pub kind: Kind,
    pub host: String,
    pub port: u16,
}

#[derive(Default)]
struct Flow {
    sequence: u64,
    acknowledged: u64,
    bytes: usize,
    pending: VecDeque<(u64, usize, Instant)>,
}

impl Flow {
    /// Room for one more full block; a socket read never exceeds one block.
    fn has_room(&self) -> bool {
        self.bytes + CHUNK <= BUDGET && self.pending.len() < BLOCKS
    }

    fn reserve(&mut self, bytes: usize) -> Option<u64> {
        if bytes == 0 || bytes > CHUNK || !self.has_room() {
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
            return Err("Invalid terminal acknowledgement".into());
        }
        if sequence <= self.acknowledged {
            return Ok(());
        }
        if sequence != self.acknowledged + 1 {
            return Err("Out-of-order terminal acknowledgement".into());
        }
        let (_, bytes, _) = self
            .pending
            .pop_front()
            .ok_or("Missing terminal output block")?;
        self.bytes -= bytes;
        self.acknowledged = sequence;
        Ok(())
    }

    fn deadline(&self, wait: Duration) -> Option<Instant> {
        self.pending.front().map(|(_, _, at)| *at + wait)
    }

    fn expired(&self, wait: Duration) -> bool {
        self.deadline(wait).is_some_and(|at| at <= Instant::now())
    }
}

enum Control {
    Input(Vec<u8>),
    Resize(u16, u16),
}

struct Session {
    owner: String,
    kind: Kind,
    cancel: watch::Sender<bool>,
    input: mpsc::Sender<Control>,
    connected: AtomicBool,
    flow: Mutex<Flow>,
    changed: Notify,
}

#[derive(Default)]
struct Registry {
    sessions: HashMap<String, Arc<Session>>,
    /// Closes that arrived before their open; the open is then refused.
    closed_early: VecDeque<(String, String)>,
    /// Finished sessions: late ACK and close succeed, the ID is not reused.
    finished: VecDeque<(String, String)>,
    shutdown: bool,
}

impl Registry {
    fn remember(list: &mut VecDeque<(String, String)>, owner: &str, id: &str) {
        if list.len() == MAX_TOMBSTONES {
            list.pop_front();
        }
        list.push_back((owner.into(), id.into()));
    }

    fn finished(&self, owner: &str, id: &str) -> bool {
        self.finished.iter().any(|(o, i)| o == owner && i == id)
    }
}

/// Telnet and raw TCP terminals, managed as Tauri state.
pub struct NetTerminals {
    registry: Mutex<Registry>,
    connect_wait: Duration,
    ack_wait: Duration,
}

impl Default for NetTerminals {
    fn default() -> Self {
        Self {
            registry: Mutex::default(),
            connect_wait: CONNECT_WAIT,
            ack_wait: ACK_WAIT,
        }
    }
}

/// A freshly registered session and the receiving ends its task will own.
struct Registered {
    session: Arc<Session>,
    controls: mpsc::Receiver<Control>,
    cancel: watch::Receiver<bool>,
}

/// Removes a session that never reached the running state, including when
/// the opening future is dropped.
struct Opening<'a> {
    service: &'a NetTerminals,
    owner: &'a str,
    id: &'a str,
    handed_off: bool,
}

impl Drop for Opening<'_> {
    fn drop(&mut self) {
        if !self.handed_off {
            self.service.finish(self.owner, self.id);
        }
    }
}

impl NetTerminals {
    fn registry(&self) -> Result<MutexGuard<'_, Registry>, String> {
        self.registry
            .lock()
            .map_err(|_| "Network terminal state unavailable".into())
    }

    /// Connects and starts streaming. `id` is a client-generated UUID that is
    /// valid for `close` from the moment this call starts.
    pub async fn open(
        self: &Arc<Self>,
        owner: &str,
        id: &str,
        target: Target,
        cols: u16,
        rows: u16,
        sink: EventSink,
    ) -> Result<String, String> {
        validate(&target)?;
        let Target { kind, host, port } = target;
        let connect = async move { TcpStream::connect((host.as_str(), port)).await };
        self.open_via(owner, id, kind, cols, rows, sink, connect)
            .await
    }

    #[allow(clippy::too_many_arguments)]
    async fn open_via<F>(
        self: &Arc<Self>,
        owner: &str,
        id: &str,
        kind: Kind,
        cols: u16,
        rows: u16,
        sink: EventSink,
        connect: F,
    ) -> Result<String, String>
    where
        F: Future<Output = std::io::Result<TcpStream>> + Send,
    {
        size(cols, rows)?;
        let label = kind.label();
        let Registered {
            session,
            controls,
            mut cancel,
        } = self.register(owner, id, kind)?;
        let mut opening = Opening {
            service: self,
            owner,
            id,
            handed_off: false,
        };
        let stream = tokio::select! {
            biased;
            _ = cancel.changed() => return Err(format!("{label} connection cancelled")),
            result = tokio::time::timeout(self.connect_wait, connect) => result
                .map_err(|_| format!("{label} connection timed out"))?
                .map_err(|_| format!("{label} connection failed"))?,
        };
        // Cancellation is monotonic: a close after this check is seen by `run`.
        if *cancel.borrow() {
            return Err(format!("{label} connection cancelled"));
        }
        let _ = stream.set_nodelay(true);
        session.connected.store(true, Ordering::SeqCst);
        opening.handed_off = true;
        let service = self.clone();
        let (owner, id) = (owner.to_string(), id.to_string());
        let ack_wait = self.ack_wait;
        tokio::spawn(async move {
            let link = Link {
                id: &id,
                kind,
                session: &session,
                sink: &sink,
                ack_wait,
            };
            let result = link.run(stream, controls, cancel, cols, rows).await;
            service.finish(&owner, &id);
            let _ = sink(match result {
                Ok(()) => PtyEvent::Exit {
                    id: id.clone(),
                    code: None,
                },
                Err(message) => PtyEvent::Error {
                    id: id.clone(),
                    message,
                },
            });
        });
        Ok(opening.id.to_string())
    }

    fn register(&self, owner: &str, id: &str, kind: Kind) -> Result<Registered, String> {
        uuid::Uuid::parse_str(id).map_err(|_| "Invalid terminal ID")?;
        let mut registry = self.registry()?;
        if registry.shutdown {
            return Err("Network terminals are shutting down".into());
        }
        if registry.sessions.contains_key(id) || registry.finished(owner, id) {
            return Err("Terminal ID already used".into());
        }
        if let Some(index) = registry
            .closed_early
            .iter()
            .position(|(o, i)| o == owner && i == id)
        {
            registry.closed_early.remove(index);
            Registry::remember(&mut registry.finished, owner, id);
            return Err(format!("{} connection cancelled", kind.label()));
        }
        if registry.sessions.len() >= MAX_SESSIONS {
            return Err("P0 allows at most 8 live Telnet/TCP sessions".into());
        }
        let (cancel, cancelled) = watch::channel(false);
        let (input, controls) = mpsc::channel(INPUT_QUEUE);
        let session = Arc::new(Session {
            owner: owner.into(),
            kind,
            cancel,
            input,
            connected: AtomicBool::new(false),
            flow: Mutex::default(),
            changed: Notify::new(),
        });
        registry.sessions.insert(id.into(), session.clone());
        Ok(Registered {
            session,
            controls,
            cancel: cancelled,
        })
    }

    fn finish(&self, owner: &str, id: &str) {
        let mut registry = self.registry.lock().unwrap_or_else(|e| e.into_inner());
        if registry
            .sessions
            .get(id)
            .is_some_and(|session| session.owner == owner)
        {
            registry.sessions.remove(id);
        }
        Registry::remember(&mut registry.finished, owner, id);
    }

    fn session(&self, owner: &str, id: &str) -> Result<Arc<Session>, String> {
        let registry = self.registry()?;
        let session = registry
            .sessions
            .get(id)
            .ok_or("Network terminal is closed")?;
        if session.owner != owner {
            return Err("Network terminal not owned by this window".into());
        }
        Ok(session.clone())
    }

    fn connected(&self, owner: &str, id: &str) -> Result<Arc<Session>, String> {
        let session = self.session(owner, id)?;
        if !session.connected.load(Ordering::SeqCst) {
            return Err("Network terminal is not connected yet".into());
        }
        Ok(session)
    }

    /// Waits for queue space, so a slow peer pushes back on the front end's
    /// bounded input queue instead of failing a large paste.
    pub async fn write(&self, owner: &str, id: &str, data: Vec<u8>) -> Result<(), String> {
        if data.is_empty() || data.len() > CHUNK {
            return Err("Terminal input must contain 1 to 4096 bytes".into());
        }
        let session = self.connected(owner, id)?;
        tokio::time::timeout(WRITE_WAIT, session.input.send(Control::Input(data)))
            .await
            .map_err(|_| "Terminal input timed out")?
            .map_err(|_| "Network terminal is closed".into())
    }

    pub fn resize(&self, owner: &str, id: &str, cols: u16, rows: u16) -> Result<(), String> {
        size(cols, rows)?;
        let session = self.connected(owner, id)?;
        if session.kind == Kind::Raw {
            return Ok(()); // Raw TCP has no way to report a window size.
        }
        session
            .input
            .try_send(Control::Resize(cols, rows))
            .map_err(|_| "Terminal input queue unavailable".into())
    }

    pub fn ack(&self, owner: &str, id: &str, sequence: u64) -> Result<(), String> {
        let session = match self.session(owner, id) {
            Ok(session) => session,
            Err(_) if self.registry()?.finished(owner, id) => return Ok(()),
            Err(error) => return Err(error),
        };
        session
            .flow
            .lock()
            .map_err(|_| "Terminal flow unavailable")?
            .ack(sequence)?;
        session.changed.notify_waiters();
        Ok(())
    }

    /// Closes a connected session or cancels one that is still connecting.
    /// A close that arrives before its open makes that open fail.
    pub fn close(&self, owner: &str, id: &str) -> Result<(), String> {
        uuid::Uuid::parse_str(id).map_err(|_| "Invalid terminal ID")?;
        let mut registry = self.registry()?;
        if let Some(session) = registry.sessions.get(id) {
            if session.owner != owner {
                return Err("Network terminal not owned by this window".into());
            }
            session.cancel.send_replace(true);
            return Ok(());
        }
        if !registry.finished(owner, id) {
            Registry::remember(&mut registry.closed_early, owner, id);
        }
        Ok(())
    }

    /// Page reload or window destruction: closes every session of the window.
    pub fn close_owner(&self, owner: &str) {
        let registry = self.registry.lock().unwrap_or_else(|e| e.into_inner());
        for session in registry.sessions.values().filter(|s| s.owner == owner) {
            session.cancel.send_replace(true);
        }
    }

    pub fn shutdown(&self) {
        let mut registry = self.registry.lock().unwrap_or_else(|e| e.into_inner());
        registry.shutdown = true;
        for session in registry.sessions.values() {
            session.cancel.send_replace(true);
        }
    }
}

fn validate(target: &Target) -> Result<(), String> {
    if target.host.is_empty()
        || target.host.len() > 253
        || !target
            .host
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || ".-:".contains(c))
        || target.port == 0
    {
        return Err(format!("Invalid {} host or port", target.kind.label()));
    }
    Ok(())
}

fn size(cols: u16, rows: u16) -> Result<(), String> {
    if cols == 0 || rows == 0 || cols > 1000 || rows > 1000 {
        return Err("Invalid terminal size".into());
    }
    Ok(())
}

/// One running connection.
struct Link<'a> {
    id: &'a str,
    kind: Kind,
    session: &'a Session,
    sink: &'a EventSink,
    ack_wait: Duration,
}

impl Link<'_> {
    /// Returns `Ok` for a local close or a remote close, `Err` for failures.
    async fn run(
        &self,
        stream: TcpStream,
        mut controls: mpsc::Receiver<Control>,
        mut cancel: watch::Receiver<bool>,
        cols: u16,
        rows: u16,
    ) -> Result<(), String> {
        let label = self.kind.label();
        let codec =
            (self.kind == Kind::Telnet).then(|| Mutex::new(Codec::new(TERMINAL_TYPE, cols, rows)));
        let (mut reader, mut writer) = stream.into_split();
        // Negotiation replies and input share one ordered, bounded queue.
        let (outgoing, mut queued) = mpsc::channel::<Vec<u8>>(OUTGOING_QUEUE);
        let output = self.output(&mut reader, codec.as_ref(), &outgoing);
        let input = async {
            while let Some(control) = controls.recv().await {
                let bytes = match (control, codec.as_ref()) {
                    (Control::Input(data), Some(codec)) => lock(codec)?.send(&data),
                    (Control::Input(data), None) => data,
                    (Control::Resize(cols, rows), Some(codec)) => lock(codec)?.resize(cols, rows),
                    (Control::Resize(..), None) => Vec::new(),
                };
                if !bytes.is_empty() {
                    outgoing
                        .send(bytes)
                        .await
                        .map_err(|_| format!("{label} connection lost"))?;
                }
            }
            std::future::pending::<Result<(), String>>().await
        };
        let send = async {
            while let Some(bytes) = queued.recv().await {
                tokio::time::timeout(WRITE_WAIT, writer.write_all(&bytes))
                    .await
                    .map_err(|_| format!("{label} input timed out"))?
                    .map_err(|_| format!("{label} connection lost"))?;
            }
            std::future::pending::<Result<(), String>>().await
        };
        let result = tokio::select! {
            biased;
            _ = cancel.changed() => Ok(()),
            result = output => result,
            result = input => result,
            result = send => result,
        };
        // Dropping the write half sends FIN at once (also on a local close);
        // the socket is released when the read half drops on return.
        drop(writer);
        result
    }

    async fn output(
        &self,
        reader: &mut tokio::net::tcp::OwnedReadHalf,
        codec: Option<&Mutex<Codec>>,
        outgoing: &mpsc::Sender<Vec<u8>>,
    ) -> Result<(), String> {
        let label = self.kind.label();
        let mut buffer = vec![0; CHUNK];
        loop {
            // Created before checking so an ACK in between is not missed.
            let notified = self.session.changed.notified();
            let (room, deadline) = {
                let flow = lock(&self.session.flow)?;
                (flow.has_room(), flow.deadline(self.ack_wait))
            };
            let expiry = async {
                match deadline {
                    Some(at) => tokio::time::sleep_until(at).await,
                    None => std::future::pending().await,
                }
            };
            // Without room the socket is not read: TCP applies backpressure.
            let read = tokio::select! {
                biased;
                _ = expiry => {
                    if lock(&self.session.flow)?.expired(self.ack_wait) {
                        return Err(format!("{label} output acknowledgement timed out"));
                    }
                    continue;
                }
                _ = notified, if !room => continue,
                read = reader.read(&mut buffer), if room => read,
            };
            let count = read.map_err(|_| format!("{label} connection lost"))?;
            if count == 0 {
                return Ok(()); // The remote side closed the connection.
            }
            let (data, reply) = match codec {
                Some(codec) => {
                    let received = lock(codec)?.receive(&buffer[..count]);
                    (received.data, received.reply)
                }
                None => (buffer[..count].to_vec(), Vec::new()),
            };
            if !reply.is_empty() {
                outgoing
                    .send(reply)
                    .await
                    .map_err(|_| format!("{label} connection lost"))?;
            }
            if data.is_empty() {
                continue;
            }
            let sequence = lock(&self.session.flow)?
                .reserve(data.len())
                .ok_or("Terminal flow unavailable")?;
            (self.sink)(PtyEvent::Data {
                id: self.id.into(),
                sequence,
                data,
            })
            .map_err(|_| format!("{label} event delivery failed"))?;
        }
    }
}

fn lock<T>(mutex: &Mutex<T>) -> Result<MutexGuard<'_, T>, String> {
    mutex
        .lock()
        .map_err(|_| "Network terminal state unavailable".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn id() -> String {
        uuid::Uuid::new_v4().to_string()
    }

    fn events() -> (EventSink, mpsc::UnboundedReceiver<PtyEvent>) {
        let (sender, receiver) = mpsc::unbounded_channel();
        let sink: EventSink = Arc::new(move |event| sender.send(event).map_err(|e| e.to_string()));
        (sink, receiver)
    }

    fn service(connect_wait: Duration, ack_wait: Duration) -> Arc<NetTerminals> {
        Arc::new(NetTerminals {
            registry: Mutex::default(),
            connect_wait,
            ack_wait,
        })
    }

    fn live(service: &NetTerminals) -> usize {
        service.registry.lock().unwrap().sessions.len()
    }

    async fn never() -> std::io::Result<TcpStream> {
        std::future::pending().await
    }

    #[test]
    fn flow_is_bounded_ordered_and_duplicates_are_idempotent() {
        let mut flow = Flow::default();
        for n in 1..=16 {
            assert!(flow.has_room());
            assert_eq!(flow.reserve(CHUNK), Some(n));
        }
        assert_eq!(flow.bytes, BUDGET);
        assert!(!flow.has_room());
        assert_eq!(flow.reserve(1), None);
        assert!(flow.ack(2).is_err());
        assert!(flow.ack(0).is_err());
        assert!(flow.ack(17).is_err());
        flow.ack(1).unwrap();
        flow.ack(1).unwrap();
        assert_eq!(flow.bytes, BUDGET - CHUNK);
        assert_eq!(flow.reserve(CHUNK), Some(17));
        let mut flow = Flow::default();
        for _ in 0..BLOCKS {
            assert!(flow.reserve(1).is_some());
        }
        assert!(!flow.has_room());
        assert!(flow.deadline(ACK_WAIT).is_some());
        assert!(!flow.expired(ACK_WAIT));
        assert!(flow.expired(Duration::ZERO));
    }

    #[test]
    fn targets_ids_and_sizes_are_validated() {
        let target = |host: &str, port| Target {
            kind: Kind::Telnet,
            host: host.into(),
            port,
        };
        assert!(validate(&target("127.0.0.1", 23)).is_ok());
        assert!(validate(&target("::1", 23)).is_ok());
        assert!(validate(&target("router-1.example", 2323)).is_ok());
        for host in ["", "a b", "host;rm", "-oProxyCommand=x", &"a".repeat(254)] {
            assert!(validate(&target(host, 23)).is_err(), "{host}");
        }
        assert!(validate(&target("127.0.0.1", 0)).is_err());
        assert!(size(0, 24).is_err() && size(80, 1001).is_err() && size(80, 24).is_ok());
        let kind = |name: &str| {
            use serde::de::{value::Error, IntoDeserializer};
            Kind::deserialize(IntoDeserializer::<Error>::into_deserializer(name))
        };
        assert_eq!(kind("telnet").unwrap(), Kind::Telnet);
        assert_eq!(kind("raw").unwrap(), Kind::Raw);
        assert!(kind("ssh").is_err() && kind("Raw").is_err());
    }

    #[tokio::test]
    async fn close_during_connect_cancels_and_releases_the_slot() {
        let service = service(CONNECT_WAIT, ACK_WAIT);
        let session = id();
        let (sink, _events) = events();
        let task = {
            let (service, session) = (service.clone(), session.clone());
            tokio::spawn(async move {
                service
                    .open_via("main", &session, Kind::Telnet, 80, 24, sink, never())
                    .await
            })
        };
        while live(&service) == 0 {
            tokio::task::yield_now().await;
        }
        assert!(service
            .write("main", &session, b"x".to_vec())
            .await
            .is_err());
        assert!(service.close("other", &session).is_err());
        service.close("main", &session).unwrap();
        let error = tokio::time::timeout(Duration::from_secs(2), task)
            .await
            .unwrap()
            .unwrap()
            .unwrap_err();
        assert_eq!(error, "Telnet connection cancelled");
        assert_eq!(live(&service), 0);
        // Late close and ACK from the front end are harmless; the ID is spent.
        service.close("main", &session).unwrap();
        service.ack("main", &session, 1).unwrap();
        let (sink, _events) = events();
        assert!(service
            .open_via("main", &session, Kind::Raw, 80, 24, sink, never())
            .await
            .unwrap_err()
            .contains("already used"));
    }

    #[tokio::test]
    async fn reload_during_connect_and_close_before_open_refuse_the_open() {
        let service = service(CONNECT_WAIT, ACK_WAIT);
        let (sink, _events) = events();
        let task = {
            let (service, sink) = (service.clone(), sink.clone());
            tokio::spawn(async move {
                service
                    .open_via("main", &id(), Kind::Raw, 80, 24, sink, never())
                    .await
            })
        };
        while live(&service) == 0 {
            tokio::task::yield_now().await;
        }
        service.close_owner("other");
        assert_eq!(live(&service), 1);
        service.close_owner("main");
        assert_eq!(task.await.unwrap().unwrap_err(), "TCP connection cancelled");
        let early = id();
        service.close("main", &early).unwrap();
        assert!(service
            .open_via("main", &early, Kind::Raw, 80, 24, sink.clone(), never())
            .await
            .unwrap_err()
            .contains("cancelled"));
        assert!(service
            .open_via(
                "main",
                "not-a-uuid",
                Kind::Raw,
                80,
                24,
                sink.clone(),
                never()
            )
            .await
            .is_err());
        service.shutdown();
        assert!(service
            .open_via("main", &id(), Kind::Raw, 80, 24, sink, never())
            .await
            .unwrap_err()
            .contains("shutting down"));
        assert_eq!(live(&service), 0);
    }

    #[tokio::test]
    async fn connect_timeout_fails_closed() {
        let service = service(Duration::from_millis(100), ACK_WAIT);
        let (sink, _events) = events();
        let started = std::time::Instant::now();
        let error = service
            .open_via("main", &id(), Kind::Telnet, 80, 24, sink, never())
            .await
            .unwrap_err();
        assert_eq!(error, "Telnet connection timed out");
        assert!(started.elapsed() < Duration::from_secs(2));
        assert_eq!(live(&service), 0);
    }

    #[tokio::test]
    async fn withheld_ack_times_out_without_more_network_output() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            stream.write_all(b"one block").await.unwrap();
            let mut rest = Vec::new();
            // Returns when the client gives up and closes the socket.
            let _ = stream.read_to_end(&mut rest).await;
        });
        let service = service(CONNECT_WAIT, Duration::from_millis(300));
        let (sink, mut events) = events();
        let session = service
            .open(
                "main",
                &id(),
                Target {
                    kind: Kind::Raw,
                    host: "127.0.0.1".into(),
                    port,
                },
                80,
                24,
                sink,
            )
            .await
            .unwrap();
        assert!(matches!(
            events.recv().await.unwrap(),
            PtyEvent::Data { sequence: 1, .. }
        ));
        let event = tokio::time::timeout(Duration::from_secs(3), events.recv())
            .await
            .unwrap()
            .unwrap();
        assert!(
            matches!(&event, PtyEvent::Error { message, .. } if message == "TCP output acknowledgement timed out"),
            "{event:?}"
        );
        tokio::time::timeout(Duration::from_secs(2), server)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(live(&service), 0);
        service.ack("main", &session, 1).unwrap();
        assert!(service
            .write("main", &session, b"x".to_vec())
            .await
            .is_err());
    }
}
