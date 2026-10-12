//! Tauri commands for SFTP writes and downloads (WindTerm F02–F07 prototype)
//! and for legacy SCP transfers through the same grant (F08/F09). Thin
//! wrappers like the rest of `lib.rs`: the window label is the owner, and
//! the WebView never chooses the local download folder.
//!
//! Uploads arrive as a raw IPC body so up to 16 MiB of bytes are not inflated
//! into a JSON number array. Their arguments travel in `x-sftp-*` headers,
//! which must be ASCII; the remote path is therefore hex-encoded UTF-8.

use crate::sftp::{local::Downloaded, write::MAX_UPLOAD_BYTES, RemoteEntry};
use crate::ssh::{
    sftp_write::{Mutation, ProgressSink, SftpCall, TransferProgress},
    Ssh,
};
use serde::Deserialize;
use std::sync::Arc;
use tauri::{
    http::HeaderMap,
    ipc::{Channel, InvokeBody, JavaScriptChannelId, Request},
    Manager, State, WebviewWindow,
};

/// Remote changes other than uploads, as the file panel sends them.
#[derive(Debug, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum Change {
    Mkdir { path: String },
    Rename { from: String, to: String },
    RemoveFile { path: String },
    RemoveDir { path: String },
    Chmod { path: String, mode: u32 },
}

impl From<Change> for Mutation {
    fn from(change: Change) -> Self {
        match change {
            Change::Mkdir { path } => Self::Mkdir { path },
            Change::Rename { from, to } => Self::Rename { from, to },
            Change::RemoveFile { path } => Self::RemoveFile { path },
            Change::RemoveDir { path } => Self::RemoveDir { path },
            Change::Chmod { path, mode } => Self::Chmod { path, mode },
        }
    }
}

/// Progress goes back only to the window that started the transfer.
fn progress(
    window: &WebviewWindow,
    on_progress: Option<JavaScriptChannelId>,
) -> Option<ProgressSink> {
    on_progress.map(|id| {
        let channel: Channel<TransferProgress> = id.channel_on(window.as_ref().clone());
        Arc::new(move |event| channel.send(event).map_err(|e| e.to_string())) as ProgressSink
    })
}

fn call(
    window: &WebviewWindow,
    grant: String,
    id: String,
    scope: String,
    on_auth: Option<JavaScriptChannelId>,
) -> SftpCall {
    SftpCall {
        owner: window.label().into(),
        id,
        grant,
        scope,
        prompts: super::prompts(window, on_auth),
    }
}

/// Upload arguments read from the raw request's headers.
struct UploadHeaders {
    grant: String,
    scope: String,
    id: String,
    path: String,
    overwrite: bool,
    on_auth: Option<JavaScriptChannelId>,
    on_progress: Option<JavaScriptChannelId>,
}

const MAX_HEADER_BYTES: usize = 16 * 1024;
const BAD_HEADERS: &str = "Invalid SFTP upload request";

/// At most one ASCII value per name; absent is `None`.
fn header<'a>(headers: &'a HeaderMap, name: &str) -> Result<Option<&'a str>, String> {
    let mut values = headers.get_all(name).iter();
    let Some(value) = values.next() else {
        return Ok(None);
    };
    if values.next().is_some() || value.len() > MAX_HEADER_BYTES {
        return Err(BAD_HEADERS.into());
    }
    value.to_str().map(Some).map_err(|_| BAD_HEADERS.into())
}

fn required<'a>(headers: &'a HeaderMap, name: &str) -> Result<&'a str, String> {
    header(headers, name)?.ok_or_else(|| BAD_HEADERS.into())
}

fn channel(headers: &HeaderMap, name: &str) -> Result<Option<JavaScriptChannelId>, String> {
    header(headers, name)?
        .map(|value| value.parse().map_err(|_| BAD_HEADERS.to_string()))
        .transpose()
}

