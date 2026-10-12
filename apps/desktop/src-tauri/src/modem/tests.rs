//! Loopback and fault-injection tests for the sans-IO X/YMODEM machines.
use super::*;
use std::convert::identity;

const SIZES: [usize; 7] = [0, 1, 127, 128, 1024, 1025, 70_000];
const MAX_STEPS: usize = 100_000;

#[derive(Debug, Clone, Copy)]
enum Mode {
    Xmodem,
    Xmodem1k,
    Ymodem,
}
const MODES: [Mode; 3] = [Mode::Xmodem, Mode::Xmodem1k, Mode::Ymodem];

#[derive(Debug, Clone, Copy)]
enum Delivery {
    Bulk,
    ByteByByte,
}

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

fn padded(data: &[u8]) -> Vec<u8> {
    let mut bytes = data.to_vec();
    bytes.resize(data.len().div_ceil(SHORT_BLOCK) * SHORT_BLOCK, SUB);
    bytes
}

fn one(name: &str, data: Vec<u8>) -> Vec<OutgoingFile> {
    vec![OutgoingFile {
        name: name.into(),
        data,
    }]
}

fn two(size: usize) -> Vec<OutgoingFile> {
    vec![
        OutgoingFile {
            name: format!("alpha-{size}.bin"),
            data: pattern(size, 1),
        },
        OutgoingFile {
            name: format!("中文 名-{size}.txt"),
            data: pattern(size, 2),
        },
    ]
}

fn pair(mode: Mode, mut files: Vec<OutgoingFile>) -> (Sender, Receiver) {
    let limits = Limits::default();
    let sender = match mode {
        Mode::Xmodem => Sender::xmodem(files.remove(0).data, limits),
        Mode::Xmodem1k => Sender::xmodem_1k(files.remove(0).data, limits),
        Mode::Ymodem => Sender::ymodem(files, limits),
    };
    let receiver = match mode {
        Mode::Ymodem => Receiver::ymodem(limits),
        _ => Receiver::xmodem(limits),
    };
    (sender.expect("valid sender"), receiver)
}

/// What the receiver must hold: exact YMODEM files, padded XMODEM data.
fn expected(mode: Mode, files: &[OutgoingFile]) -> Vec<ReceivedFile> {
    match mode {
        Mode::Ymodem => files
            .iter()
            .map(|file| ReceivedFile {
                name: Some(file.name.clone()),
                declared_size: Some(file.data.len() as u64),
                data: file.data.clone(),
            })
            .collect(),
        _ => vec![ReceivedFile {
            name: None,
            declared_size: None,
            data: padded(&files[0].data),
        }],
    }
}

fn deliver(bytes: &[u8], delivery: Delivery, mut feed: impl FnMut(&[u8])) {
    match delivery {
        Delivery::Bulk => feed(bytes),
        Delivery::ByteByByte => bytes.chunks(1).for_each(feed),
    }
}

/// Full-duplex loopback; ticks both sides only while nothing is in flight.
fn run(
    tx: &mut Sender,
    rx: &mut Receiver,
    delivery: Delivery,
    mut to_rx: impl FnMut(Vec<u8>) -> Vec<u8>,
    mut to_tx: impl FnMut(Vec<u8>) -> Vec<u8>,
) -> u32 {
    let mut ticks = 0;
    for _ in 0..MAX_STEPS {
        let forward = to_rx(tx.take_output());
        let backward = to_tx(rx.take_output());
        if forward.is_empty() && backward.is_empty() {
            if tx.status() != Status::Running && rx.status() != Status::Running {
                return ticks;
            }
            tx.tick();
            rx.tick();
            ticks += 1;
            continue;
        }
        deliver(&forward, delivery, |bytes| rx.feed(bytes));
        deliver(&backward, delivery, |bytes| tx.feed(bytes));
    }
    panic!("transfer did not settle within {MAX_STEPS} steps");
}

