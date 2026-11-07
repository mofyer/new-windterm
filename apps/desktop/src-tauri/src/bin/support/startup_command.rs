//! P1 "execute command after start" (T34 sub-item) on a real Unix PTY.
//!
//! The frontend types `command + CR` into a new local shell through `pty_write` in the same step
//! that stores the ID returned by `pty_open`; it never waits for a prompt or output. This stage
//! writes the same bytes through the same `Session::write` immediately after `open_with_options`
//! returns and counts the command's actual side effect: one line appended to a fresh file. Shell
//! exit (the exit event plus the worker reaped) is the barrier before the file is read, so a late
//! second execution would still be counted. Polling the file only bounds the test's wait.
//!
//! This checks the transport and each shell's handling of type-ahead. It does not exercise the
//! frontend's one-shot state (browser contract specs do) or Windows ConPTY.
use new_windterm_desktop::pty::{local_shells, LocalLaunchOptions, PtyEvent, Session, Sessions};
use std::{
    path::Path,
    sync::{
        mpsc::{sync_channel, Receiver},
        Arc,
    },
    time::{Duration, Instant},
};

const OWNER: &str = "startup-command-probe";
/// The frontend's limit, excluding the CR that submits the line.
const MAX_COMMAND_BYTES: usize = 1000;
const SIDE_EFFECT_DEADLINE: Duration = Duration::from_secs(20);
const EXIT_DEADLINE: Duration = Duration::from_secs(10);
/// After the prompt, how long an unsubmitted line is left in the live shell before it is checked.
const UNSUBMITTED_SETTLE: Duration = Duration::from_millis(1500);
/// Opt-in observation (not a gate): trials per shell of closing a session whose line editor holds
/// the unsubmitted command. See `observe_close_with_unsubmitted_line`.
const CLOSE_TRIALS_ENV: &str = "P1_STARTUP_CLOSE_TRIALS";
const DIAGNOSTIC_TAIL: usize = 2048;

struct Probe {
    id: String,
    session: Arc<Session>,
    receiver: Receiver<PtyEvent>,
    output: Vec<u8>,
}

impl Probe {
    fn open(sessions: &Sessions, shell: Option<&str>) -> Result<Self, String> {
        let (sender, receiver) = sync_channel(256);
        let id = sessions.open_with_options(
            OWNER,
            132,
            24,
            LocalLaunchOptions {
                shell,
                ..Default::default()
            },
            Arc::new(move |event| sender.try_send(event).map_err(|e| e.to_string())),
        )?;
        let session = sessions.get(OWNER, &id)?;
        Ok(Self {
            id,
            session,
            receiver,
            output: Vec::new(),
        })
    }

    /// Takes one event for up to `timeout`; ACKs data so output never stalls on the budget.
    fn pump(&mut self, timeout: Duration) -> Result<Option<Option<u32>>, String> {
        match self.receiver.recv_timeout(timeout) {
            Ok(PtyEvent::Data { sequence, data, .. }) => {
                self.output.extend(data);
                let excess = self.output.len().saturating_sub(DIAGNOSTIC_TAIL * 4);
                if excess > 0 {
                    self.output.drain(..excess);
                }
                self.session.ack(sequence)?;
                Ok(None)
            }
            Ok(PtyEvent::Exit { code, .. }) => Ok(Some(code)),
            Ok(PtyEvent::Error { message, .. }) => Err(message),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => Ok(None),
            Err(error) => Err(error.to_string()),
        }
    }

    fn tail(&self) -> String {
        let start = self.output.len().saturating_sub(DIAGNOSTIC_TAIL);
        String::from_utf8_lossy(&self.output[start..]).into_owned()
    }

