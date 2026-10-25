//! Bounded READY event framing for the diagnostic only, not a terminal screen.
//! All text is consumed in memory; diagnostics contain fixed labels and counts.

pub const OUTPUT_LIMIT: usize = 256 * 1024;
const ESCAPE_LIMIT: usize = 64;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct FrameCounters {
    pub cr: usize,
    pub lf: usize,
    pub csi_cursor: usize,
    pub csi_erase: usize,
    pub frames: usize,
    pub duplicates: usize,
    pub control_strings: usize,
}

#[cfg(test)]
mod tests {
    use super::*;
    const NONCE: &str = "0123456789abcdef0123456789abcdef";

    fn frame() -> String {
        format!("~B{NONCE}|R|5.1.20348.5622|E{NONCE}~")
    }
    fn armed() -> FrameParser {
        let mut parser = FrameParser::new(NONCE);
        parser.arm();
        parser
    }
    fn feed(input: &[u8], chunks: &[usize]) -> (FrameParser, Result<(), &'static str>, usize) {
        let mut parser = armed();
        let mut start = 0;
        let mut cpr = 0;
        let mut result = Ok(());
        for &end in chunks {
            match parser.push(&input[start..end]) {
                Ok(count) => cpr += count,
                Err(reason) => {
                    result = Err(reason);
                    break;
                }
            }
            start = end;
        }
        if result.is_ok() {
            result = parser.finish();
        }
        (parser, result, cpr)
    }
    fn all_partitions(input: &[u8], expected: Option<&str>, seen: bool) {
        let (baseline, baseline_result, cpr) = feed(input, &[input.len()]);
        assert_eq!(baseline.diagnostic().reason, expected, "whole input");
        assert_eq!(baseline.seen(), seen);
        for cut in 0..=input.len() {
            let (split, result, count) = feed(input, &[cut, input.len()]);
            assert_eq!(result, baseline_result, "cut {cut}");
            assert_eq!(split.diagnostic(), baseline.diagnostic(), "cut {cut}");
            assert_eq!(split.seen(), seen, "cut {cut}");
            if result.is_ok() {
                assert_eq!(count, cpr);
            }
        }
        let bytewise: Vec<_> = (1..=input.len()).collect();
        let (split, result, count) = feed(input, &bytewise);
        assert_eq!(result, baseline_result);
        assert_eq!(split.diagnostic(), baseline.diagnostic());
        assert_eq!(split.seen(), seen);
        if result.is_ok() {
            assert_eq!(count, cpr);
        }
    }

    #[test]
    fn continuous_events_allow_prefix_suffix_and_unicode_at_all_splits() {
        for input in [
            frame(),
            format!("PS> {} prompt", frame()),
            format!("中文🙂{}é", frame()),
            format!("\x1b[6n\x1b[2;1H{}\x1b[0m\r\n", frame()),
        ] {
            all_partitions(input.as_bytes(), None, true);
        }
    }

    #[test]
    fn valid_minimum_and_maximum_versions_are_bounded() {
        for version in ["0.0", "0000000000.9999999999"] {
            all_partitions(
                format!("~B{NONCE}|R|5.1.{version}|E{NONCE}~").as_bytes(),
                None,
                true,
            );
        }
    }

    #[test]
    fn malformed_candidates_fail_permanently_at_all_splits() {
        let valid = frame();
        for input in [
            valid.replace("R|5.1.", "X|5.1."),
            valid.replace("5.1.", "7.1."),
            valid.replace("20348", ""),
            valid.replace("20348", "12345678901"),
            valid.replace("5622", ""),
            valid.replace("5622", "12345678901"),
            valid.replace("|E", "|extra|E"),
            valid.replace(&format!("E{NONCE}"), "Ewrong"),
            format!("~B{NONCE}|{}", valid),
        ] {
            all_partitions(input.as_bytes(), Some("invalid-frame"), false);
            let mut parser = armed();
            assert!(parser.push(input.as_bytes()).is_err());
            let first = parser.diagnostic();
            assert!(parser.push(valid.as_bytes()).is_err());
            assert_eq!(parser.diagnostic(), first);
            assert!(!parser.seen());
        }
    }

