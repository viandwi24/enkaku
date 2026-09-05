#!/bin/sh
# Update an installed Enkaku binary to the latest GitHub release.
#
# Ships beside the binary, not inside it: a core that cannot start is exactly
# when you need this, so it must not depend on the core running, on Bun, or on
# a checkout of this repo. POSIX sh, and `curl` and `tar` are the only hard
# requirements — `jq` is used when present and not needed when it is not.
#
#   ./enkaku-update.sh              # update to the latest release, if newer
#   ./enkaku-update.sh --check      # say what would happen, change nothing
#   ./enkaku-update.sh --force      # reinstall even if already current
#   ./enkaku-update.sh --version v0.1.30   # a specific tag, including downgrades
#
# Environment overrides: ENKAKU_REPO, ENKAKU_BIN, ENKAKU_OS, ENKAKU_ARCH.
set -eu

REPO="${ENKAKU_REPO:-viandwi24/enkaku}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

WANT_VERSION=""
CHECK_ONLY=0
FORCE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --check) CHECK_ONLY=1 ;;
    --force) FORCE=1 ;;
    --version) shift; WANT_VERSION="${1:-}"; [ -n "$WANT_VERSION" ] || { echo "Error: --version needs a tag, e.g. --version v0.1.32" >&2; exit 2; } ;;
    --version=*) WANT_VERSION="${1#--version=}" ;;
    -h|--help) sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Error: unknown argument '$1'. Try --help." >&2; exit 2 ;;
  esac
  shift
done

command -v curl >/dev/null 2>&1 || { echo "Error: curl is required." >&2; exit 1; }
command -v tar  >/dev/null 2>&1 || { echo "Error: tar is required." >&2; exit 1; }

# ---- Which build ------------------------------------------------------------
# Detected rather than hardcoded: the same script has to work on an arm64 board
# and an x64 server, and a farm usually has both.
detect_os() {
  case "$(uname -s)" in
    Linux) echo linux ;;
    Darwin) echo darwin ;;
    MINGW*|MSYS*|CYGWIN*) echo windows ;;
    *) echo "unsupported" ;;
  esac
}
detect_arch() {
  case "$(uname -m)" in
    x86_64|amd64) echo x64 ;;
    aarch64|arm64) echo arm64 ;;
    *) echo "unsupported" ;;
  esac
}
OS="${ENKAKU_OS:-$(detect_os)}"
ARCH="${ENKAKU_ARCH:-$(detect_arch)}"
[ "$OS" != "unsupported" ] || { echo "Error: unsupported OS '$(uname -s)'. Set ENKAKU_OS to one of: linux, darwin, windows." >&2; exit 1; }
[ "$ARCH" != "unsupported" ] || { echo "Error: unsupported architecture '$(uname -m)'. Set ENKAKU_ARCH to x64 or arm64." >&2; exit 1; }

# The release matrix, from .github/workflows/release.yml. darwin-x64 exists,
# linux-arm64 exists, windows is x64-only and ships a .zip.
TARGET="$OS-$ARCH"
case "$TARGET" in
  linux-x64|linux-arm64|darwin-x64|darwin-arm64) EXT="tar.gz"; BIN_NAME="enkaku" ;;
  windows-x64) EXT="zip"; BIN_NAME="enkaku.exe" ;;
  *) echo "Error: no release is built for $TARGET." >&2; exit 1 ;;
esac
BINARY="${ENKAKU_BIN:-$SCRIPT_DIR/$BIN_NAME}"

