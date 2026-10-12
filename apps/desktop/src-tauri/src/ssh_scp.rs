//! Legacy SCP (rcp protocol over `scp -t` / `scp -f`) for one regular file
//! (WindTerm F08/F09 prototype). SCP is a separate protocol from SFTP and is
//! verified separately. Sizes and names are bounded; directories, `-p` times
//! and recursion are not implemented.
//!
//! The file panel reaches it through an SFTP grant ([`Ssh::scp_upload`],
//! [`Ssh::scp_download`]): every transfer reconnects through the grant's
//! route, pins the confirmed host key, authenticates again and runs one exec
//! channel, under the grant's revoke/keep rules. Uploads need a writable
//! grant, as SFTP writes do. SCP has no exclusive create: an upload replaces
//! an existing file in place, so a failed or cancelled one can leave it
//! incomplete. Downloads follow the SFTP download rules: the backend chooses
//! the folder, the name is sanitized, the file is created with `create_new`,
//! the size is bounded and a partial file is removed.
use super::{
    sftp_write::{meter, ProgressSink, SftpCall},
    Authenticated, KeyCheck, SftpFailure, SftpRequest, SftpResult, Ssh, REKEY_ERROR,
};
use crate::sftp::{
    local::{self, Downloaded, LocalTarget, MAX_DOWNLOAD_BYTES},
    write::{self, Meter, Progress},
};
use russh::{client, ChannelMsg};
use std::{
    future::Future,
    path::{Path, PathBuf},
    time::Duration,
};

/// Mode of an uploaded file before the server's umask; `-p` is not supported.
const UPLOAD_MODE: u32 = 0o644;
/// Uploads are sent, and their progress counted, in pieces of this size.
const UPLOAD_CHUNK: usize = 32 * 1024;
/// Longest `C` record or server message line accepted.
const MAX_LINE: usize = 4096;
/// Server messages are untrusted text; at most this much of one is shown.
const MAX_MESSAGE_CHARS: usize = 200;
/// How long a failed transfer waits for the server's reason or exit status.
const REASON_WAIT: Duration = Duration::from_secs(1);
const SEND_FAILED: &str = "SCP send failed";
const BAD_NAME: &str = "SCP file name must not contain '/', NUL or newlines";
const UNEXPECTED: &str = "Unexpected SCP result";

/// sh single-quoting, so the remote shell passes the path as one argument.
pub(crate) fn quote(path: &str) -> String {
    format!("'{}'", path.replace('\'', "'\\''"))
}

fn valid_name(name: &str) -> bool {
    !name.is_empty() && name != "." && name != ".." && !name.contains(['/', '\0', '\n'])
}

/// The two directions of one exec channel; tests replace it with a script.
trait Wire: Send {
    fn recv(&mut self) -> impl Future<Output = Option<ChannelMsg>> + Send;
    fn send(&mut self, bytes: &[u8]) -> impl Future<Output = Result<(), String>> + Send;
    fn eof(&mut self) -> impl Future<Output = Result<(), String>> + Send;
}

impl Wire for russh::Channel<client::Msg> {
    async fn recv(&mut self) -> Option<ChannelMsg> {
        self.wait().await
    }

    async fn send(&mut self, bytes: &[u8]) -> Result<(), String> {
        self.data(bytes).await.map_err(|_| SEND_FAILED.into())
    }

    async fn eof(&mut self) -> Result<(), String> {
        russh::Channel::eof(self)
            .await
            .map_err(|_| SEND_FAILED.into())
    }
}

/// Where received file bytes go, as they arrive.
trait Sink {
    fn write(&mut self, bytes: &[u8]) -> Result<(), String>;
}

/// The `C` record that announces one regular file.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct Header {
    // Checked by the fixture test only: uploads always send UPLOAD_MODE.
    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) mode: u32,
    pub(crate) size: u64,
    pub(crate) name: String,
}

