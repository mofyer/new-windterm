//! Persistent SSH host trust in OpenSSH `known_hosts` line format.
//!
//! Only this application writes the file. Lines are `host` (port 22) or
//! `[host]:port`, a key type and the base64 public key. Hashed hosts and
//! `@marker` lines are not produced; if present they are skipped, never
//! treated as trust. Any unreadable or oversized store fails closed.
use russh::keys::PublicKey;
use std::{
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::Mutex,
};

const MAX_FILE_BYTES: u64 = 1024 * 1024;
const MAX_ENTRIES: usize = 4096;

/// Result of comparing a presented host key with the saved trust.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Saved {
    /// No saved key for this host and port.
    Unknown,
    /// A saved key matches the presented key.
    Match,
    /// Keys are saved for this host and port, but none matches. Carries the
    /// SHA-256 fingerprint of the first saved key for display.
    Changed(String),
}

pub struct KnownHosts {
    path: PathBuf,
    // Serialises read-modify-write within this process.
    lock: Mutex<()>,
}

fn pattern(host: &str, port: u16) -> String {
    let host = host.to_ascii_lowercase();
    if port == 22 {
        host
    } else {
        format!("[{host}]:{port}")
    }
}

struct Line {
    patterns: Vec<String>,
    key: PublicKey,
}

fn parse(text: &str) -> Vec<(Option<Line>, String)> {
    text.lines()
        .map(|raw| {
            let trimmed = raw.trim();
            if trimmed.is_empty() || trimmed.starts_with('#') || trimmed.starts_with('@') {
                return (None, raw.to_string());
            }
            let mut fields = trimmed.splitn(2, char::is_whitespace);
            let hosts = fields.next().unwrap_or_default();
            let key = fields
                .next()
                .and_then(|rest| PublicKey::from_openssh(rest.trim()).ok());
            let line = key.filter(|_| !hosts.starts_with('|')).map(|key| Line {
                patterns: hosts.split(',').map(str::to_ascii_lowercase).collect(),
                key,
            });
            (line, raw.to_string())
        })
        .collect()
}

impl KnownHosts {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            lock: Mutex::new(()),
        }
    }

    /// Opens once and checks the opened handle, so the checked file is the
    /// file that is read even if the path is replaced concurrently.
    fn read(&self) -> Result<String, String> {
        let file = match std::fs::File::open(&self.path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(String::new()),
            Err(_) => return Err("Saved host keys are unreadable".into()),
            Ok(file) => file,
        };
        let metadata = file
            .metadata()
            .map_err(|_| "Saved host keys are unreadable")?;
        if !metadata.is_file() || metadata.len() > MAX_FILE_BYTES {
            return Err("Saved host keys are not a regular file of at most 1 MiB".into());
        }
        let mut bytes = Vec::new();
        file.take(MAX_FILE_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| "Saved host keys are unreadable")?;
        if bytes.len() as u64 > MAX_FILE_BYTES {
            return Err("Saved host keys exceed 1 MiB".into());
        }
        String::from_utf8(bytes).map_err(|_| "Saved host keys are not UTF-8".into())
    }

    /// Compares `presented` with the saved keys of the same algorithm.
    pub fn check(&self, host: &str, port: u16, presented: &PublicKey) -> Result<Saved, String> {
        let _guard = self.lock.lock().map_err(|_| "Host key store unavailable")?;
        let wanted = pattern(host, port);
        let mut changed = None;
        for (line, _) in parse(&self.read()?) {
            let Some(line) = line else { continue };
            if !line.patterns.iter().any(|candidate| candidate == &wanted)
                || line.key.algorithm() != presented.algorithm()
            {
                continue;
            }
            if line.key.key_data() == presented.key_data() {
                return Ok(Saved::Match);
            }
            changed.get_or_insert_with(|| {
                line.key
                    .fingerprint(russh::keys::HashAlg::Sha256)
                    .to_string()
            });
        }
        Ok(changed.map_or(Saved::Unknown, Saved::Changed))
    }

    /// Saves `key` for the host and port, removing that exact pattern from
    /// saved keys of the same algorithm (a hand-edited `a,b` line keeps `b`).
    /// Other lines are preserved verbatim.
    pub fn remember(&self, host: &str, port: u16, key: &PublicKey) -> Result<(), String> {
        let _guard = self.lock.lock().map_err(|_| "Host key store unavailable")?;
        let wanted = pattern(host, port);
        let mut kept = Vec::new();
        let mut entries = 0;
        for (line, raw) in parse(&self.read()?) {
            if let Some(line) = &line {
                if line.patterns.contains(&wanted) && line.key.algorithm() == key.algorithm() {
                    let others: Vec<_> = line
                        .patterns
                        .iter()
                        .filter(|candidate| **candidate != wanted)
                        .cloned()
                        .collect();
                    if !others.is_empty() {
                        kept.push(format!("{} {}", others.join(","), encode(&line.key)?));
                        entries += 1;
                    }
                    continue;
                }
                entries += 1;
            }
            kept.push(raw);
        }
        if entries >= MAX_ENTRIES {
            return Err("Saved host key capacity reached".into());
        }
        kept.push(format!("{wanted} {}", encode(key)?));
        let mut text = kept.join("\n");
        text.push('\n');
        write_atomically(&self.path, text.as_bytes())
    }
}

