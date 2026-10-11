//! tmux control-mode protocol (P0 experiment for T22). Parses the line-based
//! stream of `tmux -C` into command replies and notifications, decodes pane
//! output, parses window layouts and keeps a window/pane model. It runs over
//! any byte stream (local PTY or SSH channel); nothing here spawns tmux.
use std::collections::BTreeMap;

/// Longest accepted protocol line. tmux splits pane output into short lines;
/// anything larger is treated as a broken or hostile stream.
const MAX_LINE: usize = 1024 * 1024;
const MAX_REPLY_LINES: usize = 64 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Event {
    /// Output of one command between `%begin` and `%end`/`%error`.
    Reply {
        number: u64,
        from_client: bool,
        ok: bool,
        lines: Vec<String>,
    },
    Output {
        pane: u32,
        data: Vec<u8>,
    },
    WindowAdd {
        window: u32,
    },
    WindowClose {
        window: u32,
    },
    WindowRenamed {
        window: u32,
        name: String,
    },
    LayoutChange {
        window: u32,
        layout: Layout,
    },
    WindowPaneChanged {
        window: u32,
        pane: u32,
    },
    SessionChanged {
        session: u32,
        name: String,
    },
    SessionWindowChanged {
        session: u32,
        window: u32,
    },
    SessionsChanged,
    Exit {
        reason: Option<String>,
    },
    /// Recognised syntax we do not model yet; kept for diagnostics.
    Other(String),
}

/// A layout cell: a pane or a horizontal (`{}`) / vertical (`[]`) split.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Layout {
    pub width: u16,
    pub height: u16,
    pub x: u16,
    pub y: u16,
    pub content: Content,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Content {
    Pane(u32),
    LeftRight(Vec<Layout>),
    TopBottom(Vec<Layout>),
}

impl Layout {
    pub fn panes(&self) -> Vec<(u32, u16, u16, u16, u16)> {
        match &self.content {
            Content::Pane(id) => vec![(*id, self.x, self.y, self.width, self.height)],
            Content::LeftRight(children) | Content::TopBottom(children) => {
                children.iter().flat_map(Layout::panes).collect()
            }
        }
    }
}

fn checksum(layout: &str) -> u16 {
    layout.bytes().fold(0u16, |sum, byte| {
        let sum = (sum >> 1).wrapping_add((sum & 1) << 15);
        sum.wrapping_add(byte as u16)
    })
}

/// Parses `csum,layout` as printed by tmux, verifying the checksum.
pub fn parse_layout(text: &str) -> Result<Layout, String> {
    let (sum, body) = text.split_once(',').ok_or("Layout has no checksum")?;
    let expected = u16::from_str_radix(sum, 16).map_err(|_| "Invalid layout checksum")?;
    if sum.len() != 4 || checksum(body) != expected {
        return Err("Layout checksum mismatch".into());
    }
    let mut rest = body;
    let layout = cell(&mut rest, 0)?;
    if !rest.is_empty() {
        return Err("Trailing layout data".into());
    }
    Ok(layout)
}

fn number<T: std::str::FromStr>(rest: &mut &str, end: &[char]) -> Result<T, String> {
    let index = rest.find(|c: char| end.contains(&c)).unwrap_or(rest.len());
    let value = rest[..index].parse().map_err(|_| "Invalid layout number")?;
    *rest = &rest[index..];
    Ok(value)
}

fn expect(rest: &mut &str, symbol: char) -> Result<(), String> {
    *rest = rest.strip_prefix(symbol).ok_or("Malformed layout")?;
    Ok(())
}