    /// Bounded wait until `file` holds at least `lines` lines; the shell must still be running.
    fn wait_for_lines(&mut self, file: &Path, lines: usize) -> Result<Duration, String> {
        let started = Instant::now();
        while started.elapsed() < SIDE_EFFECT_DEADLINE {
            if count_lines(file)? >= lines {
                return Ok(started.elapsed());
            }
            if let Some(code) = self.pump(Duration::from_millis(25))? {
                return Err(format!(
                    "shell exited ({code:?}) before the side effect; output tail={:?}",
                    self.tail()
                ));
            }
        }
        Err(format!(
            "no side effect after {:.1}s (expected {lines} line(s)); output tail={:?}",
            SIDE_EFFECT_DEADLINE.as_secs_f64(),
            self.tail()
        ))
    }

    /// Barrier: `exit 7` + CR, the exit event, the worker reaped, then close.
    fn exit_barrier(mut self, sessions: &Sessions) -> Result<(), String> {
        self.session.write(b"exit 7\r".to_vec())?;
        let started = Instant::now();
        loop {
            if started.elapsed() > EXIT_DEADLINE {
                return Err(format!("shell did not exit; output tail={:?}", self.tail()));
            }
            match self.pump(Duration::from_millis(100))? {
                Some(Some(7)) => break,
                Some(code) => return Err(format!("unexpected exit {code:?}")),
                None => {}
            }
        }
        if !self.session.wait_closed(Duration::from_secs(2)) {
            return Err("PTY worker did not reap after exit".into());
        }
        sessions.close(OWNER, &self.id)
    }

    /// Waits for the prompt, then keeps the shell running for `UNSUBMITTED_SETTLE`.
    fn settle_after_prompt(&mut self) -> Result<(), String> {
        let started = Instant::now();
        while !self.output.windows(3).any(|part| part == b"P0 ") {
            if started.elapsed() > SIDE_EFFECT_DEADLINE {
                return Err(format!("no prompt; output tail={:?}", self.tail()));
            }
            if let Some(code) = self.pump(Duration::from_millis(25))? {
                return Err(format!("shell exited ({code:?}) in the control arm"));
            }
        }
        let settle = Instant::now();
        while settle.elapsed() < UNSUBMITTED_SETTLE {
            if let Some(code) = self.pump(Duration::from_millis(25))? {
                return Err(format!("shell exited ({code:?}) in the control arm"));
            }
        }
        Ok(())
    }

    /// Product close (`Sessions::close`) and reap, as when a tab is closed.
    fn close_and_reap(self, sessions: &Sessions) -> Result<(), String> {
        sessions.close(OWNER, &self.id)?;
        if !self.session.wait_closed(Duration::from_secs(2)) {
            return Err("PTY worker did not reap after close".into());
        }
        Ok(())
    }
}