/// `type base64` without a comment: comments are server- or user-chosen text
/// and carry no trust.
fn encode(key: &PublicKey) -> Result<String, String> {
    let encoded = key.to_openssh().map_err(|_| "Host key cannot be encoded")?;
    Ok(encoded
        .split_whitespace()
        .take(2)
        .collect::<Vec<_>>()
        .join(" "))
}

/// Same-directory temporary file and rename: readers see the old or the new
/// file, never a partial one. Within one process a mutex serialises writers;
/// the app runs as a single instance, so there is no cross-process lock. On
/// Windows the file inherits the per-user application-data ACL.
fn write_atomically(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let directory = path.parent().ok_or("Host key store has no directory")?;
    std::fs::create_dir_all(directory).map_err(|_| "Host key store directory unavailable")?;
    let temporary = directory.join(format!(".known_hosts-{}.tmp", uuid::Uuid::new_v4()));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let result = (|| {
        let mut file = options.open(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        std::fs::rename(&temporary, path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result.map_err(|_| "Host key could not be saved".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use russh::keys::{Algorithm, PrivateKey};

    fn key() -> PublicKey {
        PrivateKey::random(&mut russh::keys::key::safe_rng(), Algorithm::Ed25519)
            .unwrap()
            .public_key()
            .clone()
    }

    fn store() -> (KnownHosts, PathBuf) {
        let directory =
            std::env::temp_dir().join(format!("p0-known-hosts-{}", uuid::Uuid::new_v4()));
        (KnownHosts::new(directory.join("known_hosts")), directory)
    }

    #[test]
    fn unknown_then_saved_then_changed_is_reported_per_host_and_port() {
        let (store, directory) = store();
        let (first, second) = (key(), key());
        assert_eq!(
            store.check("Example.COM", 2222, &first).unwrap(),
            Saved::Unknown
        );
        store.remember("Example.COM", 2222, &first).unwrap();
        assert_eq!(
            store.check("example.com", 2222, &first).unwrap(),
            Saved::Match
        );
        assert_eq!(
            store.check("example.com", 22, &first).unwrap(),
            Saved::Unknown
        );
        let saved = first.fingerprint(russh::keys::HashAlg::Sha256).to_string();
        assert_eq!(
            store.check("example.com", 2222, &second).unwrap(),
            Saved::Changed(saved)
        );
        store.remember("example.com", 2222, &second).unwrap();
        assert_eq!(
            store.check("example.com", 2222, &second).unwrap(),
            Saved::Match
        );
        assert!(matches!(
            store.check("example.com", 2222, &first).unwrap(),
            Saved::Changed(_)
        ));
        let text = std::fs::read_to_string(directory.join("known_hosts")).unwrap();
        assert_eq!(text.lines().count(), 1);
        assert!(text.starts_with("[example.com]:2222 ssh-ed25519 "));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(directory.join("known_hosts"))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn foreign_lines_are_preserved_but_never_trusted() {
        let (store, directory) = store();
        std::fs::create_dir_all(&directory).unwrap();
        let presented = key();
        let encoded = presented.to_openssh().unwrap();
        let foreign = format!(
            "# comment\n|1|c2FsdA==|aGFzaA== {encoded}\n@revoked host {encoded}\nother.example {encoded}\n"
        );
        std::fs::write(directory.join("known_hosts"), &foreign).unwrap();
        assert_eq!(store.check("host", 22, &presented).unwrap(), Saved::Unknown);
        store.remember("host", 22, &presented).unwrap();
        let text = std::fs::read_to_string(directory.join("known_hosts")).unwrap();
        assert!(text.starts_with(&foreign));
        assert_eq!(
            store.check("other.example", 22, &presented).unwrap(),
            Saved::Match
        );
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn replacing_a_host_on_a_shared_line_keeps_the_other_hosts() {
        let (store, directory) = store();
        std::fs::create_dir_all(&directory).unwrap();
        let (old, new) = (key(), key());
        std::fs::write(
            directory.join("known_hosts"),
            format!(
                "alpha,[beta]:2222 {} legacy-comment\n",
                encode(&old).unwrap()
            ),
        )
        .unwrap();
        assert!(matches!(
            store.check("beta", 2222, &new).unwrap(),
            Saved::Changed(_)
        ));
        store.remember("beta", 2222, &new).unwrap();
        assert_eq!(store.check("beta", 2222, &new).unwrap(), Saved::Match);
        assert_eq!(store.check("alpha", 22, &old).unwrap(), Saved::Match);
        assert!(matches!(
            store.check("beta", 2222, &old).unwrap(),
            Saved::Changed(_)
        ));
        let text = std::fs::read_to_string(directory.join("known_hosts")).unwrap();
        assert_eq!(text.lines().count(), 2);
        assert!(!text.contains("legacy-comment"));
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn oversized_or_non_file_stores_fail_closed() {
        let (store, directory) = store();
        std::fs::create_dir_all(directory.join("known_hosts")).unwrap();
        assert!(store.check("host", 22, &key()).is_err());
        assert!(store.remember("host", 22, &key()).is_err());
        std::fs::remove_dir_all(directory.join("known_hosts")).unwrap();
        std::fs::write(
            directory.join("known_hosts"),
            vec![b'#'; MAX_FILE_BYTES as usize + 1],
        )
        .unwrap();
        assert!(store.check("host", 22, &key()).is_err());
        std::fs::remove_dir_all(directory).unwrap();
    }
}
