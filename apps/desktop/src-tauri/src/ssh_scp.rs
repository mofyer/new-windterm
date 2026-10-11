// P0 probe without a UI consumer yet.
#![allow(dead_code)]
//! Legacy SCP (rcp protocol over `scp -t` / `scp -f`) for one regular file
//! (P0 probe for F08/F09). SCP is a separate protocol from SFTP and is
//! verified separately. Sizes and names are bounded; directories, `-p`
//! times and recursion are not implemented yet.
use super::KeyCheck;
use russh::{client, ChannelMsg};

pub(crate) struct ScpFile {
    pub(crate) name: String,
    pub(crate) mode: u32,
    pub(crate) data: Vec<u8>,
}

/// sh single-quoting, so the remote shell passes the path as one argument.
pub(crate) fn quote(path: &str) -> String {
    format!("'{}'", path.replace('\'', "'\\''"))
}

fn valid_name(name: &str) -> bool {
    !name.is_empty() && name != "." && name != ".." && !name.contains(['/', '\0', '\n'])
}

/// Buffered reads from a channel, bounded by the caller's limits.
struct Reader {
    channel: russh::Channel<client::Msg>,
    buffer: Vec<u8>,
    exit: Option<u32>,
}

impl Reader {
    async fn fill(&mut self) -> Result<(), String> {
        loop {
            match self.channel.wait().await {
                Some(ChannelMsg::Data { data }) => {
                    self.buffer.extend_from_slice(&data);
                    return Ok(());
                }
                Some(ChannelMsg::ExitStatus { exit_status }) => self.exit = Some(exit_status),
                Some(ChannelMsg::Eof | ChannelMsg::Close) | None => {
                    return Err(match self.exit {
                        Some(code) => format!("SCP ended early (exit {code})"),
                        None => "SCP ended early".into(),
                    })
                }
                Some(_) => {}
            }
        }
    }

    async fn exact(&mut self, length: usize) -> Result<Vec<u8>, String> {
        while self.buffer.len() < length {
            self.fill().await?;
        }
        Ok(self.buffer.drain(..length).collect())
    }

    async fn line(&mut self, limit: usize) -> Result<String, String> {
        loop {
            if let Some(end) = self.buffer.iter().position(|b| *b == b'\n') {
                let line: Vec<u8> = self.buffer.drain(..=end).collect();
                return String::from_utf8(line[..end].to_vec())
                    .map_err(|_| "SCP line is not UTF-8".into());
            }
            if self.buffer.len() > limit {
                return Err("SCP control line too long".into());
            }
            self.fill().await?;
        }
    }

    /// Reads one response byte: 0 is OK; 1 and 2 carry the server's message.
    async fn ack(&mut self) -> Result<(), String> {
        match self.exact(1).await?[0] {
            0 => Ok(()),
            1 | 2 => Err(format!("SCP: {}", self.line(1024).await?.trim())),
            other => Err(format!("SCP protocol error (byte {other})")),
        }
    }
}

async fn start(session: &client::Handle<KeyCheck>, command: String) -> Result<Reader, String> {
    let channel = session
        .channel_open_session()
        .await
        .map_err(|_| "SSH channel open failed")?;
    channel
        .exec(true, command)
        .await
        .map_err(|_| "SCP command request failed")?;
    Ok(Reader {
        channel,
        buffer: Vec::new(),
        exit: None,
    })
}

/// Uploads one file as `directory/name` with `scp -t`.
pub(crate) async fn upload(
    session: &client::Handle<KeyCheck>,
    directory: &str,
    name: &str,
    mode: u32,
    data: &[u8],
) -> Result<(), String> {
    if !valid_name(name) {
        return Err("SCP file name must not contain '/', NUL or newlines".into());
    }
    let mut reader = start(session, format!("scp -t -- {}", quote(directory))).await?;
    reader.ack().await?;
    let header = format!("C{:04o} {} {}\n", mode & 0o7777, data.len(), name);
    reader
        .channel
        .data(header.as_bytes())
        .await
        .map_err(|_| "SCP send failed")?;
    reader.ack().await?;
    reader
        .channel
        .data(data)
        .await
        .map_err(|_| "SCP send failed")?;
    reader
        .channel
        .data(&[0u8][..])
        .await
        .map_err(|_| "SCP send failed")?;
    reader.ack().await?;
    reader.channel.eof().await.map_err(|_| "SCP send failed")?;
    finish(reader).await
}

