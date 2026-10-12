//! Runs an installed lrzsz program as an external X/Y/ZMODEM peer over pipes
//! and pumps bytes between it and a sans-IO machine.
//!
//! lrzsz is GPL: it is only executed as a separate process found on `PATH`,
//! never linked, vendored or copied. Tests using this module are `#[ignore]`d
//! and skip with a message when lrzsz is missing, unless `P0_LRZSZ_REQUIRED`
//! is set (CI), in which case a missing program fails the test.
#![allow(dead_code)]

use new_windterm_desktop::modem::{Limits, Receiver, Sender, Status};
use std::{
    cell::Cell,
    convert::identity,
    ffi::OsStr,
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, ExitStatus, Stdio},
    sync::mpsc::{self, RecvTimeoutError},
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

/// Real time per `tick()`; with the default 10-tick timeout one step times out after 1 s.
pub const TICK: Duration = Duration::from_millis(100);
/// Upper bound for one transfer, so a protocol bug fails instead of hanging.
const TRANSFER_DEADLINE: Duration = Duration::from_secs(60);
/// How long a peer may take to exit after the transfer ended.
const EXIT_DEADLINE: Duration = Duration::from_secs(20);
/// Most stderr bytes kept for failure messages.
const STDERR_LIMIT: usize = 64 * 1024;
/// Peer output chunks (of up to 8 KiB) buffered ahead of the pump.
const READ_CHUNKS: usize = 4;

/// The common surface of our `Sender`/`Receiver` and the ZMODEM probe drivers.
pub trait Machine {
    fn feed(&mut self, input: &[u8]);
    fn tick(&mut self);
    fn take_output(&mut self) -> Vec<u8>;
    fn running(&self) -> bool;
    fn cancel(&mut self);
}

macro_rules! machine {
    ($type:ty) => {
        impl Machine for $type {
            fn feed(&mut self, input: &[u8]) {
                <$type>::feed(self, input)
            }
            fn tick(&mut self) {
                <$type>::tick(self)
            }
            fn take_output(&mut self) -> Vec<u8> {
                <$type>::take_output(self)
            }
            fn running(&self) -> bool {
                <$type>::status(self) == Status::Running
            }
            fn cancel(&mut self) {
                <$type>::cancel(self)
            }
        }
    };
}
machine!(Sender);
machine!(Receiver);

/// An lrzsz program for one role (`sx`, `rx`, `sb`, `rb`, `sz` or `rz`).
#[derive(Debug, Clone)]
pub struct Program {
    pub path: PathBuf,
    pub version: String,
}

/// Homebrew installs `sx`/`rx`/`sb`/`rb` only with an `l` prefix (`lsx`);
/// Debian installs both. lrzsz picks its protocol from the program name.
fn find(role: &str) -> Option<Program> {
    let paths = std::env::var_os("PATH")?;
    let names = [format!("l{role}"), role.to_owned()];
    let candidates = names.iter().flat_map(|name| {
        std::env::split_paths(&paths)
            .map(move |dir| dir.join(name))
            .collect::<Vec<_>>()
    });
    candidates.filter(|path| path.is_file()).find_map(|path| {
        let output = Command::new(&path)
            .arg("--version")
            .stdin(Stdio::null())
            .output()
            .ok()?;
        let text = String::from_utf8_lossy(&output.stdout).into_owned()
            + &String::from_utf8_lossy(&output.stderr);
        let version = text.lines().find(|line| line.contains("lrzsz"))?.trim();
        Some(Program {
            version: version.to_owned(),
            path,
        })
    })
}

/// Finds the program for `role`, or explains the skip. A skipped test reports
/// as passed; setting `P0_LRZSZ_REQUIRED` (to any value) makes it panic.
pub fn require(role: &str) -> Option<Program> {
    if let Some(program) = find(role) {
        eprintln!(
            "lrzsz peer {role}: {} ({})",
            program.path.display(),
            program.version
        );
        return Some(program);
    }
    let message = format!(
        "lrzsz `l{role}`/`{role}` was not found on PATH (macOS: brew install lrzsz; Debian/Ubuntu: apt-get install lrzsz)"
    );
    if std::env::var_os("P0_LRZSZ_REQUIRED").is_some() {
        panic!("{message}, but P0_LRZSZ_REQUIRED is set");
    }
    eprintln!("skipped: {message}");
    None
}

/// A private temporary directory removed on drop.
pub struct Scratch(PathBuf);

