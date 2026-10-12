//! Grant-gated SFTP writes and downloads for the file panel (WindTerm F02–F07
//! prototype). Every operation takes the same path as a listing: it
//! reconnects, pins the confirmed host key, re-authenticates and classifies
//! failures with the existing revoke/keep rules.
//!
//! Write permission is a separate, explicit switch per grant: a grant starts
//! read-only and only [`Ssh::sftp_set_writable`] lets it change the server.
//! The switch records the user's intent and keeps a stray call from mutating
//! anything; it is not a boundary against a compromised WebView, which holds
//! the grant token anyway. Downloads only read the server and are allowed on
//! read-only grants.
//!
//! Cancellation drops the operation like every other SFTP request. A partial
//! local download is then removed. A cancelled new upload can leave its hidden
//! `.part` sibling (never a partial file under the final name); a cancelled
//! overwrite can leave the target incomplete.
use super::{PromptSink, SftpRequest, SftpResult, Ssh, DEADLINE, SFTP_EXPIRED};
use crate::sftp::{
    local::{self, Downloaded},
    write::{self, Progress, Writer},
    ReadOnlySftp, RemoteEntry,
};
use serde::Serialize;
use std::{
    path::PathBuf,
    sync::Arc,
    time::{Duration, Instant},
};

/// Write requests on a grant that was not switched to writable fail with this
/// before any connection; the grant itself stays valid.
pub const READ_ONLY: &str = "SFTP session is read-only; allow writes first";
/// Transfers move up to 64 MiB with [`crate::sftp::write::PIPELINE`] requests
/// in flight. A stalled peer still fails within the per-request and
/// connection inactivity timeouts; this only caps a slow but live transfer.
const TRANSFER_DEADLINE: Duration = Duration::from_secs(300);

/// Who asks, under which grant, and how to ask for keyboard-interactive
/// answers again when the grant needs them.
pub struct SftpCall {
    pub owner: String,
    pub id: String,
    pub grant: String,
    pub scope: String,
    pub prompts: Option<PromptSink>,
}

/// One remote change. Paths are absolute, as listings report them.
pub enum Mutation {
    Mkdir {
        path: String,
    },
    Rename {
        from: String,
        to: String,
    },
    RemoveFile {
        path: String,
    },
    RemoveDir {
        path: String,
    },
    Chmod {
        path: String,
        mode: u32,
    },
    Upload {
        path: String,
        data: Vec<u8>,
        overwrite: bool,
    },
}

impl Mutation {
    /// Everything checkable without the server, checked before connecting.
    fn validate(&self) -> Result<(), String> {
        match self {
            Self::Mkdir { path } | Self::RemoveFile { path } | Self::RemoveDir { path } => {
                write::validate_target(path)
            }
            Self::Rename { from, to } => {
                write::validate_target(from)?;
                write::validate_target(to)
            }
            Self::Chmod { path, mode } => {
                write::validate_target(path)?;
                write::validate_mode(*mode)
            }
            Self::Upload { path, data, .. } => write::validate_upload(path, data.len()),
        }
    }
}

pub(super) struct Change {
    mutation: Mutation,
    progress: Option<Progress>,
}

pub(super) struct Fetch {
    path: String,
    directory: PathBuf,
    progress: Option<Progress>,
}

/// Progress of one upload or download, sent only to the window that started it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferProgress {
    pub operation_id: String,
    pub transferred: u64,
    pub total: u64,
}

pub type ProgressSink = Arc<dyn Fn(TransferProgress) -> Result<(), String> + Send + Sync>;

/// A closed progress channel never fails the transfer itself.
pub(super) fn meter(operation_id: &str, sink: ProgressSink) -> Progress {
    let operation_id = operation_id.to_string();
    Arc::new(move |transferred, total| {
        let _ = sink(TransferProgress {
            operation_id: operation_id.clone(),
            transferred,
            total,
        });
    })
}

impl SftpRequest {
    pub(super) fn writes(&self) -> bool {
        match self {
            Self::Change(_) => true,
            Self::Scp(job) => job.writes(),
            _ => false,
        }
    }

