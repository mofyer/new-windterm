//! Tests for [`super`]: grant gating without a network, and the ignored
//! end-to-end run against the isolated OpenSSH fixture.
use super::*;
use crate::ssh::{Credential, Request};
use std::sync::Mutex;

fn id() -> String {
    uuid::Uuid::new_v4().to_string()
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

fn mkdir(path: &str) -> Mutation {
    Mutation::Mkdir { path: path.into() }
}

#[test]
fn writes_need_the_owner_and_scope_of_the_grant() {
    let service = Ssh::default();
    let (grant, scope) = grant_on(&service, 1);
    assert!(!service.registry.lock().unwrap().grants[&grant].writable);
    assert_eq!(
        service
            .sftp_set_writable("other", &grant, &scope, true)
            .unwrap_err(),
        "SFTP session not owned by this window"
    );
    assert_eq!(
        service
            .sftp_set_writable("main", "missing", &scope, true)
            .unwrap_err(),
        SFTP_EXPIRED
    );
    service
        .sftp_set_writable("main", &grant, &scope, true)
        .unwrap();
    assert!(service.registry.lock().unwrap().grants[&grant].writable);
    // A delayed call from an old page removes the grant, as any use does.
    assert_eq!(
        service
            .sftp_set_writable("main", &grant, "stale-scope", false)
            .unwrap_err(),
        SFTP_EXPIRED
    );
    assert!(service.registry.lock().unwrap().grants.is_empty());
}

#[tokio::test]
async fn read_only_grants_refuse_writes_before_connecting() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let service = Arc::new(Ssh::default());
    let port = listener.local_addr().unwrap().port();
    let (grant, scope) = grant_on(&service, port);
    let refused = service
        .sftp_mutate(call(&grant, &scope), mkdir("/tmp/x"), None)
        .await
        .unwrap_err();
    assert_eq!(refused, READ_ONLY);
    {
        let registry = service.registry.lock().unwrap();
        assert!(registry.grants.contains_key(&grant) && registry.active.is_empty());
    }

    // Once writable, the same request reaches the network; a peer that
    // drops the connection carries no evidence and keeps the grant.
    service
        .sftp_set_writable("main", &grant, &scope, true)
        .unwrap();
    let task = {
        let (service, call) = (service.clone(), call(&grant, &scope));
        tokio::spawn(async move { service.sftp_mutate(call, mkdir("/tmp/x"), None).await })
    };
    drop(listener.accept().await.unwrap());
    assert_eq!(task.await.unwrap().unwrap_err(), "SSH handshake failed");
    let registry = service.registry.lock().unwrap();
    assert!(registry.grants.contains_key(&grant) && registry.active.is_empty());
}

#[tokio::test]
async fn invalid_changes_and_folders_fail_before_the_grant_is_used() {
    let service = Ssh::default();
    let (grant, scope) = grant_on(&service, 1);
    service
        .sftp_set_writable("main", &grant, &scope, true)
        .unwrap();
    let before = service.registry.lock().unwrap().grants[&grant].idle_until;
    for (mutation, expected) in [
        (mkdir("relative"), "Remote write paths must be absolute"),
        (
            Mutation::Rename {
                from: "/a".into(),
                to: "/b/../c".into(),
            },
            "Invalid remote write path",
        ),
        (
            Mutation::Chmod {
                path: "/a".into(),
                mode: 0o4755,
            },
            "Only permission bits 000-777 can be changed",
        ),
        (
            Mutation::Upload {
                path: "/a".into(),
                data: vec![0; write::MAX_UPLOAD_BYTES + 1],
                overwrite: false,
            },
            "Upload exceeds the 16 MiB limit",
        ),
    ] {
        let error = service
            .sftp_mutate(call(&grant, &scope), mutation, None)
            .await
            .unwrap_err();
        assert_eq!(error, expected);
    }
    let error = service
        .sftp_download(
            call(&grant, &scope),
            "/a".into(),
            PathBuf::from("relative-downloads"),
            None,
        )
        .await
        .unwrap_err();
    assert_eq!(error, "The download folder is unavailable");
    let registry = service.registry.lock().unwrap();
    assert_eq!(registry.grants[&grant].idle_until, before);
    assert!(registry.active.is_empty());
}

