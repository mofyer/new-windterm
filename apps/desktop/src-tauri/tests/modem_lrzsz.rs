//! Interop between our sans-IO X/YMODEM machines and a real lrzsz peer
//! (`sx`/`rx`/`sb`/`rb`, Homebrew `lsx`/`lrx`/`lsb`/`lrb`) over stdin/stdout
//! pipes in private temporary directories.
//!
//! Ignored by default; run with
//! `cargo test --locked --all-features --test modem_lrzsz -- --ignored`.
//! Each test skips with a message when lrzsz is missing, or fails when
//! `P0_LRZSZ_REQUIRED` is set. lrzsz is GPL and only ever runs as a separate
//! process; none of its code is linked or copied.
#![cfg(unix)]

#[path = "support/lrzsz.rs"]
mod lrzsz;

use lrzsz::{pump, require, transfer, Peer, Program, Scratch, Trace, TICK};
use new_windterm_desktop::modem::{
    Failure, Limits, OutgoingFile, ReceivedFile, Receiver, Sender, Status,
};
use std::{
    convert::identity,
    time::{Duration, Instant},
};

const SOH: u8 = 0x01;
const STX: u8 = 0x02;
const ACK: u8 = 0x06;
const NAK: u8 = 0x15;
const CAN: u8 = 0x18;
const SUB: u8 = 0x1A;
const SHORT: usize = 128;
const LONG: usize = 1024;
/// Empty, one byte, exactly one block, not a block multiple, and >255 blocks.
const XMODEM_SIZES: [usize; 5] = [0, 1, 128, 1000, 70_001];
/// Progress after which interruption tests intervene.
const MID_TRANSFER: u64 = 64 * 1024;
const BIG: usize = 1_000_003;
const QUICK_START: Limits = Limits {
    max_file_bytes: 16 * 1024 * 1024,
    max_files: 64,
    max_total_bytes: 64 * 1024 * 1024,
    max_retries: 10,
    timeout_ticks: 3,
};

#[derive(Debug, Clone, Copy, PartialEq)]
enum Check {
    Checksum,
    Crc,
    OneK,
}
const CHECKS: [Check; 3] = [Check::Checksum, Check::Crc, Check::OneK];

/// Deterministic xorshift bytes; long runs contain every protocol control byte.
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

/// XMODEM carries no length: the data arrives padded with SUB to 128 bytes.
fn padded(data: &[u8]) -> Vec<u8> {
    let mut bytes = data.to_vec();
    bytes.resize(data.len().div_ceil(SHORT) * SHORT, SUB);
    bytes
}

fn frames(trace: &Trace) -> Vec<&Vec<u8>> {
    trace
        .writes
        .iter()
        .filter(|write| matches!(write.as_slice(), [SOH | STX, block, inverse, ..] if *block == !*inverse))
        .collect()
}

/// How often our side sent the control byte `byte`.
fn count(trace: &Trace, byte: u8) -> usize {
    trace
        .writes
        .iter()
        .flatten()
        .filter(|&&b| b == byte)
        .count()
}

/// A retransmission repeats the previous frame byte for byte.
fn retransmitted(trace: &Trace) -> bool {
    frames(trace).windows(2).any(|pair| pair[0] == pair[1])
}

fn batch() -> Vec<OutgoingFile> {
    let mut sub_tail = b"real tail".to_vec();
    sub_tail.extend([SUB; 3]);
    [
        ("empty.bin", Vec::new()),
        ("中文 名.txt", pattern(1000, 21)),
        ("sub-tail.bin", sub_tail),
        ("wrap-70001.bin", pattern(70_001, 22)),
        ("big.bin", pattern(BIG, 23)),
    ]
    .into_iter()
    .map(|(name, data)| OutgoingFile {
        name: name.into(),
        data,
    })
    .collect()
}

fn sorted_names(files: &[OutgoingFile]) -> Vec<String> {
    let mut names: Vec<_> = files.iter().map(|file| file.name.clone()).collect();
    names.sort();
    names
}

fn write_sources(scratch: &Scratch, files: &[OutgoingFile]) {
    for file in files {
        std::fs::write(scratch.path().join(&file.name), &file.data).expect("write source file");
    }
}

fn read(scratch: &Scratch, name: &str) -> Vec<u8> {
    std::fs::read(scratch.path().join(name)).unwrap_or_else(|error| panic!("read {name}: {error}"))
}

