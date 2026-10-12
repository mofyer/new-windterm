//! Remote mutations for the SFTP prototype (WindTerm F03–F07): create a
//! directory, rename, remove a file or one empty directory, change permission
//! bits and upload one file. None of this is reachable from `ReadOnlySftp`
//! itself; callers build a [`Writer`] explicitly, and the IPC layer only does
//! so for a grant the user switched to writable.
//!
//! SFTP v3 reports "already exists" and "directory not empty" only as a
//! generic failure, so existence is checked with `lstat` first to give clearer
//! errors. That check is advisory: the request itself stays authoritative
//! (exclusive create; OpenSSH's v3 rename refuses an existing target, while
//! some other servers replace it, so a race there is server-specific).

use super::{base_name, entry, validate_path, ReadOnlySftp, RemoteEntry, RemoteKind};
use russh_sftp::{
    client::{error::Error, RawSftpSession},
    protocol::{FileAttributes, FileType, OpenFlags, StatusCode},
};
use std::{future::Future, pin::Pin, sync::Arc, task::Poll};

/// Upload bytes arrive whole over IPC, so they are bounded before any work.
pub const MAX_UPLOAD_BYTES: usize = 16 * 1024 * 1024;
const WRITE_CHUNK: usize = 32 * 1024;
/// Requests sent together before waiting, so a transfer needs one round trip
/// per `PIPELINE` chunks instead of one per chunk.
pub(super) const PIPELINE: usize = 8;
/// A new upload is written under a hidden sibling name ending in this suffix
/// and renamed into place only after its size was verified.
pub const PARTIAL_SUFFIX: &str = ".part";
/// Progress is reported at most once per this many bytes, plus at the end.
pub const PROGRESS_STEP: u64 = 256 * 1024;
/// Only rwx bits: setuid, setgid and sticky are refused in P0.
pub const PERMISSION_BITS: u32 = 0o777;
const MAX_NAME_BYTES: usize = 255;

/// `(transferred, total)` byte counts of one transfer.
pub type Progress = Arc<dyn Fn(u64, u64) + Send + Sync>;

/// Throttles progress callbacks to one per [`PROGRESS_STEP`] plus the last.
pub(crate) struct Meter<'a> {
    progress: Option<&'a Progress>,
    total: u64,
    reported: u64,
}

impl<'a> Meter<'a> {
    pub(crate) fn new(progress: Option<&'a Progress>, total: u64) -> Self {
        Self {
            progress,
            total,
            reported: 0,
        }
    }

    pub(crate) fn update(&mut self, done: u64) {
        let Some(progress) = self.progress else {
            return;
        };
        if done == self.total || done.saturating_sub(self.reported) >= PROGRESS_STEP {
            self.reported = done;
            progress(done, self.total);
        }
    }
}

/// Polls `requests` together, so each one is sent before any reply is awaited,
/// and returns their results in order. Callers pass at most [`PIPELINE`].
pub(super) async fn batch<F: Future>(requests: Vec<F>) -> Vec<F::Output> {
    let mut pending: Vec<Pin<Box<F>>> = requests.into_iter().map(Box::pin).collect();
    let mut outputs: Vec<Option<F::Output>> = pending.iter().map(|_| None).collect();
    std::future::poll_fn(|cx| {
        let mut ready = true;
        for (request, output) in pending.iter_mut().zip(outputs.iter_mut()) {
            if output.is_none() {
                match request.as_mut().poll(cx) {
                    Poll::Ready(value) => *output = Some(value),
                    Poll::Pending => ready = false,
                }
            }
        }
        if ready {
            Poll::Ready(())
        } else {
            Poll::Pending
        }
    })
    .await;
    outputs.into_iter().flatten().collect()
}

/// `/dir/.name.<8 hex>.part` beside `path`, within the 255-byte name limit.
fn partial_path(path: &str) -> String {
    let (parent, name) = path.rsplit_once('/').unwrap_or(("", path));
    let tag = uuid::Uuid::new_v4().simple().to_string();
    let extra = 1 + 1 + 8 + PARTIAL_SUFFIX.len();
    let mut end = name.len().min(MAX_NAME_BYTES - extra);
    while !name.is_char_boundary(end) {
        end -= 1;
    }
    format!("{parent}/.{}.{}{PARTIAL_SUFFIX}", &name[..end], &tag[..8])
}