fn assert_done(mode: Mode, tx: &Sender, rx: &Receiver, want: &[ReceivedFile]) {
    assert_eq!(tx.status(), Status::Done, "{mode:?} sender");
    assert_eq!(rx.status(), Status::Done, "{mode:?} receiver");
    assert!(rx.files() == want, "{mode:?} received files differ");
}

/// Runs a clean transfer, checks the result, and returns every sender write.
fn roundtrip(mode: Mode, files: Vec<OutgoingFile>, delivery: Delivery) -> Vec<Vec<u8>> {
    let want = expected(mode, &files);
    let sent: u64 = match mode {
        Mode::Ymodem => files.iter().map(|file| file.data.len() as u64).sum(),
        _ => files[0].data.len() as u64,
    };
    let (mut tx, mut rx) = pair(mode, files);
    let mut writes = Vec::new();
    let ticks = run(
        &mut tx,
        &mut rx,
        delivery,
        |bytes| {
            writes.push(bytes.clone());
            bytes
        },
        identity,
    );
    assert_done(mode, &tx, &rx, &want);
    assert_eq!(ticks, 0, "{mode:?} clean transfer needed a timeout");
    assert_eq!(tx.transferred(), sent);
    writes
}

fn is_block(bytes: &[u8], number: u8) -> bool {
    matches!(bytes, [SOH | STX, block, inverse, ..] if *block == number && *inverse == !number)
}

fn is_frame(bytes: &[u8]) -> bool {
    matches!(bytes, [SOH | STX, block, inverse, ..] if *block == !*inverse)
}

fn drop_nth(target: u8, nth: usize) -> impl FnMut(Vec<u8>) -> Vec<u8> {
    let mut seen = 0;
    move |bytes| {
        bytes
            .into_iter()
            .filter(|&byte| {
                if byte != target {
                    return true;
                }
                seen += 1;
                seen != nth
            })
            .collect()
    }
}

/// Exchanges a few rounds by hand so a test can intervene mid-transfer.
fn exchange(tx: &mut Sender, rx: &mut Receiver, rounds: usize) {
    for _ in 0..rounds {
        rx.feed(&tx.take_output());
        tx.feed(&rx.take_output());
    }
}

#[test]
fn crc_and_checksum_match_reference_values() {
    assert_eq!(crc16(b"123456789"), 0x31C3);
    assert_eq!(crc16(b""), 0);
    assert_eq!(checksum(b"123456789"), 0xDD);
    let block = build_frame(1, b"abc", SHORT_BLOCK, SUB, true);
    assert_eq!(block.len(), 3 + SHORT_BLOCK + 2);
    assert_eq!(&block[..6], &[SOH, 1, 0xFE, b'a', b'b', b'c']);
    assert_eq!(block[6], SUB);
}

#[test]
fn xmodem_crc_loopback_keeps_data_with_sub_padding() {
    for size in SIZES {
        let writes = roundtrip(Mode::Xmodem, one("", pattern(size, 3)), Delivery::Bulk);
        let frames = writes.iter().filter(|write| write.first() == Some(&SOH));
        assert!(frames
            .clone()
            .all(|write| write.len() == 3 + SHORT_BLOCK + 2));
        assert_eq!(frames.count(), size.div_ceil(SHORT_BLOCK), "size {size}");
    }
}

#[test]
fn xmodem_1k_loopback_uses_long_blocks_and_keeps_padding() {
    for size in SIZES {
        let writes = roundtrip(Mode::Xmodem1k, one("", pattern(size, 4)), Delivery::Bulk);
        let long = writes
            .iter()
            .filter(|write| write.first() == Some(&STX))
            .count();
        assert_eq!(long > 0, size > LONG_BLOCK - SHORT_BLOCK, "size {size}");
    }
}

