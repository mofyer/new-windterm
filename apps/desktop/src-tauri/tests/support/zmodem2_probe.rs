//! ZMODEM (F12) evaluation probe: drives `zmodem2` 0.7.3 (MIT OR Apache-2.0,
//! a dev-dependency only) through the `lrzsz::Machine` surface so the same
//! pipe pump can run it against `sz`/`rz`.
//!
//! The drivers add what `zmodem2` leaves to its caller, and the interop tests
//! check both sides of that split:
//! - abort on five consecutive CAN from the peer (`zmodem2` only reacts to
//!   ZABORT/ZCAN headers, which lrzsz never sends when it is interrupted);
//! - a bound on silent timeouts (`zmodem2` only repeats ZRINIT/ZRQINIT before
//!   a file starts, so a dead peer would otherwise stall it forever);
//! - file name validation and size/count limits (`zmodem2` passes raw name
//!   bytes up to 256 bytes and any `u32` size).
//!
//! These drivers are test scaffolding for the evaluation, not a design for
//! the product integration (they keep whole files in memory, for one).
#![allow(dead_code)]

use super::lrzsz::Machine;
use new_windterm_desktop::modem::validate_file_name;
use zmodem2::{Action, Event, FileInfo, Position};

const CAN: u8 = 0x18;
/// Consecutive CANs that cancel a ZMODEM session.
const CANCEL_RUN: usize = 5;
/// Library errors (corrupt headers, which it answers with ZNAK) tolerated
/// without progress before the driver gives up.
const MAX_ERRORS: u32 = 10;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    Running,
    Done,
    LocalCancel,
    /// `by_library` is true when `zmodem2` itself reported `Event::Aborted`.
    RemoteCancel {
        by_library: bool,
    },
    TimedOut,
    Refused(&'static str),
    Protocol(String),
}

#[derive(Debug, Clone, Copy)]
pub struct ProbeLimits {
    pub max_file_bytes: u64,
    pub max_files: usize,
    /// Ticks without input before `timeout()` is called.
    pub timeout_ticks: u32,
    /// Consecutive timeouts tolerated before the driver aborts.
    pub max_timeouts: u32,
    /// Whether the driver watches for five CANs (off shows what the library
    /// does on its own).
    pub can_check: bool,
}

