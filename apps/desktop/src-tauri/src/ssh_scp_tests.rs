//! SCP protocol tests against a scripted channel, grant gating without a
//! network, and the ignored run against the isolated OpenSSH fixture
//! (tests/fixtures/ssh-sftp/rust-client.test.mjs).
use super::*;
use crate::ssh::{Credential, Request};
use std::{
    collections::VecDeque,
    sync::{Arc, Mutex},
};

fn id() -> String {
    uuid::Uuid::new_v4().to_string()
}

/// Replays server messages in order and records what the client sent.
#[derive(Clone, Default)]
struct Script {
    incoming: Arc<Mutex<VecDeque<ChannelMsg>>>,
    sent: Arc<Mutex<Vec<u8>>>,
    eof: Arc<Mutex<bool>>,
    /// Sends after this many succeed fail, as on a channel the server closed.
    sends_left: Arc<Mutex<Option<usize>>>,
}

impl Script {
    fn new(messages: Vec<ChannelMsg>) -> Self {
        let script = Self::default();
        *script.incoming.lock().unwrap() = messages.into();
        script
    }

    fn sent(&self) -> Vec<u8> {
        self.sent.lock().unwrap().clone()
    }
}

impl Wire for Script {
    async fn recv(&mut self) -> Option<ChannelMsg> {
        self.incoming.lock().unwrap().pop_front()
    }

    async fn send(&mut self, bytes: &[u8]) -> Result<(), String> {
        if let Some(left) = self.sends_left.lock().unwrap().as_mut() {
            if *left == 0 {
                return Err(SEND_FAILED.into());
            }
            *left -= 1;
        }
        self.sent.lock().unwrap().extend_from_slice(bytes);
        Ok(())
    }

    async fn eof(&mut self) -> Result<(), String> {
        *self.eof.lock().unwrap() = true;
        Ok(())
    }
}

impl Sink for Vec<u8> {
    fn write(&mut self, bytes: &[u8]) -> Result<(), String> {
        self.extend_from_slice(bytes);
        Ok(())
    }
}

fn data(bytes: &[u8]) -> ChannelMsg {
    ChannelMsg::Data {
        data: bytes.to_vec().into(),
    }
}

fn exit(code: u32) -> ChannelMsg {
    ChannelMsg::ExitStatus { exit_status: code }
}

type Seen = Arc<Mutex<Vec<(u64, u64)>>>;

fn recorder() -> (Progress, Seen) {
    let seen: Seen = Arc::default();
    let record = seen.clone();
    let progress: Progress =
        Arc::new(move |done, total| record.lock().unwrap().push((done, total)));
    (progress, seen)
}

/// A private, empty download folder removed when dropped.
struct Folder(PathBuf);

impl Folder {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("p0-scp-{}", &id()[..8]));
        std::fs::create_dir(&path).unwrap();
        Self(path)
    }

    fn names(&self) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(&self.0)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }
}

