//! One supervised ConPTY diagnostic sample. The Node wrapper owns the matrix.
#[cfg(not(windows))]
fn main() {
    std::process::exit(1);
}

#[cfg(test)]
mod tests {
    use super::probe::*;
    use std::time::Duration;

    const NONCE: &str = "0123456789abcdef0123456789abcdef";
    fn lines() -> String {
        let p = format!("P1Q_{NONCE}|");
        format!("{p}READY|5.1.20348.5622\r\n{p}START|1\r\n{p}RESULT|1|12.5|true\r\n{p}START|2\r\n{p}RESULT|2|0.25|true\r\n{p}END\r\n")
    }
    #[test]
    fn valid_protocol_and_split_cursor_query() {
        let mut parser = Parser::new(NONCE);
        assert_eq!(parser.push(b"\x1b[6").unwrap(), 0);
        assert_eq!(parser.push(b"n").unwrap(), 1);
        for byte in lines().bytes() {
            parser.push(&[byte]).unwrap();
        }
        assert!(parser.ended);
        assert!(parser.version_ok);
        assert_eq!(parser.queries, [Some(12.5), Some(0.25)]);
    }
    #[test]
    fn marker_must_be_unique_complete_independent_line() {
        for text in [
            lines().replace(NONCE, "other"),
            format!("echo {}", lines()),
            lines().replace("END\r\n", "END"),
        ] {
            let mut parser = Parser::new(NONCE);
            let _ = parser.push(text.as_bytes());
            assert!(!parser.ended);
        }
    }
    #[test]
    fn malformed_order_identity_and_timings_are_rejected() {
        for text in [
            lines().replace("5.1.", "7.1."),
            lines().replace("START|1", "START|2"),
            lines().replace("12.5", "NaN"),
            lines().replace("12.5", "-1"),
            lines().replace("12.5", "30001"),
            lines().replace("|true", "|false"),
            format!("{}{}", lines(), lines()),
        ] {
            assert!(Parser::new(NONCE).push(text.as_bytes()).is_err());
        }
    }
    #[test]
    fn completed_prefix_survives_later_incomplete_phase() {
        let text = lines();
        let cut = text.find("RESULT|2").unwrap();
        let mut parser = Parser::new(NONCE);
        parser.push(&text.as_bytes()[..cut]).unwrap();
        assert_eq!(parser.queries, [Some(12.5), None]);
        assert!(!parser.ended);
    }
    #[test]
    fn ansi_and_osc_state_cannot_create_markers_from_hidden_text() {
        let mut parser = Parser::new(NONCE);
        parser
            .push(format!("\x1b]0;{}\x07\r\n", lines()).as_bytes())
            .unwrap();
        assert!(!parser.ended);
        parser
            .push(format!("\x1b[?25h{}", lines()).as_bytes())
            .unwrap();
        assert!(parser.ended);
    }
    #[test]
    fn script_has_no_cmdlet_before_query_and_no_complete_echo_marker() {
        let ready = ready_script(NONCE);
        assert!(!ready.contains(&format!("P1Q_{NONCE}")));
        assert!(!ready.contains("Get-Command"));
        for arm in [Arm::Unqualified, Arm::Qualified] {
            let script = query_script(arm, NONCE, "C:\\private\\中文");
            assert!(!script.contains(&format!("P1Q_{NONCE}")));
            assert!(!script.contains("Import-Module"));
            assert!(!script.contains("Get-Command"));
            assert!(!script.contains("Write-Output"));
            assert_eq!(
                script.contains("Microsoft.PowerShell.Management\\Get-Location"),
                arm == Arm::Qualified
            );
        }
    }
    #[test]
    fn cleanup_requires_all_confirmations_and_never_calls_wait() {
        assert!(!cleanup_confirmed(true, true, true, false));
        assert!(cleanup_confirmed(true, true, true, true));
        let mut child = FakeChild {
            polls: 0,
            exit_after: 2,
            killed: false,
        };
        assert_eq!(
            poll_exit(&mut child, Duration::from_millis(20)).unwrap(),
            Some(0)
        );
        let mut child = FakeChild {
            polls: 0,
            exit_after: usize::MAX,
            killed: false,
        };
        assert_eq!(
            poll_exit(&mut child, Duration::from_millis(1)).unwrap(),
            None
        );
    }
    #[derive(Debug)]
    struct FakeChild {
        polls: usize,
        exit_after: usize,
        killed: bool,
    }
    impl portable_pty::ChildKiller for FakeChild {
        fn kill(&mut self) -> std::io::Result<()> {
            self.killed = true;
            Ok(())
        }
        fn clone_killer(&self) -> Box<dyn portable_pty::ChildKiller + Send + Sync> {
            Box::new(Self {
                polls: 0,
                exit_after: self.exit_after,
                killed: false,
            })
        }
    }
    impl portable_pty::Child for FakeChild {
        fn try_wait(&mut self) -> std::io::Result<Option<portable_pty::ExitStatus>> {
            self.polls += 1;
            Ok(
                (self.polls >= self.exit_after)
                    .then(|| portable_pty::ExitStatus::with_exit_code(0)),
            )
        }
        fn wait(&mut self) -> std::io::Result<portable_pty::ExitStatus> {
            panic!("unbounded wait forbidden")
        }
        fn process_id(&self) -> Option<u32> {
            Some(42)
        }
        #[cfg(windows)]
        fn as_raw_handle(&self) -> Option<std::os::windows::io::RawHandle> {
            None
        }
    }
    #[test]
    fn fixed_report_contains_no_paths_or_output() {
        let report = Report::new(Arm::Qualified);
        let value: serde_json::Value = serde_json::from_str(&report.json()).unwrap();
        assert_eq!(value["arm"], "module-qualified");
        assert_eq!(value["cleanupOk"], false);
        assert!(!report.json().contains("private"));
    }
    #[test]
    fn trailing_records_and_truncated_markers_fail_at_eof() {
        let mut parser = Parser::new(NONCE);
        parser.push(lines().as_bytes()).unwrap();
        assert!(parser.finish().is_ok());
        parser.push(format!("P1Q_{NONCE}|RES").as_bytes()).unwrap();
        assert_eq!(parser.finish(), Err("protocol-error"));
        let mut parser = Parser::new(NONCE);
        parser.push(lines().as_bytes()).unwrap();
        assert_eq!(
            parser.push(format!("P1Q_{NONCE}|END\r\n").as_bytes()),
            Err("protocol-error")
        );
    }
    #[test]
    fn bounds_and_local_path_validation_preserve_exact_unicode_cwd() {
        assert_eq!(OUTPUT_LIMIT, 256 * 1024);
        assert_eq!(local_path(r"\\?\C:\p1 中文"), Some(r"C:\p1 中文"));
        assert_eq!(local_path(r"C:\p1 中文"), Some(r"C:\p1 中文"));
        assert_eq!(local_path(r"\\?\UNC\host\share"), None);
        assert_eq!(local_path(r"relative\private"), None);
        assert_eq!(
            Parser::new(NONCE).push(&vec![b'x'; 16_385]),
            Err("output-limit")
        );
    }
    #[test]
    fn successful_kill_request_without_observed_exit_is_not_cleanup_confirmation() {
        let mut child = FakeChild {
            polls: 0,
            exit_after: usize::MAX,
            killed: false,
        };
        portable_pty::ChildKiller::kill(&mut child).unwrap();
        assert!(child.killed);
        let exit = poll_exit(&mut child, Duration::from_millis(1)).unwrap();
        assert!(!cleanup_confirmed(exit.is_some(), true, true, true));
    }
}

