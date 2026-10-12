mod known_hosts;
pub mod modem;
pub mod net_terminal;
mod platform;
pub mod pty;
pub mod sftp;
mod sftp_ipc;
pub mod ssh;
pub mod telnet;
pub mod tmux_control;

use pty::{PtyEvent, Sessions};
use serde::Serialize;
use std::sync::Arc;
use tauri::{
    ipc::{Channel, JavaScriptChannelId},
    Manager, State, WebviewWindow,
};
use zeroize::Zeroizing;

#[derive(Serialize)]
struct Opened {
    id: String,
}

/// Keyboard-interactive rounds go back only to the window that sent the command.
fn prompts(
    window: &WebviewWindow,
    on_auth: Option<JavaScriptChannelId>,
) -> Option<ssh::PromptSink> {
    on_auth.map(|id| {
        let channel: Channel<ssh::AuthPrompt> = id.channel_on(window.as_ref().clone());
        Arc::new(move |prompt| channel.send(prompt).map_err(|e| e.to_string())) as ssh::PromptSink
    })
}

fn login(
    window: &WebviewWindow,
    credential: Option<ssh::Credential>,
    on_auth: Option<JavaScriptChannelId>,
) -> ssh::Login {
    ssh::Login {
        credential: credential.unwrap_or_default(),
        prompts: prompts(window, on_auth),
    }
}

#[tauri::command]
fn ssh_context(window: WebviewWindow, service: State<'_, Arc<ssh::Ssh>>) -> Result<String, String> {
    service.context(window.label())
}

/// `route` is bound to the returned challenge; later commands cannot change it.
#[tauri::command]
async fn ssh_probe(
    window: WebviewWindow,
    service: State<'_, Arc<ssh::Ssh>>,
    request: ssh::Request,
    operation_id: String,
    scope_token: String,
    route: Option<ssh::RouteSpec>,
) -> Result<ssh::Challenge, String> {
    let route = route.unwrap_or_default();
    service
        .probe_via(window.label(), &operation_id, request, route, &scope_token)
        .await
}

/// Step 2 of a jump route: logs in to the confirmed jump host and returns
/// the target's challenge, observed through it.
#[tauri::command]
async fn ssh_probe_through(
    window: WebviewWindow,
    service: State<'_, Arc<ssh::Ssh>>,
    challenge_token: String,
    operation_id: String,
    scope_token: String,
    credential: ssh::Credential,
) -> Result<ssh::Challenge, String> {
    service
        .probe_through(
            window.label(),
            &operation_id,
            &challenge_token,
            &scope_token,
            credential,
        )
        .await
}

/// The exact argv a ProxyCommand would run, for the user to confirm. Runs nothing.
#[tauri::command]
fn ssh_proxy_command_preview(
    _window: WebviewWindow,
    request: ssh::Request,
    command: String,
) -> Result<Vec<String>, String> {
    ssh::proxy_command_preview(&request, &command)
}

#[tauri::command]
async fn ssh_accept(
    window: WebviewWindow,
    service: State<'_, Arc<ssh::Ssh>>,
    challenge_token: String,
    operation_id: String,
    scope_token: String,
    credential: Option<ssh::Credential>,
    on_auth: Option<JavaScriptChannelId>,
) -> Result<ssh::Output, String> {
    let login = login(&window, credential, on_auth);
    service
        .accept_with(
            window.label(),
            &operation_id,
            &challenge_token,
            &scope_token,
            login,
        )
        .await
}

#[tauri::command]
async fn ssh_sftp_open(
    window: WebviewWindow,
    service: State<'_, Arc<ssh::Ssh>>,
    challenge_token: String,
    operation_id: String,
    scope_token: String,
    credential: Option<ssh::Credential>,
    on_auth: Option<JavaScriptChannelId>,
) -> Result<ssh::SftpOpened, String> {
    let login = login(&window, credential, on_auth);
    service
        .sftp_open_with(
            window.label(),
            &operation_id,
            &challenge_token,
            &scope_token,
            login,
        )
        .await
}

#[tauri::command]
async fn ssh_sftp_list(
    window: WebviewWindow,
    service: State<'_, Arc<ssh::Ssh>>,
    grant_token: String,
    operation_id: String,
    scope_token: String,
    path: String,
    on_auth: Option<JavaScriptChannelId>,
) -> Result<sftp::RemoteListing, String> {
    let prompts = prompts(&window, on_auth);
    service
        .sftp_list(
            window.label(),
            &operation_id,
            &grant_token,
            &scope_token,
            path,
            prompts,
        )
        .await
}