/// Server status text is never shown: it is untrusted, unbounded and may
/// carry server-side paths. The status code alone selects the explanation.
pub(super) fn describe(action: &str, error: &Error) -> String {
    let reason = match error {
        Error::Status(status) => match status.status_code {
            StatusCode::NoSuchFile => "no such file or directory",
            StatusCode::PermissionDenied => "permission denied",
            StatusCode::OpUnsupported => "not supported by the server",
            _ => "the server refused the request",
        },
        Error::Timeout => "the server did not answer in time",
        _ => "the SFTP session failed",
    };
    format!("SFTP {action} failed: {reason}")
}

fn is_missing(error: &Error) -> bool {
    matches!(error, Error::Status(status) if status.status_code == StatusCode::NoSuchFile)
}

/// Write targets are absolute, normalized paths whose last component is a
/// usable name. Listings already supply such paths, so anything else is a
/// caller bug and is refused before any network work.
pub fn validate_target(path: &str) -> Result<(), String> {
    validate_path(path)?;
    let Some(relative) = path.strip_prefix('/') else {
        return Err("Remote write paths must be absolute".into());
    };
    if relative.is_empty()
        || relative
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
    {
        return Err("Invalid remote write path".into());
    }
    if base_name(path).len() > MAX_NAME_BYTES {
        return Err("Remote file name is too long".into());
    }
    Ok(())
}

pub fn validate_mode(mode: u32) -> Result<(), String> {
    if mode & !PERMISSION_BITS != 0 {
        return Err("Only permission bits 000-777 can be changed".into());
    }
    Ok(())
}

pub fn validate_upload(path: &str, length: usize) -> Result<(), String> {
    validate_target(path)?;
    if length > MAX_UPLOAD_BYTES {
        return Err("Upload exceeds the 16 MiB limit".into());
    }
    Ok(())
}

/// The mutating surface of one SFTP session.
pub struct Writer<'a> {
    session: &'a RawSftpSession,
}

impl<'a> Writer<'a> {
    pub fn new(sftp: &'a ReadOnlySftp) -> Self {
        Self {
            session: &sftp.session,
        }
    }

    /// The kind of `path` itself (symbolic links are not followed).
    async fn kind(&self, path: &str) -> Result<Option<RemoteKind>, String> {
        match self.session.lstat(path).await {
            Ok(attrs) => Ok(Some(attrs.attrs.file_type().into())),
            Err(error) if is_missing(&error) => Ok(None),
            Err(error) => Err(describe("metadata request", &error)),
        }
    }

    async fn existing(&self, path: &str, action: &str) -> Result<RemoteKind, String> {
        self.kind(path)
            .await?
            .ok_or_else(|| format!("SFTP {action} failed: no such file or directory"))
    }

    async fn absent(&self, path: &str) -> Result<(), String> {
        match self.kind(path).await? {
            None => Ok(()),
            Some(_) => Err("Remote path already exists".into()),
        }
    }

    async fn entry(&self, path: &str) -> Result<RemoteEntry, String> {
        let attrs = self
            .session
            .lstat(path)
            .await
            .map_err(|error| describe("metadata request", &error))?
            .attrs;
        Ok(entry(base_name(path).to_string(), &attrs))
    }

    /// Creates one directory with the server's default permissions.
    pub async fn mkdir(&self, path: &str) -> Result<(), String> {
        validate_target(path)?;
        self.absent(path).await?;
        self.session
            .mkdir(path, FileAttributes::empty())
            .await
            .map(drop)
            .map_err(|error| describe("mkdir", &error))
    }

    /// Renames without replacing an existing target.
    pub async fn rename(&self, from: &str, to: &str) -> Result<(), String> {
        validate_target(from)?;
        validate_target(to)?;
        if from == to {
            return Err("Source and target are the same".into());
        }
        self.existing(from, "rename").await?;
        self.absent(to).await?;
        self.session
            .rename(from, to)
            .await
            .map(drop)
            .map_err(|error| describe("rename", &error))
    }