    #[test]
    fn every_candidate_truncation_and_tail_prefix_fails() {
        let valid = frame();
        for end in 1..valid.len() {
            all_partitions(&valid.as_bytes()[..end], Some("incomplete-frame"), false);
        }
        all_partitions(
            format!("{}~B", valid).as_bytes(),
            Some("incomplete-frame"),
            true,
        );
    }

    #[test]
    fn control_or_non_ascii_inside_candidate_is_never_stripped() {
        let valid = frame();
        let begin_len = format!("~B{NONCE}|").len();
        for position in begin_len..valid.len() {
            for inserted in [
                "\r",
                "\n",
                "\t",
                "\x08",
                "\x7f",
                "\x1b[0m",
                "\x1b]x\x07",
                "\x1bPignored\x1b\\",
                "é",
                "\u{9b}",
            ] {
                let input = format!("{}{}{}", &valid[..position], inserted, &valid[position..]);
                all_partitions(input.as_bytes(), Some("frame-control"), false);
            }
        }
    }

    #[test]
    fn partial_prefix_cannot_cross_controls_or_unicode() {
        let valid = frame();
        let begin_len = format!("~B{NONCE}|").len();
        for position in 1..begin_len {
            for inserted in ["\r", "\n", "\x1b[0m", "\x1b]hidden\x07", "中"] {
                let input = format!("{}{}{}", &valid[..position], inserted, &valid[position..]);
                // The final '~' begins a possible next prefix; finish must reject
                // it rather than accepting the broken original token.
                all_partitions(input.as_bytes(), Some("incomplete-frame"), false);
            }
        }
    }

    #[test]
    fn opaque_control_strings_never_supply_frames_or_cpr() {
        for (open, end) in [
            ("\x1b]", "\x07"),
            ("\x1b]", "\x1b\\"),
            ("\x1bP", "\x1b\\"),
            ("\x1bX", "\x1b\\"),
            ("\x1b^", "\x1b\\"),
            ("\x1b_", "\x1b\\"),
        ] {
            let hidden = format!("{open}中文{}\x1b[6n{end}", frame());
            all_partitions(hidden.as_bytes(), None, false);
            all_partitions(format!("{hidden}{}", frame()).as_bytes(), None, true);
            all_partitions(
                format!("{open}{}", frame()).as_bytes(),
                Some("incomplete-control"),
                false,
            );
        }
    }

    #[test]
    fn opaque_escape_without_st_does_not_release_hidden_text() {
        for open in ["\x1b]", "\x1bP", "\x1bX", "\x1b^", "\x1b_"] {
            let hidden = format!("{open}\x1bZ{}\x1b\\", frame());
            all_partitions(hidden.as_bytes(), None, false);
        }
    }

    #[test]
    fn control_string_cancel_is_explicit_and_resets_prefix() {
        for open in ["\x1b]", "\x1bP", "\x1bX", "\x1b^", "\x1b_"] {
            for cancel in ["\x18", "\x1a"] {
                all_partitions(
                    format!("~B{open}hidden{cancel}{}", frame()).as_bytes(),
                    None,
                    true,
                );
            }
        }
    }

    #[test]
    fn malformed_or_incomplete_utf8_and_c1_fail_closed() {
        for bytes in [
            vec![0x9b],
            vec![0xc0, 0xaf],
            vec![0xed, 0xa0, 0x80],
            vec![0xf4, 0x90, 0x80, 0x80],
            vec![0xc2],
            vec![0xe4, 0xb8],
            vec![0xf0, 0x9f, 0x99],
            vec![0xc2, b'a'],
        ] {
            all_partitions(&bytes, Some("invalid-utf8"), false);
        }
        for code in ['\u{80}', '\u{90}', '\u{9b}', '\u{9d}', '\u{9c}', '\u{9f}'] {
            all_partitions(
                format!("{code}{}", frame()).as_bytes(),
                Some("unsupported-control"),
                false,
            );
        }
    }

    #[test]
    fn ordinary_utf8_continuation_bytes_are_not_c1_controls() {
        // U+4E1B includes the continuation byte 0x9B; it is ordinary text.
        all_partitions(format!("丛{}", frame()).as_bytes(), None, true);
    }

