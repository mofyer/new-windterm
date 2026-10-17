//! Fixed, platform-scoped discovery. Never search PATH or interpret a shell ID as a path.
use portable_pty::CommandBuilder;
use serde::Serialize;
use std::path::{Path, PathBuf};

/// Availability snapshot for a fixed, platform-supported shell ID.
/// `path` is present only when available; otherwise `reason` explains the failure.
/// Opening by ID discovers the executable again; this snapshot does not pin an inode.
#[derive(Clone, Debug, Serialize)]
pub struct LocalShell {
    pub id: String,
    pub label: String,
    pub path: Option<String>,
    pub available: bool,
    pub reason: Option<String>,
}

#[cfg(unix)]
fn candidates() -> Vec<(&'static str, &'static str, Vec<PathBuf>)> {
    let paths = |names: &[&str]| names.iter().map(PathBuf::from).collect();
    vec![
        (
            "bash",
            "Bash",
            paths(&[
                "/bin/bash",
                "/usr/bin/bash",
                "/opt/homebrew/bin/bash",
                "/usr/local/bin/bash",
            ]),
        ),
        (
            "zsh",
            "Zsh",
            paths(&[
                "/bin/zsh",
                "/usr/bin/zsh",
                "/opt/homebrew/bin/zsh",
                "/usr/local/bin/zsh",
            ]),
        ),
        (
            "pwsh",
            "PowerShell 7",
            paths(&[
                "/usr/bin/pwsh",
                "/opt/homebrew/bin/pwsh",
                "/usr/local/bin/pwsh",
                "/opt/microsoft/powershell/7/pwsh",
                "/usr/local/microsoft/powershell/7/pwsh",
            ]),
        ),
    ]
}

#[cfg(windows)]
fn candidates() -> Vec<(&'static str, &'static str, Vec<PathBuf>)> {
    // Environment values are only accepted as absolute, local installation roots.
    // An absent/relative value must never turn discovery into a cwd/PATH lookup.
    let root = |name: &str, suffix: &str| {
        std::env::var_os(name)
            .map(PathBuf::from)
            .filter(|path| local_absolute_path(path))
            .map(|path| path.join(suffix))
            .into_iter()
            .collect()
    };
    vec![
        (
            "cmd",
            "Command Prompt",
            root("SystemRoot", r"System32\cmd.exe"),
        ),
        (
            "powershell",
            "Windows PowerShell",
            root(
                "SystemRoot",
                r"System32\WindowsPowerShell\v1.0\powershell.exe",
            ),
        ),
        (
            "pwsh",
            "PowerShell 7",
            root("ProgramFiles", r"PowerShell\7\pwsh.exe"),
        ),
    ]
}

#[cfg(not(any(unix, windows)))]
fn candidates() -> Vec<(&'static str, &'static str, Vec<PathBuf>)> {
    Vec::new()
}

fn local_absolute_path(path: &Path) -> bool {
    if !path.is_absolute() || path.as_os_str().as_encoded_bytes().contains(&0) {
        return false;
    }
    #[cfg(windows)]
    {
        use std::path::{Component, Prefix};
        return matches!(path.components().next(), Some(Component::Prefix(prefix)) if matches!(prefix.kind(), Prefix::Disk(_)));
    }
    #[cfg(not(windows))]
    true
}

fn executable(path: &Path) -> Result<(), String> {
    if !local_absolute_path(path) {
        return Err("not an absolute local executable path".into());
    }
    let metadata = path.metadata().map_err(|e| e.to_string())?;
    if !metadata.is_file() {
        return Err("not a regular file".into());
    }
    #[cfg(windows)]
    {
        use std::path::{Component, Prefix};
        let target = path.canonicalize().map_err(|e| e.to_string())?;
        if !matches!(target.components().next(), Some(Component::Prefix(prefix)) if matches!(prefix.kind(), Prefix::Disk(_) | Prefix::VerbatimDisk(_)))
        {
            return Err("executable cannot resolve to a UNC or device path".into());
        }
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o111 == 0 {
            return Err("file has no executable permission".into());
        }
    }
    Ok(())
}