    /// Removes a regular file, or a symbolic link itself (never its target).
    pub async fn remove_file(&self, path: &str) -> Result<(), String> {
        validate_target(path)?;
        match self.existing(path, "remove").await? {
            RemoteKind::File | RemoteKind::Symlink => {}
            RemoteKind::Directory => {
                return Err("This is a directory; remove it as an empty directory".into())
            }
            RemoteKind::Other => {
                return Err("P0 removes only regular files and symbolic links".into())
            }
        }
        self.session
            .remove(path)
            .await
            .map(drop)
            .map_err(|error| describe("remove", &error))
    }

    /// Removes one empty directory. There is no recursive delete in P0.
    pub async fn remove_dir(&self, path: &str) -> Result<(), String> {
        validate_target(path)?;
        if self.existing(path, "rmdir").await? != RemoteKind::Directory {
            return Err("Only a directory can be removed this way".into());
        }
        self.session
            .rmdir(path)
            .await
            .map(drop)
            .map_err(|error| match &error {
                Error::Status(status) if status.status_code == StatusCode::Failure => {
                    "SFTP rmdir failed: the directory is not empty or cannot be removed".into()
                }
                _ => describe("rmdir", &error),
            })
    }

    /// Sets the permission bits of a file or directory and returns what the
    /// server reports afterwards, which can differ if it ignores some bits.
    pub async fn chmod(&self, path: &str, mode: u32) -> Result<RemoteEntry, String> {
        validate_target(path)?;
        validate_mode(mode)?;
        match self.existing(path, "chmod").await? {
            RemoteKind::File | RemoteKind::Directory => {}
            RemoteKind::Symlink => {
                return Err("P0 does not change permissions through symbolic links".into())
            }
            RemoteKind::Other => {
                return Err("P0 changes permissions only on files and directories".into())
            }
        }
        let attrs = FileAttributes {
            permissions: Some(mode),
            ..FileAttributes::empty()
        };
        self.session
            .setstat(path, attrs)
            .await
            .map_err(|error| describe("chmod", &error))?;
        self.entry(path).await
    }

    /// Writes `data` as one remote regular file in pipelined chunks and
    /// returns the entry the server reports afterwards, whose size must equal
    /// `data.len()`.
    ///
    /// A path that does not exist is created through [`Self::upload_new`],
    /// even with `overwrite`; `overwrite` only ever replaces an existing
    /// regular file, truncated in place, which keeps its permissions but
    /// cannot restore the old content after a failure or cancellation.
    pub async fn upload(
        &self,
        path: &str,
        data: &[u8],
        overwrite: bool,
        progress: Option<&Progress>,
    ) -> Result<RemoteEntry, String> {
        validate_upload(path, data.len())?;
        match (self.kind(path).await?, overwrite) {
            (None, _) => self.upload_new(path, data, progress).await?,
            (Some(RemoteKind::File), true) => self.upload_over(path, data, progress).await?,
            (Some(_), true) => {
                return Err("Only an existing regular file can be overwritten".into())
            }
            (Some(_), false) => return Err("Remote path already exists".into()),
        }
        self.entry(path).await
    }

    /// Writes a hidden sibling created exclusively, verifies its size and
    /// renames it into place without replacing anything, so the final name
    /// never holds partial content. Failures remove the sibling (exclusive
    /// creation proves it is ours); cancellation drops this future, which can
    /// leave the sibling behind.
    async fn upload_new(
        &self,
        path: &str,
        data: &[u8],
        progress: Option<&Progress>,
    ) -> Result<(), String> {
        let partial = partial_path(path);
        let flags = OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::EXCLUDE;
        let handle = self.open_for_writing(&partial, flags).await?;
        let placed = async {
            self.fill(handle, data, progress).await?;
            self.verify_size(&partial, data.len() as u64).await?;
            if let Err(error) = self.session.rename(&partial, path).await {
                return Err(match self.kind(path).await {
                    Ok(Some(_)) => "Remote path already exists".into(),
                    _ => describe("rename into place", &error),
                });
            }
            Ok(())
        }
        .await;
        if let Err(error) = placed {
            return Err(match self.session.remove(&partial).await {
                Ok(_) => error,
                Err(_) => format!("{error}; a hidden {PARTIAL_SUFFIX} file may remain"),
            });
        }
        Ok(())
    }