/// Strict lowercase-or-uppercase hex of UTF-8, two digits per byte.
fn decode_hex_utf8(text: &str) -> Result<String, String> {
    let digit = |byte: u8| (byte as char).to_digit(16).map(|value| value as u8);
    let bytes = text
        .as_bytes()
        .chunks(2)
        .map(|pair| match pair {
            [high, low] => Some(digit(*high)? << 4 | digit(*low)?),
            _ => None,
        })
        .collect::<Option<Vec<u8>>>()
        .ok_or(BAD_HEADERS)?;
    String::from_utf8(bytes).map_err(|_| BAD_HEADERS.into())
}

impl UploadHeaders {
    fn parse(headers: &HeaderMap) -> Result<Self, String> {
        let overwrite = match required(headers, "x-sftp-overwrite")? {
            "true" => true,
            "false" => false,
            _ => return Err(BAD_HEADERS.into()),
        };
        Self::with_overwrite(headers, overwrite)
    }

    /// SCP cannot refuse to replace a file, so `x-sftp-overwrite` must be
    /// absent rather than suggest a choice that is not honored.
    fn parse_scp(headers: &HeaderMap) -> Result<Self, String> {
        if header(headers, "x-sftp-overwrite")?.is_some() {
            return Err(BAD_HEADERS.into());
        }
        Self::with_overwrite(headers, true)
    }

    fn with_overwrite(headers: &HeaderMap, overwrite: bool) -> Result<Self, String> {
        Ok(Self {
            grant: required(headers, "x-sftp-grant")?.into(),
            scope: required(headers, "x-sftp-scope")?.into(),
            id: required(headers, "x-sftp-operation")?.into(),
            path: decode_hex_utf8(required(headers, "x-sftp-path")?)?,
            overwrite,
            on_auth: channel(headers, "x-sftp-on-auth")?,
            on_progress: channel(headers, "x-sftp-on-progress")?,
        })
    }
}

/// Switches this window's grant between read-only (the default) and writable.
#[tauri::command]
pub fn ssh_sftp_set_writable(
    window: WebviewWindow,
    service: State<'_, Arc<Ssh>>,
    grant_token: String,
    scope_token: String,
    writable: bool,
) -> Result<(), String> {
    service.sftp_set_writable(window.label(), &grant_token, &scope_token, writable)
}

/// mkdir, rename, remove a file or empty directory, or chmod. Chmod returns
/// the entry as the server reports it afterwards.
#[tauri::command]
pub async fn ssh_sftp_change(
    window: WebviewWindow,
    service: State<'_, Arc<Ssh>>,
    grant_token: String,
    operation_id: String,
    scope_token: String,
    change: Change,
    on_auth: Option<JavaScriptChannelId>,
) -> Result<Option<RemoteEntry>, String> {
    let call = call(&window, grant_token, operation_id, scope_token, on_auth);
    service.sftp_mutate(call, change.into(), None).await
}

/// Saves one remote file into the user's Downloads folder, never overwriting.
// Tauri maps each IPC argument to one parameter, like the other SFTP commands.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn ssh_sftp_download(
    window: WebviewWindow,
    service: State<'_, Arc<Ssh>>,
    grant_token: String,
    operation_id: String,
    scope_token: String,
    path: String,
    on_auth: Option<JavaScriptChannelId>,
    on_progress: Option<JavaScriptChannelId>,
) -> Result<Downloaded, String> {
    let directory = window
        .path()
        .download_dir()
        .map_err(|_| "The download folder is unavailable".to_string())?;
    let progress = progress(&window, on_progress);
    let call = call(&window, grant_token, operation_id, scope_token, on_auth);
    service.sftp_download(call, path, directory, progress).await
}

