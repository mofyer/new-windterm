//! Read-only SFTP capability slice for an authenticated Russh channel.
//!
//! This module deliberately does not own SSH authentication or expose mutating
//! filesystem operations. Callers provide an authenticated channel, and the
//! wrapper only permits directory listing, metadata, and bounded file reads.

use russh::{client, Channel};
use russh_sftp::{
    client::{fs::Metadata, SftpSession},
    protocol::FileType,
};
use serde::Serialize;
use tokio::io::AsyncReadExt;

const MAX_REMOTE_PATH_BYTES: usize = 4 * 1024;
const MAX_DIRECTORY_ENTRIES: usize = 4 * 1024;
pub const MAX_READ_BYTES: usize = 64 * 1024;

/// JSON-safe metadata exposed to the future desktop IPC layer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteEntry {
    pub name: String,
    pub path: String,
    pub kind: RemoteKind,
    pub size: u64,
    pub mode: Option<u32>,
    pub modified_unix_seconds: Option<u32>,
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

fn entry(name: String, path: String, metadata: Metadata) -> RemoteEntry {
    RemoteEntry {
        name,
        path,
        kind: metadata.file_type().into(),
        size: metadata.len(),
        mode: metadata.permissions,
        modified_unix_seconds: metadata.mtime,
    }
}

/// An authenticated SFTP subsystem with a read-only public surface.
pub struct ReadOnlySftp {
    session: SftpSession,
}

impl ReadOnlySftp {
    /// Starts the `sftp` subsystem on an already authenticated SSH channel.
    pub async fn from_channel(channel: Channel<client::Msg>) -> Result<Self, String> {
        channel
            .request_subsystem(true, "sftp")
            .await
            .map_err(|_| "SFTP subsystem request failed".to_string())?;
        let session = SftpSession::new(channel.into_stream())
            .await
            .map_err(|_| "SFTP subsystem initialization failed".to_string())?;
        Ok(Self { session })
    }

    /// Lists one remote directory, excluding the protocol's `.` and `..` rows.
    pub async fn list(&self, path: &str) -> Result<Vec<RemoteEntry>, String> {
        validate_path(path)?;
        let entries = self
            .session
            .read_dir(path)
            .await
            .map_err(|_| "SFTP directory listing failed".to_string())?;
        let entries: Vec<_> = entries
            .into_iter()
            .take(MAX_DIRECTORY_ENTRIES + 1)
            .collect();
        if entries.len() > MAX_DIRECTORY_ENTRIES {
            return Err("SFTP directory contains too many entries".into());
        }
        Ok(entries
            .into_iter()
            .map(|item| {
                let name = item.file_name();
                entry(name, item.path(), item.metadata())
            })
            .collect())
    }

    /// Reads metadata for one remote path without opening it for writing.
    pub async fn metadata(&self, path: &str) -> Result<RemoteEntry, String> {
        validate_path(path)?;
        let metadata = self
            .session
            .metadata(path)
            .await
            .map_err(|_| "SFTP metadata request failed".to_string())?;
        Ok(entry(
            path.rsplit('/').next().unwrap_or(path).to_string(),
            path.to_string(),
            metadata,
        ))
    }

    /// Reads at most [`MAX_READ_BYTES`] from a remote regular file.
    pub async fn read(&self, path: &str) -> Result<Vec<u8>, String> {
        validate_path(path)?;
        let metadata = self
            .session
            .metadata(path)
            .await
            .map_err(|_| "SFTP metadata request failed".to_string())?;
        if metadata.file_type() != FileType::File {
            return Err("SFTP read requires a regular file".into());
        }
        if metadata.len() > MAX_READ_BYTES as u64 {
            return Err("SFTP file exceeds the 64 KiB read limit".into());
        }
        let mut file = self
            .session
            .open(path)
            .await
            .map_err(|_| "SFTP file open failed".to_string())?;
        let mut bytes = Vec::with_capacity(metadata.len() as usize);
        let mut limited = (&mut file).take(MAX_READ_BYTES as u64 + 1);
        limited
            .read_to_end(&mut bytes)
            .await
            .map_err(|_| "SFTP file read failed".to_string())?;
        drop(limited);
        file.close()
            .await
            .map_err(|_| "SFTP file close failed".to_string())?;
        if bytes.len() > MAX_READ_BYTES {
            return Err("SFTP file exceeds the 64 KiB read limit".into());
        }
        Ok(bytes)
    }

    /// Closes the underlying SFTP channel.
    pub async fn close(self) -> Result<(), String> {
        self.session
            .close()
            .await
            .map_err(|_| "SFTP close failed".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
        let mut metadata = Metadata {
            size: Some(12),
            permissions: Some(0o100644),
            mtime: Some(42),
            ..Default::default()
        };
        metadata.set_regular(true);
        let result = entry("a.txt".into(), "/tmp/a.txt".into(), metadata);
        assert_eq!(result.kind, RemoteKind::File);
        assert_eq!(result.size, 12);
        assert_eq!(result.mode, Some(0o100644 | 0o100000));
        assert_eq!(result.modified_unix_seconds, Some(42));
    }
}