#[test]
fn ymodem_batch_loopback_restores_two_files_exactly() {
    for size in SIZES {
        let writes = roundtrip(Mode::Ymodem, two(size), Delivery::Bulk);
        // Two headers plus the empty end-of-batch block 0.
        assert_eq!(writes.iter().filter(|write| is_block(write, 0)).count(), 3);
    }
}

#[test]
fn long_ymodem_header_uses_a_1k_block_0() {
    let name = "长".repeat(MAX_NAME_BYTES / 3);
    let writes = roundtrip(Mode::Ymodem, one(&name, pattern(10, 13)), Delivery::Bulk);
    let header = writes
        .iter()
        .find(|write| is_block(write, 0))
        .expect("header");
    assert_eq!(header.len(), 3 + LONG_BLOCK + 2);
    assert_eq!(header[0], STX);
}

#[test]
fn byte_by_byte_delivery_matches_bulk_results() {
    for mode in MODES {
        for size in SIZES {
            roundtrip(mode, two(size), Delivery::ByteByByte);
        }
    }
}

#[test]
fn ymodem_size_trims_padding_but_keeps_real_trailing_sub_bytes() {
    let mut data = b"tail".to_vec();
    data.extend([SUB; 3]);
    roundtrip(Mode::Ymodem, one("sub.bin", data.clone()), Delivery::Bulk);
    // XMODEM has no length: a file ending in SUB and one without arrive identical.
    let received = |data: &[u8]| {
        let (mut tx, mut rx) = pair(Mode::Xmodem, one("", data.to_vec()));
        run(&mut tx, &mut rx, Delivery::Bulk, identity, identity);
        rx.files()[0].data.clone()
    };
    assert_eq!(received(&data), received(b"tail"));
}

#[test]
fn checksum_fallback_when_crc_requests_are_ignored() {
    for mode in [Mode::Xmodem, Mode::Xmodem1k] {
        let files = one("", pattern(1025, 5));
        let want = expected(mode, &files);
        let (mut tx, mut rx) = pair(mode, files);
        let mut writes = Vec::new();
        let ignore_crc = |bytes: Vec<u8>| bytes.into_iter().filter(|&b| b != b'C').collect();
        let ticks = run(
            &mut tx,
            &mut rx,
            Delivery::Bulk,
            |bytes| {
                writes.push(bytes.clone());
                bytes
            },
            ignore_crc,
        );
        assert_done(mode, &tx, &rx, &want);
        assert!(ticks >= CRC_ATTEMPTS * Limits::default().timeout_ticks);
        let frames: Vec<_> = writes.iter().filter(|w| is_frame(w)).collect();
        assert_eq!(frames.len(), 9, "{mode:?}: 1025 bytes in 128-byte blocks");
        assert!(frames
            .iter()
            .all(|w| w[0] == SOH && w.len() == 3 + SHORT_BLOCK + 1));
    }
}

#[test]
fn corrupted_block_is_retransmitted_and_data_stays_exact() {
    for mode in MODES {
        let files = one("corrupt.bin", pattern(5000, 6));
        let want = expected(mode, &files);
        let (mut tx, mut rx) = pair(mode, files);
        let mut copies = 0;
        let corrupt_first_copy = |mut bytes: Vec<u8>| {
            if is_block(&bytes, 2) {
                copies += 1;
                if copies == 1 {
                    bytes[40] ^= 0x5A;
                }
            }
            bytes
        };
        run(
            &mut tx,
            &mut rx,
            Delivery::Bulk,
            corrupt_first_copy,
            identity,
        );
        assert_done(mode, &tx, &rx, &want);
        assert_eq!(copies, 2, "{mode:?}: block 2 sent twice");
    }
}

