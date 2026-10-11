//! P0 SSH verification and interactive channels. No agent, password, or persisted trust.
#[path = "ssh_auth.rs"]
pub mod auth;
#[path = "ssh_forward.rs"]
pub mod forward;
#[path = "ssh_kbdint.rs"]
pub mod kbdint;
#[path = "ssh_proxy.rs"]
pub mod proxy;
#[path = "ssh_scp.rs"]
pub mod scp;
#[path = "ssh_terminal.rs"]
pub mod terminal;
use crate::known_hosts::{KnownHosts, Saved};
use crate::sftp::{ReadOnlySftp, RemoteEntry, RemoteListing};
use auth::AuthFailure;
pub use auth::Credential;
pub use kbdint::{AuthPrompt, PromptField, PromptSink, ROUND_DEADLINE};
use kbdint::{Clock, Prompter, Prompts};
use russh::{
    client,
    keys::{Algorithm, HashAlg, PrivateKeyWithHashAlg, PublicKey, PublicKeyOrCertificate},
    ChannelMsg,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    io::Read,
    net::Shutdown,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::{net::TcpStream, sync::watch};

const HOST_CHANGED: &str =
    "SSH host key differs from the saved key; verify it and replace the saved key first";
const REKEY_ERROR: &str =
    "SSH rekey is not supported in P0; reconnect to verify the host key again";
const DEADLINE: Duration = Duration::from_secs(15);
const TRUST_TTL: Duration = Duration::from_secs(60);
const MAX_BYTES: usize = 64 * 1024;
const MAX_KDF_ROUNDS: u32 = 512;
const MAX_ACTIVE: usize = 4;
const MAX_CHALLENGES: usize = 8;
const MAX_CANCELLED: usize = 128;
const SFTP_IDLE: Duration = Duration::from_secs(5 * 60);
const SFTP_LIFETIME: Duration = Duration::from_secs(30 * 60);
const MAX_SFTP_GRANTS: usize = 4;
// Both messages end with the same phrase so the UI can return to reconnect.
const SFTP_EXPIRED: &str = "SFTP session expired; reconnect and verify the host again";
const SFTP_REVOKED: &str = "SFTP session closed; reconnect and verify the host again";
const SFTP_CAPACITY: &str = "SFTP session capacity reached; disconnect another file browser";
static KEY_READS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(MAX_ACTIVE);

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub private_key_path: String,
}

/// How the presented host key relates to saved trust.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Trust {
    /// Not saved: the user must compare the fingerprint before continuing.
    New,
    /// Matches a saved key for this host and port.
    Known,
    /// Differs from the saved key. Blocked until the user separately replaces it.
    Changed,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Challenge {
    pub challenge_token: String,
    pub host: String,
    pub port: u16,
    pub algorithm: String,
    pub fingerprint: String,
    pub expires_in_seconds: u64,
    pub trust: Trust,
    pub saved_fingerprint: Option<String>,
}

/// A credential plus, for prompted keyboard-interactive, where to show the
/// server's rounds. The sink belongs to one command and is never stored.
pub struct Login {
    pub credential: Credential,
    pub prompts: Option<PromptSink>,
}

impl From<Credential> for Login {
    fn from(credential: Credential) -> Self {
        Self {
            credential,
            prompts: None,
        }
    }
}

