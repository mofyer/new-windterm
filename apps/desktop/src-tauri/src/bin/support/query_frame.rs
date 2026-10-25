//! Strict query events over the shared bounded UTF-8/VT decoder.
use super::ready_frame::{valid_nonce, FrameProtocol, WireDecoder};

const MAX_TICKS: u64 = 300_000_000; // 30 seconds, in 1/10000 ms report units.
const MAX_CANDIDATE: usize = 84; // Entire event suffix; complete wire frame stays below 120.

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Diagnostic {
    pub stage: &'static str,
    pub reason: Option<&'static str>,
    pub frames: usize,
}
#[derive(Clone, Copy, Debug, PartialEq)]
enum Event {
    Ready,
    Start(usize),
    Query(usize, u64),
    Done,
    Failure(usize, &'static str),
    Observe(bool, bool, bool, Option<bool>),
    Verify(bool),
    EnvironmentError(bool),
}

// Prefix parsing reports incomplete input separately from an already invalid
// byte. We never wait for a later delimiter to rescue a malformed candidate.
#[derive(Debug)]
enum PrefixError {
    More,
    Invalid(&'static str),
}
struct Cursor<'a> {
    bytes: &'a [u8],
    at: usize,
}
impl Cursor<'_> {
    fn byte(&mut self) -> Result<u8, PrefixError> {
        let value = *self.bytes.get(self.at).ok_or(PrefixError::More)?;
        self.at += 1;
        Ok(value)
    }
    fn literal(&mut self, expected: &[u8], reason: &'static str) -> Result<(), PrefixError> {
        for &byte in expected {
            if self.byte()? != byte {
                return Err(PrefixError::Invalid(reason));
            }
        }
        Ok(())
    }
    fn boolean(&mut self) -> Result<bool, PrefixError> {
        match self.byte()? {
            b'0' => Ok(false),
            b'1' => Ok(true),
            _ => Err(PrefixError::Invalid("invalid-frame")),
        }
    }
    fn phase(&mut self) -> Result<usize, PrefixError> {
        match self.byte()? {
            b'1' => Ok(1),
            b'2' => Ok(2),
            _ => Err(PrefixError::Invalid("invalid-frame")),
        }
    }
    fn digits(
        &mut self,
        delimiter: u8,
        max: usize,
        reason: &'static str,
    ) -> Result<u64, PrefixError> {
        let mut value = 0;
        let mut count = 0;
        loop {
            let byte = self.byte()?;
            if byte == delimiter && count > 0 {
                return Ok(value);
            }
            if !byte.is_ascii_digit() || count == max {
                return Err(PrefixError::Invalid(reason));
            }
            count += 1;
            value = value * 10 + u64::from(byte - b'0');
        }
    }
}
fn event_prefix(bytes: &[u8], end: &[u8]) -> Result<Event, PrefixError> {
    let mut c = Cursor { bytes, at: 0 };
    let event = match c.byte()? {
        b'R' => {
            c.literal(b"|5.1.", "invalid-frame")?;
            c.digits(b'.', 10, "invalid-frame")?;
            c.digits(b'|', 10, "invalid-frame")?;
            Event::Ready
        }
        b'S' => {
            c.literal(b"|", "invalid-frame")?;
            let phase = c.phase()?;
            c.literal(b"|", "invalid-frame")?;
            Event::Start(phase)
        }
        b'Q' => {
            c.literal(b"|", "invalid-frame")?;
            let phase = c.phase()?;
            c.literal(b"|", "invalid-frame")?;
            let integer = c.digits(b'.', 5, "invalid-number")?;
            let mut fraction = 0;
            for _ in 0..4 {
                let byte = c.byte()?;
                if !byte.is_ascii_digit() {
                    return Err(PrefixError::Invalid("invalid-number"));
                }
                fraction = fraction * 10 + u64::from(byte - b'0');
            }
            c.literal(b"|", "invalid-number")?;
            c.literal(b"1|", "invalid-frame")?;
            Event::Query(phase, integer * 10_000 + fraction)
        }
        b'D' => {
            c.literal(b"|", "invalid-frame")?;
            Event::Done
        }
        b'O' => {
            c.literal(b"|", "invalid-frame")?;
            let present = c.boolean()?;
            c.literal(b"|", "invalid-frame")?;
            let nonempty = c.boolean()?;
            c.literal(b"|", "invalid-frame")?;
            let valid = c.boolean()?;
            c.literal(b"|", "invalid-frame")?;
            let equal = match c.byte()? {
                b'0' => Some(false),
                b'1' => Some(true),
                b'x' => None,
                _ => return Err(PrefixError::Invalid("invalid-frame")),
            };
            c.literal(b"|", "invalid-frame")?;
            Event::Observe(present, nonempty, valid, equal)
        }
        b'V' => {
            c.literal(b"|", "invalid-frame")?;
            let verified = c.boolean()?;
            c.literal(b"|", "invalid-frame")?;
            Event::Verify(verified)
        }
        b'E' => {
            c.literal(b"|", "invalid-frame")?;
            let assignment = match c.byte()? {
                b'r' => {
                    c.literal(b"ead|", "invalid-frame")?;
                    false
                }
                b'a' => {
                    c.literal(b"ssign|", "invalid-frame")?;
                    true
                }
                _ => return Err(PrefixError::Invalid("invalid-frame")),
            };
            Event::EnvironmentError(assignment)
        }
        b'X' => {
            c.literal(b"|", "invalid-frame")?;
            let phase = c.phase()?;
            c.literal(b"|c", "invalid-frame")?;
            let reason = match c.byte()? {
                b'o' => {
                    c.literal(b"mmand|", "invalid-frame")?;
                    "command-error"
                }
                b'w' => {
                    c.literal(b"d|", "invalid-frame")?;
                    "cwd-mismatch"
                }
                _ => return Err(PrefixError::Invalid("invalid-frame")),
            };
            Event::Failure(phase, reason)
        }
        _ => return Err(PrefixError::Invalid("invalid-frame")),
    };
    c.literal(end, "invalid-frame")?;
    Ok(event)
}