#[test]
fn dropped_ack_is_recovered_without_duplicating_data() {
    // ACK 1 is the YMODEM header ACK; ACK 3 confirms a data block. Recovery
    // always waits for the receiver's timeout (NAK, or `C` before data).
    for (mode, nth) in [
        (Mode::Xmodem, 3),
        (Mode::Xmodem1k, 3),
        (Mode::Ymodem, 1),
        (Mode::Ymodem, 3),
    ] {
        let files = one("ack.bin", pattern(5000, 7));
        let want = expected(mode, &files);
        let (mut tx, mut rx) = pair(mode, files);
        let ticks = run(
            &mut tx,
            &mut rx,
            Delivery::Bulk,
            identity,
            drop_nth(ACK, nth),
        );
        assert_done(mode, &tx, &rx, &want);
        assert!(ticks >= Limits::default().timeout_ticks, "{mode:?}");
    }
}

#[test]
fn sender_cancel_aborts_receiver_with_can_can() {
    let (mut tx, mut rx) = pair(Mode::Ymodem, two(70_000));
    exchange(&mut tx, &mut rx, 20);
    assert_eq!(
        (tx.status(), rx.status()),
        (Status::Running, Status::Running)
    );
    assert!(rx.transferred() > 0);
    tx.cancel();
    let output = tx.take_output();
    assert!(output.ends_with(&ABORT));
    rx.feed(&output);
    assert_eq!(tx.status(), Status::Failed(Failure::LocalCancel));
    assert_eq!(rx.status(), Status::Failed(Failure::RemoteCancel));
    assert!(!rx.take_output().contains(&CAN), "no CAN echoed back");
    assert!(rx.files().is_empty());
}

#[test]
fn receiver_cancel_aborts_sender_with_can_can() {
    let (mut tx, mut rx) = pair(Mode::Xmodem1k, one("", pattern(70_000, 8)));
    exchange(&mut tx, &mut rx, 20);
    rx.cancel();
    tx.feed(&rx.take_output());
    assert_eq!(rx.status(), Status::Failed(Failure::LocalCancel));
    assert_eq!(tx.status(), Status::Failed(Failure::RemoteCancel));
    assert!((1..70_000).contains(&tx.transferred()));
    // A cancelled machine ignores further input and ticks.
    tx.take_output();
    tx.feed(&[ACK]);
    tx.tick();
    assert!(tx.take_output().is_empty());
}

#[test]
fn lone_can_is_treated_as_line_noise() {
    let files = one("", pattern(1000, 9));
    let want = expected(Mode::Xmodem, &files);
    let (mut tx, mut rx) = pair(Mode::Xmodem, files);
    let (mut forward, mut backward) = (0, 0);
    let noisy = |count: &mut i32, mut bytes: Vec<u8>| {
        if !bytes.is_empty() {
            *count += 1;
            if *count == 3 {
                bytes.insert(0, CAN);
            }
        }
        bytes
    };
    run(
        &mut tx,
        &mut rx,
        Delivery::Bulk,
        |bytes| noisy(&mut forward, bytes),
        |bytes| noisy(&mut backward, bytes),
    );
    assert_done(Mode::Xmodem, &tx, &rx, &want);
}

#[test]
fn silent_peer_exhausts_bounded_retries() {
    let limits = Limits::default();
    let mut tx = Sender::xmodem(vec![1, 2, 3], limits).expect("valid sender");
    let mut ticks = 0;
    while tx.status() == Status::Running {
        tx.tick();
        ticks += 1;
    }
    assert_eq!(tx.status(), Status::Failed(Failure::RetriesExhausted));
    assert_eq!(ticks, (limits.max_retries + 1) * limits.timeout_ticks);
    assert_eq!(tx.take_output(), ABORT);

    let mut rx = Receiver::xmodem(limits);
    let mut requests = rx.take_output();
    while rx.status() == Status::Running {
        rx.tick();
        requests.extend(rx.take_output());
    }
    assert_eq!(rx.status(), Status::Failed(Failure::RetriesExhausted));
    // `C` requests first, then checksum NAKs, then the CAN abort.
    let crc_requests = requests.iter().filter(|&&b| b == CRC_REQUEST).count();
    assert_eq!(crc_requests, CRC_ATTEMPTS as usize);
    assert_eq!(requests[CRC_ATTEMPTS as usize], NAK);
    assert!(requests.ends_with(&ABORT));
}