/// Writes the raw request body as one remote file; see the module docs for
/// the header contract.
#[tauri::command]
pub async fn ssh_sftp_upload(
    window: WebviewWindow,
    service: State<'_, Arc<Ssh>>,
    request: Request<'_>,
) -> Result<RemoteEntry, String> {
    let InvokeBody::Raw(data) = request.body() else {
        return Err(BAD_HEADERS.into());
    };
    // Checked again with the path; this only avoids copying an oversize body.
    if data.len() > MAX_UPLOAD_BYTES {
        return Err("Upload exceeds the 16 MiB limit".into());
    }
    let headers = UploadHeaders::parse(request.headers())?;
    let progress = progress(&window, headers.on_progress);
    let call = call(
        &window,
        headers.grant,
        headers.id,
        headers.scope,
        headers.on_auth,
    );
    let mutation = Mutation::Upload {
        path: headers.path,
        data: data.clone(),
        overwrite: headers.overwrite,
    };
    service
        .sftp_mutate(call, mutation, progress)
        .await?
        .ok_or_else(|| "Unexpected SFTP result".into())
}

/// Writes the raw request body as one remote file with legacy SCP
/// (`scp -t`), replacing an existing file. Same headers as
/// [`ssh_sftp_upload`] without `x-sftp-overwrite`; needs a writable grant.
#[tauri::command]
pub async fn ssh_scp_upload(
    window: WebviewWindow,
    service: State<'_, Arc<Ssh>>,
    request: Request<'_>,
) -> Result<(), String> {
    let InvokeBody::Raw(data) = request.body() else {
        return Err(BAD_HEADERS.into());
    };
    if data.len() > MAX_UPLOAD_BYTES {
        return Err("Upload exceeds the 16 MiB limit".into());
    }
    let headers = UploadHeaders::parse_scp(request.headers())?;
    let progress = progress(&window, headers.on_progress);
    let call = call(
        &window,
        headers.grant,
        headers.id,
        headers.scope,
        headers.on_auth,
    );
    service
        .scp_upload(call, headers.path, data.clone(), progress)
        .await
}