#[cfg(any(windows, test))]
mod probe {
    use portable_pty::Child;
    use std::time::{Duration, Instant};

    pub const OUTPUT_LIMIT: usize = 256 * 1024;
    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub enum Arm {
        Unqualified,
        Qualified,
    }
    impl Arm {
        pub fn name(self) -> &'static str {
            match self {
                Self::Unqualified => "unqualified",
                Self::Qualified => "module-qualified",
            }
        }
    }
    pub struct Report {
        pub arm: Arm,
        pub q1: Option<f64>,
        pub q2: Option<f64>,
        pub startup: Option<f64>,
        pub host: Option<f64>,
        pub wall: f64,
        pub version_ok: bool,
        pub cwd1_ok: bool,
        pub cwd2_ok: bool,
        pub exit_code: Option<u32>,
        pub cpr: usize,
        pub bytes: usize,
        pub complete: bool,
        pub cleanup_ok: bool,
        pub failure: Option<&'static str>,
    }
    impl Report {
        pub fn new(arm: Arm) -> Self {
            Self {
                arm,
                q1: None,
                q2: None,
                startup: None,
                host: None,
                wall: 0.0,
                version_ok: false,
                cwd1_ok: false,
                cwd2_ok: false,
                exit_code: None,
                cpr: 0,
                bytes: 0,
                complete: false,
                cleanup_ok: false,
                failure: Some("setup-error"),
            }
        }
        pub fn json(&self) -> String {
            let number = |value: Option<f64>| {
                value
                    .filter(|n| n.is_finite() && *n >= 0.0)
                    .map_or_else(|| "null".to_owned(), |n| n.to_string())
            };
            format!("{{\"schema\":1,\"arm\":\"{}\",\"q1Ms\":{},\"q2Ms\":{},\"startupMs\":{},\"hostMs\":{},\"wallMs\":{},\"versionOk\":{},\"cwd1Ok\":{},\"cwd2Ok\":{},\"exitCode\":{},\"cprReplies\":{},\"mergedBytes\":{},\"complete\":{},\"cleanupOk\":{},\"failure\":{}}}", self.arm.name(), number(self.q1), number(self.q2), number(self.startup), number(self.host), number(Some(self.wall)), self.version_ok, self.cwd1_ok, self.cwd2_ok, self.exit_code.map_or_else(|| "null".to_owned(), |n| n.to_string()), self.cpr, self.bytes, self.complete, self.cleanup_ok, self.failure.map_or_else(|| "null".to_owned(), |s| format!("\"{s}\"")))
        }
    }
    enum Escape {
        Text,
        Esc,
        Csi(Vec<u8>),
        Osc,
        OscEsc,
    }
    pub struct Parser {
        prefix: String,
        line: Vec<u8>,
        escape: Escape,
        step: usize,
        pub version_ok: bool,
        pub queries: [Option<f64>; 2],
        pub ended: bool,
    }
    impl Parser {
        pub fn new(nonce: &str) -> Self {
            Self {
                prefix: format!("P1Q_{nonce}|"),
                line: Vec::new(),
                escape: Escape::Text,
                step: 0,
                version_ok: false,
                queries: [None, None],
                ended: false,
            }
        }
        pub fn push(&mut self, bytes: &[u8]) -> Result<usize, &'static str> {
            let mut cpr = 0;
            for &byte in bytes {
                match &mut self.escape {
                    Escape::Text => match byte {
                        0x1b => self.escape = Escape::Esc,
                        b'\r' => {}
                        b'\n' => {
                            self.consume_line()?;
                            self.line.clear();
                        }
                        _ => {
                            if self.line.len() >= 16_384 {
                                return Err("output-limit");
                            }
                            self.line.push(byte);
                        }
                    },
                    Escape::Esc => {
                        self.escape = match byte {
                            b'[' => Escape::Csi(Vec::new()),
                            b']' => Escape::Osc,
                            _ => Escape::Text,
                        }
                    }
                    Escape::Csi(sequence) => {
                        if (0x40..=0x7e).contains(&byte) {
                            if byte == b'n' && sequence == b"6" {
                                cpr += 1;
                            }
                            self.escape = Escape::Text;
                        } else {
                            if sequence.len() >= 64 {
                                return Err("protocol-error");
                            }
                            sequence.push(byte);
                        }
                    }
                    Escape::Osc => {
                        if byte == 7 {
                            self.escape = Escape::Text;
                        } else if byte == 0x1b {
                            self.escape = Escape::OscEsc;
                        }
                    }
                    Escape::OscEsc => {
                        self.escape = if byte == b'\\' {
                            Escape::Text
                        } else {
                            Escape::Osc
                        }
                    }
                }
            }
            Ok(cpr)
        }
        pub fn finish(&self) -> Result<(), &'static str> {
            if !self.line.is_empty()
                && (self.line.starts_with(self.prefix.as_bytes())
                    || self.prefix.as_bytes().starts_with(&self.line))
            {
                return Err("protocol-error");
            }
            Ok(())
        }
        fn consume_line(&mut self) -> Result<(), &'static str> {
            if !self.line.starts_with(self.prefix.as_bytes()) {
                return Ok(());
            }
            let line = std::str::from_utf8(&self.line).map_err(|_| "protocol-error")?;
            let fields: Vec<_> = line[self.prefix.len()..].split('|').collect();
            if fields == ["ERROR"] {
                return Err("command-error");
            }
            match self.step {
                0 => {
                    if fields.len() != 2 || fields[0] != "READY" {
                        return Err("protocol-error");
                    }
                    let version: Vec<_> = fields[1].split('.').collect();
                    if version.len() != 4
                        || version[0] != "5"
                        || version[1] != "1"
                        || version[2..].iter().any(|s| {
                            s.is_empty() || s.len() > 10 || !s.bytes().all(|b| b.is_ascii_digit())
                        })
                    {
                        return Err("protocol-error");
                    }
                    self.version_ok = true;
                }
                1 | 3 => {
                    let expected = if self.step == 1 { "1" } else { "2" };
                    if fields != ["START", expected] {
                        return Err("protocol-error");
                    }
                }
                2 | 4 => {
                    let index = if self.step == 2 { 0 } else { 1 };
                    if fields.len() != 4
                        || fields[0] != "RESULT"
                        || fields[1] != if index == 0 { "1" } else { "2" }
                    {
                        return Err("protocol-error");
                    }
                    if fields[3] != "true" {
                        return Err("cwd-mismatch");
                    }
                    if !fields[2].as_bytes().first().is_some_and(u8::is_ascii_digit) {
                        return Err("protocol-error");
                    }
                    let elapsed: f64 = fields[2].parse().map_err(|_| "protocol-error")?;
                    if !elapsed.is_finite()
                        || elapsed < 0.0
                        || elapsed + self.queries[0].unwrap_or(0.0) > 30_000.0
                    {
                        return Err("protocol-error");
                    }
                    self.queries[index] = Some(elapsed);
                }
                5 => {
                    if fields != ["END"] {
                        return Err("protocol-error");
                    }
                    self.ended = true;
                }
                _ => {
                    self.ended = false;
                    return Err("protocol-error");
                }
            }
            self.step += 1;
            Ok(())
        }
    }
    fn prefix_assignment(nonce: &str) -> String {
        format!("$p=('P1Q_'+'{}'+'{}'+'|');", &nonce[..16], &nonce[16..])
    }
    pub fn ready_script(nonce: &str) -> String {
        format!("{}[Console]::WriteLine();[Console]::WriteLine($p+'READY|'+$PSVersionTable.PSVersion.ToString());\r\n", prefix_assignment(nonce))
    }
    pub fn query_script(arm: Arm, nonce: &str, cwd: &str) -> String {
        let expected = cwd
            .encode_utf16()
            .map(|c| c.to_string())
            .collect::<Vec<_>>()
            .join(",");
        let command = if arm == Arm::Qualified {
            "Microsoft.PowerShell.Management\\Get-Location"
        } else {
            "Get-Location"
        };
        let mut script = format!("{}$ErrorActionPreference='Stop';$expected=[string]::new([char[]]@({expected}));try {{[Console]::WriteLine();", prefix_assignment(nonce));
        for phase in 1..=2 {
            script.push_str(&format!("[Console]::WriteLine($p+'START|{phase}');$sw=[Diagnostics.Stopwatch]::StartNew();$path=({command}).Path;$sw.Stop();$ok=[string]::Equals($path,$expected,[StringComparison]::Ordinal);[Console]::WriteLine($p+'RESULT|{phase}|'+$sw.Elapsed.TotalMilliseconds.ToString('R',[Globalization.CultureInfo]::InvariantCulture)+'|'+$ok.ToString().ToLowerInvariant());if(-not $ok){{exit 1;}}"));
        }
        script.push_str("[Console]::WriteLine($p+'END');exit 0;}catch{[Console]::WriteLine($p+'ERROR');exit 1;}\r\n");
        script
    }
    pub fn poll_exit(child: &mut dyn Child, timeout: Duration) -> std::io::Result<Option<u32>> {
        let deadline = Instant::now() + timeout;
        loop {
            if let Some(status) = child.try_wait()? {
                return Ok(Some(status.exit_code()));
            }
            if Instant::now() >= deadline {
                return Ok(None);
            }
            std::thread::sleep(Duration::from_millis(5));
        }
    }
    pub fn cleanup_confirmed(exited: bool, reader: bool, writer: bool, master: bool) -> bool {
        exited && reader && writer && master
    }
    pub fn local_path(text: &str) -> Option<&str> {
        let path = text.strip_prefix(r"\\?\").unwrap_or(text);
        let bytes = path.as_bytes();
        (bytes.len() >= 3
            && bytes[0].is_ascii_alphabetic()
            && bytes[1] == b':'
            && bytes[2] == b'\\')
            .then_some(path)
    }
}

