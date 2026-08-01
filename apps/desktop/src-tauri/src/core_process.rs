//! Siklus hidup proses core (plan 14 §4.2).
//!
//! Core dijalankan sebagai proses anak dengan bind loopback, sehingga mode
//! auth `local` sah dipakai: tanpa login, tapi juga tidak terjangkau dari
//! jaringan. PID ditulis ke berkas supaya proses yatim akibat crash bisa
//! dibersihkan saat aplikasi dibuka lagi.

use std::fs;
use std::net::TcpListener;
use std::path::PathBuf;
use std::process::{Child, Command};
use std::time::{Duration, Instant};

pub struct CoreHandle {
    pub child: Child,
    pub port: u16,
}

/// Cari port bebas mulai dari 7700 supaya tidak bentrok dengan core lain
/// yang mungkin sedang berjalan.
fn find_free_port(start: u16) -> u16 {
    for port in start..start + 100 {
        if TcpListener::bind(("127.0.0.1", port)).is_ok() {
            return port;
        }
    }
    start
}

fn pid_file(data_dir: &PathBuf) -> PathBuf {
    data_dir.join("core.pid")
}

/// Bersihkan proses core yatim dari sesi sebelumnya (aplikasi crash).
pub fn cleanup_orphan(data_dir: &PathBuf) {
    let path = pid_file(data_dir);
    let Ok(content) = fs::read_to_string(&path) else {
        return;
    };
    if let Ok(pid) = content.trim().parse::<i32>() {
        // Kill lunak; kalau prosesnya sudah tidak ada, ini tidak berefek.
        let _ = Command::new("kill").arg(pid.to_string()).status();
    }
    let _ = fs::remove_file(&path);
}

pub fn spawn(data_dir: &PathBuf, binary: &str) -> std::io::Result<CoreHandle> {
    cleanup_orphan(data_dir);
    let port = find_free_port(7700);
    let child = Command::new(binary)
        .env("ENKAKU_BIND", "127.0.0.1")
        .env("ENKAKU_PORT", port.to_string())
        .env("ENKAKU_DATA_DIR", data_dir.to_string_lossy().to_string())
        .spawn()?;
    let _ = fs::write(pid_file(data_dir), child.id().to_string());
    Ok(CoreHandle { child, port })
}

/// Tunggu core siap sebelum memuat Studio — jendela putih tanpa penjelasan
/// adalah pengalaman terburuk saat sesuatu gagal.
pub fn wait_healthy(port: u16, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        let ok = Command::new("curl")
            .args([
                "-sf",
                "-o",
                "/dev/null",
                &format!("http://127.0.0.1:{port}/api/health"),
            ])
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        if ok {
            return true;
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    false
}

pub fn stop(handle: &mut CoreHandle, data_dir: &PathBuf) {
    let _ = handle.child.kill();
    let _ = handle.child.wait();
    let _ = fs::remove_file(pid_file(data_dir));
}