fn cell(rest: &mut &str, depth: usize) -> Result<Layout, String> {
    if depth > 32 {
        return Err("Layout nesting too deep".into());
    }
    let width = number(rest, &['x'])?;
    expect(rest, 'x')?;
    let height = number(rest, &[','])?;
    expect(rest, ',')?;
    let x = number(rest, &[','])?;
    expect(rest, ',')?;
    let y = number(rest, &[',', '{', '[', '}', ']'])?;
    let content = match rest.chars().next() {
        Some(open @ ('{' | '[')) => {
            *rest = &rest[1..];
            let close = if open == '{' { '}' } else { ']' };
            let mut children = vec![cell(rest, depth + 1)?];
            while rest.starts_with(',') {
                *rest = &rest[1..];
                children.push(cell(rest, depth + 1)?);
            }
            expect(rest, close)?;
            if open == '{' {
                Content::LeftRight(children)
            } else {
                Content::TopBottom(children)
            }
        }
        Some(',') => {
            *rest = &rest[1..];
            Content::Pane(number(rest, &[',', '}', ']'])?)
        }
        _ => return Err("Malformed layout cell".into()),
    };
    Ok(Layout {
        width,
        height,
        x,
        y,
        content,
    })
}

/// Decodes `%output` data: tmux escapes bytes below 0x20 and `\` as `\ooo`;
/// every other byte (including UTF-8) is sent as is.
pub fn decode_output(escaped: &[u8]) -> Result<Vec<u8>, String> {
    let mut data = Vec::with_capacity(escaped.len());
    let mut index = 0;
    while index < escaped.len() {
        if escaped[index] == b'\\' {
            let digits = escaped
                .get(index + 1..index + 4)
                .ok_or("Truncated output escape")?;
            if !digits.iter().all(|d| (b'0'..=b'7').contains(d)) {
                return Err("Invalid output escape".into());
            }
            let value = digits.iter().fold(0u16, |v, d| v * 8 + u16::from(d - b'0'));
            data.push(u8::try_from(value).map_err(|_| "Invalid output escape")?);
            index += 4;
        } else {
            data.push(escaped[index]);
            index += 1;
        }
    }
    Ok(data)
}

fn id(token: Option<&str>, sigil: char) -> Result<u32, String> {
    token
        .and_then(|token| token.strip_prefix(sigil))
        .and_then(|digits| digits.parse().ok())
        .ok_or_else(|| format!("Expected {sigil}<id>"))
}

#[derive(Default)]
pub struct Parser {
    line: Vec<u8>,
    block: Option<(u64, bool, Vec<String>)>,
    /// `-CC` wraps the stream in DCS `ESC P 1000 p … ESC \`.
    dcs_checked: bool,
}

impl Parser {
    /// Feeds raw bytes in any chunking; returns the complete events.
    pub fn push(&mut self, bytes: &[u8]) -> Result<Vec<Event>, String> {
        let mut events = Vec::new();
        for &byte in bytes {
            if byte != b'\n' {
                if self.line.len() >= MAX_LINE {
                    return Err("tmux control line exceeds 1 MiB".into());
                }
                self.line.push(byte);
                continue;
            }
            let mut line = std::mem::take(&mut self.line);
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            if !self.dcs_checked {
                self.dcs_checked = true;
                if let Some(rest) = line.strip_prefix(b"\x1bP1000p") {
                    line = rest.to_vec();
                }
            }
            if line == b"\x1b\\" {
                continue; // `-CC` terminator after %exit
            }
            if let Some(event) = self.line_event(&line)? {
                events.push(event);
            }
        }
        Ok(events)
    }