    /// Truncates and rewrites an existing regular file. Without `CREATE`, a
    /// file removed meanwhile fails instead of being recreated.
    async fn upload_over(
        &self,
        path: &str,
        data: &[u8],
        progress: Option<&Progress>,
    ) -> Result<(), String> {
        let handle = self
            .open_for_writing(path, OpenFlags::WRITE | OpenFlags::TRUNCATE)
            .await?;
        let written = async {
            self.fill(handle, data, progress).await?;
            self.verify_size(path, data.len() as u64).await
        }
        .await;
        written.map_err(|error| format!("{error}; the remote file may now be incomplete"))
    }

    async fn open_for_writing(&self, path: &str, flags: OpenFlags) -> Result<String, String> {
        self.session
            .open(path, flags, FileAttributes::empty())
            .await
            .map(|handle| handle.handle)
            .map_err(|error| describe("open for writing", &error))
    }

    /// Writes everything, then closes the handle even after a failure; a
    /// failed close can mean a failed flush, so it fails the upload too.
    async fn fill(
        &self,
        handle: String,
        data: &[u8],
        progress: Option<&Progress>,
    ) -> Result<(), String> {
        let written = self.write_all(&handle, data, progress).await;
        let closed = self
            .session
            .close(handle)
            .await
            .map(drop)
            .map_err(|error| describe("close", &error));
        written.and(closed)
    }

    async fn write_all(
        &self,
        handle: &str,
        data: &[u8],
        progress: Option<&Progress>,
    ) -> Result<(), String> {
        let mut meter = Meter::new(progress, data.len() as u64);
        let mut offset = 0u64;
        for window in data.chunks(WRITE_CHUNK * PIPELINE) {
            let chunks: Vec<&[u8]> = window.chunks(WRITE_CHUNK).collect();
            let mut at = offset;
            let requests: Vec<_> = chunks
                .iter()
                .map(|chunk| {
                    let request = self.session.write(handle, at, chunk.to_vec());
                    at += chunk.len() as u64;
                    request
                })
                .collect();
            for (chunk, result) in chunks.iter().zip(batch(requests).await) {
                result.map_err(|error| describe("write", &error))?;
                offset += chunk.len() as u64;
                meter.update(offset);
            }
        }
        Ok(())
    }