fn spawn(program: &Program, args: &[&str], scratch: &Scratch) -> Peer {
    Peer::spawn(program, args, scratch.path())
}

#[test]
#[ignore = "needs lrzsz; run with --ignored"]
fn xmodem_send_to_rx_in_checksum_crc_and_1k_modes() {
    let Some(rx) = require("rx") else { return };
    for check in CHECKS {
        for size in XMODEM_SIZES {
            let label = format!("{check:?} {size} bytes");
            let data = pattern(size, size as u32 + 1);
            let scratch = Scratch::new();
            // `rx` asks for the checksum variant unless given `-c`.
            let args: &[&str] = match check {
                Check::Checksum => &["--binary", "out.bin"],
                _ => &["--with-crc", "--binary", "out.bin"],
            };
            let mut peer = spawn(&rx, args, &scratch);
            let mut tx = match check {
                Check::OneK => Sender::xmodem_1k(data.clone(), Limits::default()),
                _ => Sender::xmodem(data.clone(), Limits::default()),
            }
            .expect("valid sender");
            let trace = transfer(&mut tx, &mut peer);
            let exit = peer.finish();
            assert_eq!(tx.status(), Status::Done, "{label}: {}", exit.stderr);
            assert!(exit.success(), "{label}: {:?} {}", exit.status, exit.stderr);
            assert_eq!(tx.transferred(), size as u64, "{label}");
            assert!(
                read(&scratch, "out.bin") == padded(&data),
                "{label}: content differs"
            );
            let lengths: Vec<usize> = frames(&trace).iter().map(|frame| frame.len()).collect();
            let expected = match check {
                Check::Checksum => vec![3 + SHORT + 1; size.div_ceil(SHORT)],
                Check::Crc => vec![3 + SHORT + 2; size.div_ceil(SHORT)],
                Check::OneK => lengths.clone(),
            };
            assert_eq!(lengths, expected, "{label}: frame lengths");
            if check == Check::OneK {
                let long = lengths.iter().filter(|&&len| len == 3 + LONG + 2).count();
                assert_eq!(
                    long > 0,
                    size > LONG - SHORT,
                    "{label}: 1K frames {lengths:?}"
                );
            }
        }
    }
}

#[test]
#[ignore = "needs lrzsz; run with --ignored"]
fn xmodem_receive_from_sx_in_checksum_crc_and_1k_modes() {
    let Some(sx) = require("sx") else { return };
    for check in CHECKS {
        for size in XMODEM_SIZES {
            let label = format!("{check:?} {size} bytes");
            let data = pattern(size, size as u32 + 7);
            let scratch = Scratch::new();
            std::fs::write(scratch.path().join("in.bin"), &data).expect("write source");
            let args: &[&str] = match check {
                Check::OneK => &["--1k", "in.bin"],
                _ => &["in.bin"],
            };
            let mut peer = spawn(&sx, args, &scratch);
            let limits = match check {
                // Shorter timeouts keep the three ignored `C` requests quick.
                Check::Checksum => QUICK_START,
                _ => Limits::default(),
            };
            let mut rx = Receiver::xmodem(limits);
            // Without our `C` requests the receiver falls back to checksum NAKs.
            let drop_crc_requests = |bytes: Vec<u8>| -> Vec<u8> {
                match check {
                    Check::Checksum => bytes.into_iter().filter(|&b| b != b'C').collect(),
                    _ => bytes,
                }
            };
            let trace = pump(&mut rx, &mut peer, drop_crc_requests, identity, |_, _| {});
            let exit = peer.finish();
            assert_eq!(rx.status(), Status::Done, "{label}: {}", exit.stderr);
            assert!(exit.success(), "{label}: {:?} {}", exit.status, exit.stderr);
            let files = rx.files();
            assert_eq!(files.len(), 1, "{label}");
            assert!(files[0].data == padded(&data), "{label}: content differs");
            // One ACK per data block plus one for EOT.
            let short_blocks = size.div_ceil(SHORT) + 1;
            match check {
                // Like ours, `sx -k` keeps 128-byte blocks for a tail of up to 896 bytes.
                Check::OneK if size > LONG - SHORT => {
                    assert!(count(&trace, ACK) < short_blocks, "{label}: no 1K blocks")
                }
                _ => assert_eq!(count(&trace, ACK), short_blocks, "{label}"),
            }
            // No block was rejected; checksum mode starts with one NAK request.
            let naks = usize::from(check == Check::Checksum);
            assert_eq!(count(&trace, NAK), naks, "{label}: retries");
            if check == Check::Checksum {
                assert!(trace.ticks >= 3 * limits.timeout_ticks, "{label}");
            }
        }
    }
}