/// Downloads one regular file with `scp -f`, refusing more than `limit` bytes.
pub(crate) async fn download(
    session: &client::Handle<KeyCheck>,
    path: &str,
    limit: u64,
) -> Result<ScpFile, String> {
    let mut reader = start(session, format!("scp -f -- {}", quote(path))).await?;
    reader
        .channel
        .data(&[0u8][..])
        .await
        .map_err(|_| "SCP send failed")?;
    let kind = reader.exact(1).await?[0];
    if kind == 1 || kind == 2 {
        return Err(format!("SCP: {}", reader.line(1024).await?.trim()));
    }
    if kind != b'C' {
        return Err("SCP: only a single regular file is supported".into());
    }
    let header = reader.line(4096).await?;
    let mut fields = header.splitn(3, ' ');
    let mode = fields
        .next()
        .and_then(|m| u32::from_str_radix(m, 8).ok())
        .ok_or("SCP header has no mode")?;
    let size: u64 = fields
        .next()
        .and_then(|s| s.parse().ok())
        .ok_or("SCP header has no size")?;
    let name = fields.next().ok_or("SCP header has no name")?.to_string();
    if !valid_name(&name) {
        return Err("SCP server sent an invalid file name".into());
    }
    if size > limit {
        let _ = reader.channel.data(&b"\x02size limit\n"[..]).await;
        return Err(format!("SCP file exceeds the {limit} byte limit"));
    }
    reader
        .channel
        .data(&[0u8][..])
        .await
        .map_err(|_| "SCP send failed")?;
    let size = usize::try_from(size).map_err(|_| "SCP file is too large")?;
    let data = reader.exact(size).await?;
    reader.ack().await?;
    reader
        .channel
        .data(&[0u8][..])
        .await
        .map_err(|_| "SCP send failed")?;
    reader.channel.eof().await.map_err(|_| "SCP send failed")?;
    finish(reader).await?;
    Ok(ScpFile { name, mode, data })
}

async fn finish(mut reader: Reader) -> Result<(), String> {
    while reader.exit.is_none() {
        match reader.channel.wait().await {
            Some(ChannelMsg::ExitStatus { exit_status }) => reader.exit = Some(exit_status),
            Some(ChannelMsg::Close) | None => break,
            Some(_) => {}
        }
    }
    match reader.exit {
        Some(0) => Ok(()),
        Some(code) => Err(format!("SCP exited with status {code}")),
        None => Err("SCP closed without an exit status".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ssh::{connect_pinned, observe_host_key, Credential, Request};
    use russh::keys::HashAlg;

    #[test]
    fn quoting_and_names_are_strict() {
        assert_eq!(quote("/tmp/a b"), "'/tmp/a b'");
        assert_eq!(quote("it's"), "'it'\\''s'");
        assert!(valid_name("中文 file.bin"));
        for bad in ["", ".", "..", "a/b", "a\nb", "a\0b"] {
            assert!(!valid_name(bad), "{bad:?}");
        }
    }

    /// Real OpenSSH `scp -t/-f` on the isolated fixture; run by
    /// tests/fixtures/ssh-sftp/rust-client.test.mjs.
    #[tokio::test]
    #[ignore = "requires the isolated fixture; run tests/fixtures/ssh-sftp/rust-client.test.mjs"]
    async fn real_fixture_scp_round_trip() {
        let env = |name: &str| std::env::var(name).unwrap();
        let request = Request {
            host: env("P0_SSH_FIXTURE_HOST"),
            port: env("P0_SSH_FIXTURE_PORT").parse().unwrap(),
            username: env("P0_SSH_FIXTURE_USER"),
            private_key_path: env("P0_SSH_FIXTURE_KEY"),
        };
        let remote = env("P0_SSH_FIXTURE_REMOTE");
        let connect = || tokio::net::TcpStream::connect((request.host.clone(), request.port));
        let key = observe_host_key(connect().await.unwrap()).await.unwrap();
        assert_eq!(
            key.fingerprint(HashAlg::Sha256).to_string(),
            env("P0_SSH_FIXTURE_FINGERPRINT")
        );
        let (_, cancel) = tokio::sync::watch::channel(false);
        let ssh = connect_pinned(
            connect().await.unwrap(),
            &request,
            key.to_bytes().unwrap(),
            &Credential::default(),
            cancel,
        )
        .await
        .unwrap();

        let payload: Vec<u8> = (0..1_048_583u32)
            .map(|i| (i.wrapping_mul(2_654_435_761) >> 13) as u8)
            .collect();
        let name = "scp 中文 'quoted'.bin";
        upload(&ssh, &remote, name, 0o640, &payload).await.unwrap();
        let on_disk = std::fs::read(std::path::Path::new(&remote).join(name)).unwrap();
        assert!(on_disk == payload, "uploaded bytes differ on disk");

        let file = download(&ssh, &format!("{remote}/{name}"), 4 * 1024 * 1024)
            .await
            .unwrap();
        assert_eq!(file.name, name);
        // The server applies its umask; the mode never exceeds what was sent.
        assert_eq!(file.mode & 0o777 & !0o640, 0, "mode {:o}", file.mode);
        assert!(file.data == payload, "downloaded bytes differ");

        let missing = download(&ssh, &format!("{remote}/missing"), 1024)
            .await
            .err()
            .unwrap();
        assert!(missing.starts_with("SCP: "), "{missing}");
        let large = download(&ssh, &format!("{remote}/{name}"), 1024)
            .await
            .err()
            .unwrap();
        assert!(large.contains("limit"), "{large}");
        assert!(upload(&ssh, &remote, "bad/name", 0o600, b"x")
            .await
            .is_err());
        // Outside the fixture's directory the server side denies the command.
        assert!(download(&ssh, "/etc/hosts", 1024).await.is_err());
    }
}
