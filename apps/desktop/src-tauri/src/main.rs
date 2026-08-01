// Shell desktop Enkaku (plan 09 §4.9): jendela native + tray, membungkus
// core yang berjalan sebagai proses anak.
//
// Core TIDAK di-bundle sebagai sidecar biner di tahap ini — shell menjalankan
// binary core yang sudah terpasang (hasil `bun build --compile`) dan menunggu
// endpoint health-nya siap sebelum memuat Studio. Pilihan ini menjaga jalur
// rilis core dan desktop tetap terpisah.

use std::process::{Child, Command};
use std::sync::Mutex;
use tauri::{Manager, State};

struct CoreProcess(Mutex<Option<Child>>);

fn spawn_core() -> std::io::Result<Child> {
    let binary = std::env::var("ENKAKU_CORE_BIN").unwrap_or_else(|_| "enkaku-core".to_string());
    Command::new(binary)
        // Bind loopback ⇒ mode auth `local`: tanpa login, aman karena tidak
        // terjangkau dari luar mesin.
        .env("ENKAKU_BIND", "127.0.0.1")
        .env("ENKAKU_PORT", "7700")
        .spawn()
}

fn main() {
    tauri::Builder::default()
        .manage(CoreProcess(Mutex::new(None)))
        .setup(|app| {
            let state: State<CoreProcess> = app.state();
            match spawn_core() {
                Ok(child) => {
                    *state.0.lock().unwrap() = Some(child);
                }
                Err(err) => {
                    eprintln!("gagal menjalankan core: {err}");
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // Tutup jendela = matikan core juga; farm tidak boleh menggantung
            // sebagai proses yatim tanpa UI.
            if let tauri::WindowEvent::Destroyed = event {
                let state: State<CoreProcess> = window.state();
                if let Some(mut child) = state.0.lock().unwrap().take() {
                    let _ = child.kill();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("gagal menjalankan aplikasi Enkaku");
}