#[cfg(windows)]
mod windows_worker {
    use super::probe::*;
    use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
    use std::{
        collections::BTreeMap,
        env,
        ffi::OsString,
        io::{Read, Write},
        path::{Path, PathBuf},
        sync::{
            atomic::{AtomicBool, AtomicUsize, Ordering},
            mpsc::{self, Receiver, SyncSender, TrySendError},
            Arc,
        },
        thread,
        time::{Duration, Instant},
    };

    enum Event {
        Data(Vec<u8>),
        Eof,
        Error,
    }
    struct Io {
        input: SyncSender<Vec<u8>>,
        output: Receiver<Event>,
        reader_done: Receiver<()>,
        writer_done: Receiver<()>,
        bytes: Arc<AtomicUsize>,
        read_failed: Arc<AtomicBool>,
        write_failed: Arc<AtomicBool>,
    }
    fn start_io(mut reader: Box<dyn Read + Send>, mut writer: Box<dyn Write + Send>) -> Io {
        let (tx, output) = mpsc::sync_channel(64);
        let (input, commands) = mpsc::sync_channel::<Vec<u8>>(4);
        // Each completion channel carries one notification only. A receiver
        // may already have timed out; losing that notification is then benign.
        let (rd, reader_done) = mpsc::sync_channel(1);
        let (wd, writer_done) = mpsc::sync_channel(1);
        let bytes = Arc::new(AtomicUsize::new(0));
        let read_failed = Arc::new(AtomicBool::new(false));
        let write_failed = Arc::new(AtomicBool::new(false));
        let count = bytes.clone();
        let failed = read_failed.clone();
        thread::spawn(move || {
            let mut buffer = [0u8; 4096];
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) => {
                        let _ = tx.try_send(Event::Eof);
                        break;
                    }
                    Ok(size) => {
                        let before = count.load(Ordering::Relaxed);
                        if before > OUTPUT_LIMIT {
                            continue;
                        }
                        count.store((before + size).min(OUTPUT_LIMIT + 4096), Ordering::Relaxed);
                        if before + size > OUTPUT_LIMIT {
                            continue;
                        }
                        match tx.try_send(Event::Data(buffer[..size].to_vec())) {
                            Ok(()) => {}
                            Err(TrySendError::Full(_)) => failed.store(true, Ordering::Relaxed),
                            Err(TrySendError::Disconnected(_)) => break,
                        }
                    }
                    Err(_) => {
                        failed.store(true, Ordering::Relaxed);
                        let _ = tx.try_send(Event::Error);
                        break;
                    }
                }
            }
            drop(reader);
            let _ = rd.send(());
        });
        let failed = write_failed.clone();
        thread::spawn(move || {
            while let Ok(command) = commands.recv() {
                if writer
                    .write_all(&command)
                    .and_then(|()| writer.flush())
                    .is_err()
                {
                    failed.store(true, Ordering::Relaxed);
                    break;
                }
            }
            drop(writer);
            let _ = wd.send(());
        });
        Io {
            input,
            output,
            reader_done,
            writer_done,
            bytes,
            read_failed,
            write_failed,
        }
    }
    #[derive(Clone, Copy)]
    enum Until {
        Cursor,
        Ready,
        End,
    }
    fn receive(
        io: &Io,
        parser: &mut Parser,
        report: &mut Report,
        deadline: Instant,
        until: Until,
    ) -> Result<(), &'static str> {
        let timeout = if matches!(until, Until::End) {
            "command-timeout"
        } else {
            "startup-timeout"
        };
        loop {
            report.bytes = io.bytes.load(Ordering::Relaxed);
            if report.bytes > OUTPUT_LIMIT {
                return Err("output-limit");
            }
            if io.read_failed.load(Ordering::Relaxed) {
                return Err("read-error");
            }
            if io.write_failed.load(Ordering::Relaxed) {
                return Err("write-error");
            }
            if Instant::now() >= deadline {
                return Err(timeout);
            }
            match io.output.recv_timeout(Duration::from_millis(10)) {
                Ok(Event::Data(chunk)) => {
                    let replies = parser.push(&chunk)?;
                    for _ in 0..replies {
                        io.input
                            .try_send(b"\x1b[1;1R".to_vec())
                            .map_err(|_| "write-error")?;
                        report.cpr += 1;
                        if report.cpr > 65_536 {
                            return Err("protocol-error");
                        }
                    }
                    let reached = match until {
                        Until::Cursor => replies > 0,
                        Until::Ready => parser.version_ok,
                        Until::End => parser.ended,
                    };
                    if reached {
                        if Instant::now() >= deadline {
                            return Err(timeout);
                        }
                        return Ok(());
                    }
                }
                Ok(Event::Error) => return Err("read-error"),
                Ok(Event::Eof) => return Err("protocol-error"),
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => return Err("read-error"),
            }
        }
    }
    fn cleanup(
        mut child: Box<dyn Child + Send + Sync>,
        master: Box<dyn MasterPty + Send>,
        io: Io,
        failed: bool,
        mut parser: Parser,
    ) -> (bool, Option<u32>, Option<&'static str>, usize) {
        let final_bytes = io.bytes.clone();
        let (tx, rx) = mpsc::sync_channel(1);
        thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_millis(4500);
            drop(io.input);
            let mut exit = if failed {
                None
            } else {
                poll_exit(child.as_mut(), Duration::from_millis(500))
                    .ok()
                    .flatten()
            };
            if exit.is_none() {
                // portable-pty's return value is not termination evidence.
                // Only the subsequent try_wait observation can confirm exit.
                let _ = child.kill();
                exit = poll_exit(child.as_mut(), Duration::from_secs(2))
                    .ok()
                    .flatten();
            }
            let (closed_tx, closed) = mpsc::sync_channel(1);
            thread::spawn(move || {
                drop(master);
                let _ = closed_tx.send(());
            });
            let mut reader = false;
            let mut writer = false;
            let mut master_closed = false;
            let mut tail_failure = None;
            while Instant::now() < deadline {
                reader |= io.reader_done.try_recv().is_ok();
                writer |= io.writer_done.try_recv().is_ok();
                master_closed |= closed.try_recv().is_ok();
                // Keep the output receiver alive while the reader drains the
                // pseudoconsole. Validate trailing protocol without retaining it.
                while let Ok(event) = io.output.try_recv() {
                    match event {
                        Event::Data(bytes) => match parser.push(&bytes) {
                            Ok(0) => {}
                            Ok(_) => {
                                tail_failure.get_or_insert("protocol-error");
                            }
                            Err(reason) => {
                                tail_failure.get_or_insert(reason);
                            }
                        },
                        Event::Error => {
                            tail_failure.get_or_insert("read-error");
                        }
                        Event::Eof => {}
                    }
                }
                if exit.is_none() {
                    exit = child
                        .try_wait()
                        .ok()
                        .flatten()
                        .map(|status| status.exit_code());
                }
                if exit.is_some() && reader && writer && master_closed {
                    break;
                }
                thread::sleep(Duration::from_millis(5));
            }
            if let Err(reason) = parser.finish() {
                tail_failure.get_or_insert(reason);
            }
            let bytes = io.bytes.load(Ordering::Relaxed);
            if bytes > OUTPUT_LIMIT {
                tail_failure.get_or_insert("output-limit");
            }
            if io.read_failed.load(Ordering::Relaxed) {
                tail_failure.get_or_insert("read-error");
            }
            if io.write_failed.load(Ordering::Relaxed) {
                tail_failure.get_or_insert("write-error");
            }
            // The supervising sample may already have reached its deadline.
            // One late fixed notification may be discarded safely.
            let _ = tx.send((
                cleanup_confirmed(exit.is_some(), reader, writer, master_closed),
                exit,
                tail_failure,
                bytes,
            ));
        });
        rx.recv_timeout(Duration::from_secs(5)).unwrap_or((
            false,
            None,
            Some("cleanup-failed"),
            final_bytes.load(Ordering::Relaxed),
        ))
    }
    fn environment() -> Result<(BTreeMap<OsString, OsString>, PathBuf), &'static str> {
        let source: BTreeMap<_, _> = env::vars_os().collect();
        let mut values = BTreeMap::new();
        for name in [
            "SystemRoot",
            "PATH",
            "ComSpec",
            "USERPROFILE",
            "TEMP",
            "TMP",
            "APPDATA",
            "LOCALAPPDATA",
        ] {
            if let Some((_, value)) = source
                .iter()
                .find(|(key, _)| key.to_string_lossy().eq_ignore_ascii_case(name))
            {
                values.insert(OsString::from(name), value.clone());
            } else if matches!(name, "SystemRoot" | "PATH") {
                return Err("setup-error");
            }
        }
        let root = values
            .get(&OsString::from("SystemRoot"))
            .ok_or("setup-error")?;
        if root.to_str().and_then(local_path).is_none() {
            return Err("setup-error");
        }
        let path = PathBuf::from(root).join(r"System32\WindowsPowerShell\v1.0\powershell.exe");
        Ok((values, path))
    }
    pub fn sample(arm: Arm, cwd: &Path) -> Report {
        let started = Instant::now();
        let mut report = Report::new(arm);
        // Before spawn any failed ConPTY construction/drop is still bounded by
        // the supervising Node worker deadline; no shell has been created yet.
        let setup = (|| {
            let (environment, executable) = environment()?;
            let pair = native_pty_system()
                .openpty(PtySize {
                    rows: 30,
                    cols: 120,
                    pixel_width: 0,
                    pixel_height: 0,
                })
                .map_err(|_| "setup-error")?;
            let reader = pair.master.try_clone_reader().map_err(|_| "setup-error")?;
            let writer = pair.master.take_writer().map_err(|_| "setup-error")?;
            let mut command = CommandBuilder::new(executable);
            command.args(["-NoLogo", "-NoProfile"]);
            command.env_clear();
            command.cwd(cwd);
            for (name, value) in environment {
                command.env(name, value);
            }
            let child = pair
                .slave
                .spawn_command(command)
                .map_err(|_| "setup-error")?;
            drop(pair.slave);
            Ok::<_, &'static str>((child, pair.master, reader, writer))
        })();
        let Ok((child, master, reader, writer)) = setup else {
            report.cleanup_ok = true;
            report.wall = started.elapsed().as_secs_f64() * 1000.0;
            return report;
        };
        let io = start_io(reader, writer);
        let nonce = uuid::Uuid::new_v4().simple().to_string();
        let mut parser = Parser::new(&nonce);
        let outcome = (|| {
            let startup = Instant::now();
            let startup_deadline = startup + Duration::from_secs(5);
            let ready = (|| {
                // INHERIT_CURSOR requires a complete CPR response before any
                // shell input. The writer FIFO preserves this order, and both
                // stages share the original five-second startup deadline.
                receive(
                    &io,
                    &mut parser,
                    &mut report,
                    startup_deadline,
                    Until::Cursor,
                )?;
                io.input
                    .try_send(ready_script(&nonce).into_bytes())
                    .map_err(|_| "write-error")?;
                receive(
                    &io,
                    &mut parser,
                    &mut report,
                    startup_deadline,
                    Until::Ready,
                )
            })();
            report.startup = Some(startup.elapsed().as_secs_f64() * 1000.0);
            ready?;
            let command = Instant::now();
            let script = query_script(arm, &nonce, cwd.to_str().ok_or("setup-error")?);
            io.input
                .try_send(script.into_bytes())
                .map_err(|_| "write-error")?;
            let result = receive(
                &io,
                &mut parser,
                &mut report,
                command + Duration::from_secs(30),
                Until::End,
            );
            report.host = Some(command.elapsed().as_secs_f64() * 1000.0);
            result
        })();
        report.q1 = parser.queries[0];
        report.q2 = parser.queries[1];
        report.version_ok = parser.version_ok;
        report.cwd1_ok = report.q1.is_some();
        report.cwd2_ok = report.q2.is_some();
        report.bytes = io.bytes.load(Ordering::Relaxed);
        report.failure = outcome.err();
        let ended = parser.ended;
        let (confirmed, exit, tail_failure, final_bytes) =
            cleanup(child, master, io, report.failure.is_some(), parser);
        report.bytes = final_bytes;
        if report.failure.is_none() {
            report.failure = tail_failure;
        }
        report.cleanup_ok = confirmed;
        report.exit_code = exit;
        if !confirmed {
            report.failure = Some("cleanup-failed");
        } else if exit != Some(0) {
            report.failure.get_or_insert("exit-error");
        }
        report.complete = ended && report.failure.is_none() && confirmed;
        report.wall = started.elapsed().as_secs_f64() * 1000.0;
        report
    }
    #[cfg(test)]
    mod tests {
        use super::*;
        fn mock_io() -> (Io, SyncSender<Event>, Receiver<Vec<u8>>) {
            let (events, output) = mpsc::sync_channel(4);
            let (input, commands) = mpsc::sync_channel(4);
            let (_, reader_done) = mpsc::sync_channel(1);
            let (_, writer_done) = mpsc::sync_channel(1);
            (
                Io {
                    input,
                    output,
                    reader_done,
                    writer_done,
                    bytes: Arc::new(AtomicUsize::new(0)),
                    read_failed: Arc::new(AtomicBool::new(false)),
                    write_failed: Arc::new(AtomicBool::new(false)),
                },
                events,
                commands,
            )
        }
        #[test]
        fn split_cursor_reply_precedes_ready_and_deadline_is_not_reset() {
            let (io, events, commands) = mock_io();
            let nonce = "0123456789abcdef0123456789abcdef";
            let mut parser = Parser::new(nonce);
            let mut report = Report::new(Arm::Unqualified);
            events.send(Event::Data(b"\x1b[6".to_vec())).unwrap();
            events.send(Event::Data(b"n".to_vec())).unwrap();
            let deadline = Instant::now() + Duration::from_millis(100);
            receive(&io, &mut parser, &mut report, deadline, Until::Cursor).unwrap();
            io.input.try_send(ready_script(nonce).into_bytes()).unwrap();
            assert_eq!(commands.recv().unwrap(), b"\x1b[1;1R");
            assert_eq!(commands.recv().unwrap(), ready_script(nonce).as_bytes());
            assert_eq!(report.cpr, 1);
            assert_eq!(
                receive(&io, &mut parser, &mut report, Instant::now(), Until::Ready),
                Err("startup-timeout")
            );
        }
        #[test]
        fn incomplete_cursor_request_never_enqueues_shell_input() {
            let (io, events, commands) = mock_io();
            events.send(Event::Data(b"\x1b[6".to_vec())).unwrap();
            let mut parser = Parser::new("0123456789abcdef0123456789abcdef");
            let mut report = Report::new(Arm::Unqualified);
            assert_eq!(
                receive(
                    &io,
                    &mut parser,
                    &mut report,
                    Instant::now() + Duration::from_millis(2),
                    Until::Cursor
                ),
                Err("startup-timeout")
            );
            assert!(commands.try_recv().is_err());
            assert_eq!(report.cpr, 0);
        }
    }
}