/// Prompted authentication without a way to ask the user fails before any
/// challenge is consumed or connection made.
fn check_prompts(credential: &Credential, prompts: Option<&PromptSink>) -> Result<(), String> {
    if credential.is_prompted() && prompts.is_none() {
        return Err(kbdint::NO_CHANNEL.into());
    }
    Ok(())
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Output {
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub exit_code: u32,
}

struct Pending {
    owner: String,
    request: Request,
    key: Vec<u8>,
    expires: Instant,
    public: Option<PublicKey>,
    trust: Trust,
}

struct Active {
    owner: String,
    cancel: watch::Sender<bool>,
}

/// Short-lived, in-memory permission to repeat read-only SFTP operations after
/// one explicit host-key confirmation. Every operation still reconnects and
/// pins the confirmed key; nothing is persisted or shared across windows.
struct Grant {
    owner: String,
    scope: String,
    request: Request,
    key: Vec<u8>,
    // Needed for every reconnect; zeroized when the grant is dropped.
    credential: Credential,
    idle_until: Instant,
    expires: Instant,
}

impl Grant {
    fn alive(&self, now: Instant) -> bool {
        now < self.idle_until && now < self.expires
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpOpened {
    pub grant_token: String,
    pub idle_seconds: u64,
    pub listing: RemoteListing,
}

struct AuthenticatedSftp {
    _socket: SocketGuard,
    session: client::Handle<KeyCheck>,
    sftp: ReadOnlySftp,
    rekey_rejected: Arc<std::sync::atomic::AtomicBool>,
}

enum SftpRequest {
    Open,
    List(String),
    Metadata(String),
    Read(String),
}

enum SftpResult {
    List(RemoteListing),
    Metadata(RemoteEntry),
    Read(Vec<u8>),
}

/// Failures carrying evidence against the confirmed trust (host key changed,
/// rekey, public key now rejected) revoke a grant. Transport, local resource,
/// file-level, timeout and cancellation failures keep it.
enum SftpFailure {
    Revoke(String),
    Keep(String),
}

/// Everything needed to reconnect for one SFTP operation.
struct Target {
    request: Request,
    key: Vec<u8>,
    credential: Credential,
}

impl SftpFailure {
    fn message(self) -> String {
        match self {
            Self::Revoke(message) | Self::Keep(message) => message,
        }
    }
}

#[derive(Default)]
struct Registry {
    scopes: HashMap<String, String>,
    active: HashMap<String, Active>,
    challenges: HashMap<String, Pending>,
    // Cancellation before command dispatch is remembered. Saturation fails closed
    // until application restart rather than evicting a still-queued cancellation.
    cancelled: HashMap<String, HashSet<String>>,
    completed: VecDeque<(String, String)>,
    shutdown: bool,
    terminals: HashMap<String, Arc<terminal::Terminal>>,
    grants: HashMap<String, Grant>,
}

#[derive(Default)]
pub struct Ssh {
    registry: Mutex<Registry>,
    known_hosts: Option<KnownHosts>,
    prompts: Arc<Prompts>,
}

struct Operation<'a> {
    service: &'a Ssh,
    id: String,
    owner: String,
    cancel: watch::Receiver<bool>,
    handed_off: bool,
}

impl Drop for Operation<'_> {
    fn drop(&mut self) {
        if self.handed_off {
            return;
        }
        let mut registry = self
            .service
            .registry
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if let Some(active) = registry.active.remove(&self.id) {
            active.cancel.send_replace(true);
        }
        if registry.completed.len() == MAX_CANCELLED {
            registry.completed.pop_front();
        }
        registry
            .completed
            .push_back((self.owner.clone(), self.id.clone()));
    }
}

impl Ssh {
    /// A service whose confirmed host keys may be saved to `path`.
    pub fn with_known_hosts(path: std::path::PathBuf) -> Self {
        Self {
            known_hosts: Some(KnownHosts::new(path)),
            ..Self::default()
        }
    }

    /// Shortens how long one keyboard-interactive round waits for an answer
    /// (tests). It never exceeds [`ROUND_DEADLINE`].
    pub fn with_prompt_deadline(mut self, deadline: Duration) -> Self {
        self.prompts = Arc::new(Prompts::with_deadline(deadline));
        self
    }

    /// Answers round `round` of operation `id`, which must be waiting and
    /// must have been started by `owner`.
    pub fn auth_respond(
        &self,
        owner: &str,
        id: &str,
        round: u32,
        answers: Vec<zeroize::Zeroizing<String>>,
    ) -> Result<(), String> {
        uuid::Uuid::parse_str(id).map_err(|_| "Invalid operation ID")?;
        self.prompts.respond(owner, id, round, answers)
    }

    fn prompter(
        &self,
        operation: &Operation<'_>,
        sink: Option<PromptSink>,
        clock: &Clock,
    ) -> Option<Prompter> {
        sink.map(|sink| Prompter {
            prompts: self.prompts.clone(),
            owner: operation.owner.clone(),
            id: operation.id.clone(),
            sink,
            clock: clock.clone(),
        })
    }

    pub fn context(&self, owner: &str) -> Result<String, String> {
        let mut registry = self.registry.lock().map_err(|_| "SSH state unavailable")?;
        if registry.shutdown {
            return Err("SSH is shutting down".into());
        }
        Ok(registry
            .scopes
            .entry(owner.into())
            .or_insert_with(|| uuid::Uuid::new_v4().to_string())
            .clone())
    }

    fn start(&self, owner: &str, id: &str, scope: &str) -> Result<Operation<'_>, String> {
        uuid::Uuid::parse_str(id).map_err(|_| "Invalid operation ID")?;
        let mut registry = self.registry.lock().map_err(|_| "SSH state unavailable")?;
        if registry.shutdown {
            return Err("SSH is shutting down".into());
        }
        if registry.scopes.get(owner).map(String::as_str) != Some(scope) {
            return Err("SSH document context expired; reopen verification".into());
        }
        if registry
            .completed
            .iter()
            .any(|(done_owner, done_id)| done_owner == owner && done_id == id)
        {
            return Err("SSH operation ID already used".into());
        }
        if registry
            .cancelled
            .get(owner)
            .is_some_and(|ids| ids.len() >= MAX_CANCELLED || ids.contains(id))
        {
            return Err(
                "SSH operation cancelled; restart the app if cancellation capacity was reached"
                    .into(),
            );
        }
        if registry.active.len() >= MAX_ACTIVE || registry.active.contains_key(id) {
            return Err("SSH operation capacity reached".into());
        }
        let (cancel, receiver) = watch::channel(false);
        registry.active.insert(
            id.into(),
            Active {
                owner: owner.into(),
                cancel,
            },
        );
        Ok(Operation {
            service: self,
            id: id.into(),
            owner: owner.into(),
            cancel: receiver,
            handed_off: false,
        })
    }

    pub fn cancel(&self, owner: &str, id: &str) -> Result<(), String> {
        uuid::Uuid::parse_str(id).map_err(|_| "Invalid operation ID")?;
        let mut registry = self.registry.lock().map_err(|_| "SSH state unavailable")?;
        if let Some(active) = registry.active.get(id) {
            if active.owner != owner {
                return Err("SSH operation not owned by this window".into());
            }
            active.cancel.send_replace(true);
            return Ok(());
        }
        if registry
            .completed
            .iter()
            .any(|(done_owner, done_id)| done_owner == owner && done_id == id)
        {
            return Ok(());
        }
        let ids = registry.cancelled.entry(owner.into()).or_default();
        if ids.len() < MAX_CANCELLED {
            ids.insert(id.into());
        }
        Ok(())
    }

    pub fn close_owner(&self, owner: &str) {
        let mut registry = self.registry.lock().unwrap_or_else(|e| e.into_inner());
        registry.scopes.remove(owner);
        for active in registry
            .active
            .values()
            .filter(|active| active.owner == owner)
        {
            active.cancel.send_replace(true);
        }
        registry
            .challenges
            .retain(|_, pending| pending.owner != owner);
        registry.grants.retain(|_, grant| grant.owner != owner);
        drop(registry);
        self.prompts.close_owner(owner);
    }

    pub fn shutdown(&self) {
        let mut registry = self.registry.lock().unwrap_or_else(|e| e.into_inner());
        registry.shutdown = true;
        for active in registry.active.values() {
            active.cancel.send_replace(true);
        }
        registry.challenges.clear();
        registry.grants.clear();
        drop(registry);
        self.prompts.clear();
    }

    pub fn reject(&self, owner: &str, token: &str) -> Result<(), String> {
        let mut registry = self.registry.lock().map_err(|_| "SSH state unavailable")?;
        if registry
            .challenges
            .get(token)
            .is_some_and(|pending| pending.owner != owner)
        {
            return Err("SSH challenge not owned by this window".into());
        }
        registry.challenges.remove(token);
        Ok(())
    }

    fn consume(&self, owner: &str, token: &str) -> Result<Pending, String> {
        let mut registry = self.registry.lock().map_err(|_| "SSH state unavailable")?;
        let pending = registry
            .challenges
            .get(token)
            .ok_or("SSH challenge expired or already used")?;
        if pending.owner != owner {
            return Err("SSH challenge not owned by this window".into());
        }
        // A changed key stays pending so the user can still replace it explicitly.
        if pending.trust == Trust::Changed && pending.expires > Instant::now() {
            return Err(HOST_CHANGED.into());
        }
        let pending = registry
            .challenges
            .remove(token)
            .ok_or("SSH challenge expired or already used")?;
        if pending.expires <= Instant::now() || pending.trust == Trust::Changed {
            return Err("SSH challenge expired or already used".into());
        }
        Ok(pending)
    }

    /// Saves the confirmed key of a new host. Never overwrites a changed key.
    pub fn trust_save(&self, owner: &str, token: &str) -> Result<(), String> {
        self.update_trust(owner, token, Trust::New)
    }

    /// Replaces a saved key that changed. A separate, explicit user action.
    pub fn trust_replace(&self, owner: &str, token: &str) -> Result<(), String> {
        self.update_trust(owner, token, Trust::Changed)
    }

    fn update_trust(&self, owner: &str, token: &str, from: Trust) -> Result<(), String> {
        let store = self
            .known_hosts
            .as_ref()
            .ok_or("Saving host keys is unavailable")?;
        let (host, port, public, trust) = {
            let registry = self.registry.lock().map_err(|_| "SSH state unavailable")?;
            let pending = registry
                .challenges
                .get(token)
                .filter(|pending| pending.expires > Instant::now())
                .ok_or("SSH challenge expired or already used")?;
            if pending.owner != owner {
                return Err("SSH challenge not owned by this window".into());
            }
            let public = pending.public.clone().ok_or("Host key unavailable")?;
            (
                pending.request.host.clone(),
                pending.request.port,
                public,
                pending.trust,
            )
        };
        if trust == Trust::Known {
            return Ok(());
        }
        if trust != from {
            return Err(match trust {
                Trust::Changed => HOST_CHANGED,
                _ => "Only a changed host key can be replaced",
            }
            .into());
        }
        // File I/O happens outside the registry lock.
        store.remember(&host, port, &public)?;
        let mut registry = self.registry.lock().map_err(|_| "SSH state unavailable")?;
        let pending = registry
            .challenges
            .get_mut(token)
            .ok_or("SSH challenge expired or already used")?;
        pending.trust = Trust::Known;
        Ok(())
    }

    pub async fn probe(
        &self,
        owner: &str,
        id: &str,
        request: Request,
        scope: &str,
    ) -> Result<Challenge, String> {
        validate(&request)?;
        let mut operation = self.start(owner, id, scope)?;
        let observed = Arc::new(Mutex::new(None));
        let work = async {
            let (_socket, stream) = transport(&request).await?;
            let handler = KeyCheck {
                expected: None,
                observed: observed.clone(),
                mismatch: Arc::default(),
                kex_seen: false,
                rekey_rejected: Arc::default(),
                routes: Arc::default(),
            };
            // Deliberately reject every unknown key. No user authentication occurs.
            let _ = client::connect_stream(config(), stream, handler).await;
            let key = observed
                .lock()
                .map_err(|_| "SSH state unavailable")?
                .take()
                .ok_or("SSH handshake failed or host key is not Ed25519")?;
            Ok::<_, String>(key)
        };
        let public: PublicKey = tokio::select! {
            biased;
            _ = operation.cancel.changed() => return Err("SSH operation cancelled".into()),
            result = tokio::time::timeout(DEADLINE, work) => result.map_err(|_| "SSH operation timed out")??,
        };
        let key = public
            .to_bytes()
            .map_err(|_| "Host key cannot be encoded")?;
        let fingerprint = public.fingerprint(HashAlg::Sha256).to_string();
        // An unreadable store fails closed instead of downgrading to "new".
        let (trust, saved_fingerprint) = match &self.known_hosts {
            None => (Trust::New, None),
            Some(store) => match store.check(&request.host, request.port, &public)? {
                Saved::Unknown => (Trust::New, None),
                Saved::Match => (Trust::Known, None),
                Saved::Changed(saved) => (Trust::Changed, Some(saved)),
            },
        };
        let token = uuid::Uuid::new_v4().to_string();
        let mut registry = self.registry.lock().map_err(|_| "SSH state unavailable")?;
        if *operation.cancel.borrow() || registry.shutdown {
            return Err("SSH operation cancelled".into());
        }
        registry
            .challenges
            .retain(|_, pending| pending.expires > Instant::now());
        if registry.challenges.len() >= MAX_CHALLENGES {
            return Err("SSH challenge capacity reached".into());
        }
        let challenge = Challenge {
            challenge_token: token.clone(),
            host: request.host.clone(),
            port: request.port,
            algorithm: "ssh-ed25519".into(),
            fingerprint,
            expires_in_seconds: TRUST_TTL.as_secs(),
            trust,
            saved_fingerprint,
        };
        registry.challenges.insert(
            token,
            Pending {
                owner: operation.owner.clone(),
                request,
                key,
                expires: Instant::now() + TRUST_TTL,
                public: Some(public),
                trust,
            },
        );
        Ok(challenge)
    }

    pub async fn accept(
        &self,
        owner: &str,
        id: &str,
        token: &str,
        scope: &str,
    ) -> Result<Output, String> {
        self.accept_with(owner, id, token, scope, Credential::default())
            .await
    }

    pub async fn accept_with(
        &self,
        owner: &str,
        id: &str,
        token: &str,
        scope: &str,
        login: impl Into<Login>,
    ) -> Result<Output, String> {
        let Login {
            credential,
            prompts,
        } = login.into();
        let mut operation = self.start(owner, id, scope)?;
        check_prompts(&credential, prompts.as_ref())?;
        let pending = self.consume(owner, token)?;
        credential.validate(&pending.request)?;
        let clock = Clock::new(DEADLINE);
        let prompter = self.prompter(&operation, prompts, &clock);
        let work = execute(
            pending,
            credential,
            operation.cancel.clone(),
            prompter.as_ref(),
        );
        let output = tokio::select! {
            biased;
            _ = operation.cancel.changed() => return Err("SSH operation cancelled".into()),
            _ = clock.expired() => return Err("SSH operation timed out".into()),
            result = work => result?,
        };
        if *operation.cancel.borrow() {
            return Err("SSH operation cancelled".into());
        }
        Ok(output)
    }

    /// Consumes a confirmed challenge, lists the login directory, and only then
    /// issues a grant for further read-only operations against the same key.
    pub async fn sftp_open(
        &self,
        owner: &str,
        id: &str,
        token: &str,
        scope: &str,
    ) -> Result<SftpOpened, String> {
        self.sftp_open_with(owner, id, token, scope, Credential::default())
            .await
    }

    pub async fn sftp_open_with(
        &self,
        owner: &str,
        id: &str,
        token: &str,
        scope: &str,
        login: impl Into<Login>,
    ) -> Result<SftpOpened, String> {
        let Login {
            credential,
            prompts,
        } = login.into();
        let operation = self.start(owner, id, scope)?;
        check_prompts(&credential, prompts.as_ref())?;
        // Fail before any network work when no grant could be issued anyway.
        self.grant_capacity()?;
        let pending = self.consume(owner, token)?;
        credential.validate(&pending.request)?;
        let (request, key) = (pending.request, pending.key);
        let target = Target {
            request: request.clone(),
            key: key.clone(),
            credential: credential.clone(),
        };
        // A prompted grant keeps no answers: every later operation asks again.
        let listing = match self
            .run_sftp(&operation, target, SftpRequest::Open, prompts)
            .await
            .map_err(SftpFailure::message)?
        {
            SftpResult::List(listing) => listing,
            _ => return Err("Unexpected SFTP result".into()),
        };
        let grant_token = self.issue_grant(&operation, scope, request, key, credential)?;
        Ok(SftpOpened {
            grant_token,
            idle_seconds: SFTP_IDLE.as_secs(),
            listing,
        })
    }

    /// `prompts` is required when the grant came from prompted
    /// keyboard-interactive: each reconnect asks the user again.
    pub async fn sftp_list(
        &self,
        owner: &str,
        id: &str,
        grant: &str,
        scope: &str,
        path: String,
        prompts: Option<PromptSink>,
    ) -> Result<RemoteListing, String> {
        match self
            .sftp_request(owner, id, grant, scope, SftpRequest::List(path), prompts)
            .await?
        {
            SftpResult::List(listing) => Ok(listing),
            _ => Err("Unexpected SFTP result".into()),
        }
    }

    pub async fn sftp_metadata(
        &self,
        owner: &str,
        id: &str,
        grant: &str,
        scope: &str,
        path: String,
        prompts: Option<PromptSink>,
    ) -> Result<RemoteEntry, String> {
        let request = SftpRequest::Metadata(path);
        match self
            .sftp_request(owner, id, grant, scope, request, prompts)
            .await?
        {
            SftpResult::Metadata(entry) => Ok(entry),
            _ => Err("Unexpected SFTP result".into()),
        }
    }

    pub async fn sftp_read(
        &self,
        owner: &str,
        id: &str,
        grant: &str,
        scope: &str,
        path: String,
        prompts: Option<PromptSink>,
    ) -> Result<Vec<u8>, String> {
        match self
            .sftp_request(owner, id, grant, scope, SftpRequest::Read(path), prompts)
            .await?
        {
            SftpResult::Read(bytes) => Ok(bytes),
            _ => Err("Unexpected SFTP result".into()),
        }
    }

    /// Revokes a grant. Idempotent. An operation that already passed
    /// `use_grant` may still finish within its deadline; the UI cancels it.
    pub fn sftp_close(&self, owner: &str, grant: &str) -> Result<(), String> {
        let mut registry = self.registry.lock().map_err(|_| "SSH state unavailable")?;
        if registry
            .grants
            .get(grant)
            .is_some_and(|grant| grant.owner != owner)
        {
            return Err("SFTP session not owned by this window".into());
        }
        registry.grants.remove(grant);
        Ok(())
    }

    async fn sftp_request(
        &self,
        owner: &str,
        id: &str,
        grant: &str,
        scope: &str,
        request: SftpRequest,
        prompts: Option<PromptSink>,
    ) -> Result<SftpResult, String> {
        let operation = self.start(owner, id, scope)?;
        let target = self.use_grant(owner, grant, scope)?;
        check_prompts(&target.credential, prompts.as_ref())?;
        self.run_sftp(&operation, target, request, prompts)
            .await
            .map_err(|failure| match failure {
                SftpFailure::Revoke(message) => {
                    self.revoke_grant(owner, grant);
                    format!("{message}; {SFTP_REVOKED}")
                }
                SftpFailure::Keep(message) => message,
            })
    }

    async fn run_sftp(
        &self,
        operation: &Operation<'_>,
        target: Target,
        request: SftpRequest,
        prompts: Option<PromptSink>,
    ) -> Result<SftpResult, SftpFailure> {
        let mut cancel = operation.cancel.clone();
        let clock = Clock::new(DEADLINE);
        let prompter = self.prompter(operation, prompts, &clock);
        let work = execute_sftp(target, cancel.clone(), request, prompter.as_ref());
        tokio::select! {
            biased;
            _ = cancel.changed() => Err(SftpFailure::Keep("SSH operation cancelled".into())),
            _ = clock.expired() => Err(SftpFailure::Keep("SFTP operation timed out".into())),
            result = work => result,
        }
    }

    fn grant_capacity(&self) -> Result<(), String> {
        let mut registry = self.registry.lock().map_err(|_| "SSH state unavailable")?;
        let now = Instant::now();
        registry.grants.retain(|_, grant| grant.alive(now));
        if registry.grants.len() >= MAX_SFTP_GRANTS {
            return Err(SFTP_CAPACITY.into());
        }
        Ok(())
    }

    fn issue_grant(
        &self,
        operation: &Operation<'_>,
        scope: &str,
        request: Request,
        key: Vec<u8>,
        credential: Credential,
    ) -> Result<String, String> {
        let mut registry = self.registry.lock().map_err(|_| "SSH state unavailable")?;
        if *operation.cancel.borrow()
            || registry.shutdown
            || registry.scopes.get(&operation.owner).map(String::as_str) != Some(scope)
        {
            return Err("SSH operation cancelled".into());
        }
        let now = Instant::now();
        registry.grants.retain(|_, grant| grant.alive(now));
        if registry.grants.len() >= MAX_SFTP_GRANTS {
            return Err(SFTP_CAPACITY.into());
        }
        let token = uuid::Uuid::new_v4().to_string();
        registry.grants.insert(
            token.clone(),
            Grant {
                owner: operation.owner.clone(),
                scope: scope.into(),
                request,
                key,
                credential,
                idle_until: now + SFTP_IDLE,
                expires: now + SFTP_LIFETIME,
            },
        );
        Ok(token)
    }

    fn use_grant(&self, owner: &str, token: &str, scope: &str) -> Result<Target, String> {
        let mut registry = self.registry.lock().map_err(|_| "SSH state unavailable")?;
        let now = Instant::now();
        registry.grants.retain(|_, grant| grant.alive(now));
        let grant = registry.grants.get_mut(token).ok_or(SFTP_EXPIRED)?;
        if grant.owner != owner {
            return Err("SFTP session not owned by this window".into());
        }
        if grant.scope != scope {
            registry.grants.remove(token);
            return Err(SFTP_EXPIRED.into());
        }
        grant.idle_until = (now + SFTP_IDLE).min(grant.expires);
        Ok(Target {
            request: grant.request.clone(),
            key: grant.key.clone(),
            credential: grant.credential.clone(),
        })
    }

    fn revoke_grant(&self, owner: &str, token: &str) {
        let mut registry = self.registry.lock().unwrap_or_else(|e| e.into_inner());
        if registry
            .grants
            .get(token)
            .is_some_and(|grant| grant.owner == owner)
        {
            registry.grants.remove(token);
        }
    }
}

