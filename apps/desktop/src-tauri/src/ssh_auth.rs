//! Client authentication after the host key matched the confirmed pin.
//! Secrets arrive from the WebView only when a connection is consumed, are
//! zeroized on drop, and are never logged, persisted or echoed in errors.
use super::{private_key, read_key_bounded, KeyCheck, Request};
use russh::{
    client,
    keys::{agent::client::AgentClient, agent::AgentIdentity, HashAlg},
};
use serde::Deserialize;
use tokio::sync::watch;
use zeroize::Zeroizing;

const MAX_SECRET_BYTES: usize = 1024;
const MAX_ROUNDS: usize = 8;
const MAX_PROMPTS: usize = 16;
/// Servers commonly allow six attempts; never exhaust them on agent keys.
const MAX_AGENT_KEYS: usize = 4;
#[cfg(windows)]
const OPENSSH_AGENT_PIPE: &str = r"\\.\pipe\openssh-ssh-agent";

/// How to authenticate. `Key` uses the private key path sent with the probe.
#[derive(Clone, Deserialize)]
#[serde(tag = "method", rename_all = "camelCase", deny_unknown_fields)]
pub enum Credential {
    Key {
        #[serde(default)]
        passphrase: Option<Zeroizing<String>>,
    },
    Password {
        password: Zeroizing<String>,
    },
    // A struct variant so `deny_unknown_fields` rejects stray secrets.
    Agent {},
    /// Answers given in order to keyboard-interactive prompts, across rounds.
    KeyboardInteractive {
        responses: Vec<Zeroizing<String>>,
    },
}

impl Default for Credential {
    fn default() -> Self {
        Self::Key { passphrase: None }
    }
}

impl Credential {
    pub(super) fn validate(&self, request: &Request) -> Result<(), String> {
        let secret = match self {
            Self::Key { passphrase } => {
                if request.private_key_path.is_empty() {
                    return Err("A private key path is required for key authentication".into());
                }
                passphrase.as_deref()
            }
            Self::Password { password } => Some(&**password),
            Self::Agent {} => None,
            Self::KeyboardInteractive { responses } => {
                if responses.len() > MAX_PROMPTS
                    || responses
                        .iter()
                        .any(|r| r.len() > MAX_SECRET_BYTES || r.contains('\0'))
                {
                    return Err(
                        "SSH keyboard-interactive answers are limited to 16 of 1024 bytes".into(),
                    );
                }
                None
            }
        };
        if secret.is_some_and(|secret| secret.len() > MAX_SECRET_BYTES || secret.contains('\0')) {
            return Err("SSH secret must be at most 1024 bytes without NUL".into());
        }
        Ok(())
    }
}

/// `Rejected` is evidence the server refused these credentials (an SFTP
/// grant is revoked); `Failed` is local, transport or availability trouble.
pub(super) enum AuthFailure {
    Rejected(String),
    Failed(String),
}

impl AuthFailure {
    pub(super) fn message(self) -> String {
        match self {
            Self::Rejected(message) | Self::Failed(message) => message,
        }
    }
}

pub(super) async fn authenticate(
    session: &mut client::Handle<KeyCheck>,
    request: &Request,
    credential: &Credential,
    cancel: watch::Receiver<bool>,
) -> Result<(), AuthFailure> {
    let user = request.username.clone();
    let (accepted, rejected) = match credential {
        Credential::Key { passphrase } => {
            let path = request.private_key_path.clone();
            let passphrase = passphrase.clone();
            let key = read_key_bounded(cancel, move || {
                private_key(&path, passphrase.as_ref().map(|p| p.as_str()))
            })
            .await
            .map_err(AuthFailure::Failed)?;
            let result = session.authenticate_publickey(user, key).await;
            (
                result.map(|r| r.success()),
                "SSH public key authentication rejected",
            )
        }
        Credential::Password { password } => {
            let result = session.authenticate_password(user, password.as_str()).await;
            (
                result.map(|r| r.success()),
                "SSH password authentication rejected",
            )
        }
        Credential::Agent {} => return agent(session, user).await,
        Credential::KeyboardInteractive { responses } => {
            let mut queue = responses.iter().cloned();
            return keyboard_interactive(session, user, |round: Round| {
                let answers: Option<Vec<_>> = round.prompts.iter().map(|_| queue.next()).collect();
                std::future::ready(answers)
            })
            .await;
        }
    };
    match accepted {
        Ok(true) => Ok(()),
        Ok(false) => Err(AuthFailure::Rejected(rejected.into())),
        Err(_) => Err(AuthFailure::Failed("SSH authentication failed".into())),
    }
}