impl Drop for Folder {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[test]
fn quoting_and_names_are_strict() {
    assert_eq!(quote("/tmp/a b"), "'/tmp/a b'");
    assert_eq!(quote("it's"), "'it'\\''s'");
    assert!(valid_name("中文 file.bin"));
    for bad in ["", ".", "..", "a/b", "a\nb", "a\0b"] {
        assert!(!valid_name(bad), "{bad:?}");
    }
}

#[test]
fn headers_are_parsed_strictly() {
    assert_eq!(
        parse_header("0644 12 a b 中文.txt").unwrap(),
        Header {
            mode: 0o644,
            size: 12,
            name: "a b 中文.txt".into()
        }
    );
    assert_eq!(parse_header("7 0 x").unwrap().mode, 0o7);
    for bad in [
        "",
        "0644",
        "0644 12",
        "0644 12 ",
        "+644 1 a",
        "06444 1 a",
        "0648 1 a",
        "0644 -1 a",
        "0644 +1 a",
        "0644 1x a",
        "0644 99999999999999999999999 a",
        "0644 1 a/b",
        "0644 1 ..",
    ] {
        assert!(parse_header(bad).is_err(), "{bad:?}");
    }
    assert_eq!(
        clean(b"scp: \x1b[31mred\x07\tline"),
        "SCP: scp: [31mredline"
    );
    let disguised = "a\u{202E}b\u{200B}c\u{2066}d\u{FEFF}e";
    assert_eq!(clean(disguised.as_bytes()), "SCP: abcde");
    assert_eq!(
        clean(&[b'x'; 1000]).len(),
        "SCP: ".len() + MAX_MESSAGE_CHARS
    );
    assert_eq!(limit_text(64 * 1024 * 1024), "64 MiB");
    assert_eq!(limit_text(1024), "1024 byte");
}

#[tokio::test]
async fn upload_sends_the_header_data_and_terminator_with_progress() {
    let script = Script::new(vec![
        data(b"\0"),
        data(b"\0"),
        data(b"\0"),
        exit(0),
        ChannelMsg::Close,
    ]);
    let payload: Vec<u8> = (0..UPLOAD_CHUNK * 2 + 3).map(|i| i as u8).collect();
    let (progress, seen) = recorder();
    send_file(
        Reader::new(script.clone()),
        "上传 'q'.bin",
        0o100644,
        &payload,
        Some(&progress),
    )
    .await
    .unwrap();
    let header = format!("C0644 {} 上传 'q'.bin\n", payload.len());
    let expected = [header.as_bytes(), &payload, &[0]].concat();
    assert!(script.sent() == expected, "sent bytes differ");
    assert!(*script.eof.lock().unwrap());
    let total = payload.len() as u64;
    assert_eq!(seen.lock().unwrap().last(), Some(&(total, total)));
}

#[tokio::test]
async fn upload_reports_refusals_and_failed_exits() {
    let refused = Script::new(vec![data(b"\0\x01scp: /r/x: Permission denied\n")]);
    let error = send_file(Reader::new(refused.clone()), "x", 0o644, b"1", None)
        .await
        .unwrap_err();
    assert_eq!(error, "SCP: scp: /r/x: Permission denied");
    // Nothing after the header is sent once the server refuses it.
    assert_eq!(refused.sent(), b"C0644 1 x\n");

    let failed = Script::new(vec![data(b"\0\0\0"), exit(1), ChannelMsg::Close]);
    let error = send_file(Reader::new(failed), "x", 0o644, b"1", None)
        .await
        .unwrap_err();
    assert_eq!(error, "SCP exited with status 1");

    let ended = Script::new(vec![data(b"\0"), exit(126), ChannelMsg::Eof]);
    let error = send_file(Reader::new(ended), "x", 0o644, b"1", None)
        .await
        .unwrap_err();
    assert_eq!(error, "SCP ended early (exit 126)");
    // OpenSSH may close stdout (EOF) before it reports the exit status.
    let missing = Script::new(vec![
        data(b"\0"),
        ChannelMsg::Eof,
        exit(127),
        ChannelMsg::Close,
    ]);
    let error = send_file(Reader::new(missing), "x", 0o644, b"1", None)
        .await
        .unwrap_err();
    assert_eq!(error, "SCP ended early (exit 127)");
}

/// A send that fails partway reports the server's reason, not just that
/// sending failed.
#[tokio::test]
async fn failed_sends_report_the_server_reason() {
    let cases = [
        (
            vec![
                data(b"\0\0"),
                data(b"\x01scp: write: No space left on device\n"),
                exit(1),
                ChannelMsg::Close,
            ],
            "SCP: scp: write: No space left on device",
        ),
        (
            vec![data(b"\0\0"), ChannelMsg::Eof, exit(1), ChannelMsg::Close],
            "SCP ended early (exit 1)",
        ),
        (vec![data(b"\0\0\x07")], SEND_FAILED),
    ];
    for (messages, expected) in cases {
        let script = Script::new(messages);
        // The header goes out; the first data chunk fails.
        *script.sends_left.lock().unwrap() = Some(1);
        let error = send_file(Reader::new(script), "x", 0o644, &[1; 10], None)
            .await
            .unwrap_err();
        assert_eq!(error, expected);
    }
}

#[tokio::test]
async fn download_streams_into_a_new_sanitized_local_file() {
    let folder = Folder::new();
    std::fs::write(folder.0.join("a_b.txt"), b"keep").unwrap();
    // The data arrives split across messages, the end ack inside the last one.
    let script = Script::new(vec![
        data(b"C0600 10 a:b.txt\n"),
        data(b"01234"),
        data(b"56789\0"),
    ]);
    let (progress, seen) = recorder();
    let saved = save(
        Reader::new(script.clone()),
        "/remote/a:b.txt",
        &folder.0,
        Some(&progress),
    )
    .await
    .unwrap();
    assert_eq!(saved.bytes, 10);
    assert_eq!(PathBuf::from(&saved.path), folder.0.join("a_b (1).txt"));
    assert_eq!(std::fs::read(&saved.path).unwrap(), b"0123456789");
    assert_eq!(std::fs::read(folder.0.join("a_b.txt")).unwrap(), b"keep");
    assert_eq!(script.sent(), [0, 0, 0]);
    assert_eq!(seen.lock().unwrap().last(), Some(&(10, 10)));
}

/// Every failure leaves the download folder exactly as it was.
#[tokio::test]
async fn failed_downloads_leave_no_local_file() {
    let folder = Folder::new();
    let cases: Vec<(Vec<ChannelMsg>, &str)> = vec![
        (
            vec![data(b"\x01scp: /remote/f: No such file or directory\n")],
            "SCP: scp: /remote/f: No such file or directory",
        ),
        (
            vec![data(b"C0644 3 other\n")],
            "SCP server sent a different file name than requested",
        ),
        (
            vec![data(
                format!("C0644 {} f\n", MAX_DOWNLOAD_BYTES + 1).as_bytes(),
            )],
            "SCP file exceeds the 64 MiB download limit",
        ),
        (
            vec![data(b"D0755 0 f\n")],
            "SCP: only a single regular file is supported",
        ),
        (vec![data(b"C0644 x f\n")], "SCP header has no size"),
        // The server stops partway: the partial file is removed.
        (
            vec![data(b"C0644 10 f\n01234"), exit(1), ChannelMsg::Eof],
            "SCP ended early (exit 1)",
        ),
        // The data arrived but the server reports a read error after it.
        (
            vec![data(b"C0644 3 f\nabc\x01scp: read error\n")],
            "SCP: scp: read error",
        ),
        (
            vec![data(b"C0644 3 f\nabc\x07")],
            "SCP protocol error (byte 7)",
        ),
    ];
    for (messages, expected) in cases {
        let script = Script::new(messages);
        let error = save(Reader::new(script.clone()), "/remote/f", &folder.0, None)
            .await
            .unwrap_err();
        assert_eq!(error, expected);
        assert!(
            folder.names().is_empty(),
            "{expected}: {:?}",
            folder.names()
        );
    }
    // A refused header is answered with an error, never with a go-ahead.
    let script = Script::new(vec![data(b"C0644 3 other\n")]);
    let _ = save(Reader::new(script.clone()), "/remote/f", &folder.0, None).await;
    assert_eq!(script.sent(), b"\0\x02transfer refused by the client\n");
}

#[tokio::test]
async fn an_unusable_download_folder_refuses_the_file_before_its_data() {
    let folder = Folder::new();
    let missing = folder.0.join("missing");
    let script = Script::new(vec![data(b"C0644 3 f\nabc\0")]);
    let error = save(Reader::new(script.clone()), "/remote/f", &missing, None)
        .await
        .unwrap_err();
    assert_eq!(error, "The download folder is unavailable");
    assert_eq!(script.sent(), b"\0\x02transfer refused by the client\n");
}

#[tokio::test]
async fn control_lines_are_bounded() {
    let mut long = vec![b'C'];
    long.extend(std::iter::repeat_n(b'1', MAX_LINE + 10));
    let mut reader = Reader::new(Script::new(vec![data(&long)]));
    let error = receive(&mut reader, "f", 10, |_| Ok(Vec::new()))
        .await
        .unwrap_err();
    assert_eq!(error, "SCP control line too long");
    // Also when the whole line, terminator included, arrives at once.
    long.push(b'\n');
    let mut reader = Reader::new(Script::new(vec![data(&long)]));
    let error = receive(&mut reader, "f", 10, |_| Ok(Vec::new()))
        .await
        .unwrap_err();
    assert_eq!(error, "SCP control line too long");
    let mut reader = Reader::new(Script::new(vec![data(b"C0644 3 f\nab"), data(b"c\0")]));
    let (header, bytes) = receive(&mut reader, "f", 3, |_| Ok(Vec::new()))
        .await
        .unwrap();
    assert_eq!((header.size, bytes), (3, b"abc".to_vec()));
}

fn grant_on(service: &Ssh, port: u16) -> (String, String) {
    let scope = service.context("main").unwrap();
    let operation = service.start("main", &id(), &scope).unwrap();
    let request = Request {
        host: "127.0.0.1".into(),
        port,
        username: "fixture".into(),
        private_key_path: std::env::temp_dir().join("key").to_string_lossy().into(),
    };
    let token = service
        .issue_grant(
            &operation,
            &scope,
            request,
            vec![1],
            Credential::default(),
            crate::ssh::route::Route::Direct,
        )
        .unwrap();
    (token, scope)
}

fn call(grant: &str, scope: &str) -> SftpCall {
    SftpCall {
        owner: "main".into(),
        id: id(),
        grant: grant.into(),
        scope: scope.into(),
        prompts: None,
    }
}

/// Uploads need a writable grant and valid paths before any connection;
/// downloads go through on a read-only grant.
#[tokio::test]
async fn uploads_need_a_writable_grant_before_connecting() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let service = Ssh::default();
    let (grant, scope) = grant_on(&service, port);
    let upload =
        |path: &str| service.scp_upload(call(&grant, &scope), path.into(), b"x".to_vec(), None);
    assert_eq!(
        upload("/remote/x").await.unwrap_err(),
        crate::ssh::sftp_write::READ_ONLY
    );
    service
        .sftp_set_writable("main", &grant, &scope, true)
        .unwrap();
    for bad in ["relative", "/", "/a/../b", "/a/", "/a\nb", "//x"] {
        assert!(upload(bad).await.is_err(), "{bad:?}");
    }
    let oversize = vec![0; write::MAX_UPLOAD_BYTES + 1];
    let error = service
        .scp_upload(call(&grant, &scope), "/remote/x".into(), oversize, None)
        .await
        .unwrap_err();
    assert_eq!(error, "Upload exceeds the 16 MiB limit");
    let folder = Folder::new();
    let missing = folder.0.join("missing");
    let error = service
        .scp_download(call(&grant, &scope), "/remote/x".into(), missing, None)
        .await
        .unwrap_err();
    assert_eq!(error, "The download folder is unavailable");
    let connected = tokio::time::timeout(Duration::from_millis(100), listener.accept()).await;
    assert!(connected.is_err(), "a refused request connected");

