//! Opt-in, bounded PTY measurement. Never prints captured terminal contents.
use new_windterm_desktop::pty::{PtyEvent, Session, Sessions, OUTPUT_BUDGET};
use std::{
    io::Write,
    process::{Command, Stdio},
    sync::{
        mpsc::{sync_channel, Receiver},
        Arc,
    },
    time::{Duration, Instant},
};

const BYTES: usize = 2 * 1024 * 1024;
const OWNER: &str = "diagnostic";

fn receive(
    receiver: &Receiver<PtyEvent>,
    session: &Session,
    marker: &[u8],
    timeout: Duration,
) -> Result<Vec<u8>, String> {
    let started = Instant::now();
    let mut output = Vec::new();
    loop {
        let remaining = timeout
            .checked_sub(started.elapsed())
            .ok_or("Diagnostic deadline exceeded")?;
        match receiver
            .recv_timeout(remaining.min(Duration::from_secs(2)))
            .map_err(|_| "Diagnostic receive stalled")?
        {
            PtyEvent::Data { sequence, data, .. } => {
                if output.len() + data.len() > 4 * BYTES {
                    return Err("Diagnostic output exceeded bound".into());
                }
                let from = output.len().saturating_sub(marker.len() - 1);
                output.extend(data);
                session.ack(sequence)?;
                if output[from..]
                    .windows(marker.len())
                    .any(|part| part == marker)
                {
                    return Ok(output);
                }
            }
            PtyEvent::Error { .. } => return Err("PTY reported an error".into()),
            PtyEvent::Exit { .. } => return Err("PTY exited before marker".into()),
        }
    }
}

fn sample(label: &str, producer: &str, repeat: usize) -> Result<(), String> {
    let sessions = Sessions::default();
    let (sender, receiver) = sync_channel(128);
    let id = sessions.open(
        OWNER,
        80,
        24,
        Arc::new(move |event| {
            sender
                .try_send(event)
                .map_err(|_| "Diagnostic queue full or closed".into())
        }),
    )?;
    let session = sessions.get(OWNER, &id)?;
    let whole = Instant::now();
    let result = (|| {
        receive(&receiver, &session, b"P0 ", Duration::from_secs(10))?;
        session.write(b"stty -echo; printf '\\nREADY_%s\\n' OK\n".to_vec())?;
        receive(&receiver, &session, b"READY_OK", Duration::from_secs(10))?;
        let before = session.diagnostics();
        let started = Instant::now();
        session.write(
            format!("printf '\\nBEGIN_%s\\n' LOAD; {producer}; printf '\\nEND_%s\\n' LOAD\n")
                .into_bytes(),
        )?;
        std::thread::sleep(Duration::from_millis(300));
        let load = receive(&receiver, &session, b"END_LOAD", Duration::from_secs(60))?;
        let load_ms = started.elapsed().as_secs_f64() * 1000.0;
        // Live snapshots are approximate: an in-progress read/sleep may straddle
        // a boundary. Whole-session counters below are collected after reaping.
        let load_counters: std::collections::BTreeMap<_, _> = session
            .diagnostics()
            .into_iter()
            .map(|(name, value)| (name, value.saturating_sub(before[name])))
            .collect();
        let begin = load
            .windows(10)
            .position(|p| p == b"BEGIN_LOAD")
            .ok_or("Missing begin")?
            + 10;
        let end = load
            .windows(8)
            .position(|p| p == b"END_LOAD")
            .ok_or("Missing end")?;
        // The exact payload is bounded by CR/LF from the marker printf commands.
        let payload = load[begin..end]
            .strip_prefix(b"\r\n")
            .or_else(|| load[begin..end].strip_prefix(b"\n"))
            .ok_or("Missing payload prefix")?;
        let payload = payload
            .strip_suffix(b"\r\n")
            .or_else(|| payload.strip_suffix(b"\n"))
            .ok_or("Missing payload suffix")?;
        if payload.len() != BYTES || !payload.iter().all(|&b| b == b'x') {
            return Err("Payload exact integrity mismatch".into());
        }
        if session.peak_pending_bytes() > OUTPUT_BUDGET {
            return Err("Output budget exceeded".into());
        }
        session.write(b"sleep 30\n".to_vec())?;
        std::thread::sleep(Duration::from_millis(100));
        let cancel = Instant::now();
        session.write(vec![3])?;
        session.write(b"printf 'CTRL_%s\\n' OK\n".to_vec())?;
        receive(&receiver, &session, b"CTRL_OK", Duration::from_secs(10))?;
        let cancel_ms = cancel.elapsed().as_secs_f64() * 1000.0;
        session.write(b"exit 7\n".to_vec())?;
        loop {
            match receiver
                .recv_timeout(Duration::from_secs(2))
                .map_err(|_| "Exit stalled")?
            {
                PtyEvent::Data { sequence, .. } => session.ack(sequence)?,
                PtyEvent::Exit { code: Some(7), .. } => break,
                _ => return Err("Unexpected PTY termination".into()),
            }
        }
        if !session.wait_closed(Duration::from_secs(2)) {
            return Err("Worker reaping failed".into());
        }
        println!("PASS source={label} repeat={repeat} bytes={BYTES} load_ms={load_ms:.3} cancel_ms={cancel_ms:.3} whole_ms={:.3} peak_bytes={} load_counters={load_counters:?} counters={:?}", whole.elapsed().as_secs_f64() * 1000.0, session.peak_pending_bytes(), session.diagnostics());
        Ok(())
    })();
    sessions.shutdown();
    if !session.wait_closed(Duration::from_secs(2)) {
        return Err("Cleanup did not reap worker".into());
    }
    result
}

