//! P0 local PTY transport. No terminal decoding or remote/file APIs live here.
use crate::platform;
use portable_pty::{native_pty_system, MasterPty, PtySize};
use serde::Serialize;
use std::{
    collections::{HashMap, HashSet, VecDeque},
    io::{Read, Write},
    sync::{
        mpsc::{sync_channel, SyncSender},
        Arc, Condvar, Mutex,
    },
    thread,
    time::{Duration, Instant},
};

#[cfg(feature = "pty-diagnostics")]
use std::sync::atomic::{AtomicU64, Ordering};

/// Aggregate-only instrumentation, compiled out of normal application builds.
#[cfg(feature = "pty-diagnostics")]
#[derive(Default)]
struct Diagnostics {
    read_calls: AtomicU64,
    read_ns: AtomicU64,
    read_bytes: AtomicU64,
    read_sizes: [AtomicU64; 7],
    would_block: AtomicU64,
    byte_stalls: AtomicU64,
    chunk_stalls: AtomicU64,
    budget_sleeps: AtomicU64,
    budget_sleep_ns: AtomicU64,
    read_sleep_ns: AtomicU64,
    readiness_waits: AtomicU64,
    readiness_wait_ns: AtomicU64,
    capacity_waits: AtomicU64,
    capacity_wait_ns: AtomicU64,
    sink_ns: AtomicU64,
    flow_locks: AtomicU64,
    flow_lock_wait_ns: AtomicU64,
}

#[cfg(feature = "pty-diagnostics")]
fn elapsed_ns(start: Instant) -> u64 {
    start.elapsed().as_nanos().min(u64::MAX as u128) as u64
}

pub const CHUNK_BYTES: usize = 4096;
pub const OUTPUT_BUDGET: usize = 64 * 1024;
const MAX_IN_FLIGHT: usize = 64;
const ACK_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_SESSIONS: usize = 8;

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum PtyEvent {
    Data {
        id: String,
        sequence: u64,
        data: Vec<u8>,
    },
    Exit {
        id: String,
        code: Option<u32>,
    },
    Error {
        id: String,
        message: String,
    },
}

pub type EventSink = Arc<dyn Fn(PtyEvent) -> Result<(), String> + Send + Sync>;

#[derive(Default)]
struct Flow {
    sent: u64,
    acknowledged: u64,
    pending: VecDeque<(u64, usize, Instant)>,
    bytes: usize,
    peak: usize,
    closed: bool,
}

impl Flow {
    fn has_room(&self) -> bool {
        !self.closed
            && self.bytes + CHUNK_BYTES <= OUTPUT_BUDGET
            && self.pending.len() < MAX_IN_FLIGHT
    }

    fn reserve(&mut self, bytes: usize) -> Result<u64, String> {
        if bytes == 0 || bytes > CHUNK_BYTES || !self.has_room() {
            return Err("PTY output budget unavailable".into());
        }
        self.sent += 1;
        self.bytes += bytes;
        self.peak = self.peak.max(self.bytes);
        self.pending.push_back((self.sent, bytes, Instant::now()));
        Ok(self.sent)
    }

    fn ack(&mut self, sequence: u64) -> Result<(), String> {
        if sequence == 0 || sequence > self.sent {
            return Err("Invalid PTY acknowledgement".into());
        }
        if self.closed || sequence <= self.acknowledged {
            return Ok(());
        }
        if sequence != self.acknowledged + 1 {
            return Err("Out-of-order PTY acknowledgement".into());
        }
        let (_, bytes, _) = self.pending.pop_front().ok_or("Missing PTY output chunk")?;
        self.bytes -= bytes;
        self.acknowledged = sequence;
        Ok(())
    }

    fn timed_out(&self) -> bool {
        self.pending
            .front()
            .is_some_and(|(_, _, at)| at.elapsed() >= ACK_TIMEOUT)
    }

    fn close(&mut self) {
        self.closed = true;
        self.pending.clear();
        self.bytes = 0;
    }
}

pub struct Session {
    owner: String,
    #[cfg(feature = "pty-diagnostics")]
    diagnostics: Diagnostics,
    flow: Mutex<Flow>,
    #[cfg(feature = "pty-readiness")]
    capacity: Condvar,
    #[cfg(feature = "pty-readiness")]
    cancel_readiness: platform::CancelReadiness,
    #[cfg(windows)]
    tree: platform::windows::ProcessTree,
    master: Mutex<Option<Box<dyn MasterPty + Send>>>,
    input: SyncSender<Vec<u8>>,
    done: (Mutex<bool>, Condvar),
}