    // Read-only again: a download still reaches the network (and fails at
    // the handshake against this silent listener), keeping the grant.
    service
        .sftp_set_writable("main", &grant, &scope, false)
        .unwrap();
    let accepted = async {
        // Closing at once makes the handshake fail without waiting.
        let (socket, _) = listener.accept().await.unwrap();
        drop(socket);
    };
    let download = service.scp_download(
        call(&grant, &scope),
        "/remote/x".into(),
        folder.0.clone(),
        None,
    );
    let ((), result) = tokio::time::timeout(Duration::from_secs(10), async {
        tokio::join!(accepted, download)
    })
    .await
    .unwrap();
    assert!(result.is_err());
    assert!(service.registry.lock().unwrap().grants.contains_key(&grant));
    assert!(folder.names().is_empty());
}

/// Real OpenSSH `scp -t/-f` on the isolated fixture: the session-level
/// probe, then the grant path the file panel uses.
#[cfg(unix)]
#[tokio::test]
#[ignore = "requires the isolated fixture; run tests/fixtures/ssh-sftp/rust-client.test.mjs"]
async fn real_fixture_scp_round_trip() {
    use crate::ssh::{connect_pinned, observe_host_key};
    use russh::keys::HashAlg;
    let env = |name: &str| std::env::var(name).unwrap();
    let request = Request {
        host: env("P0_SSH_FIXTURE_HOST"),
        port: env("P0_SSH_FIXTURE_PORT").parse().unwrap(),
        username: env("P0_SSH_FIXTURE_USER"),
        private_key_path: env("P0_SSH_FIXTURE_KEY"),
    };
    let remote = env("P0_SSH_FIXTURE_REMOTE");
    let connect = || tokio::net::TcpStream::connect((request.host.clone(), request.port));
    let key = observe_host_key(connect().await.unwrap()).await.unwrap();
    assert_eq!(
        key.fingerprint(HashAlg::Sha256).to_string(),
        env("P0_SSH_FIXTURE_FINGERPRINT")
    );
    let (_, cancel) = tokio::sync::watch::channel(false);
    let ssh = connect_pinned(
        connect().await.unwrap(),
        &request,
        key.to_bytes().unwrap(),
        &Credential::default(),
        cancel,
    )
    .await
    .unwrap();

    let payload: Vec<u8> = (0..1_048_583u32)
        .map(|i| (i.wrapping_mul(2_654_435_761) >> 13) as u8)
        .collect();
    let name = "scp 中文 'quoted'.bin";
    upload(&ssh, &remote, name, 0o640, &payload, None)
        .await
        .unwrap();
    let on_disk = std::fs::read(std::path::Path::new(&remote).join(name)).unwrap();
    assert!(on_disk == payload, "uploaded bytes differ on disk");

    let (header, bytes) = download(&ssh, &format!("{remote}/{name}"), 4 * 1024 * 1024)
        .await
        .unwrap();
    assert_eq!(header.name, name);
    // The server applies its umask; the mode never exceeds what was sent.
    assert_eq!(header.mode & 0o777 & !0o640, 0, "mode {:o}", header.mode);
    assert!(bytes == payload, "downloaded bytes differ");

    let missing = download(&ssh, &format!("{remote}/missing"), 1024)
        .await
        .err()
        .unwrap();
    assert!(missing.starts_with("SCP: "), "{missing}");
    let large = download(&ssh, &format!("{remote}/{name}"), 1024)
        .await
        .err()
        .unwrap();
    assert!(large.contains("limit"), "{large}");
    assert!(upload(&ssh, &remote, "bad/name", 0o600, b"x", None)
        .await
        .is_err());
    // `scp -t -d`: a parent that is a regular file or missing is refused,
    // never written to or created under that name.
    let plain = std::path::Path::new(&remote).join("plain.txt");
    std::fs::write(&plain, b"keep\n").unwrap();
    let parent = format!("{remote}/plain.txt");
    let error = upload(&ssh, &parent, "b.txt", 0o600, b"x", None)
        .await
        .unwrap_err();
    assert!(error.starts_with("SCP: "), "{error}");
    assert_eq!(std::fs::read(&plain).unwrap(), b"keep\n");
    let missing_parent = format!("{remote}/missing-dir");
    let error = upload(&ssh, &missing_parent, "b.txt", 0o600, b"x", None)
        .await
        .unwrap_err();
    assert!(error.starts_with("SCP: "), "{error}");
    assert!(!std::path::Path::new(&missing_parent).exists());
    // Outside the fixture's directory the server side denies the command.
    assert!(download(&ssh, "/etc/hosts", 1024).await.is_err());

    let downloads = PathBuf::from(env("P0_SSH_FIXTURE_DOWNLOADS"));
    grant_round_trip(request, &remote, &downloads).await;
}

