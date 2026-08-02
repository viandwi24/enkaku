// The Enkaku desktop shell (plan 14).
//
// One goal: the user just double-clicks. No terminal,
// no address to type, and no adb to install.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod core_process;

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use core_process::CoreHandle;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

struct AppState {
    core: Mutex<Option<CoreHandle>>,
    data_dir: PathBuf,
}

fn data_dir() -> PathBuf {
    std::env::var("ENKAKU_DATA_DIR").map(PathBuf::from).unwrap_or_else(|_| {
        let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
        #[cfg(target_os = "macos")]
        return PathBuf::from(home).join("Library/Application Support/Enkaku");
        #[cfg(not(target_os = "macos"))]
        return PathBuf::from(home).join(".local/share/enkaku");
    })
}

/// The page shown when the core fails to start — an explanation rather than
/// a white window that leaves the user guessing.
fn error_page(message: &str) -> String {
    format!(
        r#"data:text/html,<html><body style="font-family:system-ui;padding:2rem;background:#0b0c0e;color:#e7e9ee">
<h2>Enkaku failed to start</h2>
<p>{message}</p>
<p style="color:#9aa1ad">Check that the core binary is present. Set <code>ENKAKU_CORE_BIN</code> if the core lives somewhere else.</p>
</body></html>"#
    )
}

fn main() {
    let dir = data_dir();
    let _ = std::fs::create_dir_all(&dir);

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(AppState {
            core: Mutex::new(None),
            data_dir: dir.clone(),
        })
        .setup(move |app| {
            let binary = std::env::var("ENKAKU_CORE_BIN").unwrap_or_else(|_| "enkaku-core".to_string());
            let state = app.state::<AppState>();

            let url = match core_process::spawn(&state.data_dir, &binary) {
                Ok(handle) => {
                    let port = handle.port;
                    *state.core.lock().unwrap() = Some(handle);
                    if core_process::wait_healthy(port, Duration::from_secs(30)) {
                        WebviewUrl::External(
                            format!("http://127.0.0.1:{port}").parse().expect("URL core valid"),
                        )
                    } else {
                        WebviewUrl::External(
                            error_page("The core started but did not respond within 30 seconds.")
                                .parse()
                                .expect("URL data valid"),
                        )
                    }
                }
                Err(err) => WebviewUrl::External(
                    error_page(&format!("Could not start the core: {err}"))
                        .parse()
                        .expect("URL data valid"),
                ),
            };

            WebviewWindowBuilder::new(app, "main", url)
                .title("Enkaku")
                .inner_size(1280.0, 860.0)
                .build()?;

            // Tray: closing the window minimises to the tray, the core stays alive.
            let open = MenuItem::with_id(app, "open", "Open Enkaku", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &quit])?;
            TrayIconBuilder::new()
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => {
                        if let Some(win) = app.get_webview_window("main") {
                            let _ = win.show();
                            let _ = win.set_focus();
                        }
                    }
                    "quit" => {
                        // Tell the UI first so it can warn about running jobs.
                        let _ = app.emit("enkaku://quit-requested", ());
                        app.exit(0);
                    }
                    _ => {}
                })
                .build(app)?;

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                // Minimise to the tray rather than exiting — the core keeps serving jobs.
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("failed to build the Enkaku application")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { .. } = event {
                // The core must never be left orphaned with no UI.
                let state = app.state::<AppState>();
                let mut guard = state.core.lock().unwrap();
                if let Some(handle) = guard.as_mut() {
                    core_process::stop(handle, &state.data_dir);
                }
                *guard = None;
            }
        });
}