fn validate(request: &Request) -> Result<(), String> {
    if request.host.is_empty()
        || request.host.len() > 253
        || !request
            .host
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || ".-:".contains(c))
        || request.port == 0
    {
        return Err("Invalid SSH host or port".into());
    }
    if request.username.is_empty()
        || request.username.len() > 64
        || request.username.chars().any(|c| c.is_control())
    {
        return Err("Invalid SSH username".into());
    }
    // Empty means password or agent authentication; checked when consumed.
    if !request.private_key_path.is_empty()
        && (request.private_key_path.len() > 4096
            || !std::path::Path::new(&request.private_key_path).is_absolute()
            || request.private_key_path.contains('\0'))
    {
        return Err("An absolute private key path is required".into());
    }
    if crate::platform::is_device_path(std::path::Path::new(&request.private_key_path)) {
        return Err("Private key must be a regular file".into());
    }
    Ok(())
}

struct SocketGuard(std::net::TcpStream);
impl Drop for SocketGuard {
    fn drop(&mut self) {
        // Best effort: an already-closed peer can make shutdown fail. Owning this
        // descriptor still guarantees it is dropped, including cancellation.
        let _ = self.0.shutdown(Shutdown::Both);
    }
}

async fn transport(request: &Request) -> Result<(SocketGuard, TcpStream), String> {
    let stream = TcpStream::connect((request.host.as_str(), request.port))
        .await
        .map_err(|_| "SSH connection failed")?;
    let socket = stream.into_std().map_err(|_| "SSH transport failed")?;
    let guard = SocketGuard(socket.try_clone().map_err(|_| "SSH transport failed")?);
    let stream = TcpStream::from_std(socket).map_err(|_| "SSH transport failed")?;
    Ok((guard, stream))
}