#[test]
fn transfers_get_a_longer_deadline_and_only_changes_need_write() {
    let upload = SftpRequest::Change(Change {
        mutation: Mutation::Upload {
            path: "/a".into(),
            data: Vec::new(),
            overwrite: false,
        },
        progress: None,
    });
    let fetch = SftpRequest::Fetch(Fetch {
        path: "/a".into(),
        directory: PathBuf::new(),
        progress: None,
    });
    let rename = SftpRequest::Change(Change {
        mutation: Mutation::Rename {
            from: "/a".into(),
            to: "/b".into(),
        },
        progress: None,
    });
    assert_eq!(upload.deadline(), TRANSFER_DEADLINE);
    assert_eq!(fetch.deadline(), TRANSFER_DEADLINE);
    assert_eq!(rename.deadline(), DEADLINE);
    assert_eq!(SftpRequest::List("/".into()).deadline(), DEADLINE);
    assert!(upload.writes() && rename.writes());
    assert!(!fetch.writes() && !SftpRequest::Open.writes());
}

#[test]
fn progress_carries_the_operation_and_ignores_a_closed_channel() {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let sink = seen.clone();
    let progress = meter(
        "op-1",
        Arc::new(move |event| {
            sink.lock().unwrap().push(event);
            Err("channel closed".into())
        }),
    );
    progress(5, 10);
    assert_eq!(
        *seen.lock().unwrap(),
        [TransferProgress {
            operation_id: "op-1".into(),
            transferred: 5,
            total: 10
        }]
    );
}

/// Records progress; with a service, cancels the operation at its first event.
#[cfg(unix)]
fn recorder(service: Option<Arc<Ssh>>) -> (ProgressSink, Arc<Mutex<Vec<TransferProgress>>>) {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let sink = seen.clone();
    let progress: ProgressSink = Arc::new(move |event: TransferProgress| {
        if let Some(service) = &service {
            service.cancel("main", &event.operation_id)?;
        }
        sink.lock().unwrap().push(event);
        Ok(())
    });
    (progress, seen)
}