/// Saves one remote file into the user's Downloads folder with legacy SCP
/// (`scp -f`), never overwriting. Allowed on read-only grants.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn ssh_scp_download(
    window: WebviewWindow,
    service: State<'_, Arc<Ssh>>,
    grant_token: String,
    operation_id: String,
    scope_token: String,
    path: String,
    on_auth: Option<JavaScriptChannelId>,
    on_progress: Option<JavaScriptChannelId>,
) -> Result<Downloaded, String> {
    let directory = window
        .path()
        .download_dir()
        .map_err(|_| "The download folder is unavailable".to_string())?;
    let progress = progress(&window, on_progress);
    let call = call(&window, grant_token, operation_id, scope_token, on_auth);
    service.scp_download(call, path, directory, progress).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use tauri::http::HeaderValue;

    fn headers(pairs: &[(&'static str, &str)]) -> HeaderMap {
        let mut map = HeaderMap::new();
        for (name, value) in pairs {
            map.append(*name, HeaderValue::from_str(value).unwrap());
        }
        map
    }

    fn hex(text: &str) -> String {
        text.bytes().map(|byte| format!("{byte:02x}")).collect()
    }

    fn upload_headers(path: &str, overwrite: &str) -> Vec<(&'static str, String)> {
        vec![
            ("x-sftp-grant", "grant".into()),
            ("x-sftp-scope", "scope".into()),
            ("x-sftp-operation", "operation".into()),
            ("x-sftp-path", hex(path)),
            ("x-sftp-overwrite", overwrite.into()),
        ]
    }

    fn parse(pairs: &[(&'static str, String)]) -> Result<UploadHeaders, String> {
        let borrowed: Vec<_> = pairs.iter().map(|(n, v)| (*n, v.as_str())).collect();
        UploadHeaders::parse(&headers(&borrowed))
    }

    #[test]
    fn upload_headers_carry_utf8_paths_as_hex() {
        let mut pairs = upload_headers("/home/用户/上传 🌏.bin", "true");
        pairs.push(("x-sftp-on-progress", "__CHANNEL__:7".into()));
        let parsed = parse(&pairs).unwrap();
        assert_eq!(parsed.path, "/home/用户/上传 🌏.bin");
        assert!(parsed.overwrite && parsed.on_auth.is_none() && parsed.on_progress.is_some());
        assert_eq!(
            (
                parsed.grant.as_str(),
                parsed.scope.as_str(),
                parsed.id.as_str()
            ),
            ("grant", "scope", "operation")
        );
        assert!(!parse(&upload_headers("/a", "false")).unwrap().overwrite);
        assert_eq!(decode_hex_utf8("2F41").unwrap(), "/A");
    }

    #[test]
    fn upload_headers_are_strict() {
        for overwrite in ["", "1", "TRUE", "yes"] {
            assert!(
                parse(&upload_headers("/a", overwrite)).is_err(),
                "{overwrite}"
            );
        }
        for bad in ["2", "2f4", "zz", "+f", "2f 41", "c3"] {
            assert!(decode_hex_utf8(bad).is_err(), "{bad}");
        }
        let mut missing = upload_headers("/a", "false");
        missing.remove(0);
        assert_eq!(parse(&missing).err().as_deref(), Some(BAD_HEADERS));
        let mut duplicated = upload_headers("/a", "false");
        duplicated.push(("x-sftp-grant", "other".into()));
        assert!(parse(&duplicated).is_err());
        let mut channel = upload_headers("/a", "false");
        channel.push(("x-sftp-on-auth", "not-a-channel".into()));
        assert!(parse(&channel).is_err());
        let mut oversize = upload_headers("/a", "false");
        oversize[3].1 = "2f".repeat(MAX_HEADER_BYTES);
        assert!(parse(&oversize).is_err());
    }

    #[test]
    fn scp_upload_headers_have_no_overwrite_switch() {
        let mut pairs = upload_headers("/home/用户/scp.bin", "false");
        pairs.retain(|(name, _)| *name != "x-sftp-overwrite");
        let borrowed: Vec<_> = pairs.iter().map(|(n, v)| (*n, v.as_str())).collect();
        let parsed = UploadHeaders::parse_scp(&headers(&borrowed)).unwrap();
        assert_eq!(parsed.path, "/home/用户/scp.bin");
        assert!(parsed.overwrite);
        // The SFTP form needs the switch; the SCP form refuses any value.
        assert!(UploadHeaders::parse(&headers(&borrowed)).is_err());
        for value in ["true", "false"] {
            let full = upload_headers("/a", value);
            let borrowed: Vec<_> = full.iter().map(|(n, v)| (*n, v.as_str())).collect();
            assert_eq!(
                UploadHeaders::parse_scp(&headers(&borrowed))
                    .err()
                    .as_deref(),
                Some(BAD_HEADERS)
            );
        }
        let mut missing = pairs.clone();
        missing.remove(0);
        let borrowed: Vec<_> = missing.iter().map(|(n, v)| (*n, v.as_str())).collect();
        assert!(UploadHeaders::parse_scp(&headers(&borrowed)).is_err());
    }

    #[test]
    fn changes_are_tagged_and_closed() {
        let parsed: Change =
            serde_json::from_str(r#"{"kind":"rename","from":"/a","to":"/b"}"#).unwrap();
        assert_eq!(
            parsed,
            Change::Rename {
                from: "/a".into(),
                to: "/b".into()
            }
        );
        let chmod: Change =
            serde_json::from_str(r#"{"kind":"chmod","path":"/a","mode":420}"#).unwrap();
        assert_eq!(
            chmod,
            Change::Chmod {
                path: "/a".into(),
                mode: 0o644
            }
        );
        for rejected in [
            r#"{"kind":"upload","path":"/a","data":[1]}"#,
            r#"{"kind":"removeFile","path":"/a","recursive":true}"#,
            r#"{"kind":"chmod","path":"/a","mode":-1}"#,
            r#"{"path":"/a"}"#,
        ] {
            assert!(
                serde_json::from_str::<Change>(rejected).is_err(),
                "{rejected}"
            );
        }
        assert!(matches!(
            Mutation::from(Change::RemoveDir { path: "/d".into() }),
            Mutation::RemoveDir { path } if path == "/d"
        ));
    }
}