/// Every connection starts from this; variants change only what differs.
fn base_config() -> client::Config {
    client::Config {
        inactivity_timeout: Some(DEADLINE),
        ..Default::default()
    }
}

fn config() -> Arc<client::Config> {
    Arc::new(base_config())
}

/// Prompted authentication leaves the connection silent while the user
/// types, so its transport idles longer; the operation clock still bounds
/// the network time outside of those waits.
fn config_for(credential: &Credential) -> Arc<client::Config> {
    let mut config = base_config();
    if credential.is_prompted() {
        config.inactivity_timeout = Some(ROUND_DEADLINE + DEADLINE);
    }
    Arc::new(config)
}

type Observed = Arc<Mutex<Option<PublicKey>>>;
/// Server-initiated channels this connection may accept. Everything not
/// listed here (sessions, direct-tcpip, X11, streamlocal) is refused.
pub(crate) struct Routes {
    /// Remote forwards: (bind address, bound port) → local host and port.
    pub(crate) remote: Mutex<HashMap<(String, u32), (String, u16)>>,
    /// Agent forwarding, enabled per connection by an explicit user choice.
    pub(crate) agent: std::sync::atomic::AtomicBool,
    /// Bounds concurrent forwarded-tcpip channels, as local forwards are.
    remote_channels: Arc<tokio::sync::Semaphore>,
}

impl Routes {
    pub(crate) fn limited(remote_channels: usize) -> Self {
        Self {
            remote: Mutex::default(),
            agent: std::sync::atomic::AtomicBool::default(),
            remote_channels: Arc::new(tokio::sync::Semaphore::new(remote_channels)),
        }
    }
}

impl Default for Routes {
    fn default() -> Self {
        Self::limited(forward::MAX_CONNECTIONS)
    }
}

pub(crate) struct KeyCheck {
    expected: Option<Vec<u8>>,
    observed: Observed,
    mismatch: Arc<std::sync::atomic::AtomicBool>,
    kex_seen: bool,
    rekey_rejected: Arc<std::sync::atomic::AtomicBool>,
    routes: Arc<Routes>,
}
impl client::Handler for KeyCheck {
    type Error = russh::Error;
    async fn kex_done(
        &mut self,
        _shared_secret: Option<&[u8]>,
        _names: &russh::Names,
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        // russh 0.64.1 calls check_server_key only for the initial exchange.
        // Its rekey callback exposes no host key, so reject subsequent exchanges
        // before new keys are installed instead of silently weakening the pin.
        if self.kex_seen {
            self.rekey_rejected
                .store(true, std::sync::atomic::Ordering::SeqCst);
            return Err(russh::Error::UnknownKey);
        }
        self.kex_seen = true;
        Ok(())
    }
    // russh accepts server-initiated channels by default; dropping the reply
    // refuses them. Only registered routes are accepted.
    async fn server_channel_open_forwarded_tcpip(
        &mut self,
        channel: russh::Channel<client::Msg>,
        connected_address: &str,
        connected_port: u32,
        _originator_address: &str,
        _originator_port: u32,
        reply: client::ChannelOpenHandle,
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        let route = self
            .routes
            .remote
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&(connected_address.to_string(), connected_port))
            .cloned();
        let Some((host, port)) = route else {
            return Ok(());
        };
        let Ok(permit) = self.routes.remote_channels.clone().try_acquire_owned() else {
            return Ok(());
        };
        let connect = TcpStream::connect((host.as_str(), port));
        let Ok(Ok(target)) = tokio::time::timeout(Duration::from_secs(5), connect).await else {
            return Ok(());
        };
        reply.accept().await;
        tokio::spawn(async move {
            forward::pump(channel, target).await;
            drop(permit);
        });
        Ok(())
    }
    async fn server_channel_open_agent_forward(
        &mut self,
        channel: russh::Channel<client::Msg>,
        reply: client::ChannelOpenHandle,
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        if !self.routes.agent.load(std::sync::atomic::Ordering::SeqCst) {
            return Ok(());
        }
        #[cfg(unix)]
        let agent = match std::env::var_os("SSH_AUTH_SOCK") {
            Some(path) => tokio::net::UnixStream::connect(path).await.ok(),
            None => None,
        };
        #[cfg(windows)]
        let agent = tokio::net::windows::named_pipe::ClientOptions::new()
            .open(r"\\.\pipe\openssh-ssh-agent")
            .ok();
        let Some(agent) = agent else { return Ok(()) };
        reply.accept().await;
        tokio::spawn(forward::pump(channel, agent));
        Ok(())
    }
    async fn server_channel_open_session(
        &mut self,
        _channel: russh::Channel<client::Msg>,
        _reply: client::ChannelOpenHandle,
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        Ok(())
    }
    async fn server_channel_open_direct_tcpip(
        &mut self,
        _channel: russh::Channel<client::Msg>,
        _host_to_connect: &str,
        _port_to_connect: u32,
        _originator_address: &str,
        _originator_port: u32,
        _reply: client::ChannelOpenHandle,
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        Ok(())
    }
    async fn server_channel_open_x11(
        &mut self,
        _channel: russh::Channel<client::Msg>,
        _originator_address: &str,
        _originator_port: u32,
        _reply: client::ChannelOpenHandle,
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        Ok(())
    }
    async fn check_server_key(
        &mut self,
        key: &PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        use std::sync::atomic::Ordering;
        let PublicKeyOrCertificate::PublicKey { key, .. } = key else {
            self.mismatch.store(true, Ordering::Relaxed);
            return Ok(false);
        };
        if key.algorithm() != Algorithm::Ed25519 {
            self.mismatch.store(true, Ordering::Relaxed);
            return Ok(false);
        }
        let bytes = key.to_bytes().map_err(|_| russh::Error::UnknownKey)?;
        if let Some(expected) = &self.expected {
            let matches = expected == &bytes;
            self.mismatch.store(!matches, Ordering::Relaxed);
            Ok(matches)
        } else {
            *self.observed.lock().unwrap_or_else(|e| e.into_inner()) = Some(key.clone());
            Ok(false)
        }
    }
}

fn private_key(path: &str, passphrase: Option<&str>) -> Result<PrivateKeyWithHashAlg, String> {
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NONBLOCK);
    }
    // Check both before and after open; nonblocking open also rejects FIFO races
    // without hanging a runtime worker on Unix. Never return a filesystem error.
    if !std::fs::metadata(path)
        .map_err(|_| "Cannot read private key")?
        .is_file()
    {
        return Err("Private key must be a regular file".into());
    }
    let file = options.open(path).map_err(|_| "Cannot read private key")?;
    // Windows `is_file` also accepts pipes and character devices (`C:\x\CON`).
    #[cfg(windows)]
    if !crate::platform::windows::is_disk_file(&file) {
        return Err("Private key must be a regular file".into());
    }
    let metadata = file.metadata().map_err(|_| "Cannot read private key")?;
    if !metadata.is_file() || metadata.len() > MAX_BYTES as u64 {
        return Err("Private key must be a regular file of at most 64 KiB".into());
    }
    let mut bytes = zeroize::Zeroizing::new(Vec::new());
    file.take(MAX_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "Cannot read private key")?;
    if bytes.len() > MAX_BYTES {
        return Err("Private key exceeds 64 KiB".into());
    }
    let content = std::str::from_utf8(&bytes).map_err(|_| "Invalid private key")?;
    check_kdf_cost(content, MAX_KDF_ROUNDS)?;
    let key = russh::keys::decode_secret_key(content, passphrase).map_err(|_| {
        if passphrase.is_some() {
            "Private key could not be decrypted; check the passphrase"
        } else {
            "Invalid private key, or it is encrypted and needs a passphrase"
        }
    })?;
    // RSA needs the russh `rsa` feature, which this build does not enable.
    if !matches!(
        key.algorithm(),
        Algorithm::Ed25519 | Algorithm::Ecdsa { .. }
    ) {
        return Err("P0 supports Ed25519 and ECDSA private keys".into());
    }
    Ok(PrivateKeyWithHashAlg::new(Arc::new(key), None))
}

