//! ZMODEM (F12) evaluation: `zmodem2` =0.7.3 (dev-dependency only) against a
//! real lrzsz `sz`/`rz` (Homebrew `lsz`/`lrz`) over stdin/stdout pipes in
//! private temporary directories. Nothing here is used by the app.
//!
//! Ignored by default; run with
//! `cargo test --locked --all-features --test zmodem_lrzsz -- --ignored`.
//! Each test skips with a message when lrzsz is missing, or fails when
//! `P0_LRZSZ_REQUIRED` is set. lrzsz is GPL and only ever runs as a separate
//! process; none of its code is linked or copied.
#![cfg(unix)]

#[path = "support/lrzsz.rs"]
mod lrzsz;
#[path = "support/zmodem2_probe.rs"]
mod zmodem2_probe;

use lrzsz::{pump, require, transfer, Peer, Program, Scratch, Trace, TICK};
use std::{
    convert::identity,
    time::{Duration, Instant},
};
use zmodem2_probe::{Outcome, ProbeLimits, ZOutgoing, ZReceiver, ZSender};

const SUB: u8 = 0x1A;
const CAN: u8 = 0x18;
const BIG: usize = 1_000_003;
/// Progress after which interruption tests intervene.
const MID_TRANSFER: u64 = 128 * 1024;
/// A ZRPOS hex header (`**`, ZDLE, `B`, frame type 09).
const ZRPOS_HEX: &[u8] = b"**\x18B09";

/// Deterministic xorshift bytes; long runs contain every ZDLE-escaped byte.
fn pattern(len: usize, seed: u32) -> Vec<u8> {
    let mut state = seed.wrapping_mul(0x9E37_79B9) | 1;
    (0..len)
        .map(|_| {
            state ^= state << 13;
            state ^= state >> 17;
            state ^= state << 5;
            (state >> 24) as u8
        })
        .collect()
}

/// Empty, non-ASCII name, a real trailing SUB, odd sizes and a 1 MB file.
fn batch() -> Vec<ZOutgoing> {
    let mut sub_tail = b"real tail".to_vec();
    sub_tail.extend([SUB; 3]);
    [
        ("empty.bin", Vec::new()),
        ("中文 名.txt", pattern(1000, 21)),
        ("sub-tail.bin", sub_tail),
        ("odd-70001.bin", pattern(70_001, 22)),
        ("big.bin", pattern(BIG, 23)),
    ]
    .into_iter()
    .map(|(name, data)| ZOutgoing {
        name: name.into(),
        data,
    })
    .collect()
}

fn big() -> Vec<ZOutgoing> {
    vec![ZOutgoing {
        name: "big.bin".into(),
        data: pattern(BIG, 31),
    }]
}

fn write_sources(scratch: &Scratch, files: &[ZOutgoing]) {
    for file in files {
        std::fs::write(scratch.path().join(&file.name), &file.data).expect("write source file");
    }
}

fn names(files: &[ZOutgoing]) -> Vec<String> {
    let mut names: Vec<_> = files.iter().map(|file| file.name.clone()).collect();
    names.sort();
    names
}

fn spawn(program: &Program, args: &[&str], scratch: &Scratch) -> Peer {
    Peer::spawn(program, args, scratch.path())
}

fn occurrences(trace: &Trace, needle: &[u8]) -> usize {
    trace
        .writes
        .concat()
        .windows(needle.len())
        .filter(|window| *window == needle)
        .count()
}

/// Receives `files` from `sz` with extra `options`, checking every byte.
fn receive_from_sz(
    sz: &Program,
    options: &[&str],
    files: &[ZOutgoing],
    inbound: impl FnMut(Vec<u8>) -> Vec<u8>,
) -> Trace {
    let scratch = Scratch::new();
    write_sources(&scratch, files);
    let mut args = vec!["--binary"];
    args.extend_from_slice(options);
    args.extend(files.iter().map(|file| file.name.as_str()));
    let mut peer = spawn(sz, &args, &scratch);
    let mut rx = ZReceiver::new(ProbeLimits::default());
    let trace = pump(&mut rx, &mut peer, identity, inbound, |_, _| {});
    let exit = peer.finish();
    let label = format!("sz {options:?}");
    assert_eq!(rx.outcome(), &Outcome::Done, "{label}: {}", exit.stderr);
    assert!(exit.success(), "{label}: {:?} {}", exit.status, exit.stderr);
    assert_eq!(rx.files().len(), files.len(), "{label}");
    for (got, want) in rx.files().iter().zip(files) {
        assert_eq!(got.name, want.name, "{label}");
        assert_eq!(
            got.declared,
            want.data.len() as u64,
            "{label}: {}",
            want.name
        );
        assert!(got.data == want.data, "{label}: {} differs", want.name);
    }
    trace
}

/// What a send to `rz` left behind.
struct Sent {
    outcome: Outcome,
    exit: lrzsz::Exit,
    scratch: Scratch,
}

