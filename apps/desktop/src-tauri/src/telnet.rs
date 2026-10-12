//! Telnet (RFC 854/855) codec for terminal sessions (P0 probe for C02).
//! Splits server bytes into terminal data and option negotiation, answers
//! negotiation with a fixed policy, and escapes outgoing data. Transport,
//! UI and saved settings are not part of this probe.

const IAC: u8 = 255;
const DONT: u8 = 254;
const DO: u8 = 253;
const WONT: u8 = 252;
const WILL: u8 = 251;
const SB: u8 = 250;
const SE: u8 = 240;

const BINARY: u8 = 0;
const ECHO: u8 = 1;
const SGA: u8 = 3;
const TTYPE: u8 = 24;
const NAWS: u8 = 31;

const TTYPE_SEND: u8 = 1;
const TTYPE_IS: u8 = 0;
/// Subnegotiation payloads larger than this are discarded, not buffered.
const MAX_SUBNEGOTIATION: usize = 256;

#[derive(Default, Clone, Copy, PartialEq, Eq)]
enum State {
    #[default]
    Data,
    Iac,
    Verb(u8),
    Sub,
    SubIac,
    /// Data CR seen outside binary mode: a following NUL is dropped
    /// (RFC 854 bare CR).
    Cr,
}

/// What one call to [`Codec::receive`] produced.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Received {
    /// Bytes for the terminal.
    pub data: Vec<u8>,
    /// Bytes to send back to the server (negotiation replies).
    pub reply: Vec<u8>,
}

pub struct Codec {
    state: State,
    sub: Vec<u8>,
    sub_overflow: bool,
    terminal: String,
    size: (u16, u16),
    /// Options we have agreed to perform / the server performs.
    ours: [bool; 256],
    theirs: [bool; 256],
}

impl Codec {
    pub fn new(terminal: &str, cols: u16, rows: u16) -> Self {
        Self {
            state: State::Data,
            sub: Vec::new(),
            sub_overflow: false,
            terminal: terminal
                .chars()
                .filter(char::is_ascii_graphic)
                .take(40)
                .collect(),
            size: (cols, rows),
            ours: [false; 256],
            theirs: [false; 256],
        }
    }

    /// Whether the server echoes input (so the terminal must not).
    pub fn server_echoes(&self) -> bool {
        self.theirs[ECHO as usize]
    }

    /// Decodes server bytes in any chunking.
    pub fn receive(&mut self, input: &[u8]) -> Received {
        let mut out = Received::default();
        for &byte in input {
            self.state = match (self.state, byte) {
                (State::Data | State::Cr, IAC) => State::Iac,
                (State::Cr, 0) => State::Data,
                // RFC 856: in binary mode CR NUL is two data bytes.
                (State::Data | State::Cr, b'\r') if !self.theirs[BINARY as usize] => {
                    out.data.push(b'\r');
                    State::Cr
                }
                (State::Data | State::Cr, byte) => {
                    out.data.push(byte);
                    State::Data
                }
                (State::Iac, IAC) => {
                    out.data.push(IAC);
                    State::Data
                }
                (State::Iac, verb @ (WILL | WONT | DO | DONT)) => State::Verb(verb),
                (State::Iac, SB) => {
                    self.sub.clear();
                    self.sub_overflow = false;
                    State::Sub
                }
                (State::Iac, _) => State::Data, // NOP, GA, AYT and others are ignored
                (State::Verb(verb), option) => {
                    self.negotiate(verb, option, &mut out.reply);
                    State::Data
                }
                (State::Sub, IAC) => State::SubIac,
                (State::Sub, byte) => {
                    self.push_sub(byte);
                    State::Sub
                }
                (State::SubIac, SE) => {
                    self.subnegotiation(&mut out.reply);
                    State::Data
                }
                (State::SubIac, byte) => {
                    self.push_sub(byte); // IAC IAC inside SB is a literal 255
                    State::Sub
                }
            };
        }
        out
    }

    fn push_sub(&mut self, byte: u8) {
        if self.sub.len() < MAX_SUBNEGOTIATION {
            self.sub.push(byte);
        } else {
            self.sub_overflow = true;
        }
    }