    fn line_event(&mut self, line: &[u8]) -> Result<Option<Event>, String> {
        if let Some((number, from_client, lines)) = &mut self.block {
            let text = String::from_utf8_lossy(line);
            let closing = ["%end ", "%error "]
                .iter()
                .find(|prefix| text.starts_with(*prefix));
            if let Some(prefix) = closing {
                let closed: u64 = text
                    .split(' ')
                    .nth(2)
                    .and_then(|n| n.parse().ok())
                    .ok_or("Malformed %end")?;
                if closed == *number {
                    let event = Event::Reply {
                        number: *number,
                        from_client: *from_client,
                        ok: *prefix == "%end ",
                        lines: std::mem::take(lines),
                    };
                    self.block = None;
                    return Ok(Some(event));
                }
            }
            if lines.len() >= MAX_REPLY_LINES {
                return Err("tmux reply exceeds 65536 lines".into());
            }
            lines.push(text.into_owned());
            return Ok(None);
        }
        // %output keeps raw bytes: only the escape alphabet is ASCII.
        if let Some(rest) = line.strip_prefix(b"%output ") {
            let space = rest.iter().position(|b| *b == b' ').unwrap_or(rest.len());
            let pane = id(std::str::from_utf8(&rest[..space]).ok(), '%')?;
            let data = decode_output(rest.get(space + 1..).unwrap_or_default())?;
            return Ok(Some(Event::Output { pane, data }));
        }
        let text = String::from_utf8_lossy(line).into_owned();
        let mut words = text.splitn(4, ' ');
        let event = match words.next().unwrap_or_default() {
            "%begin" => {
                let number = words
                    .nth(1)
                    .and_then(|n| n.parse().ok())
                    .ok_or("Malformed %begin")?;
                let flags: u32 = words.next().and_then(|n| n.parse().ok()).unwrap_or(0);
                self.block = Some((number, flags & 1 == 1, Vec::new()));
                return Ok(None);
            }
            "%window-add" => Event::WindowAdd {
                window: id(words.next(), '@')?,
            },
            "%window-close" | "%unlinked-window-close" => Event::WindowClose {
                window: id(words.next(), '@')?,
            },
            "%window-renamed" => {
                let window = id(words.next(), '@')?;
                let name = text.splitn(3, ' ').nth(2).unwrap_or_default().to_string();
                Event::WindowRenamed { window, name }
            }
            "%layout-change" => {
                let window = id(words.next(), '@')?;
                Event::LayoutChange {
                    window,
                    layout: parse_layout(words.next().ok_or("Missing layout")?)?,
                }
            }
            "%window-pane-changed" => Event::WindowPaneChanged {
                window: id(words.next(), '@')?,
                pane: id(words.next(), '%')?,
            },
            "%session-changed" => {
                let session = id(words.next(), '$')?;
                Event::SessionChanged {
                    session,
                    name: text.splitn(3, ' ').nth(2).unwrap_or_default().to_string(),
                }
            }
            "%session-window-changed" => Event::SessionWindowChanged {
                session: id(words.next(), '$')?,
                window: id(words.next(), '@')?,
            },
            "%sessions-changed" => Event::SessionsChanged,
            "%exit" => Event::Exit {
                reason: text.split_once(' ').map(|(_, reason)| reason.to_string()),
            },
            "" => return Ok(None),
            _ => Event::Other(text),
        };
        Ok(Some(event))
    }
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Window {
    pub name: String,
    pub layout: Option<Layout>,
    pub active_pane: Option<u32>,
}

/// Windows and panes as tmux reports them; pane output is routed by the caller.
#[derive(Debug, Default)]
pub struct Model {
    pub windows: BTreeMap<u32, Window>,
    pub session: Option<(u32, String)>,
    pub exited: Option<Option<String>>,
}

impl Model {
    pub fn apply(&mut self, event: &Event) {
        match event {
            Event::WindowAdd { window } => {
                self.windows.entry(*window).or_default();
            }
            Event::WindowClose { window } => {
                self.windows.remove(window);
            }
            Event::WindowRenamed { window, name } => {
                self.windows.entry(*window).or_default().name = name.clone()
            }
            Event::LayoutChange { window, layout } => {
                self.windows.entry(*window).or_default().layout = Some(layout.clone())
            }
            Event::WindowPaneChanged { window, pane } => {
                self.windows.entry(*window).or_default().active_pane = Some(*pane)
            }
            Event::SessionChanged { session, name } => {
                self.session = Some((*session, name.clone()))
            }
            Event::Exit { reason } => self.exited = Some(reason.clone()),
            _ => {}
        }
    }