/// Sends `files` to `rz`; `window` overrides the library's 10 subpackets per ZACK.
fn run_to_rz(
    rz: &Program,
    files: Vec<ZOutgoing>,
    window: Option<usize>,
    outbound: impl FnMut(Vec<u8>) -> Vec<u8>,
) -> Sent {
    let scratch = Scratch::new();
    let mut peer = spawn(rz, &["--binary"], &scratch);
    let mut tx = ZSender::new(files, ProbeLimits::default());
    if let Some(window) = window {
        tx = tx.with_window(window);
    }
    pump(&mut tx, &mut peer, outbound, identity, |_, _| {});
    Sent {
        outcome: tx.outcome().clone(),
        exit: peer.finish(),
        scratch,
    }
}

/// Sends `files` to `rz`, checking names and every byte on disk.
fn send_to_rz(rz: &Program, files: Vec<ZOutgoing>, window: Option<usize>) {
    let sent = run_to_rz(rz, files.clone(), window, identity);
    let (exit, scratch) = (&sent.exit, &sent.scratch);
    assert_eq!(sent.outcome, Outcome::Done, "rz: {}", exit.stderr);
    assert!(exit.success(), "rz: {:?} {}", exit.status, exit.stderr);
    assert_eq!(scratch.file_names(), names(&files));
    for file in &files {
        let got = std::fs::read(scratch.path().join(&file.name)).expect("read received file");
        assert!(got == file.data, "rz: {} differs", file.name);
    }
}

/// Damages the byte at `at` of the stream, counting from the first write.
fn damage_at(at: usize) -> impl FnMut(Vec<u8>) -> Vec<u8> {
    let mut offset = 0;
    move |mut bytes: Vec<u8>| {
        if let Some(byte) = at.checked_sub(offset).and_then(|i| bytes.get_mut(i)) {
            *byte ^= 0x5A;
        }
        offset += bytes.len();
        bytes
    }
}

#[test]
#[ignore = "needs lrzsz; run with --ignored"]
fn zmodem2_receives_a_batch_from_sz() {
    let Some(sz) = require("sz") else { return };
    // `--escape` makes sz open with ZSINIT and escape every control byte.
    for options in [&[][..], &["--escape"][..]] {
        let trace = receive_from_sz(&sz, options, &batch(), identity);
        assert_eq!(occurrences(&trace, ZRPOS_HEX), batch().len(), "{options:?}");
    }
}

#[test]
#[ignore = "needs lrzsz; run with --ignored"]
fn zmodem2_sends_a_batch_to_rz() {
    let Some(rz) = require("rz") else { return };
    send_to_rz(&rz, batch(), None);
    // Stop-and-wait, as the corruption test below needs, also interoperates.
    send_to_rz(&rz, batch(), Some(1));
}

#[test]
#[ignore = "needs lrzsz; run with --ignored"]
fn zmodem2_receiver_recovers_corrupted_data_with_zrpos() {
    // One byte deep inside the 1 MB file is damaged on the way to us; the
    // library asks `sz` to rewind with a second ZRPOS for that file.
    let Some(sz) = require("sz") else { return };
    for at in [5_000, 300_000] {
        let trace = receive_from_sz(&sz, &[], &big(), damage_at(at));
        assert_eq!(
            occurrences(&trace, ZRPOS_HEX),
            2,
            "{at}: one to start, one to rewind"
        );
    }
}

#[test]
#[ignore = "needs lrzsz; run with --ignored"]
fn zmodem2_sender_recovers_from_rz_rewinds_only_in_stop_and_wait() {
    let Some(rz) = require("rz") else { return };
    for at in [50_000, 300_000] {
        // Defect in 0.7.3: with its default window (10 subpackets per ZACK)
        // or nonstop streaming, the sender reads at most one header per data
        // frame, so after a rewind it keeps answering a stale ZRPOS/ZACK one
        // frame late; `rz` repeats ZRPOS until it reports "out of sync" and
        // cancels. Deterministic here with lrzsz 0.13.1.
        for window in [None, Some(usize::MAX)] {
            let sent = run_to_rz(&rz, big(), window, damage_at(at));
            let label = format!("{at} {window:?}");
            assert_eq!(
                sent.outcome,
                Outcome::RemoteCancel { by_library: false },
                "{label}"
            );
            assert!(!sent.exit.success(), "{label}");
            assert!(
                sent.scratch.file_names().is_empty(),
                "{label}: rz kept a file"
            );
        }
        // One subpacket per ZACK (a round trip per KiB) recovers exactly.
        let sent = run_to_rz(&rz, big(), Some(1), damage_at(at));
        assert_eq!(sent.outcome, Outcome::Done, "{at}: {}", sent.exit.stderr);
        assert!(sent.exit.success(), "{at}");
        let got = std::fs::read(sent.scratch.path().join("big.bin")).expect("read big.bin");
        assert!(got == big()[0].data, "{at}: content differs");
    }
}

