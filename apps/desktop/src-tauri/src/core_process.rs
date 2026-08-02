//! The core process lifecycle (plan 14 §4.2).
//!
//! The core runs as a child process bound to loopback, which is what makes
//! `local` auth mode legitimate: no login, but also unreachable from the
//! network. The PID is written to a file so a process orphaned by a crash can
//! be cleaned up the next time the app opens.

use std::fs;
use std::net::TcpListener;
use std::path::PathBuf;
use std::process::{Child, Command};
use std::time::{Duration, Instant};

pub struct CoreHandle {
    pub child: Child,
    pub port: u16,
}

/// Find a free port starting at 7700, so it never collides with another core
/// that may already be running.
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

/// Clean up an orphaned core process from a previous session (an app crash).
pub fn cleanup_orphan(data_dir: &PathBuf) {
    let path = pid_file(data_dir);
    let Ok(content) = fs::read_to_string(&path) else {
        return;
    };
    if let Ok(pid) = content.trim().parse::<i32>() {
        // A soft kill; if the process is already gone this does nothing.
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

/// Wait for the core to be ready before loading Studio — a white window with
/// no explanation is the worst thing to show when something fails.
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