/// `<mode> <size> <name>`: four octal digits at most, decimal digits only
/// (no sign), and a name that is one path component.
fn parse_header(line: &str) -> Result<Header, String> {
    let mut fields = line.splitn(3, ' ');
    let mode = fields
        .next()
        .filter(|m| (1..=4).contains(&m.len()) && m.bytes().all(|b| (b'0'..=b'7').contains(&b)))
        .and_then(|m| u32::from_str_radix(m, 8).ok())
        .ok_or("SCP header has no mode")?;
    let size = fields
        .next()
        .filter(|s| (1..=20).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_digit()))
        .and_then(|s| s.parse().ok())
        .ok_or("SCP header has no size")?;
    let name = fields.next().ok_or("SCP header has no name")?;
    if !valid_name(name) {
        return Err("SCP server sent an invalid file name".into());
    }
    Ok(Header {
        mode,
        size,
        name: name.into(),
    })
}

/// Control, invisible and direction-changing characters dropped, length
/// bounded: the server's message is shown to the user as plain text.
fn clean(message: &[u8]) -> String {
    let hidden = |c: char| {
        c.is_control()
            || matches!(
                c,
                '\u{061C}'
                    | '\u{200B}'..='\u{200F}'
                    | '\u{202A}'..='\u{202E}'
                    | '\u{2060}'..='\u{2069}'
                    | '\u{FEFF}'
            )
    };
    let text: String = String::from_utf8_lossy(message)
        .chars()
        .filter(|c| !hidden(*c))
        .take(MAX_MESSAGE_CHARS)
        .collect();
    format!("SCP: {}", text.trim())
}

fn ended(exit: Option<u32>) -> String {
    match exit {
        Some(code) => format!("SCP ended early (exit {code})"),
        None => "SCP ended early".into(),
    }
}

fn limit_text(limit: u64) -> String {
    const MIB: u64 = 1024 * 1024;
    if limit >= MIB && limit.is_multiple_of(MIB) {
        format!("{} MiB", limit / MIB)
    } else {
        format!("{limit} byte")
    }
}

/// Buffered reads from a channel, bounded by the caller's limits.
struct Reader<W> {
    wire: W,
    buffer: Vec<u8>,
    exit: Option<u32>,
}

impl<W: Wire> Reader<W> {
    fn new(wire: W) -> Self {
        Self {
            wire,
            buffer: Vec::new(),
            exit: None,
        }
    }

    async fn fill(&mut self) -> Result<(), String> {
        loop {
            match self.wire.recv().await {
                Some(ChannelMsg::Data { data }) => {
                    self.buffer.extend_from_slice(&data);
                    return Ok(());
                }
                Some(ChannelMsg::ExitStatus { exit_status }) => self.exit = Some(exit_status),
                // OpenSSH may send EOF before the exit status: wait briefly
                // for it, so the error says how the remote command ended.
                Some(ChannelMsg::Eof) => {
                    let _ = tokio::time::timeout(REASON_WAIT, self.exit_status()).await;
                    return Err(ended(self.exit));
                }
                Some(ChannelMsg::Close) | None => return Err(ended(self.exit)),
                Some(_) => {}
            }
        }
    }

    /// Reads until the exit status or the channel's end; data is dropped.
    async fn exit_status(&mut self) {
        while self.exit.is_none() {
            match self.wire.recv().await {
                Some(ChannelMsg::ExitStatus { exit_status }) => self.exit = Some(exit_status),
                Some(ChannelMsg::Close) | None => break,
                Some(_) => {}
            }
        }
    }

    async fn byte(&mut self) -> Result<u8, String> {
        while self.buffer.is_empty() {
            self.fill().await?;
        }
        Ok(self.buffer.drain(..1).next().unwrap_or_default())
    }

    /// One `\n`-terminated line of at most [`MAX_LINE`] bytes, without its
    /// terminator.
    async fn line(&mut self) -> Result<Vec<u8>, String> {
        loop {
            if let Some(end) = self.buffer.iter().position(|b| *b == b'\n') {
                if end > MAX_LINE {
                    return Err("SCP control line too long".into());
                }
                let mut line: Vec<u8> = self.buffer.drain(..=end).collect();
                line.pop();
                return Ok(line);
            }
            if self.buffer.len() > MAX_LINE {
                return Err("SCP control line too long".into());
            }
            self.fill().await?;
        }
    }