impl Scratch {
    pub fn new() -> Self {
        let dir = std::env::temp_dir().join(format!("p0-modem-lrzsz-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&dir).expect("create scratch directory");
        Self(dir)
    }

    pub fn path(&self) -> &Path {
        &self.0
    }

    /// Sorted names of regular files directly inside the directory.
    pub fn file_names(&self) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(&self.0)
            .expect("list scratch directory")
            .filter_map(Result::ok)
            .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_file()))
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// A spawned lrzsz process connected through stdin/stdout pipes.
pub struct Peer {
    child: Child,
    stdin: Option<ChildStdin>,
    stdout: mpsc::Receiver<Vec<u8>>,
    stderr: Option<JoinHandle<Vec<u8>>>,
}

/// How a peer ended: `None` when it had to be killed after `EXIT_DEADLINE`.
pub struct Exit {
    pub status: Option<ExitStatus>,
    pub stderr: String,
}

impl Exit {
    pub fn success(&self) -> bool {
        self.status.is_some_and(|status| status.success())
    }
}

impl Peer {
    pub fn spawn<S: AsRef<OsStr>>(program: &Program, args: &[S], cwd: &Path) -> Self {
        let mut child = Command::new(&program.path)
            .args(args)
            .current_dir(cwd)
            .env("LC_ALL", "C")
            .env_remove("ZMODEM_RESTRICTED")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn lrzsz peer");
        let mut stdout = child.stdout.take().expect("peer stdout");
        // Bounded, so a streaming peer (ZMODEM) blocks on the pipe as it would
        // on a real link instead of racing ahead into our memory.
        let (sender, chunks) = mpsc::sync_channel(READ_CHUNKS);
        thread::spawn(move || {
            let mut buffer = [0; 8192];
            while let Ok(n) = stdout.read(&mut buffer) {
                if n == 0 || sender.send(buffer[..n].to_vec()).is_err() {
                    break;
                }
            }
        });
        let mut stderr = child.stderr.take().expect("peer stderr");
        let stderr = thread::spawn(move || {
            let mut kept = Vec::new();
            let mut buffer = [0; 4096];
            while let Ok(n) = stderr.read(&mut buffer) {
                if n == 0 {
                    break;
                }
                kept.extend_from_slice(&buffer[..n]);
                let excess = kept.len().saturating_sub(STDERR_LIMIT);
                kept.drain(..excess);
            }
            kept
        });
        Self {
            stdin: child.stdin.take(),
            child,
            stdout: chunks,
            stderr: Some(stderr),
        }
    }

    pub fn id(&self) -> u32 {
        self.child.id()
    }

    /// Writes to the peer; a peer that already exited (EPIPE) just stops reading.
    /// The write blocks while the peer's stdin pipe is full; the tests never
    /// stream more than a pipe's worth both ways at once, and the CI job
    /// timeout bounds the worst case.
    fn write(&mut self, bytes: &[u8]) {
        if bytes.is_empty() {
            return;
        }
        let failed = self
            .stdin
            .as_mut()
            .is_some_and(|stdin| stdin.write_all(bytes).and_then(|()| stdin.flush()).is_err());
        if failed {
            self.stdin = None;
        }
    }

    /// Sends a signal by name through `kill(1)`, keeping the tests free of `unsafe`.
    pub fn signal(&self, name: &str) {
        let status = Command::new("kill")
            .arg(format!("-{name}"))
            .arg(self.id().to_string())
            .status()
            .expect("run kill");
        assert!(status.success(), "kill -{name} {}", self.id());
    }