#[test]
fn persistent_corruption_aborts_after_bounded_retries() {
    let (mut tx, mut rx) = pair(Mode::Xmodem, one("", pattern(1000, 10)));
    let corrupt_every_copy = |mut bytes: Vec<u8>| {
        if is_block(&bytes, 2) {
            bytes[10] ^= 1;
        }
        bytes
    };
    run(
        &mut tx,
        &mut rx,
        Delivery::Bulk,
        corrupt_every_copy,
        identity,
    );
    assert_eq!(rx.status(), Status::Failed(Failure::RetriesExhausted));
    assert_eq!(tx.status(), Status::Failed(Failure::RemoteCancel));
    assert!(rx.files().is_empty());
}

#[test]
fn file_names_are_validated_on_both_sides() {
    let long = "n".repeat(MAX_NAME_BYTES + 1);
    for good in ["a.txt", "中文 名.bin", "a.b.c", ".profile"] {
        assert_eq!(validate_file_name(good), Ok(()), "{good}");
    }
    for bad in [
        "",
        ".",
        "..",
        "../x",
        "a/b",
        "/etc",
        "a\\b",
        "a\0b",
        "x..y",
        "a\nb",
        long.as_str(),
    ] {
        assert_eq!(
            validate_file_name(bad),
            Err(Failure::InvalidFileName),
            "{bad:?}"
        );
    }
    let limits = Limits::default();
    let refused = Sender::ymodem(one("../x", vec![1]), limits);
    assert_eq!(refused.err(), Some(Failure::InvalidFileName));

    for header in [
        &b"../etc/passwd\x005"[..],
        &b"a/b\x001"[..],
        &b"\xff\xfe\x001"[..],
    ] {
        let mut rx = Receiver::ymodem(limits);
        rx.take_output();
        rx.feed(&build_frame(0, header, SHORT_BLOCK, 0, true));
        assert_eq!(rx.status(), Status::Failed(Failure::InvalidFileName));
        assert!(rx.take_output().ends_with(&ABORT));
        assert!(rx.files().is_empty());
    }
}

#[test]
fn malformed_headers_and_wrong_block_numbers_abort() {
    let limits = Limits::default();
    for header in [&b"a.bin\x00-5"[..], &b"a.bin\x0099999999999999999999"[..]] {
        let mut rx = Receiver::ymodem(limits);
        rx.feed(&build_frame(0, header, SHORT_BLOCK, 0, true));
        assert_eq!(rx.status(), Status::Failed(Failure::InvalidHeader));
    }
    let mut rx = Receiver::ymodem(limits);
    rx.feed(&build_frame(0, &[b'a'; SHORT_BLOCK], SHORT_BLOCK, 0, true));
    assert_eq!(rx.status(), Status::Failed(Failure::InvalidHeader));

    let mut rx = Receiver::xmodem(limits);
    rx.take_output();
    rx.feed(&build_frame(3, &[1; SHORT_BLOCK], SHORT_BLOCK, SUB, true));
    assert_eq!(rx.status(), Status::Failed(Failure::SequenceError));
    assert!(rx.take_output().ends_with(&ABORT));
}

