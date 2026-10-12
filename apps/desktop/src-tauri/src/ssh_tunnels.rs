//! Port forwards owned by one interactive SSH terminal (C16 local, C17
//! remote, C18 dynamic). They share the terminal's authenticated connection
//! and its routes, and are torn down when the terminal ends for any reason.
use crate::ssh::{forward, KeyCheck, Routes, Ssh, DEADLINE};
use russh::client;
use serde::{Deserialize, Serialize};
use std::{
    net::{IpAddr, SocketAddr},
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::watch;

/// Forwards per terminal session.
pub const MAX_FORWARDS: usize = 16;
/// Upper bound for asking the server to cancel remote forwards on teardown.
const TEARDOWN: Duration = Duration::from_secs(3);
const CLOSED: &str = "SSH terminal is closed";
const LOOPBACK_ONLY: &str =
    "Local and dynamic forwards listen only on a loopback IP address (127.0.0.1 or ::1)";
const BAD_TARGET: &str =
    "Forward target needs a host name or IP address and a port from 1 to 65535";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ForwardKind {
    /// `ssh -L`: a local listener relayed to a fixed target via the server.
    Local,
    /// `ssh -D`: a local SOCKS5 listener; each client names its target.
    Dynamic,
    /// `ssh -R`: the server listens and connections come back to a local target.
    Remote,
}

/// What the WebView asks for. The target is required for local and remote
/// forwards and must be absent for dynamic ones.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ForwardRequest {
    pub kind: ForwardKind,
    pub bind_host: String,
    /// 0 lets the system (local, dynamic) or the server (remote) choose.
    pub bind_port: u16,
    #[serde(default)]
    pub target_host: Option<String>,
    #[serde(default)]
    pub target_port: Option<u16>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ForwardStatus {
    /// Listening locally, or registered with the server.
    Active,
    /// The local listener ended on its own; remove the forward.
    Stopped,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForwardInfo {
    pub id: String,
    pub kind: ForwardKind,
    /// The address and port actually bound (local) or granted (remote).
    pub bind_host: String,
    pub bind_port: u16,
    pub target_host: Option<String>,
    pub target_port: Option<u16>,
    pub status: ForwardStatus,
    /// Open relayed connections; `None` where not counted per forward (remote).
    pub connections: Option<u32>,
}

/// A request that passed validation.
pub(crate) enum Spec {
    Listen {
        kind: ForwardKind,
        bind: SocketAddr,
        target: forward::Target,
    },
    Remote {
        bind_host: String,
        bind_port: u16,
        host: String,
        port: u16,
    },
}

/// A host name (dot-separated labels of letters, digits, `-` and `_`, not
/// starting with `-`) or an IP literal; IPv6 without brackets.
fn valid_host(host: &str) -> bool {
    if host.contains(':') {
        return host.parse::<std::net::Ipv6Addr>().is_ok();
    }
    host.len() <= 253
        && host.split('.').all(|label| {
            (1..=63).contains(&label.len())
                && !label.starts_with('-')
                && label
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        })
}

impl ForwardRequest {
    pub(crate) fn validate(self) -> Result<Spec, String> {
        let target = match (self.kind, self.target_host, self.target_port) {
            (ForwardKind::Dynamic, None, None) => None,
            (ForwardKind::Dynamic, _, _) => {
                return Err("A dynamic (SOCKS5) forward takes no target".into())
            }
            (_, Some(host), Some(port)) if valid_host(&host) && port != 0 => Some((host, port)),
            _ => return Err(BAD_TARGET.into()),
        };
        match (self.kind, target) {
            (ForwardKind::Remote, Some((host, port))) => {
                if !valid_host(&self.bind_host) {
                    return Err("Invalid remote bind address".into());
                }
                Ok(Spec::Remote {
                    bind_host: self.bind_host,
                    bind_port: self.bind_port,
                    host,
                    port,
                })
            }
            (kind, target) => {
                let ip: IpAddr = self.bind_host.parse().map_err(|_| LOOPBACK_ONLY)?;
                if !ip.is_loopback() {
                    return Err(LOOPBACK_ONLY.into());
                }
                let target = match target {
                    Some((host, port)) => forward::Target::Fixed { host, port },
                    None => forward::Target::Socks5,
                };
                Ok(Spec::Listen {
                    kind,
                    bind: SocketAddr::new(ip, self.bind_port),
                    target,
                })
            }
        }
    }
}

enum Running {
    Listener(forward::Forward),
    Remote { bind_host: String, port: u32 },
}

struct Entry {
    /// Fixed description; status and connections are read when listed.
    info: ForwardInfo,
    running: Running,
}

impl Entry {
    fn info(&self) -> ForwardInfo {
        let (status, connections) = match &self.running {
            Running::Listener(listener) => (
                if listener.listening() {
                    ForwardStatus::Active
                } else {
                    ForwardStatus::Stopped
                },
                Some(u32::try_from(listener.connections()).unwrap_or(u32::MAX)),
            ),
            Running::Remote { .. } => (ForwardStatus::Active, None),
        };
        ForwardInfo {
            status,
            connections,
            ..self.info.clone()
        }
    }

    fn is_remote(&self, host: &str, port: u32) -> bool {
        matches!(&self.running, Running::Remote { bind_host, port: bound } if bind_host == host && *bound == port)
    }
}

#[derive(Default)]
struct State {
    closed: bool,
    entries: Vec<Entry>,
    /// Remote listeners left by `close` for `cancel_remote_left`.
    remote_left: Vec<(String, u32)>,
}

/// The forwards of one terminal. Additions are serialized so the capacity
/// and duplicate checks see every earlier forward; removal and teardown do
/// their network work outside the state lock.
pub(crate) struct Tunnels {
    session: Arc<client::Handle<KeyCheck>>,
    routes: Arc<Routes>,
    adding: tokio::sync::Mutex<()>,
    state: Mutex<State>,
    closed: watch::Sender<bool>,
}

async fn until_closed(mut closed: watch::Receiver<bool>) {
    // A dropped sender also counts as closed.
    let _ = closed.wait_for(|closed| *closed).await;
}

impl Tunnels {
    pub(crate) fn new(session: Arc<client::Handle<KeyCheck>>, routes: Arc<Routes>) -> Self {
        Self {
            session,
            routes,
            adding: tokio::sync::Mutex::new(()),
            state: Mutex::default(),
            closed: watch::channel(false).0,
        }
    }

    fn state(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub(crate) fn list(&self) -> Result<Vec<ForwardInfo>, String> {
        let state = self.state();
        if state.closed {
            return Err(CLOSED.into());
        }
        Ok(state.entries.iter().map(Entry::info).collect())
    }

    pub(crate) async fn add(&self, spec: Spec) -> Result<ForwardInfo, String> {
        let _turn = tokio::select! {
            biased;
            _ = until_closed(self.closed.subscribe()) => return Err(CLOSED.into()),
            turn = self.adding.lock() => turn,
        };
        {
            let state = self.state();
            if state.closed {
                return Err(CLOSED.into());
            }
            if state.entries.len() >= MAX_FORWARDS {
                return Err(format!(
                    "At most {MAX_FORWARDS} port forwards per SSH terminal"
                ));
            }
            // A second request for the same fixed remote port would replace
            // the first forward's route before the server refuses it.
            if let Spec::Remote {
                bind_host,
                bind_port,
                ..
            } = &spec
            {
                let port = u32::from(*bind_port);
                if port != 0 && state.entries.iter().any(|e| e.is_remote(bind_host, port)) {
                    return Err("That remote address and port is already forwarded".into());
                }
            }
        }
        let entry = match spec {
            Spec::Listen { kind, bind, target } => self.listen(kind, bind, target).await?,
            Spec::Remote {
                bind_host,
                bind_port,
                host,
                port,
            } => self.remote(bind_host, bind_port, host, port).await?,
        };
        let info = entry.info();
        let refused = {
            let mut state = self.state();
            if state.closed {
                Some(entry)
            } else {
                state.entries.push(entry);
                None
            }
        };
        match refused {
            Some(entry) => {
                let _ = self.release(entry.running).await;
                Err(CLOSED.into())
            }
            None => Ok(info),
        }
    }

    async fn listen(
        &self,
        kind: ForwardKind,
        bind: SocketAddr,
        target: forward::Target,
    ) -> Result<Entry, String> {
        let (target_host, target_port) = match &target {
            forward::Target::Fixed { host, port } => (Some(host.clone()), Some(*port)),
            forward::Target::Socks5 => (None, None),
        };
        let listener = forward::listen(self.session.clone(), bind, target).await?;
        Ok(Entry {
            info: ForwardInfo {
                id: uuid::Uuid::new_v4().to_string(),
                kind,
                bind_host: listener.local.ip().to_string(),
                bind_port: listener.local.port(),
                target_host,
                target_port,
                status: ForwardStatus::Active,
                connections: None,
            },
            running: Running::Listener(listener),
        })
    }

    async fn remote(
        &self,
        bind_host: String,
        bind_port: u16,
        host: String,
        port: u16,
    ) -> Result<Entry, String> {
        let request = forward::remote(
            &self.session,
            &self.routes,
            &bind_host,
            bind_port.into(),
            &host,
            port,
        );
        let outcome = tokio::select! {
            biased;
            _ = until_closed(self.closed.subscribe()) => None,
            result = tokio::time::timeout(DEADLINE, request) => Some(result),
        };
        let bound = match outcome {
            Some(Ok(result)) => result?,
            abandoned => {
                // The server may still grant it; a fixed port is known and is
                // withdrawn. A server-chosen port stays unrouted (refused).
                if bind_port != 0 {
                    self.withdraw(&bind_host, bind_port.into()).await;
                }
                return Err(match abandoned {
                    None => CLOSED.into(),
                    Some(_) => "SSH server did not answer the remote forward request".into(),
                });
            }
        };
        let Some(granted) = u16::try_from(bound).ok().filter(|port| *port != 0) else {
            self.withdraw(&bind_host, bound).await;
            return Err("SSH server granted an invalid remote port".into());
        };
        Ok(Entry {
            info: ForwardInfo {
                id: uuid::Uuid::new_v4().to_string(),
                kind: ForwardKind::Remote,
                bind_host: bind_host.clone(),
                bind_port: granted,
                target_host: Some(host),
                target_port: Some(port),
                status: ForwardStatus::Active,
                connections: None,
            },
            running: Running::Remote {
                bind_host,
                port: bound,
            },
        })
    }

    /// Removes the route first (new connections are refused at once), then
    /// asks the server to stop listening, within [`TEARDOWN`].
    async fn withdraw(&self, bind_host: &str, port: u32) {
        let cancel = forward::cancel_remote(&self.session, &self.routes, bind_host, port);
        let _ = tokio::time::timeout(TEARDOWN, cancel).await;
    }

    async fn release(&self, running: Running) -> Result<(), String> {
        match running {
            Running::Listener(listener) => {
                listener.stop().await;
                Ok(())
            }
            Running::Remote { bind_host, port } => {
                let cancel = forward::cancel_remote(&self.session, &self.routes, &bind_host, port);
                match tokio::time::timeout(TEARDOWN, cancel).await {
                    Ok(Ok(())) => Ok(()),
                    // The route is already gone, so nothing is relayed any more.
                    _ => Err(
                        "Remote forward removed here; the SSH server did not confirm it stopped listening"
                            .into(),
                    ),
                }
            }
        }
    }

    pub(crate) async fn remove(&self, id: &str) -> Result<(), String> {
        let entry = {
            let mut state = self.state();
            if state.closed {
                return Err(CLOSED.into());
            }
            let index = state
                .entries
                .iter()
                .position(|entry| entry.info.id == id)
                .ok_or("Port forward not found")?;
            state.entries.remove(index)
        };
        self.release(entry.running).await
    }

    /// Ends every forward on this side: local listeners and their
    /// connections close, relays of remote forwards end and no new remote
    /// connection is routed. Idempotent; later additions fail. Only local
    /// work, so the terminal's end is not held up by the network; the server
    /// is asked to stop listening by [`Tunnels::cancel_remote_left`].
    pub(crate) async fn close(&self) {
        self.closed.send_replace(true);
        let entries = {
            let mut state = self.state();
            state.closed = true;
            std::mem::take(&mut state.entries)
        };
        self.routes.end_relays();
        let mut remote = Vec::new();
        for entry in entries {
            match entry.running {
                Running::Listener(listener) => listener.stop().await,
                Running::Remote { bind_host, port } => remote.push((bind_host, port)),
            }
        }
        self.state().remote_left.extend(remote);
    }

    /// Asks the server, within [`TEARDOWN`], to stop the remote listeners
    /// that [`Tunnels::close`] left. Needs the connection to still be open;
    /// if it is not, the server drops them with the connection.
    pub(crate) async fn cancel_remote_left(&self) {
        let remote = std::mem::take(&mut self.state().remote_left);
        let cancel = async {
            for (bind_host, port) in &remote {
                let _ = self.session.cancel_tcpip_forward(bind_host, *port).await;
            }
        };
        let _ = tokio::time::timeout(TEARDOWN, cancel).await;
    }
}

impl Ssh {
    /// Starts a port forward over open terminal `id` of `owner`; returns the
    /// address and port actually bound.
    pub async fn forward_add(
        &self,
        owner: &str,
        id: &str,
        request: ForwardRequest,
    ) -> Result<ForwardInfo, String> {
        let terminal = self.terminal(owner, id)?;
        let spec = request.validate()?;
        terminal.tunnels.add(spec).await
    }

    pub async fn forward_remove(
        &self,
        owner: &str,
        id: &str,
        forward_id: &str,
    ) -> Result<(), String> {
        let terminal = self.terminal(owner, id)?;
        uuid::Uuid::parse_str(forward_id).map_err(|_| "Invalid port forward ID")?;
        terminal.tunnels.remove(forward_id).await
    }

    pub fn forward_list(&self, owner: &str, id: &str) -> Result<Vec<ForwardInfo>, String> {
        self.terminal(owner, id)?.tunnels.list()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(kind: ForwardKind, bind: &str, target: Option<(&str, u16)>) -> ForwardRequest {
        ForwardRequest {
            kind,
            bind_host: bind.into(),
            bind_port: 0,
            target_host: target.map(|(host, _)| host.into()),
            target_port: target.map(|(_, port)| port),
        }
    }

    #[test]
    fn local_and_dynamic_binds_are_loopback_ip_literals() {
        for bind in ["127.0.0.1", "127.8.9.10", "::1"] {
            assert!(request(ForwardKind::Dynamic, bind, None).validate().is_ok());
            let local = request(ForwardKind::Local, bind, Some(("db.internal", 5432)));
            assert!(local.validate().is_ok(), "{bind}");
        }
        for bind in [
            "0.0.0.0",
            "::",
            "192.168.1.2",
            "localhost",
            "",
            "[::1]",
            "::ffff:127.0.0.1",
        ] {
            let error = request(ForwardKind::Dynamic, bind, None)
                .validate()
                .err()
                .unwrap();
            assert_eq!(error, LOOPBACK_ONLY, "{bind}");
            assert!(request(ForwardKind::Local, bind, Some(("h", 1)))
                .validate()
                .is_err());
        }
    }

    #[test]
    fn targets_are_required_exactly_where_used() {
        let missing = request(ForwardKind::Local, "127.0.0.1", None);
        assert_eq!(missing.validate().err().unwrap(), BAD_TARGET);
        let remote = request(ForwardKind::Remote, "127.0.0.1", None);
        assert_eq!(remote.validate().err().unwrap(), BAD_TARGET);
        let socks = request(ForwardKind::Dynamic, "127.0.0.1", Some(("h", 80)));
        assert!(socks.validate().err().unwrap().contains("no target"));
        let mut half = request(ForwardKind::Local, "127.0.0.1", Some(("h", 80)));
        half.target_port = None;
        assert_eq!(half.validate().err().unwrap(), BAD_TARGET);
        for (host, port) in [("h", 0), ("", 80), ("a b", 80), ("<img>", 80), ("a/b", 80)] {
            let bad = request(ForwardKind::Local, "127.0.0.1", Some((host, port)));
            assert_eq!(bad.validate().err().unwrap(), BAD_TARGET, "{host}:{port}");
        }
        for host in [
            "-",
            "-x",
            ":::",
            "a..b",
            "a.",
            ".a",
            "fe80::1%en0",
            "[::1]",
            "x\0",
        ] {
            let bad = request(ForwardKind::Local, "127.0.0.1", Some((host, 80)));
            assert_eq!(bad.validate().err().unwrap(), BAD_TARGET, "{host:?}");
        }
        for host in [
            "db_1.internal",
            "_srv.example",
            "a-b",
            "10.0.0.1",
            "2001:db8::1",
            "::1",
        ] {
            let good = request(ForwardKind::Local, "127.0.0.1", Some((host, 80)));
            assert!(good.validate().is_ok(), "{host}");
        }
        let long = "a".repeat(254);
        assert!(request(ForwardKind::Remote, "127.0.0.1", Some((&long, 80)))
            .validate()
            .is_err());
    }

    #[test]
    fn remote_binds_are_server_side_names() {
        for bind in ["127.0.0.1", "localhost", "::1", "0.0.0.0"] {
            assert!(
                request(ForwardKind::Remote, bind, Some(("127.0.0.1", 22)))
                    .validate()
                    .is_ok(),
                "{bind}"
            );
        }
        for bind in ["", "a b", "*", "x\0"] {
            let error = request(ForwardKind::Remote, bind, Some(("127.0.0.1", 22)))
                .validate()
                .err()
                .unwrap();
            assert_eq!(error, "Invalid remote bind address", "{bind:?}");
        }
    }

    #[test]
    fn ipc_shape_is_strict() {
        let parse = serde_json::from_str::<ForwardRequest>;
        let ok = parse(
            r#"{"kind":"local","bindHost":"127.0.0.1","bindPort":0,"targetHost":"h","targetPort":80}"#,
        );
        assert!(ok.is_ok());
        let dynamic = parse(r#"{"kind":"dynamic","bindHost":"::1","bindPort":1080}"#).unwrap();
        assert!(dynamic.target_host.is_none() && dynamic.target_port.is_none());
        for bad in [
            r#"{"kind":"socks","bindHost":"127.0.0.1","bindPort":0}"#,
            r#"{"kind":"local","bindHost":"127.0.0.1","bindPort":70000}"#,
            r#"{"kind":"local","bindHost":"127.0.0.1","bindPort":-1}"#,
            r#"{"kind":"local","bindHost":"127.0.0.1","bindPort":0,"gateway":true}"#,
            r#"{"kind":"local","bindPort":0}"#,
        ] {
            assert!(parse(bad).is_err(), "{bad}");
        }
        let info = ForwardInfo {
            id: "id".into(),
            kind: ForwardKind::Dynamic,
            bind_host: "127.0.0.1".into(),
            bind_port: 1080,
            target_host: None,
            target_port: None,
            status: ForwardStatus::Active,
            connections: Some(2),
        };
        assert_eq!(
            serde_json::to_string(&info).unwrap(),
            r#"{"id":"id","kind":"dynamic","bindHost":"127.0.0.1","bindPort":1080,"targetHost":null,"targetPort":null,"status":"active","connections":2}"#
        );
    }
}