    /// Reads one response byte: 0 is OK; 1 and 2 carry the server's message.
    async fn ack(&mut self) -> Result<(), String> {
        match self.byte().await? {
            0 => Ok(()),
            1 | 2 => Err(clean(&self.line().await?)),
            other => Err(format!("SCP protocol error (byte {other})")),
        }
    }

    /// Copies exactly `size` bytes into `sink` as they arrive.
    async fn stream(&mut self, size: u64, sink: &mut impl Sink) -> Result<(), String> {
        let mut remaining = size;
        while remaining > 0 {
            if self.buffer.is_empty() {
                self.fill().await?;
                continue;
            }
            let take = self
                .buffer
                .len()
                .min(usize::try_from(remaining).unwrap_or(usize::MAX));
            sink.write(&self.buffer[..take])?;
            self.buffer.drain(..take);
            remaining -= take as u64;
        }
        Ok(())
    }

    /// Sends `bytes`. When that fails (usually because the remote command
    /// ended), the error is the server's own reason if it gave one.
    async fn send(&mut self, bytes: &[u8]) -> Result<(), String> {
        match self.wire.send(bytes).await {
            Ok(()) => Ok(()),
            Err(error) => Err(self.reason(error).await),
        }
    }

    /// The server's 1/2 message, or how the command ended, read within
    /// [`REASON_WAIT`] after a failure; `fallback` when neither arrives.
    async fn reason(&mut self, fallback: String) -> String {
        let read = async {
            loop {
                match self.byte().await {
                    Ok(0) => {}
                    Ok(1 | 2) => return self.line().await.map(|line| clean(&line)).ok(),
                    Ok(_) => return None,
                    Err(ended) => return Some(ended),
                }
            }
        };
        match tokio::time::timeout(REASON_WAIT, read).await {
            Ok(Some(reason)) => reason,
            _ => fallback,
        }
    }

    /// Tells the server this side gives up. Best effort: the transfer has
    /// failed already and the connection ends right after.
    async fn refuse(&mut self, reason: &str) {
        let _ = self.wire.send(format!("\x02{reason}\n").as_bytes()).await;
    }

    async fn finish(mut self) -> Result<(), String> {
        self.exit_status().await;
        match self.exit {
            Some(0) => Ok(()),
            Some(code) => Err(format!("SCP exited with status {code}")),
            None => Err("SCP closed without an exit status".into()),
        }
    }
}

/// Sends one file as `name` to a `scp -t` sink and waits for its exit status.
async fn send_file<W: Wire>(
    mut reader: Reader<W>,
    name: &str,
    mode: u32,
    data: &[u8],
    progress: Option<&Progress>,
) -> Result<(), String> {
    reader.ack().await?;
    let header = format!("C{:04o} {} {}\n", mode & 0o7777, data.len(), name);
    reader.send(header.as_bytes()).await?;
    reader.ack().await?;
    let mut meter = Meter::new(progress, data.len() as u64);
    let mut sent = 0u64;
    for chunk in data.chunks(UPLOAD_CHUNK) {
        reader.send(chunk).await?;
        sent += chunk.len() as u64;
        meter.update(sent);
    }
    reader.send(&[0]).await?;
    reader.ack().await?;
    reader.wire.eof().await?;
    reader.finish().await
}