async fn agent(session: &mut client::Handle<KeyCheck>, user: String) -> Result<(), AuthFailure> {
    let unavailable = || AuthFailure::Failed("SSH agent is unavailable".into());
    #[cfg(unix)]
    let mut agent = AgentClient::connect_env()
        .await
        .map_err(|_| unavailable())?;
    #[cfg(windows)]
    let mut agent = AgentClient::connect_named_pipe(OPENSSH_AGENT_PIPE)
        .await
        .map_err(|_| unavailable())?;
    let identities = agent
        .request_identities()
        .await
        .map_err(|_| unavailable())?;
    let keys: Vec<_> = identities
        .into_iter()
        .filter_map(|identity| match identity {
            AgentIdentity::PublicKey { key, .. } => Some(key),
            _ => None,
        })
        .take(MAX_AGENT_KEYS)
        .collect();
    if keys.is_empty() {
        return Err(AuthFailure::Failed("SSH agent has no usable keys".into()));
    }
    for key in keys {
        let hash = key.algorithm().is_rsa().then_some(HashAlg::Sha256);
        match session
            .authenticate_publickey_with(user.clone(), key, hash, &mut agent)
            .await
        {
            Ok(result) if result.success() => return Ok(()),
            Ok(_) => continue,
            Err(_) => return Err(AuthFailure::Failed("SSH agent signing failed".into())),
        }
    }
    Err(AuthFailure::Rejected(
        "SSH agent authentication rejected".into(),
    ))
}

/// One keyboard-interactive round. `name`, `instructions` and prompt text
/// come from the server and must be shown as plain text.
pub struct Round {
    pub name: String,
    pub instructions: String,
    /// Prompt text and whether the answer may be echoed.
    pub prompts: Vec<(String, bool)>,
}

/// Runs keyboard-interactive (RFC 4256) rounds, asking `answer` for each
/// non-empty round. `answer` returning `None` cancels authentication.
pub(super) async fn keyboard_interactive<F, Fut>(
    session: &mut client::Handle<KeyCheck>,
    user: String,
    mut answer: F,
) -> Result<(), AuthFailure>
where
    F: FnMut(Round) -> Fut,
    Fut: std::future::Future<Output = Option<Vec<Zeroizing<String>>>>,
{
    use russh::client::KeyboardInteractiveAuthResponse as Reply;
    let failed = || AuthFailure::Failed("SSH authentication failed".into());
    let mut reply = session
        .authenticate_keyboard_interactive_start(user, None)
        .await
        .map_err(|_| failed())?;
    for _ in 0..MAX_ROUNDS {
        let (name, instructions, prompts) = match reply {
            Reply::Success => return Ok(()),
            Reply::Failure { .. } => {
                return Err(AuthFailure::Rejected(
                    "SSH keyboard-interactive authentication rejected".into(),
                ))
            }
            Reply::InfoRequest {
                name,
                instructions,
                prompts,
            } => (name, instructions, prompts),
        };
        if prompts.len() > MAX_PROMPTS {
            return Err(AuthFailure::Failed(
                "SSH server sent too many prompts".into(),
            ));
        }
        let count = prompts.len();
        // Servers may send an empty round; it is answered without asking.
        let responses = if count == 0 {
            Vec::new()
        } else {
            let round = Round {
                name,
                instructions,
                prompts: prompts.into_iter().map(|p| (p.prompt, p.echo)).collect(),
            };
            answer(round).await.ok_or_else(|| {
                AuthFailure::Failed("SSH keyboard-interactive needs more answers".into())
            })?
        };
        if responses.len() != count {
            return Err(AuthFailure::Failed(
                "SSH keyboard-interactive answer count mismatch".into(),
            ));
        }
        reply = session
            .authenticate_keyboard_interactive_respond(
                responses.iter().map(|r| r.to_string()).collect(),
            )
            .await
            .map_err(|_| failed())?;
    }
    Err(AuthFailure::Failed(
        "SSH keyboard-interactive exceeded 8 rounds".into(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(path: &str) -> Request {
        Request {
            host: "127.0.0.1".into(),
            port: 22,
            username: "fixture".into(),
            private_key_path: path.into(),
        }
    }

    #[test]
    fn credentials_deserialize_by_method_and_reject_unknown_fields() {
        let parse = |json: &str| serde_json::from_str::<Credential>(json);
        assert!(matches!(
            parse(r#"{"method":"key"}"#).unwrap(),
            Credential::Key { passphrase: None }
        ));
        assert!(matches!(
            parse(r#"{"method":"key","passphrase":"x"}"#).unwrap(),
            Credential::Key {
                passphrase: Some(_)
            }
        ));
        assert!(matches!(
            parse(r#"{"method":"password","password":"x"}"#).unwrap(),
            Credential::Password { .. }
        ));
        assert!(matches!(
            parse(r#"{"method":"agent"}"#).unwrap(),
            Credential::Agent {}
        ));
        assert!(parse(r#"{"method":"agent","password":"x"}"#).is_err());
        assert!(parse(r#"{"method":"password"}"#).is_err());
        assert!(parse(r#"{"method":"gssapi"}"#).is_err());
        assert!(matches!(
            parse(r#"{"method":"keyboardInteractive","responses":["a","b"]}"#).unwrap(),
            Credential::KeyboardInteractive { responses } if responses.len() == 2
        ));
    }

    #[test]
    fn key_needs_a_path_and_secrets_are_bounded() {
        assert!(Credential::default().validate(&request("")).is_err());
        assert!(Credential::default().validate(&request("/key")).is_ok());
        assert!(Credential::Agent {}.validate(&request("")).is_ok());
        let long = Credential::Password {
            password: Zeroizing::new("x".repeat(MAX_SECRET_BYTES + 1)),
        };
        assert!(long.validate(&request("")).is_err());
        let nul = Credential::Key {
            passphrase: Some(Zeroizing::new("a\0b".into())),
        };
        assert!(nul.validate(&request("/key")).is_err());
    }
}