    /// Checked by path after the handle is closed: `stat`-family requests on
    /// a path are mandatory in SFTP v3, and the close has flushed the data.
    async fn verify_size(&self, path: &str, expected: u64) -> Result<(), String> {
        let attrs = self
            .session
            .lstat(path)
            .await
            .map_err(|error| describe("size check", &error))?
            .attrs;
        if attrs.file_type() != FileType::File || attrs.size != Some(expected) {
            return Err("Uploaded size does not match the source".into());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use russh_sftp::protocol::Status;
    use std::sync::Mutex;

    #[test]
    fn write_targets_are_absolute_normalized_and_named() {
        for good in ["/tmp/a", "/home/用户/新 目录", "/x"] {
            assert!(validate_target(good).is_ok(), "{good}");
        }
        for bad in [
            "relative/a",
            "/",
            "/tmp/",
            "/tmp//a",
            "/tmp/./a",
            "/tmp/../a",
            "/tmp/..",
            "/tmp/a\nb",
            "",
        ] {
            assert!(validate_target(bad).is_err(), "{bad:?}");
        }
        let long = format!("/tmp/{}", "n".repeat(MAX_NAME_BYTES + 1));
        assert_eq!(
            validate_target(&long).unwrap_err(),
            "Remote file name is too long"
        );
    }

    #[test]
    fn only_rwx_bits_and_bounded_uploads_are_accepted() {
        assert!(validate_mode(0o755).is_ok());
        assert!(validate_mode(0).is_ok());
        for mode in [0o1777, 0o2755, 0o4755, 0o100644] {
            assert!(validate_mode(mode).is_err(), "{mode:o}");
        }
        assert!(validate_upload("/tmp/a", MAX_UPLOAD_BYTES).is_ok());
        assert_eq!(
            validate_upload("/tmp/a", MAX_UPLOAD_BYTES + 1).unwrap_err(),
            "Upload exceeds the 16 MiB limit"
        );
        assert!(validate_upload("tmp/a", 0).is_err());
    }

    #[test]
    fn errors_map_status_codes_without_server_text() {
        let status = |status_code| {
            Error::Status(Status {
                id: 1,
                status_code,
                error_message: "/secret/server/path".into(),
                language_tag: "en".into(),
            })
        };
        assert_eq!(
            describe("mkdir", &status(StatusCode::PermissionDenied)),
            "SFTP mkdir failed: permission denied"
        );
        assert_eq!(
            describe("rename", &status(StatusCode::NoSuchFile)),
            "SFTP rename failed: no such file or directory"
        );
        let generic = describe("write", &status(StatusCode::Failure));
        assert_eq!(generic, "SFTP write failed: the server refused the request");
        assert!(!generic.contains("secret"));
        assert!(is_missing(&status(StatusCode::NoSuchFile)));
        assert!(!is_missing(&status(StatusCode::Failure)));
        assert_eq!(
            describe("read", &Error::Timeout),
            "SFTP read failed: the server did not answer in time"
        );
    }

    #[tokio::test]
    async fn batches_poll_every_request_before_any_reply_and_keep_order() {
        // Each request waits until all of them have started, so awaiting
        // them one at a time would never finish.
        let barrier = Arc::new(tokio::sync::Barrier::new(PIPELINE));
        let requests = (0..PIPELINE)
            .map(|index| {
                let barrier = barrier.clone();
                async move {
                    barrier.wait().await;
                    // Finish in reverse order of submission.
                    tokio::time::sleep(std::time::Duration::from_millis((PIPELINE - index) as u64))
                        .await;
                    index
                }
            })
            .collect();
        let results = tokio::time::timeout(std::time::Duration::from_secs(5), batch(requests))
            .await
            .unwrap();
        assert_eq!(results, (0..PIPELINE).collect::<Vec<_>>());
        assert!(batch(Vec::<std::future::Ready<()>>::new()).await.is_empty());
    }

    #[test]
    fn partial_names_are_hidden_siblings_within_the_name_limit() {
        let partial = partial_path("/home/用户/上传 🌏.bin");
        let name = partial.strip_prefix("/home/用户/.上传 🌏.bin.").unwrap();
        let tag = name.strip_suffix(PARTIAL_SUFFIX).unwrap();
        assert!(tag.len() == 8 && tag.bytes().all(|byte| byte.is_ascii_hexdigit()));
        assert_ne!(partial, partial_path("/home/用户/上传 🌏.bin"));
        assert!(partial_path("/x").starts_with("/.x."));
        let long = format!("/d/{}", "文".repeat(85));
        let partial = partial_path(&long);
        assert!(validate_target(&partial).is_ok());
        assert!(base_name(&partial).len() <= MAX_NAME_BYTES);
        assert!(partial.ends_with(PARTIAL_SUFFIX));
    }

    #[test]
    fn progress_is_throttled_and_always_reports_completion() {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let sink = seen.clone();
        let progress: Progress =
            Arc::new(move |done, total| sink.lock().unwrap().push((done, total)));
        let total = PROGRESS_STEP * 2 + 10;
        let mut meter = Meter::new(Some(&progress), total);
        let mut done = 0;
        while done < total {
            done = (done + 32 * 1024).min(total);
            meter.update(done);
        }
        assert_eq!(
            *seen.lock().unwrap(),
            [
                (PROGRESS_STEP, total),
                (PROGRESS_STEP * 2, total),
                (total, total)
            ]
        );
        // No sink: updates are no-ops.
        Meter::new(None, 1).update(1);
    }
}
