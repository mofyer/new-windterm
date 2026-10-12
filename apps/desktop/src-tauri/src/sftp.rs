//! Read-only SFTP capability slice for an authenticated Russh channel.
//!
//! This module deliberately does not own SSH authentication. Callers provide
//! an authenticated channel, and `ReadOnlySftp` itself only permits path
//! resolution, directory listing, metadata, and bounded file reads. It drives
//! the raw protocol so a listing can stop as soon as its budget is reached
//! instead of first collecting the whole directory.
//!
//! Mutations live in [`write`] behind a separate `Writer` that callers must
//! obtain explicitly; streamed downloads to the local disk live in [`local`].

#[path = "sftp_local.rs"]
pub mod local;
#[path = "sftp_write.rs"]
pub mod write;

use russh::{client, Channel};
use russh_sftp::{
    client::{error::Error, RawSftpSession},
    protocol::{FileAttributes, FileType, OpenFlags, StatusCode},
};
use serde::Serialize;

const MAX_REMOTE_PATH_BYTES: usize = 4 * 1024;
pub const MAX_DIRECTORY_ENTRIES: usize = 4 * 1024;
/// Retained file-name bytes per listing. This bounds what is kept, not what is
/// decoded: each `readdir` page (a packet of at most 256 KiB by the russh-sftp
/// default) is decoded in full, including `longname`, before rows are checked,
/// so the transient peak is a small multiple of 256 KiB. The russh channel's
/// own receive buffering is separate; the whole operation has a 15 s deadline.
pub const MAX_LISTING_NAME_BYTES: usize = 1024 * 1024;
/// Every non-final page carries at least one row, so a well-formed listing
/// within the entry budget needs at most this many pages (plus `.` and `..`).
const MAX_DIRECTORY_PAGES: usize = MAX_DIRECTORY_ENTRIES + 2;
pub const MAX_READ_BYTES: usize = 64 * 1024;
const READ_CHUNK: usize = 32 * 1024;
const SFTP_VERSION: u32 = 3;

/// JSON-safe metadata exposed to the desktop IPC layer. Paths are not repeated
/// per entry; callers join a listing's `path` with `name`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteEntry {
    pub name: String,
    pub kind: RemoteKind,
    pub size: u64,
    pub mode: Option<u32>,
    pub modified_unix_seconds: Option<u32>,
}

/// One directory listing. `truncated` means the server had more rows than the
/// entry or name-byte budget allowed; the remaining rows were never read.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteListing {
    pub path: String,
    pub entries: Vec<RemoteEntry>,
    pub truncated: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum RemoteKind {
    Directory,
    File,
    Symlink,
    Other,
}

impl From<FileType> for RemoteKind {
    fn from(value: FileType) -> Self {
        match value {
            FileType::Dir => Self::Directory,
            FileType::File => Self::File,
            FileType::Symlink => Self::Symlink,
            FileType::Other => Self::Other,
        }
    }
}

fn validate_path(path: &str) -> Result<(), String> {
    if path.is_empty() || path.len() > MAX_REMOTE_PATH_BYTES || path.contains('\0') {
        return Err("Invalid remote path".into());
    }
    if path.chars().any(char::is_control) {
        return Err("Invalid remote path".into());
    }
    Ok(())
}

/// The last path component, used as a display name for single-path results.
fn base_name(path: &str) -> &str {
    path.trim_end_matches('/')
        .rsplit('/')
        .next()
        .filter(|name| !name.is_empty())
        .unwrap_or(path)
}

fn entry(name: String, metadata: &FileAttributes) -> RemoteEntry {
    RemoteEntry {
        name,
        kind: metadata.file_type().into(),
        size: metadata.len(),
        mode: metadata.permissions,
        modified_unix_seconds: metadata.mtime,
    }
}

fn is_eof(error: &Error) -> bool {
    matches!(error, Error::Status(status) if status.status_code == StatusCode::Eof)
}

/// Accumulates directory rows under fixed entry and name-byte budgets.
struct ListingBudget {
    entries: Vec<RemoteEntry>,
    name_bytes: usize,
}

impl ListingBudget {
    fn new() -> Self {
        Self {
            entries: Vec::new(),
            name_bytes: 0,
        }
    }

