#!/usr/bin/env bash
# Desktop application release (plan 14 §5, Stages 3 and 6).
#
# The core is bundled as a sidecar so the user installs a single file — that is
# the entire reason this desktop app exists.
set -euo pipefail
cd "$(dirname "$0")/.."

TARGET_TRIPLE="${TARGET_TRIPLE:-$(rustc -vV | sed -n 's/^host: //p')}"
BIN_DIR="apps/desktop/src-tauri/binaries"

echo "==> Building Studio (static export)"
bun run --cwd packages/studio build

echo "==> Compiling the core into a single binary (Studio + migrations embedded)"
bun scripts/gen-embedded-entry.ts
mkdir -p "$BIN_DIR"
bun build packages/core/src/entry-release.gen.ts --compile --outfile "$BIN_DIR/enkaku-core-$TARGET_TRIPLE"

echo "==> Bundling the desktop application"
cd apps/desktop/src-tauri
cargo tauri build

echo "Selesai. Artefak ada di apps/desktop/src-tauri/target/release/bundle/"
