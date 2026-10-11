//! Sans-IO XMODEM (checksum, CRC, 1K) and YMODEM batch state machines.
//!
//! P0 feasibility probe for F10/F11 only: no transport, timer, disk or UI is
//! touched here, and ZMODEM (F12) is not implemented. Callers `feed()` bytes
//! read from the peer, call `tick()` once per caller-defined time unit, and
//! write `take_output()` to the peer, so the same machines can later sit on a
//! PTY, an SSH channel or a serial port. See `docs/p0/MODEM.zh-CN.md`.
//!
//! Retransmission is receiver driven, as in classic XMODEM: the receiver NAKs
//! corrupt frames and re-requests on timeout; the sender resends only on NAK
//! (or on `C` while a header, EOT or first block is unconfirmed) and counts its
//! own timeouts toward the limit.

use std::fmt;

mod receiver;
pub use receiver::{ReceivedFile, Receiver};

const SOH: u8 = 0x01;
const STX: u8 = 0x02;
const EOT: u8 = 0x04;
const ACK: u8 = 0x06;
const NAK: u8 = 0x15;
const CAN: u8 = 0x18;
const SUB: u8 = 0x1A;
const CRC_REQUEST: u8 = b'C';
const SHORT_BLOCK: usize = 128;
const LONG_BLOCK: usize = 1024;
/// Two CANs abort X/YMODEM; five also stop a ZMODEM peer.
const ABORT: [u8; 5] = [CAN; 5];
/// `C` requests an XMODEM receiver sends before falling back to checksum NAKs.
const CRC_ATTEMPTS: u32 = 3;
const MAX_NAME_BYTES: usize = 255;

/// Bounds for one transfer. A tick is a caller-defined unit (for example 1 s).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Limits {
    /// Largest file sent or kept. XMODEM receivers count the SUB padding.
    pub max_file_bytes: u64,
    /// Most files in one YMODEM batch.
    pub max_files: usize,
    /// Most payload bytes kept across a batch (files stay in memory).
    pub max_total_bytes: u64,
    /// Consecutive NAKs or timeouts tolerated before aborting with CAN.
    pub max_retries: u32,
    /// Idle ticks before the current step times out.
    pub timeout_ticks: u32,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            max_file_bytes: 16 * 1024 * 1024,
            max_files: 64,
            max_total_bytes: 64 * 1024 * 1024,
            max_retries: 10,
            timeout_ticks: 10,
        }
    }
}

/// Why a transfer stopped.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Failure {
    /// `cancel()` was called; CANs were queued for the peer.
    LocalCancel,
    /// The peer sent two consecutive CAN bytes.
    RemoteCancel,
    /// Too many NAKs or timeouts for one step.
    RetriesExhausted,
    FileTooLarge,
    TooManyFiles,
    /// The batch exceeds `max_total_bytes`.
    BatchTooLarge,
    InvalidFileName,
    /// Malformed YMODEM block 0.
    InvalidHeader,
    /// A block number that is neither the expected one nor a duplicate.
    SequenceError,
    /// A YMODEM file ended before, or ran past, its declared size.
    SizeMismatch,
}

impl fmt::Display for Failure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::LocalCancel => "Transfer cancelled locally",
            Self::RemoteCancel => "Transfer cancelled by the peer",
            Self::RetriesExhausted => "Transfer retries exhausted",
            Self::FileTooLarge => "File exceeds the transfer size limit",
            Self::TooManyFiles => "Batch exceeds the file count limit",
            Self::BatchTooLarge => "Batch exceeds the total size limit",
            Self::InvalidFileName => "Invalid transfer file name",
            Self::InvalidHeader => "Invalid YMODEM header block",
            Self::SequenceError => "Unexpected transfer block number",
            Self::SizeMismatch => "File length does not match its header",
        })
    }
}

/// Lifecycle of a sender or receiver.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Status {
    Running,
    Done,
    Failed(Failure),
}

