#!/bin/sh
# Enkaku installer -- one command, no checkout, no Bun, no package manager.
#
#   curl -fsSL https://raw.githubusercontent.com/viandwi24/enkaku/main/install.sh | sh
#
# Downloads the self-contained binary for this platform from the latest GitHub
# release, verifies it against the release's SHA256SUMS.txt, installs it into
# ~/.enkaku/bin, and puts that directory on PATH.
#
# Options (pipe them through `sh -s --`, e.g.
#   curl -fsSL .../install.sh | sh -s -- --version v0.1.30):
#
#   --version <tag>     install a specific release instead of the latest
#   --dir <path>        install into <path> instead of ~/.enkaku/bin
#   --no-modify-path    do not touch any shell rc file
#   --help              print this header
#
# Environment overrides: ENKAKU_REPO, ENKAKU_INSTALL_DIR, ENKAKU_VERSION,
# ENKAKU_OS, ENKAKU_ARCH.
#
# POSIX sh on purpose, and `curl` plus `tar` are the only hard requirements --
# this runs on a fresh server before anything else is set up. It is also fully
# non-interactive: stdin is the script itself when piped from curl, so there is
# nothing to prompt on.
set -eu

REPO="${ENKAKU_REPO:-viandwi24/enkaku}"
WANT_VERSION="${ENKAKU_VERSION:-}"
INSTALL_DIR="${ENKAKU_INSTALL_DIR:-}"
MODIFY_PATH=1

while [ $# -gt 0 ]; do
  case "$1" in
    --version) shift; WANT_VERSION="${1:-}"; [ -n "$WANT_VERSION" ] || { echo "Error: --version needs a tag, e.g. --version v0.1.32" >&2; exit 2; } ;;
    --version=*) WANT_VERSION="${1#--version=}" ;;
    --dir) shift; INSTALL_DIR="${1:-}"; [ -n "$INSTALL_DIR" ] || { echo "Error: --dir needs a path." >&2; exit 2; } ;;
    --dir=*) INSTALL_DIR="${1#--dir=}" ;;
    --no-modify-path) MODIFY_PATH=0 ;;
    # `$0` is "sh" when this is piped from curl, so the header is only
    # readable when the script was saved to a file first. Fall back rather
    # than printing a `sed: can't read sh` error at the one moment the user
    # is asking for help.
    -h|--help)
      if [ -r "$0" ] && head -n 1 "$0" | grep -q '^#!'; then
        sed -n '2,24p' "$0" | sed 's/^# \{0,1\}//'
      else
        echo "Enkaku installer -- installs the release binary for this platform."
        echo
        echo "  curl -fsSL https://raw.githubusercontent.com/$REPO/main/install.sh | sh"
        echo "  ... | sh -s -- --version v0.1.30   install a specific release"
        echo "  ... | sh -s -- --dir /usr/local/bin install somewhere else"
        echo "  ... | sh -s -- --no-modify-path    do not touch any shell rc file"
        echo
        echo "Environment: ENKAKU_REPO, ENKAKU_INSTALL_DIR, ENKAKU_VERSION, ENKAKU_OS, ENKAKU_ARCH"
      fi
      exit 0 ;;
    *) echo "Error: unknown argument '$1'. Try --help." >&2; exit 2 ;;
  esac
  shift
done

# A tag goes straight into a URL below. Reject anything that is not plausibly a
# tag rather than letting it build a surprising one.
if [ -n "$WANT_VERSION" ]; then
  case "$WANT_VERSION" in
    *[!A-Za-z0-9._-]*) echo "Error: '$WANT_VERSION' is not a valid release tag." >&2; exit 2 ;;
  esac
fi

INSTALL_DIR="${INSTALL_DIR:-$HOME/.enkaku/bin}"

command -v curl >/dev/null 2>&1 || { echo "Error: curl is required." >&2; exit 1; }
command -v tar  >/dev/null 2>&1 || { echo "Error: tar is required." >&2; exit 1; }

# ---- Which build ------------------------------------------------------------
# Detected rather than assumed: the same one-liner has to work on an arm64 board
# and an x64 server, and a farm usually has both.
detect_os() {
  case "$(uname -s)" in
    Linux) echo linux ;;
    Darwin) echo darwin ;;
    MINGW*|MSYS*|CYGWIN*) echo windows ;;
    *) echo unsupported ;;
  esac
}
detect_arch() {
  case "$(uname -m)" in
    x86_64|amd64) echo x64 ;;
    aarch64|arm64) echo arm64 ;;
    *) echo unsupported ;;
  esac
}
OS="${ENKAKU_OS:-$(detect_os)}"
ARCH="${ENKAKU_ARCH:-$(detect_arch)}"
[ "$OS" != unsupported ] || { echo "Error: unsupported OS '$(uname -s)'. Set ENKAKU_OS to one of: linux, darwin, windows." >&2; exit 1; }
[ "$ARCH" != unsupported ] || { echo "Error: unsupported architecture '$(uname -m)'. Set ENKAKU_ARCH to x64 or arm64." >&2; exit 1; }