    /// Returns `Ok(false)` once the next row would exceed a budget.
    fn push(&mut self, name: String, attrs: &FileAttributes) -> Result<bool, String> {
        if name == "." || name == ".." {
            return Ok(true);
        }
        if name.is_empty() || name.contains('/') || name.contains('\0') {
            return Err("SFTP server returned an invalid file name".into());
        }
        if self.entries.len() == MAX_DIRECTORY_ENTRIES
            || self.name_bytes + name.len() > MAX_LISTING_NAME_BYTES
        {
            return Ok(false);
        }
        self.name_bytes += name.len();
        self.entries.push(entry(name, attrs));
        Ok(true)
    }
}

/// An authenticated SFTP subsystem with a read-only public surface.
pub struct ReadOnlySftp {
    session: RawSftpSession,
}

impl ReadOnlySftp {
    /// Starts the `sftp` subsystem on an already authenticated SSH channel.
    pub async fn from_channel(channel: Channel<client::Msg>) -> Result<Self, String> {
        channel
            .request_subsystem(true, "sftp")
            .await
            .map_err(|_| "SFTP subsystem request failed".to_string())?;
        let session = RawSftpSession::new(channel.into_stream());
        let version = session
            .init()
            .await
            .map_err(|_| "SFTP subsystem initialization failed".to_string())?;
        if version.version != SFTP_VERSION {
            return Err("Unsupported SFTP protocol version".into());
        }
        Ok(Self { session })
    }

    /// Resolves a remote path, such as `.` for the login directory.
    pub async fn canonicalize(&self, path: &str) -> Result<String, String> {
        validate_path(path)?;
        let resolved = self
            .session
            .realpath(path)
            .await
            .map_err(|_| "SFTP path resolution failed".to_string())?
            .files
            .into_iter()
            .next()
            .ok_or("SFTP path resolution failed")?
            .filename;
        validate_path(&resolved)?;
        Ok(resolved)
    }

    /// Lists one remote directory, excluding the protocol's `.` and `..` rows.
    pub async fn list(&self, path: &str) -> Result<RemoteListing, String> {
        validate_path(path)?;
        let handle = self
            .session
            .opendir(path)
            .await
            .map_err(|_| "SFTP directory listing failed".to_string())?
            .handle;
        let result = self.collect(&handle).await;
        // Release the server handle on success, truncation and failure alike. A
        // failed close does not invalidate rows already read; the whole SFTP
        // session is torn down right after every operation.
        let _ = self.session.close(handle).await;
        let (entries, truncated) = result?;
        Ok(RemoteListing {
            path: path.to_string(),
            entries,
            truncated,
        })
    }

    async fn collect(&self, handle: &str) -> Result<(Vec<RemoteEntry>, bool), String> {
        let mut budget = ListingBudget::new();
        for _ in 0..MAX_DIRECTORY_PAGES {
            let page = match self.session.readdir(handle).await {
                Ok(page) => page.files,
                Err(error) if is_eof(&error) => return Ok((budget.entries, false)),
                Err(_) => return Err("SFTP directory listing failed".into()),
            };
            if page.is_empty() {
                return Err("SFTP server returned an empty directory page".into());
            }
            for file in page {
                if !budget.push(file.filename, &file.attrs)? {
                    return Ok((budget.entries, true));
                }
            }
        }
        Err("SFTP server returned too many directory pages".into())
    }

    /// Reads metadata for one remote path, following symbolic links.
    pub async fn metadata(&self, path: &str) -> Result<RemoteEntry, String> {
        validate_path(path)?;
        let attrs = self
            .session
            .stat(path)
            .await
            .map_err(|_| "SFTP metadata request failed".to_string())?
            .attrs;
        Ok(entry(base_name(path).to_string(), &attrs))
    }

