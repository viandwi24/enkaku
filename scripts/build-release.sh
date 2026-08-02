#!/usr/bin/env bash
# Portable CLI release: one self-contained binary per platform.
#
# Builds the Studio static export, embeds it (plus the drizzle migrations)
# into the core via the generated release entrypoint, cross-compiles every
# target with `bun build --compile`, and packages tar.gz (unix) / zip
# (windows) archives with a SHA256SUMS.txt into release/.
#
# Usage:
#   bash scripts/build-release.sh                # all targets
#   TARGETS="linux-x64" bash scripts/build-release.sh
#   VERSION=v0.2.0 bash scripts/build-release.sh # defaults to git describe
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION="${VERSION:-$(git describe --tags --always --dirty 2>/dev/null || echo dev)}"
TARGETS="${TARGETS:-darwin-arm64 darwin-x64 linux-x64 linux-arm64 windows-x64}"
OUT_DIR="release"

echo "==> Building Studio (static export)"
bun run --cwd packages/studio build

echo "==> Generating the release entrypoint (Studio + migrations embedded)"
bun scripts/gen-embedded-entry.ts

rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"

for target in $TARGETS; do
  name="enkaku-$VERSION-$target"
  stage="$OUT_DIR/$name"
  mkdir -p "$stage"
  if [ "${target%%-*}" = "windows" ]; then
    bin="$stage/enkaku.exe"
  else
    bin="$stage/enkaku"
  fi

  echo "==> Compiling $target"
  # --bytecode would halve startup time but rejects top-level await (which the
  # entrypoint uses); revisit when Bun lifts that limit.
  bun build packages/core/src/entry-release.gen.ts \
    --compile --minify --sourcemap --target="bun-$target" --outfile "$bin"

  echo "==> Packaging $name"
  if [ "${target%%-*}" = "windows" ]; then
    (cd "$stage" && zip -q -9 "../$name.zip" "$(basename "$bin")")
  else
    tar -czf "$OUT_DIR/$name.tar.gz" -C "$stage" "$(basename "$bin")"
  fi
  rm -rf "$stage"
done

echo "==> Checksums"
(
  cd "$OUT_DIR"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum ./*.tar.gz ./*.zip > SHA256SUMS.txt 2>/dev/null || sha256sum ./* > SHA256SUMS.txt
  else
    shasum -a 256 ./*.tar.gz ./*.zip > SHA256SUMS.txt 2>/dev/null || shasum -a 256 ./* > SHA256SUMS.txt
  fi
  cat SHA256SUMS.txt
)

echo "Done. Artifacts in $OUT_DIR/"
