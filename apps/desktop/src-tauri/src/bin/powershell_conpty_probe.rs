//! Real Windows ConPTY-only PowerShell latency probe.
//!
//! This deliberately bypasses the product shell whitelist so candidate
//! environments can be compared without changing `local_shell.rs`. It records
//! only mode names and timings; terminal output is bounded and never printed.

#[cfg(not(windows))]
fn main() {
    eprintln!("PowerShell ConPTY probe requires Windows");
    std::process::exit(1);
}

#[cfg(windows)]
mod windows_probe {
    use portable_pty::{native_pty_system, CommandBuilder, PtySize};
    use std::{
        collections::BTreeMap,
        env,
        ffi::OsString,
        io::{Read, Write},
        path::{Path, PathBuf},
        sync::mpsc::{sync_channel, Receiver, RecvTimeoutError},
        thread,
        time::{Duration, Instant},
    };

    const SAMPLE_DEADLINE: Duration = Duration::from_secs(30);
    const STARTUP_DEADLINE: Duration = Duration::from_secs(5);
    const OUTPUT_LIMIT: usize = 256 * 1024;

    #[derive(Clone)]
    struct Variant {
        name: &'static str,
        env: BTreeMap<OsString, OsString>,
    }

    enum Chunk {
        Data(Vec<u8>),
        Error,
        Eof,
    }

    fn source_env() -> BTreeMap<OsString, OsString> {
        env::vars_os().collect()
    }