struct QueryProtocol {
    begin: Vec<u8>,
    end: Vec<u8>,
    prefix: usize,
    candidate: Option<Vec<u8>>,
    ready_armed: bool,
    query_armed: bool,
    frames: usize,
    queries: [Option<u64>; 2],
    runtime: bool,
    assignment_armed: bool,
    observation: Option<(bool, bool, Option<bool>)>,
    assignment_verified: Option<bool>,
}
impl QueryProtocol {
    fn stage(&self) -> &'static str {
        if self.runtime {
            match self.frames {
                0 => "await-frame",
                1 if !self.query_armed => "after-ready",
                1 => "await-observation",
                2 if !self.assignment_armed => "after-observation",
                2 => "await-assignment",
                3 => "await-start-1",
                4 => "await-result-1",
                5 => "await-start-2",
                6 => "await-result-2",
                7 => "await-end",
                _ => "after-end",
            }
        } else {
            match self.frames {
                0 => "await-frame",
                1 if !self.query_armed => "after-ready",
                1 => "await-start-1",
                2 => "await-result-1",
                3 => "await-start-2",
                4 => "await-result-2",
                5 => "await-end",
                _ => "after-end",
            }
        }
    }
    fn accept(&mut self, event: Event) -> Result<(), &'static str> {
        if !self.ready_armed
            || (self.frames > 0 && !self.query_armed)
            || (self.runtime && self.frames == 2 && !self.assignment_armed)
        {
            return Err("unexpected-frame");
        }
        let offset = if self.runtime { 2 } else { 0 };
        let index = match event {
            Event::Ready => 0,
            Event::Start(phase) => phase * 2 - 1 + offset,
            Event::Query(phase, _) => phase * 2 + offset,
            Event::Done => 5 + offset,
            Event::Observe(present, nonempty, valid, equal) => {
                if !self.runtime || self.frames != 1 {
                    return Err("unexpected-record");
                }
                // Only canonical states are meaningful; unknown equality never means false.
                if !matches!(
                    (present, nonempty, valid, equal),
                    (false, false, true, None)
                        | (true, false, true, None)
                        | (true, true, false, None)
                        | (true, true, true, Some(_))
                ) {
                    return Err("invalid-frame");
                }
                self.observation = Some((present, nonempty, equal));
                self.frames += 1; // A full observation frame, even if no usable contrast exists.
                if !valid {
                    return Err("environment-invalid");
                }
                if !nonempty || equal == Some(true) {
                    return Err("contrast-absent");
                }
                return Ok(());
            }
            Event::Verify(verified) => {
                if !self.runtime || self.frames != 2 {
                    return Err("unexpected-record");
                }
                self.assignment_verified = Some(verified);
                if !verified {
                    return Err("assignment-failed");
                }
                2
            }
            Event::EnvironmentError(assignment) => {
                if !self.runtime || self.frames != if assignment { 2 } else { 1 } {
                    return Err("unexpected-record");
                }
                return Err(if assignment {
                    "assignment-failed"
                } else {
                    "environment-read-error"
                });
            }
            Event::Failure(phase, reason) => {
                if self.frames != phase * 2 + offset {
                    return Err("unexpected-record");
                }
                return Err(reason);
            }
        };
        if index < self.frames {
            return Err("duplicate-record");
        }
        if index != self.frames {
            return Err("unexpected-record");
        }
        if let Event::Query(phase, ticks) = event {
            if ticks > MAX_TICKS || ticks + self.queries[0].unwrap_or(0) > MAX_TICKS {
                return Err("timing-bound");
            }
            self.queries[phase - 1] = Some(ticks);
        }
        self.frames += 1;
        Ok(())
    }
}
impl FrameProtocol for QueryProtocol {
    fn candidate(&self) -> bool {
        self.candidate.is_some()
    }
    fn boundary(&mut self) {
        self.prefix = 0;
    }
    fn text(&mut self, byte: u8) -> Result<(), &'static str> {
        if let Some(candidate) = &mut self.candidate {
            if candidate.len() == MAX_CANDIDATE {
                return Err("invalid-frame");
            }
            if !self.runtime && candidate.is_empty() && matches!(byte, b'O' | b'V' | b'E') {
                return Err("invalid-frame");
            }
            candidate.push(byte);
            match event_prefix(candidate, &self.end) {
                Ok(event) => {
                    self.candidate = None;
                    self.accept(event)?;
                }
                Err(PrefixError::More) => {}
                Err(PrefixError::Invalid(reason)) => return Err(reason),
            }
        } else {
            self.prefix = if byte == self.begin[self.prefix] {
                self.prefix + 1
            } else {
                usize::from(byte == b'~')
            };
            if self.prefix == self.begin.len() {
                self.prefix = 0;
                if self.frames == if self.runtime { 8 } else { 6 } {
                    return Err("duplicate-frame");
                }
                self.candidate = Some(Vec::new());
            }
        }
        Ok(())
    }
}

