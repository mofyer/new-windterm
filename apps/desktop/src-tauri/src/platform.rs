//! Platform policy for the P0 local shell. Shared session/ACK logic stays in pty.
//! macOS and Linux use Unix PTYs. Windows uses ConPTY with blocking pipes, a
//! kill-on-close Job Object and pseudoconsole release after the shell exits.
use portable_pty::{CommandBuilder, MasterPty};

#[cfg(windows)]
#[path = "platform_windows.rs"]
pub(crate) mod windows;

const UNSUPPORTED: &str = "P0 local PTY is enabled on macOS, Linux and Windows only";

pub(crate) fn ensure_supported() -> Result<(), String> {
    if cfg!(any(
        target_os = "macos",
        target_os = "linux",
        target_os = "windows"
    )) {
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

/// ConPTY pipes stay blocking: Windows readiness polling only works for
/// sockets. The session unblocks the reader by releasing the pseudoconsole.
#[cfg(target_os = "windows")]
pub(crate) fn configure_io(_master: &dyn MasterPty) -> Result<(), String> {
    Ok(())
}

#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
pub(crate) fn configure_io(_master: &dyn MasterPty) -> Result<(), String> {
    Err(UNSUPPORTED.into())
}

/// Windows device-namespace paths (`\\.\pipe\…`, `\\.\COM1`, `\\?\GLOBALROOT…`)
/// name pipes and devices rather than files; opening one can consume a pipe
/// instance or block. Always false on Unix, where paths have no prefix.
pub(crate) fn is_device_path(path: &std::path::Path) -> bool {
    use std::path::{Component, Prefix};
    matches!(
        path.components().next(),
        Some(Component::Prefix(prefix))
            if matches!(prefix.kind(), Prefix::DeviceNS(_) | Prefix::Verbatim(_))
    )
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

#[cfg(target_os = "windows")]
pub(crate) fn local_command() -> Result<CommandBuilder, String> {
    // Keep the Windows shell contract explicit before ConPTY is enabled. `/D`
    // disables AutoRun hooks, `/Q` disables command echoing, and `/K` keeps the
    // interactive shell alive; this prevents user-wide cmd.exe configuration
    // from changing the byte-level probe.
    let comspec = std::env::var_os("ComSpec").ok_or("ComSpec is unavailable")?;
    let comspec = std::path::PathBuf::from(comspec);
    if !comspec.is_file()
        || !comspec
            .file_name()
            .and_then(std::ffi::OsStr::to_str)
            .is_some_and(|name| name.eq_ignore_ascii_case("cmd.exe"))
    {
        return Err("ComSpec is not a regular cmd.exe file".into());
    }
    let mut command = CommandBuilder::new(comspec);
    command.args(["/D", "/Q", "/K"]);
    command.env_clear();
    for name in ["SystemRoot", "ComSpec", "PATH"] {
        command.env(
            name,
            std::env::var_os(name).ok_or_else(|| format!("{name} is unavailable"))?,
        );
    }
    command.env("PROMPT", "P0 $P$G ");
    command.cwd(std::env::temp_dir());
    Ok(command)
}

#[cfg(all(
    not(target_os = "macos"),
    not(target_os = "linux"),
    not(target_os = "windows")
))]
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

/// Experimental cancellation socket, independent of the PTY descriptor lifetime.
#[cfg(all(feature = "pty-readiness", unix))]
pub(crate) struct Readiness {
    descriptor: std::os::fd::OwnedFd,
    cancel: std::os::unix::net::UnixStream,
}

#[cfg(all(feature = "pty-readiness", unix))]
pub(crate) struct CancelReadiness(std::os::unix::net::UnixStream);

#[cfg(all(feature = "pty-readiness", unix))]
impl CancelReadiness {
    pub(crate) fn cancel(&self) {
        // Shutdown is idempotent, cannot fill a pipe, and wakes poll via HUP/EOF.
        let _ = self.0.shutdown(std::net::Shutdown::Both);
    }
}

#[cfg(all(feature = "pty-readiness", unix))]
impl Readiness {
    pub(crate) fn new(master: &dyn MasterPty) -> Result<(Self, CancelReadiness), String> {
        use std::os::fd::FromRawFd;
        let fd = master.as_raw_fd().ok_or("PTY has no native descriptor")?;
        // SAFETY: master owns fd for this call. CLOEXEC prevents the duplicate
        // from keeping the master alive in the spawned shell.
        let duplicate = unsafe { libc::fcntl(fd, libc::F_DUPFD_CLOEXEC, 0) };
        if duplicate < 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
        // SAFETY: fcntl returned a new descriptor, owned exactly once here.
        let descriptor = unsafe { std::os::fd::OwnedFd::from_raw_fd(duplicate) };
        let (cancel, sender) = std::os::unix::net::UnixStream::pair().map_err(|e| e.to_string())?;
        Ok((Self { descriptor, cancel }, CancelReadiness(sender)))
    }

