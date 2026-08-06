#!/usr/bin/env bash
# Typecheck the whole workspace. Exits non-zero if anything fails,
# so it can be dropped into CI as-is.
set -uo pipefail
cd "$(dirname "$0")/.."
fail=0
for p in protocol adb toolchain drivers scrcpy sdk session harness core node studio probe-server; do
  printf '%-10s ' "$p"
  if bunx tsc --noEmit -p "packages/$p" >/tmp/tc-$p.log 2>&1; then
    echo "OK"
  else
    echo "FAILED"
    sed 's/^/    /' "/tmp/tc-$p.log" | head -10
    fail=1
  fi
done
exit $fail
