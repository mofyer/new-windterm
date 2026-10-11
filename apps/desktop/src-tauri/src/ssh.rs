//! P0 SSH verification and interactive channels. No agent, password, or persisted trust.
#[path = "ssh_terminal.rs"]
pub mod terminal;
use crate::sftp::{ReadOnlySftp, RemoteEntry};
use russh::{
    client,
    keys::{Algorithm, HashAlg, PrivateKeyWithHashAlg, PublicKeyOrCertificate},
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

const REKEY_ERROR: &str =
    "SSH rekey is not supported in P0; reconnect to verify the host key again";
const DEADLINE: Duration = Duration::from_secs(15);
const TRUST_TTL: Duration = Duration::from_secs(60);
const MAX_BYTES: usize = 64 * 1024;
const MAX_ACTIVE: usize = 4;
const MAX_CHALLENGES: usize = 8;
const MAX_CANCELLED: usize = 128;
static KEY_READS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(MAX_ACTIVE);

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub private_key_path: String,
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
}

struct Active {
    owner: String,
    cancel: watch::Sender<bool>,
}

struct AuthenticatedSftp {
    _socket: SocketGuard,
    session: client::Handle<KeyCheck>,
    sftp: ReadOnlySftp,
    rekey_rejected: Arc<std::sync::atomic::AtomicBool>,
}

enum SftpRequest {
    List(String),
    Metadata(String),
    Read(String),
}

enum SftpResult {
    List(Vec<RemoteEntry>),
    Metadata(RemoteEntry),
    Read(Vec<u8>),
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
}