    pub(crate) fn wait(&self, timeout: std::time::Duration) -> Result<(), String> {
        use std::os::fd::AsRawFd;
        let mut descriptors = [
            libc::pollfd {
                fd: self.descriptor.as_raw_fd(),
                events: libc::POLLIN,
                revents: 0,
            },
            libc::pollfd {
                fd: self.cancel.as_raw_fd(),
                events: libc::POLLIN,
                revents: 0,
            },
        ];
        // SAFETY: both descriptors and the array remain live for the call. A
        // bounded wait allows the shared reader loop to recheck the ACK deadline.
        // Round sub-millisecond deadlines up to avoid a zero-timeout spin.
        let result = unsafe {
            libc::poll(
                descriptors.as_mut_ptr(),
                2,
                timeout.as_millis().clamp(1, i32::MAX as u128) as i32,
            )
        };
        if result < 0 {
            let error = std::io::Error::last_os_error();
            if error.kind() != std::io::ErrorKind::Interrupted {
                return Err(format!("PTY readiness failed: {error}"));
            }
        }
        if descriptors
            .iter()
            .any(|fd| fd.revents & libc::POLLNVAL != 0)
        {
            return Err("PTY readiness descriptor invalid".into());
        }
        // POLLHUP/POLLERR return to read, which retains the existing EOF policy.
        Ok(())
    }
}

#[cfg(all(feature = "pty-readiness", not(unix)))]
pub(crate) struct Readiness;
#[cfg(all(feature = "pty-readiness", not(unix)))]
pub(crate) struct CancelReadiness;
#[cfg(all(feature = "pty-readiness", not(unix)))]
impl CancelReadiness {
    pub(crate) fn cancel(&self) {}
}
// Blocking ConPTY reads never report WouldBlock, so `wait` is unreachable in
// practice; it fails closed rather than spinning if that ever changes.
#[cfg(all(feature = "pty-readiness", not(unix)))]
impl Readiness {
    pub(crate) fn new(_master: &dyn MasterPty) -> Result<(Self, CancelReadiness), String> {
        Ok((Self, CancelReadiness))
    }
    pub(crate) fn wait(&self, _timeout: std::time::Duration) -> Result<(), String> {
        Err("PTY readiness waiting is not available for blocking ConPTY pipes".into())
    }
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

    #[cfg(all(
        not(target_os = "macos"),
        not(target_os = "linux"),
        not(target_os = "windows")
    ))]
    #[test]
    fn pending_adapter_rejects_session_before_allocating_a_pty() {
        let sessions = crate::pty::Sessions::default();
        let error = sessions
            .open("main", 80, 24, std::sync::Arc::new(|_| Ok(())))
            .unwrap_err();
        assert_eq!(error, UNSUPPORTED);
        assert!(local_command().is_err());
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn device_namespace_paths_are_not_files() {
        for path in [
            r"\\.\pipe\p0-key",
            r"\\.\COM1",
            r"\\?\GLOBALROOT\Device\Null",
        ] {
            assert!(is_device_path(std::path::Path::new(path)), "{path}");
        }
        for path in [
            r"C:\Users\p0\key",
            r"\\?\C:\Users\p0\key",
            r"\\server\share\key",
        ] {
            assert!(!is_device_path(std::path::Path::new(path)), "{path}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn unix_paths_never_have_a_device_prefix() {
        assert!(!is_device_path(std::path::Path::new("/dev/null")));
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

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_command_disables_autorun_and_echoes() {
        let command = local_command().unwrap();
        assert!(ensure_supported().is_ok());
        assert_eq!(
            command.get_argv().as_slice(),
            &[
                std::env::var_os("ComSpec").unwrap(),
                "/D".into(),
                "/Q".into(),
                "/K".into(),
            ]
        );
        assert_eq!(
            command.get_env("PROMPT"),
            Some(std::ffi::OsStr::new("P0 $P$G "))
        );
        assert!(command.get_env("ComSpec").is_some());
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

#[cfg(all(test, feature = "pty-readiness", unix))]
mod readiness_tests {
    use super::*;
    use std::{io::Write, os::fd::OwnedFd, os::unix::net::UnixStream, sync::mpsc, time::Duration};

    #[test]
    fn poll_wakes_for_input_and_idempotent_cancellation() {
        for cancel_instead_of_input in [false, true] {
            let (input, mut output) = UnixStream::pair().unwrap();
            let (cancel, sender) = UnixStream::pair().unwrap();
            let readiness = Readiness {
                descriptor: OwnedFd::from(input),
                cancel,
            };
            let cancellation = CancelReadiness(sender);
            let (done, receiver) = mpsc::channel();
            let worker = std::thread::spawn(move || {
                done.send(readiness.wait(Duration::from_secs(5))).unwrap();
            });
            std::thread::sleep(Duration::from_millis(30));
            if cancel_instead_of_input {
                cancellation.cancel();
                cancellation.cancel();
            } else {
                output.write_all(b"x").unwrap();
            }
            receiver
                .recv_timeout(Duration::from_secs(1))
                .unwrap()
                .unwrap();
            worker.join().unwrap();
        }
    }
}
