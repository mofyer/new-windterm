//! Agent forwarding (C10) for one interactive SSH terminal. Off unless the
//! user turns it on for this connection; the choice is never saved.
//!
//! When it is on, the local agent's location (`$SSH_AUTH_SOCK`, or the
//! OpenSSH agent pipe on Windows) is read once and checked before any network
//! work. The terminal's session channel then asks for
//! `auth-agent-req@openssh.com`, and only this connection's [`Routes`] accept
//! the `auth-agent@openssh.com` channels the server opens; `KeyCheck` relays
//! each one to that location. While the terminal runs, the remote host can
//! ask the agent to sign with every key it holds, though it never reads a
//! private key. The routes end with the terminal, as port forwards do.
use super::super::{Login, Routes, Ssh};
use crate::pty::EventSink;
use russh::client;
use std::{path::PathBuf, sync::Arc};

/// Returned when the server answers the forwarding request with a failure.
pub(super) const REFUSED: &str = "SSH server refused agent forwarding";
const UNAVAILABLE: &str =
    "Agent forwarding needs a running local ssh-agent, and none answered; nothing was sent";
#[cfg(unix)]
const LOCAL_WAIT: std::time::Duration = std::time::Duration::from_secs(2);

/// Where the local agent listens, read once per terminal.
fn local_agent() -> Result<PathBuf, String> {
    #[cfg(unix)]
    {
        std::env::var_os("SSH_AUTH_SOCK")
            .filter(|path| !path.is_empty())
            .map(PathBuf::from)
            .ok_or_else(|| UNAVAILABLE.into())
    }
    #[cfg(windows)]
    {
        Ok(PathBuf::from(super::super::AGENT_PIPE))
    }
}

/// Fails unless the agent at `local` accepts a connection now. The relay
/// connects again for every channel the server opens.
async fn check_local(local: &std::path::Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        match tokio::time::timeout(LOCAL_WAIT, tokio::net::UnixStream::connect(local)).await {
            Ok(Ok(_)) => Ok(()),
            _ => Err(UNAVAILABLE.into()),
        }
    }
    #[cfg(windows)]
    {
        tokio::net::windows::named_pipe::ClientOptions::new()
            .open(local)
            .map(drop)
            .map_err(|_| UNAVAILABLE.into())
    }
}

/// Routes this connection's agent channels to `local`, then asks for
/// forwarding on the session channel. The caller waits for the server's
/// reply before the shell request; on a refusal it calls [`refused`].
pub(super) async fn request(
    channel: &russh::Channel<client::Msg>,
    routes: &Routes,
    local: PathBuf,
) -> Result<(), String> {
    // Routed first: the server may open a channel as soon as it replies,
    // before the caller has read that reply.
    routes.set_agent(Some(local));
    if channel.agent_forward(true).await.is_err() {
        routes.set_agent(None);
        return Err("SSH agent forwarding request failed".into());
    }
    Ok(())
}

/// The server did not confirm forwarding: no agent channel is accepted, and
/// the open fails with [`REFUSED`] when the server said no.
pub(super) fn refused(routes: &Routes, error: String) -> String {
    routes.set_agent(None);
    if error == super::REJECTED {
        REFUSED.into()
    } else {
        error
    }
}

impl Ssh {
    /// [`Ssh::open_with`], also forwarding the local ssh-agent to this
    /// terminal's connection when `agent` is set. Fails, and opens nothing,
    /// if no local agent answers or the server refuses.
    #[allow(clippy::too_many_arguments)]
    pub async fn open_with_agent(
        self: &Arc<Self>,
        owner: &str,
        id: &str,
        token: &str,
        scope: &str,
        login: impl Into<Login>,
        cols: u16,
        rows: u16,
        sink: EventSink,
        agent: bool,
    ) -> Result<String, String> {
        let local = match agent {
            true => {
                let local = local_agent()?;
                check_local(&local).await?;
                Some(local)
            }
            false => None,
        };
        let size = (cols, rows);
        self.open_session(owner, id, token, scope, login, size, sink, None, local)
            .await
    }
}