    fn negotiate(&mut self, verb: u8, option: u8, reply: &mut Vec<u8>) {
        let index = option as usize;
        match verb {
            // Server offers to perform an option. A refusal is repeated for
            // every offer (RFC 1143: him=NO answers WILL with DONT); replies
            // never exceed the request, so this cannot amplify or loop.
            WILL => {
                let accept = matches!(option, ECHO | SGA | BINARY);
                if accept != self.theirs[index] || !accept {
                    self.theirs[index] = accept;
                    reply.extend_from_slice(&[IAC, if accept { DO } else { DONT }, option]);
                }
            }
            WONT if self.theirs[index] => {
                self.theirs[index] = false;
                reply.extend_from_slice(&[IAC, DONT, option]);
            }
            // Server asks us to perform an option.
            DO => {
                let accept = matches!(option, SGA | BINARY | TTYPE | NAWS);
                if accept != self.ours[index] || !accept {
                    self.ours[index] = accept;
                    reply.extend_from_slice(&[IAC, if accept { WILL } else { WONT }, option]);
                    if accept && option == NAWS {
                        self.naws(reply);
                    }
                }
            }
            DONT if self.ours[index] => {
                self.ours[index] = false;
                reply.extend_from_slice(&[IAC, WONT, option]);
            }
            _ => {}
        }
    }

    fn subnegotiation(&mut self, reply: &mut Vec<u8>) {
        if self.sub_overflow || self.sub.len() < 2 {
            return;
        }
        if self.sub[0] == TTYPE && self.sub[1] == TTYPE_SEND && self.ours[TTYPE as usize] {
            reply.extend_from_slice(&[IAC, SB, TTYPE, TTYPE_IS]);
            reply.extend_from_slice(self.terminal.as_bytes());
            reply.extend_from_slice(&[IAC, SE]);
        }
    }

    fn naws(&self, reply: &mut Vec<u8>) {
        reply.extend_from_slice(&[IAC, SB, NAWS]);
        for byte in self
            .size
            .0
            .to_be_bytes()
            .into_iter()
            .chain(self.size.1.to_be_bytes())
        {
            reply.push(byte);
            if byte == IAC {
                reply.push(IAC);
            }
        }
        reply.extend_from_slice(&[IAC, SE]);
    }

    /// Records a new window size; returns the NAWS update if negotiated.
    pub fn resize(&mut self, cols: u16, rows: u16) -> Vec<u8> {
        self.size = (cols, rows);
        let mut reply = Vec::new();
        if self.ours[NAWS as usize] {
            self.naws(&mut reply);
        }
        reply
    }