/// CRC-16/XMODEM: polynomial 0x1021, initial value 0, no reflection.
pub fn crc16(data: &[u8]) -> u16 {
    data.iter().fold(0, |crc, &byte| {
        (0..8).fold(crc ^ (u16::from(byte) << 8), |crc, _| {
            if crc & 0x8000 == 0 {
                crc << 1
            } else {
                (crc << 1) ^ 0x1021
            }
        })
    })
}

/// Original XMODEM arithmetic checksum (sum modulo 256).
pub fn checksum(data: &[u8]) -> u8 {
    data.iter().fold(0, |sum, &byte| sum.wrapping_add(byte))
}

/// Accepts a bare UTF-8 file name: no separators, NUL, controls or `..`.
pub fn validate_file_name(name: &str) -> Result<(), Failure> {
    let invalid = name.is_empty()
        || name.len() > MAX_NAME_BYTES
        || name == "."
        || name.contains("..")
        || name
            .chars()
            .any(|c| matches!(c, '/' | '\\' | '\0') || c.is_control());
    if invalid {
        Err(Failure::InvalidFileName)
    } else {
        Ok(())
    }
}

fn check_bytes(body: &[u8], crc: bool) -> Vec<u8> {
    if crc {
        crc16(body).to_be_bytes().to_vec()
    } else {
        vec![checksum(body)]
    }
}

/// Builds `SOH|STX, n, !n, payload padded with pad, checksum|CRC`.
fn build_frame(block: u8, payload: &[u8], size: usize, pad: u8, crc: bool) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(size + 5);
    bytes.push(if size == LONG_BLOCK { STX } else { SOH });
    bytes.extend_from_slice(&[block, !block]);
    bytes.extend_from_slice(payload);
    bytes.resize(3 + size, pad);
    let check = check_bytes(bytes.get(3..).unwrap_or_default(), crc);
    bytes.extend_from_slice(&check);
    bytes
}

/// YMODEM block 0 payload: `name NUL size`; the frame pads it with NUL.
fn header_payload(name: &str, size: usize) -> Vec<u8> {
    let mut payload = Vec::with_capacity(name.len() + 22);
    payload.extend_from_slice(name.as_bytes());
    payload.push(0);
    payload.extend_from_slice(size.to_string().as_bytes());
    payload
}

/// Output queue, status, timers and CAN pairing shared by both directions.
struct Link {
    limits: Limits,
    out: Vec<u8>,
    status: Status,
    idle: u32,
    retries: u32,
    can_pending: bool,
}

impl Link {
    fn new(limits: Limits) -> Self {
        Self {
            limits,
            out: Vec::new(),
            status: Status::Running,
            idle: 0,
            retries: 0,
            can_pending: false,
        }
    }

    fn running(&self) -> bool {
        self.status == Status::Running
    }

    fn fail(&mut self, failure: Failure) {
        if !self.running() {
            return;
        }
        if failure != Failure::RemoteCancel {
            self.out.extend_from_slice(&ABORT);
        }
        self.status = Status::Failed(failure);
    }

    /// Counts one retry; fails the transfer once the budget is spent.
    fn retry(&mut self) -> bool {
        self.retries = self.retries.saturating_add(1);
        if self.retries > self.limits.max_retries {
            self.fail(Failure::RetriesExhausted);
            return false;
        }
        true
    }

    /// Advances the idle timer; true when a timeout should be acted on.
    fn timed_out(&mut self) -> bool {
        if !self.running() {
            return false;
        }
        self.idle = self.idle.saturating_add(1);
        if self.idle < self.limits.timeout_ticks.max(1) {
            return false;
        }
        self.idle = 0;
        self.retry()
    }

    /// Tracks CAN pairs; true when `byte` was a CAN. A lone CAN is noise.
    fn cancel_byte(&mut self, byte: u8) -> bool {
        if byte != CAN {
            self.can_pending = false;
            return false;
        }
        if self.can_pending {
            self.fail(Failure::RemoteCancel);
        }
        self.can_pending = true;
        true
    }

    /// Drops bytes that predate our latest transmission but still honours CAN CAN.
    fn purge(&mut self, stale: &[u8]) {
        for &byte in stale {
            if !self.running() {
                return;
            }
            self.cancel_byte(byte);
        }
    }
}

