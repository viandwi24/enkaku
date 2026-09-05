#!/bin/sh
# Start Enkaku on the LAN over HTTPS, with a certificate it manages itself.
#
# Copy this next to the `enkaku` binary and edit it -- it is an example to
# start from, not a wrapper to keep. Everything here is an environment
# variable the binary reads directly, so `env FOO=bar ./enkaku` is always the
# equivalent, and `.env.example` at the repo root is the full list.
#
#   ./enkaku-example-run.sh              # start it
#   ./enkaku-example-run.sh doctor       # any argument is passed straight through
set -eu

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BINARY="${ENKAKU_BIN:-$SCRIPT_DIR/enkaku}"
[ -x "$BINARY" ] || { echo "Error: no executable at $BINARY. Set ENKAKU_BIN, or run ./enkaku-update.sh first." >&2; exit 1; }

# Reachable from other machines, not just this one. A non-loopback bind is
# what puts the core into `server` mode: login required, TLS required.
export ENKAKU_BIND="${ENKAKU_BIND:-0.0.0.0}"

# `self` with no ENKAKU_TLS_CERT/ENKAKU_TLS_KEY means Enkaku owns the
# certificate: it generates one into <dataDir>/tls/ on the first start and
# loads that same pair on every start after. Browsers still warn -- self-signed
# encrypts the connection and proves no identity -- which is fine on a trusted
# LAN and wrong for anything reachable from the internet. For that, put a real
# proxy in front and use ENKAKU_TLS_MODE=external instead.
#
# Bring your own certificate by setting BOTH of these; then nothing is
# generated:
#   export ENKAKU_TLS_CERT=/path/cert.pem
#   export ENKAKU_TLS_KEY=/path/key.pem
export ENKAKU_TLS_MODE="${ENKAKU_TLS_MODE:-self}"

# ENKAKU_ALLOW_INSECURE=1 is deliberately NOT set here. It only does anything
# when TLS is `off` in server mode -- it is the "yes, I really mean plain HTTP
# with passwords in the clear" override -- and with `self` above there is no
# insecurity to allow. Setting it anyway is harmless and teaches the wrong
# habit, so it is left out.

# Where the database, artifacts, tools and the generated certificate live.
# Defaults to the platform data directory; set it to keep everything beside
# the binary instead.
# export ENKAKU_DATA_DIR="$SCRIPT_DIR/data"

# export ENKAKU_PORT=7700
# export ENKAKU_LOG_LEVEL=info

# `exec` so Ctrl-C, SIGTERM and systemd's stop signal reach the core itself
# rather than this shell -- without it the core is a child that never hears
# them and shuts down uncleanly.
exec "$BINARY" "$@"