fn discover(id: &str, label: &str, paths: &[PathBuf]) -> LocalShell {
    let mut failures = Vec::new();
    for path in paths {
        match executable(path) {
            Ok(()) => {
                if let Some(path) = path.to_str() {
                    return LocalShell {
                        id: id.into(),
                        label: label.into(),
                        path: Some(path.into()),
                        available: true,
                        reason: None,
                    };
                } else {
                    failures.push("executable path is not Unicode".into());
                }
            }
            Err(error) => failures.push(format!("{}: {error}", path.display())),
        }
    }
    let reason = if failures.is_empty() {
        "installation root is missing or is not an absolute local path".into()
    } else {
        failures.join("; ")
    };
    LocalShell {
        id: id.into(),
        label: label.into(),
        path: None,
        available: false,
        reason: Some(format!("{label} is unavailable: {reason}")),
    }
}

/// Inspect fixed installation paths for the current platform, without executing shells.
/// Results are snapshots: each open/reopen re-discovers the selected ID and may find
/// a changed path or executable. Launch arguments and environment are controlled;
/// the complete parent environment is never inherited.
pub fn local_shells() -> Vec<LocalShell> {
    candidates()
        .into_iter()
        .map(|(id, label, paths)| discover(id, label, &paths))
        .collect()
}

pub(crate) fn command(id: &str) -> Result<CommandBuilder, String> {
    let (id, label, paths) = candidates()
        .into_iter()
        .find(|(candidate, _, _)| *candidate == id)
        .ok_or_else(|| format!("Unsupported local shell ID: {id:?}"))?;
    let shell = discover(id, label, &paths);
    let path = shell.path.ok_or_else(|| {
        shell
            .reason
            .unwrap_or_else(|| "Local shell is unavailable".into())
    })?;
    command_at(id, Path::new(&path))
}