    pub(super) fn deadline(&self) -> Duration {
        match self {
            Self::Fetch(_)
            | Self::Scp(_)
            | Self::Change(Change {
                mutation: Mutation::Upload { .. },
                ..
            }) => TRANSFER_DEADLINE,
            _ => DEADLINE,
        }
    }
}

pub(super) async fn apply(sftp: &ReadOnlySftp, change: Change) -> Result<SftpResult, String> {
    let writer = Writer::new(sftp);
    let entry = match change.mutation {
        Mutation::Mkdir { path } => writer.mkdir(&path).await.map(|()| None),
        Mutation::Rename { from, to } => writer.rename(&from, &to).await.map(|()| None),
        Mutation::RemoveFile { path } => writer.remove_file(&path).await.map(|()| None),
        Mutation::RemoveDir { path } => writer.remove_dir(&path).await.map(|()| None),
        Mutation::Chmod { path, mode } => writer.chmod(&path, mode).await.map(Some),
        Mutation::Upload {
            path,
            data,
            overwrite,
        } => writer
            .upload(&path, &data, overwrite, change.progress.as_ref())
            .await
            .map(Some),
    }?;
    Ok(SftpResult::Changed(entry))
}

pub(super) async fn fetch(sftp: &ReadOnlySftp, fetch: Fetch) -> Result<SftpResult, String> {
    local::download(sftp, &fetch.path, &fetch.directory, fetch.progress.as_ref())
        .await
        .map(SftpResult::Fetched)
}

impl Ssh {
    /// Switches one grant between read-only and writable. Bound to the
    /// owner and page scope like every grant use; idle time is not refreshed.
    pub fn sftp_set_writable(
        &self,
        owner: &str,
        grant: &str,
        scope: &str,
        writable: bool,
    ) -> Result<(), String> {
        let mut registry = self.registry.lock().map_err(|_| "SSH state unavailable")?;
        let now = Instant::now();
        registry.grants.retain(|_, grant| grant.alive(now));
        let entry = registry.grants.get_mut(grant).ok_or(SFTP_EXPIRED)?;
        if entry.owner != owner {
            return Err("SFTP session not owned by this window".into());
        }
        if entry.scope != scope {
            registry.grants.remove(grant);
            return Err(SFTP_EXPIRED.into());
        }
        entry.writable = writable;
        Ok(())
    }

    /// Applies one change through a writable grant. Chmod and upload return
    /// the entry as the server reports it afterwards.
    pub async fn sftp_mutate(
        &self,
        call: SftpCall,
        mutation: Mutation,
        progress: Option<ProgressSink>,
    ) -> Result<Option<RemoteEntry>, String> {
        mutation.validate()?;
        let progress = progress.map(|sink| meter(&call.id, sink));
        let request = SftpRequest::Change(Change { mutation, progress });
        match self.sftp_call(call, request).await? {
            SftpResult::Changed(entry) => Ok(entry),
            _ => Err("Unexpected SFTP result".into()),
        }
    }

    /// Saves one remote regular file into `directory` without overwriting.
    pub async fn sftp_download(
        &self,
        call: SftpCall,
        path: String,
        directory: PathBuf,
        progress: Option<ProgressSink>,
    ) -> Result<Downloaded, String> {
        // Fail before any network work when nothing could be saved anyway.
        local::check_directory(&directory)?;
        let progress = progress.map(|sink| meter(&call.id, sink));
        let request = SftpRequest::Fetch(Fetch {
            path,
            directory,
            progress,
        });
        match self.sftp_call(call, request).await? {
            SftpResult::Fetched(downloaded) => Ok(downloaded),
            _ => Err("Unexpected SFTP result".into()),
        }
    }

    async fn sftp_call(&self, call: SftpCall, request: SftpRequest) -> Result<SftpResult, String> {
        let SftpCall {
            owner,
            id,
            grant,
            scope,
            prompts,
        } = call;
        self.sftp_request(&owner, &id, &grant, &scope, request, prompts)
            .await
    }
}

#[cfg(test)]
#[path = "ssh_sftp_write_tests.rs"]
mod tests;