    #[test]
    fn duplicate_frame_is_fatal_even_after_valid_prefix() {
        for tail in [frame(), format!("~B{NONCE}|")] {
            all_partitions(
                format!("{}{tail}", frame()).as_bytes(),
                Some("duplicate-frame"),
                true,
            );
        }
        let mut parser = armed();
        assert!(parser
            .push(format!("{}{}", frame(), frame()).as_bytes())
            .is_err());
        assert!(parser.seen());
        assert_eq!(parser.diagnostic().counters.frames, 1);
        assert_eq!(parser.diagnostic().counters.duplicates, 1);
        let first = parser.diagnostic();
        parser.record_failure("cleanup-failed");
        assert!(parser.push(b"more\r\n").is_err());
        assert_eq!(parser.diagnostic(), first);
    }

    #[test]
    fn seen_frame_followed_by_hidden_frame_is_not_a_duplicate() {
        for open in ["\x1b]", "\x1bP", "\x1bX", "\x1b^", "\x1b_"] {
            all_partitions(
                format!("{}{open}{}\x1b\\", frame(), frame()).as_bytes(),
                None,
                true,
            );
        }
    }

    #[test]
    fn continuous_wire_event_does_not_depend_on_screen_columns() {
        // Real xterm layout tests exercise these printable prefixes separately;
        // the protocol accepts an event, not one unwrapped screen row.
        for width in [20, 40, 100] {
            let input = format!("{}{}", " ".repeat(width - 2), frame());
            all_partitions(input.as_bytes(), None, true);
        }
    }

    #[test]
    fn arming_is_required_and_does_not_clear_a_prior_error() {
        let mut parser = FrameParser::new(NONCE);
        assert_eq!(parser.push(frame().as_bytes()), Err("protocol-error"));
        assert_eq!(parser.diagnostic().reason, Some("unexpected-frame"));
        assert!(!parser.seen());
        parser.arm();
        assert!(parser.push(frame().as_bytes()).is_err());
        assert!(!parser.seen());
        let mut parser = FrameParser::new(NONCE);
        assert_eq!(parser.push(b"PS>\x1b[6n"), Ok(1));
        parser.arm();
        assert!(parser.push(frame().as_bytes()).is_ok());
        assert!(parser.seen());
    }

    #[test]
    fn cpr_requires_complete_ground_csi_and_preserves_splits() {
        let input = format!("\x1b[6n\x1b[?6n\x1b[06n\x1b[6 n{}", frame());
        let (_, result, count) = feed(input.as_bytes(), &[input.len()]);
        assert!(result.is_ok());
        assert_eq!(count, 1);
        all_partitions(input.as_bytes(), None, true);
    }

    #[test]
    fn unknown_or_invalid_control_sequences_fail_closed() {
        for input in ["\x1bZ", "\x1b[1 2m", "\x1b[\x1bm", "\x1b(\r"] {
            all_partitions(input.as_bytes(), Some("unsupported-control"), false);
        }
        for input in ["\x1b", "\x1b[", "\x1b(", "\x1b]x\x1b"] {
            all_partitions(input.as_bytes(), Some("incomplete-control"), false);
        }
        all_partitions(format!("\x1b(B{}", frame()).as_bytes(), None, true);
    }

    #[test]
    fn bounds_are_enforced_without_retaining_output() {
        let mut parser = armed();
        assert!(parser.push(&vec![b'x'; OUTPUT_LIMIT]).is_ok());
        assert_eq!(parser.push(b"x"), Err("output-limit"));
        assert_eq!(parser.diagnostic().reason, Some("output-limit"));
        for control in [
            format!("\x1b[{}m", "0".repeat(65)),
            format!("\x1b{}B", "(".repeat(65)),
        ] {
            all_partitions(control.as_bytes(), Some("escape-limit"), false);
        }
        for nonce in ["", "bad", "0123456789ABCDEF0123456789ABCDEF"] {
            let mut parser = FrameParser::new(nonce);
            assert!(parser.push(frame().as_bytes()).is_err());
            assert_eq!(parser.diagnostic().reason, Some("invalid-frame"));
        }
    }