/// Receives one regular file from a `scp -f` source. The server must name it
/// `expected` and announce at most `limit` bytes; only then does `open`
/// create the sink, before any data is requested. Returns once the server
/// has acknowledged the end of the data, which is when the file is complete.
async fn receive<W: Wire, S: Sink>(
    reader: &mut Reader<W>,
    expected: &str,
    limit: u64,
    open: impl FnOnce(&Header) -> Result<S, String>,
) -> Result<(Header, S), String> {
    reader.send(&[0]).await?;
    match reader.byte().await? {
        1 | 2 => return Err(clean(&reader.line().await?)),
        b'C' => {}
        _ => {
            reader.refuse("only one regular file is supported").await;
            return Err("SCP: only a single regular file is supported".into());
        }
    }
    let line = reader.line().await?;
    let parsed = std::str::from_utf8(&line)
        .map_err(|_| "SCP header is not UTF-8".to_string())
        .and_then(parse_header);
    let header = match parsed {
        Ok(header) if header.name != expected => {
            Err("SCP server sent a different file name than requested".into())
        }
        Ok(header) if header.size > limit => Err(format!(
            "SCP file exceeds the {} download limit",
            limit_text(limit)
        )),
        other => other,
    };
    let opened = header.and_then(|header| open(&header).map(|sink| (header, sink)));
    let (header, mut sink) = match opened {
        Ok(opened) => opened,
        Err(error) => {
            reader.refuse("transfer refused by the client").await;
            return Err(error);
        }
    };
    reader.send(&[0]).await?;
    reader.stream(header.size, &mut sink).await?;
    reader.ack().await?;
    Ok((header, sink))
}

/// A new local download file, removed on drop unless committed.
struct LocalFile<'a> {
    target: LocalTarget,
    meter: Meter<'a>,
    written: u64,
}

impl Sink for LocalFile<'_> {
    fn write(&mut self, bytes: &[u8]) -> Result<(), String> {
        self.target.write(bytes)?;
        self.written += bytes.len() as u64;
        self.meter.update(self.written);
        Ok(())
    }
}

