#!/usr/bin/env bash
# Build Studio into a static export.
#
# Guard first: `next build` writes into `.next` even when `distDir` points
# elsewhere, so building while `next dev` is running corrupts the dev server —
# it starts answering 500 with "Cannot find module './NNN.js'", which says
# nothing about the real cause. Both a separate distDir and a .mjs config were
# tried and neither prevents it, so the honest fix is to refuse and say why.
set -euo pipefail
cd "$(dirname "$0")/.."

# -sTCP:LISTEN matters: a browser that once had the page open leaves CLOSED
# sockets on :3001, and a plain port check counts those as "still running".
if lsof -ti:3001 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "The Studio dev server is running on :3001."
  echo
  echo "Building now would corrupt it (you would get HTTP 500 on :3001)."
  echo "Stop it first, then build:"
  echo
  echo "    # in the dev:studio terminal, press Ctrl-C"
  echo "    bun run build:studio"
  echo
  echo "Building is only needed to serve Studio from the core on :7700."
  echo "While developing, use :3001 — it needs no build at all."
  exit 1
fi

exec bun run --cwd packages/studio build
