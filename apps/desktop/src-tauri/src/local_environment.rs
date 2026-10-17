//! Per-child environment overrides. Values never enter diagnostics or global state.
use portable_pty::CommandBuilder;
use serde::{Deserialize, Deserializer};
use std::collections::HashSet;

#[derive(Clone)]
pub struct EnvironmentVariable {
    pub name: String,
    pub value: String,
}

impl std::fmt::Debug for EnvironmentVariable {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("EnvironmentVariable { <redacted> }")
    }
}

impl<'de> Deserialize<'de> for EnvironmentVariable {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Wire {
            name: String,
            value: String,
        }
        let wire = Wire::deserialize(deserializer).map_err(|_| {
            serde::de::Error::custom("Invalid environment entry; expected name and value strings")
        })?;
        Ok(Self {
            name: wire.name,
            value: wire.value,
        })
    }
}

/// IPC wrapper also sanitizes malformed *array* input, before entry deserialization.
#[derive(Default)]
pub(crate) struct EnvironmentVariables(pub(crate) Vec<EnvironmentVariable>);

impl<'de> Deserialize<'de> for EnvironmentVariables {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Vec::<EnvironmentVariable>::deserialize(deserializer)
            .map(Self)
            .map_err(|_| {
                serde::de::Error::custom(
                    "Invalid environment; expected an array of name/value entries",
                )
            })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LocaleMode {
    Default,
    Custom,
}

impl<'de> Deserialize<'de> for LocaleMode {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let mode = String::deserialize(deserializer)
            .map_err(|_| serde::de::Error::custom("Invalid locale mode"))?;
        match mode.as_str() {
            "default" => Ok(Self::Default),
            "custom" => Ok(Self::Custom),
            _ => Err(serde::de::Error::custom("Invalid locale mode")),
        }
    }
}

#[derive(Clone, Debug)]
pub struct LocaleOptions {
    pub mode: LocaleMode,
    pub variables: Vec<EnvironmentVariable>,
}

impl<'de> Deserialize<'de> for LocaleOptions {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Wire {
            mode: LocaleMode,
            variables: Vec<EnvironmentVariable>,
        }
        let wire = Wire::deserialize(deserializer).map_err(|_| {
            serde::de::Error::custom("Invalid locale options; expected mode and variables")
        })?;
        Ok(Self {
            mode: wire.mode,
            variables: wire.variables,
        })
    }
}

const LOCALE_NAMES: &[&str] = &[
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "LC_COLLATE",
    "LC_MESSAGES",
    "LC_MONETARY",
    "LC_NUMERIC",
    "LC_TIME",
    "LC_ADDRESS",
    "LC_IDENTIFICATION",
    "LC_MEASUREMENT",
    "LC_NAME",
    "LC_PAPER",
];
const RESERVED: &[&str] = &[
    // portable-pty resolves this even with explicit argv and logs invalid values.
    "SHELL",
    "TERM",
    "COLORTERM",
    "PS1",
    "PS2",
    "PS3",
    "PS4",
    "PROMPT",
    "PROMPT_COMMAND",
    "RPROMPT",
    "HISTFILE",
    "HISTSIZE",
    "HISTFILESIZE",
    "HISTCONTROL",
    "ZDOTDIR",
    "SystemRoot",
    "ComSpec",
    "HOME",
    "USERPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
    "APPDATA",
    "LOCALAPPDATA",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_STATE_HOME",
    "XDG_CACHE_HOME",
    "TEMP",
    "TMP",
    "TMPDIR",
    "ENV",
    "BASH_ENV",
    "SHELLOPTS",
    "BASHOPTS",
    "PSModulePath",
    // glibc can load conversion modules using this directory while starting a shell.
    "GCONV_PATH",
];
const RESERVED_PREFIXES: &[&str] = &[
    "BASH_FUNC_",
    "LD_",
    "DYLD_",
    "DOTNET_",
    "CORECLR_",
    "COR_",
    "COMPlus_",
];

fn key(name: &str, windows: bool) -> String {
    if windows {
        name.to_ascii_uppercase()
    } else {
        name.into()
    }
}

pub(crate) fn validate(
    env: &[EnvironmentVariable],
    locale: Option<&LocaleOptions>,
) -> Result<(), String> {
    validate_for_platform(env, locale, cfg!(windows))
}