# The release matrix, from .github/workflows/release.yml. darwin-x64 exists,
# linux-arm64 exists, windows is x64-only and ships a .zip.
TARGET="$OS-$ARCH"
case "$TARGET" in
  linux-x64|linux-arm64|darwin-x64|darwin-arm64) EXT="tar.gz"; BIN_NAME="enkaku" ;;
  windows-x64) EXT="zip"; BIN_NAME="enkaku.exe" ;;
  *) echo "Error: no release is built for $TARGET." >&2; exit 1 ;;
esac

# ---- Which version ----------------------------------------------------------
# Only the tag is read from the API; every URL below is constructed from the
# naming convention in scripts/build-release.sh, exactly as enkaku-update.sh
# does it. Parsing the whole `assets` array would add a jq dependency and a
# second thing to break when a release adds an artifact.
json_field() {
  if command -v jq >/dev/null 2>&1; then
    jq -r ".$1 // empty"
  else
    sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\\([^\"]*\\)\".*/\\1/p" | head -n 1
  fi
}

if [ -n "$WANT_VERSION" ]; then
  VERSION="$WANT_VERSION"
else
  echo "Looking up the latest $REPO release..."
  LATEST_JSON="$(curl -fsSL -H 'Accept: application/vnd.github+json' "https://api.github.com/repos/$REPO/releases/latest")" || {
    echo "Error: could not reach the GitHub API. Check the network, or pass --version <tag> to skip the lookup." >&2
    exit 1
  }
  VERSION="$(printf '%s\n' "$LATEST_JSON" | json_field tag_name)"
fi
[ -n "$VERSION" ] || { echo "Error: could not determine the latest version. Pass --version <tag>." >&2; exit 1; }

echo "  release: $VERSION"
echo "  target:  $TARGET"
echo "  into:    $INSTALL_DIR"

# ---- Download, verify, install ----------------------------------------------
ASSET="enkaku-$VERSION-$TARGET.$EXT"
BASE="https://github.com/$REPO/releases/download/$VERSION"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/enkaku-install.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT INT TERM

echo "Downloading $ASSET..."
curl -fL --progress-bar -o "$WORK/$ASSET" "$BASE/$ASSET" || {
  echo "Error: could not download $BASE/$ASSET" >&2
  echo "       Check that $VERSION published a build for $TARGET." >&2
  exit 1
}

# The release publishes SHA256SUMS.txt over the whole artifact set. Verified
# when both the file and a hashing tool are available, and SKIPPED LOUDLY
# rather than silently when either is missing -- an unverified install that
# looks identical to a verified one is how a bad mirror goes unnoticed.
if curl -fsSL -o "$WORK/SHA256SUMS.txt" "$BASE/SHA256SUMS.txt" 2>/dev/null; then
  EXPECTED="$(grep " [ *]\{0,1\}$ASSET\$" "$WORK/SHA256SUMS.txt" | awk '{print $1}' | head -n 1)"
  if [ -z "$EXPECTED" ]; then
    echo "Warning: $ASSET is not listed in SHA256SUMS.txt -- continuing without verification."
  else
    if command -v sha256sum >/dev/null 2>&1; then
      ACTUAL="$(sha256sum "$WORK/$ASSET" | awk '{print $1}')"
    elif command -v shasum >/dev/null 2>&1; then
      ACTUAL="$(shasum -a 256 "$WORK/$ASSET" | awk '{print $1}')"
    else
      ACTUAL=""
      echo "Warning: neither sha256sum nor shasum is available -- continuing without verification."
    fi
    if [ -n "$ACTUAL" ]; then
      [ "$ACTUAL" = "$EXPECTED" ] || {
        echo "Error: checksum mismatch for $ASSET." >&2
        echo "  expected $EXPECTED" >&2
        echo "  actual   $ACTUAL" >&2
        echo "Refusing to install." >&2
        exit 1
      }
      echo "Checksum verified."
    fi
  fi
else
  echo "Warning: SHA256SUMS.txt is not published for $VERSION -- continuing without verification."
fi

echo "Extracting..."
mkdir -p "$WORK/x"
if [ "$EXT" = zip ]; then
  command -v unzip >/dev/null 2>&1 || { echo "Error: unzip is required for the Windows archive." >&2; exit 1; }
  unzip -q -o "$WORK/$ASSET" -d "$WORK/x"
else
  tar -xzf "$WORK/$ASSET" -C "$WORK/x"
fi
[ -f "$WORK/x/$BIN_NAME" ] || { echo "Error: '$BIN_NAME' not found inside $ASSET." >&2; exit 1; }
chmod 0755 "$WORK/x/$BIN_NAME"

mkdir -p "$INSTALL_DIR" || { echo "Error: could not create $INSTALL_DIR." >&2; exit 1; }
[ -w "$INSTALL_DIR" ] || { echo "Error: $INSTALL_DIR is not writable. Re-run with --dir <a path you own>." >&2; exit 1; }
BINARY="$INSTALL_DIR/$BIN_NAME"

# Keep the old binary when this is really an upgrade. An install that cannot be
# undone is a worse outage than the one it was meant to fix.
if [ -f "$BINARY" ]; then
  cp -p "$BINARY" "$BINARY.bak" 2>/dev/null || cp "$BINARY" "$BINARY.bak"
  echo "Previous binary kept at $BINARY.bak"
fi

# `mv`, never `cp`: replacing a RUNNING executable with cp fails outright on
# Linux with ETXTBSY ("Text file busy"), and re-running this installer on a live
# farm is exactly that case. A rename swaps the directory entry instead; the
# running process keeps its own open inode and carries on, unharmed, on the old
# code until it is restarted. Staged inside the destination directory first so
# the rename is on one filesystem and therefore atomic -- nothing can observe a
# half-written binary, and a failure here leaves the old one in place.
STAGED="$INSTALL_DIR/.enkaku-install.$$"
mv "$WORK/x/$BIN_NAME" "$STAGED"
mv "$STAGED" "$BINARY"

# The updater ships beside the binary rather than inside it: "the core will not
# start" is exactly when you reach for it, so it must not need a running core, a
# checkout, or Bun. Best-effort -- a failure here does not fail the install.
if curl -fsSL -o "$WORK/enkaku-update.sh" "https://raw.githubusercontent.com/$REPO/$VERSION/scripts/enkaku-update.sh" 2>/dev/null ||
   curl -fsSL -o "$WORK/enkaku-update.sh" "https://raw.githubusercontent.com/$REPO/main/scripts/enkaku-update.sh" 2>/dev/null; then
  mv "$WORK/enkaku-update.sh" "$INSTALL_DIR/enkaku-update.sh"
  chmod 0755 "$INSTALL_DIR/enkaku-update.sh"
fi

echo "Installed $BINARY ($VERSION)"

# ---- PATH -------------------------------------------------------------------
# Only ever appended to a file the user's shell actually reads, only when the
# directory is not already on PATH, and only once -- the marker below makes a
# repeat install a no-op instead of a growing pile of duplicate exports.
MARKER="# added by the Enkaku installer"
ON_PATH=0
case ":${PATH:-}:" in
  *":$INSTALL_DIR:"*) ON_PATH=1 ;;