/// bcrypt cost is chosen by whoever wrote the key file and decryption cannot be
/// cancelled, so refuse extreme costs before holding a reader permit for them.
fn check_kdf_cost(content: &str, max_rounds: u32) -> Result<(), String> {
    if let Ok(parsed) = russh::keys::ssh_key::PrivateKey::from_openssh(content) {
        if let russh::keys::ssh_key::Kdf::Bcrypt { rounds, .. } = parsed.kdf() {
            if *rounds > max_rounds {
                return Err(format!(
                    "Private key encryption cost is too high (more than {max_rounds} bcrypt rounds)"
                ));
            }
        }
    }
    Ok(())
}

async fn execute(
    pending: Pending,
    credential: Credential,
    cancel: watch::Receiver<bool>,
    prompter: Option<&Prompter>,
) -> Result<Output, String> {
    let (_socket, stream) = transport(&pending.request).await?;
    let mismatch = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let rekey_rejected = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let handler = KeyCheck {
        expected: Some(pending.key),
        observed: Arc::default(),
        mismatch: mismatch.clone(),
        kex_seen: false,
        rekey_rejected: rekey_rejected.clone(),
        routes: Arc::default(),
    };
    let mut session = client::connect_stream(config_for(&credential), stream, handler)
        .await
        .map_err(|_| {
            if mismatch.load(std::sync::atomic::Ordering::Relaxed) {
                "SSH host key changed; authentication was not attempted"
            } else {
                "SSH handshake failed"
            }
        })?;
    // Credentials are used only after the new handshake matched the pin.
    auth::authenticate(
        &mut session,
        &pending.request,
        &credential,
        cancel,
        prompter,
    )
    .await
    .map_err(AuthFailure::message)?;
    let mut channel = session
        .channel_open_session()
        .await
        .map_err(|_| "SSH channel open failed")?;
    channel
        .exec(true, "fixture-check")
        .await
        .map_err(|_| "SSH command request failed")?;
    let mut output = Output::default();
    let mut exit = None;
    while let Some(message) = channel.wait().await {
        match message {
            ChannelMsg::Data { data } => append(&mut output, &data, false)?,
            ChannelMsg::ExtendedData { data, ext: 1 } => append(&mut output, &data, true)?,
            ChannelMsg::ExtendedData { .. } => return Err("Unexpected SSH extended data".into()),
            ChannelMsg::ExitStatus { exit_status } => exit = Some(exit_status),
            ChannelMsg::Failure => return Err("SSH command rejected".into()),
            ChannelMsg::ExitSignal { .. } => return Err("SSH command terminated by signal".into()),
            ChannelMsg::Close => break,
            _ => {}
        }
    }
    if rekey_rejected.load(std::sync::atomic::Ordering::SeqCst) {
        return Err(REKEY_ERROR.into());
    }
    output.exit_code = exit.ok_or("SSH channel closed without exit status")?;
    // The command result is complete. Graceful disconnect is best effort and
    // cannot replace that result; SocketGuard forces transport shutdown even if
    // the peer ignores disconnect or the russh background task does not finish.
    let _ = session
        .disconnect(
            russh::Disconnect::ByApplication,
            "P0 verification finished",
            "en",
        )
        .await;
    let _ = tokio::time::timeout(Duration::from_millis(250), session).await;
    Ok(output)
}

async fn execute_sftp(
    target: Target,
    cancel: watch::Receiver<bool>,
    request: SftpRequest,
    prompter: Option<&Prompter>,
) -> Result<SftpResult, SftpFailure> {
    let authenticated = connect_sftp(target, cancel, prompter).await?;
    let AuthenticatedSftp {
        _socket,
        session,
        sftp,
        rekey_rejected,
    } = authenticated;
    let result = match request {
        SftpRequest::Open => match sftp.canonicalize(".").await {
            Ok(home) => sftp.list(&home).await.map(SftpResult::List),
            Err(error) => Err(error),
        },
        SftpRequest::List(path) => sftp.list(&path).await.map(SftpResult::List),
        SftpRequest::Metadata(path) => sftp.metadata(&path).await.map(SftpResult::Metadata),
        SftpRequest::Read(path) => sftp.read(&path).await.map(SftpResult::Read),
    };
    let _ = sftp.close().await;
    if rekey_rejected.load(std::sync::atomic::Ordering::SeqCst) {
        return Err(SftpFailure::Revoke(REKEY_ERROR.into()));
    }
    let _ = session
        .disconnect(
            russh::Disconnect::ByApplication,
            "P0 SFTP operation finished",
            "en",
        )
        .await;
    let _ = tokio::time::timeout(Duration::from_millis(250), session).await;
    result.map_err(SftpFailure::Keep)
}

async fn connect_sftp(
    target: Target,
    cancel: watch::Receiver<bool>,
    prompter: Option<&Prompter>,
) -> Result<AuthenticatedSftp, SftpFailure> {
    let Target {
        request: target,
        key,
        credential,
    } = target;
    let (socket, stream) = transport(&target).await.map_err(SftpFailure::Keep)?;
    let mismatch = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let rekey_rejected = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let handler = KeyCheck {
        expected: Some(key),
        observed: Arc::default(),
        mismatch: mismatch.clone(),
        kex_seen: false,
        rekey_rejected: rekey_rejected.clone(),
        routes: Arc::default(),
    };
    let mut session = client::connect_stream(config_for(&credential), stream, handler)
        .await
        .map_err(|_| {
            if mismatch.load(std::sync::atomic::Ordering::Relaxed) {
                SftpFailure::Revoke("SSH host key changed; authentication was not attempted".into())
            } else {
                SftpFailure::Keep("SSH handshake failed".into())
            }
        })?;
    auth::authenticate(&mut session, &target, &credential, cancel, prompter)
        .await
        .map_err(|failure| match failure {
            AuthFailure::Rejected(message) => SftpFailure::Revoke(message),
            AuthFailure::Failed(message) => SftpFailure::Keep(message),
        })?;
    let channel = session
        .channel_open_session()
        .await
        .map_err(|_| SftpFailure::Keep("SSH channel open failed".into()))?;
    let sftp = ReadOnlySftp::from_channel(channel)
        .await
        .map_err(SftpFailure::Keep)?;
    if rekey_rejected.load(std::sync::atomic::Ordering::SeqCst) {
        return Err(SftpFailure::Revoke(REKEY_ERROR.into()));
    }
    Ok(AuthenticatedSftp {
        _socket: socket,
        session,
        sftp,
        rekey_rejected,
    })
}

/// SSH over any byte stream (a TCP socket or a channel through a jump host):
/// the server must present exactly `key`, then `credential` authenticates.
#[cfg_attr(not(test), allow(dead_code))] // P0 probe; no UI consumer yet
pub(crate) async fn connect_pinned<S>(
    stream: S,
    request: &Request,
    key: Vec<u8>,
    credential: &Credential,
    cancel: watch::Receiver<bool>,
) -> Result<client::Handle<KeyCheck>, String>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    connect_routed(stream, request, key, credential, cancel, Arc::default()).await
}

/// As [`connect_pinned`], with the caller keeping `routes` to register
/// remote and agent forwarding for this connection later.
#[cfg_attr(not(test), allow(dead_code))] // P0 probe; no UI consumer yet
pub(crate) async fn connect_routed<S>(
    stream: S,
    request: &Request,
    key: Vec<u8>,
    credential: &Credential,
    cancel: watch::Receiver<bool>,
    routes: Arc<Routes>,
) -> Result<client::Handle<KeyCheck>, String>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    let mismatch = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let handler = KeyCheck {
        expected: Some(key),
        observed: Arc::default(),
        mismatch: mismatch.clone(),
        kex_seen: false,
        rekey_rejected: Arc::default(),
        routes,
    };
    let mut session = client::connect_stream(config(), stream, handler)
        .await
        .map_err(|_| {
            if mismatch.load(std::sync::atomic::Ordering::Relaxed) {
                "SSH host key changed; authentication was not attempted"
            } else {
                "SSH handshake failed"
            }
        })?;
    // Forwarding probes have no window to ask: prompted credentials fail closed.
    auth::authenticate(&mut session, request, credential, cancel, None)
        .await
        .map_err(AuthFailure::message)?;
    Ok(session)
}