#[test]
fn size_and_count_limits_are_enforced() {
    let small = Limits {
        max_file_bytes: 1000,
        max_files: 1,
        ..Limits::default()
    };
    let big = Sender::xmodem(vec![0; 1001], small);
    assert_eq!(big.err(), Some(Failure::FileTooLarge));
    assert_eq!(
        Sender::ymodem(two(1), small).err(),
        Some(Failure::TooManyFiles)
    );

    let mut rx = Receiver::ymodem(small);
    rx.feed(&build_frame(0, b"big.bin\x001001", SHORT_BLOCK, 0, true));
    assert_eq!(rx.status(), Status::Failed(Failure::FileTooLarge));

    // A stream without a declared size is cut off once it outgrows the limit.
    let mut tx = Sender::xmodem(vec![7; 2000], Limits::default()).expect("valid sender");
    let mut rx = Receiver::xmodem(small);
    run(&mut tx, &mut rx, Delivery::Bulk, identity, identity);
    assert_eq!(rx.status(), Status::Failed(Failure::FileTooLarge));
    assert_eq!(tx.status(), Status::Failed(Failure::RemoteCancel));

    let mut tx = Sender::ymodem(two(10), Limits::default()).expect("valid sender");
    let mut rx = Receiver::ymodem(small);
    run(&mut tx, &mut rx, Delivery::Bulk, identity, identity);
    assert_eq!(rx.status(), Status::Failed(Failure::TooManyFiles));
    assert_eq!(rx.files().len(), 1);

    let capped = Limits {
        max_total_bytes: 1500,
        ..Limits::default()
    };
    let batch = Sender::ymodem(two(1000), capped);
    assert_eq!(batch.err(), Some(Failure::BatchTooLarge));
    let mut tx = Sender::ymodem(two(1000), Limits::default()).expect("valid sender");
    let mut rx = Receiver::ymodem(capped);
    run(&mut tx, &mut rx, Delivery::Bulk, identity, identity);
    assert_eq!(rx.status(), Status::Failed(Failure::BatchTooLarge));
    assert_eq!(rx.files().len(), 1);
}

#[test]
fn ymodem_receiver_confirms_eot_twice_and_rejects_short_files() {
    let mut rx = Receiver::ymodem(Limits::default());
    assert_eq!(rx.take_output(), [CRC_REQUEST]);
    rx.feed(&build_frame(0, b"empty.txt\x000", SHORT_BLOCK, 0, true));
    assert_eq!(rx.take_output(), [ACK, CRC_REQUEST]);
    rx.feed(&[EOT]);
    assert_eq!(rx.take_output(), [NAK]);
    rx.feed(&[EOT]);
    assert_eq!(rx.take_output(), [ACK, CRC_REQUEST]);
    // A repeated EOT (our ACK was lost) is confirmed again.
    rx.feed(&[EOT]);
    assert_eq!(rx.take_output(), [ACK, CRC_REQUEST]);
    rx.feed(&build_frame(0, &[], SHORT_BLOCK, 0, true));
    assert_eq!(rx.take_output(), [ACK]);
    assert_eq!(rx.status(), Status::Done);
    assert_eq!(rx.files()[0].name.as_deref(), Some("empty.txt"));
    assert!(rx.files()[0].data.is_empty());

    let mut rx = Receiver::ymodem(Limits::default());
    rx.feed(&build_frame(0, b"short.bin\x00200", SHORT_BLOCK, 0, true));
    rx.feed(&build_frame(1, &[9; 100], SHORT_BLOCK, SUB, true));
    rx.feed(&[EOT, EOT]);
    assert_eq!(rx.status(), Status::Failed(Failure::SizeMismatch));
    assert!(rx.files().is_empty());
}

#[test]
fn stale_reply_in_the_same_read_is_ignored_after_a_retransmit() {
    let mut tx = Sender::xmodem(pattern(300, 11), Limits::default()).expect("valid sender");
    tx.feed(&[CRC_REQUEST]);
    let first = tx.take_output();
    assert!(is_block(&first, 1));
    // The ACK was sent before the peer could see the retransmission it asked for.
    tx.feed(&[NAK, ACK]);
    assert_eq!(tx.take_output(), first);
    assert_eq!(tx.transferred(), 0);
    tx.feed(&[ACK]);
    assert!(is_block(&tx.take_output(), 2));
    assert_eq!(tx.transferred(), SHORT_BLOCK as u64);
}