esac

RC=""
if [ "$ON_PATH" -eq 0 ] && [ "$MODIFY_PATH" -eq 1 ]; then
  case "${SHELL:-}" in
    */zsh)  RC="${ZDOTDIR:-$HOME}/.zshrc" ;;
    */bash) if [ -f "$HOME/.bashrc" ]; then RC="$HOME/.bashrc"; else RC="$HOME/.bash_profile"; fi ;;
    */fish) RC="$HOME/.config/fish/config.fish" ;;
    *)      RC="" ;;
  esac
fi

if [ -n "$RC" ]; then
  if [ -f "$RC" ] && grep -qF "$MARKER" "$RC" 2>/dev/null; then
    : # already there from an earlier install
  else
    mkdir -p "$(dirname "$RC")" 2>/dev/null || true
    case "$RC" in
      */config.fish) printf '\n%s\nset -gx PATH "%s" $PATH\n' "$MARKER" "$INSTALL_DIR" >> "$RC" ;;
      *)             printf '\n%s\nexport PATH="%s:$PATH"\n'  "$MARKER" "$INSTALL_DIR" >> "$RC" ;;
    esac
    echo "Added $INSTALL_DIR to PATH in $RC"
  fi
fi

echo
if [ "$ON_PATH" -eq 1 ]; then
  echo "Run it:"
  echo "  $BIN_NAME"
elif [ -n "$RC" ]; then
  echo "Open a new shell (or: . \"$RC\"), then run:"
  echo "  $BIN_NAME"
else
  echo "Add it to PATH, then run \`$BIN_NAME\`:"
  echo "  export PATH=\"$INSTALL_DIR:\$PATH\""
  echo "Or run it by full path right now:"
  echo "  $BINARY"
fi
echo
echo "Studio is then at http://localhost:7700 -- the first run downloads adb,"
echo "scrcpy-server and the inspector APKs and verifies them (usually under a"
echo "minute). Update later with $INSTALL_DIR/enkaku-update.sh"
echo "Server and systemd setup: https://github.com/$REPO/blob/main/docs/guide/install.md"
