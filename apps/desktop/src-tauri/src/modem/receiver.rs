//! Receiving half of the sans-IO X/YMODEM probe.
use super::{
    check_bytes, validate_file_name, Failure, Limits, Link, Status, ACK, CRC_ATTEMPTS, CRC_REQUEST,
    EOT, LONG_BLOCK, NAK, SHORT_BLOCK, SOH, STX,
};

/// A completed file. XMODEM has no name or size, so its data keeps SUB padding.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReceivedFile {
    pub name: Option<String>,
    pub declared_size: Option<u64>,
    pub data: Vec<u8>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RxPhase {
    /// YMODEM: expecting block 0 (a file header or the empty end-of-batch block).
    Header,
    /// Expecting block `expected`; `started` once a data block or EOT arrived.
    Data { expected: u8, started: bool },
}

#[derive(Default)]
struct Incoming {
    name: Option<String>,
    declared: Option<u64>,
    data: Vec<u8>,
}

/// Parses YMODEM block 0 (`name NUL [size [fields]]`); `None` ends the batch.
fn parse_header(body: &[u8], max_file_bytes: u64) -> Result<Option<Incoming>, Failure> {
    let end = body
        .iter()
        .position(|&byte| byte == 0)
        .ok_or(Failure::InvalidHeader)?;
    if end == 0 {
        return Ok(None);
    }
    let (name, fields) = body.split_at(end);
    let name = std::str::from_utf8(name).map_err(|_| Failure::InvalidFileName)?;
    validate_file_name(name)?;
    let digits = fields
        .get(1..)
        .unwrap_or_default()
        .split(|&byte| byte == b' ' || byte == 0)
        .next()
        .unwrap_or_default();
    let declared = if digits.is_empty() {
        None
    } else if digits.iter().all(u8::is_ascii_digit) {
        let text = std::str::from_utf8(digits).map_err(|_| Failure::InvalidHeader)?;
        Some(text.parse::<u64>().map_err(|_| Failure::InvalidHeader)?)
    } else {
        return Err(Failure::InvalidHeader);
    };
    if declared.is_some_and(|size| size > max_file_bytes) {
        return Err(Failure::FileTooLarge);
    }
    Ok(Some(Incoming {
        name: Some(name.to_owned()),
        declared,
        data: Vec::new(),
    }))
}

/// Sans-IO XMODEM (CRC with checksum fallback, 128/1K blocks) or YMODEM receiver.
pub struct Receiver {
    batch: bool,
    crc: bool,
    /// Set once a frame arrived; the CRC/checksum choice is then fixed.
    heard: bool,
    phase: RxPhase,
    packet: Vec<u8>,
    packet_len: usize,
    eot_pending: bool,
    current: Incoming,
    files: Vec<ReceivedFile>,
    link: Link,
    transferred: u64,
}

impl Receiver {
    /// XMODEM: requests CRC with `C`, then falls back to checksum NAKs.
    pub fn xmodem(limits: Limits) -> Self {
        Self::new(false, limits)
    }

    /// YMODEM batch (CRC only): validates names and trims padding by declared size.
    pub fn ymodem(limits: Limits) -> Self {
        Self::new(true, limits)
    }

    fn new(batch: bool, limits: Limits) -> Self {
        let phase = if batch {
            RxPhase::Header
        } else {
            RxPhase::Data {
                expected: 1,
                started: false,
            }
        };
        let mut receiver = Self {
            batch,
            crc: true,
            heard: false,
            phase,
            packet: Vec::new(),
            packet_len: 0,
            eot_pending: false,
            current: Incoming::default(),
            files: Vec::new(),
            link: Link::new(limits),
            transferred: 0,
        };
        receiver.request_start();
        receiver
    }

    /// Consumes bytes received from the sender.
    pub fn feed(&mut self, input: &[u8]) {
        for (index, &byte) in input.iter().enumerate() {
            if !self.link.running() {
                return;
            }
            if self.packet_len > 0 {
                self.link.idle = 0;
                self.packet.push(byte);
                if self.packet.len() == self.packet_len && !self.finish_packet() {
                    self.link.purge(input.get(index + 1..).unwrap_or_default());
                    return;
                }
                continue;
            }
            if self.link.cancel_byte(byte) {
                continue;
            }
            match byte {
                SOH | STX => self.start_packet(byte),
                EOT => self.end_of_file(),
                _ => {} // Line noise between frames.
            }
        }
    }

    /// One time unit elapsed: drop a partial frame and re-request.
    pub fn tick(&mut self) {
        if !self.link.timed_out() {
            return;
        }
        self.packet.clear();
        self.packet_len = 0;
        match self.phase {
            RxPhase::Data { started: true, .. } => self.link.out.push(NAK),
            _ => {
                if !self.batch && !self.heard && self.link.retries >= CRC_ATTEMPTS {
                    self.crc = false;
                }
                self.request_start();
            }
        }
    }

    /// Aborts locally and queues CAN bytes for the peer.
    pub fn cancel(&mut self) {
        self.link.fail(Failure::LocalCancel);
    }

