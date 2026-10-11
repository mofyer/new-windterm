//! Real local PTY smoke/stress probe; never connects to a remote host.
use new_windterm_desktop::pty::{PtyEvent, Session, Sessions, OUTPUT_BUDGET};
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

        for _ in 0..12 {
            let next = sessions.open("cycle", 80, 24, Arc::new(|_| Ok(())))?;
            let active = sessions.get("cycle", &next)?;
            active.write(b"yes bounded-output\n".to_vec())?;
            std::thread::sleep(Duration::from_millis(30));
            sessions.close("cycle", &next)?;
            if !active.wait_closed(Duration::from_secs(2)) {
                return Err("Repeated close failed to reap worker".into());
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
    if let Err(error) = run() {
        eprintln!("FAIL PTY probe: {error}");
        std::process::exit(1);
    }
}