    /// Closes stdin and waits for the peer to exit, killing it after a deadline.
    /// Its output is still drained, so a peer blocked on a full pipe can go
    /// on to read what we sent (for example our CANs).
    pub fn finish(mut self) -> Exit {
        self.stdin = None;
        let deadline = Instant::now() + EXIT_DEADLINE;
        let status = loop {
            while self.stdout.try_recv().is_ok() {}
            match self.child.try_wait().expect("poll lrzsz peer") {
                Some(status) => break Some(status),
                None if Instant::now() >= deadline => {
                    let _ = self.child.kill();
                    let _ = self.child.wait();
                    break None;
                }
                None => thread::sleep(Duration::from_millis(20)),
            }
        };
        let stderr = self
            .stderr
            .take()
            .and_then(|handle| handle.join().ok())
            .unwrap_or_default();
        Exit {
            status,
            stderr: String::from_utf8_lossy(&stderr).into_owned(),
        }
    }
}

impl Drop for Peer {
    fn drop(&mut self) {
        if matches!(self.child.try_wait(), Ok(None)) {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
}

/// What a pumped transfer did on our side.
pub struct Trace {
    /// `tick()` calls, one per `TICK` of real time.
    pub ticks: u32,
    /// Every chunk our machine wrote to the peer, after `outbound` filtering.
    pub writes: Vec<Vec<u8>>,
}

/// Pumps until our machine stops. `outbound` and `inbound` may rewrite bytes
/// on the wire; `hook` runs every iteration so a test can cancel or kill.
pub fn pump<M: Machine>(
    machine: &mut M,
    peer: &mut Peer,
    mut outbound: impl FnMut(Vec<u8>) -> Vec<u8>,
    mut inbound: impl FnMut(Vec<u8>) -> Vec<u8>,
    mut hook: impl FnMut(&mut M, &mut Peer),
) -> Trace {
    let start = Instant::now();
    let mut next_tick = start + TICK;
    let mut trace = Trace {
        ticks: 0,
        writes: Vec::new(),
    };
    loop {
        let bytes = outbound(machine.take_output());
        if !bytes.is_empty() {
            peer.write(&bytes);
            trace.writes.push(bytes);
        }
        if !machine.running() {
            return trace;
        }
        assert!(
            start.elapsed() < TRANSFER_DEADLINE,
            "transfer still running after {TRANSFER_DEADLINE:?}"
        );
        hook(machine, peer);
        if !machine.running() {
            continue; // Flush the CAN bytes a cancel queued.
        }
        let now = Instant::now();
        if now >= next_tick {
            machine.tick();
            trace.ticks += 1;
            next_tick += TICK;
            continue;
        }
        match peer.stdout.recv_timeout(next_tick - now) {
            Ok(chunk) => machine.feed(&inbound(chunk)),
            Err(RecvTimeoutError::Timeout) => {}
            // The peer closed its stdout; only our timers can end the transfer now.
            Err(RecvTimeoutError::Disconnected) => thread::sleep(next_tick - now),
        }
    }
}

/// Pumps a whole transfer without interference.
pub fn transfer<M: Machine>(machine: &mut M, peer: &mut Peer) -> Trace {
    pump(machine, peer, identity, identity, |_, _| {})
}

/// Peer silence before an intervention after which withheld timers start:
/// the peer is stuck, not slow.
pub const STUCK: Duration = Duration::from_secs(10);

/// A machine whose `tick()`s are withheld until `timed` is set, so a test
/// can time only the steps after an intervention.
pub struct Held<M> {
    pub machine: M,
    pub timed: bool,
}

impl<M: Machine> Machine for Held<M> {
    fn feed(&mut self, input: &[u8]) {
        self.machine.feed(input)
    }
    fn tick(&mut self) {
        if self.timed {
            self.machine.tick()
        }
    }
    fn take_output(&mut self) -> Vec<u8> {
        self.machine.take_output()
    }
    fn running(&self) -> bool {
        self.machine.running()
    }
    fn cancel(&mut self) {
        self.machine.cancel()
    }
}

/// When the peer answered before an intervention, for logs and failures.
pub struct Watch {
    /// Just after the peer was spawned; the first wait includes its start-up.
    pub start: Instant,
    /// When the test intervened.
    pub acted: Cell<Option<Instant>>,
    first_reply: Cell<Option<Duration>>,
    pub last_reply: Cell<Instant>,
    /// Longest wait for the peer: start to first reply, or between replies.
    longest_wait: Cell<Duration>,
    /// Withheld timers started after `STUCK` of silence.
    pub stuck: Cell<bool>,
}

impl Watch {
    pub fn new() -> Self {
        let start = Instant::now();
        Self {
            start,
            acted: Cell::new(None),
            first_reply: Cell::new(None),
            last_reply: Cell::new(start),
            longest_wait: Cell::new(Duration::ZERO),
            stuck: Cell::new(false),
        }
    }

    /// Inbound filter: notes when the peer's bytes arrived before the intervention.
    pub fn heard(&self, chunk: Vec<u8>) -> Vec<u8> {
        if self.acted.get().is_none() {
            let now = Instant::now();
            let wait = now - self.last_reply.get();
            self.longest_wait.set(self.longest_wait.get().max(wait));
            self.last_reply.set(now);
            if self.first_reply.get().is_none() {
                self.first_reply.set(Some(now - self.start));
            }
        }
        chunk
    }

    /// Compares the peer's pace up to the intervention (or, without one, up
    /// to `stopped`) with the silence `limits` tolerate per step.
    pub fn report(&self, limits: Limits, stopped: Instant) -> String {
        let tolerated = TICK * limits.timeout_ticks * (limits.max_retries + 1);
        let end = self.acted.get().unwrap_or(stopped);
        let trailing = end.saturating_duration_since(self.last_reply.get());
        let stuck = match self.stuck.get() {
            true => format!("; timers started after {STUCK:?} of peer silence"),
            false => String::new(),
        };
        format!(
            "first peer byte after {:?}; longest wait for the peer before the intervention {:?} (our limits tolerate {tolerated:?} of silence per step){stuck}",
            self.first_reply.get(),
            self.longest_wait.get().max(trailing)
        )
    }
}