# ---- Which version ----------------------------------------------------------
# Only the tag is read from the API; every URL below is constructed from the
# naming convention in scripts/build-release.sh. Parsing the whole `assets`
# array would add a jq dependency and a second thing to break when a release
# adds an artifact.
json_field() {
  # $1 = field name. GitHub pretty-prints one field per line, so this is safe
  # without a JSON parser; jq is used when it is available anyway.
  if command -v jq >/dev/null 2>&1; then
    jq -r ".$1 // empty"
  else
    sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\\([^\"]*\\)\".*/\\1/p" | head -n 1
  fi
}

if [ -n "$WANT_VERSION" ]; then
  VERSION="$WANT_VERSION"
else
  echo "Checking $REPO for the latest release…"
  LATEST_JSON="$(curl -fsSL -H 'Accept: application/vnd.github+json' "https://api.github.com/repos/$REPO/releases/latest")" || {
    echo "Error: could not reach the GitHub API. Check the network, or pass --version <tag> to skip the lookup." >&2
    exit 1
  }
  VERSION="$(printf '%s\n' "$LATEST_JSON" | json_field tag_name)"
fi
[ -n "$VERSION" ] || { echo "Error: could not determine the latest version." >&2; exit 1; }

# `enkaku --version` prints the package version (0.1.32); tags carry a leading
# v. Compared as strings on purpose — "is this the exact release I would
# install" is the question, not "is it newer", so a pinned downgrade with
# --version still reports honestly.
INSTALLED=""
if [ -x "$BINARY" ]; then
  INSTALLED="v$("$BINARY" --version 2>/dev/null || echo '')"
  [ "$INSTALLED" != "v" ] || INSTALLED="unknown"
fi

echo "  installed: ${INSTALLED:-none} ($BINARY)"
echo "  release:   $VERSION ($TARGET)"

if [ -n "$INSTALLED" ] && [ "$INSTALLED" = "$VERSION" ] && [ "$FORCE" -eq 0 ]; then
  echo "Already up to date. Use --force to reinstall."
  exit 0
fi
if [ "$CHECK_ONLY" -eq 1 ]; then
  echo "An update is available. Re-run without --check to install it."
  exit 0
fi

# ---- Download, verify, install ---------------------------------------------
ASSET="enkaku-$VERSION-$TARGET.$EXT"
BASE="https://github.com/$REPO/releases/download/$VERSION"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/enkaku-update.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT INT TERM

echo "Downloading $ASSET…"
curl -fL --progress-bar -o "$WORK/$ASSET" "$BASE/$ASSET" || {
  echo "Error: could not download $BASE/$ASSET" >&2
  echo "       Check that $VERSION published a build for $TARGET." >&2
  exit 1
}

# The release publishes SHA256SUMS.txt over the whole artifact set. Verified
# when both the file and a hashing tool are available, and SKIPPED LOUDLY
# rather than silently when either is missing — an unverified install that
# looks identical to a verified one is how a bad mirror goes unnoticed.
if curl -fsSL -o "$WORK/SHA256SUMS.txt" "$BASE/SHA256SUMS.txt" 2>/dev/null; then
  EXPECTED="$(grep " [ *]\{0,1\}$ASSET\$" "$WORK/SHA256SUMS.txt" | awk '{print $1}' | head -n 1)"
  if [ -z "$EXPECTED" ]; then
    echo "Warning: $ASSET is not listed in SHA256SUMS.txt — continuing without verification."
  else
    if command -v sha256sum >/dev/null 2>&1; then
      ACTUAL="$(sha256sum "$WORK/$ASSET" | awk '{print $1}')"
    elif command -v shasum >/dev/null 2>&1; then
      ACTUAL="$(shasum -a 256 "$WORK/$ASSET" | awk '{print $1}')"
    else
      ACTUAL=""
      echo "Warning: neither sha256sum nor shasum is available — continuing without verification."
    fi
    if [ -n "$ACTUAL" ]; then
      [ "$ACTUAL" = "$EXPECTED" ] || {
        echo "Error: checksum mismatch for $ASSET." >&2
        echo "  expected $EXPECTED" >&2
        echo "  actual   $ACTUAL" >&2
        echo "Refusing to install. Delete nothing and retry; if it fails again, the release asset may be corrupt." >&2
        exit 1
      }
      echo "Checksum verified."
    fi
  fi
else
  echo "Warning: SHA256SUMS.txt is not published for $VERSION — continuing without verification."
fi

echo "Extracting…"
if [ "$EXT" = "zip" ]; then
  command -v unzip >/dev/null 2>&1 || { echo "Error: unzip is required for the Windows archive." >&2; exit 1; }
  unzip -q -o "$WORK/$ASSET" -d "$WORK/x"
else
  mkdir -p "$WORK/x"
  tar -xzf "$WORK/$ASSET" -C "$WORK/x"
fi
[ -f "$WORK/x/$BIN_NAME" ] || { echo "Error: '$BIN_NAME' not found inside $ASSET." >&2; exit 1; }
chmod 0755 "$WORK/x/$BIN_NAME"

# Keep the old binary. An update that cannot be undone is a worse outage than
# the one it was meant to fix, and a farm is usually updated remotely.
if [ -f "$BINARY" ]; then
  cp -p "$BINARY" "$BINARY.bak" 2>/dev/null || cp "$BINARY" "$BINARY.bak"
  echo "Previous binary kept at $BINARY.bak"
fi

# `mv`, never `cp`: replacing a RUNNING executable with cp fails outright on
# Linux with ETXTBSY ("Text file busy"), which is precisely the case an
# updater meets — the farm is up and you are updating it. A rename swaps the
# directory entry instead; the running process keeps its own open inode and
# carries on, unharmed, on the old code until it is restarted.
#
# Staged inside the destination directory first, so the rename is on one
# filesystem and therefore atomic: nothing can observe a half-written binary,
# and a failure here leaves the old one in place.
STAGED="$(dirname "$BINARY")/.enkaku-update.$$"
mv "$WORK/x/$BIN_NAME" "$STAGED"
mv "$STAGED" "$BINARY"

echo "Updated $BINARY to $VERSION"

# The rename above does not touch a process that is already running: it is
# still executing the old binary from its own open inode. Saying so is the
# difference between "updated" and "updated and live".
if command -v pgrep >/dev/null 2>&1 && pgrep -f "$BINARY" >/dev/null 2>&1; then
  echo
  echo "A core is still running the PREVIOUS binary — the update takes effect on restart."
  echo "  systemd:  sudo systemctl restart enkaku"
  echo "  manual:   stop it, then start $BINARY again"
fi
