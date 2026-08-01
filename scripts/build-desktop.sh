#!/usr/bin/env bash
# Rilis aplikasi desktop (plan 14 §5 Tahap 3 & 6).
#
# Core ikut di-bundle sebagai sidecar supaya pengguna cukup memasang satu
# file — itu seluruh alasan aplikasi desktop ini ada.
set -euo pipefail
cd "$(dirname "$0")/.."

TARGET_TRIPLE="${TARGET_TRIPLE:-$(rustc -vV | sed -n 's/^host: //p')}"
BIN_DIR="apps/desktop/src-tauri/binaries"

echo "==> Build Studio (static export)"
bun run --cwd packages/studio build

echo "==> Compile core → binary tunggal"
mkdir -p "$BIN_DIR"
bun build packages/core/src/index.ts --compile --outfile "$BIN_DIR/enkaku-core-$TARGET_TRIPLE"

echo "==> Bundle aplikasi desktop"
cd apps/desktop/src-tauri
cargo tauri build

echo "Selesai. Artefak ada di apps/desktop/src-tauri/target/release/bundle/"