/// Reads the host key a server presents over `stream` without authenticating.
#[cfg_attr(not(test), allow(dead_code))] // P0 probe; no UI consumer yet
pub(crate) async fn observe_host_key<S>(stream: S) -> Result<PublicKey, String>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    let observed = Arc::new(Mutex::new(None));
    let handler = KeyCheck {
        expected: None,
        observed: observed.clone(),
        mismatch: Arc::default(),
        kex_seen: false,
        rekey_rejected: Arc::default(),
        routes: Arc::default(),
    };
    let _ = client::connect_stream(config(), stream, handler).await;
    let key = observed.lock().map_err(|_| "SSH state unavailable")?.take();
    key.ok_or_else(|| "SSH handshake failed or host key is not Ed25519".into())
}

fn append(output: &mut Output, bytes: &[u8], stderr: bool) -> Result<(), String> {
    if output.stdout.len() + output.stderr.len() + bytes.len() > MAX_BYTES {
        return Err("SSH output exceeds 64 KiB".into());
    }
    if stderr {
        output.stderr.extend_from_slice(bytes);
    } else {
        output.stdout.extend_from_slice(bytes);
    }
    Ok(())
}

async fn read_key_bounded(
    cancel: watch::Receiver<bool>,
    read: impl FnOnce() -> Result<PrivateKeyWithHashAlg, String> + Send + 'static,
) -> Result<PrivateKeyWithHashAlg, String> {
    // A cancelled filesystem read cannot be forcibly stopped. Keep its permit
    // in the blocking closure, even after its awaiting operation has gone away.
    let permit = KEY_READS
        .try_acquire()
        .map_err(|_| "Private key reader capacity reached")?;
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        if *cancel.borrow() {
            return Err("SSH operation cancelled".into());
        }
        read()
    })
    .await
    .map_err(|_| "Private key reader failed")?
}

#[cfg(test)]
mod tests {
    use super::*;
    fn id() -> String {
        uuid::Uuid::new_v4().to_string()
    }
    fn request() -> Request {
        Request {
            host: "127.0.0.1".into(),
            port: 2222,
            username: "fixture".into(),
            private_key_path: std::env::temp_dir().join("key").to_string_lossy().into(),
        }
    }
    fn pending(service: &Ssh, expires: Instant) -> String {
        let token = id();
        service.registry.lock().unwrap().challenges.insert(
            token.clone(),
            Pending {
                owner: "main".into(),
                request: request(),
                key: vec![1, 2, 3],
                expires,
                public: None,
                trust: Trust::New,
            },
        );
        token
    }
    #[test]
    fn challenges_are_owner_bound_one_shot_and_expire() {
        let service = Ssh::default();
        let token = pending(&service, Instant::now() + TRUST_TTL);
        assert!(service.consume("other", &token).is_err());
        assert_eq!(service.consume("main", &token).unwrap().key, [1, 2, 3]);
        assert!(service.consume("main", &token).is_err());
        let token = pending(&service, Instant::now());
        assert!(service.consume("main", &token).is_err());
        assert!(service.registry.lock().unwrap().challenges.is_empty());
    }
    #[test]
    fn rejection_and_reload_revoke_challenges_and_operations() {
        let service = Ssh::default();
        let token = pending(&service, Instant::now() + TRUST_TTL);
        assert!(service.reject("other", &token).is_err());
        service.reject("main", &token).unwrap();
        assert!(service.consume("main", &token).is_err());
        let token = pending(&service, Instant::now() + TRUST_TTL);
        let operation = service
            .start("main", &id(), &service.context("main").unwrap())
            .unwrap();
        service.close_owner("main");
        assert!(*operation.cancel.borrow());
        assert!(service.consume("main", &token).is_err());
    }
    #[test]
    fn cancellation_before_dispatch_and_capacity_fail_closed() {
        let service = Ssh::default();
        let cancelled = id();
        service.cancel("main", &cancelled).unwrap();
        assert!(service
            .start("main", &cancelled, &service.context("main").unwrap())
            .is_err());
        let operations: Vec<_> = (0..MAX_ACTIVE)
            .map(|_| {
                service
                    .start("main", &id(), &service.context("main").unwrap())
                    .unwrap()
            })
            .collect();
        assert!(service
            .start("main", &id(), &service.context("main").unwrap())
            .is_err());
        assert!(service.cancel("other", &operations[0].id).is_err());
        drop(operations);
        assert!(service.registry.lock().unwrap().active.is_empty());
        for _ in 0..MAX_CANCELLED {
            service.cancel("main", &id()).unwrap();
        }
        assert!(service
            .start("main", &id(), &service.context("main").unwrap())
            .is_err());
    }

    #[test]
    fn cancelling_completed_operations_does_not_consume_tombstones() {
        let service = Ssh::default();
        for _ in 0..MAX_CANCELLED * 2 {
            let operation_id = id();
            let operation = service
                .start("main", &operation_id, &service.context("main").unwrap())
                .unwrap();
            service.cancel("main", &operation_id).unwrap();
            drop(operation);
            service.cancel("main", &operation_id).unwrap();
        }
        assert!(service.registry.lock().unwrap().cancelled.is_empty());
        assert!(service
            .start("main", &id(), &service.context("main").unwrap())
            .is_ok());
    }

    #[test]
    fn delayed_old_document_commands_cannot_start_after_reload() {
        let service = Ssh::default();
        let scope = service.context("main").unwrap();
        assert_eq!(service.context("main").unwrap(), scope);
        assert!(service.start("other", &id(), &scope).is_err());
        service.close_owner("main");
        let new_scope = service.context("main").unwrap();
        assert_ne!(scope, new_scope);
        assert!(service.start("main", &id(), &scope).is_err());
        assert!(service.start("main", &id(), &new_scope).is_ok());
    }