#[test]
#[ignore = "needs lrzsz; run with --ignored"]
fn sz_full_path_names_are_refused_by_the_driver_not_the_library() {
    let Some(sz) = require("sz") else { return };
    let scratch = Scratch::new();
    std::fs::create_dir(scratch.path().join("sub")).expect("create sub");
    std::fs::write(scratch.path().join("sub/x.bin"), b"payload").expect("write source");
    let mut peer = spawn(&sz, &["--full-path", "sub/x.bin"], &scratch);
    let mut rx = ZReceiver::new(ProbeLimits::default());
    let trace = transfer(&mut rx, &mut peer);
    let exit = peer.finish();
    assert_eq!(rx.outcome(), &Outcome::Refused("file name"));
    assert!(
        trace.writes.concat().windows(5).any(|w| w == [CAN; 5]),
        "CAN sent"
    );
    assert!(rx.files().is_empty());
    assert!(
        exit.status.is_some() && !exit.success(),
        "{:?}",
        exit.status
    );
}

/// Runs a 1 MB transfer in one direction and intervenes mid-transfer.
fn interrupted(
    to_peer: bool,
    limits: ProbeLimits,
    act: impl Fn(&mut dyn lrzsz::Machine, &Peer),
) -> Option<(Outcome, lrzsz::Exit, Duration)> {
    let scratch = Scratch::new();
    let mut acted: Option<Instant> = None;
    let (outcome, peer) = if to_peer {
        let rz = require("rz")?;
        let mut peer = spawn(&rz, &["--binary"], &scratch);
        let mut tx = ZSender::new(big(), limits);
        pump(&mut tx, &mut peer, identity, identity, |tx, peer| {
            if acted.is_none() && tx.submitted() >= MID_TRANSFER {
                acted = Some(Instant::now());
                act(tx, peer);
            }
        });
        (tx.outcome().clone(), peer)
    } else {
        let sz = require("sz")?;
        write_sources(&scratch, &big());
        let mut peer = spawn(&sz, &["--binary", "big.bin"], &scratch);
        let mut rx = ZReceiver::new(limits);
        pump(&mut rx, &mut peer, identity, identity, |rx, peer| {
            if acted.is_none() && rx.received() >= MID_TRANSFER {
                acted = Some(Instant::now());
                act(rx, peer);
            }
        });
        assert!(rx.files().is_empty(), "a partial file was completed");
        (rx.outcome().clone(), peer)
    };
    let settle = acted
        .expect("transfer ended before the intervention")
        .elapsed();
    let exit = peer.finish();
    let label = if to_peer { "to rz" } else { "from sz" };
    eprintln!(
        "{label}: {outcome:?} after {settle:?}; peer exit {:?}",
        exit.status
    );
    Some((outcome, exit, settle))
}

#[test]
#[ignore = "needs lrzsz; run with --ignored"]
fn our_abort_sequence_stops_sz_and_rz() {
    for to_peer in [true, false] {
        let run = interrupted(to_peer, ProbeLimits::default(), |machine, _| {
            machine.cancel()
        });
        let Some((outcome, exit, _)) = run else {
            return;
        };
        assert_eq!(outcome, Outcome::LocalCancel);
        assert!(exit.status.is_some(), "peer had to be killed");
        assert!(!exit.success(), "peer reported success");
    }
}

#[test]
#[ignore = "needs lrzsz; run with --ignored"]
fn interrupted_lrzsz_is_caught_by_the_driver_not_the_library() {
    let quick = ProbeLimits {
        timeout_ticks: 2,
        max_timeouts: 3,
        ..ProbeLimits::default()
    };
    let interrupt = |_: &mut dyn lrzsz::Machine, peer: &Peer| peer.signal("INT");
    // `rz` answers SIGINT with ten CANs; only the driver's CAN check sees
    // them; zmodem2 0.7.3 alone ignores them and waits until timed out.
    let Some((outcome, exit, _)) = interrupted(true, quick, interrupt) else {
        return;
    };
    assert_eq!(outcome, Outcome::RemoteCancel { by_library: false });
    assert!(!exit.success());
    let library_only = ProbeLimits {
        can_check: false,
        ..quick
    };
    let Some((outcome, _, _)) = interrupted(true, library_only, interrupt) else {
        return;
    };
    assert_eq!(
        outcome,
        Outcome::TimedOut,
        "zmodem2 noticed the CANs itself"
    );
    // `sz` (lsz 0.13.1, ZMODEM over pipes) just goes silent on SIGINT without
    // a CAN run, so only the driver's timeout budget ends the session.
    let Some((outcome, exit, _)) = interrupted(false, quick, interrupt) else {
        return;
    };
    assert_eq!(outcome, Outcome::TimedOut);
    assert!(!exit.success());
}

#[test]
#[ignore = "needs lrzsz; run with --ignored"]
fn killed_lrzsz_ends_through_the_drivers_timeout_budget() {
    let quick = ProbeLimits {
        timeout_ticks: 2,
        max_timeouts: 3,
        ..ProbeLimits::default()
    };
    for to_peer in [true, false] {
        let run = interrupted(to_peer, quick, |_, peer| peer.signal("KILL"));
        let Some((outcome, exit, settle)) = run else {
            return;
        };
        assert_eq!(outcome, Outcome::TimedOut);
        assert!(!exit.success());
        let budget = TICK * (quick.max_timeouts + 1) * quick.timeout_ticks;
        assert!(settle < budget + Duration::from_secs(1), "{settle:?}");
    }
}
