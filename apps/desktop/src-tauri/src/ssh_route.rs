//! How an SSH connection reaches its server (P0 for C07, C08, C19, C20):
//! direct TCP, an HTTP CONNECT or SOCKS5 proxy, a confirmed ProxyCommand
//! argv, or one jump host. The probe observes the host key through the same
//! route later operations use, and the challenge and SFTP grant keep that
//! route, so no later operation can switch it. Proxy passwords and the jump
//! host's credential stay in `Zeroizing`, are never persisted, and never
//! appear in error messages.
use super::{
    auth::{self, AuthFailure},
    forward, observe_host_key, proxy, transport, valid_host, validate, Challenge, Credential,
    KeyCheck, Operation, Request, SocketGuard, Ssh, DEADLINE,
};
use russh::{
    client,
    keys::{HashAlg, PublicKey},
};
use serde::{Deserialize, Serialize};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use tokio::{
    io::{AsyncRead, AsyncWrite},
    net::TcpStream,
    sync::watch,
};
use zeroize::Zeroizing;

/// RFC 1929 limits SOCKS5 names and passwords to 255 bytes; HTTP shares it.
const MAX_PROXY_FIELD: usize = 255;
const MAX_COMMAND_BYTES: usize = 4096;
const MAX_ARGV_BYTES: usize = 16 * 1024;
const PIPE_BYTES: usize = 64 * 1024;
/// A silently broken path to the jump host ends the relayed session.
const JUMP_KEEPALIVE: std::time::Duration = std::time::Duration::from_secs(30);
pub(super) const JUMP_FIRST: &str =
    "Confirm the jump host's key and then the target's key before connecting";
pub(super) const NOT_JUMP: &str = "This SSH challenge is not for a jump host";
pub(super) const JUMP_PROMPTED: &str =
    "Jump host login cannot ask questions; use a private key, password or SSH agent";

/// A route as requested by the WebView. Proxy secrets travel with the probe
/// because the proxy must be crossed to see the host key. A jump route
/// carries no secret: the jump credential is sent only after the user has
/// confirmed the jump host's own key (`Ssh::probe_through`).
#[derive(Clone, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum RouteSpec {
    // Struct variants so `deny_unknown_fields` rejects stray fields.
    Direct {},
    HttpConnect {
        host: String,
        port: u16,
        #[serde(default)]
        username: Option<String>,
        #[serde(default)]
        password: Option<Zeroizing<String>>,
    },
    Socks5 {
        host: String,
        port: u16,
        #[serde(default)]
        username: Option<String>,
        #[serde(default)]
        password: Option<Zeroizing<String>>,
    },
    /// `argv` is what the user confirmed; it must equal what `command`
    /// produces for this target, so the shown argv is the argv that runs.
    ProxyCommand {
        command: String,
        argv: Vec<String>,
    },
    Jump {
        host: String,
        port: u16,
        username: String,
        #[serde(default)]
        private_key_path: String,
    },
}

impl Default for RouteSpec {
    fn default() -> Self {
        Self::Direct {}
    }
}

/// What the WebView may show about a route. Never carries a secret.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum RouteSummary {
    Direct,
    HttpConnect {
        host: String,
        port: u16,
        authenticated: bool,
    },
    Socks5 {
        host: String,
        port: u16,
        authenticated: bool,
    },
    ProxyCommand {
        argv: Vec<String>,
    },
    Jump {
        host: String,
        port: u16,
        username: String,
        /// The jump host key the user confirmed in the first step.
        fingerprint: String,
    },
}

/// Which key a challenge shows: the jump host's (step 1 of 2) or the
/// target's, which is the only kind later operations may consume.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Stage {
    Jump,
    Target,
}

/// A validated route, bound to a challenge and then to an SFTP grant.
#[derive(Clone)]
pub(super) enum Route {
    Direct,
    Http(ProxyServer),
    Socks5(ProxyServer),
    Command(Vec<String>),
    Jump(Box<Hop>),
}

#[derive(Clone)]
pub(super) struct ProxyServer {
    host: String,
    port: u16,
    login: Option<(String, Zeroizing<String>)>,
}

/// The confirmed first hop: where it is, the key it must present, and the
/// credential that logs in to it. Built only from a confirmed challenge.
#[derive(Clone)]
pub(super) struct Hop {
    pub(super) request: Request,
    pub(super) key: Vec<u8>,
    pub(super) fingerprint: String,
    pub(super) credential: Credential,
}