#[tauri::command]
async fn ssh_sftp_metadata(
    window: WebviewWindow,
    service: State<'_, Arc<ssh::Ssh>>,
    grant_token: String,
    operation_id: String,
    scope_token: String,
    path: String,
    on_auth: Option<JavaScriptChannelId>,
) -> Result<sftp::RemoteEntry, String> {
    let prompts = prompts(&window, on_auth);
    service
        .sftp_metadata(
            window.label(),
            &operation_id,
            &grant_token,
            &scope_token,
            path,
            prompts,
        )
        .await
}

#[tauri::command]
async fn ssh_sftp_read(
    window: WebviewWindow,
    service: State<'_, Arc<ssh::Ssh>>,
    grant_token: String,
    operation_id: String,
    scope_token: String,
    path: String,
    on_auth: Option<JavaScriptChannelId>,
) -> Result<Vec<u8>, String> {
    let prompts = prompts(&window, on_auth);
    service
        .sftp_read(
            window.label(),
            &operation_id,
            &grant_token,
            &scope_token,
            path,
            prompts,
        )
        .await
}

#[tauri::command]
fn ssh_sftp_close(
    window: WebviewWindow,
    service: State<'_, Arc<ssh::Ssh>>,
    grant_token: String,
) -> Result<(), String> {
    service.sftp_close(window.label(), &grant_token)
}

#[tauri::command]
fn ssh_trust_save(
    window: WebviewWindow,
    service: State<'_, Arc<ssh::Ssh>>,
    challenge_token: String,
) -> Result<(), String> {
    service.trust_save(window.label(), &challenge_token)
}

#[tauri::command]
fn ssh_trust_replace(
    window: WebviewWindow,
    service: State<'_, Arc<ssh::Ssh>>,
    challenge_token: String,
) -> Result<(), String> {
    service.trust_replace(window.label(), &challenge_token)
}

#[tauri::command]
fn ssh_reject(
    window: WebviewWindow,
    service: State<'_, Arc<ssh::Ssh>>,
    challenge_token: String,
) -> Result<(), String> {
    service.reject(window.label(), &challenge_token)
}

/// Answers the waiting keyboard-interactive round of this window's operation.
#[tauri::command]
fn ssh_auth_respond(
    window: WebviewWindow,
    service: State<'_, Arc<ssh::Ssh>>,
    operation_id: String,
    round: u32,
    answers: Vec<Zeroizing<String>>,
) -> Result<(), String> {
    service.auth_respond(window.label(), &operation_id, round, answers)
}

