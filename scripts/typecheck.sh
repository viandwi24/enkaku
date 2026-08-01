#!/usr/bin/env bash
# Typecheck seluruh workspace. Keluar dengan kode != 0 bila ada yang gagal,
# supaya bisa dipakai di CI apa adanya.
set -uo pipefail
cd "$(dirname "$0")/.."
fail=0
for p in protocol adb toolchain drivers scrcpy sdk session core agent studio; do
  printf '%-10s ' "$p"
  if bunx tsc --noEmit -p "packages/$p" >/tmp/tc-$p.log 2>&1; then
    echo "OK"
  else
    echo "GAGAL"
    sed 's/^/    /' "/tmp/tc-$p.log" | head -10
    fail=1
  fi
done
exit $fail