fn count_lines(file: &Path) -> Result<usize, String> {
    match std::fs::read(file) {
        Ok(bytes) => Ok(bytes.iter().filter(|&&byte| byte == b'\n').count()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(0),
        Err(error) => Err(error.to_string()),
    }
}

fn read_lines(file: &Path) -> Result<Vec<String>, String> {
    let bytes = std::fs::read(file).map_err(|error| error.to_string())?;
    let text = String::from_utf8(bytes).map_err(|_| "count file is not UTF-8".to_string())?;
    Ok(text.lines().map(str::to_owned).collect())
}

/// The file path is single-quoted in shell source; the probe refuses a path it cannot quote that way.
fn quoted(path: &Path) -> Result<String, String> {
    let text = path.to_str().ok_or("probe path is not UTF-8")?;
    if text.contains('\'') {
        return Err("probe path contains a single quote".into());
    }
    Ok(format!("'{text}'"))
}

/// `printf '%s %s\n' '<payload>' "$$" >> '<file>'`, which appends "<payload> <shell pid>".
fn append_command(payload: &str, file: &Path) -> Result<String, String> {
    Ok(format!(
        "printf '%s %s\\n' '{payload}' \"$$\" >> {}",
        quoted(file)?
    ))
}

/// A payload of ASCII nonce, multi-byte UTF-8 and padding that makes the whole command exactly
/// `MAX_COMMAND_BYTES` bytes, with a three-byte character ending right at the limit.
fn boundary_command(nonce: &str, file: &Path) -> Result<(String, String), String> {
    let base = append_command(nonce, file)?.len();
    if base + 3 > MAX_COMMAND_BYTES {
        return Err("probe path leaves no room for the boundary payload".into());
    }
    let room = MAX_COMMAND_BYTES - base;
    let ascii = room % 3;
    let payload = format!("{nonce}{}{}", "x".repeat(ascii), "中".repeat(room / 3));
    let command = append_command(&payload, file)?;
    if command.len() != MAX_COMMAND_BYTES || !payload.ends_with('中') {
        return Err(format!("boundary command is {} bytes", command.len()));
    }
    Ok((payload, command))
}

fn submit(probe: &Probe, command: &str) -> Result<(), String> {
    let mut bytes = command.as_bytes().to_vec();
    bytes.push(b'\r');
    probe.session.write(bytes)
}

fn pid_of(line: &str, payload: &str) -> Result<u32, String> {
    line.strip_prefix(payload)
        .and_then(|rest| rest.strip_prefix(' '))
        .and_then(|pid| pid.parse().ok())
        .ok_or_else(|| format!("count line is not \"<payload> <pid>\": {line:?}"))
}

fn probe_shell(sessions: &Sessions, shell: Option<&str>, directory: &Path) -> Result<(), String> {
    let label = shell.unwrap_or("default");
    let nonce = format!("P1SC{}", uuid::Uuid::new_v4().simple());
    let file = directory.join(format!("{label} 计数.txt"));
    let command = append_command(&nonce, &file)?;
    let mut pids = Vec::new();
    for attempt in 1..=2 {
        let mut probe = Probe::open(sessions, shell)?;
        // Same bytes and timing as the frontend: right after open returns, no prompt wait.
        submit(&probe, &command)?;
        let waited = probe.wait_for_lines(&file, attempt)?;
        probe.exit_barrier(sessions)?;
        let lines = read_lines(&file)?;
        if lines.len() != attempt {
            return Err(format!(
                "{label} attempt {attempt}: {} line(s) after the exit barrier, expected {attempt}",
                lines.len()
            ));
        }
        let pid = pid_of(&lines[attempt - 1], &nonce)?;
        if pids.contains(&pid) {
            return Err(format!("{label} reopen reused shell pid {pid}"));
        }
        pids.push(pid);
        println!("PASS startup command shell={label} attempt {attempt}/2: written right after open, {attempt} line(s) after exit barrier, pid {pid}; side effect after {:.0} ms (diagnostic only)", waited.as_secs_f64() * 1000.0);
    }

    let boundary_file = directory.join(format!("{label} boundary.txt"));
    let (payload, command) = boundary_command(&nonce, &boundary_file)?;
    let mut probe = Probe::open(sessions, shell)?;
    submit(&probe, &command)?;
    probe.wait_for_lines(&boundary_file, 1)?;
    probe.exit_barrier(sessions)?;
    let lines = read_lines(&boundary_file)?;
    if lines.len() != 1 {
        return Err(format!(
            "{label} boundary: {} line(s), expected 1",
            lines.len()
        ));
    }
    pid_of(&lines[0], &payload)?;
    println!("PASS startup command shell={label}: {MAX_COMMAND_BYTES}-byte command (+CR, multi-byte UTF-8 at the end) arrived intact, 1 line after exit barrier");

    // Control: the same bytes without CR never run while the shell is alive. The line is then
    // discarded with Ctrl-U (VKILL / kill-line) before the exit barrier. Closing the session instead
    // would not be an inert barrier: see `observe_close_with_unsubmitted_line`.
    let control_file = directory.join(format!("{label} control.txt"));
    let command = append_command(&nonce, &control_file)?;
    let mut probe = Probe::open(sessions, shell)?;
    probe.session.write(command.into_bytes())?;
    probe.settle_after_prompt()?;
    if control_file.exists() {
        return Err(format!(
            "{label} control: command without CR ran while the shell was alive"
        ));
    }
    probe.session.write(vec![0x15])?;
    probe.exit_barrier(sessions)?;
    let count = count_lines(&control_file)?;
    if count != 0 || control_file.exists() {
        return Err(format!(
            "{label} control: command without CR produced {count} line(s) or created the file"
        ));
    }
    println!("PASS startup command shell={label} control: same command without CR, prompt plus {} ms alive, Ctrl-U, exit barrier: file never created, 0 lines", UNSUBMITTED_SETTLE.as_millis());
    Ok(())
}

/// Observation only, never a pass/fail gate (opt-in through `P1_STARTUP_CLOSE_TRIALS`). On Unix
/// `Sessions::close` releases the input worker first; dropping portable-pty 0.9.0's master writer
/// writes "\n" plus VEOF into the PTY before the shell receives SIGHUP. A line still held by the
/// shell's line editor can therefore be submitted, and start running, while the session closes.
/// The outcome is a race, so this only counts how often the command's file appears.
fn observe_close_with_unsubmitted_line(
    sessions: &Sessions,
    shell: Option<&str>,
    directory: &Path,
    trials: usize,
) -> Result<(), String> {
    let label = shell.unwrap_or("default");
    let (mut created, mut appended) = (0, 0);
    for trial in 1..=trials {
        let file = directory.join(format!("{label} close-{trial}.txt"));
        let mut probe = Probe::open(sessions, shell)?;
        probe
            .session
            .write(append_command("P1SC-CLOSE", &file)?.into_bytes())?;
        probe.settle_after_prompt()?;
        if file.exists() {
            return Err(format!("{label} close trial {trial}: ran before close"));
        }
        probe.close_and_reap(sessions)?;
        created += usize::from(file.exists());
        appended += usize::from(count_lines(&file)? > 0);
    }
    println!("OBSERVE startup command shell={label}: {trials} product close(s) with an unsubmitted line held by the shell: command file created {created}, line appended {appended} (diagnostic only, not a gate)");
    Ok(())
}

/// Default shell, explicit Bash and, when present, explicit zsh. Missing shells are skipped, not passed.
pub fn probe_startup_command() -> Result<(), String> {
    let trials = std::env::var(CLOSE_TRIALS_ENV)
        .ok()
        .map(|value| match value.parse::<usize>() {
            Ok(trials) if trials <= 50 => Ok(trials),
            _ => Err(format!("{CLOSE_TRIALS_ENV} must be an integer 0..=50")),
        })
        .transpose()?
        .unwrap_or(0);
    let directory =
        std::env::temp_dir().join(format!("p1 startup 计数-{}", uuid::Uuid::new_v4().simple()));
    std::fs::create_dir(&directory).map_err(|error| error.to_string())?;
    let sessions = Sessions::default();
    let shells = local_shells();
    let available = |id: &str| shells.iter().any(|shell| shell.id == id && shell.available);
    let result = (|| {
        let mut shells_run = vec![None];
        for id in ["bash", "zsh"] {
            if available(id) {
                shells_run.push(Some(id));
            } else {
                println!("SKIP startup command shell={id}: unavailable on this host");
            }
        }
        for shell in &shells_run {
            probe_shell(&sessions, *shell, &directory)?;
        }
        if trials > 0 {
            for shell in &shells_run {
                observe_close_with_unsubmitted_line(&sessions, *shell, &directory, trials)?;
            }
        }
        if available("pwsh") {
            println!("SKIP startup command shell=pwsh: PowerShell 7 is not covered by this probe");
        }
        Ok(())
    })();
    sessions.shutdown();
    let cleanup = std::fs::remove_dir_all(&directory).map_err(|error| error.to_string());
    result.and(cleanup)
}