#[test]
#[ignore = "needs lrzsz; run with --ignored"]
fn ymodem_batch_send_to_rb_keeps_names_and_exact_bytes() {
    let Some(rb) = require("rb") else { return };
    let files = batch();
    let scratch = Scratch::new();
    let mut peer = spawn(&rb, &[], &scratch);
    let mut tx = Sender::ymodem(files.clone(), Limits::default()).expect("valid sender");
    let trace = transfer(&mut tx, &mut peer);
    let exit = peer.finish();
    assert_eq!(tx.status(), Status::Done, "{}", exit.stderr);
    assert!(exit.success(), "{:?} {}", exit.status, exit.stderr);
    assert!(
        !retransmitted(&trace),
        "a clean pipe needed a retransmission"
    );
    assert_eq!(scratch.file_names(), sorted_names(&files));
    for file in &files {
        assert!(
            read(&scratch, &file.name) == file.data,
            "{} differs",
            file.name
        );
    }
}

#[test]
#[ignore = "needs lrzsz; run with --ignored"]
fn ymodem_batch_receive_from_sb_in_128_and_1k_blocks() {
    let Some(sb) = require("sb") else { return };
    for one_k in [false, true] {
        let files = batch();
        let scratch = Scratch::new();
        write_sources(&scratch, &files);
        let mut args: Vec<&str> = files.iter().map(|file| file.name.as_str()).collect();
        if one_k {
            args.insert(0, "--1k");
        }
        let mut peer = spawn(&sb, &args, &scratch);
        let mut rx = Receiver::ymodem(Limits::default());
        let trace = transfer(&mut rx, &mut peer);
        let exit = peer.finish();
        assert_eq!(rx.status(), Status::Done, "1k={one_k}: {}", exit.stderr);
        assert!(
            exit.success(),
            "1k={one_k}: {:?} {}",
            exit.status,
            exit.stderr
        );
        // The only NAKs are the YMODEM answers to each file's first EOT.
        assert_eq!(count(&trace, NAK), files.len(), "1k={one_k}: retries");
        let want: Vec<ReceivedFile> = files
            .iter()
            .map(|file| ReceivedFile {
                name: Some(file.name.clone()),
                declared_size: Some(file.data.len() as u64),
                data: file.data.clone(),
            })
            .collect();
        assert_eq!(rx.files().len(), want.len(), "1k={one_k}");
        for (got, want) in rx.files().iter().zip(&want) {
            assert!(got == want, "1k={one_k}: {:?} differs", want.name);
        }
        // 1 MB in 128-byte blocks needs ~7800 ACKs; 1K blocks need ~1000.
        let blocks = count(&trace, ACK);
        assert_eq!(blocks < BIG / SHORT, one_k, "1k={one_k}: {blocks} ACKs");
    }
}