/// A file queued for sending; XMODEM ignores the name.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OutgoingFile {
    pub name: String,
    pub data: Vec<u8>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Frame {
    Header,
    Data,
    Eot,
    EndOfBatch,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Waiting {
    /// Waiting for `C` (or NAK for checksum XMODEM) before a file or the batch end.
    Start,
    /// YMODEM header acknowledged; waiting for `C` before data.
    DataStart,
    /// Waiting for ACK/NAK on the frame stored in `last`.
    Ack(Frame),
}

enum Reaction {
    Ignored,
    Handled,
    Transmitted,
}

/// Sans-IO XMODEM / XMODEM-1K / YMODEM batch sender.
pub struct Sender {
    files: Vec<OutgoingFile>,
    batch: bool,
    long_blocks: bool,
    crc: bool,
    file: usize,
    offset: usize,
    block: u8,
    last: Vec<u8>,
    last_len: usize,
    /// Ticks since our last frame; a `C` within the same tick crossed it.
    quiet_ticks: u32,
    state: Waiting,
    link: Link,
    transferred: u64,
}

impl Sender {
    /// XMODEM with 128-byte blocks; CRC or checksum as the receiver requests.
    pub fn xmodem(data: Vec<u8>, limits: Limits) -> Result<Self, Failure> {
        Self::new(vec![unnamed(data)], false, false, limits)
    }

    /// XMODEM-1K: 1024-byte CRC blocks, 128-byte blocks for the tail or a checksum peer.
    pub fn xmodem_1k(data: Vec<u8>, limits: Limits) -> Result<Self, Failure> {
        Self::new(vec![unnamed(data)], false, true, limits)
    }

    /// YMODEM batch: a block 0 header per file, 1K data blocks, empty header to end.
    pub fn ymodem(files: Vec<OutgoingFile>, limits: Limits) -> Result<Self, Failure> {
        Self::new(files, true, true, limits)
    }

    fn new(
        files: Vec<OutgoingFile>,
        batch: bool,
        long_blocks: bool,
        limits: Limits,
    ) -> Result<Self, Failure> {
        if files.len() > limits.max_files {
            return Err(Failure::TooManyFiles);
        }
        for file in &files {
            if file.data.len() as u64 > limits.max_file_bytes {
                return Err(Failure::FileTooLarge);
            }
            if batch {
                validate_file_name(&file.name)?;
            }
        }
        let total = files
            .iter()
            .fold(0u64, |sum, file| sum.saturating_add(file.data.len() as u64));
        if total > limits.max_total_bytes {
            return Err(Failure::BatchTooLarge);
        }
        Ok(Self {
            files,
            batch,
            long_blocks,
            crc: true,
            file: 0,
            offset: 0,
            block: 1,
            last: Vec::new(),
            last_len: 0,
            quiet_ticks: 0,
            state: Waiting::Start,
            link: Link::new(limits),
            transferred: 0,
        })
    }

    /// Consumes bytes received from the peer.
    pub fn feed(&mut self, input: &[u8]) {
        for (index, &byte) in input.iter().enumerate() {
            if !self.link.running() {
                return;
            }
            if self.link.cancel_byte(byte) {
                continue;
            }
            match self.respond(byte) {
                Reaction::Ignored => {}
                Reaction::Handled => self.link.idle = 0,
                Reaction::Transmitted => {
                    self.link.idle = 0;
                    // Later bytes in this read were sent before the peer saw our new frame.
                    self.link.purge(input.get(index + 1..).unwrap_or_default());
                    return;
                }
            }
        }
    }

    /// One time unit elapsed. The sender only counts timeouts; the receiver re-requests.
    pub fn tick(&mut self) {
        self.quiet_ticks = self.quiet_ticks.saturating_add(1);
        self.link.timed_out();
    }

    /// Aborts locally and queues CAN bytes for the peer.
    pub fn cancel(&mut self) {
        self.link.fail(Failure::LocalCancel);
    }

    /// Drains bytes that must be written to the peer.
    pub fn take_output(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.link.out)
    }

    pub fn status(&self) -> Status {
        self.link.status
    }

    /// Payload bytes acknowledged by the receiver, excluding padding.
    pub fn transferred(&self) -> u64 {
        self.transferred
    }

    fn respond(&mut self, byte: u8) -> Reaction {
        match (self.state, byte) {
            (Waiting::Start, CRC_REQUEST) => {
                self.crc = true;
                self.begin()
            }
            (Waiting::Start, NAK) if !self.batch => {
                self.crc = false;
                self.long_blocks = false;
                self.begin()
            }
            (Waiting::DataStart, CRC_REQUEST | NAK) => self.send_data(),
            (Waiting::Ack(frame), ACK) => self.acknowledged(frame),
            (Waiting::Ack(_), NAK) => self.resend(),
            // `C` re-requests a lost header, EOT or first block; mid-file, or within
            // the tick our frame went out, it is a stale request that crossed it.
            (Waiting::Ack(frame), CRC_REQUEST)
                if self.quiet_ticks > 0 && (frame != Frame::Data || self.offset == 0) =>
            {
                self.resend()
            }
            _ => Reaction::Ignored,
        }
    }

    fn begin(&mut self) -> Reaction {
        if !self.batch {
            return self.send_data();
        }
        let header = match self.files.get(self.file) {
            Some(file) => header_payload(&file.name, file.data.len()),
            None => Vec::new(),
        };
        let kind = if header.is_empty() {
            Frame::EndOfBatch
        } else {
            Frame::Header
        };
        let size = if header.len() <= SHORT_BLOCK {
            SHORT_BLOCK
        } else {
            LONG_BLOCK
        };
        let bytes = build_frame(0, &header, size, 0, self.crc);
        self.transmit(bytes, kind, 0)
    }

    fn send_data(&mut self) -> Reaction {
        let rest = self
            .files
            .get(self.file)
            .and_then(|file| file.data.get(self.offset..))
            .unwrap_or_default();
        if rest.is_empty() {
            return self.transmit(vec![EOT], Frame::Eot, 0);
        }
        // Use 1K blocks while they carry more than seven short blocks would.
        let size = if self.long_blocks && rest.len() > LONG_BLOCK - SHORT_BLOCK {
            LONG_BLOCK
        } else {
            SHORT_BLOCK
        };
        let len = rest.len().min(size);
        let bytes = build_frame(self.block, &rest[..len], size, SUB, self.crc);
        self.transmit(bytes, Frame::Data, len)
    }

    fn transmit(&mut self, bytes: Vec<u8>, frame: Frame, len: usize) -> Reaction {
        self.link.out.extend_from_slice(&bytes);
        self.last = bytes;
        self.last_len = len;
        self.quiet_ticks = 0;
        self.state = Waiting::Ack(frame);
        Reaction::Transmitted
    }

    fn resend(&mut self) -> Reaction {
        if !self.link.retry() {
            return Reaction::Handled;
        }
        self.quiet_ticks = 0;
        self.link.out.extend_from_slice(&self.last);
        Reaction::Transmitted
    }

    fn acknowledged(&mut self, frame: Frame) -> Reaction {
        self.link.retries = 0;
        match frame {
            Frame::Header => {
                self.state = Waiting::DataStart;
                Reaction::Handled
            }
            Frame::Data => {
                self.offset += self.last_len;
                self.transferred += self.last_len as u64;
                self.block = self.block.wrapping_add(1);
                self.send_data()
            }
            Frame::Eot if self.batch => {
                self.file += 1;
                self.offset = 0;
                self.block = 1;
                self.state = Waiting::Start;
                Reaction::Handled
            }
            Frame::Eot | Frame::EndOfBatch => {
                self.link.status = Status::Done;
                Reaction::Handled
            }
        }
    }
}

fn unnamed(data: Vec<u8>) -> OutgoingFile {
    OutgoingFile {
        name: String::new(),
        data,
    }
}

#[cfg(test)]
mod tests;