fn run() -> Result<(), String> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    if args.first().is_some_and(|arg| arg == "--generate") {
        let block = match args.get(1).map(String::as_str) {
            Some("1024") => 1024,
            Some("4096") => 4096,
            _ => return Err("Generator block must be 1024 or 4096".into()),
        };
        if args.len() != 2 {
            return Err("Unexpected generator argument".into());
        }
        let mut output = std::io::stdout().lock();
        let bytes = [b'x'; 4096];
        for _ in 0..BYTES / block {
            output
                .write_all(&bytes[..block])
                .map_err(|e| e.to_string())?;
        }
        return output.flush().map_err(|e| e.to_string());
    }
    if !args.is_empty() {
        return Err("Use no arguments, or --generate 1024|4096".into());
    }
    if !cfg!(any(target_os = "macos", target_os = "linux")) {
        return Err("PTY diagnostics require the supported macOS/Linux adapter".into());
    }
    let executable = std::env::current_exe().map_err(|e| e.to_string())?;
    let path = executable.to_str().ok_or("Executable path is not UTF-8")?;
    let quoted = format!("'{}'", path.replace('\'', "'\\''"));
    let sources = [
        (
            "head-tr",
            "head -c 2097152 /dev/zero | tr '\\000' x".to_string(),
        ),
        ("rust-1024", format!("{quoted} --generate 1024")),
        ("rust-4096", format!("{quoted} --generate 4096")),
    ];
    println!("PTY diagnostic OS={} ARCH={} debug={} repeats=3 pause_ms=300; load_counters approximate the load window; counters cover complete sessions; no terminal text", std::env::consts::OS, std::env::consts::ARCH, cfg!(debug_assertions));
    // Bounded producer-only pipe control, with no PTY or shell startup configuration.
    for (label, command) in &sources {
        let started = Instant::now();
        let mut pipe = Command::new("/bin/sh");
        pipe.args(["-c", command])
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .stdin(Stdio::null());
        if cfg!(target_os = "macos") {
            pipe.env("LANG", "en_US.UTF-8").env("LC_CTYPE", "UTF-8");
        } else {
            pipe.env("LANG", "C.UTF-8").env("LC_ALL", "C.UTF-8");
        }
        let output = pipe.output().map_err(|e| e.to_string())?;
        if !output.status.success()
            || output.stdout.len() != BYTES
            || !output.stdout.iter().all(|&b| b == b'x')
        {
            return Err("Pipe control integrity failed".into());
        }
        println!(
            "PASS pipe source={label} bytes={BYTES} elapsed_ms={:.3}",
            started.elapsed().as_secs_f64() * 1000.0
        );
    }
    // Rotate source order to reduce a fixed first/last position bias.
    for repeat in 0..3 {
        for offset in 0..sources.len() {
            let (label, producer) = &sources[(repeat + offset) % sources.len()];
            sample(label, producer, repeat + 1)?;
        }
    }
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("FAIL PTY diagnostic: {error}");
        std::process::exit(1);
    }
}