    #[test]
    fn old_markers_and_wrong_nonce_never_authorize_frame() {
        for input in [
            format!("P1Q_{NONCE}|READY|5.1.1.1\r\n"),
            NONCE.to_owned(),
            frame().replace(NONCE, "abcdef0123456789abcdef0123456789ab"),
        ] {
            let mut parser = armed();
            assert!(parser.push(input.as_bytes()).is_ok());
            assert!(!parser.seen());
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FrameDiagnostic {
    pub stage: &'static str,
    pub reason: Option<&'static str>,
    pub counters: FrameCounters,
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum Vt {
    Ground,
    Esc,
    EscIntermediate(usize),
    Csi(Vec<u8>),
    Osc,
    OscEsc,
    Opaque,
    OpaqueEsc,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Frame {
    Seeking,
    Payload(usize),
    Build(usize),
    Revision(usize),
    End(usize),
}

pub(crate) trait FrameProtocol {
    fn candidate(&self) -> bool;
    fn boundary(&mut self);
    fn text(&mut self, byte: u8) -> Result<(), &'static str>;
}

// Both diagnostic protocols consume the same incremental UTF-8/VT stream.
// The consumer sees printable ground bytes only; candidates cannot cross controls.
pub(crate) struct WireDecoder {
    vt: Vt,
    utf8: [u8; 4],
    utf8_len: usize,
    utf8_need: usize,
    bytes: usize,
    counters: FrameCounters,
}
impl Default for WireDecoder {
    fn default() -> Self {
        Self {
            vt: Vt::Ground,
            utf8: [0; 4],
            utf8_len: 0,
            utf8_need: 0,
            bytes: 0,
            counters: FrameCounters::default(),
        }
    }
}
fn increment(counter: &mut usize) {
    *counter = counter.saturating_add(1).min(OUTPUT_LIMIT);
}
pub(crate) fn valid_nonce(nonce: &str) -> bool {
    nonce.len() == 32
        && nonce
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
impl WireDecoder {
    /// Returns only complete, ground-state CSI 6 n requests consumed by this call.
    pub(crate) fn push<P: FrameProtocol>(
        &mut self,
        input: &[u8],
        protocol: &mut P,
    ) -> Result<usize, &'static str> {
        let mut cpr = 0;
        for &byte in input {
            self.bytes += 1;
            if self.bytes > OUTPUT_LIMIT {
                return Err("output-limit");
            }
            if byte == b'\r' {
                increment(&mut self.counters.cr);
            }
            if byte == b'\n' {
                increment(&mut self.counters.lf);
            }
            if self.utf8_need != 0 {
                if !(0x80..=0xbf).contains(&byte) {
                    return Err("invalid-utf8");
                }
                self.utf8[self.utf8_len] = byte;
                self.utf8_len += 1;
                if self.utf8_len == self.utf8_need {
                    let character = std::str::from_utf8(&self.utf8[..self.utf8_need])
                        .ok()
                        .and_then(|text| text.chars().next());
                    self.utf8_len = 0;
                    self.utf8_need = 0;
                    match character {
                        Some(character) => cpr += self.character(character, protocol)?,
                        None => return Err("invalid-utf8"),
                    }
                }
            } else if byte.is_ascii() {
                cpr += self.character(char::from(byte), protocol)?;
            } else {
                self.utf8_need = match byte {
                    0xc2..=0xdf => 2,
                    0xe0..=0xef => 3,
                    0xf0..=0xf4 => 4,
                    _ => return Err("invalid-utf8"),
                };
                self.utf8[0] = byte;
                self.utf8_len = 1;
            }
        }
        Ok(cpr)
    }

    fn character<P: FrameProtocol>(
        &mut self,
        character: char,
        protocol: &mut P,
    ) -> Result<usize, &'static str> {
        if protocol.candidate() && (!character.is_ascii() || character.is_ascii_control()) {
            return Err("frame-control");
        }
        // Encoded C1 is a control, not ordinary Unicode text. The protocol
        // supports explicit 7-bit ESC controls only; never scan behind C1.
        if ('\u{80}'..='\u{9f}').contains(&character) {
            return Err("unsupported-control");
        }
        if !character.is_ascii() {
            protocol.boundary();
            return match self.vt {
                Vt::Ground | Vt::Osc | Vt::Opaque => Ok(0),
                _ => Err("unsupported-control"),
            };
        }
        let byte = character as u8;
        match self.vt.clone() {
            Vt::Ground => {
                if byte.is_ascii_control() {
                    protocol.boundary();
                    if byte == 0x1b {
                        self.vt = Vt::Esc;
                    }
                    return Ok(0);
                }
                protocol.text(byte)?;
            }
            Vt::Esc => {
                self.vt = match byte {
                    b'[' => Vt::Csi(Vec::new()),
                    b']' => {
                        increment(&mut self.counters.control_strings);
                        Vt::Osc
                    }
                    b'P' | b'X' | b'^' | b'_' => {
                        increment(&mut self.counters.control_strings);
                        Vt::Opaque
                    }
                    b'7' | b'8' | b'D' | b'E' | b'H' | b'M' | b'=' | b'>' | b'c' => Vt::Ground,
                    0x20..=0x2f => Vt::EscIntermediate(1),
                    _ => return Err("unsupported-control"),
                };
            }
            Vt::EscIntermediate(size) => {
                self.vt = match byte {
                    0x20..=0x2f if size < ESCAPE_LIMIT => Vt::EscIntermediate(size + 1),
                    0x20..=0x2f => return Err("escape-limit"),
                    0x30..=0x7e => Vt::Ground,
                    _ => return Err("unsupported-control"),
                };
            }
            Vt::Csi(mut sequence) => {
                if (0x40..=0x7e).contains(&byte) {
                    let cpr = usize::from(byte == b'n' && sequence == b"6");
                    if b"ABCDEFGHfade`".contains(&byte) {
                        increment(&mut self.counters.csi_cursor);
                    }
                    if matches!(byte, b'J' | b'K') {
                        increment(&mut self.counters.csi_erase);
                    }
                    self.vt = Vt::Ground;
                    return Ok(cpr);
                }
                if !(0x20..=0x3f).contains(&byte)
                    || ((0x30..=0x3f).contains(&byte)
                        && sequence.iter().any(|b| (0x20..=0x2f).contains(b)))
                {
                    return Err("unsupported-control");
                }
                if sequence.len() >= ESCAPE_LIMIT {
                    return Err("escape-limit");
                }
                sequence.push(byte);
                self.vt = Vt::Csi(sequence);
            }
            Vt::Osc | Vt::Opaque => {
                self.vt = match byte {
                    0x18 | 0x1a => Vt::Ground,
                    7 if self.vt == Vt::Osc => Vt::Ground,
                    0x1b if self.vt == Vt::Osc => Vt::OscEsc,
                    0x1b => Vt::OpaqueEsc,
                    _ => self.vt.clone(),
                };
            }
            Vt::OscEsc | Vt::OpaqueEsc => {
                self.vt = match byte {
                    b'\\' | 0x18 | 0x1a => Vt::Ground,
                    7 if self.vt == Vt::OscEsc => Vt::Ground,
                    0x1b => self.vt.clone(),
                    _ if self.vt == Vt::OscEsc => Vt::Osc,
                    _ => Vt::Opaque,
                };
            }
        }
        Ok(0)
    }

    pub(crate) fn finish(&self) -> Result<(), &'static str> {
        if self.utf8_need != 0 {
            return Err("invalid-utf8");
        }
        if self.vt != Vt::Ground {
            return Err("incomplete-control");
        }
        Ok(())
    }
}

struct ReadyProtocol {
    begin: Vec<u8>,
    end: Vec<u8>,
    prefix: usize,
    frame: Frame,
    armed: bool,
    seen: bool,
    counters: FrameCounters,
}
impl FrameProtocol for ReadyProtocol {
    fn candidate(&self) -> bool {
        self.frame != Frame::Seeking
    }
    fn boundary(&mut self) {
        self.prefix = 0;
    }
    fn text(&mut self, byte: u8) -> Result<(), &'static str> {
        match self.frame {
            Frame::Seeking => {
                if byte == self.begin[self.prefix] {
                    self.prefix += 1;
                } else {
                    self.prefix = usize::from(byte == b'~');
                }
                if self.prefix == self.begin.len() {
                    self.prefix = 0;
                    if self.seen {
                        increment(&mut self.counters.duplicates);
                        return Err("duplicate-frame");
                    }
                    self.frame = Frame::Payload(0);
                }
            }
            Frame::Payload(index) => {
                const PAYLOAD: &[u8] = b"R|5.1.";
                if byte != PAYLOAD[index] {
                    return Err("invalid-frame");
                }
                self.frame = if index + 1 == PAYLOAD.len() {
                    Frame::Build(0)
                } else {
                    Frame::Payload(index + 1)
                };
            }
            Frame::Build(digits) => {
                self.frame = match byte {
                    b'0'..=b'9' if digits < 10 => Frame::Build(digits + 1),
                    b'.' if digits > 0 => Frame::Revision(0),
                    _ => return Err("invalid-frame"),
                };
            }
            Frame::Revision(digits) => {
                self.frame = match byte {
                    b'0'..=b'9' if digits < 10 => Frame::Revision(digits + 1),
                    b'|' if digits > 0 => Frame::End(0),
                    _ => return Err("invalid-frame"),
                };
            }
            Frame::End(index) => {
                if byte != self.end[index] {
                    return Err("invalid-frame");
                }
                if index + 1 == self.end.len() {
                    if !self.armed {
                        return Err("unexpected-frame");
                    }
                    self.seen = true;
                    increment(&mut self.counters.frames);
                    self.frame = Frame::Seeking;
                } else {
                    self.frame = Frame::End(index + 1);
                }
            }
        }
        Ok(())
    }
}

pub struct FrameParser {
    decoder: WireDecoder,
    protocol: ReadyProtocol,
    first_failure: Option<FrameDiagnostic>,
}
impl FrameParser {
    pub fn new(nonce: &str) -> Self {
        let valid = valid_nonce(nonce);
        let mut parser = Self {
            decoder: WireDecoder::default(),
            protocol: ReadyProtocol {
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
                frame: Frame::Seeking,
                armed: false,
                seen: false,
                counters: FrameCounters::default(),
            },
            first_failure: None,
        };
        if !valid {
            parser.record_failure("invalid-frame");
        }
        parser
    }
    pub fn arm(&mut self) {
        self.protocol.armed = true;
    }
    /// Historical acceptance only: a later duplicate/tail failure remains fatal.
    pub fn seen(&self) -> bool {
        self.protocol.seen
    }
    pub fn diagnostic(&self) -> FrameDiagnostic {
        let mut counters = self.decoder.counters;
        counters.frames = self.protocol.counters.frames;
        counters.duplicates = self.protocol.counters.duplicates;
        self.first_failure.unwrap_or(FrameDiagnostic {
            stage: if self.seen() {
                "after-frame"
            } else {
                "await-frame"
            },
            reason: None,
            counters,
        })
    }
    pub fn record_failure(&mut self, reason: &'static str) {
        if self.first_failure.is_none() {
            let mut diagnostic = self.diagnostic();
            diagnostic.reason = Some(reason);
            self.first_failure = Some(diagnostic);
        }
    }
    fn error(&self) -> &'static str {
        if self.first_failure.and_then(|d| d.reason) == Some("output-limit") {
            "output-limit"
        } else {
            "protocol-error"
        }
    }
    pub fn push(&mut self, input: &[u8]) -> Result<usize, &'static str> {
        if self.first_failure.is_some() {
            return Err(self.error());
        }
        match self.decoder.push(input, &mut self.protocol) {
            Ok(cpr) => Ok(cpr),
            Err(reason) => {
                self.record_failure(reason);
                Err(self.error())
            }
        }
    }
    pub fn finish(&mut self) -> Result<(), &'static str> {
        if self.first_failure.is_some() {
            return Err(self.error());
        }
        let result = self.decoder.finish().and_then(|()| {
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