impl Session {
    fn flow_state(&self) -> std::sync::MutexGuard<'_, Flow> {
        #[cfg(feature = "pty-diagnostics")]
        let started = Instant::now();
        let locked = self.flow.lock();
        #[cfg(feature = "pty-diagnostics")]
        {
            self.diagnostics.flow_locks.fetch_add(1, Ordering::Relaxed);
            self.diagnostics
                .flow_lock_wait_ns
                .fetch_add(elapsed_ns(started), Ordering::Relaxed);
        }
        match locked {
            Ok(flow) => flow,
            Err(poisoned) => {
                // Do not continue producing from potentially inconsistent counters.
                // Recover only to cancel and permit the worker to release resources.
                let mut flow = poisoned.into_inner();
                flow.close();
                flow
            }
        }
    }

    /// Cumulative counters since session creation; read after reaping for a stable snapshot.
    #[cfg(feature = "pty-diagnostics")]
    pub fn diagnostics(&self) -> std::collections::BTreeMap<&'static str, u64> {
        let d = &self.diagnostics;
        let mut result = std::collections::BTreeMap::from([
            ("read_calls", d.read_calls.load(Ordering::Relaxed)),
            ("read_ns", d.read_ns.load(Ordering::Relaxed)),
            ("read_bytes", d.read_bytes.load(Ordering::Relaxed)),
            ("would_block", d.would_block.load(Ordering::Relaxed)),
            ("byte_stalls", d.byte_stalls.load(Ordering::Relaxed)),
            ("chunk_stalls", d.chunk_stalls.load(Ordering::Relaxed)),
            ("budget_sleeps", d.budget_sleeps.load(Ordering::Relaxed)),
            ("budget_sleep_ns", d.budget_sleep_ns.load(Ordering::Relaxed)),
            ("read_sleep_ns", d.read_sleep_ns.load(Ordering::Relaxed)),
            ("readiness_waits", d.readiness_waits.load(Ordering::Relaxed)),
            (
                "readiness_wait_ns",
                d.readiness_wait_ns.load(Ordering::Relaxed),
            ),
            ("capacity_waits", d.capacity_waits.load(Ordering::Relaxed)),
            (
                "capacity_wait_ns",
                d.capacity_wait_ns.load(Ordering::Relaxed),
            ),
            ("sink_ns", d.sink_ns.load(Ordering::Relaxed)),
            ("flow_locks", d.flow_locks.load(Ordering::Relaxed)),
            (
                "flow_lock_wait_ns",
                d.flow_lock_wait_ns.load(Ordering::Relaxed),
            ),
        ]);
        for (name, count) in [
            "read_1_64",
            "read_65_256",
            "read_257_512",
            "read_513_1024",
            "read_1025_2048",
            "read_2049_4095",
            "read_4096",
        ]
        .into_iter()
        .zip(&d.read_sizes)
        {
            result.insert(name, count.load(Ordering::Relaxed));
        }
        result
    }

    pub fn write(&self, data: Vec<u8>) -> Result<(), String> {
        if data.len() > CHUNK_BYTES {
            return Err("PTY input exceeds 4096 bytes; split the input into chunks".into());
        }
        if self.is_closed() {
            return Err("PTY session is closed".into());
        }
        if data.is_empty() {
            return Ok(());
        }
        self.input
            .try_send(data)
            .map_err(|_| "PTY input queue is full or closed; retry after drain".into())
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Result<(), String> {
        let size = checked_size(cols, rows)?;
        if self.is_closed() {
            return Err("PTY session is closed".into());
        }
        self.master
            .lock()
            .map_err(|_| "PTY descriptor state is poisoned")?
            .as_ref()
            .ok_or("PTY session is closed")?
            .resize(size)
            .map_err(|e| e.to_string())
    }

    pub fn ack(&self, sequence: u64) -> Result<(), String> {
        let result = self.flow_state().ack(sequence);
        #[cfg(feature = "pty-readiness")]
        self.capacity.notify_one();
        result
    }

    pub fn is_closed(&self) -> bool {
        self.flow_state().closed
    }

    pub fn peak_pending_bytes(&self) -> usize {
        self.flow_state().peak
    }

    /// Idempotent cancellation. The reader worker owns wait/reaping.
    pub fn close(&self) {
        self.flow_state().close();
        #[cfg(feature = "pty-readiness")]
        {
            self.capacity.notify_all();
            self.cancel_readiness.cancel();
        }
        // Releasing a Unix master wakes the nonblocking reader. On Windows the
        // blocking ConPTY reader returns only once the pseudoconsole is closed,
        // which the waiter does after the terminated shell has exited; closing
        // it here could block this caller while conhost flushes output.
        #[cfg(unix)]
        self.master
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take();
        #[cfg(windows)]
        self.tree.terminate();
    }

    /// Closes the pseudoconsole outside the master lock: conhost flushes the
    /// remaining output and closes its pipe end, so the reader observes EOF.
    #[cfg(windows)]
    fn release_console(&self) {
        let master = self
            .master
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take();
        drop(master);
    }

    /// Live processes left in the shell's job, for lifecycle verification.
    #[cfg(windows)]
    pub fn live_processes(&self) -> Result<u32, String> {
        self.tree.active_processes()
    }

    pub fn wait_closed(&self, timeout: Duration) -> bool {
        let (done, wake) = &self.done;
        *wake
            .wait_timeout_while(
                done.lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner),
                timeout,
                |done| !*done,
            )
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .0
    }
}

#[derive(Default)]
pub struct Sessions {
    registry: Mutex<Registry>,
}

#[derive(Default)]
struct Registry {
    sessions: HashMap<String, Arc<Session>>,
    closed_owners: HashSet<String>,
    generations: HashMap<String, u64>,
    stopping: bool,
}

impl Sessions {
    pub fn get(&self, owner: &str, id: &str) -> Result<Arc<Session>, String> {
        let registry = self
            .registry
            .lock()
            .map_err(|_| "PTY registry is poisoned")?;
        let session = registry.sessions.get(id).ok_or("Unknown PTY session")?;
        if session.owner != owner {
            return Err("PTY session belongs to another window".into());
        }
        Ok(session.clone())
    }