#[cfg(unix)]
type Events = Arc<Mutex<Vec<crate::ssh::sftp_write::TransferProgress>>>;

#[cfg(unix)]
fn sink_of(seen: Events) -> ProgressSink {
    Arc::new(move |event| {
        seen.lock().unwrap().push(event);
        Ok(())
    })
}

#[cfg(unix)]
fn assert_progress(
    events: &[crate::ssh::sftp_write::TransferProgress],
    operation: &str,
    total: u64,
) {
    assert!(!events.is_empty());
    assert!(events
        .windows(2)
        .all(|pair| pair[0].transferred < pair[1].transferred));
    assert!(events.iter().all(|event| event.operation_id == operation));
    let last = events.last().unwrap();
    assert_eq!((last.transferred, last.total), (total, total));
}

/// The file panel's path: one grant, every transfer reconnecting through it.
#[cfg(unix)]
async fn grant_round_trip(request: Request, remote: &str, downloads: &Path) {
    use crate::ssh::{sftp_write::READ_ONLY, SFTP_EXPIRED};
    let service = Arc::new(Ssh::default());
    let scope = service.context("main").unwrap();
    let challenge = service.probe("main", &id(), request, &scope).await.unwrap();
    let grant = service
        .sftp_open("main", &id(), &challenge.challenge_token, &scope)
        .await
        .unwrap()
        .grant_token;
    let call_as = |operation: &str| SftpCall {
        owner: "main".into(),
        id: operation.into(),
        grant: grant.clone(),
        scope: scope.clone(),
        prompts: None,
    };
    let path = |name: &str| format!("{remote}/{name}");
    let disk = |name: &str| Path::new(remote).join(name);
    let payload: Vec<u8> = (0..(1u32 << 20) + 7).map(|i| (i % 253) as u8).collect();
    let name = "grant 中文 'q'.bin";

    // Read-only: an upload is refused before connecting.
    let refused = service
        .scp_upload(call_as(&id()), path(name), payload.clone(), None)
        .await
        .unwrap_err();
    assert_eq!(refused, READ_ONLY);
    assert!(!disk(name).exists());

    service
        .sftp_set_writable("main", &grant, &scope, true)
        .unwrap();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let operation = id();
    service
        .scp_upload(
            call_as(&operation),
            path(name),
            payload.clone(),
            Some(sink_of(seen.clone())),
        )
        .await
        .unwrap();
    assert!(std::fs::read(disk(name)).unwrap() == payload);
    assert_progress(&seen.lock().unwrap(), &operation, payload.len() as u64);
    // SCP replaces an existing file in place.
    service
        .scp_upload(call_as(&id()), path(name), b"short\n".to_vec(), None)
        .await
        .unwrap();
    assert_eq!(std::fs::read(disk(name)).unwrap(), b"short\n");
    // A parent that is a regular file or missing is refused, not written.
    std::fs::write(disk("plain.txt"), b"keep\n").unwrap();
    for target in ["plain.txt/b.txt", "missing-dir/b.txt"] {
        let error = service
            .scp_upload(call_as(&id()), path(target), b"x".to_vec(), None)
            .await
            .unwrap_err();
        assert!(error.starts_with("SCP: "), "{target}: {error}");
    }
    assert_eq!(std::fs::read(disk("plain.txt")).unwrap(), b"keep\n");
    assert!(!disk("missing-dir").exists());

    // Downloads work on a read-only grant and never overwrite.
    service
        .sftp_set_writable("main", &grant, &scope, false)
        .unwrap();
    std::fs::write(disk("source.bin"), &payload).unwrap();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let operation = id();
    let saved = service
        .scp_download(
            call_as(&operation),
            path("source.bin"),
            downloads.into(),
            Some(sink_of(seen.clone())),
        )
        .await
        .unwrap();
    assert_eq!(saved.bytes, payload.len() as u64);
    assert_eq!(PathBuf::from(&saved.path), downloads.join("source.bin"));
    assert!(std::fs::read(&saved.path).unwrap() == payload);
    assert_progress(&seen.lock().unwrap(), &operation, payload.len() as u64);
    let again = service
        .scp_download(call_as(&id()), path("source.bin"), downloads.into(), None)
        .await
        .unwrap();
    assert_eq!(PathBuf::from(&again.path), downloads.join("source (1).bin"));
    std::fs::write(disk("冒号:名 .txt"), b"colon\n").unwrap();
    let colon = service
        .scp_download(call_as(&id()), path("冒号:名 .txt"), downloads.into(), None)
        .await
        .unwrap();
    assert_eq!(PathBuf::from(&colon.path), downloads.join("冒号_名 .txt"));

    // Failures keep the grant and leave no local file behind.
    let names = || {
        let mut names: Vec<_> = std::fs::read_dir(downloads)
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        names.sort();
        names
    };
    let before = names();
    let download = |name: String| {
        let service = service.clone();
        let call = call_as(&id());
        async move {
            service
                .scp_download(call, name, downloads.into(), None)
                .await
        }
    };
    let missing = download(path("missing")).await.unwrap_err();
    assert!(missing.starts_with("SCP: "), "{missing}");
    assert!(download("/etc/hosts".into()).await.is_err());
    std::fs::File::create(disk("huge.bin"))
        .unwrap()
        .set_len(MAX_DOWNLOAD_BYTES + 1)
        .unwrap();
    let huge = download(path("huge.bin")).await.unwrap_err();
    assert!(huge.contains("64 MiB download limit"), "{huge}");
    // Cancelling partway removes the partial file.
    std::fs::write(disk("big.bin"), vec![7u8; 8 << 20]).unwrap();
    let operation = id();
    let canceller: ProgressSink = {
        let (service, operation) = (service.clone(), operation.clone());
        Arc::new(move |_| {
            let _ = service.cancel("main", &operation);
            Ok(())
        })
    };
    let cancelled = service
        .scp_download(
            call_as(&operation),
            path("big.bin"),
            downloads.into(),
            Some(canceller),
        )
        .await
        .unwrap_err();
    assert_eq!(cancelled, "SSH operation cancelled");
    assert_eq!(names(), before);

    let kept = download(path(name)).await.unwrap();
    assert_eq!(std::fs::read(&kept.path).unwrap(), b"short\n");
    service.sftp_close("main", &grant).unwrap();
    assert_eq!(
        download(path(name)).await.unwrap_err(),
        SFTP_EXPIRED.to_string()
    );
}