#[derive(Default)]
pub struct Ssh {
    registry: Mutex<Registry>,
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
    }

    pub fn shutdown(&self) {
        let mut registry = self.registry.lock().unwrap_or_else(|e| e.into_inner());
        registry.shutdown = true;
        for active in registry.active.values() {
            active.cancel.send_replace(true);
        }
        registry.challenges.clear();
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
        let pending = registry
            .challenges
            .remove(token)
            .ok_or("SSH challenge expired or already used")?;
        if pending.expires <= Instant::now() {
            return Err("SSH challenge expired or already used".into());
        }
        Ok(pending)
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
        let (key, fingerprint) = tokio::select! {
            biased;
            _ = operation.cancel.changed() => return Err("SSH operation cancelled".into()),
            result = tokio::time::timeout(DEADLINE, work) => result.map_err(|_| "SSH operation timed out")??,
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
        };
        registry.challenges.insert(
            token,
            Pending {
                owner: operation.owner.clone(),
                request,
                key,
                expires: Instant::now() + TRUST_TTL,
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
        let mut operation = self.start(owner, id, scope)?;
        let pending = self.consume(owner, token)?;
        let work = execute(pending, operation.cancel.clone());
        let output = tokio::select! {
            biased;
            _ = operation.cancel.changed() => return Err("SSH operation cancelled".into()),
            result = tokio::time::timeout(DEADLINE, work) => result.map_err(|_| "SSH operation timed out")??,
        };
        if *operation.cancel.borrow() {
            return Err("SSH operation cancelled".into());
        }
        Ok(output)
    }

    pub async fn sftp_list(
        &self,
        owner: &str,
        id: &str,
        token: &str,
        scope: &str,
        path: String,
    ) -> Result<Vec<RemoteEntry>, String> {
        match self
            .sftp_request(owner, id, token, scope, SftpRequest::List(path))
            .await?
        {
            SftpResult::List(entries) => Ok(entries),
            _ => Err("Unexpected SFTP result".into()),
        }
    }

    pub async fn sftp_metadata(
        &self,
        owner: &str,
        id: &str,
        token: &str,
        scope: &str,
        path: String,
    ) -> Result<RemoteEntry, String> {
        match self
            .sftp_request(owner, id, token, scope, SftpRequest::Metadata(path))
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
        token: &str,
        scope: &str,
        path: String,
    ) -> Result<Vec<u8>, String> {
        match self
            .sftp_request(owner, id, token, scope, SftpRequest::Read(path))
            .await?
        {
            SftpResult::Read(bytes) => Ok(bytes),
            _ => Err("Unexpected SFTP result".into()),
        }
    }

    async fn sftp_request(
        &self,
        owner: &str,
        id: &str,
        token: &str,
        scope: &str,
        request: SftpRequest,
    ) -> Result<SftpResult, String> {
        let operation = self.start(owner, id, scope)?;
        let pending = self.consume(owner, token)?;
        let mut cancel = operation.cancel.clone();
        let work = execute_sftp(pending, cancel.clone(), request);
        tokio::select! {
            biased;
            _ = cancel.changed() => Err("SSH operation cancelled".into()),
            result = tokio::time::timeout(DEADLINE, work) => result.map_err(|_| "SFTP operation timed out".to_string())?,
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
    if request.private_key_path.len() > 4096
        || !std::path::Path::new(&request.private_key_path).is_absolute()
        || request.private_key_path.contains('\0')
    {
        return Err("An absolute private key path is required".into());
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

fn config() -> Arc<client::Config> {
    Arc::new(client::Config {
        inactivity_timeout: Some(DEADLINE),
        ..Default::default()
    })
}

type Observed = Arc<Mutex<Option<(Vec<u8>, String)>>>;
struct KeyCheck {
    expected: Option<Vec<u8>>,
    observed: Observed,
    mismatch: Arc<std::sync::atomic::AtomicBool>,
    kex_seen: bool,
    rekey_rejected: Arc<std::sync::atomic::AtomicBool>,
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
            *self.observed.lock().unwrap_or_else(|e| e.into_inner()) =
                Some((bytes, key.fingerprint(HashAlg::Sha256).to_string()));
            Ok(false)
        }
    }
}

fn private_key(path: &str) -> Result<PrivateKeyWithHashAlg, String> {
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
    let key = russh::keys::decode_secret_key(content, None)
        .map_err(|_| "Invalid or encrypted private key; P0 requires an unencrypted Ed25519 key")?;
    if key.algorithm() != Algorithm::Ed25519 {
        return Err("P0 requires an Ed25519 private key".into());
    }
    Ok(PrivateKeyWithHashAlg::new(Arc::new(key), None))
}

async fn execute(pending: Pending, cancel: watch::Receiver<bool>) -> Result<Output, String> {
    let (_socket, stream) = transport(&pending.request).await?;
    let mismatch = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let rekey_rejected = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let handler = KeyCheck {
        expected: Some(pending.key),
        observed: Arc::default(),
        mismatch: mismatch.clone(),
        kex_seen: false,
        rekey_rejected: rekey_rejected.clone(),
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
    // Read the explicitly selected key only after the new handshake matched.
    let path = pending.request.private_key_path;
    let key = read_key_bounded(cancel, move || private_key(&path)).await?;
    let authenticated = session
        .authenticate_publickey(pending.request.username, key)
        .await
        .map_err(|_| "SSH authentication failed")?;
    if !authenticated.success() {
        return Err("SSH public key authentication rejected".into());
    }
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
    pending: Pending,
    cancel: watch::Receiver<bool>,
    request: SftpRequest,
) -> Result<SftpResult, String> {
    let authenticated = connect_sftp(pending, cancel).await?;
    let AuthenticatedSftp {
        _socket,
        session,
        sftp,
        rekey_rejected,
    } = authenticated;
    let result = match request {
        SftpRequest::List(path) => sftp.list(&path).await.map(SftpResult::List),
        SftpRequest::Metadata(path) => sftp.metadata(&path).await.map(SftpResult::Metadata),
        SftpRequest::Read(path) => sftp.read(&path).await.map(SftpResult::Read),
    };
    let _ = sftp.close().await;
    if rekey_rejected.load(std::sync::atomic::Ordering::SeqCst) {
        return Err(REKEY_ERROR.into());
    }
    let _ = session
        .disconnect(
            russh::Disconnect::ByApplication,
            "P0 SFTP operation finished",
            "en",
        )
        .await;
    let _ = tokio::time::timeout(Duration::from_millis(250), session).await;
    result
}

async fn connect_sftp(
    pending: Pending,
    cancel: watch::Receiver<bool>,
) -> Result<AuthenticatedSftp, String> {
    let (socket, stream) = transport(&pending.request).await?;
    let mismatch = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let rekey_rejected = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let handler = KeyCheck {
        expected: Some(pending.key),
        observed: Arc::default(),
        mismatch: mismatch.clone(),
        kex_seen: false,
        rekey_rejected: rekey_rejected.clone(),
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
    let path = pending.request.private_key_path;
    let key = read_key_bounded(cancel, move || private_key(&path)).await?;
    if !session
        .authenticate_publickey(pending.request.username, key)
        .await
        .map_err(|_| "SSH authentication failed")?
        .success()
    {
        return Err("SSH public key authentication rejected".into());
    }
    let channel = session
        .channel_open_session()
        .await
        .map_err(|_| "SSH channel open failed")?;
    let sftp = ReadOnlySftp::from_channel(channel).await?;
    if rekey_rejected.load(std::sync::atomic::Ordering::SeqCst) {
        return Err(REKEY_ERROR.into());
    }
    Ok(AuthenticatedSftp {
        _socket: socket,
        session,
        sftp,
        rekey_rejected,
    })
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
            private_key(root.to_str().unwrap()).err().unwrap(),
            "Private key must be a regular file"
        );
        let path = root.join("secret-name");
        std::fs::write(&path, vec![b'x'; MAX_BYTES + 1]).unwrap();
        let error = private_key(path.to_str().unwrap()).err().unwrap();
        assert_eq!(
            error,
            "Private key must be a regular file of at most 64 KiB"
        );
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
        };
        assert!(!handler.check_server_key(&public).await.unwrap());
        assert!(mismatch.load(std::sync::atomic::Ordering::Relaxed));
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