/// The last component of a path accepted by [`write::validate_target`].
fn base_name(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

/// Receives remote `path` into a new file in `directory` (see the module docs).
async fn save<W: Wire>(
    mut reader: Reader<W>,
    path: &str,
    directory: &Path,
    progress: Option<&Progress>,
) -> Result<Downloaded, String> {
    let open = |header: &Header| {
        let name = local::sanitize_file_name(&header.name);
        let target = local::blocking(|| LocalTarget::create(directory, &name))?;
        Ok(LocalFile {
            target,
            meter: Meter::new(progress, header.size),
            written: 0,
        })
    };
    let (header, file) = receive(&mut reader, base_name(path), MAX_DOWNLOAD_BYTES, open).await?;
    let saved = file.target.commit(header.size)?;
    // The file is complete and kept. The closing reply is best effort: the
    // connection is closed right after, as SFTP closes its remote handle.
    let _ = reader.wire.send(&[0]).await;
    let _ = reader.wire.eof().await;
    Ok(Downloaded {
        path: saved.to_string_lossy().into_owned(),
        bytes: header.size,
    })
}

async fn start(
    session: &client::Handle<KeyCheck>,
    command: String,
) -> Result<Reader<russh::Channel<client::Msg>>, String> {
    let channel = session
        .channel_open_session()
        .await
        .map_err(|_| "SSH channel open failed")?;
    channel
        .exec(true, command)
        .await
        .map_err(|_| "SCP command request failed")?;
    Ok(Reader::new(channel))
}

/// Uploads one file as `directory/name` with `scp -t -d`: `-d` makes the
/// server refuse a `directory` that is not a directory, instead of writing
/// the file under that name (a missing or regular-file parent).
pub(crate) async fn upload(
    session: &client::Handle<KeyCheck>,
    directory: &str,
    name: &str,
    mode: u32,
    data: &[u8],
    progress: Option<&Progress>,
) -> Result<(), String> {
    if !valid_name(name) {
        return Err(BAD_NAME.into());
    }
    let reader = start(session, format!("scp -t -d -- {}", quote(directory))).await?;
    send_file(reader, name, mode, data, progress).await
}

/// Downloads one regular file with `scp -f` into memory, refusing more than
/// `limit` bytes, and waits for the exit status (fixture probe only).
#[cfg(all(test, unix))]
pub(crate) async fn download(
    session: &client::Handle<KeyCheck>,
    path: &str,
    limit: u64,
) -> Result<(Header, Vec<u8>), String> {
    let mut reader = start(session, format!("scp -f -- {}", quote(path))).await?;
    let received = receive(&mut reader, base_name(path), limit, |_| Ok(Vec::new())).await?;
    reader.send(&[0]).await?;
    Wire::eof(&mut reader.wire).await?;
    reader.finish().await?;
    Ok(received)
}

/// One SCP transfer through a grant, built by [`Ssh::scp_upload`] or
/// [`Ssh::scp_download`] after validating everything checkable locally.
pub(super) enum Job {
    Upload {
        directory: String,
        name: String,
        data: Vec<u8>,
        progress: Option<Progress>,
    },
    Download {
        path: String,
        directory: PathBuf,
        progress: Option<Progress>,
    },
}

impl Job {
    pub(super) fn writes(&self) -> bool {
        matches!(self, Self::Upload { .. })
    }
}

/// Runs `job` on a grant's authenticated connection, then disconnects.
/// Failures after authentication keep the grant. A rekey revokes it and is
/// reported as the result even when the transfer itself had finished (as for
/// SFTP); a downloaded file is then already saved.
pub(super) async fn execute(
    connection: Authenticated,
    job: Job,
) -> Result<SftpResult, SftpFailure> {
    let Authenticated {
        _socket,
        session,
        rekey_rejected,
    } = connection;
    let result = match job {
        Job::Upload {
            directory,
            name,
            data,
            progress,
        } => upload(
            &session,
            &directory,
            &name,
            UPLOAD_MODE,
            &data,
            progress.as_ref(),
        )
        .await
        .map(|()| SftpResult::Changed(None)),
        Job::Download {
            path,
            directory,
            progress,
        } => match start(&session, format!("scp -f -- {}", quote(&path))).await {
            Ok(reader) => save(reader, &path, &directory, progress.as_ref())
                .await
                .map(SftpResult::Fetched),
            Err(error) => Err(error),
        },
    };
    if rekey_rejected.load(std::sync::atomic::Ordering::SeqCst) {
        return Err(SftpFailure::Revoke(REKEY_ERROR.into()));
    }
    let _ = session
        .disconnect(
            russh::Disconnect::ByApplication,
            "P0 SCP transfer finished",
            "en",
        )
        .await;
    let _ = tokio::time::timeout(Duration::from_millis(250), session).await;
    result.map_err(SftpFailure::Keep)
}

impl Ssh {
    /// Uploads `data` as the remote file `path` with `scp -t`, through a
    /// writable grant. An existing file is replaced in place.
    pub async fn scp_upload(
        &self,
        call: SftpCall,
        path: String,
        data: Vec<u8>,
        progress: Option<ProgressSink>,
    ) -> Result<(), String> {
        write::validate_upload(&path, data.len())?;
        let (parent, name) = path.rsplit_once('/').ok_or(BAD_NAME)?;
        if !valid_name(name) {
            return Err(BAD_NAME.into());
        }
        let job = Job::Upload {
            directory: if parent.is_empty() { "/" } else { parent }.into(),
            name: name.into(),
            progress: progress.map(|sink| meter(&call.id, sink)),
            data,
        };
        match self.scp_call(call, job).await? {
            SftpResult::Changed(_) => Ok(()),
            _ => Err(UNEXPECTED.into()),
        }
    }

    /// Saves one remote regular file into `directory` with `scp -f`, without
    /// overwriting. Allowed on read-only grants, like SFTP downloads.
    pub async fn scp_download(
        &self,
        call: SftpCall,
        path: String,
        directory: PathBuf,
        progress: Option<ProgressSink>,
    ) -> Result<Downloaded, String> {
        write::validate_target(&path)?;
        // Fail before any network work when nothing could be saved anyway.
        local::check_directory(&directory)?;
        let job = Job::Download {
            progress: progress.map(|sink| meter(&call.id, sink)),
            path,
            directory,
        };
        match self.scp_call(call, job).await? {
            SftpResult::Fetched(downloaded) => Ok(downloaded),
            _ => Err(UNEXPECTED.into()),
        }
    }

    async fn scp_call(&self, call: SftpCall, job: Job) -> Result<SftpResult, String> {
        let SftpCall {
            owner,
            id,
            grant,
            scope,
            prompts,
        } = call;
        self.sftp_request(&owner, &id, &grant, &scope, SftpRequest::Scp(job), prompts)
            .await
    }
}

#[cfg(test)]
#[path = "ssh_scp_tests.rs"]
mod tests;