    fn find_key<'a>(
        source: &'a BTreeMap<OsString, OsString>,
        wanted: &str,
    ) -> Option<&'a OsString> {
        source
            .keys()
            .find(|key| key.to_string_lossy().eq_ignore_ascii_case(wanted))
    }

    fn remove_key(
        source: &BTreeMap<OsString, OsString>,
        wanted: &str,
    ) -> BTreeMap<OsString, OsString> {
        let mut result = source.clone();
        if let Some(key) = find_key(&result, wanted).cloned() {
            result.remove(&key);
        }
        result
    }

    fn product_env(
        source: &BTreeMap<OsString, OsString>,
    ) -> Result<BTreeMap<OsString, OsString>, String> {
        let mut result = BTreeMap::new();
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
            let key = find_key(source, name);
            if key.is_none() && matches!(name, "SystemRoot" | "PATH") {
                return Err(format!("required environment missing: {name}"));
            }
            if let Some(key) = key {
                result.insert(OsString::from(name), source[key].clone());
            }
        }
        Ok(result)
    }

    fn variants(source: &BTreeMap<OsString, OsString>) -> Result<Vec<Variant>, String> {
        let product = product_env(source)?;
        let mut product_with_parent = product.clone();
        if let Some(key) = find_key(source, "PSModulePath") {
            product_with_parent.insert(OsString::from("PSModulePath"), source[key].clone());
        }
        Ok(vec![
            Variant {
                name: "inherited",
                env: source.clone(),
            },
            Variant {
                name: "product-whitelist",
                env: product,
            },
            Variant {
                name: "product-whitelist-parent-psmodulepath",
                env: product_with_parent,
            },
            Variant {
                name: "inherited-without-psmodulepath",
                env: remove_key(source, "PSModulePath"),
            },
        ])
    }

    fn spawn_reader(mut reader: Box<dyn Read + Send>) -> Receiver<Chunk> {
        let (sender, receiver) = sync_channel(128);
        thread::spawn(move || {
            let mut buffer = [0_u8; 4096];
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) => {
                        let _ = sender.send(Chunk::Eof);
                        break;
                    }
                    Ok(size) => {
                        if sender.send(Chunk::Data(buffer[..size].to_vec())).is_err() {
                            break;
                        }
                    }
                    Err(_) => {
                        let _ = sender.send(Chunk::Error);
                        break;
                    }
                }
            }
        });
        receiver
    }

    fn answer_cursor(writer: &mut dyn Write, chunk: &[u8]) -> Result<(), String> {
        if chunk.windows(4).any(|part| part == b"\x1b[6n") {
            writer
                .write_all(b"\x1b[1;1R")
                .map_err(|_| "cursor response failed".to_owned())?;
            writer
                .flush()
                .map_err(|_| "cursor response flush failed".to_owned())?;
        }
        Ok(())
    }

    fn prime(receiver: &Receiver<Chunk>, writer: &mut dyn Write) -> Result<(), String> {
        let deadline = Instant::now() + STARTUP_DEADLINE;
        loop {
            let left = deadline
                .checked_duration_since(Instant::now())
                .ok_or("PowerShell ConPTY startup timed out")?;
            match receiver.recv_timeout(left.min(Duration::from_millis(250))) {
                Ok(Chunk::Data(chunk)) => {
                    answer_cursor(writer, &chunk)?;
                    return Ok(());
                }
                Ok(Chunk::Error) => return Err("PowerShell ConPTY reader failed".into()),
                Ok(Chunk::Eof) => return Err("PowerShell ConPTY exited during startup".into()),
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => {
                    return Err("PowerShell ConPTY reader disconnected".into())
                }
            }
        }
    }

    fn receive_marker(
        receiver: &Receiver<Chunk>,
        writer: &mut dyn Write,
        marker: &[u8],
        timeout: Duration,
    ) -> Result<Vec<u8>, String> {
        let deadline = Instant::now() + timeout;
        let mut output = Vec::new();
        loop {
            let left = deadline
                .checked_duration_since(Instant::now())
                .ok_or("PowerShell ConPTY marker timed out")?;
            match receiver.recv_timeout(left.min(Duration::from_millis(250))) {
                Ok(Chunk::Data(chunk)) => {
                    answer_cursor(writer, &chunk)?;
                    output.extend_from_slice(&chunk);
                    if output.len() > OUTPUT_LIMIT {
                        return Err("PowerShell ConPTY output exceeded bound".into());
                    }
                    if output.windows(marker.len()).any(|part| part == marker) {
                        return Ok(output);
                    }
                }
                Ok(Chunk::Error) => return Err("PowerShell ConPTY reader failed".into()),
                Ok(Chunk::Eof) => return Err("PowerShell ConPTY exited before marker".into()),
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => {
                    return Err("PowerShell ConPTY reader disconnected".into())
                }
            }
        }
    }

    fn powershell_path(source: &BTreeMap<OsString, OsString>) -> Result<PathBuf, String> {
        let root = find_key(source, "SystemRoot")
            .and_then(|key| source.get(key))
            .ok_or("SystemRoot is unavailable")?;
        Ok(PathBuf::from(root).join(r"System32\WindowsPowerShell\v1.0\powershell.exe"))
    }

    fn parse_inner_milliseconds(output: &[u8]) -> Result<f64, String> {
        let text = String::from_utf8_lossy(output);
        let prefix = "P1_RESULT|";
        // ConPTY may wrap the prompt/command in cursor-control sequences, so
        // the marker is not guaranteed to begin a logical text line.
        let start = text
            .find(prefix)
            .ok_or("PowerShell result marker missing")?
            + prefix.len();
        let line = text[start..]
            .split(['\r', '\n', '\u{1b}'])
            .next()
            .unwrap_or_default()
            .trim();
        let value = line
            .parse::<f64>()
            .map_err(|_| "PowerShell result timing invalid")?;
        if !value.is_finite() || value < 0.0 {
            return Err("PowerShell result timing out of range".into());
        }
        Ok(value)
    }

    fn sample(path: &Path, cwd: &Path, variant: &Variant) -> Result<(f64, f64), String> {
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 30,
                cols: 120,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|_| "PowerShell ConPTY allocation failed")?;
        let mut command = CommandBuilder::new(path);
        command.args(["-NoLogo", "-NoProfile"]);
        command.env_clear();
        for (name, value) in &variant.env {
            command.env(name, value);
        }
        command.cwd(cwd);
        let mut child = pair
            .slave
            .spawn_command(command)
            .map_err(|_| "PowerShell ConPTY spawn failed")?;
        drop(pair.slave);
        let receiver = spawn_reader(
            pair.master
                .try_clone_reader()
                .map_err(|_| "PowerShell reader clone failed")?,
        );
        let mut writer = pair
            .master
            .take_writer()
            .map_err(|_| "PowerShell writer unavailable")?;
        let result = (|| {
            prime(&receiver, writer.as_mut())?;
            writer.write_all(b"$sw=[Diagnostics.Stopwatch]::StartNew(); $null=(Get-Location).Path; $sw.Stop(); Write-Output ('P1_RESULT|' + $sw.Elapsed.TotalMilliseconds.ToString('R',[Globalization.CultureInfo]::InvariantCulture)); Write-Output 'P1_DONE'\r\n").map_err(|_| "PowerShell command write failed")?;
            writer
                .flush()
                .map_err(|_| "PowerShell command flush failed")?;
            let started = Instant::now();
            let output = receive_marker(&receiver, writer.as_mut(), b"P1_DONE", SAMPLE_DEADLINE)?;
            let host_ms = started.elapsed().as_secs_f64() * 1000.0;
            let inner_ms = parse_inner_milliseconds(&output)?;
            writer
                .write_all(b"exit 0\r\n")
                .map_err(|_| "PowerShell exit write failed")?;
            writer.flush().map_err(|_| "PowerShell exit flush failed")?;
            child.wait().map_err(|_| "PowerShell exit wait failed")?;
            Ok((inner_ms, host_ms))
        })();
        if result.is_err() {
            let _ = child.kill();
        }
        let _ = child.wait();
        drop(writer);
        drop(pair.master);
        result
    }

    pub fn run() -> Result<(), String> {
        let source = source_env();
        let path = powershell_path(&source)?;
        let directory = tempfile_dir()?;
        let variants = variants(&source)?;
        let mut failed = false;
        for iteration in 1..=2 {
            let order: Vec<_> = if iteration % 2 == 0 {
                variants.iter().rev().collect()
            } else {
                variants.iter().collect()
            };
            for variant in order {
                match sample(&path, &directory, variant) {
                    Ok((inner_ms, host_ms)) => println!(
                        "PASS mode={} iteration={} inner_ms={inner_ms:.3} host_ms={host_ms:.3}",
                        variant.name, iteration
                    ),
                    Err(error) => {
                        failed = true;
                        eprintln!("FAIL mode={} iteration={iteration}: {error}", variant.name);
                    }
                }
            }
        }
        let _ = std::fs::remove_dir(&directory);
        if failed {
            Err("one or more ConPTY samples failed".into())
        } else {
            Ok(())
        }
    }

    fn tempfile_dir() -> Result<PathBuf, String> {
        let root = env::temp_dir();
        for attempt in 0..100 {
            let path = root.join(format!("p1-conpty-latency-{attempt}"));
            if std::fs::create_dir(&path).is_ok() {
                return Ok(path);
            }
        }
        Err("unable to create ConPTY probe directory".into())
    }
}

#[cfg(windows)]
fn main() {
    if let Err(error) = windows_probe::run() {
        eprintln!("PowerShell ConPTY probe failed: {error}");
        std::process::exit(1);
    }
}