    pub fn close(&self, owner: &str, id: &str) -> Result<(), String> {
        let registry = self
            .registry
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(session) = registry.sessions.get(id) {
            if session.owner != owner {
                return Err("PTY session belongs to another window".into());
            }
            session.close();
        }
        Ok(())
    }

    pub fn close_owner(&self, owner: &str) {
        let mut registry = self
            .registry
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        registry.closed_owners.insert(owner.to_owned());
        for session in registry
            .sessions
            .values()
            .filter(|session| session.owner == owner)
        {
            session.close();
        }
    }

    pub fn shutdown(&self) {
        let sessions: Vec<_> = {
            let mut registry = self
                .registry
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            registry.stopping = true;
            registry.sessions.values().cloned().collect()
        };
        for session in &sessions {
            session.close();
        }
        for session in sessions {
            if !session.wait_closed(Duration::from_secs(2)) {
                eprintln!("PTY cleanup did not finish within the shutdown deadline");
            }
        }
    }

    pub fn open(
        &self,
        owner: &str,
        cols: u16,
        rows: u16,
        sink: EventSink,
    ) -> Result<String, String> {
        let generation = self.generation(owner)?;
        self.open_at_generation(owner, generation, cols, rows, sink)
    }

    pub fn generation(&self, owner: &str) -> Result<u64, String> {
        let registry = self
            .registry
            .lock()
            .map_err(|_| "PTY registry is poisoned")?;
        Ok(*registry.generations.get(owner).unwrap_or(&0))
    }

    /// A navigation invalidates queued opens from the previous document and closes
    /// even idle shells whose previous document had already acknowledged all data.
    pub fn reload_owner(&self, owner: &str) {
        let mut registry = self
            .registry
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        *registry.generations.entry(owner.to_owned()).or_default() += 1;
        for session in registry
            .sessions
            .values()
            .filter(|session| session.owner == owner)
        {
            session.close();
        }
    }

    pub fn open_at_generation(
        &self,
        owner: &str,
        generation: u64,
        cols: u16,
        rows: u16,
        sink: EventSink,
    ) -> Result<String, String> {
        let mut registry = self
            .registry
            .lock()
            .map_err(|_| "PTY registry is poisoned")?;
        if registry.stopping || registry.closed_owners.contains(owner) {
            return Err("PTY window or application is closing".into());
        }
        if *registry.generations.get(owner).unwrap_or(&0) != generation {
            return Err("PTY request belongs to an unloaded document".into());
        }
        let sessions = &mut registry.sessions;
        // Retain closing workers until reaped: repeated opens cannot bypass the bound.
        sessions.retain(|_, session| {
            !*session
                .done
                .0
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
        });
        if sessions.len() >= MAX_SESSIONS {
            return Err("P0 allows at most 8 live PTY sessions".into());
        }
        let size = checked_size(cols, rows)?;
        let id = uuid::Uuid::new_v4().to_string();
        let session = spawn_local_session(owner, size, &id, sink)?;
        sessions.insert(id.clone(), session);
        Ok(id)
    }
}

fn spawn_local_session(
    owner: &str,
    size: PtySize,
    id: &str,
    sink: EventSink,
) -> Result<Arc<Session>, String> {
    platform::ensure_supported()?;
    let command = platform::local_command()?;
    let pair = native_pty_system()
        .openpty(size)
        .map_err(|e| e.to_string())?;
    platform::configure_io(pair.master.as_ref())?;
    #[cfg(feature = "pty-readiness")]
    let (readiness, cancel_readiness) = platform::Readiness::new(pair.master.as_ref())?;
    let reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let child = pair
        .slave
        .spawn_command(command)
        .map_err(|e| e.to_string())?;
    #[cfg(windows)]
    let tree = match child
        .as_raw_handle()
        .ok_or_else(|| "Windows shell has no process handle".to_string())
        .and_then(platform::windows::ProcessTree::adopt)
    {
        Ok(tree) => tree,
        Err(error) => {
            // Without a job the tree cannot be bounded; refuse the session.
            let _ = child.clone_killer().kill();
            return Err(error);
        }
    };
    drop(pair.slave);
    let (input, receiver) = sync_channel::<Vec<u8>>(16);
    let session = Arc::new(Session {
        owner: owner.to_owned(),
        #[cfg(feature = "pty-diagnostics")]
        diagnostics: Diagnostics::default(),
        flow: Mutex::new(Flow::default()),
        #[cfg(feature = "pty-readiness")]
        capacity: Condvar::new(),
        #[cfg(feature = "pty-readiness")]
        cancel_readiness,
        #[cfg(windows)]
        tree,
        master: Mutex::new(Some(pair.master)),
        input,
        done: (Mutex::new(false), Condvar::new()),
    });
    launch_workers(
        session.clone(),
        id.to_owned(),
        sink,
        reader,
        #[cfg(feature = "pty-readiness")]
        readiness,
        writer,
        receiver,
        child,
    );
    Ok(session)
}