fn validate_for_platform(
    env: &[EnvironmentVariable],
    locale: Option<&LocaleOptions>,
    windows: bool,
) -> Result<(), String> {
    if env.len() > 64 {
        return Err("PTY environment allows at most 64 entries".into());
    }
    let variables = locale.map_or(&[][..], |locale| locale.variables.as_slice());
    if variables.len() > 13 {
        return Err("PTY locale allows at most 13 entries".into());
    }
    if locale.is_some_and(|locale| locale.mode == LocaleMode::Default && !variables.is_empty()) {
        return Err("Default locale cannot include custom variables".into());
    }
    let mut names = HashSet::new();
    let mut total = 0;
    for (entries, is_locale) in [(env, false), (variables, true)] {
        for entry in entries {
            let bytes = entry.name.as_bytes();
            if bytes.is_empty()
                || bytes.len() > 64
                || !(bytes[0].is_ascii_alphabetic() || bytes[0] == b'_')
                || !bytes
                    .iter()
                    .all(|byte| byte.is_ascii_alphanumeric() || *byte == b'_')
            {
                return Err(
                    "Environment names must match [A-Za-z_][A-Za-z0-9_]* and fit 64 bytes".into(),
                );
            }
            if entry.value.len() > 4096 || entry.value.contains('\0') {
                return Err(
                    "Environment values must fit 4096 UTF-8 bytes and contain no NUL".into(),
                );
            }
            total += entry.name.len() + entry.value.len() + 2;
            if total > 16 * 1024 {
                return Err("Environment and locale exceed the combined 16 KiB budget".into());
            }
            let name = key(&entry.name, windows);
            if !names.insert(name.clone()) {
                return Err("Duplicate environment or locale variable".into());
            }
            let matches = |candidate: &str| name == key(candidate, windows);
            if is_locale {
                if !LOCALE_NAMES.iter().any(|candidate| matches(candidate)) {
                    return Err("Unsupported locale variable".into());
                }
            } else {
                if matches("LANG") || name.starts_with(&key("LC_", windows)) {
                    return Err(
                        "Locale variables must use the dedicated locale configuration".into(),
                    );
                }
                if RESERVED.iter().any(|candidate| matches(candidate))
                    || RESERVED_PREFIXES
                        .iter()
                        .any(|prefix| name.starts_with(&key(prefix, windows)))
                {
                    return Err("Environment variable is reserved for controlled shell startup, runtime or history paths".into());
                }
            }
        }
    }
    if names.contains(&key("LC_ALL", windows))
        && variables.iter().any(|entry| {
            let name = key(&entry.name, windows);
            name.starts_with(&key("LC_", windows)) && name != key("LC_ALL", windows)
        })
    {
        return Err(
            "LC_ALL cannot be combined with other LC_* variables; LANG may be a fallback".into(),
        );
    }
    Ok(())
}