    /// Escapes terminal input for the wire: IAC is doubled and, outside
    /// binary mode, a CR not already followed by LF in `input` is sent as
    /// CR LF (Enter). In binary mode CR is sent unchanged (RFC 856).
    pub fn send(&self, input: &[u8]) -> Vec<u8> {
        let binary = self.ours[BINARY as usize];
        let mut out = Vec::with_capacity(input.len());
        for (index, &byte) in input.iter().enumerate() {
            match byte {
                IAC => out.extend_from_slice(&[IAC, IAC]),
                b'\r' if !binary && input.get(index + 1) != Some(&b'\n') => {
                    out.extend_from_slice(b"\r\n")
                }
                byte => out.push(byte),
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn decode(codec: &mut Codec, chunks: &[&[u8]]) -> Received {
        let mut total = Received::default();
        for chunk in chunks {
            let part = codec.receive(chunk);
            total.data.extend(part.data);
            total.reply.extend(part.reply);
        }
        total
    }

    // A server greeting with negotiation interleaved in text, a literal 255,
    // a CR NUL and a TTYPE request.
    const SERVER: &[u8] = &[
        IAC, WILL, ECHO, IAC, WILL, SGA, IAC, DO, NAWS, IAC, DO, TTYPE, b'h', b'i', IAC, IAC, b'!',
        b'\r', 0, IAC, SB, TTYPE, TTYPE_SEND, IAC, SE, IAC, DO, 39, IAC, WILL, 5, 0xe4, 0xb8, 0xad,
    ];

    #[test]
    fn negotiation_and_data_are_identical_under_any_chunking() {
        let whole = decode(&mut Codec::new("xterm-256color", 300, 255), &[SERVER]);
        for cut in 1..SERVER.len() {
            let split = decode(
                &mut Codec::new("xterm-256color", 300, 255),
                &[&SERVER[..cut], &SERVER[cut..]],
            );
            assert_eq!(split, whole, "cut at {cut}");
        }
        let bytes: Vec<&[u8]> = SERVER.chunks(1).collect();
        assert_eq!(
            decode(&mut Codec::new("xterm-256color", 300, 255), &bytes),
            whole
        );
        assert_eq!(whole.data, [b'h', b'i', IAC, b'!', b'\r', 0xe4, 0xb8, 0xad]);
        let mut expected = vec![IAC, DO, ECHO, IAC, DO, SGA, IAC, WILL, NAWS];
        // NAWS 300x255: 255 is doubled inside the subnegotiation.
        expected.extend_from_slice(&[IAC, SB, NAWS, 1, 44, 0, 255, 255, IAC, SE]);
        expected.extend_from_slice(&[IAC, WILL, TTYPE]);
        expected.extend_from_slice(&[IAC, SB, TTYPE, TTYPE_IS]);
        expected.extend_from_slice(b"xterm-256color");
        expected.extend_from_slice(&[IAC, SE]);
        expected.extend_from_slice(&[IAC, WONT, 39, IAC, DONT, 5]);
        assert_eq!(whole.reply, expected);
    }

    #[test]
    fn repeated_requests_do_not_loop_and_echo_state_is_tracked() {
        let mut codec = Codec::new("xterm", 80, 24);
        assert_eq!(codec.receive(&[IAC, WILL, ECHO]).reply, [IAC, DO, ECHO]);
        assert!(codec.server_echoes());
        assert!(codec.receive(&[IAC, WILL, ECHO]).reply.is_empty());
        assert_eq!(codec.receive(&[IAC, WONT, ECHO]).reply, [IAC, DONT, ECHO]);
        assert!(!codec.server_echoes());
        assert!(
            codec.resize(100, 30).is_empty(),
            "no NAWS before it was negotiated"
        );
        codec.receive(&[IAC, DO, NAWS]);
        assert_eq!(
            codec.resize(100, 30),
            [IAC, SB, NAWS, 0, 100, 0, 30, IAC, SE]
        );
    }

    #[test]
    fn binary_mode_keeps_nul_after_cr_and_sends_bare_cr() {
        let mut codec = Codec::new("xterm", 80, 24);
        assert_eq!(codec.receive(b"a\r\0b").data, b"a\rb");
        assert_eq!(codec.receive(&[IAC, WILL, BINARY]).reply, [IAC, DO, BINARY]);
        // Found against telnetd 308: in binary mode it sends CR NUL as data.
        assert_eq!(codec.receive(b"a\r\0b").data, b"a\r\0b");
        assert_eq!(codec.receive(b"c\r").data, b"c\r");
        assert_eq!(codec.receive(&[0, IAC, IAC]).data, [0, IAC]);
        assert_eq!(
            codec.receive(&[IAC, WONT, BINARY]).reply,
            [IAC, DONT, BINARY]
        );
        assert_eq!(codec.receive(b"a\r\0b").data, b"a\rb");
        // Sending follows our own side of BINARY.
        assert_eq!(codec.send(b"x\r"), b"x\r\n");
        assert_eq!(codec.receive(&[IAC, DO, BINARY]).reply, [IAC, WILL, BINARY]);
        assert_eq!(codec.send(&[b'x', b'\r', IAC]), [b'x', b'\r', IAC, IAC]);
    }

    #[test]
    fn outgoing_data_is_escaped_and_subnegotiation_is_bounded() {
        let codec = Codec::new("xterm", 80, 24);
        assert_eq!(
            codec.send(&[b'a', IAC, b'\r']),
            [b'a', IAC, IAC, b'\r', b'\n']
        );
        assert_eq!(codec.send(b"x\r\n"), b"x\r\n");
        let mut codec = Codec::new("xterm", 80, 24);
        codec.receive(&[IAC, DO, TTYPE]);
        let mut flood = vec![IAC, SB, TTYPE, TTYPE_SEND];
        flood.extend(std::iter::repeat_n(b'x', 10_000));
        flood.extend_from_slice(&[IAC, SE, b'o', b'k']);
        let out = codec.receive(&flood);
        assert!(
            out.reply.is_empty(),
            "oversized subnegotiation must be ignored"
        );
        assert_eq!(out.data, b"ok");
    }
}
