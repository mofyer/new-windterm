//! One supervised ConPTY diagnostic sample. The Node wrapper owns the matrix.
#[cfg(any(windows, test))]
#[path = "support/ready_frame.rs"]
mod ready_frame;
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
    fn frame() -> String {
        format!("~B{NONCE}|R|5.1.20348.5622|E{NONCE}~")
    }
    #[test]
    fn framed_script_echo_cannot_satisfy_armed_protocol_at_any_split() {
        let script = framed_ready_script(NONCE);
        assert!(!script.contains(&format!("~B{NONCE}|")));
        assert!(!script.contains(&format!("|E{NONCE}~")));
        assert!(!script.contains(NONCE));
        for input in [&script, &format!("PS> {script}")] {
            let mut parser = Parser::framed(NONCE);
            parser.arm_frame();
            for byte in input.bytes() {
                parser.push(&[byte]).unwrap();
            }
            parser.finish().unwrap();
            assert!(!parser.version_ok);
            for cut in 0..=input.len() {
                let mut parser = Parser::framed(NONCE);
                parser.arm_frame();
                parser.push(&input.as_bytes()[..cut]).unwrap();
                parser.push(&input.as_bytes()[cut..]).unwrap();
                parser.finish().unwrap();
                assert!(!parser.version_ok);
            }
        }
    }
    #[test]
    fn framed_snapshot_preserves_first_error_and_distinguishes_legacy_line_protocol() {
        let mut parser = Parser::framed(NONCE);
        parser.arm_frame();
        parser
            .push(format!("prompt{}suffix", frame()).as_bytes())
            .unwrap();
        assert!(parser.version_ok);
        assert_eq!(parser.ready_counts(), (1, 0));
        assert_eq!(parser.diagnostic().stage, "after-frame");
        assert_eq!(parser.push(frame().as_bytes()), Err("protocol-error"));
        let frozen = parser.diagnostic();
        assert_eq!(frozen.reason, Some("duplicate-frame"));
        parser.record_failure("cleanup-failed");
        assert_eq!(parser.diagnostic(), frozen);
        let mut legacy = Parser::startup(NONCE);
        legacy.push(frame().as_bytes()).unwrap();
        assert!(!legacy.version_ok);
    }
    #[test]
    fn framed_report_uses_only_its_new_fixed_fields() {
        let mut report = Report::new(Arm::Unqualified);
        report.startup_only = true;
        report.startup_framed = true;
        let value: serde_json::Value = serde_json::from_str(&report.json()).unwrap();
        assert_eq!(value.as_object().unwrap().len(), 19);
        assert_eq!(value["mode"], "startup-framed");
        assert_eq!(value["schema"], 1);
        assert_eq!(value["frameCount"], 0);
        for legacy in [
            "terminalCounters",
            "strictReadyCount",
            "embeddedReadyCount",
            "q1Ms",
            "arm",
        ] {
            assert!(value.get(legacy).is_none());
        }
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
        let diagnostic = parser.diagnostic();
        assert_eq!(diagnostic.stage, "after-end");
        assert_eq!(diagnostic.reason, None);
        assert_eq!(diagnostic.counters.cr, 6);
        assert_eq!(diagnostic.counters.marker_lines, 6);
    }
    #[test]
    fn shared_layout_fixtures_preserve_real_parser_results_at_every_split() {
        let fixtures: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../../tests/fixtures/conpty-startup-layout.json"
        ))
        .unwrap();
        let nonce = fixtures["nonce"].as_str().unwrap();
        for case in fixtures["cases"].as_array().unwrap() {
            let input = case["input"].as_str().unwrap().as_bytes();
            for cut in (0..=input.len()).map(Some).chain(std::iter::once(None)) {
                let chunks: Vec<&[u8]> = match cut {
                    Some(at) => vec![&input[..at], &input[at..]],
                    None => input.chunks(1).collect(),
                };
                let mut parser = Parser::startup(nonce);
                let result = chunks
                    .into_iter()
                    .try_for_each(|chunk| parser.push(chunk).map(|_| ()))
                    .and_then(|()| parser.finish());
                let expected = &case["parser"];
                let (strict, embedded) = parser.ready_counts();
                assert_eq!(
                    parser.version_ok,
                    expected["versionOk"].as_bool().unwrap(),
                    "{} split {cut:?}",
                    case["id"]
                );
                assert_eq!(
                    strict,
                    expected["strictReadyCount"].as_u64().unwrap() as usize,
                    "{} split {cut:?}",
                    case["id"]
                );
                assert_eq!(
                    embedded,
                    expected["embeddedReadyCount"].as_u64().unwrap() as usize,
                    "{} split {cut:?}",
                    case["id"]
                );
                assert_eq!(
                    parser.diagnostic().reason,
                    expected["reason"].as_str(),
                    "{} split {cut:?}: {result:?}",
                    case["id"]
                );
            }
        }
    }
    // These are synthetic terminal streams, not captured Windows evidence.
    #[test]
    fn synthetic_cursor_and_erase_fixtures_preserve_rejection_rules() {
        let p = format!("P1Q_{NONCE}|");
        for (tail, stage, cursor, erase, embedded) in [
            (
                format!("{p}START|1\x1b[2;1H{p}RESULT|1|1|true\n"),
                "await-start-1",
                1,
                0,
                0,
            ),
            (
                format!("PS>\r\x1b[2K{p}START|1\n{p}RESULT|1|1|true\n"),
                "await-start-1",
                0,
                1,
                1,
            ),
        ] {
            let mut parser = Parser::new(NONCE);
            parser
                .push(format!("{p}READY|5.1.1.1\n").as_bytes())
                .unwrap();
            assert_eq!(parser.push(tail.as_bytes()), Err("protocol-error"));
            let d = parser.diagnostic();
            assert_eq!(d.stage, stage);
            assert_eq!(d.reason, Some("unexpected-record"));
            assert_eq!(d.counters.csi_cursor, cursor);
            assert_eq!(d.counters.csi_erase, erase);
            assert_eq!(d.counters.embedded_marker_lines, embedded);
        }
    }
    #[test]
    fn duplicate_redraw_and_cleanup_preserve_first_failure_snapshot() {
        let p = format!("P1Q_{NONCE}|");
        let mut parser = Parser::new(NONCE);
        parser
            .push(format!("{p}READY|5.1.1.1\n{p}START|1\n").as_bytes())
            .unwrap();
        assert_eq!(
            parser.push(format!("{p}START|1\n").as_bytes()),
            Err("protocol-error")
        );
        let first = parser.diagnostic();
        assert_eq!(first.stage, "await-result-1");
        assert_eq!(first.counters.duplicate_markers, 1);
        let _ = parser.push(b"\r\n\x1b[2J");
        parser.record_failure("cleanup-failed");
        assert_eq!(parser.diagnostic(), first);
    }
    #[test]
    fn timeout_context_and_counter_saturation_are_fixed() {
        let mut parser = Parser::new(NONCE);
        parser.await_cursor = true;
        parser.record_failure("startup-timeout");
        assert_eq!(parser.diagnostic().stage, "await-cursor");
        assert_eq!(parser.diagnostic().reason, Some("startup-timeout"));
        let mut parser = Parser::new(NONCE);
        parser.push(&vec![b'\r'; COUNTER_LIMIT + 1]).unwrap();
        assert_eq!(parser.diagnostic().counters.cr, COUNTER_LIMIT);
    }
    #[test]
    fn split_synthetic_control_sequences_have_identical_diagnostics() {
        let input = format!("\x1b[4;1H\x1b[2K{}", lines());
        let mut whole = Parser::new(NONCE);
        whole.push(input.as_bytes()).unwrap();
        for cut in 0..=input.len() {
            let mut split = Parser::new(NONCE);
            split.push(&input.as_bytes()[..cut]).unwrap();
            split.push(&input.as_bytes()[cut..]).unwrap();
            assert_eq!(split.diagnostic(), whole.diagnostic());
            assert!(split.ended);
        }
    }
    #[test]
    fn startup_only_classifies_complete_embedded_ready_without_accepting_it() {
        let p = format!("P1Q_{NONCE}|");
        for suffix in ["READY|5.1.1.2", "READY|5.1.0001.2"] {
            let text = format!("PS>\r\x1b[2K{p}{suffix}\r\n");
            for cut in 0..=text.len() {
                let mut parser = Parser::startup(NONCE);
                parser.push(&text.as_bytes()[..cut]).unwrap();
                parser.push(&text.as_bytes()[cut..]).unwrap();
                assert_eq!(parser.ready_counts(), (0, 1));
                assert!(!parser.version_ok);
            }
        }
        for suffix in [
            "READY|7.1.1.2",
            "READY|5.1.1.2junk",
            "READY|5.1.1.2|extra",
            "READY|5.1.1",
            "READY|5.1.1.2\0",
        ] {
            let mut parser = Parser::startup(NONCE);
            parser
                .push(format!("prompt{p}{suffix}\n").as_bytes())
                .unwrap();
            assert_eq!(parser.ready_counts(), (0, 0));
        }
        let mut parser = Parser::startup(NONCE);
        parser
            .push(format!("prompt{p}READY|5.1.1.2").as_bytes())
            .unwrap();
        assert_eq!(parser.ready_counts(), (0, 0));
        let mut parser = Parser::startup(NONCE);
        let mut invalid = format!("prompt{p}READY|5.1.1.").into_bytes();
        invalid.extend_from_slice(&[0xff, b'\n']);
        parser.push(&invalid).unwrap();
        assert_eq!(parser.ready_counts(), (0, 0));
    }
    #[test]
    fn startup_strict_ready_is_unique_and_never_accepts_query_records() {
        let p = format!("P1Q_{NONCE}|");
        let mut parser = Parser::startup(NONCE);
        parser
            .push(format!("{p}READY|5.1.1.2\n").as_bytes())
            .unwrap();
        assert!(parser.version_ok);
        assert_eq!(parser.ready_counts(), (1, 0));
        assert_eq!(parser.diagnostic().stage, "after-ready");
        assert_eq!(
            parser.push(format!("{p}START|1\n").as_bytes()),
            Err("protocol-error")
        );
        assert_eq!(parser.queries, [None, None]);
        let first = parser.ready_counts();
        let _ = parser.push(format!("{p}READY|5.1.1.2\n").as_bytes());
        assert_eq!(parser.ready_counts(), first);
    }
    #[test]
    fn ready_write_evidence_uses_actual_completion_before_the_frozen_cutoff() {
        let start = std::time::Instant::now();
        let cutoff = start + Duration::from_secs(5);
        assert_eq!(
            ready_write_ms(start, cutoff, Some(start + Duration::from_millis(12))),
            Some(12.0)
        );
        assert_eq!(ready_write_ms(start, cutoff, Some(cutoff)), None);
        assert_eq!(
            ready_write_ms(start, cutoff, Some(cutoff + Duration::from_millis(1))),
            None
        );
        assert_eq!(ready_write_ms(start, cutoff, None), None);
    }
    #[test]
    fn startup_schema_has_no_query_fields_or_raw_state() {
        let mut report = Report::new(Arm::Unqualified);
        report.startup_only = true;
        let value: serde_json::Value = serde_json::from_str(&report.json()).unwrap();
        assert_eq!(value["mode"], "startup-only");
        assert_eq!(value["schema"], 1);
        assert_eq!(value["startupComplete"], false);
        assert_eq!(value["readyWriteCompleted"], false);
        assert_eq!(value["readyWriteMs"], serde_json::Value::Null);
        for key in ["arm", "q1Ms", "q2Ms", "cwd1Ok", "hostMs"] {
            assert!(value.get(key).is_none());
        }
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
        assert_eq!(value["schema"], 2);
        assert_eq!(value["expectedStage"], "not-started");
        assert_eq!(value["protocolReason"], "setup-error");
        assert!(value["killRequested"].is_null());
        assert!(value["exitObservedBeforeKill"].is_null());
        assert_eq!(value["terminalCounters"].as_object().unwrap().len(), 8);
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
    pub const COUNTER_LIMIT: usize = 262_144;
    #[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
    pub struct TerminalCounters {
        pub cr: usize,
        pub lf: usize,
        pub csi_cursor: usize,
        pub csi_erase: usize,
        pub marker_lines: usize,
        pub duplicate_markers: usize,
        pub embedded_marker_lines: usize,
        pub ignored_lines: usize,
    }
    fn increment(counter: &mut usize) {
        *counter = (*counter + 1).min(COUNTER_LIMIT);
    }
    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub struct Diagnostic {
        pub stage: &'static str,
        pub reason: Option<&'static str>,
        pub counters: TerminalCounters,
        ready_counts: (usize, usize),
    }
    impl Diagnostic {
        pub fn record_failure(&mut self, reason: &'static str) {
            if self.reason.is_none() {
                self.reason = Some(reason);
            }
        }
    }
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
        pub startup_framed: bool,
        pub frame_count: usize,
        pub startup_only: bool,
        pub startup_complete: bool,
        pub ready_write_ms: Option<f64>,
        pub strict_ready_count: usize,
        pub embedded_ready_count: usize,
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
        pub diagnostic: Diagnostic,
        pub kill_requested: Option<bool>,
        pub exit_observed_before_kill: Option<bool>,
    }
    impl Report {
        pub fn new(arm: Arm) -> Self {
            Self {
                startup_framed: false,
                frame_count: 0,
                startup_only: false,
                startup_complete: false,
                ready_write_ms: None,
                strict_ready_count: 0,
                embedded_ready_count: 0,
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
                diagnostic: Diagnostic {
                    stage: "not-started",
                    reason: Some("setup-error"),
                    counters: TerminalCounters::default(),
                    ready_counts: (0, 0),
                },
                kill_requested: None,
                exit_observed_before_kill: None,
            }
        }
        pub fn json(&self) -> String {
            let number = |value: Option<f64>| {
                value
                    .filter(|n| n.is_finite() && *n >= 0.0)
                    .map_or_else(|| "null".to_owned(), |n| n.to_string())
            };
            let c = self.diagnostic.counters;
            let boolean = |v: Option<bool>| v.map_or_else(|| "null".to_owned(), |v| v.to_string());
            if self.startup_framed {
                return format!("{{\"schema\":1,\"mode\":\"startup-framed\",\"startupMs\":{},\"wallMs\":{},\"versionOk\":{},\"exitCode\":{},\"cprReplies\":{},\"mergedBytes\":{},\"startupComplete\":{},\"complete\":{},\"cleanupOk\":{},\"failure\":{},\"expectedStage\":\"{}\",\"protocolReason\":{},\"killRequested\":{},\"exitObservedBeforeKill\":{},\"readyWriteCompleted\":{},\"readyWriteMs\":{},\"frameCount\":{}}}", number(self.startup),number(Some(self.wall)),self.version_ok,self.exit_code.map_or_else(|| "null".to_owned(), |n|n.to_string()),self.cpr,self.bytes,self.startup_complete,self.complete,self.cleanup_ok,self.failure.map_or_else(|| "null".to_owned(), |s|format!("\"{s}\"")),self.diagnostic.stage,self.diagnostic.reason.map_or_else(|| "null".to_owned(), |s|format!("\"{s}\"")),boolean(self.kill_requested),boolean(self.exit_observed_before_kill),self.ready_write_ms.is_some(),number(self.ready_write_ms),self.frame_count);
            }
            if self.startup_only {
                return format!("{{\"schema\":1,\"mode\":\"startup-only\",\"startupMs\":{},\"wallMs\":{},\"versionOk\":{},\"exitCode\":{},\"cprReplies\":{},\"mergedBytes\":{},\"startupComplete\":{},\"complete\":{},\"cleanupOk\":{},\"failure\":{},\"expectedStage\":\"{}\",\"protocolReason\":{},\"terminalCounters\":{{\"cr\":{},\"lf\":{},\"csiCursor\":{},\"csiErase\":{},\"markerLines\":{},\"duplicateMarkers\":{},\"embeddedMarkerLines\":{},\"ignoredLines\":{}}},\"killRequested\":{},\"exitObservedBeforeKill\":{},\"readyWriteCompleted\":{},\"readyWriteMs\":{},\"strictReadyCount\":{},\"embeddedReadyCount\":{}}}", number(self.startup),number(Some(self.wall)),self.version_ok,self.exit_code.map_or_else(|| "null".to_owned(), |n|n.to_string()),self.cpr,self.bytes,self.startup_complete,self.complete,self.cleanup_ok,self.failure.map_or_else(|| "null".to_owned(), |s|format!("\"{s}\"")),self.diagnostic.stage,self.diagnostic.reason.map_or_else(|| "null".to_owned(), |s|format!("\"{s}\"")),c.cr,c.lf,c.csi_cursor,c.csi_erase,c.marker_lines,c.duplicate_markers,c.embedded_marker_lines,c.ignored_lines,boolean(self.kill_requested),boolean(self.exit_observed_before_kill),self.ready_write_ms.is_some(),number(self.ready_write_ms),self.strict_ready_count,self.embedded_ready_count);
            }
            format!("{{\"schema\":2,\"arm\":\"{}\",\"q1Ms\":{},\"q2Ms\":{},\"startupMs\":{},\"hostMs\":{},\"wallMs\":{},\"versionOk\":{},\"cwd1Ok\":{},\"cwd2Ok\":{},\"exitCode\":{},\"cprReplies\":{},\"mergedBytes\":{},\"complete\":{},\"cleanupOk\":{},\"failure\":{},\"expectedStage\":\"{}\",\"protocolReason\":{},\"terminalCounters\":{{\"cr\":{},\"lf\":{},\"csiCursor\":{},\"csiErase\":{},\"markerLines\":{},\"duplicateMarkers\":{},\"embeddedMarkerLines\":{},\"ignoredLines\":{}}},\"killRequested\":{},\"exitObservedBeforeKill\":{}}}", self.arm.name(), number(self.q1), number(self.q2), number(self.startup), number(self.host), number(Some(self.wall)), self.version_ok, self.cwd1_ok, self.cwd2_ok, self.exit_code.map_or_else(|| "null".to_owned(), |n| n.to_string()), self.cpr, self.bytes, self.complete, self.cleanup_ok, self.failure.map_or_else(|| "null".to_owned(), |s| format!("\"{s}\"")), self.diagnostic.stage, self.diagnostic.reason.map_or_else(|| "null".to_owned(), |s| format!("\"{s}\"")), c.cr,c.lf,c.csi_cursor,c.csi_erase,c.marker_lines,c.duplicate_markers,c.embedded_marker_lines,c.ignored_lines,boolean(self.kill_requested),boolean(self.exit_observed_before_kill))
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
        framed: Option<super::ready_frame::FrameParser>,
        startup_only: bool,
        strict_ready_count: usize,
        embedded_ready_count: usize,
        prefix: String,
        line: Vec<u8>,
        escape: Escape,
        step: usize,
        pub version_ok: bool,
        pub queries: [Option<f64>; 2],
        pub ended: bool,
        pub await_cursor: bool,
        counters: TerminalCounters,
        seen_markers: u8,
        first_failure: Option<Diagnostic>,
    }
    impl Parser {
        pub fn new(nonce: &str) -> Self {
            Self {
                framed: None,
                startup_only: false,
                strict_ready_count: 0,
                embedded_ready_count: 0,
                prefix: format!("P1Q_{nonce}|"),
                line: Vec::new(),
                escape: Escape::Text,
                step: 0,
                version_ok: false,
                queries: [None, None],
                ended: false,
                await_cursor: false,
                counters: TerminalCounters::default(),
                seen_markers: 0,
                first_failure: None,
            }
        }
        pub fn startup(nonce: &str) -> Self {
            Self {
                startup_only: true,
                ..Self::new(nonce)
            }
        }
        pub fn framed(nonce: &str) -> Self {
            Self {
                framed: Some(super::ready_frame::FrameParser::new(nonce)),
                startup_only: true,
                ..Self::new(nonce)
            }
        }
        pub fn arm_frame(&mut self) {
            if let Some(frame) = &mut self.framed {
                frame.arm();
            }
        }
        pub fn ready_counts(&self) -> (usize, usize) {
            self.diagnostic().ready_counts
        }
        pub fn diagnostic(&self) -> Diagnostic {
            if let Some(frozen) = self.first_failure {
                return frozen;
            }
            if let Some(frame) = &self.framed {
                let d = frame.diagnostic();
                return Diagnostic {
                    stage: if self.await_cursor {
                        "await-cursor"
                    } else {
                        d.stage
                    },
                    reason: d.reason,
                    counters: TerminalCounters::default(),
                    ready_counts: (d.counters.frames, 0),
                };
            }
            self.first_failure.unwrap_or(Diagnostic {
                stage: if self.await_cursor {
                    "await-cursor"
                } else if self.startup_only && self.step > 0 {
                    "after-ready"
                } else {
                    match self.step {
                        0 => "await-ready",
                        1 => "await-start-1",
                        2 => "await-result-1",
                        3 => "await-start-2",
                        4 => "await-result-2",
                        5 => "await-end",
                        _ => "after-end",
                    }
                },
                reason: None,
                counters: self.counters,
                ready_counts: (self.strict_ready_count, self.embedded_ready_count),
            })
        }
        pub fn record_failure(&mut self, reason: &'static str) {
            if self.first_failure.is_none() {
                let mut diagnostic = self.diagnostic();
                diagnostic.record_failure(reason);
                self.first_failure = Some(diagnostic);
            }
        }
        fn fail<T>(
            &mut self,
            reason: &'static str,
            failure: &'static str,
        ) -> Result<T, &'static str> {
            self.record_failure(reason);
            Err(failure)
        }
        pub fn push(&mut self, bytes: &[u8]) -> Result<usize, &'static str> {
            if let Some(frame) = &mut self.framed {
                let result = frame.push(bytes);
                self.version_ok = frame.seen();
                let reason = frame.diagnostic().reason;
                if let Some(reason) = reason {
                    self.record_failure(reason);
                }
                return result;
            }
            let mut cpr = 0;
            for &byte in bytes {
                if byte == b'\r' {
                    increment(&mut self.counters.cr);
                }
                if byte == b'\n' {
                    increment(&mut self.counters.lf);
                }
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
                                return self.fail("line-limit", "output-limit");
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
                            if b"ABCDEFGHfade`".contains(&byte) {
                                increment(&mut self.counters.csi_cursor);
                            }
                            if matches!(byte, b'J' | b'K') {
                                increment(&mut self.counters.csi_erase);
                            }
                            if byte == b'n' && sequence == b"6" {
                                cpr += 1;
                            }
                            self.escape = Escape::Text;
                        } else {
                            if sequence.len() >= 64 {
                                return self.fail("escape-limit", "protocol-error");
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
        pub fn finish(&mut self) -> Result<(), &'static str> {
            if let Some(frame) = &mut self.framed {
                let result = frame.finish();
                let reason = frame.diagnostic().reason;
                if let Some(reason) = reason {
                    self.record_failure(reason);
                }
                return result;
            }
            if !self.line.is_empty()
                && (self.line.starts_with(self.prefix.as_bytes())
                    || self.prefix.as_bytes().starts_with(&self.line))
            {
                return self.fail("incomplete-marker", "protocol-error");
            }
            Ok(())
        }
        fn consume_line(&mut self) -> Result<(), &'static str> {
            if self.startup_only {
                // Classify only LF-terminated complete shapes. A nonce inside
                // ignored prompt text remains diagnostic evidence, never READY.
                for offset in 0..self.line.len() {
                    let candidate = &self.line[offset..];
                    if let Some(payload) = candidate.strip_prefix(self.prefix.as_bytes()) {
                        if let Ok(payload) = std::str::from_utf8(payload) {
                            if payload.strip_prefix("READY|").is_some_and(valid_version) {
                                if offset == 0 {
                                    increment(&mut self.strict_ready_count);
                                } else {
                                    increment(&mut self.embedded_ready_count);
                                }
                                break;
                            }
                        }
                    }
                }
            }
            if !self.line.starts_with(self.prefix.as_bytes()) {
                if !self.line.is_empty() {
                    increment(&mut self.counters.ignored_lines);
                }
                if self
                    .line
                    .windows(self.prefix.len())
                    .any(|w| w == self.prefix.as_bytes())
                {
                    increment(&mut self.counters.embedded_marker_lines);
                }
                return Ok(());
            }
            increment(&mut self.counters.marker_lines);
            let Ok(line) = std::str::from_utf8(&self.line) else {
                return self.fail("invalid-utf8", "protocol-error");
            };
            let fields: Vec<_> = line[self.prefix.len()..].split('|').collect();
            let marker = match fields.as_slice() {
                ["READY", ..] => 1,
                ["START", "1", ..] => 2,
                ["RESULT", "1", ..] => 4,
                ["START", "2", ..] => 8,
                ["RESULT", "2", ..] => 16,
                ["END", ..] => 32,
                ["ERROR", ..] => 64,
                _ => 0,
            };
            if marker != 0 && self.seen_markers & marker != 0 {
                increment(&mut self.counters.duplicate_markers);
            }
            self.seen_markers |= marker;
            if fields == ["ERROR"] {
                return self.fail("command-error", "command-error");
            }
            if self.startup_only && self.step > 0 {
                return self.fail("unexpected-record", "protocol-error");
            }
            match self.step {
                0 => {
                    if fields.len() != 2 || fields[0] != "READY" {
                        return self.fail("unexpected-record", "protocol-error");
                    }
                    if !valid_version(fields[1]) {
                        return self.fail("invalid-version", "protocol-error");
                    }
                    self.version_ok = true;
                }
                1 | 3 => {
                    let expected = if self.step == 1 { "1" } else { "2" };
                    if fields != ["START", expected] {
                        return self.fail("unexpected-record", "protocol-error");
                    }
                }
                2 | 4 => {
                    let index = if self.step == 2 { 0 } else { 1 };
                    if fields.len() != 4
                        || fields[0] != "RESULT"
                        || fields[1] != if index == 0 { "1" } else { "2" }
                    {
                        return self.fail("unexpected-record", "protocol-error");
                    }
                    if fields[3] != "true" {
                        return self.fail("cwd-mismatch", "cwd-mismatch");
                    }
                    if !fields[2].as_bytes().first().is_some_and(u8::is_ascii_digit) {
                        return self.fail("invalid-number", "protocol-error");
                    }
                    let Ok(elapsed) = fields[2].parse::<f64>() else {
                        return self.fail("invalid-number", "protocol-error");
                    };
                    if !elapsed.is_finite()
                        || elapsed < 0.0
                        || elapsed + self.queries[0].unwrap_or(0.0) > 30_000.0
                    {
                        return self.fail("timing-bound", "protocol-error");
                    }
                    self.queries[index] = Some(elapsed);
                }
                5 => {
                    if fields != ["END"] {
                        return self.fail("unexpected-record", "protocol-error");
                    }
                    self.ended = true;
                }
                _ => {
                    self.ended = false;
                    return self.fail("unexpected-record", "protocol-error");
                }
            }
            self.step += 1;
            Ok(())
        }
    }
    fn valid_version(value: &str) -> bool {
        let version: Vec<_> = value.split('.').collect();
        version.len() == 4
            && version[0] == "5"
            && version[1] == "1"
            && version[2..]
                .iter()
                .all(|s| !s.is_empty() && s.len() <= 10 && s.bytes().all(|b| b.is_ascii_digit()))
    }
    pub fn ready_write_ms(
        start: Instant,
        cutoff: Instant,
        completed: Option<Instant>,
    ) -> Option<f64> {
        completed
            .filter(|at| *at >= start && *at < cutoff)
            .map(|at| at.duration_since(start).as_secs_f64() * 1000.0)
    }
    fn prefix_assignment(nonce: &str) -> String {
        format!("$p=('P1Q_'+'{}'+'{}'+'|');", &nonce[..16], &nonce[16..])
    }
    pub fn ready_script(nonce: &str) -> String {
        format!("{}[Console]::WriteLine();[Console]::WriteLine($p+'READY|'+$PSVersionTable.PSVersion.ToString());\r\n", prefix_assignment(nonce))
    }
    pub fn framed_ready_script(nonce: &str) -> String {
        let (left, right) = nonce.split_at(16);
        // Literal command echo never contains a complete begin or end token.
        format!("$n='{left}'+'{right}';$b='~'+'B'+$n+'|';$e='|'+'E'+$n+'~';[Console]::Out.WriteLine();[Console]::Out.WriteLine($b+'R|'+[string]$PSVersionTable.PSVersion+$e)\r\n")
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

#[cfg(any(windows, test))]
mod windows_worker {
    use super::probe::*;
    use portable_pty::Child;
    #[cfg(windows)]
    use portable_pty::{native_pty_system, CommandBuilder, PtySize};
    #[cfg(windows)]
    use std::{
        collections::BTreeMap,
        env,
        ffi::OsString,
        path::{Path, PathBuf},
    };
    use std::{
        io::{Read, Write},
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
    #[derive(Debug)]
    struct WriteRequest {
        bytes: Vec<u8>,
        ready_done: Option<SyncSender<Instant>>,
    }
    impl From<Vec<u8>> for WriteRequest {
        fn from(bytes: Vec<u8>) -> Self {
            Self {
                bytes,
                ready_done: None,
            }
        }
    }
    struct Io {
        input: SyncSender<WriteRequest>,
        output: Receiver<Event>,
        reader_done: Receiver<()>,
        writer_done: Receiver<()>,
        bytes: Arc<AtomicUsize>,
        read_failed: Arc<AtomicBool>,
        write_failed: Arc<AtomicBool>,
    }
    fn start_io(mut reader: Box<dyn Read + Send>, mut writer: Box<dyn Write + Send>) -> Io {
        let (tx, output) = mpsc::sync_channel(64);
        let (input, commands) = mpsc::sync_channel::<WriteRequest>(4);
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
                    .write_all(&command.bytes)
                    .and_then(|()| writer.flush())
                    .is_err()
                {
                    failed.store(true, Ordering::Relaxed);
                    break;
                }
                if let Some(ready_done) = command.ready_done {
                    // One fixed acknowledgment only. After timeout the receiver
                    // may be gone; a late write cannot revise the frozen report.
                    let _ = ready_done.try_send(Instant::now());
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
        parser.await_cursor = matches!(until, Until::Cursor);
        let result = (|| loop {
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
                            .try_send(b"\x1b[1;1R".to_vec().into())
                            .map_err(|_| "write-error")?;
                        report.cpr += 1;
                        if report.cpr > 65_536 {
                            parser.record_failure("late-cpr");
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
                Ok(Event::Eof) => {
                    parser.record_failure("eof-before-complete");
                    return Err("protocol-error");
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => return Err("read-error"),
            }
        })();
        if let Err(reason) = result {
            parser.record_failure(reason);
        }
        if matches!(until, Until::Cursor) && result.is_ok() {
            parser.await_cursor = false;
        }
        result
    }
    struct CleanupOutcome {
        confirmed: bool,
        exit: Option<u32>,
        failure: Option<&'static str>,
        bytes: usize,
        diagnostic: Diagnostic,
        kill_requested: Option<bool>,
        exit_before_kill: Option<bool>,
    }
    // The write ACK and child exit share the existing graceful-exit window.
    // Keeping the sender alive also keeps the writer/ConPTY input handle alive.
    fn startup_exit(
        input: &SyncSender<WriteRequest>,
        child: &mut dyn Child,
        deadline: Instant,
    ) -> (Option<u32>, Option<&'static str>) {
        let (done, ack) = mpsc::sync_channel(1);
        if input
            .try_send(WriteRequest {
                bytes: b"exit 0\r\n".to_vec(),
                ready_done: Some(done),
            })
            .is_err()
        {
            return (None, Some("write-error"));
        }
        match ack.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
            Ok(at) if at < deadline && Instant::now() < deadline => {}
            _ => return (None, Some("write-error")),
        }
        match poll_exit(child, deadline.saturating_duration_since(Instant::now())) {
            Ok(exit) => (exit, None),
            Err(_) => (None, Some("exit-error")),
        }
    }
    fn cleanup<M: Send + 'static>(
        mut child: Box<dyn Child + Send + Sync>,
        master: M,
        io: Io,
        failed: bool,
        startup_only: bool,
        mut parser: Parser,
    ) -> CleanupOutcome {
        let final_bytes = io.bytes.clone();
        let mut fallback_diagnostic = parser.diagnostic();
        fallback_diagnostic.record_failure("cleanup-failed");
        let (tx, rx) = mpsc::sync_channel(1);
        thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_millis(4500);
            let mut tail_failure = None;
            let mut exit = if startup_only && !failed {
                let (exit, failure) = startup_exit(
                    &io.input,
                    child.as_mut(),
                    Instant::now() + Duration::from_millis(500),
                );
                tail_failure = failure;
                if let Some(reason) = failure {
                    parser.record_failure(reason);
                }
                exit
            } else {
                // Preserve the original qualified-sample and failed-startup policy.
                None
            };
            let input = if startup_only && !failed {
                Some(io.input)
            } else {
                drop(io.input);
                exit = if failed {
                    None
                } else {
                    poll_exit(child.as_mut(), Duration::from_millis(500))
                        .ok()
                        .flatten()
                };
                None
            };
            let mut kill_requested = false;
            let exit_before_kill = if exit.is_some() {
                Some(true)
            } else {
                // Observe without changing the existing failed-sample kill policy.
                child.try_wait().ok().map(|status| status.is_some())
            };
            if exit.is_none() {
                // portable-pty's return value is not termination evidence.
                // Only the subsequent try_wait observation can confirm exit.
                kill_requested = true;
                let _ = child.kill();
                exit = poll_exit(child.as_mut(), Duration::from_secs(2))
                    .ok()
                    .flatten();
            }
            // Startup-only input stays open through exit observation or the
            // bounded kill fallback, then releases the writer for cleanup.
            drop(input);
            let (closed_tx, closed) = mpsc::sync_channel(1);
            thread::spawn(move || {
                drop(master);
                let _ = closed_tx.send(());
            });
            let mut reader = false;
            let mut writer = false;
            let mut master_closed = false;
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
                                parser.record_failure("late-cpr");
                                tail_failure.get_or_insert("protocol-error");
                            }
                            Err(reason) => {
                                tail_failure.get_or_insert(reason);
                            }
                        },
                        Event::Error => {
                            parser.record_failure("read-error");
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
                parser.record_failure("output-limit");
                tail_failure.get_or_insert("output-limit");
            }
            if io.read_failed.load(Ordering::Relaxed) {
                parser.record_failure("read-error");
                tail_failure.get_or_insert("read-error");
            }
            if io.write_failed.load(Ordering::Relaxed) {
                parser.record_failure("write-error");
                tail_failure.get_or_insert("write-error");
            }
            // The supervising sample may already have reached its deadline.
            // One late fixed notification may be discarded safely.
            let confirmed = cleanup_confirmed(exit.is_some(), reader, writer, master_closed);
            if !confirmed {
                parser.record_failure("cleanup-failed");
            } else if exit != Some(0) {
                parser.record_failure("exit-error");
            }
            let _ = tx.send(CleanupOutcome {
                confirmed,
                exit,
                failure: tail_failure,
                bytes,
                diagnostic: parser.diagnostic(),
                kill_requested: Some(kill_requested),
                exit_before_kill,
            });
        });
        rx.recv_timeout(Duration::from_secs(5))
            .unwrap_or_else(|_| CleanupOutcome {
                confirmed: false,
                exit: None,
                failure: Some("cleanup-failed"),
                bytes: final_bytes.load(Ordering::Relaxed),
                diagnostic: fallback_diagnostic,
                kill_requested: None,
                exit_before_kill: None,
            })
    }
    #[cfg(windows)]
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
    #[cfg(windows)]
    pub fn sample(arm: Arm, cwd: &Path, startup_only: bool, startup_framed: bool) -> Report {
        let started = Instant::now();
        let mut report = Report::new(arm);
        report.startup_only = startup_only;
        report.startup_framed = startup_framed;
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
        let mut parser = if startup_framed {
            Parser::framed(&nonce)
        } else if startup_only {
            Parser::startup(&nonce)
        } else {
            Parser::new(&nonce)
        };
        let (ready_ack_tx, ready_ack_rx) = mpsc::sync_channel(1);
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
                    .try_send(WriteRequest {
                        bytes: if startup_framed {
                            framed_ready_script(&nonce)
                        } else {
                            ready_script(&nonce)
                        }
                        .into_bytes(),
                        ready_done: startup_only.then_some(ready_ack_tx),
                    })
                    .map_err(|_| "write-error")?;
                parser.arm_frame();
                receive(
                    &io,
                    &mut parser,
                    &mut report,
                    startup_deadline,
                    Until::Ready,
                )
            })();
            if startup_only {
                let mut outcome = ready;
                let ack = if outcome.is_ok() {
                    match ready_ack_rx
                        .recv_timeout(startup_deadline.saturating_duration_since(Instant::now()))
                    {
                        Ok(at) => Some(at),
                        Err(mpsc::RecvTimeoutError::Timeout) => {
                            outcome = Err("startup-timeout");
                            None
                        }
                        Err(mpsc::RecvTimeoutError::Disconnected) => {
                            outcome = Err("write-error");
                            None
                        }
                    }
                } else {
                    ready_ack_rx.try_recv().ok()
                };
                let frozen = Instant::now();
                // This ACK was received before `frozen`; compare its actual
                // completion with the original deadline, even on equal clock ticks.
                report.ready_write_ms = ready_write_ms(startup, startup_deadline, ack);
                if outcome.is_ok()
                    && (frozen >= startup_deadline || report.ready_write_ms.is_none())
                {
                    outcome = Err("startup-timeout");
                }
                report.startup = Some(frozen.duration_since(startup).as_secs_f64() * 1000.0);
                if startup_framed {
                    report.frame_count = parser.ready_counts().0;
                } else {
                    (report.strict_ready_count, report.embedded_ready_count) =
                        parser.ready_counts();
                }
                report.startup_complete = outcome.is_ok();
                outcome?;
                // Exit is sent and acknowledged in the existing cleanup budget,
                // after this frozen startup snapshot. No query is introduced.
                return Ok(());
            }
            report.startup = Some(startup.elapsed().as_secs_f64() * 1000.0);
            ready?;
            let command = Instant::now();
            let script = query_script(arm, &nonce, cwd.to_str().ok_or("setup-error")?);
            io.input
                .try_send(script.into_bytes().into())
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
        if let Some(reason) = report.failure {
            parser.record_failure(reason);
        }
        let ended = if startup_only {
            report.startup_complete
        } else {
            parser.ended
        };
        let cleaned = cleanup(
            child,
            master,
            io,
            report.failure.is_some(),
            startup_only,
            parser,
        );
        report.bytes = cleaned.bytes;
        report.diagnostic = cleaned.diagnostic;
        report.kill_requested = cleaned.kill_requested;
        report.exit_observed_before_kill = cleaned.exit_before_kill;
        if report.failure.is_none() {
            report.failure = cleaned.failure;
        }
        report.cleanup_ok = cleaned.confirmed;
        report.exit_code = cleaned.exit;
        if !cleaned.confirmed {
            report.failure = Some("cleanup-failed");
        } else if cleaned.exit != Some(0) {
            report.failure.get_or_insert("exit-error");
        }
        report.complete = ended && report.failure.is_none() && cleaned.confirmed;
        report.wall = started.elapsed().as_secs_f64() * 1000.0;
        report
    }
    #[cfg(test)]
    mod tests {
        use super::*;
        #[derive(Debug, Default)]
        struct LifecycleState {
            bytes: std::sync::Mutex<Vec<u8>>,
            flushed: AtomicBool,
            input_closed: AtomicBool,
            child_ready: AtomicBool,
            running_notice: std::sync::Mutex<Option<SyncSender<()>>>,
            child_observed: AtomicBool,
            closed_before_exit: AtomicBool,
            killed: AtomicBool,
        }
        struct LifecycleWriter {
            state: Arc<LifecycleState>,
            fail_flush: bool,
            flush_gate: Option<Receiver<()>>,
        }
        impl Write for LifecycleWriter {
            fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
                let size = bytes.len().min(2);
                self.state
                    .bytes
                    .lock()
                    .unwrap()
                    .extend_from_slice(&bytes[..size]);
                Ok(size)
            }
            fn flush(&mut self) -> std::io::Result<()> {
                if let Some(gate) = self.flush_gate.take() {
                    gate.recv_timeout(Duration::from_secs(1))
                        .map_err(|_| std::io::Error::other("fixture gate"))?;
                }
                if self.fail_flush {
                    return Err(std::io::Error::other("fixture flush"));
                }
                self.state.flushed.store(true, Ordering::SeqCst);
                Ok(())
            }
        }
        impl Drop for LifecycleWriter {
            fn drop(&mut self) {
                self.state.input_closed.store(true, Ordering::SeqCst);
            }
        }
        #[derive(Debug)]
        struct LifecycleChild(Arc<LifecycleState>);
        impl portable_pty::ChildKiller for LifecycleChild {
            fn kill(&mut self) -> std::io::Result<()> {
                self.0.killed.store(true, Ordering::SeqCst);
                Ok(())
            }
            fn clone_killer(&self) -> Box<dyn portable_pty::ChildKiller + Send + Sync> {
                Box::new(Self(self.0.clone()))
            }
        }
        impl Child for LifecycleChild {
            fn try_wait(&mut self) -> std::io::Result<Option<portable_pty::ExitStatus>> {
                let killed = self.0.killed.load(Ordering::SeqCst);
                // Child progress is independent of writer closure. Observe the
                // ordering, without simulating a Windows exit cause or code.
                if !killed && !self.0.child_ready.load(Ordering::SeqCst) {
                    if let Some(notice) = self.0.running_notice.lock().unwrap().take() {
                        let _ = notice.try_send(());
                    }
                    return Ok(None);
                }
                self.0.child_observed.store(true, Ordering::SeqCst);
                self.0
                    .closed_before_exit
                    .store(self.0.input_closed.load(Ordering::SeqCst), Ordering::SeqCst);
                Ok(Some(portable_pty::ExitStatus::with_exit_code(u32::from(
                    killed,
                ))))
            }
            fn wait(&mut self) -> std::io::Result<portable_pty::ExitStatus> {
                panic!("unbounded wait forbidden")
            }
            fn process_id(&self) -> Option<u32> {
                None
            }
            #[cfg(windows)]
            fn as_raw_handle(&self) -> Option<std::os::windows::io::RawHandle> {
                None
            }
        }
        fn lifecycle_io(
            state: &Arc<LifecycleState>,
            fail_flush: bool,
            flush_gate: Option<Receiver<()>>,
        ) -> Io {
            start_io(
                Box::new(std::io::Cursor::new(Vec::new())),
                Box::new(LifecycleWriter {
                    state: state.clone(),
                    fail_flush,
                    flush_gate,
                }),
            )
        }
        fn ready_parser() -> Parser {
            let nonce = "0123456789abcdef0123456789abcdef";
            let mut parser = Parser::startup(nonce);
            parser
                .push(format!("P1Q_{nonce}|READY|5.1.1.1\r\n").as_bytes())
                .unwrap();
            parser
        }
        #[test]
        fn old_input_drop_can_precede_independent_child_exit_observation() {
            let state = Arc::new(LifecycleState::default());
            let io = lifecycle_io(&state, false, None);
            io.input.try_send(b"exit 0\r\n".to_vec().into()).unwrap();
            // A permitted old scheduling: writer drains before child is polled.
            drop(io.input);
            io.writer_done.recv_timeout(Duration::from_secs(1)).unwrap();
            assert!(state.flushed.load(Ordering::SeqCst));
            assert!(!state.child_observed.load(Ordering::SeqCst));
            state.child_ready.store(true, Ordering::SeqCst);
            assert!(LifecycleChild(state.clone()).try_wait().unwrap().is_some());
            assert!(state.closed_before_exit.load(Ordering::SeqCst));
        }
        #[test]
        fn startup_cleanup_acknowledges_exit_and_retains_input_until_exit() {
            let state = Arc::new(LifecycleState::default());
            state.child_ready.store(true, Ordering::SeqCst);
            let io = lifecycle_io(&state, false, None);
            let cleaned = cleanup(
                Box::new(LifecycleChild(state.clone())),
                (),
                io,
                false,
                true,
                ready_parser(),
            );
            assert!(cleaned.confirmed);
            assert_eq!(cleaned.exit, Some(0));
            assert_eq!(cleaned.failure, None);
            assert_eq!(cleaned.kill_requested, Some(false));
            assert_eq!(cleaned.exit_before_kill, Some(true));
            assert!(state.flushed.load(Ordering::SeqCst));
            assert_eq!(*state.bytes.lock().unwrap(), b"exit 0\r\n");
            assert!(!state.closed_before_exit.load(Ordering::SeqCst));
            assert!(state.input_closed.load(Ordering::SeqCst));
            assert_eq!(cleaned.diagnostic.reason, None);
            assert_eq!(cleaned.bytes, 0);
        }
        #[test]
        fn framed_cleanup_rejects_duplicate_and_incomplete_tails_without_losing_startup() {
            let nonce = "0123456789abcdef0123456789abcdef";
            let frame = format!("~B{nonce}|R|5.1.1.1|E{nonce}~");
            for (tail, reason) in [
                (String::new(), None),
                (frame.clone(), Some("duplicate-frame")),
                (format!("~B{nonce}|"), Some("duplicate-frame")),
                ("\x1b]unfinished".into(), Some("incomplete-control")),
                ("~B0123".into(), Some("incomplete-frame")),
            ] {
                let state = Arc::new(LifecycleState::default());
                state.child_ready.store(true, Ordering::SeqCst);
                let io = start_io(
                    Box::new(std::io::Cursor::new(tail.into_bytes())),
                    Box::new(LifecycleWriter {
                        state: state.clone(),
                        fail_flush: false,
                        flush_gate: None,
                    }),
                );
                let mut parser = Parser::framed(nonce);
                parser.arm_frame();
                parser.push(frame.as_bytes()).unwrap();
                let frozen_count = parser.ready_counts().0;
                assert!(parser.version_ok);
                let cleaned = cleanup(
                    Box::new(LifecycleChild(state.clone())),
                    (),
                    io,
                    false,
                    true,
                    parser,
                );
                assert!(cleaned.confirmed);
                assert_eq!(cleaned.exit, Some(0));
                assert_eq!(cleaned.diagnostic.reason, reason);
                assert_eq!(cleaned.failure, reason.map(|_| "protocol-error"));
                assert_eq!(cleaned.diagnostic.stage, "after-frame");
                assert_eq!(frozen_count, 1);
                assert!(!state.closed_before_exit.load(Ordering::SeqCst));
            }
        }
        #[test]
        fn startup_cleanup_keeps_input_open_while_child_progress_is_pending() {
            let state = Arc::new(LifecycleState::default());
            let (notice, running) = mpsc::sync_channel(1);
            *state.running_notice.lock().unwrap() = Some(notice);
            let io = lifecycle_io(&state, false, None);
            let child_state = state.clone();
            let worker = thread::spawn(move || {
                cleanup(
                    Box::new(LifecycleChild(child_state)),
                    (),
                    io,
                    false,
                    true,
                    ready_parser(),
                )
            });
            running.recv_timeout(Duration::from_secs(1)).unwrap();
            let closed_while_running = state.input_closed.load(Ordering::SeqCst);
            assert!(state.flushed.load(Ordering::SeqCst));
            state.child_ready.store(true, Ordering::SeqCst);
            let cleaned = worker.join().unwrap();
            assert!(!closed_while_running);
            assert!(!state.closed_before_exit.load(Ordering::SeqCst));
            assert!(cleaned.confirmed);
            assert_eq!(cleaned.exit, Some(0));
            assert_eq!(cleaned.kill_requested, Some(false));
            assert!(state.input_closed.load(Ordering::SeqCst));
        }
        #[test]
        fn failed_exit_flush_keeps_first_reason_and_uses_bounded_kill() {
            let state = Arc::new(LifecycleState::default());
            let io = lifecycle_io(&state, true, None);
            let cleaned = cleanup(
                Box::new(LifecycleChild(state.clone())),
                (),
                io,
                false,
                true,
                ready_parser(),
            );
            assert!(cleaned.confirmed);
            assert_eq!(cleaned.failure, Some("write-error"));
            assert_eq!(cleaned.diagnostic.reason, Some("write-error"));
            assert_eq!(cleaned.kill_requested, Some(true));
            assert_eq!(cleaned.exit, Some(1));
        }
        #[test]
        fn startup_exit_without_child_exit_uses_original_bounded_fallback() {
            let state = Arc::new(LifecycleState::default());
            let io = lifecycle_io(&state, false, None);
            let before = Instant::now();
            let cleaned = cleanup(
                Box::new(LifecycleChild(state.clone())),
                (),
                io,
                false,
                true,
                ready_parser(),
            );
            assert!(before.elapsed() < Duration::from_secs(2));
            assert!(cleaned.confirmed);
            assert_eq!(cleaned.kill_requested, Some(true));
            assert_eq!(cleaned.exit, Some(1));
            assert!(!state.closed_before_exit.load(Ordering::SeqCst));
        }
        #[test]
        fn startup_exit_ack_timeout_cannot_wait_for_late_flush() {
            let state = Arc::new(LifecycleState::default());
            let (release, gate) = mpsc::sync_channel(1);
            let io = lifecycle_io(&state, false, Some(gate));
            let before = Instant::now();
            let result = startup_exit(
                &io.input,
                &mut LifecycleChild(state.clone()),
                before + Duration::from_millis(5),
            );
            assert_eq!(result, (None, Some("write-error")));
            assert!(before.elapsed() < Duration::from_millis(500));
            assert!(!state.child_observed.load(Ordering::SeqCst));
            release.send(()).unwrap();
            drop(io.input);
            io.writer_done.recv_timeout(Duration::from_secs(1)).unwrap();
            assert!(state.flushed.load(Ordering::SeqCst));
        }
        struct FixtureWriter {
            bytes: Arc<std::sync::Mutex<Vec<u8>>>,
            flushed: Arc<AtomicBool>,
            fail_write: bool,
            fail_flush: bool,
        }
        impl Write for FixtureWriter {
            fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
                if self.fail_write {
                    return Err(std::io::Error::other("fixture"));
                }
                // Partial writes verify that ACK follows all of write_all.
                let size = bytes.len().min(2);
                self.bytes.lock().unwrap().extend_from_slice(&bytes[..size]);
                Ok(size)
            }
            fn flush(&mut self) -> std::io::Result<()> {
                if self.fail_flush {
                    return Err(std::io::Error::other("fixture"));
                }
                self.flushed.store(true, Ordering::SeqCst);
                Ok(())
            }
        }
        #[test]
        fn actual_writer_ack_follows_fifo_all_bytes_and_successful_flush() {
            let bytes = Arc::new(std::sync::Mutex::new(Vec::new()));
            let flushed = Arc::new(AtomicBool::new(false));
            let io = start_io(
                Box::new(std::io::Cursor::new(Vec::new())),
                Box::new(FixtureWriter {
                    bytes: bytes.clone(),
                    flushed: flushed.clone(),
                    fail_write: false,
                    fail_flush: false,
                }),
            );
            let (done, ack) = mpsc::sync_channel(1);
            io.input.try_send(b"CPR".to_vec().into()).unwrap();
            let before = Instant::now();
            io.input
                .try_send(WriteRequest {
                    bytes: b"READY".to_vec(),
                    ready_done: Some(done),
                })
                .unwrap();
            let completed = ack.recv_timeout(Duration::from_secs(1)).unwrap();
            assert!(completed >= before && completed <= Instant::now());
            assert!(flushed.load(Ordering::SeqCst));
            assert_eq!(*bytes.lock().unwrap(), b"CPRREADY");
            drop(io.input);
            io.writer_done.recv_timeout(Duration::from_secs(1)).unwrap();
        }
        #[test]
        fn actual_writer_never_acknowledges_failed_write_or_flush() {
            for fail_write in [false, true] {
                let io = start_io(
                    Box::new(std::io::Cursor::new(Vec::new())),
                    Box::new(FixtureWriter {
                        bytes: Arc::new(std::sync::Mutex::new(Vec::new())),
                        flushed: Arc::new(AtomicBool::new(false)),
                        fail_write,
                        fail_flush: !fail_write,
                    }),
                );
                let (done, ack) = mpsc::sync_channel(1);
                io.input
                    .try_send(WriteRequest {
                        bytes: b"READY".to_vec(),
                        ready_done: Some(done),
                    })
                    .unwrap();
                assert!(ack.recv_timeout(Duration::from_secs(1)).is_err());
                assert!(io.write_failed.load(Ordering::Relaxed));
                drop(io.input);
                io.writer_done.recv_timeout(Duration::from_secs(1)).unwrap();
            }
        }
        fn mock_io() -> (Io, SyncSender<Event>, Receiver<WriteRequest>) {
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
        fn framed_cursor_fifo_and_arm_gate_preserve_startup_order() {
            let nonce = "0123456789abcdef0123456789abcdef";
            let frame = format!("~B{nonce}|R|5.1.1.1|E{nonce}~");
            let (io, output, commands) = mock_io();
            let mut parser = Parser::framed(nonce);
            let mut report = Report::new(Arm::Unqualified);
            let deadline = Instant::now() + Duration::from_secs(1);
            output.send(Event::Data(b"\x1b[6n".to_vec())).unwrap();
            receive(&io, &mut parser, &mut report, deadline, Until::Cursor).unwrap();
            let ready = framed_ready_script(nonce);
            io.input.try_send(ready.as_bytes().to_vec().into()).unwrap();
            parser.arm_frame();
            output.send(Event::Data(frame.as_bytes().to_vec())).unwrap();
            receive(&io, &mut parser, &mut report, deadline, Until::Ready).unwrap();
            assert_eq!(commands.recv().unwrap().bytes, b"\x1b[1;1R");
            assert_eq!(commands.recv().unwrap().bytes, ready.as_bytes());
            assert!(parser.version_ok);
            let mut early = Parser::framed(nonce);
            early.await_cursor = true;
            assert_eq!(early.push(frame.as_bytes()), Err("protocol-error"));
            assert_eq!(early.diagnostic().stage, "await-cursor");
            assert_eq!(early.diagnostic().reason, Some("unexpected-frame"));
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
            io.input
                .try_send(ready_script(nonce).into_bytes().into())
                .unwrap();
            assert_eq!(commands.recv().unwrap().bytes, b"\x1b[1;1R");
            assert_eq!(
                commands.recv().unwrap().bytes,
                ready_script(nonce).as_bytes()
            );
            assert_eq!(report.cpr, 1);
            assert_eq!(
                receive(&io, &mut parser, &mut report, Instant::now(), Until::Ready),
                Err("startup-timeout")
            );
            assert_eq!(parser.diagnostic().stage, "await-ready");
            assert_eq!(parser.diagnostic().reason, Some("startup-timeout"));
        }
        #[test]
        fn qualified_command_deadline_still_reports_command_timeout() {
            let (io, _, _) = mock_io();
            let mut parser = Parser::new("0123456789abcdef0123456789abcdef");
            let mut report = Report::new(Arm::Unqualified);
            assert_eq!(
                receive(&io, &mut parser, &mut report, Instant::now(), Until::End),
                Err("command-timeout")
            );
            assert_eq!(parser.diagnostic().reason, Some("command-timeout"));
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
            assert_eq!(parser.diagnostic().stage, "await-cursor");
            assert_eq!(parser.diagnostic().reason, Some("startup-timeout"));
            assert_eq!(report.cpr, 0);
        }
    }
}

#[cfg(windows)]
fn main() {
    use std::io::Write;
    let args: Vec<_> = std::env::args().skip(1).collect();
    let (arm, startup_only, startup_framed) = match args.as_slice() {
        [flag] if flag == "--startup-only" => (probe::Arm::Unqualified, true, false),
        [flag] if flag == "--startup-framed" => (probe::Arm::Unqualified, true, true),
        [flag, arm] if flag == "--sample" && arm == "unqualified" => {
            (probe::Arm::Unqualified, false, false)
        }
        [flag, arm] if flag == "--sample" && arm == "module-qualified" => {
            (probe::Arm::Qualified, false, false)
        }
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
            windows_worker::sample(arm, &cwd, startup_only, startup_framed)
        }
        Err(_) => {
            let mut r = probe::Report::new(arm);
            r.startup_only = startup_only;
            r.startup_framed = startup_framed;
            r.cleanup_ok = true;
            r
        }
    };
    if report.cleanup_ok && std::fs::remove_dir(&directory).is_err() {
        report.failure = Some("setup-error");
        report.diagnostic.record_failure("setup-error");
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