#[allow(clippy::too_many_arguments)]
fn launch_workers(
    session: Arc<Session>,
    id: String,
    sink: EventSink,
    mut reader: Box<dyn Read + Send>,
    #[cfg(feature = "pty-readiness")] readiness: platform::Readiness,
    writer: Box<dyn Write + Send>,
    receiver: std::sync::mpsc::Receiver<Vec<u8>>,
    #[cfg_attr(windows, allow(unused_mut))] mut child: Box<dyn portable_pty::Child + Send + Sync>,
) {
    let write_session = session.clone();
    let write_sink = sink.clone();
    let write_id = id.clone();
    let writer_worker =
        thread::spawn(move || writer_loop(write_session, writer, receiver, write_sink, write_id));
    let read_id = id;
    // Windows: a waiter owns the child. When the shell exits (naturally or via
    // job termination) it closes the pseudoconsole, which ends the blocking
    // reader with EOF after conhost flushes the remaining output.
    #[cfg(windows)]
    let waiter = {
        let session = session.clone();
        thread::spawn(move || {
            let status = child.wait();
            session.release_console();
            status
        })
    };
    thread::spawn(move || {
        if let Err(message) = reader_loop(
            &session,
            reader.as_mut(),
            &sink,
            &read_id,
            #[cfg(feature = "pty-readiness")]
            &readiness,
        ) {
            terminal_error(&sink, &read_id, message);
        }
        #[cfg(unix)]
        let status = cleanup_child(&session, child.as_mut(), &sink, &read_id);
        // Reader errors (ACK timeout, sink failure) end the tree too; after a
        // natural exit this only reaps detached children left in the job.
        #[cfg(windows)]
        {
            session.close();
            // Keep draining until conhost closes the pipe. Closing the
            // pseudoconsole waits for conhost to flush, and portable-pty keeps
            // its own read handle, so dropping ours could not unblock a writer
            // stuck on a full pipe.
            drain(reader.as_mut());
        }
        drop(reader);
        #[cfg(windows)]
        let status = match waiter.join() {
            Ok(Ok(status)) => Some(status),
            Ok(Err(error)) => {
                terminal_error(&sink, &read_id, format!("PTY reaping failed: {error}"));
                None
            }
            Err(_) => {
                terminal_error(&sink, &read_id, "PTY child waiter panicked".into());
                None
            }
        };
        #[cfg(all(feature = "pty-readiness", unix))]
        drop(readiness);
        let writer_reaped = writer_worker.join().is_ok();
        if !writer_reaped {
            terminal_error(
                &sink,
                &read_id,
                "PTY input worker panicked during cleanup".into(),
            );
        }
        let reaped = status.is_some() && writer_reaped;
        terminal_event(
            &sink,
            PtyEvent::Exit {
                id: read_id,
                code: status.map(|status| status.exit_code()),
            },
        );
        *session
            .done
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = reaped;
        session.done.1.notify_all();
    });
}

fn writer_loop(
    write_session: Arc<Session>,
    mut writer: Box<dyn Write + Send>,
    receiver: std::sync::mpsc::Receiver<Vec<u8>>,
    write_sink: EventSink,
    write_id: String,
) {
    while !write_session.is_closed() {
        let data = match receiver.recv_timeout(Duration::from_millis(25)) {
            Ok(data) => data,
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
            Err(_) => break,
        };
        let mut remaining = data.as_slice();
        let started = Instant::now();
        while !remaining.is_empty() && !write_session.is_closed() {
            match writer.write(remaining) {
                Ok(0) => {
                    write_session.close();
                    break;
                }
                Ok(n) => remaining = &remaining[n..],
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(error)
                    if error.kind() == std::io::ErrorKind::WouldBlock
                        && started.elapsed() < ACK_TIMEOUT =>
                {
                    thread::sleep(Duration::from_millis(5))
                }
                Err(_) => {
                    terminal_error(
                        &write_sink,
                        &write_id,
                        "PTY input write failed or timed out".into(),
                    );
                    write_session.close();
                    break;
                }
            }
        }
    }
}