#[cfg(windows)]
fn main() {
    use std::io::Write;
    let args: Vec<_> = std::env::args().skip(1).collect();
    let arm = match args.as_slice() {
        [flag, arm] if flag == "--sample" && arm == "unqualified" => probe::Arm::Unqualified,
        [flag, arm] if flag == "--sample" && arm == "module-qualified" => probe::Arm::Qualified,
        _ => std::process::exit(1),
    };
    let directory = std::env::temp_dir().join(format!(
        "p1 qualified 中文-{}",
        uuid::Uuid::new_v4().simple()
    ));
    let cwd = std::fs::create_dir(&directory)
        .and_then(|()| std::fs::canonicalize(&directory))
        .and_then(|path| {
            path.to_str()
                .and_then(probe::local_path)
                .map(std::path::PathBuf::from)
                .ok_or_else(|| std::io::Error::other("unsupported cwd"))
        });
    let mut report = match cwd {
        Ok(cwd) => {
            // canonicalize yields a Windows verbatim prefix; PowerShell's provider
            // reports an ordinary local path. Strip only that fixed prefix in memory.
            windows_worker::sample(arm, &cwd)
        }
        Err(_) => {
            let mut r = probe::Report::new(arm);
            r.cleanup_ok = true;
            r
        }
    };
    if report.cleanup_ok && std::fs::remove_dir(&directory).is_err() {
        report.failure = Some("setup-error");
        report.complete = false;
    }
    let output_ok = {
        let mut output = std::io::stdout().lock();
        writeln!(output, "{}", report.json())
            .and_then(|()| output.flush())
            .is_ok()
    };
    if !report.cleanup_ok {
        // Even if the report pipe failed, retain the process-tree root until
        // the supervising wrapper's bounded tree termination runs.
        loop {
            std::thread::park();
        }
    }
    if !output_ok || !report.complete {
        std::process::exit(1);
    }
}
