mod platform;
pub mod pty;

use pty::{PtyEvent, Sessions};
use serde::Serialize;
use std::sync::Arc;
use tauri::{ipc::Channel, Manager, State, WebviewWindow};

#[derive(Serialize)]
struct Opened {
    id: String,
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
        .invoke_handler(tauri::generate_handler![
            pty_open, pty_write, pty_resize, pty_ack, pty_close
        ])
        .on_page_load(|webview, payload| {
            if payload.event() == tauri::webview::PageLoadEvent::Started {
                webview
                    .state::<Arc<Sessions>>()
                    .reload_owner(webview.label());
            }
        })
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                window.state::<Arc<Sessions>>().close_owner(window.label());
            }
        })
        .build(tauri::generate_context!())
        .expect("Unable to initialize New WindTerm P0")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                app.state::<Arc<Sessions>>().shutdown();
            }
        });
}
