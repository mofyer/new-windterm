//! Platform policy for the P0 local shell. Shared session/ACK logic stays in pty.
//! Windows ConPTY and Linux shell/cancellation adapters are planned, not enabled.
use portable_pty::{CommandBuilder, MasterPty};

const UNSUPPORTED: &str = "P0 local PTY is currently enabled only on macOS; Windows ConPTY and Linux adapters are pending";

pub(crate) fn ensure_supported() -> Result<(), String> {
    if cfg!(target_os = "macos") {
        Ok(())
    } else {
        Err(UNSUPPORTED.into())
    }
}

#[cfg(target_os = "macos")]
pub(crate) fn configure_io(master: &dyn MasterPty) -> Result<(), String> {
    let fd = master.as_raw_fd().ok_or("PTY has no native descriptor")?;
    // SAFETY: fd belongs to the live master. F_GETFL/F_SETFL do not retain it;
    // duplicated reader/writer handles share O_NONBLOCK and poll cancellation.
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
        return Err(std::io::Error::last_os_error().to_string());
    }
    Ok(())
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn configure_io(_master: &dyn MasterPty) -> Result<(), String> {
    Err(UNSUPPORTED.into())
}

#[cfg(target_os = "macos")]
pub(crate) fn local_command() -> Result<CommandBuilder, String> {
    let mut command = CommandBuilder::new("/bin/zsh");
    command.args(["-f", "-i"]);
    command.env_clear();
    command.env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin");
    command.env("TERM", "xterm-256color");
    command.env("LANG", "en_US.UTF-8");
    command.env("LC_CTYPE", "UTF-8");
    command.env("PROMPT", "P0 %~ %# ");
    command.env("HISTFILE", "/dev/null");
    command.env("ZDOTDIR", "/var/empty");
    command.cwd("/tmp");
    if let Some(home) = std::env::var_os("HOME") {
        command.env("HOME", home);
    }
    Ok(command)
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn local_command() -> Result<CommandBuilder, String> {
    Err(UNSUPPORTED.into())
}

// Unix PTY EIO is an EOF convention; raw Windows error 5 has a different meaning.
#[cfg(unix)]
pub(crate) fn is_pty_eof(error: &std::io::Error) -> bool {
    error.raw_os_error() == Some(libc::EIO)
}

#[cfg(not(unix))]
pub(crate) fn is_pty_eof(_error: &std::io::Error) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_probe_command_is_explicit_and_does_not_inherit_agent_access() {
        let command = local_command().unwrap();
        assert!(ensure_supported().is_ok());
        assert_eq!(
            command.get_argv().as_slice(),
            &["/bin/zsh", "-f", "-i"].map(std::ffi::OsString::from)
        );
        assert_eq!(
            command.get_env("ZDOTDIR"),
            Some(std::ffi::OsStr::new("/var/empty"))
        );
        assert!(command.get_env("SSH_AUTH_SOCK").is_none());
        assert!(command.get_env("DYLD_INSERT_LIBRARIES").is_none());
    }

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn pending_adapter_rejects_session_before_allocating_a_pty() {
        let sessions = crate::pty::Sessions::default();
        let error = sessions
            .open("main", 80, 24, std::sync::Arc::new(|_| Ok(())))
            .unwrap_err();
        assert_eq!(error, UNSUPPORTED);
        assert!(local_command().is_err());
    }

    #[test]
    fn eof_does_not_treat_arbitrary_os_errors_as_successful_exit() {
        let permission_denied = std::io::Error::from(std::io::ErrorKind::PermissionDenied);
        assert!(!is_pty_eof(&permission_denied));
        #[cfg(windows)]
        assert!(!is_pty_eof(&std::io::Error::from_raw_os_error(5)));
        #[cfg(unix)]
        assert!(is_pty_eof(&std::io::Error::from_raw_os_error(libc::EIO)));
    }
}