    /// Drains bytes that must be written to the sender.
    pub fn take_output(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.link.out)
    }

    pub fn status(&self) -> Status {
        self.link.status
    }

    /// Completed files, in batch order.
    pub fn files(&self) -> &[ReceivedFile] {
        &self.files
    }

    /// Payload bytes kept so far across all files.
    pub fn transferred(&self) -> u64 {
        self.transferred
    }

    fn request_start(&mut self) {
        self.link.out.push(if self.crc { CRC_REQUEST } else { NAK });
    }

    fn start_packet(&mut self, kind: u8) {
        let size = if kind == STX { LONG_BLOCK } else { SHORT_BLOCK };
        self.heard = true;
        self.link.idle = 0;
        self.packet.clear();
        self.packet.push(kind);
        self.packet_len = 3 + size + if self.crc { 2 } else { 1 };
    }

    /// Validates a complete frame; false when it was rejected with NAK.
    fn finish_packet(&mut self) -> bool {
        let packet = std::mem::take(&mut self.packet);
        self.packet_len = 0;
        let check_len = if self.crc { 2 } else { 1 };
        if let [_, block, inverse, rest @ ..] = packet.as_slice() {
            let (body, check) = rest.split_at(rest.len().saturating_sub(check_len));
            if *block == !*inverse && check == check_bytes(body, self.crc).as_slice() {
                self.accept_block(*block, body);
                return true;
            }
        }
        if self.link.retry() {
            self.link.out.push(NAK);
        }
        false
    }

    fn accept_block(&mut self, block: u8, body: &[u8]) {
        self.eot_pending = false;
        match self.phase {
            RxPhase::Header if block == 0 => self.header(body),
            RxPhase::Data { expected, .. } if block == expected => {
                if self.store(body) {
                    self.link.retries = 0;
                    self.phase = RxPhase::Data {
                        expected: expected.wrapping_add(1),
                        started: true,
                    };
                    self.link.out.push(ACK);
                }
            }
            RxPhase::Data { expected, started } if block == expected.wrapping_sub(1) => {
                // Duplicate after a lost ACK: confirm again and store nothing.
                self.link.out.push(ACK);
                if self.batch && !started {
                    self.link.out.push(CRC_REQUEST);
                }
            }
            _ => self.link.fail(Failure::SequenceError),
        }
    }

    fn header(&mut self, body: &[u8]) {
        match parse_header(body, self.link.limits.max_file_bytes) {
            Ok(None) => {
                self.link.out.push(ACK);
                self.link.status = Status::Done;
            }
            Ok(Some(_)) if self.files.len() >= self.link.limits.max_files => {
                self.link.fail(Failure::TooManyFiles);
            }
            Ok(Some(incoming)) => {
                self.current = incoming;
                self.link.retries = 0;
                self.phase = RxPhase::Data {
                    expected: 1,
                    started: false,
                };
                self.link.out.extend_from_slice(&[ACK, CRC_REQUEST]);
            }
            Err(failure) => self.link.fail(failure),
        }
    }

    /// Appends payload within the declared size, or within the file limit.
    fn store(&mut self, body: &[u8]) -> bool {
        let stored = self.current.data.len() as u64;
        let take = match self.current.declared {
            Some(size) if stored >= size => {
                self.link.fail(Failure::SizeMismatch);
                return false;
            }
            Some(size) => body
                .len()
                .min(usize::try_from(size - stored).unwrap_or(usize::MAX)),
            None if stored + body.len() as u64 > self.link.limits.max_file_bytes => {
                self.link.fail(Failure::FileTooLarge);
                return false;
            }
            None => body.len(),
        };
        if self.transferred.saturating_add(take as u64) > self.link.limits.max_total_bytes {
            self.link.fail(Failure::BatchTooLarge);
            return false;
        }
        self.current.data.extend_from_slice(&body[..take]);
        self.transferred += take as u64;
        true
    }

    fn end_of_file(&mut self) {
        self.link.idle = 0;
        match self.phase {
            // Our ACK for the previous EOT was lost: confirm it again.
            RxPhase::Header if !self.files.is_empty() => {
                self.link.out.extend_from_slice(&[ACK, CRC_REQUEST]);
            }
            RxPhase::Header => {}
            // YMODEM confirms EOT twice: NAK the first, ACK the second.
            RxPhase::Data { expected, .. } if self.batch && !self.eot_pending => {
                self.eot_pending = true;
                self.phase = RxPhase::Data {
                    expected,
                    started: true,
                };
                self.link.out.push(NAK);
            }
            RxPhase::Data { .. } => self.complete(),
        }
    }

    fn complete(&mut self) {
        let file = std::mem::take(&mut self.current);
        if file
            .declared
            .is_some_and(|size| (file.data.len() as u64) < size)
        {
            self.link.fail(Failure::SizeMismatch);
            return;
        }
        self.link.out.push(ACK);
        self.link.retries = 0;
        self.eot_pending = false;
        self.files.push(ReceivedFile {
            name: file.name,
            declared_size: file.declared,
            data: file.data,
        });
        if self.batch {
            self.phase = RxPhase::Header;
            self.request_start();
        } else {
            self.link.status = Status::Done;
        }
    }
}
