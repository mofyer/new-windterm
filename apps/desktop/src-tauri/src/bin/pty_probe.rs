//! Real local PTY smoke/stress probe; never connects to a remote host.
use new_windterm_desktop::pty::{
    local_shells, EnvironmentVariable, LocalLaunchOptions, LocaleMode, LocaleOptions, PtyEvent,
    Session, Sessions, OUTPUT_BUDGET,
};
use std::{
    sync::{
        mpsc::{sync_channel, Receiver},
        Arc,
    },
    time::{Duration, Instant},
};

fn receive_until(
    receiver: &Receiver<PtyEvent>,
    session: &Session,
    marker: &[u8],
) -> Result<Vec<u8>, String> {
    receive_until_with_timeout(receiver, session, marker, Duration::from_secs(10))
}

fn receive_until_with_timeout(
    receiver: &Receiver<PtyEvent>,
    session: &Session,
    marker: &[u8],
    timeout: Duration,
) -> Result<Vec<u8>, String> {
    let started = Instant::now();
    let mut output = Vec::new();
    while started.elapsed() < timeout {
        match receiver
            .recv_timeout(Duration::from_secs(2).min(timeout.saturating_sub(started.elapsed())))
            .map_err(|error| {
                format!(
                    "Probe receive failed waiting for {:?} after {:.2}s; received {} bytes: {error}",
                    String::from_utf8_lossy(marker),
                    started.elapsed().as_secs_f64(),
                    output.len()
                )
            })?
        {
            PtyEvent::Data { sequence, data, .. } => {
                let search_start = output.len().saturating_sub(marker.len() - 1);
                output.extend(data);
                session.ack(sequence)?;
                if output[search_start..]
                    .windows(marker.len())
                    .any(|part| part == marker)
                {
                    return Ok(output);
                }
                if output.len() > 8 * 1024 * 1024 {
                    return Err("Probe output exceeded 8 MiB".into());
                }
            }
            PtyEvent::Error { message, .. } => return Err(message),
            PtyEvent::Exit { .. } => return Err("PTY exited before expected output".into()),
        }
    }
    Err(format!(
        "Probe output timed out waiting for {:?} after {:.2}s (limit {:.0}s); received {} bytes",
        String::from_utf8_lossy(marker),
        started.elapsed().as_secs_f64(),
        timeout.as_secs_f64(),
        output.len()
    ))
}

