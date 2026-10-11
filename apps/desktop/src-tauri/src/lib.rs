mod platform;
pub mod pty;
pub mod sftp;
pub mod ssh;

use pty::{PtyEvent, Sessions};
use serde::Serialize;
use std::sync::Arc;
use tauri::{ipc::Channel, Manager, State, WebviewWindow};

#[derive(Serialize)]
struct Opened {
    id: String,
}

#[tauri::command]
fn ssh_context(window: WebviewWindow, service: State<'_, Arc<ssh::Ssh>>) -> Result<String, String> {
    service.context(window.label())
}

#[tauri::command]
async fn ssh_probe(
    window: WebviewWindow,
    service: State<'_, Arc<ssh::Ssh>>,
    request: ssh::Request,
    operation_id: String,
    scope_token: String,
) -> Result<ssh::Challenge, String> {
    service
        .probe(window.label(), &operation_id, request, &scope_token)
        .await
}

#[tauri::command]
async fn ssh_accept(
    window: WebviewWindow,
    service: State<'_, Arc<ssh::Ssh>>,
    challenge_token: String,
    operation_id: String,
    scope_token: String,
) -> Result<ssh::Output, String> {
    service
        .accept(
            window.label(),
            &operation_id,
            &challenge_token,
            &scope_token,
        )
        .await
}

#[tauri::command]
fn ssh_reject(
    window: WebviewWindow,
    service: State<'_, Arc<ssh::Ssh>>,
    challenge_token: String,
) -> Result<(), String> {
    service.reject(window.label(), &challenge_token)
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
    cols: u16,
    rows: u16,
    on_event: Channel<PtyEvent>,
) -> Result<Opened, String> {
    service
        .inner()
        .open(
            window.label(),
            &operation_id,
            &challenge_token,
            &scope_token,
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

pub fn run() {
    tauri::Builder::default()
        .manage(Arc::new(Sessions::default()))
        .manage(Arc::new(ssh::Ssh::default()))
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
            ssh_accept,
            ssh_reject,
            ssh_cancel
        ])
        .on_page_load(|webview, payload| {
            if payload.event() == tauri::webview::PageLoadEvent::Started {
                webview
                    .state::<Arc<Sessions>>()
                    .reload_owner(webview.label());
                webview
                    .state::<Arc<ssh::Ssh>>()
                    .close_owner(webview.label());
            }
        })
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                window.state::<Arc<Sessions>>().close_owner(window.label());
                window.state::<Arc<ssh::Ssh>>().close_owner(window.label());
            }
        })
        .build(tauri::generate_context!())
        .expect("Unable to initialize New WindTerm P0")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                app.state::<Arc<Sessions>>().shutdown();
                app.state::<Arc<ssh::Ssh>>().shutdown();
            }
        });
}