pub(crate) fn apply(
    command: &mut CommandBuilder,
    env: &[EnvironmentVariable],
    locale: Option<&LocaleOptions>,
) {
    if let Some(locale) = locale.filter(|locale| locale.mode == LocaleMode::Custom) {
        // Remove all platform locale policy, including future LC_* additions.
        let inherited: Vec<_> = command
            .iter_full_env_as_str()
            .filter(|(name, _)| {
                let name = key(name, cfg!(windows));
                name == "LANG" || name.starts_with("LC_")
            })
            .map(|(name, _)| name.to_owned())
            .collect();
        for name in inherited {
            command.env_remove(name);
        }
        for entry in &locale.variables {
            command.env(&entry.name, &entry.value);
        }
    }
    for entry in env {
        command.env(&entry.name, &entry.value);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{platform, pty::LocalLaunchOptions};
    use std::ffi::OsStr;

    fn variable(name: &str, value: &str) -> EnvironmentVariable {
        EnvironmentVariable {
            name: name.into(),
            value: value.into(),
        }
    }
    fn custom(variables: Vec<EnvironmentVariable>) -> LocaleOptions {
        LocaleOptions {
            mode: LocaleMode::Custom,
            variables,
        }
    }

    #[test]
    fn rejects_invalid_names_and_values_without_echoing_them() {
        for name in ["", "1NAME", "bad-name", "A=B", "中文", "N\0AME"] {
            assert!(validate(&[variable(name, "secret")], None).is_err());
        }
        assert!(validate(&[variable(&"A".repeat(65), "secret")], None).is_err());
        assert!(validate(&[variable(&"A".repeat(64), "")], None).is_ok());
        for value in [
            "secret\0hidden".to_owned(),
            "secret".repeat(700),
            "中".repeat(1366),
        ] {
            let error = validate(&[variable("NAME", &value)], None).unwrap_err();
            assert!(!error.contains("secret"));
            assert!(!error.contains('中'));
        }
        assert!(validate(&[variable("NAME", &"x".repeat(4096))], None).is_ok());
    }

    #[test]
    fn rejects_counts_and_enforces_combined_exact_byte_budget() {
        let mut entries: Vec<_> = (0..64).map(|i| variable(&format!("V{i}"), "")).collect();
        assert!(validate(&entries, None).is_ok());
        entries.push(variable("OVER", ""));
        assert!(validate(&entries, None).is_err());
        assert!(validate(&[], Some(&custom(vec![variable("LANG", ""); 14])))
            .unwrap_err()
            .contains("13"));
        let mut entries = vec![
            variable("A", &"x".repeat(4096)),
            variable("B", &"x".repeat(4096)),
            variable("C", &"x".repeat(4096)),
        ];
        let mut locale = custom(vec![variable("LANG", &"x".repeat(4081))]);
        assert!(validate(&entries, Some(&locale)).is_ok()); // 3*(4096+3)+(4081+6)=16384
        locale.variables[0].value.push('x');
        assert!(validate(&entries, Some(&locale))
            .unwrap_err()
            .contains("16 KiB"));
        entries[0].value.clear();
        assert!(validate(&entries, Some(&locale)).is_ok());
    }

    #[test]
    fn duplicates_follow_platform_case_rules() {
        for windows in [false, true] {
            assert!(validate_for_platform(
                &[variable("NAME", "a"), variable("NAME", "b")],
                None,
                windows
            )
            .is_err());
            assert_eq!(
                validate_for_platform(
                    &[variable("NAME", "a"), variable("name", "b")],
                    None,
                    windows
                )
                .is_err(),
                windows
            );
            assert!(validate_for_platform(
                &[],
                Some(&custom(vec![variable("LANG", "a"), variable("LANG", "b")])),
                windows
            )
            .is_err());
        }
        assert!(
            validate_for_platform(&[], Some(&custom(vec![variable("lang", "C")])), true).is_ok()
        );
        assert!(
            validate_for_platform(&[], Some(&custom(vec![variable("lang", "C")])), false).is_err()
        );
    }

    #[test]
    fn reserved_names_prefixes_and_locale_groups_cannot_be_overridden() {
        for windows in [false, true] {
            let sensitive = "/nonexistent/private-shell-marker";
            let error =
                validate_for_platform(&[variable("SHELL", sensitive)], None, windows).unwrap_err();
            assert!(error.contains("reserved"));
            assert!(!error.contains(sensitive));
            for name in RESERVED
                .iter()
                .copied()
                .chain(RESERVED_PREFIXES.iter().copied())
            {
                assert!(
                    validate_for_platform(&[variable(name, "secret")], None, windows).is_err(),
                    "{name}"
                );
                if windows {
                    assert!(
                        validate_for_platform(
                            &[variable(&name.to_ascii_lowercase(), "secret")],
                            None,
                            windows
                        )
                        .is_err(),
                        "{name}"
                    );
                }
            }
            for name in ["LANG", "LC_ALL", "LC_UNKNOWN"] {
                assert!(validate_for_platform(&[variable(name, "secret")], None, windows).is_err());
            }
            assert!(validate_for_platform(
                &[variable("PATH", "arbitrary child command lookup")],
                None,
                windows
            )
            .is_ok());
        }
        assert!(validate_for_platform(&[variable("home", "value")], None, false).is_ok());
        assert!(validate_for_platform(&[variable("dyld_custom", "value")], None, false).is_ok());
    }

    #[test]
    fn locale_default_and_lc_all_conflicts_are_explicit() {
        let invalid = LocaleOptions {
            mode: LocaleMode::Default,
            variables: vec![variable("LANG", "C")],
        };
        assert!(validate(&[], Some(&invalid)).is_err());
        assert!(validate(&[], Some(&custom(vec![variable("PATH", "secret")]))).is_err());
        for name in LOCALE_NAMES
            .iter()
            .filter(|name| name.starts_with("LC_") && **name != "LC_ALL")
        {
            let locale = custom(vec![variable("LC_ALL", "C"), variable(name, "C")]);
            assert!(validate(&[], Some(&locale)).is_err());
        }
        assert!(validate(
            &[],
            Some(&custom(vec![
                variable("LANG", "C"),
                variable("LC_ALL", "C")
            ]))
        )
        .is_ok());
    }

    #[test]
    fn default_and_omitted_options_preserve_platform_environment() {
        let baseline = platform::local_command().unwrap();
        let locale = LocaleOptions {
            mode: LocaleMode::Default,
            variables: vec![],
        };
        for locale in [None, Some(&locale)] {
            let command = platform::command_with_options(LocalLaunchOptions {
                locale,
                ..Default::default()
            })
            .unwrap();
            assert_eq!(
                command.iter_full_env_as_str().collect::<Vec<_>>(),
                baseline.iter_full_env_as_str().collect::<Vec<_>>()
            );
        }
    }

    #[test]
    fn custom_locale_removes_all_defaults_before_setting_values() {
        let mut command = CommandBuilder::new("not executed");
        command.env_clear();
        for name in ["LANG", "LC_ALL", "LC_CTYPE", "LC_FUTURE"] {
            command.env(name, "old");
        }
        apply(
            &mut command,
            &[],
            Some(&custom(vec![
                variable("LANG", "中文.UTF-8"),
                variable("LC_TIME", "C"),
            ])),
        );
        assert_eq!(command.get_env("LANG"), Some(OsStr::new("中文.UTF-8")));
        assert_eq!(command.get_env("LC_TIME"), Some(OsStr::new("C")));
        for name in ["LC_ALL", "LC_CTYPE", "LC_FUTURE"] {
            assert!(command.get_env(name).is_none());
        }
        apply(&mut command, &[], Some(&custom(vec![])));
        assert!(command.iter_full_env_as_str().next().is_none());
    }

    #[test]
    fn values_are_literal_child_only_and_do_not_leak_to_later_commands() {
        let name = "P1_ENV_ISOLATION_TEST";
        let parent = std::env::var_os(name);
        let value = " 中文 = spaces $HOME $(not executed) %PATH% \n";
        let entries = [
            variable(name, value),
            variable("EMPTY", ""),
            variable("PATH", "literal replacement"),
        ];
        let command = platform::command_with_options(LocalLaunchOptions {
            env: &entries,
            ..Default::default()
        })
        .unwrap();
        assert_eq!(command.get_env(name), Some(OsStr::new(value)));
        assert_eq!(command.get_env("EMPTY"), Some(OsStr::new("")));
        assert_eq!(
            command.get_env("PATH"),
            Some(OsStr::new("literal replacement"))
        );
        assert_eq!(std::env::var_os(name), parent);
        let next = platform::command_with_options(LocalLaunchOptions::default()).unwrap();
        assert!(next.get_env(name).is_none());
        assert_eq!(command.get_argv(), next.get_argv());
    }

    #[test]
    fn malformed_ipc_and_debug_never_include_supplied_values() {
        let secret = "sensitive-marker";
        for input in [
            r#""sensitive-marker""#,
            r#"["sensitive-marker"]"#,
            r#"[{"name":"OK","value":{"sensitive-marker":1}}]"#,
            r#"[{"name":"OK","value":"sensitive-marker","sensitive-marker":1}]"#,
        ] {
            let error = serde_json::from_str::<EnvironmentVariables>(input)
                .err()
                .unwrap()
                .to_string();
            assert!(!error.contains(secret));
        }
        for input in [
            r#""sensitive-marker""#,
            r#"{"mode":"sensitive-marker","variables":[]}"#,
            r#"{"mode":"custom","variables":"sensitive-marker"}"#,
        ] {
            let error = serde_json::from_str::<LocaleOptions>(input)
                .unwrap_err()
                .to_string();
            assert!(!error.contains(secret));
        }
        let locale = custom(vec![variable(secret, secret)]);
        let options = LocalLaunchOptions {
            env: &locale.variables,
            locale: Some(&locale),
            ..Default::default()
        };
        assert!(!format!("{options:?}").contains(secret));
        assert!(serde_json::from_str::<EnvironmentVariables>(
            r#"[{"name":"OK","value":" 中文 = "}]"#
        )
        .is_ok());
    }
}