    /// The window that owns a pane, according to the latest layouts.
    pub fn window_of(&self, pane: u32) -> Option<u32> {
        self.windows.iter().find_map(|(id, window)| {
            window
                .layout
                .as_ref()?
                .panes()
                .iter()
                .any(|(p, ..)| *p == pane)
                .then_some(*id)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Captured from tmux 3.6b in control mode (shell output abbreviated).
    const SAMPLE: &[u8] = b"%begin 1791715420 272 0\n%end 1791715420 272 0\n%window-add @0\n%sessions-changed\n%session-changed $0 0\n%begin 1791715420 278 1\n0: sh* (1 panes) [80x24] [layout b25d,80x24,0,0,0] @0 (active)\n%end 1791715420 278 1\n%window-add @1\n%window-pane-changed @1 %2\n%layout-change @1 020a,80x24,0,0{40x24,0,0,1,39x24,41,0,2} 020a,80x24,0,0{40x24,0,0,1,39x24,41,0,2} *\n%output %2 a\\011b\\134c\xe4\xb8\xad\\015\\012\n%window-renamed @1 \xe4\xb8\xad\xe6\x96\x87 window\n%begin 1791715421 290 1\nparse error: unknown command: nope\n%error 1791715421 290 1\n%exit\n";

    fn events(chunks: &[&[u8]]) -> Vec<Event> {
        let mut parser = Parser::default();
        chunks
            .iter()
            .flat_map(|chunk| parser.push(chunk).unwrap())
            .collect()
    }

    #[test]
    fn sample_stream_parses_identically_under_any_chunking() {
        let whole = events(&[SAMPLE]);
        for cut in 1..SAMPLE.len() {
            assert_eq!(
                events(&[&SAMPLE[..cut], &SAMPLE[cut..]]),
                whole,
                "cut at {cut}"
            );
        }
        let bytes: Vec<&[u8]> = SAMPLE.chunks(1).collect();
        assert_eq!(events(&bytes), whole);
        assert_eq!(
            whole[0],
            Event::Reply {
                number: 272,
                from_client: false,
                ok: true,
                lines: vec![]
            }
        );
        assert!(
            matches!(&whole[4], Event::Reply { number: 278, from_client: true, ok: true, lines } if lines[0].contains("layout b25d"))
        );
        assert_eq!(
            whole[8],
            Event::Output {
                pane: 2,
                data: "a\tb\\c中\r\n".as_bytes().to_vec()
            }
        );
        assert_eq!(
            whole[9],
            Event::WindowRenamed {
                window: 1,
                name: "中文 window".into()
            }
        );
        assert!(
            matches!(&whole[10], Event::Reply { number: 290, ok: false, lines, .. } if lines == &vec!["parse error: unknown command: nope".to_string()])
        );
        assert_eq!(whole[11], Event::Exit { reason: None });
    }

    #[test]
    fn layouts_parse_with_checksum_and_nesting() {
        let layout = parse_layout("020a,80x24,0,0{40x24,0,0,1,39x24,41,0,2}").unwrap();
        assert_eq!(layout.panes(), vec![(1, 0, 0, 40, 24), (2, 41, 0, 39, 24)]);
        let nested = "80x24,0,0{40x24,0,0,1,39x24,41,0[39x12,41,0,2,39x11,41,13,3]}";
        let text = format!("{:04x},{nested}", checksum(nested));
        assert_eq!(parse_layout(&text).unwrap().panes().len(), 3);
        assert!(parse_layout("020b,80x24,0,0{40x24,0,0,1,39x24,41,0,2}").is_err());
        assert!(parse_layout("b25d,80x24,0,0,0").is_ok());
        assert!(parse_layout("0000,80x24,0,0{").is_err());
    }

    #[test]
    fn output_escapes_are_strict_and_lines_bounded() {
        assert_eq!(decode_output(b"\\033[1m\\134").unwrap(), b"\x1b[1m\\");
        assert!(decode_output(b"\\09").is_err());
        assert!(decode_output(b"\\777").is_err());
        let mut parser = Parser::default();
        assert!(parser.push(&vec![b'x'; MAX_LINE + 1]).is_err());
        assert!(Parser::default().push(b"%output %x data\n").is_err());
    }

    #[test]
    fn dcs_wrapped_stream_and_model_tracking() {
        let mut parser = Parser::default();
        let mut model = Model::default();
        let stream = [b"\x1bP1000p".as_slice(), SAMPLE, b"\x1b\\\n"].concat();
        for event in parser.push(&stream).unwrap() {
            model.apply(&event);
        }
        assert_eq!(model.session, Some((0, "0".into())));
        assert_eq!(model.windows[&1].name, "中文 window");
        assert_eq!(model.windows[&1].active_pane, Some(2));
        assert_eq!(model.window_of(2), Some(1));
        assert_eq!(model.exited, Some(None));
    }
}