/// What a probe observes first.
pub(super) enum Plan {
    /// The target, through this route.
    Reach(Route),
    /// The jump host, directly; the target follows once it is confirmed.
    Jump(Request),
}

impl RouteSpec {
    pub(super) fn plan(self, target: &Request) -> Result<Plan, String> {
        Ok(match self {
            Self::Direct {} => Plan::Reach(Route::Direct),
            Self::HttpConnect {
                host,
                port,
                username,
                password,
            } => Plan::Reach(Route::Http(ProxyServer::new(
                host, port, username, password, true,
            )?)),
            Self::Socks5 {
                host,
                port,
                username,
                password,
            } => Plan::Reach(Route::Socks5(ProxyServer::new(
                host, port, username, password, false,
            )?)),
            Self::ProxyCommand { command, argv } => {
                if argv.len() > proxy::MAX_ARGUMENTS
                    || proxy_command_preview(target, &command)? != argv
                {
                    return Err("ProxyCommand differs from the one shown; review it again".into());
                }
                Plan::Reach(Route::Command(argv))
            }
            Self::Jump {
                host,
                port,
                username,
                private_key_path,
            } => {
                let jump = Request {
                    host,
                    port,
                    username,
                    private_key_path,
                };
                validate(&jump).map_err(|error| format!("Jump host: {error}"))?;
                Plan::Jump(jump)
            }
        })
    }
}

impl Ssh {
    /// Observes the host key through `route` without authenticating. For a
    /// jump route this is the jump host's key (stage `jump`); the target's
    /// follows from [`Ssh::probe_through`] once the user has confirmed it.
    /// A ProxyCommand runs here only if `route` repeats the argv the user
    /// confirmed from [`proxy_command_preview`].
    pub async fn probe_via(
        &self,
        owner: &str,
        id: &str,
        request: Request,
        route: RouteSpec,
        scope: &str,
    ) -> Result<Challenge, String> {
        validate(&request)?;
        let plan = route.plan(&request)?;
        let mut operation = self.start(owner, id, scope)?;
        let (observed, route, next) = match plan {
            Plan::Reach(route) => (request, route, None),
            Plan::Jump(jump) => (jump, Route::Direct, Some(request)),
        };
        let public = self.observe(&mut operation, &observed, &route).await?;
        self.challenge(&operation, observed, route, next, public)
    }

    /// Step 2 of a jump route: consumes the confirmed jump host challenge,
    /// logs in to the jump host with `credential` (sent only now), and
    /// observes the target's key through it. The new target challenge binds
    /// the pinned jump key and credential. A changed jump key never gets here.
    pub async fn probe_through(
        &self,
        owner: &str,
        id: &str,
        token: &str,
        scope: &str,
        credential: Credential,
    ) -> Result<Challenge, String> {
        let mut operation = self.start(owner, id, scope)?;
        if credential.is_prompted() {
            return Err(JUMP_PROMPTED.into());
        }
        let pending = self.take(owner, token, Stage::Jump)?;
        credential
            .validate(&pending.request)
            .map_err(|error| format!("Jump host: {error}"))?;
        let target = pending.next.ok_or(NOT_JUMP)?;
        let fingerprint = pending
            .public
            .as_ref()
            .ok_or("Host key unavailable")?
            .fingerprint(HashAlg::Sha256)
            .to_string();
        let route = Route::Jump(Box::new(Hop {
            request: pending.request,
            key: pending.key,
            fingerprint,
            credential,
        }));
        let public = self.observe(&mut operation, &target, &route).await?;
        self.challenge(&operation, target, route, None, public)
    }

    async fn observe(
        &self,
        operation: &mut Operation<'_>,
        request: &Request,
        route: &Route,
    ) -> Result<PublicKey, String> {
        let cancel = operation.cancel.clone();
        let work = async {
            let rekey_rejected = Arc::default();
            let (_carrier, stream) = connect(request, route, &rekey_rejected, cancel)
                .await
                .map_err(RouteError::message)?;
            // Deliberately reject every key. No user authentication occurs.
            observe_host_key(stream).await
        };
        tokio::select! {
            biased;
            _ = operation.cancel.changed() => Err("SSH operation cancelled".into()),
            result = tokio::time::timeout(DEADLINE, work) => result.map_err(|_| "SSH operation timed out")?,
        }
    }
}