    /// Reads at most [`MAX_READ_BYTES`] from a remote regular file.
    pub async fn read(&self, path: &str) -> Result<Vec<u8>, String> {
        validate_path(path)?;
        let attrs = self
            .session
            .stat(path)
            .await
            .map_err(|_| "SFTP metadata request failed".to_string())?
            .attrs;
        if attrs.file_type() != FileType::File {
            return Err("SFTP read requires a regular file".into());
        }
        if attrs.len() > MAX_READ_BYTES as u64 {
            return Err("SFTP file exceeds the 64 KiB read limit".into());
        }
        let handle = self
            .session
            .open(path, OpenFlags::READ, FileAttributes::empty())
            .await
            .map_err(|_| "SFTP file open failed".to_string())?
            .handle;
        let result = self.read_handle(&handle).await;
        // As with listings, the session is closed right after this operation.
        let _ = self.session.close(handle).await;
        let bytes = result?;
        // Short or grown content means the file changed after `stat`, or the
        // server ended early without an EOF status; never return it as whole.
        if bytes.len() as u64 != attrs.len() {
            return Err("SFTP file changed during read; retry".into());
        }
        Ok(bytes)
    }

    async fn read_handle(&self, handle: &str) -> Result<Vec<u8>, String> {
        let mut bytes = Vec::new();
        loop {
            // Request one byte past the limit so growth after `stat` is caught.
            let wanted = (MAX_READ_BYTES + 1 - bytes.len()).min(READ_CHUNK);
            let data = match self
                .session
                .read(handle, bytes.len() as u64, wanted as u32)
                .await
            {
                Ok(data) => data.data,
                Err(error) if is_eof(&error) => return Ok(bytes),
                Err(_) => return Err("SFTP file read failed".into()),
            };
            if data.is_empty() {
                return Ok(bytes);
            }
            if data.len() > wanted {
                return Err("SFTP server returned more data than requested".into());
            }
            bytes.extend_from_slice(&data);
            if bytes.len() > MAX_READ_BYTES {
                return Err("SFTP file exceeds the 64 KiB read limit".into());
            }
        }
    }

    /// Closes the underlying SFTP channel.
    pub async fn close(self) -> Result<(), String> {
        self.session
            .close_session()
            .map_err(|_| "SFTP close failed".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn regular(size: u64) -> FileAttributes {
        let mut attrs = FileAttributes {
            size: Some(size),
            ..Default::default()
        };
        attrs.set_regular(true);
        attrs
    }

    #[test]
    fn paths_are_bounded_and_reject_control_bytes() {
        assert!(validate_path("/tmp/fixture").is_ok());
        assert!(validate_path("").is_err());
        assert!(validate_path("/tmp/\0fixture").is_err());
        assert!(validate_path("/tmp/\nfixture").is_err());
        assert!(validate_path(&"x".repeat(MAX_REMOTE_PATH_BYTES + 1)).is_err());
    }

    #[test]
    fn metadata_is_projected_without_write_fields() {
        let mut metadata = FileAttributes {
            size: Some(12),
            permissions: Some(0o100644),
            mtime: Some(42),
            ..Default::default()
        };
        metadata.set_regular(true);
        let result = entry("a.txt".into(), &metadata);
        assert_eq!(result.kind, RemoteKind::File);
        assert_eq!(result.size, 12);
        assert_eq!(result.mode, Some(0o100644 | 0o100000));
        assert_eq!(result.modified_unix_seconds, Some(42));
    }

    #[test]
    fn listing_budget_skips_dot_rows_and_stops_at_entry_limit() {
        let mut budget = ListingBudget::new();
        assert!(budget.push(".".into(), &regular(0)).unwrap());
        assert!(budget.push("..".into(), &regular(0)).unwrap());
        for index in 0..MAX_DIRECTORY_ENTRIES {
            assert!(budget.push(format!("f{index}"), &regular(1)).unwrap());
        }
        assert!(!budget.push("one-more".into(), &regular(1)).unwrap());
        assert_eq!(budget.entries.len(), MAX_DIRECTORY_ENTRIES);
    }

    #[test]
    fn listing_budget_stops_at_name_bytes_before_retaining_them() {
        let mut budget = ListingBudget::new();
        let long = "n".repeat(MAX_LISTING_NAME_BYTES / 2);
        assert!(budget.push(long.clone(), &regular(1)).unwrap());
        assert!(budget.push(long, &regular(1)).unwrap());
        assert!(!budget.push("x".into(), &regular(1)).unwrap());
        assert_eq!(budget.name_bytes, MAX_LISTING_NAME_BYTES);
    }

    #[test]
    fn listing_budget_rejects_names_that_would_escape_the_directory() {
        for name in ["", "a/b", "../x", "a\0b"] {
            assert!(ListingBudget::new().push(name.into(), &regular(1)).is_err());
        }
    }
}