#[cfg(unix)]
fn file_names(directory: &std::path::Path) -> Vec<String> {
    let mut names: Vec<_> = std::fs::read_dir(directory)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

// The OpenSSH fixture runs on macOS and Linux only.
#[cfg(unix)]
#[tokio::test]
#[ignore = "requires the isolated fixture; run tests/fixtures/ssh-sftp/rust-client.test.mjs"]
async fn real_fixture_sftp_write_operations() {
    use crate::sftp::{
        local::MAX_DOWNLOAD_BYTES,
        write::{PARTIAL_SUFFIX, PROGRESS_STEP},
        RemoteKind,
    };
    let env = |name: &str| std::env::var(name).unwrap();
    // The fixture's remote directory is on this machine, so results are
    // also checked directly on disk.
    let remote = env("P0_SSH_FIXTURE_REMOTE");
    let downloads = PathBuf::from(env("P0_SSH_FIXTURE_DOWNLOADS"));
    let disk = |name: &str| PathBuf::from(&remote).join(name);
    let path = |name: &str| format!("{remote}/{name}");
    let service = Arc::new(Ssh::default());
    let scope = service.context("main").unwrap();
    let request = Request {
        host: env("P0_SSH_FIXTURE_HOST"),
        port: env("P0_SSH_FIXTURE_PORT").parse().unwrap(),
        username: env("P0_SSH_FIXTURE_USER"),
        private_key_path: env("P0_SSH_FIXTURE_KEY"),
    };
    let challenge = service.probe("main", &id(), request, &scope).await.unwrap();
    let grant = service
        .sftp_open("main", &id(), &challenge.challenge_token, &scope)
        .await
        .unwrap()
        .grant_token;
    let change = |mutation: Mutation| {
        let service = service.clone();
        let call = call(&grant, &scope);
        async move { service.sftp_mutate(call, mutation, None).await }
    };
    let payload: Vec<u8> = (0..(1 << 20) + 7).map(|i: u32| (i % 251) as u8).collect();
    std::fs::write(disk("source.bin"), &payload).unwrap();

    // Read-only: writes are refused before connecting; downloads work.
    assert_eq!(
        change(mkdir(&path("refused"))).await.unwrap_err(),
        READ_ONLY
    );
    assert!(!disk("refused").exists());
    let (progress, seen) = recorder(None);
    let saved = service
        .sftp_download(
            call(&grant, &scope),
            path("source.bin"),
            downloads.clone(),
            Some(progress),
        )
        .await
        .unwrap();
    assert_eq!(saved.bytes, payload.len() as u64);
    assert_eq!(PathBuf::from(&saved.path), downloads.join("source.bin"));
    assert_eq!(std::fs::read(&saved.path).unwrap(), payload);
    // The server may answer reads short, so only the shape is fixed.
    let events = seen.lock().unwrap().clone();
    assert!(events.len() >= 2);
    assert!(events
        .windows(2)
        .all(|pair| pair[0].transferred < pair[1].transferred
            && pair[0].operation_id == pair[1].operation_id));
    assert_eq!(
        events.last().map(|event| (event.transferred, event.total)),
        Some((payload.len() as u64, payload.len() as u64))
    );
    let again = service
        .sftp_download(
            call(&grant, &scope),
            path("source.bin"),
            downloads.clone(),
            None,
        )
        .await
        .unwrap();
    assert_eq!(PathBuf::from(&again.path), downloads.join("source (1).bin"));
    // Symbolic links are followed; the local name is sanitized.
    std::fs::write(disk("冒号:名 .txt"), b"colon\n").unwrap();
    std::os::unix::fs::symlink("冒号:名 .txt", disk("链接")).unwrap();
    for (name, local) in [("冒号:名 .txt", "冒号_名 .txt"), ("链接", "链接")] {
        let saved = service
            .sftp_download(call(&grant, &scope), path(name), downloads.clone(), None)
            .await
            .unwrap();
        assert_eq!(PathBuf::from(&saved.path), downloads.join(local));
        assert_eq!(std::fs::read(&saved.path).unwrap(), b"colon\n");
    }

    // The largest allowed download completes (sparse file, loopback).
    std::fs::File::create(disk("max.bin"))
        .unwrap()
        .set_len(MAX_DOWNLOAD_BYTES)
        .unwrap();
    let saved = service
        .sftp_download(
            call(&grant, &scope),
            path("max.bin"),
            downloads.clone(),
            None,
        )
        .await
        .unwrap();
    assert_eq!(saved.bytes, MAX_DOWNLOAD_BYTES);
    assert_eq!(
        std::fs::metadata(&saved.path).unwrap().len(),
        MAX_DOWNLOAD_BYTES
    );
    std::fs::remove_file(&saved.path).unwrap();

    // Download failures and cancellation leave no local file behind.
    std::fs::create_dir(disk("folder")).unwrap();
    std::fs::File::create(disk("sparse.bin"))
        .unwrap()
        .set_len(MAX_DOWNLOAD_BYTES + 1)
        .unwrap();
    let before = file_names(&downloads);
    for (name, expected) in [
        ("folder", "SFTP download requires a regular file"),
        ("sparse.bin", "SFTP file exceeds the 64 MiB download limit"),
        (
            "missing",
            "SFTP metadata request failed: no such file or directory",
        ),
    ] {
        let error = service
            .sftp_download(call(&grant, &scope), path(name), downloads.clone(), None)
            .await
            .unwrap_err();
        assert_eq!(error, expected);
    }
    let (cancelling, seen) = recorder(Some(service.clone()));
    let error = service
        .sftp_download(
            call(&grant, &scope),
            path("source.bin"),
            downloads.clone(),
            Some(cancelling),
        )
        .await
        .unwrap_err();
    assert_eq!(error, "SSH operation cancelled");
    assert_eq!(seen.lock().unwrap().len(), 1);
    assert_eq!(file_names(&downloads), before);

    // Writable: create a directory with a Chinese, spaced name.
    service
        .sftp_set_writable("main", &grant, &scope, true)
        .unwrap();
    let folder = path("写入 测试");
    change(mkdir(&folder)).await.unwrap();
    assert!(disk("写入 测试").is_dir());
    assert_eq!(
        change(mkdir(&folder)).await.unwrap_err(),
        "Remote path already exists"
    );
    let inside = |name: &str| format!("{folder}/{name}");
    let on_disk = |name: &str| disk("写入 测试").join(name);

    // Upload: chunked, exclusive by default, verified size and bytes.
    let upload = |name: &str, data: &[u8], overwrite: bool| Mutation::Upload {
        path: inside(name),
        data: data.to_vec(),
        overwrite,
    };
    let (progress, seen) = recorder(None);
    let entry = service
        .sftp_mutate(
            call(&grant, &scope),
            upload("上传 🌏.bin", &payload, false),
            Some(progress),
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        (entry.kind, entry.size),
        (RemoteKind::File, payload.len() as u64)
    );
    assert_eq!(std::fs::read(on_disk("上传 🌏.bin")).unwrap(), payload);
    assert_eq!(seen.lock().unwrap().len(), 5);
    assert_eq!(file_names(&disk("写入 测试")), ["上传 🌏.bin"]);
    assert_eq!(
        change(upload("上传 🌏.bin", b"other", false))
            .await
            .unwrap_err(),
        "Remote path already exists"
    );
    assert_eq!(std::fs::read(on_disk("上传 🌏.bin")).unwrap(), payload);
    change(upload("上传 🌏.bin", b"replaced\n", true))
        .await
        .unwrap();
    assert_eq!(
        std::fs::read(on_disk("上传 🌏.bin")).unwrap(),
        b"replaced\n"
    );
    std::os::unix::fs::symlink("上传 🌏.bin", on_disk("link")).unwrap();
    for name in ["link", ""] {
        let target = if name.is_empty() {
            folder.clone()
        } else {
            inside(name)
        };
        let error = change(Mutation::Upload {
            path: target,
            data: b"x".to_vec(),
            overwrite: true,
        })
        .await
        .unwrap_err();
        assert_eq!(error, "Only an existing regular file can be overwritten");
    }
    assert_eq!(
        std::fs::read(on_disk("上传 🌏.bin")).unwrap(),
        b"replaced\n"
    );
    let empty = change(upload("空 文件.txt", b"", false))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(empty.size, 0);
    assert_eq!(std::fs::metadata(on_disk("空 文件.txt")).unwrap().len(), 0);

    // Rename never replaces an existing target.
    let rename = |from: &str, to: &str| Mutation::Rename {
        from: inside(from),
        to: inside(to),
    };
    assert_eq!(
        change(rename("上传 🌏.bin", "空 文件.txt"))
            .await
            .unwrap_err(),
        "Remote path already exists"
    );
    change(rename("上传 🌏.bin", "改名 后.bin")).await.unwrap();
    assert!(!on_disk("上传 🌏.bin").exists());
    assert_eq!(
        std::fs::read(on_disk("改名 后.bin")).unwrap(),
        b"replaced\n"
    );

    // Chmod changes rwx bits on files and directories, never through links.
    use std::os::unix::fs::PermissionsExt;
    let chmod = |name: &str, mode: u32| Mutation::Chmod {
        path: inside(name),
        mode,
    };
    let entry = change(chmod("改名 后.bin", 0o640)).await.unwrap().unwrap();
    assert_eq!(entry.mode.map(|mode| mode & 0o7777), Some(0o640));
    let mode = std::fs::metadata(on_disk("改名 后.bin"))
        .unwrap()
        .permissions()
        .mode();
    assert_eq!(mode & 0o7777, 0o640);
    assert_eq!(
        change(chmod("link", 0o600)).await.unwrap_err(),
        "P0 does not change permissions through symbolic links"
    );

    // A cancelled new upload never leaves partial content under its
    // final name; its hidden sibling can remain (documented).
    let (cancelling, _) = recorder(Some(service.clone()));
    let error = service
        .sftp_mutate(
            call(&grant, &scope),
            upload("取消.bin", &payload, false),
            Some(cancelling),
        )
        .await
        .unwrap_err();
    assert_eq!(error, "SSH operation cancelled");
    assert!(!on_disk("取消.bin").exists());
    let partial: Vec<_> = file_names(&disk("写入 测试"))
        .into_iter()
        .filter(|name| name.starts_with(".取消.bin.") && name.ends_with(PARTIAL_SUFFIX))
        .collect();
    assert_eq!(partial.len(), 1);
    let size = std::fs::metadata(on_disk(&partial[0])).unwrap().len();
    assert!(size >= PROGRESS_STEP && size < payload.len() as u64);

    // Removal: files and links as files, empty directories only.
    let remove = |name: &str| Mutation::RemoveFile { path: inside(name) };
    change(remove(&partial[0])).await.unwrap();
    change(remove("link")).await.unwrap();
    assert!(on_disk("改名 后.bin").exists());
    assert_eq!(
        change(Mutation::RemoveFile {
            path: folder.clone()
        })
        .await
        .unwrap_err(),
        "This is a directory; remove it as an empty directory"
    );
    let rmdir = Mutation::RemoveDir {
        path: folder.clone(),
    };
    assert_eq!(
        change(rmdir).await.unwrap_err(),
        "SFTP rmdir failed: the directory is not empty or cannot be removed"
    );
    change(remove("改名 后.bin")).await.unwrap();
    change(remove("空 文件.txt")).await.unwrap();
    change(Mutation::RemoveDir {
        path: folder.clone(),
    })
    .await
    .unwrap();
    assert!(!disk("写入 测试").exists());

    // Server permission failures are reported without server text.
    std::fs::create_dir(disk("locked")).unwrap();
    std::fs::write(disk("locked").join("kept.txt"), b"kept").unwrap();
    std::fs::set_permissions(disk("locked"), std::fs::Permissions::from_mode(0o500)).unwrap();
    let locked = |name: &str| format!("{remote}/locked/{name}");
    let denied = [
        (
            mkdir(&locked("new")),
            "SFTP mkdir failed: permission denied",
        ),
        (
            Mutation::RemoveFile {
                path: locked("kept.txt"),
            },
            "SFTP remove failed: permission denied",
        ),
        (
            Mutation::Upload {
                path: locked("new.bin"),
                data: b"x".to_vec(),
                overwrite: false,
            },
            "SFTP open for writing failed: permission denied",
        ),
    ];
    for (mutation, expected) in denied {
        assert_eq!(change(mutation).await.unwrap_err(), expected);
    }
    std::fs::set_permissions(disk("locked"), std::fs::Permissions::from_mode(0o700)).unwrap();
    assert_eq!(
        std::fs::read(disk("locked").join("kept.txt")).unwrap(),
        b"kept"
    );

    // Switching back to read-only refuses writes again; closing ends it.
    service
        .sftp_set_writable("main", &grant, &scope, false)
        .unwrap();
    assert_eq!(change(mkdir(&folder)).await.unwrap_err(), READ_ONLY);
    service.sftp_close("main", &grant).unwrap();
    assert_eq!(change(mkdir(&folder)).await.unwrap_err(), SFTP_EXPIRED);
    let registry = service.registry.lock().unwrap();
    assert!(registry.active.is_empty() && registry.grants.is_empty());
}