impl Default for ProbeLimits {
    fn default() -> Self {
        Self {
            max_file_bytes: 16 * 1024 * 1024,
            max_files: 64,
            timeout_ticks: 10,
            max_timeouts: 10,
            can_check: true,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ZFile {
    pub name: String,
    pub declared: u64,
    pub data: Vec<u8>,
}

/// State shared by both drivers: output, outcome, CAN run and timers.
struct Common {
    limits: ProbeLimits,
    out: Vec<u8>,
    outcome: Outcome,
    can_run: usize,
    idle: u32,
    timeouts: u32,
    errors: u32,
}

impl Common {
    fn new(limits: ProbeLimits) -> Self {
        Self {
            limits,
            out: Vec::new(),
            outcome: Outcome::Running,
            can_run: 0,
            idle: 0,
            timeouts: 0,
            errors: 0,
        }
    }

    /// Counts a library error; false once the budget is spent.
    fn tolerate(&mut self) -> bool {
        self.errors += 1;
        self.errors <= MAX_ERRORS
    }

    fn running(&self) -> bool {
        self.outcome == Outcome::Running
    }

    fn end(&mut self, outcome: Outcome) {
        if self.running() {
            self.outcome = outcome;
        }
    }

    /// True when `input` completes a run of five CANs from the peer.
    fn cancelled_by_peer(&mut self, input: &[u8]) -> bool {
        self.idle = 0;
        self.timeouts = 0;
        if !self.limits.can_check {
            return false;
        }
        for &byte in input {
            self.can_run = if byte == CAN { self.can_run + 1 } else { 0 };
            if self.can_run >= CANCEL_RUN {
                return true;
            }
        }
        false
    }

    /// Advances the idle timer; true when `timeout()` is due, false when the
    /// budget is spent (the caller then aborts).
    fn timer(&mut self) -> Option<bool> {
        self.idle += 1;
        if self.idle < self.limits.timeout_ticks.max(1) {
            return Some(false);
        }
        self.idle = 0;
        self.timeouts += 1;
        (self.timeouts <= self.limits.max_timeouts).then_some(true)
    }
}

/// `zmodem2::Receiver` plus the bounds and checks the library leaves out.
pub struct ZReceiver {
    inner: zmodem2::Receiver,
    common: Common,
    current: Option<ZFile>,
    files: Vec<ZFile>,
    received: u64,
}

impl ZReceiver {
    pub fn new(limits: ProbeLimits) -> Self {
        // Nonstop I/O, as the crate recommends for pipes, TCP and SSH.
        let inner = zmodem2::Receiver::with_flow_control(0, true).expect("zmodem2 receiver");
        let mut receiver = Self {
            inner,
            common: Common::new(limits),
            current: None,
            files: Vec::new(),
            received: 0,
        };
        receiver.drain();
        receiver
    }

    pub fn outcome(&self) -> &Outcome {
        &self.common.outcome
    }

    pub fn files(&self) -> &[ZFile] {
        &self.files
    }

    pub fn received(&self) -> u64 {
        self.received
    }

    fn abort(&mut self, outcome: Outcome) {
        if self.common.running() {
            self.common.out.clear();
            let _ = self.inner.abort();
            self.drain_wire_only();
            self.common.end(outcome);
        }
    }

    /// After an abort only the cancel sequence matters.
    fn drain_wire_only(&mut self) {
        while let Action::WriteWire(bytes) = self.inner.poll() {
            let n = bytes.len();
            self.common.out.extend_from_slice(bytes);
            self.inner.wire_written(n);
        }
    }

    fn file_started(&mut self, name: &[u8], size: Option<Position>) {
        let declared = u64::from(size.map_or(0, Position::get));
        let name = match std::str::from_utf8(name) {
            Ok(name) if validate_file_name(name).is_ok() => name.to_owned(),
            _ => return self.abort(Outcome::Refused("file name")),
        };
        if declared > self.common.limits.max_file_bytes {
            return self.abort(Outcome::Refused("file size"));
        }
        if self.files.len() >= self.common.limits.max_files {
            return self.abort(Outcome::Refused("file count"));
        }
        self.current = Some(ZFile {
            name,
            declared,
            data: Vec::new(),
        });
    }

    fn file_data(&mut self, bytes: &[u8]) -> bool {
        let Some(file) = self.current.as_mut() else {
            self.abort(Outcome::Protocol("data outside a file".into()));
            return false;
        };
        if (file.data.len() + bytes.len()) as u64 > file.declared {
            self.abort(Outcome::Refused("data past the declared size"));
            return false;
        }
        file.data.extend_from_slice(bytes);
        self.received += bytes.len() as u64;
        self.common.errors = 0;
        true
    }

    fn file_completed(&mut self) {
        match self.current.take() {
            Some(file) if file.data.len() as u64 == file.declared => self.files.push(file),
            _ => self.abort(Outcome::Protocol("file shorter than declared".into())),
        }
    }

    /// Performs every pending action until the library is idle.
    fn drain(&mut self) {
        while self.common.running() {
            match self.inner.poll() {
                Action::WriteWire(bytes) => {
                    let n = bytes.len();
                    self.common.out.extend_from_slice(bytes);
                    self.inner.wire_written(n);
                }
                Action::WriteFile(bytes) => {
                    let bytes = bytes.to_vec();
                    if !self.file_data(&bytes) {
                        return;
                    }
                    if let Err(error) = self.inner.file_written(bytes.len()) {
                        return self.abort(Outcome::Protocol(error.to_string()));
                    }
                }
                Action::Event(Event::FileStarted(info)) => {
                    let (name, size) = (info.name.to_vec(), info.size);
                    self.file_started(&name, size);
                }
                Action::Event(Event::FileCompleted) => self.file_completed(),
                Action::Event(Event::SessionCompleted) => {
                    self.drain_wire_only(); // ZFIN
                    self.common.end(Outcome::Done);
                }
                Action::Event(Event::Aborted) => {
                    self.common.end(Outcome::RemoteCancel { by_library: true })
                }
                Action::Event(_) | Action::ReadFile { .. } => {
                    self.abort(Outcome::Protocol("unexpected action".into()))
                }
                Action::Idle => return,
                _ => return self.abort(Outcome::Protocol("unknown action".into())),
            }
        }
    }
}

impl Machine for ZReceiver {
    fn feed(&mut self, input: &[u8]) {
        if !self.common.running() {
            return;
        }
        if self.common.cancelled_by_peer(input) {
            self.common.end(Outcome::RemoteCancel { by_library: false });
            return;
        }
        let mut rest = input;
        let mut stalled = false;
        while self.common.running() && !rest.is_empty() {
            let consumed = match self.inner.submit_wire(rest) {
                Ok(n) => n,
                // The consumed count is lost with the error: drop this read.
                Err(_) if self.common.tolerate() => rest.len(),
                Err(error) => return self.abort(Outcome::Protocol(error.to_string())),
            };
            rest = &rest[consumed..];
            self.drain();
            // Bytes after the session ended inside the library stay unread.
            if consumed > 0 {
                stalled = false;
            } else if std::mem::replace(&mut stalled, true) {
                return;
            }
        }
    }

    fn tick(&mut self) {
        if !self.common.running() {
            return;
        }
        match self.common.timer() {
            Some(false) => {}
            Some(true) => {
                if let Err(error) = self.inner.timeout() {
                    return self.abort(Outcome::Protocol(error.to_string()));
                }
                self.drain();
            }
            None => self.abort(Outcome::TimedOut),
        }
    }

    fn take_output(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.common.out)
    }

    fn running(&self) -> bool {
        self.common.running()
    }

    fn cancel(&mut self) {
        self.abort(Outcome::LocalCancel);
    }
}

/// An outgoing file for the sender driver.
#[derive(Debug, Clone)]
pub struct ZOutgoing {
    pub name: String,
    pub data: Vec<u8>,
}

/// `zmodem2::Sender` fed from memory, plus the same bounds as the receiver.
pub struct ZSender {
    inner: zmodem2::Sender,
    common: Common,
    files: Vec<ZOutgoing>,
    index: usize,
    submitted: u64,
}

impl ZSender {
    pub fn new(files: Vec<ZOutgoing>, limits: ProbeLimits) -> Self {
        for file in &files {
            validate_file_name(&file.name).expect("valid outgoing name");
            assert!(file.data.len() as u64 <= limits.max_file_bytes);
            u32::try_from(file.data.len()).expect("ZMODEM sizes are 32-bit");
        }
        let inner = zmodem2::Sender::new().expect("zmodem2 sender");
        let mut sender = Self {
            inner,
            common: Common::new(limits),
            files,
            index: 0,
            submitted: 0,
        };
        sender.next_file();
        sender.drain();
        sender
    }

    pub fn outcome(&self) -> &Outcome {
        &self.common.outcome
    }

    /// Subpackets per acknowledgement when the receiver streams nonstop.
    pub fn with_window(mut self, subpackets: usize) -> Self {
        self.inner.set_streaming_window(subpackets);
        self
    }

    /// File bytes handed to the library (sent at least once).
    pub fn submitted(&self) -> u64 {
        self.submitted
    }

    fn next_file(&mut self) {
        let result = match self.files.get(self.index) {
            Some(file) => {
                let size = u32::try_from(file.data.len()).unwrap_or(u32::MAX);
                let info = FileInfo::new(file.name.as_bytes(), Some(Position::new(size)));
                self.inner.start_file(info)
            }
            None => self.inner.finish(),
        };
        if let Err(error) = result {
            self.abort(Outcome::Protocol(error.to_string()));
        }
    }

    fn abort(&mut self, outcome: Outcome) {
        if self.common.running() {
            self.common.out.clear();
            self.inner.abort();
            while let Action::WriteWire(bytes) = self.inner.poll() {
                let n = bytes.len();
                self.common.out.extend_from_slice(bytes);
                self.inner.wire_written(n);
            }
            self.common.end(outcome);
        }
    }

    fn read_file(&mut self, offset: Position, max_len: usize) {
        let data = self
            .files
            .get(self.index)
            .map(|file| file.data.as_slice())
            .unwrap_or_default();
        let start = (offset.get() as usize).min(data.len());
        let end = start.saturating_add(max_len).min(data.len());
        let chunk = data[start..end].to_vec();
        self.submitted = self.submitted.max(self.offset_base() + end as u64);
        // Streaming file data is progress even while the receiver is quiet.
        self.common.errors = 0;
        self.common.idle = 0;
        self.common.timeouts = 0;
        if let Err(error) = self.inner.submit_file(&chunk) {
            self.abort(Outcome::Protocol(error.to_string()));
        }
    }

    /// Bytes of the files before the current one.
    fn offset_base(&self) -> u64 {
        self.files[..self.index]
            .iter()
            .map(|file| file.data.len() as u64)
            .sum()
    }

    fn drain(&mut self) {
        while self.common.running() {
            match self.inner.poll() {
                Action::WriteWire(bytes) => {
                    let n = bytes.len();
                    self.common.out.extend_from_slice(bytes);
                    self.inner.wire_written(n);
                }
                Action::ReadFile { offset, max_len } => self.read_file(offset, max_len),
                Action::Event(Event::FileCompleted) => {
                    self.index += 1;
                    self.next_file();
                }
                Action::Event(Event::SessionCompleted) => {
                    // "OO" follows the event.
                    while let Action::WriteWire(bytes) = self.inner.poll() {
                        let n = bytes.len();
                        self.common.out.extend_from_slice(bytes);
                        self.inner.wire_written(n);
                    }
                    self.common.end(Outcome::Done);
                }
                Action::Event(Event::Aborted) => {
                    self.common.end(Outcome::RemoteCancel { by_library: true })
                }
                Action::Idle => return,
                _ => return self.abort(Outcome::Protocol("unexpected action".into())),
            }
        }
    }
}

impl Machine for ZSender {
    fn feed(&mut self, input: &[u8]) {
        if !self.common.running() {
            return;
        }
        if self.common.cancelled_by_peer(input) {
            self.common.end(Outcome::RemoteCancel { by_library: false });
            return;
        }
        let mut rest = input;
        let mut stalled = false;
        while self.common.running() && !rest.is_empty() {
            let consumed = match self.inner.submit_wire(rest) {
                Ok(n) => n,
                // A corrupt header: the library queued a ZNAK; drop this read.
                Err(_) if self.common.tolerate() => rest.len(),
                Err(error) => return self.abort(Outcome::Protocol(error.to_string())),
            };
            rest = &rest[consumed..];
            self.drain();
            if consumed > 0 {
                stalled = false;
            } else if std::mem::replace(&mut stalled, true) {
                return;
            }
        }
    }

    fn tick(&mut self) {
        if !self.common.running() {
            return;
        }
        match self.common.timer() {
            Some(false) => {}
            Some(true) => {
                if let Err(error) = self.inner.timeout() {
                    return self.abort(Outcome::Protocol(error.to_string()));
                }
                self.drain();
            }
            None => self.abort(Outcome::TimedOut),
        }
    }

    fn take_output(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.common.out)
    }

    fn running(&self) -> bool {
        self.common.running()
    }

    fn cancel(&mut self) {
        self.abort(Outcome::LocalCancel);
    }
}