pub struct QueryParser {
    wire: WireDecoder,
    protocol: QueryProtocol,
    failure: Option<Diagnostic>,
}
impl QueryParser {
    pub fn new(nonce: &str) -> Self {
        let valid = valid_nonce(nonce);
        let mut parser = Self {
            wire: WireDecoder::default(),
            protocol: QueryProtocol {
                begin: if valid {
                    format!("~B{nonce}|").into_bytes()
                } else {
                    Vec::new()
                },
                end: if valid {
                    format!("E{nonce}~").into_bytes()
                } else {
                    Vec::new()
                },
                prefix: 0,
                candidate: None,
                ready_armed: false,
                query_armed: false,
                frames: 0,
                queries: [None, None],
                runtime: false,
                assignment_armed: false,
                observation: None,
                assignment_verified: None,
            },
            failure: None,
        };
        if !valid {
            parser.record_failure("invalid-frame");
        }
        parser
    }
    pub fn runtime(nonce: &str) -> Self {
        let mut parser = Self::new(nonce);
        parser.protocol.runtime = true;
        parser
    }
    pub fn observation(&self) -> Option<(bool, bool, Option<bool>)> {
        self.protocol.observation
    }
    pub fn assignment_verified(&self) -> Option<bool> {
        self.protocol.assignment_verified
    }
    pub fn ended(&self) -> bool {
        self.protocol.frames == if self.protocol.runtime { 8 } else { 6 }
    }
    pub fn arm_assignment(&mut self) -> Result<(), &'static str> {
        if self.failure.is_some() {
            return Err(self.error());
        }
        if !self.protocol.runtime || self.protocol.frames != 2 || self.protocol.assignment_armed {
            self.record_failure("unexpected-frame");
            return Err(self.error());
        }
        self.protocol.assignment_armed = true;
        Ok(())
    }
    pub fn arm_ready(&mut self) {
        self.protocol.ready_armed = true;
    }
    pub fn arm_query(&mut self) -> Result<(), &'static str> {
        if self.failure.is_some() {
            return Err(self.error());
        }
        if self.protocol.frames != 1 || self.protocol.query_armed {
            self.record_failure("unexpected-frame");
            return Err(self.error());
        }
        self.protocol.query_armed = true;
        Ok(())
    }
    pub fn diagnostic(&self) -> Diagnostic {
        self.failure.unwrap_or(Diagnostic {
            stage: self.protocol.stage(),
            reason: None,
            frames: self.protocol.frames,
        })
    }
    pub fn queries(&self) -> [Option<f64>; 2] {
        self.protocol
            .queries
            .map(|q| q.map(|n| n as f64 / 10_000.0))
    }
    pub fn record_failure(&mut self, reason: &'static str) {
        if self.failure.is_none() {
            self.failure = Some(Diagnostic {
                reason: Some(reason),
                ..self.diagnostic()
            });
        }
    }
    fn error(&self) -> &'static str {
        match self.failure.and_then(|d| d.reason) {
            Some("output-limit") => "output-limit",
            Some("cwd-mismatch") => "cwd-mismatch",
            Some("command-error") => "command-error",
            Some("contrast-absent") => "contrast-absent",
            Some("environment-invalid") => "environment-invalid",
            Some("environment-read-error") => "environment-read-error",
            Some("assignment-failed") => "assignment-failed",
            _ => "protocol-error",
        }
    }
    pub fn push(&mut self, input: &[u8]) -> Result<usize, &'static str> {
        if self.failure.is_some() {
            return Err(self.error());
        }
        match self.wire.push(input, &mut self.protocol) {
            Ok(cpr) => Ok(cpr),
            Err(reason) => {
                self.record_failure(reason);
                Err(self.error())
            }
        }
    }
    pub fn finish(&mut self) -> Result<(), &'static str> {
        if self.failure.is_some() {
            return Err(self.error());
        }
        let result = self.wire.finish().and_then(|()| {
            if self.protocol.candidate() || self.protocol.prefix != 0 {
                Err("incomplete-frame")
            } else {
                Ok(())
            }
        });
        if let Err(reason) = result {
            self.record_failure(reason);
            return Err(self.error());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const NONCE: &str = "0123456789abcdef0123456789abcdef";
    fn frame(payload: &str) -> String {
        format!("~B{NONCE}|{payload}|E{NONCE}~")
    }
    fn ready() -> QueryParser {
        let mut p = QueryParser::new(NONCE);
        p.arm_ready();
        p.push(frame("R|5.1.1.1").as_bytes()).unwrap();
        p.arm_query().unwrap();
        p
    }
    fn stream(q1: &str, q2: &str) -> String {
        [
            "S|1".into(),
            format!("Q|1|{q1}|1"),
            "S|2".into(),
            format!("Q|2|{q2}|1"),
            "D".into(),
        ]
        .iter()
        .map(|s| frame(s))
        .collect()
    }
    fn partitions(input: &[u8], reason: Option<&str>, frames: usize) {
        let mut baseline = ready();
        let _ = baseline.push(input);
        let _ = baseline.finish();
        assert_eq!(baseline.diagnostic().reason, reason);
        assert_eq!(baseline.diagnostic().frames, frames);
        for cut in 0..=input.len() {
            let mut p = ready();
            let _ = p.push(&input[..cut]);
            let _ = p.push(&input[cut..]);
            let _ = p.finish();
            assert_eq!(p.diagnostic(), baseline.diagnostic(), "split {cut}");
            assert_eq!(p.queries(), baseline.queries());
        }
        let mut p = ready();
        for byte in input {
            let _ = p.push(&[*byte]);
        }
        let _ = p.finish();
        assert_eq!(p.diagnostic(), baseline.diagnostic());
        assert_eq!(p.queries(), baseline.queries());
    }
    #[test]
    fn valid_stream_all_splits_and_fixed_point_boundaries() {
        for (a, b) in [
            ("0.0000", "0.0000"),
            ("12.5000", "0.2500"),
            ("30000.0000", "0.0000"),
            ("29999.9999", "0.0001"),
        ] {
            partitions(format!("中PS> {} suffix", stream(a, b)).as_bytes(), None, 6);
        }
        for payload in [
            "R|5.1.9999999999.9999999999",
            "Q|1|30000.0000|1",
            "X|1|command",
        ] {
            assert!(frame(payload).len() < 120);
        }
    }
    #[test]
    fn timing_and_numeric_grammar_fail_without_accepting_query() {
        for value in [
            "-1.0000",
            "NaN",
            "1e1",
            "1",
            ".0000",
            "000001.0000",
            "1.000",
            "1.00000",
            "+1.0000",
        ] {
            partitions(
                format!("{}{}", frame("S|1"), frame(&format!("Q|1|{value}|1"))).as_bytes(),
                Some("invalid-number"),
                2,
            );
        }
        partitions(
            stream("30000.0001", "0.0000").as_bytes(),
            Some("timing-bound"),
            2,
        );
        partitions(
            stream("30000.0000", "0.0001").as_bytes(),
            Some("timing-bound"),
            4,
        );
    }
    #[test]
    fn order_duplicate_error_phase_and_partial_results_are_strict() {
        partitions(
            frame("Q|1|1.0000|1").as_bytes(),
            Some("unexpected-record"),
            1,
        );
        partitions(
            format!("{}{}", frame("S|1"), frame("S|1")).as_bytes(),
            Some("duplicate-record"),
            2,
        );
        partitions(
            format!("{}{}", frame("S|1"), frame("X|2|command")).as_bytes(),
            Some("unexpected-record"),
            2,
        );
        partitions(
            frame("X|1|command").as_bytes(),
            Some("unexpected-record"),
            1,
        );
        partitions(
            format!("{}{}", frame("S|1"), frame("X|1|cwd")).as_bytes(),
            Some("cwd-mismatch"),
            2,
        );
        let input = format!(
            "{}{}{}{}",
            frame("S|1"),
            frame("Q|1|2.0000|1"),
            frame("S|2"),
            frame("X|2|command")
        );
        partitions(input.as_bytes(), Some("command-error"), 4);
        let mut p = ready();
        assert_eq!(p.push(input.as_bytes()), Err("command-error"));
        assert_eq!(p.queries(), [Some(2.0), None]);
        let frozen = p.diagnostic();
        p.record_failure("cleanup-failed");
        assert!(p.push(stream("1.0000", "1.0000").as_bytes()).is_err());
        assert_eq!(p.diagnostic(), frozen);
    }
    #[test]
    fn host_query_gate_cannot_be_crossed_in_one_push() {
        let mut p = QueryParser::new(NONCE);
        p.arm_ready();
        assert!(p
            .push(format!("{}{}", frame("R|5.1.1.1"), frame("S|1")).as_bytes())
            .is_err());
        assert_eq!(p.diagnostic().reason, Some("unexpected-frame"));
        assert_eq!(p.diagnostic().frames, 1);
        assert!(p.arm_query().is_err());
        let mut p = QueryParser::new(NONCE);
        assert!(p.push(frame("R|5.1.1.1").as_bytes()).is_err());
        assert_eq!(p.diagnostic().frames, 0);
    }
    #[test]
    fn candidates_reject_controls_nesting_and_all_partial_tails() {
        let payloads = ["S|1", "Q|1|1.0000|1", "S|2", "Q|2|1.0000|1", "D"];
        let mut prefix = String::new();
        for (i, payload) in payloads.iter().enumerate() {
            let wire = frame(payload);
            let begin = format!("~B{NONCE}|").len();
            for at in begin..wire.len() {
                for insert in ["\r", "\n", "\x1b[0m", "中", "\u{9b}"] {
                    partitions(
                        format!("{prefix}{}{insert}{}", &wire[..at], &wire[at..]).as_bytes(),
                        Some("frame-control"),
                        i + 1,
                    );
                }
            }
            for at in 1..wire.len() {
                partitions(
                    format!("{prefix}{}", &wire[..at]).as_bytes(),
                    Some("incomplete-frame"),
                    i + 1,
                );
            }
            prefix.push_str(&wire);
        }
        partitions(
            format!("~B{NONCE}|{}", frame("S|1")).as_bytes(),
            Some("invalid-frame"),
            1,
        );
    }
    #[test]
    fn hidden_frames_do_not_advance_and_cleanup_tail_remains_strict() {
        for open in ["\x1b]", "\x1bP", "\x1bX", "\x1b^", "\x1b_"] {
            let hidden = format!("{open}{}\x1b[6n\x1b\\", stream("1.0000", "1.0000"));
            partitions(
                format!("{hidden}{}", stream("1.0000", "1.0000")).as_bytes(),
                None,
                6,
            );
            partitions(
                format!("{}{hidden}", stream("1.0000", "1.0000")).as_bytes(),
                None,
                6,
            );
        }
        partitions(
            format!("{}~B{NONCE}|", stream("1.0000", "1.0000")).as_bytes(),
            Some("duplicate-frame"),
            6,
        );
        partitions(
            format!("{}\x1b]unfinished", stream("1.0000", "1.0000")).as_bytes(),
            Some("incomplete-control"),
            6,
        );
    }
    #[test]
    fn prefix_controls_utf8_cpr_and_output_limit_are_shared() {
        for control in ["\r", "\x1b[0m", "中"] {
            let f = frame("S|1");
            let input = format!("{}{control}{}", &f[..4], &f[4..]);
            partitions(input.as_bytes(), Some("incomplete-frame"), 1);
        }
        let mut p = ready();
        assert_eq!(p.push(b"\x1b[6"), Ok(0));
        assert_eq!(p.push(b"n"), Ok(1));
        assert_eq!(p.push(&[0x9b]), Err("protocol-error"));
        assert_eq!(p.diagnostic().reason, Some("invalid-utf8"));
        let mut p = ready();
        assert_eq!(
            p.push(&vec![b'x'; super::super::ready_frame::OUTPUT_LIMIT]),
            Err("output-limit")
        );
        let mut p = QueryParser::new("bad");
        assert!(p.push(b"x").is_err());
    }
    fn runtime_ready() -> QueryParser {
        let mut p = QueryParser::runtime(NONCE);
        p.arm_ready();
        p.push(frame("R|5.1.1.1").as_bytes()).unwrap();
        p.arm_query().unwrap();
        p
    }
    #[test]
    fn runtime_observation_canonical_states_and_first_error_all_splits() {
        for (payload, expected, observation) in [
            (
                "O|0|0|1|x",
                Some("contrast-absent"),
                Some((false, false, None)),
            ),
            (
                "O|1|0|1|x",
                Some("contrast-absent"),
                Some((true, false, None)),
            ),
            (
                "O|1|1|0|x",
                Some("environment-invalid"),
                Some((true, true, None)),
            ),
            (
                "O|1|1|1|1",
                Some("contrast-absent"),
                Some((true, true, Some(true))),
            ),
            ("O|1|1|1|0", None, Some((true, true, Some(false)))),
        ] {
            let text = frame(payload);
            for cut in (0..=text.len()).map(Some).chain(std::iter::once(None)) {
                let mut p = runtime_ready();
                match cut {
                    Some(cut) => {
                        let _ = p.push(&text.as_bytes()[..cut]);
                        let _ = p.push(&text.as_bytes()[cut..]);
                    }
                    None => {
                        for byte in text.bytes() {
                            let _ = p.push(&[byte]);
                        }
                    }
                }
                assert_eq!(p.diagnostic().frames, 2);
                assert_eq!(p.diagnostic().stage, "after-observation");
                assert_eq!(p.diagnostic().reason, expected);
                assert_eq!(p.observation(), observation);
                if expected.is_some() {
                    assert!(p.arm_assignment().is_err());
                }
            }
        }
        for payload in [
            "O|0|1|1|x",
            "O|0|0|0|x",
            "O|1|0|1|0",
            "O|1|1|0|0",
            "O|1|1|1|x",
        ] {
            let mut p = runtime_ready();
            assert!(p.push(frame(payload).as_bytes()).is_err());
            assert_eq!(p.diagnostic().reason, Some("invalid-frame"));
            assert_eq!(p.diagnostic().frames, 1);
            assert_eq!(p.observation(), None);
        }
    }
    #[test]
    fn runtime_gate_assignment_and_query_prefix_are_strict_all_splits() {
        let mut early = runtime_ready();
        assert!(early
            .push(format!("{}{}", frame("O|1|1|1|0"), frame("V|1")).as_bytes())
            .is_err());
        assert_eq!(early.diagnostic().frames, 2);
        assert_eq!(early.diagnostic().reason, Some("unexpected-frame"));
        let stream = format!("{}{}", frame("V|1"), stream("12.5000", "0.2500"));
        for cut in (0..=stream.len()).map(Some).chain(std::iter::once(None)) {
            let mut p = runtime_ready();
            p.push(frame("O|1|1|1|0").as_bytes()).unwrap();
            p.arm_assignment().unwrap();
            match cut {
                Some(cut) => {
                    p.push(&stream.as_bytes()[..cut]).unwrap();
                    p.push(&stream.as_bytes()[cut..]).unwrap();
                }
                None => {
                    for byte in stream.bytes() {
                        p.push(&[byte]).unwrap();
                    }
                }
            }
            p.finish().unwrap();
            assert_eq!(p.diagnostic().frames, 8);
            assert!(p.ended());
            assert_eq!(p.assignment_verified(), Some(true));
            assert_eq!(p.queries(), [Some(12.5), Some(0.25)]);
            assert!(p.push(frame("D").as_bytes()).is_err());
            assert_eq!(p.diagnostic().reason, Some("duplicate-frame"));
            assert_eq!(p.diagnostic().frames, 8);
        }
        for payload in ["S|1", "V|0", "E|assign"] {
            let mut p = runtime_ready();
            p.push(frame("O|1|1|1|0").as_bytes()).unwrap();
            p.arm_assignment().unwrap();
            assert!(p.push(frame(payload).as_bytes()).is_err());
            assert_eq!(p.diagnostic().frames, 2);
            assert_eq!(
                p.assignment_verified(),
                if payload == "V|0" { Some(false) } else { None }
            );
            assert_eq!(
                p.diagnostic().reason,
                Some(if payload == "S|1" {
                    "unexpected-record"
                } else {
                    "assignment-failed"
                })
            );
        }
        let mut p = runtime_ready();
        assert_eq!(
            p.push(frame("E|read").as_bytes()),
            Err("environment-read-error")
        );
        assert_eq!(p.observation(), None);
        assert_eq!(p.diagnostic().frames, 1);
    }
    #[test]
    fn runtime_control_opaque_truncation_and_legacy_grammar_stay_closed() {
        for payload in ["O|1|1|1|0", "V|1", "E|read", "E|assign"] {
            let mut legacy = ready();
            assert!(legacy.push(frame(payload).as_bytes()).is_err());
            assert_eq!(legacy.diagnostic().reason, Some("invalid-frame"));
        }
        let wire = frame("O|1|1|1|0");
        for at in 1..wire.len() {
            let mut p = runtime_ready();
            p.push(&wire.as_bytes()[..at]).unwrap();
            assert!(p.finish().is_err());
            assert_eq!(p.diagnostic().reason, Some("incomplete-frame"));
        }
        for open in ["\x1b]", "\x1bP", "\x1bX", "\x1b^", "\x1b_"] {
            let mut p = runtime_ready();
            p.push(format!("{open}{wire}\x1b\\").as_bytes()).unwrap();
            assert_eq!(p.diagnostic().frames, 1);
            assert_eq!(p.observation(), None);
        }
        for at in format!("~B{NONCE}|").len()..wire.len() {
            for control in ["\r", "\n", "\x1b[0m", "中"] {
                let mut p = runtime_ready();
                assert!(p
                    .push(format!("{}{control}{}", &wire[..at], &wire[at..]).as_bytes())
                    .is_err());
                assert_eq!(p.diagnostic().reason, Some("frame-control"));
            }
        }
    }
}