// Uses the same API as pty_open; the path is never part of a shell command.
// This binary is the Unix smoke lane. Native WebView scenarios cover cmd.exe.
fn probe_custom_cwd(shell: Option<&str>) -> Result<(), String> {
    let directory = std::env::temp_dir().join(format!("p1 cwd 中文-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&directory).map_err(|error| error.to_string())?;
    let sessions = Sessions::default();
    let result = (|| {
        // macOS /var and /tmp can be symlinks; pwd -P returns their physical paths.
        let expected = std::fs::canonicalize(&directory).map_err(|error| error.to_string())?;
        let cwd = directory.to_str().ok_or("Probe cwd is not UTF-8")?;
        let expected = expected.to_str().ok_or("Physical probe cwd is not UTF-8")?;
        let mut previous_id = None;
        for attempt in 1..=2 {
            let (sender, receiver) = sync_channel(128);
            let id = sessions.open_with_options(
                "cwd-probe",
                132,
                24,
                LocalLaunchOptions {
                    cwd: Some(cwd),
                    shell,
                    ..Default::default()
                },
                Arc::new(move |event| sender.try_send(event).map_err(|e| e.to_string())),
            )?;
            if previous_id.as_ref() == Some(&id) {
                return Err("Custom cwd reopen reused the old PTY session".into());
            }
            let session = sessions.get("cwd-probe", &id)?;
            receive_until(&receiver, &session, b"P0 ")?;
            session.write(b"stty -echo; printf '\\033[?2004l\\nCWD_%s\\n' READY\n".to_vec())?;
            receive_until(&receiver, &session, b"CWD_READY")?;
            if let Some(shell) = shell {
                // These are fixed shell-specific variable expansions, never path input.
                let query = match shell {
                    "bash" => b"printf '\\nSHELL_VERSION=%s\\n' \"$BASH_VERSION\"; printf 'SHELL_%s\\n' END\n".as_slice(),
                    "zsh" => b"printf '\\nSHELL_VERSION=%s\\n' \"$ZSH_VERSION\"; printf 'SHELL_%s\\n' END\n".as_slice(),
                    _ => return Err(format!("Unsupported Unix probe shell {shell}")),
                };
                session.write(query.to_vec())?;
                let output = receive_until(&receiver, &session, b"SHELL_END")?;
                let text = String::from_utf8_lossy(&output);
                let version = text
                    .lines()
                    .find_map(|line| line.trim_end_matches('\r').strip_prefix("SHELL_VERSION="))
                    .filter(|version| {
                        version.split('.').take(2).count() == 2
                            && version.split('.').take(2).all(|part| {
                                !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit())
                            })
                    })
                    .ok_or_else(|| {
                        format!("Expected actual {shell} version expansion; output={text:?}")
                    })?;
                println!(
                    "PASS explicit shell {shell} attempt {attempt}/2: actual version={version:?}"
                );
            }
            session
                .write(b"printf '\\nCWD_%s\\n' BEGIN; pwd -P; printf 'CWD_%s\\n' END\n".to_vec())?;
            let output = receive_until(&receiver, &session, b"CWD_END")?;
            if !String::from_utf8_lossy(&output)
                .lines()
                .any(|line| line.trim_end_matches('\r') == expected)
            {
                return Err(format!(
                    "Custom cwd attempt {attempt}: shell pwd -P did not equal {expected:?}; output={:?}",
                    String::from_utf8_lossy(&output)
                ));
            }
            session.write(b"exit 7\n".to_vec())?;
            loop {
                match receiver
                    .recv_timeout(Duration::from_secs(5))
                    .map_err(|error| error.to_string())?
                {
                    PtyEvent::Data { sequence, .. } => session.ack(sequence)?,
                    PtyEvent::Exit { code: Some(7), .. } => break,
                    PtyEvent::Exit { code, .. } => {
                        return Err(format!("Custom cwd unexpected exit {code:?}"));
                    }
                    PtyEvent::Error { message, .. } => return Err(message),
                }
            }
            if !session.wait_closed(Duration::from_secs(2)) {
                return Err("Custom cwd PTY worker did not reap".into());
            }
            sessions.close("cwd-probe", &id)?;
            previous_id = Some(id);
            println!("PASS custom cwd shell={} attempt {attempt}/2: actual pwd -P={expected:?}; exit 7, worker reaped", shell.unwrap_or("default"));
        }
        Ok(())
    })();
    sessions.shutdown();
    let cleanup = std::fs::remove_dir(&directory).map_err(|error| error.to_string());
    result.and(cleanup)
}

// These fixtures contain only synthetic values. Never print the parent env or
// interpolate a configured value into shell source.
fn open_environment_probe(
    sessions: &Sessions,
    options: LocalLaunchOptions<'_>,
) -> Result<(String, Arc<Session>, Receiver<PtyEvent>), String> {
    let (sender, receiver) = sync_channel(128);
    let id = sessions.open_with_options(
        "env-probe",
        132,
        24,
        options,
        Arc::new(move |event| sender.try_send(event).map_err(|e| e.to_string())),
    )?;
    let session = sessions.get("env-probe", &id)?;
    receive_until(&receiver, &session, b"P0 ")?;
    session.write(b"stty -echo; printf '\\033[?2004l\\nENV_%s\\n' READY\n".to_vec())?;
    receive_until(&receiver, &session, b"ENV_READY")?;
    Ok((id, session, receiver))
}

fn check_environment(
    receiver: &Receiver<PtyEvent>,
    session: &Session,
    sample: Option<&str>,
    lang: Option<&str>,
    defaults: bool,
) -> Result<(), String> {
    session.write(br#"printf '\nENV_SAMPLE_PRESENT=[%s]\n' "${P1_ENV_SAMPLE+x}"; printf 'ENV_SAMPLE=[%s]\n' "$P1_ENV_SAMPLE"; printf 'ENV_EMPTY_PRESENT=[%s]\n' "${P1_ENV_EMPTY+x}"; printf 'ENV_EMPTY=[%s]\n' "$P1_ENV_EMPTY"; printf 'ENV_LANG_PRESENT=[%s]\n' "${LANG+x}"; printf 'ENV_LANG=[%s]\n' "$LANG"; printf 'ENV_LC_ALL_PRESENT=[%s]\n' "${LC_ALL+x}"; printf 'ENV_LC_ALL=[%s]\n' "$LC_ALL"; printf 'ENV_LC_CTYPE_PRESENT=[%s]\n' "${LC_CTYPE+x}"; printf 'ENV_LC_CTYPE=[%s]\n' "$LC_CTYPE"; printf 'ENV_%s\n' END
"#.to_vec())?;
    let output = receive_until(receiver, session, b"ENV_END")?;
    let text = String::from_utf8_lossy(&output);
    let lc_all = if defaults && cfg!(target_os = "linux") {
        Some("C.UTF-8")
    } else {
        None
    };
    let lc_ctype = if defaults && cfg!(target_os = "macos") {
        Some("UTF-8")
    } else {
        None
    };
    for (name, value) in [
        ("SAMPLE", sample),
        ("EMPTY", sample.map(|_| "")),
        ("LANG", lang),
        ("LC_ALL", lc_all),
        ("LC_CTYPE", lc_ctype),
    ] {
        for row in [
            format!(
                "ENV_{name}_PRESENT=[{}]",
                if value.is_some() { "x" } else { "" }
            ),
            format!("ENV_{name}=[{}]", value.unwrap_or("")),
        ] {
            if !text.lines().any(|line| line.trim_end_matches('\r') == row) {
                return Err(format!(
                    "Environment probe missing exact synthetic row {row:?}; output={text:?}"
                ));
            }
        }
    }
    Ok(())
}

fn exit_environment_probe(
    sessions: &Sessions,
    id: &str,
    session: &Session,
    receiver: &Receiver<PtyEvent>,
) -> Result<(), String> {
    session.write(b"exit 7\n".to_vec())?;
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .ok_or("Environment probe exit deadline exceeded")?;
        match receiver
            .recv_timeout(remaining)
            .map_err(|e| e.to_string())?
        {
            PtyEvent::Data { sequence, .. } => session.ack(sequence)?,
            PtyEvent::Exit { code: Some(7), .. } => break,
            PtyEvent::Exit { code, .. } => {
                return Err(format!("Environment probe unexpected exit {code:?}"))
            }
            PtyEvent::Error { message, .. } => return Err(message),
        }
    }
    if !session.wait_closed(Duration::from_secs(2)) {
        return Err("Environment probe worker did not reap".into());
    }
    sessions.close("env-probe", id)
}

fn probe_environment() -> Result<(), String> {
    let keys = [
        "P1_ENV_SAMPLE",
        "P1_ENV_EMPTY",
        "LANG",
        "LC_ALL",
        "LC_CTYPE",
    ];
    let parent_before = keys.map(std::env::var_os);
    let lang = if cfg!(target_os = "macos") {
        "en_US.UTF-8"
    } else {
        "C.UTF-8"
    };
    let first_env = [
        EnvironmentVariable {
            name: "P1_ENV_SAMPLE".into(),
            value: "中文 space=one".into(),
        },
        EnvironmentVariable {
            name: "P1_ENV_EMPTY".into(),
            value: String::new(),
        },
    ];
    let second_env = [
        EnvironmentVariable {
            name: "P1_ENV_SAMPLE".into(),
            value: "独立 space=two".into(),
        },
        EnvironmentVariable {
            name: "P1_ENV_EMPTY".into(),
            value: String::new(),
        },
    ];
    let locale = LocaleOptions {
        mode: LocaleMode::Custom,
        variables: vec![EnvironmentVariable {
            name: "LANG".into(),
            value: lang.into(),
        }],
    };
    let first_options = LocalLaunchOptions {
        shell: Some("bash"),
        env: &first_env,
        locale: Some(&locale),
        ..Default::default()
    };
    let sessions = Sessions::default();
    let result: Result<(), String> = (|| {
        let (first_id, first, first_rx) = open_environment_probe(&sessions, first_options)?;
        check_environment(&first_rx, &first, Some("中文 space=one"), Some(lang), false)?;
        let (second_id, second, second_rx) = open_environment_probe(
            &sessions,
            LocalLaunchOptions {
                env: &second_env,
                ..first_options
            },
        )?;
        check_environment(
            &second_rx,
            &second,
            Some("独立 space=two"),
            Some(lang),
            false,
        )?;
        check_environment(&first_rx, &first, Some("中文 space=one"), Some(lang), false)?;
        first.write(b"export P1_ENV_SAMPLE='runtime-change'\n".to_vec())?;
        check_environment(&first_rx, &first, Some("runtime-change"), Some(lang), false)?;
        exit_environment_probe(&sessions, &first_id, &first, &first_rx)?;
        let (reopened_id, reopened, reopened_rx) =
            open_environment_probe(&sessions, first_options)?;
        if reopened_id == first_id {
            return Err("Environment reopen reused the exited session ID".into());
        }
        check_environment(
            &reopened_rx,
            &reopened,
            Some("中文 space=one"),
            Some(lang),
            false,
        )?;
        exit_environment_probe(&sessions, &reopened_id, &reopened, &reopened_rx)?;
        check_environment(
            &second_rx,
            &second,
            Some("独立 space=two"),
            Some(lang),
            false,
        )?;
        let (default_id, default_session, default_rx) =
            open_environment_probe(&sessions, LocalLaunchOptions::default())?;
        check_environment(&default_rx, &default_session, None, Some(lang), true)?;
        exit_environment_probe(&sessions, &default_id, &default_session, &default_rx)?;
        let cleared_locale = LocaleOptions {
            mode: LocaleMode::Custom,
            variables: vec![],
        };
        let (cleared_id, cleared, cleared_rx) = open_environment_probe(
            &sessions,
            LocalLaunchOptions {
                shell: Some("bash"),
                locale: Some(&cleared_locale),
                ..Default::default()
            },
        )?;
        check_environment(&cleared_rx, &cleared, None, None, false)?;
        exit_environment_probe(&sessions, &cleared_id, &cleared, &cleared_rx)?;
        exit_environment_probe(&sessions, &second_id, &second, &second_rx)?;
        Ok(())
    })();
    sessions.shutdown();
    if keys.map(std::env::var_os) != parent_before {
        return Err("Environment probe changed parent process variables".into());
    }
    result?;
    println!("PASS session environment: literal Unicode/spaces/equals, empty versus absent, two live sessions isolated, exit 7/reopen original config, default locale preserved, custom empty locale cleared, parent unchanged, workers reaped");
    Ok(())
}

fn run() -> Result<(), String> {
    let sessions = Sessions::default();
    let (sender, receiver) = sync_channel(128);
    let id = sessions.open(
        "probe",
        80,
        24,
        Arc::new(move |event| sender.try_send(event).map_err(|e| e.to_string())),
    )?;
    let session = sessions.get("probe", &id)?;
    let result = (|| {
        assert!(sessions.get("other-window", &id).is_err());
        assert!(sessions.close("other-window", &id).is_err());
        receive_until(&receiver, &session, b"P0 ")?;
        session.write(b"stty -echo; printf '\\033[?2004l\\nREADY_%s\\n' OK\n".to_vec())?;
        receive_until(&receiver, &session, b"READY_OK")?;
        session.resize(132, 43)?;
        session.write(b"stty size; printf 'SIZE_%s\\n' DONE\n".to_vec())?;
        let size = receive_until(&receiver, &session, b"SIZE_DONE")?;
        if !String::from_utf8_lossy(&size).contains("43 132") {
            return Err("PTY resize mismatch".into());
        }
        session.write(
            "printf '中文🙂é\\n'; printf 'UTF8_%s\\n' DONE\n"
                .as_bytes()
                .to_vec(),
        )?;
        let utf8 = receive_until(&receiver, &session, b"UTF8_DONE")?;
        if !String::from_utf8_lossy(&utf8).contains("中文🙂é") {
            return Err("PTY UTF-8 byte mismatch".into());
        }

        // Stop acknowledging briefly. The same production flow control must stop
        // output at 64 KiB while the producer still has 2 MiB to write.
        // This checks byte integrity and backpressure, not a throughput target.
        // Hosted macOS continued receiving data but exceeded the short marker deadline.
        let load_started = Instant::now();
        println!("START 2 MiB exact-output stage: 300 ms ACK pause, 60 s drain deadline");
        session.write(b"printf '\\nBEGIN_%s\\n' LOAD; head -c 2097152 /dev/zero | tr '\\000' x; printf '\\nEND_%s\\n' LOAD\n".to_vec())?;
        std::thread::sleep(Duration::from_millis(300));
        if session.peak_pending_bytes() > OUTPUT_BUDGET {
            return Err("Output exceeded budget".into());
        }
        let load =
            receive_until_with_timeout(&receiver, &session, b"END_LOAD", Duration::from_secs(60))?;
        let begin = load
            .windows(10)
            .position(|part| part == b"BEGIN_LOAD")
            .ok_or("Missing load start")?
            + 10;
        let end = load
            .windows(8)
            .position(|part| part == b"END_LOAD")
            .ok_or("Missing load end")?;
        let count = load[begin..end]
            .iter()
            .filter(|&&byte| byte == b'x')
            .count();
        if count != 2_097_152 {
            return Err(format!("PTY output lost bytes: {count}"));
        }
        let load_seconds = load_started.elapsed().as_secs_f64();
        println!(
            "PASS 2 MiB byte integrity: {count} payload bytes in {load_seconds:.2}s including ACK pause; {:.1} KiB/s observed (diagnostic only)",
            count as f64 / 1024.0 / load_seconds
        );
        session.write(b"sleep 30\n".to_vec())?;
        std::thread::sleep(Duration::from_millis(100));
        session.write(vec![3])?;
        session.write(b"printf 'CTRL_%s\\n' OK\n".to_vec())?;
        receive_until(&receiver, &session, b"CTRL_OK")?;
        session.write(b"exit 7\n".to_vec())?;
        loop {
            match receiver
                .recv_timeout(Duration::from_secs(5))
                .map_err(|e| e.to_string())?
            {
                PtyEvent::Data { sequence, .. } => session.ack(sequence)?,
                PtyEvent::Exit { code, .. } => {
                    if code != Some(7) {
                        return Err(format!("Unexpected exit {code:?}"));
                    }
                    break;
                }
                PtyEvent::Error { message, .. } => return Err(message),
            }
        }
        if !session.wait_closed(Duration::from_secs(2)) {
            return Err("PTY worker did not reap".into());
        }
        sessions.close("probe", &id)?;
        sessions.close("probe", &id)?;
        if session.write(vec![3]).is_ok() {
            return Err("Closed PTY accepted input".into());
        }
        println!("PASS real PTY: ownership, resize 132x43, UTF-8 bytes, 2 MiB exact output, Ctrl-C, exit 7, idempotent close; peak unacknowledged={} bytes", session.peak_pending_bytes());

        for cycle in 1..=12 {
            println!("START PTY close cycle {cycle}/12 with withheld ACKs");
            let cycle_started = Instant::now();
            // Preserve only lifecycle evidence: never buffer terminal Data or ACK it.
            // The fixed fixture can emit only a few Error/Exit events per session.
            let (lifecycle_sender, lifecycle_receiver) = sync_channel(8);
            let next = sessions.open(
                "cycle",
                80,
                24,
                Arc::new(move |event| {
                    if !matches!(event, PtyEvent::Data { .. })
                        && lifecycle_sender.try_send(event).is_err()
                    {
                        eprintln!(
                            "PTY close cycle {cycle}/12 lifecycle evidence channel unavailable"
                        );
                    }
                    Ok(())
                }),
            )?;
            println!("PTY close cycle {cycle}/12 session={next}");
            let active = sessions.get("cycle", &next)?;
            active.write(b"yes bounded-output\n".to_vec())?;
            std::thread::sleep(Duration::from_millis(30));
            let close_started = Instant::now();
            println!("PTY close cycle {cycle}/12 close begin");
            sessions.close("cycle", &next)?;
            let close_ms = close_started.elapsed().as_millis();
            println!("PTY close cycle {cycle}/12 close returned after {close_ms} ms");
            let wait_started = Instant::now();
            let reaped = active.wait_closed(Duration::from_secs(2));
            let wait_ms = wait_started.elapsed().as_millis();
            let lifecycle: Vec<_> = lifecycle_receiver.try_iter().collect();
            println!(
                "PTY close cycle {cycle}/12: reaped={reaped} close_ms={close_ms} wait_ms={wait_ms} total_ms={} lifecycle={lifecycle:?}",
                cycle_started.elapsed().as_millis()
            );
            if !reaped {
                return Err(format!("Repeated close failed to reap worker in cycle {cycle}/12; close_ms={close_ms} wait_ms={wait_ms} lifecycle={lifecycle:?}"));
            }
        }
        println!("PASS 12 real PTY open/write/close cycles with withheld ACKs and worker reaping");
        Ok(())
    })();
    sessions.shutdown();
    result
}

fn main() {
    println!(
        "P0 real PTY probe: OS={} ARCH={}",
        std::env::consts::OS,
        std::env::consts::ARCH
    );
    let result = run()
        .and_then(|()| probe_custom_cwd(None))
        .and_then(|()| probe_custom_cwd(Some("bash")))
        .and_then(|()| {
            if local_shells()
                .iter()
                .any(|shell| shell.id == "zsh" && shell.available)
            {
                probe_custom_cwd(Some("zsh"))
            } else {
                println!("SKIP explicit zsh probe: zsh is unavailable on this host");
                Ok(())
            }
        })
        .and_then(|()| probe_environment());
    if let Err(error) = result {
        eprintln!("FAIL PTY probe: {error}");
        std::process::exit(1);
    }
}
