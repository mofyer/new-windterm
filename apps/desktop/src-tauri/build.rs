fn main() {
    let attributes =
        tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(&[
            "pty_open",
            "pty_write",
            "pty_resize",
            "pty_ack",
            "pty_close",
        ]));
    tauri_build::try_build(attributes).expect("Tauri build configuration failed");
}