fn reader_loop(
    session: &Session,
    reader: &mut dyn Read,
    sink: &EventSink,
    read_id: &str,
    #[cfg(feature = "pty-readiness")] readiness: &platform::Readiness,
) -> Result<(), String> {
    let mut buffer = [0; CHUNK_BYTES];
    loop {
        {
            let flow = session.flow_state();
            if flow.closed {
                return Ok(());
            }
            if flow.timed_out() {
                return Err("PTY output acknowledgement timed out (15 seconds)".into());
            }
            if !flow.has_room() {
                #[cfg(feature = "pty-diagnostics")]
                {
                    session.diagnostics.byte_stalls.fetch_add(
                        u64::from(flow.bytes + CHUNK_BYTES > OUTPUT_BUDGET),
                        Ordering::Relaxed,
                    );
                    session.diagnostics.chunk_stalls.fetch_add(
                        u64::from(flow.pending.len() >= MAX_IN_FLIGHT),
                        Ordering::Relaxed,
                    );
                    #[cfg(not(feature = "pty-readiness"))]
                    session
                        .diagnostics
                        .budget_sleeps
                        .fetch_add(1, Ordering::Relaxed);
                }
                #[cfg(feature = "pty-diagnostics")]
                let started = Instant::now();
                #[cfg(feature = "pty-readiness")]
                {
                    // Predicate is tested under the same mutex as ACK/close;
                    // no notification can be lost between test and sleep.
                    let timeout = flow.pending.front().map_or(ACK_TIMEOUT, |(_, _, at)| {
                        ACK_TIMEOUT.saturating_sub(at.elapsed())
                    });
                    drop(
                        session
                            .capacity
                            .wait_timeout_while(flow, timeout, |flow| {
                                !flow.closed && !flow.has_room() && !flow.timed_out()
                            })
                            .unwrap_or_else(std::sync::PoisonError::into_inner),
                    );
                    #[cfg(feature = "pty-diagnostics")]
                    {
                        session
                            .diagnostics
                            .capacity_waits
                            .fetch_add(1, Ordering::Relaxed);
                        session
                            .diagnostics
                            .capacity_wait_ns
                            .fetch_add(elapsed_ns(started), Ordering::Relaxed);
                    }
                }
                #[cfg(not(feature = "pty-readiness"))]
                {
                    drop(flow);
                    thread::sleep(Duration::from_millis(5));
                    #[cfg(feature = "pty-diagnostics")]
                    session
                        .diagnostics
                        .budget_sleep_ns
                        .fetch_add(elapsed_ns(started), Ordering::Relaxed);
                }
                continue;
            }
        }
        #[cfg(feature = "pty-diagnostics")]
        let started = Instant::now();
        let result = reader.read(&mut buffer);
        #[cfg(feature = "pty-diagnostics")]
        {
            session
                .diagnostics
                .read_calls
                .fetch_add(1, Ordering::Relaxed);
            session
                .diagnostics
                .read_ns
                .fetch_add(elapsed_ns(started), Ordering::Relaxed);
        }
        match result {
            Ok(0) => return Ok(()),
            Ok(n) => {
                #[cfg(feature = "pty-diagnostics")]
                {
                    let bucket = match n {
                        1..=64 => 0,
                        65..=256 => 1,
                        257..=512 => 2,
                        513..=1024 => 3,
                        1025..=2048 => 4,
                        2049..=4095 => 5,
                        _ => 6,
                    };
                    session.diagnostics.read_sizes[bucket].fetch_add(1, Ordering::Relaxed);
                    session
                        .diagnostics
                        .read_bytes
                        .fetch_add(n as u64, Ordering::Relaxed);
                }
                let sequence = {
                    let mut flow = session.flow_state();
                    if flow.closed {
                        return Ok(());
                    }
                    flow.reserve(n)?
                };
                #[cfg(feature = "pty-diagnostics")]
                let started = Instant::now();
                let result = sink(PtyEvent::Data {
                    id: read_id.to_owned(),
                    sequence,
                    data: buffer[..n].to_vec(),
                });
                #[cfg(feature = "pty-diagnostics")]
                session
                    .diagnostics
                    .sink_ns
                    .fetch_add(elapsed_ns(started), Ordering::Relaxed);
                result?;
            }
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                #[cfg(feature = "pty-diagnostics")]
                let started = Instant::now();
                #[cfg(feature = "pty-readiness")]
                {
                    let timeout = session.flow_state().pending.front().map_or(
                        Duration::from_millis(250),
                        |(_, _, at)| {
                            ACK_TIMEOUT
                                .saturating_sub(at.elapsed())
                                .min(Duration::from_millis(250))
                        },
                    );
                    readiness.wait(timeout)?;
                }
                #[cfg(not(feature = "pty-readiness"))]
                thread::sleep(Duration::from_millis(5));
                #[cfg(feature = "pty-diagnostics")]
                {
                    #[cfg(feature = "pty-readiness")]
                    {
                        session
                            .diagnostics
                            .readiness_waits
                            .fetch_add(1, Ordering::Relaxed);
                        session
                            .diagnostics
                            .readiness_wait_ns
                            .fetch_add(elapsed_ns(started), Ordering::Relaxed);
                    }
                    session
                        .diagnostics
                        .would_block
                        .fetch_add(1, Ordering::Relaxed);
                    #[cfg(not(feature = "pty-readiness"))]
                    session
                        .diagnostics
                        .read_sleep_ns
                        .fetch_add(elapsed_ns(started), Ordering::Relaxed);
                }
            }
            Err(error) if platform::is_pty_eof(&error) => return Ok(()),
            Err(_) => return Err("PTY output read failed".into()),
        }
    }
}

#[cfg(unix)]
fn cleanup_child(
    session: &Session,
    child: &mut dyn portable_pty::Child,
    sink: &EventSink,
    read_id: &str,
) -> Option<portable_pty::ExitStatus> {
    // Try reaping a natural exit first, avoiding a late signal to a recycled PID.
    match child.try_wait() {
        Ok(Some(status)) => {
            session.flow_state().close();
            session
                .master
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .take();
            Some(status)
        }
        _ => {
            session.close();
            if let Err(error) = child.kill() {
                terminal_error(sink, read_id, format!("PTY termination failed: {error}"));
            }
            match child.wait() {
                Ok(status) => Some(status),
                Err(error) => {
                    terminal_error(sink, read_id, format!("PTY reaping failed: {error}"));
                    None
                }
            }
        }
    }
}

#[cfg(windows)]
fn drain(reader: &mut dyn Read) {
    let mut discard = [0; CHUNK_BYTES];
    loop {
        match reader.read(&mut discard) {
            Ok(0) => return,
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
            Err(_) => return,
        }
    }
}

