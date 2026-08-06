#!/usr/bin/env bash
# Diffs packages/harness/src against the upstream source it was copied from
# (bitorex-algo@9eab029, 2026-07-04), and fails unless the ONLY differences
# are the plan 75 §3.5 header notes on the two unreferenced files.
#
# This is what keeps plan 75's acceptance criterion 2 true as the harness
# series (76-78) proceeds: "the copied files stay byte-identical to upstream
# except for the header notes". Anyone tempted to reformat or "fix" a copied
# file finds out here, not in a later, harder-to-untangle diff.
#
# Usage:
#   bash scripts/check-harness-provenance.sh
#   HARNESS_UPSTREAM_DIR=/path/to/bitorex-algo/packages/harness/src bash scripts/check-harness-provenance.sh
#
# The default upstream path is where this plan's author found it; it is a
# machine-local checkout, not part of this repo, so it MUST be overridable —
# a missing upstream checkout is reported and skipped (exit 0 with a warning),
# never treated as "no differences found".
set -uo pipefail
cd "$(dirname "$0")/.."

UPSTREAM_DIR="${HARNESS_UPSTREAM_DIR:-/Users/solpochi/Projects/devs/bitorex/bitorex-algo/packages/harness/src}"
LOCAL_DIR="packages/harness/src"

# Files allowed to differ from upstream, and ONLY by an additive header
# comment block at the very top (plan 75 §3.5) — never a body edit.
ALLOWED_HEADER_FILES=("core/resilient.ts" "session/message-store.ts")

if [ ! -d "$UPSTREAM_DIR" ]; then
  echo "SKIP: upstream checkout not found at $UPSTREAM_DIR"
  echo "      set HARNESS_UPSTREAM_DIR to verify provenance on this machine."
  exit 0
fi

fail=0

is_allowed_header_file() {
  local f="$1"
  for allowed in "${ALLOWED_HEADER_FILES[@]}"; do
    [ "$f" = "$allowed" ] && return 0
  done
  return 1
}

# 1. No file exists on one side only.
while IFS= read -r -d '' f; do
  rel="${f#"$LOCAL_DIR"/}"
  if [ ! -f "$UPSTREAM_DIR/$rel" ]; then
    echo "FAIL: $rel exists locally but not upstream (new file, not part of the verbatim copy)"
    fail=1
  fi
done < <(find "$LOCAL_DIR" -type f -name '*.ts' -print0)

while IFS= read -r -d '' f; do
  rel="${f#"$UPSTREAM_DIR"/}"
  if [ ! -f "$LOCAL_DIR/$rel" ]; then
    echo "FAIL: $rel exists upstream but was dropped from the local copy"
    fail=1
  fi
done < <(find "$UPSTREAM_DIR" -type f -name '*.ts' -print0)

# 2. Content comparison.
while IFS= read -r -d '' f; do
  rel="${f#"$LOCAL_DIR"/}"
  upstream_f="$UPSTREAM_DIR/$rel"
  [ -f "$upstream_f" ] || continue # already reported above

  if cmp -s "$f" "$upstream_f"; then
    continue # byte-identical — the common, expected case
  fi

  if ! is_allowed_header_file "$rel"; then
    echo "FAIL: $rel differs from upstream and is not on the §3.5 header-note allowlist"
    diff -u "$upstream_f" "$f" | head -20
    fail=1
    continue
  fi

  # An allowed file may ONLY gain lines (a header comment block prepended).
  # A unified diff with zero context lines removed (`-` lines) and only `+`
  # lines added is exactly that; anything else is a body edit hiding behind
  # the allowlist.
  removed=$(diff -u "$upstream_f" "$f" | grep -c '^-[^-]')
  if [ "$removed" -ne 0 ]; then
    echo "FAIL: $rel removes or changes upstream lines — the allowlist only permits an ADDED header"
    diff -u "$upstream_f" "$f" | head -20
    fail=1
    continue
  fi

  added=$(diff -u "$upstream_f" "$f" | grep '^+[^+]')
  non_comment=$(echo "$added" | grep -v -E '^\+(//|$)')
  if [ -n "$non_comment" ]; then
    echo "FAIL: $rel's added lines are not all comments/blank — looks like more than a header note"
    echo "$non_comment"
    fail=1
    continue
  fi

  echo "OK (header note only): $rel"
done < <(find "$LOCAL_DIR" -type f -name '*.ts' -print0)

if [ "$fail" -eq 0 ]; then
  echo "Provenance check passed: packages/harness/src matches upstream except the §3.5 header notes."
fi

exit $fail