/// A sender, a receiver and the lrzsz role each one talks to.
enum Side {
    Send(Sender, &'static str),
    Receive(Receiver, &'static str),
}

fn big_file() -> Vec<OutgoingFile> {
    vec![OutgoingFile {
        name: "big.bin".into(),
        data: pattern(BIG, 31),
    }]
}

/// Every direction and mode used by the interruption tests.
fn sides(limits: Limits) -> Vec<Side> {
    let data = big_file().remove(0).data;
    vec![
        Side::Send(Sender::xmodem_1k(data, limits).expect("sender"), "rx"),
        Side::Send(Sender::ymodem(big_file(), limits).expect("sender"), "rb"),
        Side::Receive(Receiver::xmodem(limits), "sx"),
        Side::Receive(Receiver::ymodem(limits), "sb"),
    ]
}

struct Interrupted {
    label: &'static str,
    status: Status,
    exit: lrzsz::Exit,
    /// Size of the file the lrzsz receiver left behind, if any.
    left_behind: Option<u64>,
    /// Files our receiver reported complete.
    completed: usize,
    /// Real time from the intervention until our machine stopped.
    settle: Duration,
}

/// Runs one side until `act` intervenes mid-transfer, then lets it settle.
fn interrupt(
    side: Side,
    act: impl Fn(&mut dyn lrzsz::Machine, &Peer) + Copy,
) -> Option<Interrupted> {
    let scratch = Scratch::new();
    let mut acted: Option<Instant> = None;
    let mut hook = |progress: u64, machine: &mut dyn lrzsz::Machine, peer: &mut Peer| {
        if acted.is_none() && progress >= MID_TRANSFER {
            acted = Some(Instant::now());
            act(machine, peer);
        }
    };
    let (label, status, exit, completed) = match side {
        Side::Send(mut tx, role) => {
            let program = require(role)?;
            let args: &[&str] = match role {
                "rx" => &["--with-crc", "--binary", "big.bin"],
                _ => &[],
            };
            let mut peer = spawn(&program, args, &scratch);
            pump(&mut tx, &mut peer, identity, identity, |tx, peer| {
                hook(tx.transferred(), tx, peer)
            });
            (role, tx.status(), peer, 0)
        }
        Side::Receive(mut rx, role) => {
            let program = require(role)?;
            write_sources(&scratch, &big_file());
            let mut peer = spawn(&program, &["--1k", "big.bin"], &scratch);
            pump(&mut rx, &mut peer, identity, identity, |rx, peer| {
                hook(rx.transferred(), rx, peer)
            });
            (role, rx.status(), peer, rx.files().len())
        }
    };
    let settle = acted
        .unwrap_or_else(|| panic!("{label}: transfer ended before the intervention"))
        .elapsed();
    let exit = exit.finish();
    let left_behind = match label {
        "rx" | "rb" => std::fs::metadata(scratch.path().join("big.bin"))
            .ok()
            .map(|meta| meta.len()),
        _ => None,
    };
    eprintln!(
        "{label}: ours {status:?} after {settle:?}; peer exit {:?}; peer file {left_behind:?}",
        exit.status
    );
    Some(Interrupted {
        label,
        status,
        exit,
        left_behind,
        completed,
        settle,
    })
}

fn assert_incomplete(run: &Interrupted) {
    assert_eq!(
        run.completed, 0,
        "{}: partial file reported complete",
        run.label
    );
    if let Some(len) = run.left_behind {
        assert!(
            len < BIG as u64,
            "{}: lrzsz kept a complete file",
            run.label
        );
    }
}

#[test]
#[ignore = "needs lrzsz; run with --ignored"]
fn our_can_can_cancel_stops_every_lrzsz_peer() {
    for side in sides(Limits::default()) {
        let Some(run) = interrupt(side, |machine, _| machine.cancel()) else {
            return;
        };
        assert_eq!(
            run.status,
            Status::Failed(Failure::LocalCancel),
            "{}",
            run.label
        );
        // lrzsz exits by itself with an error status once it sees our CANs.
        assert!(
            run.exit.status.is_some(),
            "{}: peer had to be killed",
            run.label
        );
        assert!(!run.exit.success(), "{}: peer reported success", run.label);
        assert_incomplete(&run);
    }
}

#[test]
#[ignore = "needs lrzsz; run with --ignored"]
fn lrzsz_interrupt_sends_can_and_cancels_us() {
    // lrzsz answers SIGINT by sending its CAN sequence before exiting.
    for side in sides(Limits::default()) {
        let Some(run) = interrupt(side, |_, peer| peer.signal("INT")) else {
            return;
        };
        assert_eq!(
            run.status,
            Status::Failed(Failure::RemoteCancel),
            "{}",
            run.label
        );
        assert!(!run.exit.success(), "{}", run.label);
        assert_incomplete(&run);
    }
}

#[test]
#[ignore = "needs lrzsz; run with --ignored"]
fn peer_killed_mid_transfer_fails_within_the_retry_budget() {
    let quick = Limits {
        timeout_ticks: 2,
        max_retries: 3,
        ..Limits::default()
    };
    for side in sides(quick) {
        let Some(run) = interrupt(side, |_, peer| peer.signal("KILL")) else {
            return;
        };
        assert_eq!(
            run.status,
            Status::Failed(Failure::RetriesExhausted),
            "{}",
            run.label
        );
        assert!(!run.exit.success(), "{}", run.label);
        assert_incomplete(&run);
        // (max_retries + 1) timeouts of timeout_ticks each, plus scheduling slack.
        let budget = TICK * (quick.max_retries + 1) * quick.timeout_ticks;
        assert!(
            run.settle < budget + Duration::from_secs(1),
            "{}",
            run.label
        );
    }
}

fn is_block(bytes: &[u8], number: u8) -> bool {
    matches!(bytes, [SOH | STX, block, inverse, ..] if *block == number && *inverse == !number)
}

#[test]
#[ignore = "needs lrzsz; run with --ignored"]
fn corrupted_blocks_are_rejected_and_resent_in_both_directions() {
    // Our sender: the first copy of block 2 is damaged on the way to lrzsz.
    for (role, batch) in [("rx", false), ("rb", true)] {
        let Some(program) = require(role) else { return };
        let scratch = Scratch::new();
        let args: &[&str] = if batch {
            &[]
        } else {
            &["--with-crc", "--binary", "big.bin"]
        };
        let mut peer = spawn(&program, args, &scratch);
        let data = big_file().remove(0).data;
        let mut tx = if batch {
            Sender::ymodem(big_file(), Limits::default())
        } else {
            Sender::xmodem_1k(data.clone(), Limits::default())
        }
        .expect("valid sender");
        // Block numbers wrap every 256 blocks, so only copies sent before the
        // first block 3 are the original and its retransmission.
        let mut copies = 0;
        let mut moved_on = false;
        let damage = |mut bytes: Vec<u8>| {
            moved_on |= is_block(&bytes, 3);
            if !moved_on && is_block(&bytes, 2) {
                copies += 1;
                if copies == 1 {
                    bytes[40] ^= 0x5A;
                }
            }
            bytes
        };
        pump(&mut tx, &mut peer, damage, identity, |_, _| {});
        let exit = peer.finish();
        assert_eq!(tx.status(), Status::Done, "{role}: {}", exit.stderr);
        assert!(exit.success(), "{role}: {:?} {}", exit.status, exit.stderr);
        assert_eq!(copies, 2, "{role}: block 2 resent once");
        let want = if batch { data } else { padded(&data) };
        assert!(read(&scratch, "big.bin") == want, "{role}: content differs");
    }
    // lrzsz sender: one payload byte of its second 1K block is damaged on the way
    // to us (offset 2000 lies inside block 2 after a 1029-byte block 1 or a
    // 133-byte YMODEM header plus block 1).
    for (role, batch) in [("sx", false), ("sb", true)] {
        let Some(program) = require(role) else { return };
        let scratch = Scratch::new();
        write_sources(&scratch, &big_file());
        let mut peer = spawn(&program, &["--1k", "big.bin"], &scratch);
        let mut rx = if batch {
            Receiver::ymodem(Limits::default())
        } else {
            Receiver::xmodem(Limits::default())
        };
        let mut offset = 0;
        let damage = |mut bytes: Vec<u8>| {
            if let Some(byte) = 2000usize
                .checked_sub(offset)
                .and_then(|at| bytes.get_mut(at))
            {
                *byte ^= 0x5A;
            }
            offset += bytes.len();
            bytes
        };
        let trace = pump(&mut rx, &mut peer, identity, damage, |_, _| {});
        let exit = peer.finish();
        assert_eq!(rx.status(), Status::Done, "{role}: {}", exit.stderr);
        assert!(exit.success(), "{role}: {:?} {}", exit.status, exit.stderr);
        // One NAK for the damaged block, plus YMODEM's NAK for the first EOT.
        assert_eq!(count(&trace, NAK), 1 + usize::from(batch), "{role}");
        let data = big_file().remove(0).data;
        let want = if batch { data } else { padded(&data) };
        assert!(rx.files()[0].data == want, "{role}: content differs");
    }
}

#[test]
#[ignore = "needs lrzsz; run with --ignored"]
fn ymodem_receiver_refuses_a_path_sent_by_sb_full_path() {
    let Some(sb) = require("sb") else { return };
    let scratch = Scratch::new();
    std::fs::create_dir(scratch.path().join("sub")).expect("create sub");
    std::fs::write(scratch.path().join("sub/x.bin"), b"payload").expect("write source");
    let mut peer = spawn(&sb, &["--full-path", "sub/x.bin"], &scratch);
    let mut rx = Receiver::ymodem(Limits::default());
    let trace = transfer(&mut rx, &mut peer);
    let exit = peer.finish();
    assert_eq!(rx.status(), Status::Failed(Failure::InvalidFileName));
    assert!(trace.writes.concat().ends_with(&[CAN; 5]), "CAN sent");
    assert!(rx.files().is_empty());
    assert!(
        exit.status.is_some() && !exit.success(),
        "{:?}",
        exit.status
    );
}

#[test]
#[ignore = "needs lrzsz; run with --ignored"]
fn late_lrzsz_senders_reading_queued_requests_stay_in_step() {
    // The peer sleeps while our receiver repeats its start request every
    // 300 ms, then reads them all at once. `sb` resends block 0 for each `C`;
    // `sx` takes the first `C` (CRC) although we have fallen back to NAK, and
    // resends block 1 for each queued NAK. Before the fix, `sb` ran ahead and
    // the batch ended in `SequenceError`, and `sx` exhausted our retries.
    let patient = Limits {
        timeout_ticks: 3,
        max_retries: 30,
        ..Limits::default()
    };
    let files = vec![
        OutgoingFile {
            name: "late-a.bin".into(),
            data: pattern(5000, 41),
        },
        OutgoingFile {
            name: "late-b.bin".into(),
            data: pattern(77, 42),
        },
    ];
    let Some(sb) = require("sb") else { return };
    let scratch = Scratch::new();
    write_sources(&scratch, &files);
    let mut peer = spawn(
        &sb,
        &["--delay-startup", "2", "late-a.bin", "late-b.bin"],
        &scratch,
    );
    let mut rx = Receiver::ymodem(patient);
    let trace = transfer(&mut rx, &mut peer);
    let exit = peer.finish();
    assert_eq!(rx.status(), Status::Done, "sb: {}", exit.stderr);
    assert!(exit.success(), "sb: {:?} {}", exit.status, exit.stderr);
    assert!(count(&trace, b'C') > 3, "sb: requests did not queue up");
    for (got, want) in rx.files().iter().zip(&files) {
        assert!(got.data == want.data, "sb: {} differs", want.name);
    }
    assert_eq!(rx.files().len(), files.len());

    let Some(sx) = require("sx") else { return };
    for one_k in [false, true] {
        let scratch = Scratch::new();
        write_sources(&scratch, &files[..1]);
        let mut args = vec!["--delay-startup", "2", "late-a.bin"];
        if one_k {
            args.insert(0, "--1k");
        }
        let mut peer = spawn(&sx, &args, &scratch);
        let mut rx = Receiver::xmodem(patient);
        let trace = transfer(&mut rx, &mut peer);
        let exit = peer.finish();
        assert_eq!(rx.status(), Status::Done, "sx 1k={one_k}: {}", exit.stderr);
        assert!(
            exit.success(),
            "sx 1k={one_k}: {:?} {}",
            exit.status,
            exit.stderr
        );
        assert!(
            count(&trace, NAK) > 0,
            "sx 1k={one_k}: no checksum fallback"
        );
        assert!(
            rx.files()[0].data == padded(&files[0].data),
            "sx 1k={one_k}: differs"
        );
    }
}

#[test]
#[ignore = "needs lrzsz; run with --ignored"]
fn long_ymodem_name_reaches_rb_in_a_1k_block_0() {
    // 244 bytes of UTF-8 do not fit a 128-byte block 0, so the header goes
    // out as an STX frame. (`sb` 0.13.1 itself refuses names this long.)
    let Some(rb) = require("rb") else { return };
    let name = "名".repeat(80) + ".bin";
    let files = vec![OutgoingFile {
        name: name.clone(),
        data: pattern(3000, 51),
    }];
    let scratch = Scratch::new();
    let mut peer = spawn(&rb, &[], &scratch);
    let mut tx = Sender::ymodem(files.clone(), Limits::default()).expect("valid sender");
    let trace = transfer(&mut tx, &mut peer);
    let exit = peer.finish();
    assert_eq!(tx.status(), Status::Done, "{}", exit.stderr);
    assert!(exit.success(), "{:?} {}", exit.status, exit.stderr);
    assert!(trace
        .writes
        .iter()
        .any(|write| is_block(write, 0) && write[0] == STX));
    assert_eq!(scratch.file_names(), std::slice::from_ref(&name));
    assert!(read(&scratch, &name) == files[0].data, "content differs");
}