fn terminal_error(sink: &EventSink, id: &str, message: String) {
    terminal_event(
        sink,
        PtyEvent::Error {
            id: id.to_owned(),
            message,
        },
    );
}

fn terminal_event(sink: &EventSink, event: PtyEvent) {
    // The document may already be gone during teardown. Keep releasing native
    // resources and report only a fixed diagnostic, never terminal input/output.
    if sink(event).is_err() {
        eprintln!("PTY terminal lifecycle event could not be delivered");
    }
}

fn checked_size(cols: u16, rows: u16) -> Result<PtySize, String> {
    if !(2..=1000).contains(&cols) || !(2..=500).contains(&rows) {
        return Err("PTY size must be 2–1000 columns and 2–500 rows".into());
    }
    Ok(PtySize {
        cols,
        rows,
        pixel_width: 0,
        pixel_height: 0,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn destroyed_window_cannot_open_a_queued_session() {
        let sessions = Sessions::default();
        sessions.close_owner("main");
        assert!(sessions.open("main", 80, 24, Arc::new(|_| Ok(()))).is_err());
    }

    #[test]
    fn shutdown_cannot_open_a_queued_session() {
        let sessions = Sessions::default();
        sessions.shutdown();
        assert!(sessions.open("main", 80, 24, Arc::new(|_| Ok(()))).is_err());
    }

    #[test]
    fn navigation_rejects_requests_queued_by_previous_document() {
        let sessions = Sessions::default();
        let generation = sessions.generation("main").unwrap();
        sessions.reload_owner("main");
        assert!(sessions
            .open_at_generation("main", generation, 80, 24, Arc::new(|_| Ok(())))
            .is_err());
    }

    #[test]
    fn rejects_forged_and_out_of_order_ack_without_freeing_capacity() {
        let mut flow = Flow::default();
        flow.reserve(4096).unwrap();
        flow.reserve(32).unwrap();
        for sequence in [0, 2, 999] {
            assert!(flow.ack(sequence).is_err());
        }
        assert_eq!(flow.bytes, 4128);
        flow.ack(1).unwrap();
        flow.ack(1).unwrap();
        assert_eq!(flow.bytes, 32);
        flow.ack(2).unwrap();
        assert_eq!(flow.bytes, 0);
    }

    #[test]
    fn byte_budget_stops_producer_and_ack_reopens_it() {
        let mut flow = Flow::default();
        for _ in 0..16 {
            flow.reserve(CHUNK_BYTES).unwrap();
        }
        assert!(!flow.has_room());
        assert!(flow.reserve(1).is_err());
        assert_eq!(flow.peak, OUTPUT_BUDGET);
        flow.ack(1).unwrap();
        assert!(flow.has_room());
    }

    #[test]
    fn tiny_chunks_are_also_bounded_and_close_releases_budget() {
        let mut flow = Flow::default();
        for _ in 0..MAX_IN_FLIGHT {
            flow.reserve(1).unwrap();
        }
        assert!(!flow.has_room());
        flow.close();
        flow.close();
        assert_eq!(flow.bytes, 0);
        assert!(flow.pending.is_empty());
        assert!(!flow.has_room());
    }

    #[test]
    fn timeout_tracks_oldest_unacknowledged_chunk() {
        let mut flow = Flow::default();
        flow.reserve(8).unwrap();
        flow.pending.front_mut().unwrap().2 = Instant::now() - ACK_TIMEOUT;
        assert!(flow.timed_out());
        flow.ack(1).unwrap();
        assert!(!flow.timed_out());
    }

    #[test]
    fn terminal_dimensions_are_bounded() {
        assert!(checked_size(0, 24).is_err());
        assert!(checked_size(80, 501).is_err());
        assert!(checked_size(120, 40).is_ok());
    }
    #[cfg(all(
        feature = "pty-readiness",
        any(target_os = "macos", target_os = "linux")
    ))]
    #[test]
    fn capacity_wait_resumes_on_ack_and_cancels_while_full() {
        for acknowledge in [true, false] {
            let sessions = Sessions::default();
            let (sender, receiver) = std::sync::mpsc::channel();
            let id = sessions
                .open(
                    "readiness-test",
                    80,
                    24,
                    Arc::new(move |event| sender.send(event).map_err(|e| e.to_string())),
                )
                .unwrap();
            let session = sessions.get("readiness-test", &id).unwrap();
            session
                .write(b"head -c 131072 /dev/zero\n".to_vec())
                .unwrap();
            let started = Instant::now();
            while session.flow_state().has_room() && started.elapsed() < Duration::from_secs(3) {
                thread::sleep(Duration::from_millis(5));
            }
            assert!(
                !session.flow_state().has_room(),
                "fixture did not reach capacity"
            );
            let before = session.flow_state().sent;
            if acknowledge {
                while let Ok(event) = receiver.try_recv() {
                    if let PtyEvent::Data { sequence, .. } = event {
                        session.ack(sequence).unwrap();
                    }
                }
                let resumed = Instant::now();
                while session.flow_state().sent == before
                    && resumed.elapsed() < Duration::from_secs(1)
                {
                    thread::sleep(Duration::from_millis(2));
                }
                assert!(
                    session.flow_state().sent > before,
                    "ACK did not resume producer"
                );
            }
            session.close();
            assert!(
                session.wait_closed(Duration::from_secs(2)),
                "capacity cancellation did not reap"
            );
            sessions.shutdown();
        }
    }
}