#[test]
fn lost_final_ack_is_reported_by_the_sender_not_hidden() {
    for mode in [Mode::Xmodem, Mode::Ymodem] {
        let files = one("last.bin", pattern(1000, 12));
        let want = expected(mode, &files);
        let (mut tx, mut rx) = pair(mode, files.clone());
        let mut acks = 0;
        let count_acks = |bytes: Vec<u8>| {
            acks += bytes.iter().filter(|&&b| b == ACK).count();
            bytes
        };
        run(&mut tx, &mut rx, Delivery::Bulk, identity, count_acks);
        let (mut tx, mut rx) = pair(mode, files);
        run(
            &mut tx,
            &mut rx,
            Delivery::Bulk,
            identity,
            drop_nth(ACK, acks),
        );
        // The receiver already holds the complete file; the sender cannot know.
        assert_eq!(rx.status(), Status::Done, "{mode:?}");
        assert!(rx.files() == want, "{mode:?}");
        assert_eq!(tx.status(), Status::Failed(Failure::RetriesExhausted));
    }
}

#[test]
fn stale_start_request_does_not_duplicate_the_first_block() {
    let mut tx = Sender::xmodem(pattern(300, 14), Limits::default()).expect("valid sender");
    tx.feed(&[CRC_REQUEST]);
    let first = tx.take_output();
    // A second `C` that crossed block 1 in flight must not resend it.
    tx.feed(&[CRC_REQUEST]);
    assert!(tx.take_output().is_empty());
    // A `C` after time has passed means block 1 was lost.
    tx.tick();
    tx.feed(&[CRC_REQUEST]);
    assert_eq!(tx.take_output(), first);
}

#[test]
fn crc_mode_is_kept_once_the_sender_has_answered() {
    let files = one("", pattern(1000, 15));
    let want = expected(Mode::Xmodem, &files);
    let (mut tx, mut rx) = pair(Mode::Xmodem, files);
    let mut copies = 0;
    let mut frames = Vec::new();
    // Block 1 is corrupted three times, then lost, so the receiver also times out.
    let faulty = |mut bytes: Vec<u8>| {
        if is_block(&bytes, 1) {
            copies += 1;
            match copies {
                1..=3 => bytes[40] ^= 0x5A,
                4 => bytes.clear(),
                _ => {}
            }
        }
        if is_frame(&bytes) {
            frames.push(bytes.len());
        }
        bytes
    };
    let ticks = run(&mut tx, &mut rx, Delivery::Bulk, faulty, identity);
    assert_done(Mode::Xmodem, &tx, &rx, &want);
    assert!(ticks >= Limits::default().timeout_ticks);
    assert!(frames.iter().all(|&len| len == 3 + SHORT_BLOCK + 2));
}

/// Times the receiver out `count` times so it repeats its start request.
fn time_out(rx: &mut Receiver, count: u32) {
    for _ in 0..count * Limits::default().timeout_ticks {
        rx.tick();
    }
}

