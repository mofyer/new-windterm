//! C04 feasibility probe using the real serialport API against Unix PTYs.
//! This does not validate UART timing, modem lines, USB enumeration or hotplug.
//! Only PTYs allocated by this process are opened; no real device is accessed.
#![cfg(unix)]

use serialport::{DataBits, FlowControl, Parity, SerialPort, StopBits, TTYPort};
use std::{
    io::{ErrorKind, Read, Write},
    sync::Mutex,
    time::{Duration, Instant},
};

// serialport uses ptsname() on macOS; its shared name buffer is not thread-safe.
static PAIR_CREATION: Mutex<()> = Mutex::new(());

fn pair() -> (TTYPort, Box<dyn SerialPort>) {
    let guard = PAIR_CREATION.lock().expect("serialize PTY allocation");
    let (mut master, slave) = TTYPort::pair().expect("allocate private PTY pair");
    let path = slave.name().expect("PTY slave path");
    drop(guard);
    drop(slave);
    // macOS PTYs reject the IOSSIOSPEED ioctl used for nonzero baud rates.
    // Zero bypasses that ioctl; it is not a baud-rate validation or UART setting.
    let slave = serialport::new(path, 0)
        .data_bits(DataBits::Eight)
        .parity(Parity::None)
        .stop_bits(StopBits::One)
        .flow_control(FlowControl::None)
        .timeout(Duration::from_millis(250))
        .open()
        .expect("open our PTY slave through the public serial builder");
    master.set_timeout(Duration::from_millis(250)).unwrap();
    (master, slave)
}

#[test]
fn serial_api_transfers_all_bytes_both_directions() {
    let (mut master, mut slave) = pair();
    let payload: Vec<u8> = (0..=255).collect();
    let mut received = vec![0; payload.len()];

    master.write_all(&payload).unwrap();
    slave.read_exact(&mut received).unwrap();
    assert_eq!(received, payload, "master to serial API");

    received.fill(0);
    slave.write_all(&payload).unwrap();
    master.read_exact(&mut received).unwrap();
    assert_eq!(received, payload, "serial API to master");
}

#[test]
fn serial_api_reads_back_pty_configuration() {
    let (_master, mut slave) = pair();
    assert_eq!(slave.data_bits().unwrap(), DataBits::Eight);
    assert_eq!(slave.parity().unwrap(), Parity::None);
    assert_eq!(slave.stop_bits().unwrap(), StopBits::One);
    assert_eq!(slave.flow_control().unwrap(), FlowControl::None);
    let timeout = Duration::from_millis(80);
    slave.set_timeout(timeout).unwrap();
    assert_eq!(slave.timeout(), timeout);
}

#[test]
fn serial_api_timeout_then_successful_read() {
    let (mut master, mut slave) = pair();
    slave.set_timeout(Duration::from_millis(80)).unwrap();
    let started = Instant::now();
    let error = slave.read(&mut [0]).unwrap_err();
    assert_eq!(error.kind(), ErrorKind::TimedOut);
    assert!(started.elapsed() < Duration::from_secs(5));

    master.write_all(b"ok").unwrap();
    let mut received = [0; 2];
    slave.read_exact(&mut received).unwrap();
    assert_eq!(&received, b"ok");
}

#[test]
fn serial_api_reports_pty_peer_close() {
    let (master, mut slave) = pair();
    drop(master);
    let error = slave.read(&mut [0]).unwrap_err();
    assert_eq!(error.kind(), ErrorKind::BrokenPipe);
}