/// Windows ConPTY lifecycle acceptance, run on the `windows-2022` CI runner.
/// Markers are typed as `P0_^NAME`; cmd drops the caret, so only command output
/// (not the echoed input line) contains `P0_NAME`. The shell environment is
/// cleared, so variables such as `%OS%` are deliberately unavailable.
#[cfg(all(test, windows))]
mod windows_tests {
    use super::*;
    use std::sync::mpsc::{channel, Receiver, RecvTimeoutError};

    const DEADLINE: Duration = Duration::from_secs(10);
    const LOOP: &str = "for /L %i in (1,1,200000) do @echo %i P0 bounded ConPTY output line\r\n";

    struct Probe {
        sessions: Sessions,
        session: Arc<Session>,
        events: Receiver<PtyEvent>,
        output: Vec<u8>,
        exit: Option<Option<u32>>,
        errors: Vec<String>,
    }

    impl Probe {
        fn open() -> Self {
            let sessions = Sessions::default();
            let (sender, events) = channel();
            let id = sessions
                .open(
                    "win",
                    100,
                    30,
                    Arc::new(move |event| sender.send(event).map_err(|e| e.to_string())),
                )
                .unwrap();
            let session = sessions.get("win", &id).unwrap();
            Self {
                sessions,
                session,
                events,
                output: Vec::new(),
                exit: None,
                errors: Vec::new(),
            }
        }

        /// Drains events in order, acknowledging data when `ack`, until `done`.
        fn pump(&mut self, limit: Duration, ack: bool, done: impl Fn(&Self) -> bool) -> bool {
            let started = Instant::now();
            loop {
                if done(self) {
                    return true;
                }
                let Some(left) = limit.checked_sub(started.elapsed()) else {
                    return false;
                };
                match self
                    .events
                    .recv_timeout(left.min(Duration::from_millis(100)))
                {
                    Ok(PtyEvent::Data { sequence, data, .. }) => {
                        self.output.extend_from_slice(&data);
                        if ack {
                            let _ = self.session.ack(sequence);
                        }
                    }
                    Ok(PtyEvent::Exit { code, .. }) => self.exit = Some(code),
                    Ok(PtyEvent::Error { message, .. }) => self.errors.push(message),
                    Err(RecvTimeoutError::Timeout) => {}
                    Err(RecvTimeoutError::Disconnected) => return done(self),
                }
            }
        }

        fn text(&self) -> String {
            String::from_utf8_lossy(&self.output).into_owned()
        }

        fn tail(&self) -> String {
            let text = self.text();
            let start = text
                .char_indices()
                .rev()
                .nth(800)
                .map_or(0, |(index, _)| index);
            text[start..].to_string()
        }

        fn send(&self, text: &str) {
            self.session.write(text.as_bytes().to_vec()).unwrap();
        }

        fn expect(&mut self, marker: &str) {
            let found = self.pump(DEADLINE, true, |probe| probe.text().contains(marker));
            assert!(found, "missing {marker:?}; output tail: {}", self.tail());
        }

        fn ready(&mut self) {
            // ConPTY (PSEUDOCONSOLE_INHERIT_CURSOR) asks for the cursor position
            // and waits for the reply before rendering; xterm.js answers this
            // in the app, so the probe answers as a terminal would.
            self.expect("\x1b[6n");
            self.send("\x1b[1;1R");
            self.send("echo P0_^READY\r\n");
            self.expect("P0_READY");
        }

        /// Reader returned, writer joined, child waited, job empty, within 2 s.
        fn assert_reaped(&mut self) {
            assert!(
                self.session.wait_closed(Duration::from_secs(2)),
                "session not reaped within 2 s; errors: {:?}",
                self.errors
            );
            assert!(
                self.pump(Duration::from_secs(2), true, |probe| probe.exit.is_some()),
                "no exit event"
            );
            assert_eq!(self.session.live_processes().unwrap(), 0, "job not empty");
        }
    }

    #[test]
    fn cmd_runs_commands_and_reports_exit_code_7() {
        let mut probe = Probe::open();
        probe.ready();
        probe.send("exit 7\r\n");
        assert!(probe.pump(DEADLINE, true, |probe| probe.exit.is_some()));
        assert_eq!(probe.exit, Some(Some(7)), "errors: {:?}", probe.errors);
        probe.assert_reaped();
        assert!(probe.errors.is_empty(), "{:?}", probe.errors);
        probe.sessions.shutdown();
    }

    #[test]
    fn utf8_input_and_output_round_trip() {
        let mut probe = Probe::open();
        probe.ready();
        probe.send("echo P0_^中文\r\n");
        probe.expect("P0_中文");
        probe.session.close();
        probe.assert_reaped();
    }

    #[test]
    fn resize_reaches_the_console() {
        let mut probe = Probe::open();
        probe.ready();
        probe.session.resize(123, 41).unwrap();
        probe.send("mode con\r\n");
        probe.expect("123");
        probe.session.close();
        probe.assert_reaped();
    }