#[test]
fn surplus_start_requests_do_not_ack_echoed_first_blocks() {
    // Found with `sb --delay-startup`: a late sender reads all our queued `C`s
    // and resends block 0 for each; ACKing every copy made it run ahead and
    // send EOT and the next header before we had confirmed the last block.
    let mut rx = Receiver::ymodem(Limits::default());
    time_out(&mut rx, 2);
    assert_eq!(rx.take_output(), [CRC_REQUEST; 3]);
    let header = build_frame(0, b"late.bin\x00100", SHORT_BLOCK, 0, true);
    rx.feed(&header.repeat(3));
    assert_eq!(rx.take_output(), [ACK, CRC_REQUEST]);
    let block = build_frame(1, &[7; 100], SHORT_BLOCK, SUB, true);
    rx.feed(&block);
    assert_eq!(rx.take_output(), [ACK]);
    // With no surplus request outstanding, a copy still means our ACK was lost.
    rx.feed(&block);
    assert_eq!(rx.take_output(), [ACK]);
    rx.feed(&[EOT, EOT]);
    rx.feed(&build_frame(0, &[], SHORT_BLOCK, 0, true));
    assert_eq!(rx.status(), Status::Done);
    assert_eq!(rx.files()[0].data, [7; 100]);

    // XMODEM: the same echo of block 1 is dropped once per surplus request.
    let mut rx = Receiver::xmodem(Limits::default());
    time_out(&mut rx, 1);
    assert_eq!(rx.take_output(), [CRC_REQUEST; 2]);
    let first = build_frame(1, &[1; 128], SHORT_BLOCK, SUB, true);
    rx.feed(&first.repeat(2));
    assert_eq!(rx.take_output(), [ACK]);
    rx.feed(&first);
    assert_eq!(
        rx.take_output(),
        [ACK],
        "a third copy is a lost-ACK duplicate"
    );

    // Echoes arrive right behind the new block; after a timeout a copy is a
    // lost-ACK duplicate again, however many requests went unanswered.
    let mut rx = Receiver::xmodem(Limits::default());
    time_out(&mut rx, 2);
    assert_eq!(rx.take_output(), [CRC_REQUEST; 3]);
    rx.feed(&first);
    assert_eq!(rx.take_output(), [ACK]);
    time_out(&mut rx, 1);
    assert_eq!(rx.take_output(), [NAK]);
    rx.feed(&first);
    assert_eq!(
        rx.take_output(),
        [ACK],
        "the timeout cleared the echo budget"
    );
    rx.feed(&[EOT]);
    assert_eq!(rx.status(), Status::Done);
    assert_eq!(rx.files()[0].data, [1; 128]);
}

#[test]
fn crc_frame_after_the_checksum_fallback_is_accepted() {
    // Found with `sx --delay-startup`: the sender read our first `C` only
    // after we had fallen back to NAK, so its frames carry a CRC.
    let mut rx = Receiver::xmodem(Limits::default());
    time_out(&mut rx, CRC_ATTEMPTS);
    assert_eq!(
        rx.take_output(),
        [CRC_REQUEST, CRC_REQUEST, CRC_REQUEST, NAK]
    );
    let first = build_frame(1, &[3; 128], SHORT_BLOCK, SUB, true);
    rx.feed(&first[..first.len() - 1]);
    assert!(
        rx.take_output().is_empty(),
        "131 + 1 bytes may still be CRC"
    );
    rx.feed(&first[first.len() - 1..]);
    assert_eq!(rx.take_output(), [ACK]);
    // The sender also answered our NAKs with copies: they are echoes.
    rx.feed(&first.repeat(3));
    assert!(rx.take_output().is_empty());
    rx.feed(&build_frame(2, &[4; 5], SHORT_BLOCK, SUB, true));
    assert_eq!(rx.take_output(), [ACK], "CRC is kept for later blocks");
    rx.feed(&[EOT]);
    assert_eq!(rx.status(), Status::Done);
    assert_eq!(
        rx.files()[0].data,
        padded(&[[3; 128].as_slice(), &[4; 5]].concat())
    );

    // A corrupt checksum frame now waits for the probe byte, then times out.
    let mut rx = Receiver::xmodem(Limits::default());
    time_out(&mut rx, CRC_ATTEMPTS);
    rx.take_output();
    let mut bad = build_frame(1, &[5; 128], SHORT_BLOCK, SUB, false);
    bad[40] ^= 0x5A;
    rx.feed(&bad);
    assert!(rx.take_output().is_empty());
    time_out(&mut rx, 1);
    assert_eq!(rx.take_output(), [NAK]);
    rx.feed(&build_frame(1, &[5; 128], SHORT_BLOCK, SUB, false));
    assert_eq!(
        rx.take_output(),
        [ACK],
        "checksum still works after a failed probe"
    );
}
