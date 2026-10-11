//! Platform policy for the P0 local shell. Shared session/ACK logic stays in pty.
//! macOS and Linux use Unix PTYs. Windows awaits a cancellable ConPTY adapter.
use portable_pty::{CommandBuilder, MasterPty};

const UNSUPPORTED: &str =
    "P0 local PTY is enabled on macOS and Linux; the cancellable Windows ConPTY adapter is pending";

pub(crate) fn ensure_supported() -> Result<(), String> {
    if cfg!(any(target_os = "macos", target_os = "linux")) {
        Ok(())
    } else {
        Err(UNSUPPORTED.into())
    }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
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

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
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

#[cfg(target_os = "linux")]
pub(crate) fn local_command() -> Result<CommandBuilder, String> {
    linux_command()
}

#[cfg(any(target_os = "linux", all(test, unix)))]
fn linux_command() -> Result<CommandBuilder, String> {
    require_shell(std::path::Path::new("/bin/bash"))?;
    let mut command = CommandBuilder::new("/bin/bash");
    command.args(["--noprofile", "--norc", "-i"]);
    command.env_clear();
    command.env("PATH", "/usr/bin:/bin");
    command.env("TERM", "xterm-256color");
    command.env("LANG", "C.UTF-8");
    command.env("LC_ALL", "C.UTF-8");
    command.env("PS1", "P0 \\w \\$ ");
    command.env("HISTFILE", "/dev/null");
    command.cwd(std::env::temp_dir());
    if let Some(home) = std::env::var_os("HOME") {
        command.env("HOME", home);
    }
    Ok(command)
}

#[cfg(any(target_os = "linux", test))]
fn require_shell(path: &std::path::Path) -> Result<(), String> {
    if path.is_file() {
        Ok(())
    } else {
        Err(format!("P0 Linux requires Bash at {}", path.display()))
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
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

    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    #[test]
    fn pending_adapter_rejects_session_before_allocating_a_pty() {
        let sessions = crate::pty::Sessions::default();
        let error = sessions
            .open("main", 80, 24, std::sync::Arc::new(|_| Ok(())))
            .unwrap_err();
        assert_eq!(error, UNSUPPORTED);
        assert!(local_command().is_err());
    }

    #[cfg(unix)]
    #[test]
    fn linux_command_skips_profiles_and_uses_linux_locale_policy() {
        let command = linux_command().unwrap();
        assert_eq!(
            command.get_argv().as_slice(),
            &["/bin/bash", "--noprofile", "--norc", "-i"].map(std::ffi::OsString::from)
        );
        assert_eq!(
            command.get_env("LC_ALL"),
            Some(std::ffi::OsStr::new("C.UTF-8"))
        );
        assert_eq!(
            command.get_cwd().map(std::path::Path::new),
            Some(std::env::temp_dir().as_path())
        );
        for name in [
            "SSH_AUTH_SOCK",
            "LD_PRELOAD",
            "BASH_ENV",
            "ENV",
            "ZDOTDIR",
            "LC_CTYPE",
        ] {
            assert!(
                command.get_env(name).is_none(),
                "unexpected inherited {name}"
            );
        }
    }

    #[test]
    fn missing_linux_shell_returns_an_explicit_error() {
        let absent =
            std::env::temp_dir().join(format!("p0-missing-shell-{}", uuid::Uuid::new_v4()));
        assert!(require_shell(&absent)
            .unwrap_err()
            .contains("requires Bash"));
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