    #[test]
    fn idle_close_and_repeated_close_converge() {
        let mut probe = Probe::open();
        probe.ready();
        probe.session.close();
        probe.session.close();
        probe.assert_reaped();
        assert_eq!(probe.exit, Some(Some(1)));
        assert!(probe.session.write(b"echo late\r\n".to_vec()).is_err());
    }

    #[test]
    fn close_during_output_converges_within_budget() {
        let mut probe = Probe::open();
        probe.ready();
        probe.send(LOOP);
        assert!(probe.pump(DEADLINE, true, |probe| probe.output.len() > 128 * 1024));
        probe.session.close();
        probe.assert_reaped();
        assert!(probe.session.peak_pending_bytes() <= OUTPUT_BUDGET);
    }

    /// Records which Ctrl+C encodings ConPTY honours, for the CI artifact.
    fn record(name: &str, outcome: &str) {
        if let Some(directory) = std::env::var_os("RUNNER_TEMP") {
            let path = std::path::Path::new(&directory)
                .join("p0-logs")
                .join("windows-ctrl-c.txt");
            let _ = std::fs::create_dir_all(path.parent().unwrap());
            let mut file = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(path)
                .unwrap();
            let _ = writeln!(file, "{name}: {outcome}");
        }
    }

    fn interrupts(input: &str, command: &str, running: &str) -> bool {
        let mut probe = Probe::open();
        probe.ready();
        probe.send(command);
        let started = probe.pump(DEADLINE, true, |probe| probe.text().contains(running));
        assert!(started, "command produced no output: {}", probe.tail());
        probe.send(input);
        probe.send("echo P0_^AFTER_CTRL_C\r\n");
        let interrupted = probe.pump(DEADLINE, true, |probe| {
            probe.text().contains("P0_AFTER_CTRL_C")
        });
        probe.session.close();
        probe.assert_reaped();
        interrupted
    }

    /// xterm.js sends Ctrl+C as a plain 0x03 byte; that must stop a command.
    #[test]
    fn plain_ctrl_c_interrupts_a_running_command() {
        let ping = interrupts("\x03", "ping -t 127.0.0.1\r\n", "Reply from");
        record(
            "plain 0x03 + ping -t",
            if ping {
                "interrupted"
            } else {
                "not interrupted"
            },
        );
        let loop_ = interrupts("\x03", LOOP, "1000 P0 bounded");
        record(
            "plain 0x03 + for /L",
            if loop_ {
                "interrupted"
            } else {
                "not interrupted"
            },
        );
        // win32-input-mode encoding (Ctrl down, C down/up, Ctrl up), diagnostic only.
        let encoded =
            "\x1b[17;29;0;1;8;1_\x1b[67;46;3;1;8;1_\x1b[67;46;3;0;8;1_\x1b[17;29;0;0;0;1_";
        let win32 = interrupts(encoded, "ping -t 127.0.0.1\r\n", "Reply from");
        record(
            "win32-input-mode Ctrl+C + ping -t",
            if win32 {
                "interrupted"
            } else {
                "not interrupted"
            },
        );
        assert!(
            ping,
            "plain 0x03 did not interrupt ping -t (win32 encoding: {win32})"
        );
    }

    #[test]
    fn unacknowledged_output_stops_at_budget_then_times_out() {
        let mut probe = Probe::open();
        probe.ready();
        probe.send(LOOP);
        let full = probe.pump(DEADLINE, false, |probe| {
            !probe.session.flow_state().has_room()
        });
        assert!(full, "producer never reached the ACK budget");
        assert!(probe.session.peak_pending_bytes() <= OUTPUT_BUDGET);
        let timed_out = probe.pump(ACK_TIMEOUT + Duration::from_secs(5), false, |probe| {
            probe.errors.iter().any(|error| error.contains("timed out"))
        });
        assert!(timed_out, "errors: {:?}", probe.errors);
        probe.assert_reaped();
    }

    #[test]
    fn reload_closes_and_reaps_the_shell() {
        let mut probe = Probe::open();
        probe.ready();
        probe.sessions.reload_owner("win");
        probe.assert_reaped();
    }

    #[test]
    fn detached_children_are_reaped_on_close_and_natural_exit() {
        for natural in [false, true] {
            let mut probe = Probe::open();
            probe.ready();
            probe.send("start \"\" /B ping -n 60 127.0.0.1 >NUL\r\n");
            probe.send("echo P0_^STARTED\r\n");
            probe.expect("P0_STARTED");
            let spawned = probe.pump(DEADLINE, true, |probe| {
                probe.session.live_processes().unwrap() >= 2
            });
            assert!(spawned, "detached child never joined the job");
            if natural {
                probe.send("exit 7\r\n");
                assert!(probe.pump(DEADLINE, true, |probe| probe.exit.is_some()));
                assert_eq!(probe.exit, Some(Some(7)));
            } else {
                probe.session.close();
            }
            probe.assert_reaped();
        }
    }

    #[test]
    fn twelve_open_output_close_reap_cycles() {
        for cycle in 0..12 {
            let mut probe = Probe::open();
            probe.ready();
            probe.session.close();
            probe.assert_reaped();
            assert!(
                probe.sessions.registry.lock().unwrap().sessions.len() <= 1,
                "cycle {cycle}"
            );
            probe.sessions.shutdown();
        }
    }
}