/// The exact argv a ProxyCommand runs for `target`, for the user to confirm
/// before anything runs. The program must be named by an absolute path.
pub fn proxy_command_preview(target: &Request, command: &str) -> Result<Vec<String>, String> {
    validate(target)?;
    if command.trim().is_empty() || command.len() > MAX_COMMAND_BYTES {
        return Err("ProxyCommand must be 1 to 4096 bytes".into());
    }
    let argv = proxy::prepare(command, &target.host, target.port, &target.username)?;
    if !std::path::Path::new(&argv[0]).is_absolute() {
        return Err("ProxyCommand must start with an absolute program path".into());
    }
    if argv.iter().map(String::len).sum::<usize>() > MAX_ARGV_BYTES {
        return Err("ProxyCommand arguments exceed 16 KiB".into());
    }
    Ok(argv)
}

impl ProxyServer {
    fn new(
        host: String,
        port: u16,
        username: Option<String>,
        password: Option<Zeroizing<String>>,
        http: bool,
    ) -> Result<Self, String> {
        if !valid_host(&host) || port == 0 {
            return Err("Invalid proxy host or port".into());
        }
        let login = match (username, password) {
            (None, None) => None,
            (None, Some(_)) => return Err("A proxy password needs a proxy username".into()),
            (Some(user), password) => {
                // Basic auth joins user and password with ':' (RFC 7617).
                if user.is_empty()
                    || user.len() > MAX_PROXY_FIELD
                    || user.chars().any(char::is_control)
                    || (http && user.contains(':'))
                {
                    return Err("Invalid proxy username".into());
                }
                let password = password.unwrap_or_else(|| Zeroizing::new(String::new()));
                if password.len() > MAX_PROXY_FIELD || password.contains('\0') {
                    return Err("Proxy password must be at most 255 bytes without NUL".into());
                }
                // RFC 1929 needs a 1-byte minimum; HTTP Basic allows an empty one.
                if !http && password.is_empty() {
                    return Err("A SOCKS5 login needs a password".into());
                }
                Some((user, password))
            }
        };
        Ok(Self { host, port, login })
    }

    fn login(&self) -> Option<(&str, &str)> {
        self.login
            .as_ref()
            .map(|(user, password)| (user.as_str(), password.as_str()))
    }

    fn summary(&self) -> (String, u16, bool) {
        (self.host.clone(), self.port, self.login.is_some())
    }
}

impl Route {
    pub(super) fn summary(&self) -> RouteSummary {
        match self {
            Self::Direct => RouteSummary::Direct,
            Self::Http(server) => {
                let (host, port, authenticated) = server.summary();
                RouteSummary::HttpConnect {
                    host,
                    port,
                    authenticated,
                }
            }
            Self::Socks5(server) => {
                let (host, port, authenticated) = server.summary();
                RouteSummary::Socks5 {
                    host,
                    port,
                    authenticated,
                }
            }
            Self::Command(argv) => RouteSummary::ProxyCommand { argv: argv.clone() },
            Self::Jump(hop) => RouteSummary::Jump {
                host: hop.request.host.clone(),
                port: hop.request.port,
                username: hop.request.username.clone(),
                fingerprint: hop.fingerprint.clone(),
            },
        }
    }
}

/// A byte stream an SSH session can run over.
pub(super) trait Wire: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> Wire for T {}

/// Owns whatever carries the stream: the TCP socket (shut down on drop), the
/// ProxyCommand process (killed and reaped on drop), or the authenticated
/// jump session and its socket. Keep it as long as the SSH session.
#[derive(Default)]
pub(super) struct Carrier {
    // Declaration order is drop order: the jump session before its socket.
    _jump: Option<client::Handle<KeyCheck>>,
    _process: Option<proxy::ProxyProcess>,
    _socket: Option<SocketGuard>,
}

/// `Evidence` contradicts confirmed trust (the jump host key changed or its
/// credential was refused) and revokes an SFTP grant; `Other` keeps it.
pub(super) enum RouteError {
    Evidence(String),
    Other(String),
}

impl RouteError {
    pub(super) fn message(self) -> String {
        match self {
            Self::Evidence(message) | Self::Other(message) => message,
        }
    }
}