fn command_at(id: &str, path: &Path) -> Result<CommandBuilder, String> {
    // Recheck the selected executable on every open/reopen, not just UI discovery.
    executable(path)
        .map_err(|error| format!("Local shell {} is unavailable: {error}", path.display()))?;
    let mut command = CommandBuilder::new(path);
    match id {
        "bash" => command.args(["--noprofile", "--norc", "-i"]),
        // zsh always reads its system zshenv; -f disables subsequent RCS files.
        "zsh" => command.args(["-f", "-i"]),
        "pwsh" | "powershell" => command.args(["-NoLogo", "-NoProfile"]),
        "cmd" => command.args(["/D", "/Q", "/K"]),
        _ => return Err("Unsupported local shell ID".into()),
    }
    command.env_clear();
    #[cfg(unix)]
    {
        command.env("TERM", "xterm-256color");
        #[cfg(target_os = "macos")]
        {
            command.env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin");
            command.env("LANG", "en_US.UTF-8");
            command.env("LC_CTYPE", "UTF-8");
            command.cwd("/tmp");
        }
        #[cfg(not(target_os = "macos"))]
        {
            command.env("PATH", "/usr/bin:/bin");
            command.env("LANG", "C.UTF-8");
            command.env("LC_ALL", "C.UTF-8");
            command.cwd(std::env::temp_dir());
        }
        if let Some(home) = std::env::var_os("HOME") {
            command.env("HOME", home);
        }
        if id == "bash" || id == "zsh" {
            command.env("HISTFILE", "/dev/null");
        }
        if id == "bash" {
            command.env("PS1", "P0 \\w \\$ ");
        }
        if id == "zsh" {
            command.env("PROMPT", "P0 %~ %# ");
            command.env("ZDOTDIR", "/var/empty");
        }
    }
    #[cfg(windows)]
    {
        for name in ["SystemRoot", "PATH"] {
            command.env(
                name,
                std::env::var_os(name).ok_or_else(|| format!("{name} is unavailable"))?,
            );
        }
        if id == "cmd" {
            // Explicit cmd is resolved independently of ComSpec, too.
            command.env("ComSpec", path);
            command.env("PROMPT", "P0 $P$G ");
        } else {
            if let Some(comspec) = std::env::var_os("ComSpec") {
                command.env("ComSpec", comspec);
            }
            for name in ["USERPROFILE", "TEMP", "TMP", "APPDATA", "LOCALAPPDATA"] {
                if let Some(value) = std::env::var_os(name) {
                    command.env(name, value);
                }
            }
        }
        command.cwd(std::env::temp_dir());
    }
    Ok(command)
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("p1-shell-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir(&path).unwrap();
            Self(path)
        }
        fn file(&self, name: &str) -> PathBuf {
            let path = self.0.join(name);
            std::fs::write(&path, b"fixture, not executed").unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
            }
            path
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn discovery_rejects_missing_directory_relative_and_nonexecutable() {
        let fixture = Fixture::new();
        let paths = vec![
            PathBuf::from("pwsh"),
            fixture.0.clone(),
            fixture.0.join("missing"),
        ];
        let result = discover("pwsh", "PowerShell 7", &paths);
        assert!(!result.available);
        assert!(result.path.is_none());
        assert!(result.reason.unwrap().contains("unavailable"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let file = fixture.file("not executable");
            std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600)).unwrap();
            assert!(executable(&file)
                .unwrap_err()
                .contains("executable permission"));
        }
    }

    #[test]
    fn discovery_uses_first_valid_absolute_candidate_and_rechecks_removal() {
        let fixture = Fixture::new();
        let file = fixture.file("中文 shell");
        let result = discover(
            "pwsh",
            "PowerShell 7",
            &[fixture.0.join("missing"), file.clone()],
        );
        assert!(result.available);
        assert_eq!(result.path.as_deref(), file.to_str());
        assert!(result.reason.is_none());
        std::fs::remove_file(&file).unwrap();
        assert!(command_at("pwsh", &file).is_err());
    }

    #[test]
    fn unsupported_ids_do_not_become_paths_or_default_shells() {
        for id in [
            "",
            " ",
            "Bash",
            "/bin/bash",
            "bash;echo unsafe",
            "../cmd.exe",
        ] {
            assert!(command(id)
                .unwrap_err()
                .contains("Unsupported local shell ID"));
        }
        #[cfg(unix)]
        assert!(command("cmd").is_err());
        #[cfg(windows)]
        assert!(command("bash").is_err());
    }

    #[test]
    fn explicit_shells_use_fixed_argv_and_controlled_environment() {
        let fixture = Fixture::new();
        let file = fixture.file("shell");
        for (id, args) in [
            ("bash", vec!["--noprofile", "--norc", "-i"]),
            ("zsh", vec!["-f", "-i"]),
            ("pwsh", vec!["-NoLogo", "-NoProfile"]),
            ("powershell", vec!["-NoLogo", "-NoProfile"]),
            ("cmd", vec!["/D", "/Q", "/K"]),
        ] {
            let command = command_at(id, &file).unwrap();
            assert_eq!(command.get_argv()[0], file.as_os_str());
            assert_eq!(
                command.get_argv()[1..],
                args.iter()
                    .map(std::ffi::OsString::from)
                    .collect::<Vec<_>>()
            );
            for name in [
                "SSH_AUTH_SOCK",
                "LD_PRELOAD",
                "DYLD_INSERT_LIBRARIES",
                "BASH_ENV",
                "ENV",
                "PSModulePath",
            ] {
                assert!(command.get_env(name).is_none(), "inherited {name}");
            }
        }
    }

    #[cfg(windows)]
    #[test]
    fn discovery_rejects_windows_relative_unc_and_device_paths() {
        for path in [
            r"C:relative",
            r"\relative",
            r"\\server\share\pwsh.exe",
            r"\\?\C:\pwsh.exe",
            r"\\.\pipe\shell",
            "C:\0invalid",
        ] {
            assert!(!local_absolute_path(Path::new(path)), "accepted {path:?}");
        }
        assert!(local_absolute_path(Path::new(
            r"C:\Program Files\PowerShell\7\pwsh.exe"
        )));
    }

    #[test]
    fn discovery_has_only_current_platform_ids() {
        let shells = local_shells();
        let ids: Vec<_> = shells.iter().map(|shell| shell.id.as_str()).collect();
        #[cfg(unix)]
        assert_eq!(ids, ["bash", "zsh", "pwsh"]);
        #[cfg(windows)]
        assert_eq!(ids, ["cmd", "powershell", "pwsh"]);
        for shell in shells {
            assert_eq!(shell.available, shell.path.is_some());
            assert_eq!(shell.available, shell.reason.is_none());
        }
    }
}