    #[test]
    fn private_key_reader_rejects_non_files_and_oversize_without_path_leaks() {
        let root = std::env::temp_dir().join(id());
        std::fs::create_dir(&root).unwrap();
        assert_eq!(
            private_key(root.to_str().unwrap(), None).err().unwrap(),
            "Private key must be a regular file"
        );
        let path = root.join("secret-name");
        std::fs::write(&path, vec![b'x'; MAX_BYTES + 1]).unwrap();
        let error = private_key(path.to_str().unwrap(), None).err().unwrap();
        assert_eq!(
            error,
            "Private key must be a regular file of at most 64 KiB"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn encrypted_keys_with_extreme_bcrypt_cost_are_refused_before_decryption() {
        use russh::keys::ssh_key::{LineEnding, PrivateKey};
        let key = PrivateKey::random(&mut russh::keys::key::safe_rng(), Algorithm::Ed25519)
            .unwrap()
            .encrypt(&mut russh::keys::key::safe_rng(), "pass")
            .unwrap();
        let text = key.to_openssh(LineEnding::LF).unwrap();
        // ssh-key encrypts with its default bcrypt cost (16 rounds).
        assert!(check_kdf_cost(&text, MAX_KDF_ROUNDS).is_ok());
        assert!(check_kdf_cost(&text, 15)
            .unwrap_err()
            .contains("more than 15"));
        let root = std::env::temp_dir().join(id());
        std::fs::create_dir(&root).unwrap();
        let path = root.join("key");
        std::fs::write(&path, text.as_bytes()).unwrap();
        assert!(private_key(path.to_str().unwrap(), Some("pass")).is_ok());
        assert!(private_key(path.to_str().unwrap(), Some("wrong")).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn cancelled_reader_holds_capacity_until_blocking_work_really_ends() {
        let reserved: Vec<_> = (0..MAX_ACTIVE - 1)
            .map(|_| KEY_READS.try_acquire().unwrap())
            .collect();
        let (cancel, receiver) = watch::channel(false);
        let (started, ready) = tokio::sync::oneshot::channel();
        let (release, wait) = std::sync::mpsc::channel();
        let task = tokio::spawn(read_key_bounded(receiver, move || {
            started.send(()).unwrap();
            wait.recv().unwrap();
            Err("controlled read finished".into())
        }));
        ready.await.unwrap();
        assert_eq!(
            read_key_bounded(cancel.subscribe(), || unreachable!())
                .await
                .err()
                .unwrap(),
            "Private key reader capacity reached"
        );
        cancel.send_replace(true);
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
        assert!(KEY_READS.try_acquire().is_err());
        release.send(()).unwrap();
        let released = tokio::time::timeout(Duration::from_secs(2), KEY_READS.acquire())
            .await
            .unwrap()
            .unwrap();
        drop(released);
        assert_eq!(
            read_key_bounded(cancel.subscribe(), || unreachable!())
                .await
                .err()
                .unwrap(),
            "SSH operation cancelled"
        );
        drop(reserved);
        assert_eq!(KEY_READS.available_permits(), MAX_ACTIVE);
    }
    #[test]
    fn output_is_bounded_across_both_streams() {
        let mut output = Output::default();
        append(&mut output, &[42; MAX_BYTES - 1], false).unwrap();
        append(&mut output, &[1], true).unwrap();
        assert!(append(&mut output, &[2], false).is_err());
        assert_eq!(output.stdout.len() + output.stderr.len(), MAX_BYTES);
    }
    #[test]
    fn input_rejects_unbounded_or_ambiguous_targets() {
        let mut input = request();
        assert!(validate(&input).is_ok());
        input.host = "-oProxyCommand=unsafe".into();
        assert!(validate(&input).is_err());
        input = request();
        input.private_key_path = "~/.ssh/id_ed25519".into();
        assert!(validate(&input).is_err());
    }
    #[tokio::test]
    async fn cancellation_closes_a_stalled_handshake_socket() {
        use tokio::io::AsyncReadExt;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let service = Arc::new(Ssh::default());
        let operation_id = id();
        let mut input = request();
        input.port = listener.local_addr().unwrap().port();
        let task_service = service.clone();
        let task_id = operation_id.clone();
        let task = tokio::spawn(async move {
            task_service
                .probe(
                    "main",
                    &task_id,
                    input,
                    &task_service.context("main").unwrap(),
                )
                .await
        });
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut banner = [0; 1024];
        let _ = stream.read(&mut banner).await.unwrap();
        service.cancel("main", &operation_id).unwrap();
        assert!(task.await.unwrap().is_err());
        let mut remaining = Vec::new();
        tokio::time::timeout(Duration::from_secs(2), stream.read_to_end(&mut remaining))
            .await
            .unwrap()
            .unwrap();
        assert!(service.registry.lock().unwrap().active.is_empty());
    }

    #[tokio::test]
    async fn timeout_closes_a_stalled_handshake_socket() {
        use tokio::io::AsyncReadExt;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let service = Arc::new(Ssh::default());
        let mut input = request();
        input.port = listener.local_addr().unwrap().port();
        let task_service = service.clone();
        let task = tokio::spawn(async move {
            task_service
                .probe("main", &id(), input, &task_service.context("main").unwrap())
                .await
        });
        let (mut stream, _) = listener.accept().await.unwrap();
        let error = task.await.unwrap().err().unwrap();
        assert_eq!(error, "SSH operation timed out");
        let mut remaining = Vec::new();
        tokio::time::timeout(Duration::from_secs(2), stream.read_to_end(&mut remaining))
            .await
            .unwrap()
            .unwrap();
        assert!(service.registry.lock().unwrap().active.is_empty());
    }

    #[tokio::test]
    async fn reconnect_mismatch_is_rejected_before_private_key_read() {
        use russh::client::Handler;
        let key =
            russh::keys::PrivateKey::random(&mut russh::keys::key::safe_rng(), Algorithm::Ed25519)
                .unwrap();
        let public = PublicKeyOrCertificate::PublicKey {
            key: key.public_key().clone(),
            hash_alg: None,
        };
        let observed = Arc::default();
        let mismatch = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let mut handler = KeyCheck {
            expected: Some(vec![0]),
            observed,
            mismatch: mismatch.clone(),
            kex_seen: false,
            rekey_rejected: Arc::default(),
            routes: Arc::default(),
        };
        assert!(!handler.check_server_key(&public).await.unwrap());
        assert!(mismatch.load(std::sync::atomic::Ordering::Relaxed));
    }

    fn grant(service: &Ssh, owner: &str, request: Request) -> String {
        let scope = service.context(owner).unwrap();
        let operation = service.start(owner, &id(), &scope).unwrap();
        service
            .issue_grant(
                &operation,
                &scope,
                request,
                vec![1, 2, 3],
                Credential::default(),
            )
            .unwrap()
    }

    #[test]
    fn sftp_grants_are_owner_scope_bound_and_refresh_idle_time() {
        let service = Ssh::default();
        let token = grant(&service, "main", request());
        let scope = service.context("main").unwrap();
        assert_eq!(
            service.use_grant("other", &token, &scope).err().unwrap(),
            "SFTP session not owned by this window"
        );
        assert!(service.sftp_close("other", &token).is_err());
        let before = service.registry.lock().unwrap().grants[&token].idle_until;
        std::thread::sleep(Duration::from_millis(5));
        let target = service.use_grant("main", &token, &scope).unwrap();
        assert_eq!((target.request.port, target.key), (2222, vec![1, 2, 3]));
        assert!(service.registry.lock().unwrap().grants[&token].idle_until > before);
        assert_eq!(
            service
                .use_grant("main", &token, "stale-scope")
                .err()
                .unwrap(),
            SFTP_EXPIRED
        );
        assert!(service.registry.lock().unwrap().grants.is_empty());
    }

    #[test]
    fn sftp_grants_expire_by_idle_time_and_absolute_lifetime() {
        let service = Ssh::default();
        let scope = service.context("main").unwrap();
        for expired in [true, false] {
            let token = grant(&service, "main", request());
            let past = Instant::now() - Duration::from_secs(1);
            let mut registry = service.registry.lock().unwrap();
            let entry = registry.grants.get_mut(&token).unwrap();
            if expired {
                entry.expires = past;
            } else {
                entry.idle_until = past;
            }
            drop(registry);
            assert_eq!(
                service.use_grant("main", &token, &scope).err().unwrap(),
                SFTP_EXPIRED
            );
        }
        assert!(service.registry.lock().unwrap().grants.is_empty());
    }

    #[test]
    fn sftp_grants_are_capped_and_revoked_by_close_reload_and_shutdown() {
        let service = Ssh::default();
        let tokens: Vec<_> = (0..MAX_SFTP_GRANTS)
            .map(|_| grant(&service, "main", request()))
            .collect();
        let scope = service.context("main").unwrap();
        let operation = service.start("main", &id(), &scope).unwrap();
        assert!(service
            .issue_grant(
                &operation,
                &scope,
                request(),
                vec![1],
                Credential::default()
            )
            .is_err());
        service.sftp_close("main", &tokens[0]).unwrap();
        service.sftp_close("main", &tokens[0]).unwrap();
        assert!(service.use_grant("main", &tokens[0], &scope).is_err());
        service.close_owner("main");
        assert!(service.registry.lock().unwrap().grants.is_empty());
        assert!(service
            .issue_grant(
                &operation,
                &scope,
                request(),
                vec![1],
                Credential::default()
            )
            .is_err());
        let _ = grant(&service, "main", request());
        service.shutdown();
        assert!(service.registry.lock().unwrap().grants.is_empty());
    }

    #[tokio::test]
    async fn sftp_transport_failures_and_cancellation_keep_the_grant() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let service = Arc::new(Ssh::default());
        let mut input = request();
        input.port = listener.local_addr().unwrap().port();
        let token = grant(&service, "main", input);
        let scope = service.context("main").unwrap();

        // A stalled handshake cancelled by the user keeps the grant usable.
        let operation_id = id();
        let task = {
            let (service, token, scope, operation_id) = (
                service.clone(),
                token.clone(),
                scope.clone(),
                operation_id.clone(),
            );
            tokio::spawn(async move {
                service
                    .sftp_list("main", &operation_id, &token, &scope, "/".into(), None)
                    .await
            })
        };
        let (stalled, _) = listener.accept().await.unwrap();
        service.cancel("main", &operation_id).unwrap();
        assert_eq!(
            task.await.unwrap().err().unwrap(),
            "SSH operation cancelled"
        );
        drop(stalled);
        assert!(service.registry.lock().unwrap().grants.contains_key(&token));

        // A peer that drops the connection carries no evidence against trust.
        let task = {
            let (service, token, scope) = (service.clone(), token.clone(), scope.clone());
            tokio::spawn(async move {
                service
                    .sftp_metadata("main", &id(), &token, &scope, "/".into(), None)
                    .await
            })
        };
        drop(listener.accept().await.unwrap());
        assert_eq!(task.await.unwrap().err().unwrap(), "SSH handshake failed");
        assert!(service.registry.lock().unwrap().grants.contains_key(&token));
        assert!(service.registry.lock().unwrap().active.is_empty());
    }

    #[test]
    fn evidence_failures_revoke_and_mark_the_grant_closed() {
        let service = Ssh::default();
        let token = grant(&service, "main", request());
        service.revoke_grant("other", &token);
        assert!(service.registry.lock().unwrap().grants.contains_key(&token));
        let message = match SftpFailure::Revoke("SSH public key authentication rejected".into()) {
            SftpFailure::Revoke(message) => {
                service.revoke_grant("main", &token);
                format!("{message}; {SFTP_REVOKED}")
            }
            SftpFailure::Keep(message) => message,
        };
        assert!(message.ends_with("reconnect and verify the host again"));
        assert!(SFTP_EXPIRED.ends_with("reconnect and verify the host again"));
        assert!(service.registry.lock().unwrap().grants.is_empty());
    }

    #[tokio::test]
    async fn reload_during_sftp_open_leaves_no_grant() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let service = Arc::new(Ssh::default());
        let mut input = request();
        input.port = listener.local_addr().unwrap().port();
        let token = id();
        service.registry.lock().unwrap().challenges.insert(
            token.clone(),
            Pending {
                owner: "main".into(),
                request: input,
                key: vec![1],
                expires: Instant::now() + TRUST_TTL,
                public: None,
                trust: Trust::New,
            },
        );
        let scope = service.context("main").unwrap();
        let task = {
            let service = service.clone();
            tokio::spawn(async move { service.sftp_open("main", &id(), &token, &scope).await })
        };
        let (_stalled, _) = listener.accept().await.unwrap();
        service.close_owner("main");
        assert_eq!(
            task.await.unwrap().err().unwrap(),
            "SSH operation cancelled"
        );
        let registry = service.registry.lock().unwrap();
        assert!(registry.grants.is_empty() && registry.active.is_empty());
        assert!(registry.challenges.is_empty());
    }

    #[test]
    fn sftp_open_capacity_fails_before_consuming_the_challenge() {
        let service = Ssh::default();
        for _ in 0..MAX_SFTP_GRANTS {
            let _ = grant(&service, "main", request());
        }
        let token = pending(&service, Instant::now() + TRUST_TTL);
        let scope = service.context("main").unwrap();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let error = runtime
            .block_on(service.sftp_open("main", &id(), &token, &scope))
            .err()
            .unwrap();
        assert_eq!(error, SFTP_CAPACITY);
        assert!(service
            .registry
            .lock()
            .unwrap()
            .challenges
            .contains_key(&token));
    }

    #[tokio::test]
    async fn prompted_sftp_grants_hold_no_answers_and_ask_again_each_time() {
        let service = Ssh::default();
        let scope = service.context("main").unwrap();
        let operation = service.start("main", &id(), &scope).unwrap();
        let prompted = Credential::KeyboardInteractivePrompted {};
        let token = service
            .issue_grant(&operation, &scope, request(), vec![1], prompted)
            .unwrap();
        drop(operation);
        // A later operation without a way to ask the window fails before
        // connecting, and keeps the grant for a retry that can ask.
        let error = service
            .sftp_list("main", &id(), &token, &scope, "/".into(), None)
            .await
            .err()
            .unwrap();
        assert_eq!(error, kbdint::NO_CHANNEL);
        let registry = service.registry.lock().unwrap();
        assert!(registry.grants.contains_key(&token) && registry.active.is_empty());
    }

    #[tokio::test]
    #[ignore = "requires the isolated fixture; run tests/fixtures/ssh-sftp/rust-client.test.mjs"]
    async fn real_fixture_sftp_read_only_browse() {
        use crate::sftp::{RemoteKind, MAX_DIRECTORY_ENTRIES};
        let env = |name: &str| std::env::var(name).unwrap();
        let remote = env("P0_SSH_FIXTURE_REMOTE");
        let service = Ssh::default();
        let scope = service.context("main").unwrap();
        let input_again = || Request {
            host: env("P0_SSH_FIXTURE_HOST"),
            port: env("P0_SSH_FIXTURE_PORT").parse().unwrap(),
            username: env("P0_SSH_FIXTURE_USER"),
            private_key_path: env("P0_SSH_FIXTURE_KEY"),
        };
        let challenge = service
            .probe("main", &id(), input_again(), &scope)
            .await
            .unwrap();
        let opened = service
            .sftp_open("main", &id(), &challenge.challenge_token, &scope)
            .await
            .unwrap();
        assert!(service.consume("main", &challenge.challenge_token).is_err());
        let grant = opened.grant_token;
        assert_eq!(opened.listing.path, remote);
        assert!(!opened.listing.truncated);
        let kind = |name: &str| {
            opened
                .listing
                .entries
                .iter()
                .find(|entry| entry.name == name)
                .map(|entry| entry.kind)
        };
        assert_eq!(kind("small-中文.txt"), Some(RemoteKind::File));
        assert_eq!(kind("中文-🌏.bin"), Some(RemoteKind::File));
        assert_eq!(kind("nested"), Some(RemoteKind::Directory));
        assert_eq!(kind("link-to-small"), Some(RemoteKind::Symlink));

        let path = |name: &str| format!("{remote}/{name}");
        let small = b"P0 SFTP read-only \xe4\xb8\xad\xe6\x96\x87 \xf0\x9f\x8c\x8f\n".to_vec();
        let followed = service
            .sftp_metadata("main", &id(), &grant, &scope, path("link-to-small"), None)
            .await
            .unwrap();
        assert_eq!(
            (followed.kind, followed.size),
            (RemoteKind::File, small.len() as u64)
        );
        let bytes = service
            .sftp_read("main", &id(), &grant, &scope, path("small-中文.txt"), None)
            .await
            .unwrap();
        assert_eq!(bytes, small);
        for (name, expected) in [
            ("中文-🌏.bin", "SFTP file exceeds the 64 KiB read limit"),
            ("nested", "SFTP read requires a regular file"),
            ("missing", "SFTP metadata request failed"),
        ] {
            let error = service
                .sftp_read("main", &id(), &grant, &scope, path(name), None)
                .await
                .err()
                .unwrap();
            assert_eq!(error, expected);
        }
        let nested = service
            .sftp_list("main", &id(), &grant, &scope, path("nested"), None)
            .await
            .unwrap();
        assert_eq!(nested.entries.len(), 1);
        assert_eq!(nested.entries[0].name, "inner.txt");
        let many = service
            .sftp_list("main", &id(), &grant, &scope, path("many"), None)
            .await
            .unwrap();
        assert!(many.truncated);
        assert_eq!(many.entries.len(), MAX_DIRECTORY_ENTRIES);

        service.sftp_close("main", &grant).unwrap();
        assert_eq!(
            service
                .sftp_list("main", &id(), &grant, &scope, remote.clone(), None)
                .await
                .err()
                .unwrap(),
            SFTP_EXPIRED
        );

        // A grant whose pinned host key no longer matches is revoked before the
        // private key is read. Done last: it is an intentional pre-auth abort.
        let challenge = service
            .probe("main", &id(), input_again(), &scope)
            .await
            .unwrap();
        let grant = service
            .sftp_open("main", &id(), &challenge.challenge_token, &scope)
            .await
            .unwrap()
            .grant_token;
        service
            .registry
            .lock()
            .unwrap()
            .grants
            .get_mut(&grant)
            .unwrap()
            .key[0] ^= 1;
        assert_eq!(
            service
                .sftp_list("main", &id(), &grant, &scope, remote.clone(), None)
                .await
                .err()
                .unwrap(),
            format!("SSH host key changed; authentication was not attempted; {SFTP_REVOKED}")
        );
        let registry = service.registry.lock().unwrap();
        assert!(registry.active.is_empty() && registry.grants.is_empty());
        assert!(registry.challenges.is_empty());
    }

    #[tokio::test]
    #[ignore = "requires the isolated fixture; run tests/fixtures/ssh-sftp/rust-client.test.mjs"]
    async fn real_fixture_reconnect_mismatch() {
        let service = Ssh::default();
        let mut input = request();
        input.host = std::env::var("P0_SSH_FIXTURE_HOST").unwrap();
        input.port = std::env::var("P0_SSH_FIXTURE_PORT")
            .unwrap()
            .parse()
            .unwrap();
        input.username = std::env::var("P0_SSH_FIXTURE_USER").unwrap();
        input.private_key_path = std::env::temp_dir().join(id()).to_string_lossy().into();
        let challenge = service
            .probe("main", &id(), input, &service.context("main").unwrap())
            .await
            .unwrap();
        service
            .registry
            .lock()
            .unwrap()
            .challenges
            .get_mut(&challenge.challenge_token)
            .unwrap()
            .key[0] ^= 1;
        let error = service
            .accept(
                "main",
                &id(),
                &challenge.challenge_token,
                &service.context("main").unwrap(),
            )
            .await
            .err()
            .unwrap();
        assert_eq!(
            error,
            "SSH host key changed; authentication was not attempted"
        );
        assert!(service.registry.lock().unwrap().challenges.is_empty());
        assert!(service.registry.lock().unwrap().active.is_empty());
    }
}
