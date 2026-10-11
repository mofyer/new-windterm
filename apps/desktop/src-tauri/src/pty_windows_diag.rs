//! Which lifecycle step leaks a handle on Windows. Each step runs a few
//! warm-up cycles, then eight measured cycles, and prints the change in open
//! handles per object type. Diagnostics only: nothing is asserted.
use super::windows_tests::Probe;
use super::*;
use std::io::{Read, Write};

const CYCLES: u32 = 8;

fn settle() {
    thread::sleep(Duration::from_millis(300));
}

fn measure(step: &str, cycle: impl Fn()) {
    for _ in 0..2 {
        cycle();
    }
    settle();
    let table = platform::windows::handle_table();
    let before = platform::windows::handle_types();
    for _ in 0..CYCLES {
        cycle();
    }
    settle();
    let after = platform::windows::handle_types();
    // Name the targets of process handles that appeared during the step.
    for (value, kind) in platform::windows::handle_table() {
        if kind == "Process" && !table.contains_key(&value) {
            eprintln!(
                "[handle-diag] {step}: new process handle {value:#x}: {}",
                platform::windows::describe_process(value)
            );
        }
    }
    let mut changes = Vec::new();
    for name in before.keys().chain(after.keys()) {
        let delta =
            i64::from(*after.get(name).unwrap_or(&0)) - i64::from(*before.get(name).unwrap_or(&0));
        if delta != 0 && !changes.iter().any(|(seen, _)| seen == name) {
            changes.push((name.clone(), delta));
        }
    }
    let total: i64 = changes.iter().map(|(_, delta)| delta).sum();
    eprintln!("[handle-diag] {step}: {total:+} over {CYCLES} cycles {changes:?}");
}

/// Polls `done` until it holds or ten seconds pass.
fn wait_until(what: &str, mut done: impl FnMut() -> bool) {
    let started = Instant::now();
    while !done() {
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "{what} timed out"
        );
        thread::sleep(Duration::from_millis(10));
    }
}

/// A bare portable-pty shell: open, answer the cursor query, exit, close.
fn bare_shell(adopt: bool) {
    let pair = native_pty_system()
        .openpty(PtySize {
            rows: 30,
            cols: 100,
            pixel_width: 0,
            pixel_height: 0,
        })
        .unwrap();
    let mut reader = pair.master.try_clone_reader().unwrap();
    let mut writer = pair.master.take_writer().unwrap();
    let mut child = pair
        .slave
        .spawn_command(platform::local_command().unwrap())
        .unwrap();
    drop(pair.slave);
    let tree = adopt
        .then(|| platform::windows::ProcessTree::adopt(child.as_raw_handle().unwrap()).unwrap());
    let (eof, ended) = std::sync::mpsc::channel();
    let drain = thread::spawn(move || {
        let mut buffer = [0; 4096];
        while matches!(reader.read(&mut buffer), Ok(read) if read > 0) {}
        let _ = eof.send(());
    });
    writer.write_all(b"\x1b[1;1R").unwrap();
    writer.write_all(b"exit\r\n").unwrap();
    wait_until("shell exit", || matches!(child.try_wait(), Ok(Some(_))));
    if let Some(tree) = &tree {
        tree.terminate();
    }
    drop(writer);
    drop(pair.master);
    ended
        .recv_timeout(Duration::from_secs(10))
        .expect("pipe EOF timed out");
    drain.join().unwrap();
    drop(child);
    drop(tree);
}

#[test]
#[ignore = "process-wide handle diagnostics; run alone with --ignored --exact"]
fn handle_growth_by_lifecycle_step() {
    measure("idle (measurement noise)", || {});
    measure("openpty + drop, no shell", || {
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 30,
                cols: 100,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap();
        drop(pair);
    });
    measure("bare shell, no job", || bare_shell(false));
    measure("bare shell + job object", || bare_shell(true));
    let sessions = Arc::new(Sessions::default());
    measure("full Session close cycle", || {
        let mut probe = Probe::open_in(sessions.clone());
        probe.ready();
        probe.session.close();
        probe.assert_reaped();
    });
    sessions.shutdown();
}