/// Opens `route` to `target`. Jump-host rekeys set `rekey_rejected`, the
/// same flag as the target session's, so callers report them alike.
pub(super) async fn connect(
    target: &Request,
    route: &Route,
    rekey_rejected: &Arc<AtomicBool>,
    cancel: watch::Receiver<bool>,
) -> Result<(Carrier, Box<dyn Wire>), RouteError> {
    match route {
        Route::Direct => {
            let (socket, stream) = transport(target).await.map_err(RouteError::Other)?;
            Ok((
                Carrier {
                    _socket: Some(socket),
                    ..Carrier::default()
                },
                Box::new(stream),
            ))
        }
        Route::Http(server) => guarded(
            proxy::http_connect(
                (server.host.as_str(), server.port),
                &target.host,
                target.port,
                server.login(),
            )
            .await,
        ),
        Route::Socks5(server) => guarded(
            proxy::socks5_connect(
                (server.host.as_str(), server.port),
                &target.host,
                target.port,
                server.login(),
            )
            .await,
        ),
        Route::Command(argv) => {
            let (stream, process) = proxy::spawn(argv).map_err(RouteError::Other)?;
            Ok((
                Carrier {
                    _process: Some(process),
                    ..Carrier::default()
                },
                Box::new(stream),
            ))
        }
        Route::Jump(hop) => through(target, hop, rekey_rejected, cancel).await,
    }
}

/// Keeps a duplicate of a proxied socket so dropping the carrier shuts the
/// connection down even while russh still owns the stream.
fn guarded(stream: Result<TcpStream, String>) -> Result<(Carrier, Box<dyn Wire>), RouteError> {
    let failed = || RouteError::Other("SSH transport failed".into());
    let socket = stream
        .map_err(RouteError::Other)?
        .into_std()
        .map_err(|_| failed())?;
    let guard = SocketGuard(socket.try_clone().map_err(|_| failed())?);
    let stream = TcpStream::from_std(socket).map_err(|_| failed())?;
    Ok((
        Carrier {
            _socket: Some(guard),
            ..Carrier::default()
        },
        Box::new(stream),
    ))
}

/// Logs in to the jump host pinned to its confirmed key, then returns a
/// `direct-tcpip` channel to the target as a stream. The target's own key is
/// checked by the caller's handshake; the jump host only relays bytes.
async fn through(
    target: &Request,
    hop: &Hop,
    rekey_rejected: &Arc<AtomicBool>,
    cancel: watch::Receiver<bool>,
) -> Result<(Carrier, Box<dyn Wire>), RouteError> {
    let (socket, stream) = transport(&hop.request)
        .await
        .map_err(|_| RouteError::Other("Jump host connection failed".into()))?;
    let mismatch = Arc::new(AtomicBool::new(false));
    let handler = KeyCheck {
        expected: Some(hop.key.clone()),
        observed: Arc::default(),
        mismatch: mismatch.clone(),
        kex_seen: false,
        rekey_rejected: rekey_rejected.clone(),
        routes: Arc::default(),
    };
    // The relayed session may idle for as long as the target session does.
    // Keepalives end it if the path to the jump host silently breaks;
    // operation deadlines and the carrier's socket bound everything else.
    let config = Arc::new(client::Config {
        inactivity_timeout: None,
        keepalive_interval: Some(JUMP_KEEPALIVE),
        keepalive_max: 3,
        ..Default::default()
    });
    let mut session = client::connect_stream(config, stream, handler)
        .await
        .map_err(|_| {
            if mismatch.load(Ordering::Relaxed) {
                RouteError::Evidence(
                    "Jump host key changed; authentication was not attempted".into(),
                )
            } else {
                RouteError::Other("Jump host handshake failed".into())
            }
        })?;
    auth::authenticate(&mut session, &hop.request, &hop.credential, cancel, None)
        .await
        .map_err(|failure| match failure {
            AuthFailure::Rejected(message) => RouteError::Evidence(format!("Jump host: {message}")),
            AuthFailure::Failed(message) => RouteError::Other(format!("Jump host: {message}")),
        })?;
    let channel = session
        .channel_open_direct_tcpip(target.host.clone(), target.port.into(), "127.0.0.1", 0)
        .await
        .map_err(|_| RouteError::Other("Jump host refused the connection to the target".into()))?;
    let (ours, theirs) = tokio::io::duplex(PIPE_BYTES);
    tokio::spawn(forward::pump(channel, theirs));
    Ok((
        Carrier {
            _jump: Some(session),
            _socket: Some(socket),
            ..Carrier::default()
        },
        Box::new(ours),
    ))
}

#[cfg(test)]
#[path = "ssh_route_tests.rs"]
mod tests;