#[tauri::command]
fn ssh_cancel(
    window: WebviewWindow,
    service: State<'_, Arc<ssh::Ssh>>,
    operation_id: String,
) -> Result<(), String> {
    service.cancel(window.label(), &operation_id)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn ssh_open(
    window: WebviewWindow,
    service: State<'_, Arc<ssh::Ssh>>,
    challenge_token: String,
    operation_id: String,
    scope_token: String,
    credential: Option<ssh::Credential>,
    cols: u16,
    rows: u16,
    on_event: Channel<PtyEvent>,
    on_auth: Option<JavaScriptChannelId>,
) -> Result<Opened, String> {
    let login = login(&window, credential, on_auth);
    service
        .inner()
        .open_with(
            window.label(),
            &operation_id,
            &challenge_token,
            &scope_token,
            login,
            cols,
            rows,
            Arc::new(move |event| on_event.send(event).map_err(|e| e.to_string())),
        )
        .await
        .map(|id| Opened { id })
}
#[tauri::command]
fn ssh_write(
    window: WebviewWindow,
    service: State<'_, Arc<ssh::Ssh>>,
    id: String,
    data: Vec<u8>,
) -> Result<(), String> {
    service.write(window.label(), &id, data)
}
#[tauri::command]
fn ssh_resize(
    window: WebviewWindow,
    service: State<'_, Arc<ssh::Ssh>>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    service.resize(window.label(), &id, cols, rows)
}
#[tauri::command]
fn ssh_ack(
    window: WebviewWindow,
    service: State<'_, Arc<ssh::Ssh>>,
    id: String,
    sequence: u64,
) -> Result<(), String> {
    service.ack(window.label(), &id, sequence)
}
#[tauri::command]
fn ssh_close(
    window: WebviewWindow,
    service: State<'_, Arc<ssh::Ssh>>,
    id: String,
) -> Result<(), String> {
    service.close(window.label(), &id)
}

#[tauri::command]
async fn pty_open(
    window: WebviewWindow,
    sessions: State<'_, Arc<Sessions>>,
    on_event: Channel<PtyEvent>,
    cols: u16,
    rows: u16,
) -> Result<Opened, String> {
    let sessions = sessions.inner().clone();
    let owner = window.label().to_owned();
    let generation = sessions.generation(&owner)?;
    tauri::async_runtime::spawn_blocking(move || {
        sessions
            .open_at_generation(
                &owner,
                generation,
                cols,
                rows,
                Arc::new(move |event| on_event.send(event).map_err(|e| e.to_string())),
            )
            .map(|id| Opened { id })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn pty_write(
    window: WebviewWindow,
    sessions: State<'_, Arc<Sessions>>,
    id: String,
    data: Vec<u8>,
) -> Result<(), String> {
    sessions.get(window.label(), &id)?.write(data)
}

#[tauri::command]
async fn pty_resize(
    window: WebviewWindow,
    sessions: State<'_, Arc<Sessions>>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    sessions.get(window.label(), &id)?.resize(cols, rows)
}

#[tauri::command]
async fn pty_ack(
    window: WebviewWindow,
    sessions: State<'_, Arc<Sessions>>,
    id: String,
    sequence: u64,
) -> Result<(), String> {
    sessions.get(window.label(), &id)?.ack(sequence)
}

#[tauri::command]
async fn pty_close(
    window: WebviewWindow,
    sessions: State<'_, Arc<Sessions>>,
    id: String,
) -> Result<(), String> {
    sessions.close(window.label(), &id)
}

#[tauri::command]
async fn net_open(
    window: WebviewWindow,
    service: State<'_, Arc<net_terminal::NetTerminals>>,
    target: net_terminal::Target,
    id: String,
    cols: u16,
    rows: u16,
    on_event: Channel<PtyEvent>,
) -> Result<Opened, String> {
    service
        .inner()
        .open(
            window.label(),
            &id,
            target,
            cols,
            rows,
            Arc::new(move |event| on_event.send(event).map_err(|e| e.to_string())),
        )
        .await
        .map(|id| Opened { id })
}
#[tauri::command]
async fn net_write(
    window: WebviewWindow,
    service: State<'_, Arc<net_terminal::NetTerminals>>,
    id: String,
    data: Vec<u8>,
) -> Result<(), String> {
    service.write(window.label(), &id, data).await
}
#[tauri::command]
fn net_resize(
    window: WebviewWindow,
    service: State<'_, Arc<net_terminal::NetTerminals>>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    service.resize(window.label(), &id, cols, rows)
}
#[tauri::command]
fn net_ack(
    window: WebviewWindow,
    service: State<'_, Arc<net_terminal::NetTerminals>>,
    id: String,
    sequence: u64,
) -> Result<(), String> {
    service.ack(window.label(), &id, sequence)
}
#[tauri::command]
fn net_close(
    window: WebviewWindow,
    service: State<'_, Arc<net_terminal::NetTerminals>>,
    id: String,
) -> Result<(), String> {
    service.close(window.label(), &id)
}

pub fn run() {
    tauri::Builder::default()
        .manage(Arc::new(Sessions::default()))
        .manage(Arc::new(net_terminal::NetTerminals::default()))
        .setup(|app| {
            // Saved host trust lives with application data, never in the repo
            // or the WebView. The file is created on the first explicit save.
            let store = app.path().app_data_dir()?.join("known_hosts");
            app.manage(Arc::new(ssh::Ssh::with_known_hosts(store)));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            ssh_context,
            ssh_open,
            ssh_write,
            ssh_resize,
            ssh_ack,
            ssh_close,
            pty_open,
            pty_write,
            pty_resize,
            pty_ack,
            pty_close,
            ssh_probe,
            ssh_probe_through,
            ssh_proxy_command_preview,
            ssh_accept,
            ssh_sftp_open,
            ssh_sftp_list,
            ssh_sftp_metadata,
            ssh_sftp_read,
            ssh_sftp_close,
            sftp_ipc::ssh_sftp_set_writable,
            sftp_ipc::ssh_sftp_change,
            sftp_ipc::ssh_sftp_upload,
            sftp_ipc::ssh_sftp_download,
            ssh_trust_save,
            ssh_trust_replace,
            ssh_reject,
            ssh_cancel,
            ssh_auth_respond,
            net_open,
            net_write,
            net_resize,
            net_ack,
            net_close
        ])
        .on_page_load(|webview, payload| {
            if payload.event() == tauri::webview::PageLoadEvent::Started {
                webview
                    .state::<Arc<Sessions>>()
                    .reload_owner(webview.label());
                webview
                    .state::<Arc<ssh::Ssh>>()
                    .close_owner(webview.label());
                webview
                    .state::<Arc<net_terminal::NetTerminals>>()
                    .close_owner(webview.label());
            }
        })
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                window.state::<Arc<Sessions>>().close_owner(window.label());
                window.state::<Arc<ssh::Ssh>>().close_owner(window.label());
                window
                    .state::<Arc<net_terminal::NetTerminals>>()
                    .close_owner(window.label());
            }
        })
        .build(tauri::generate_context!())
        .expect("Unable to initialize New WindTerm P0")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                app.state::<Arc<Sessions>>().shutdown();
                app.state::<Arc<ssh::Ssh>>().shutdown();
                app.state::<Arc<net_terminal::NetTerminals>>().shutdown();
            }
        });
}
