#!/usr/bin/env bash
# Typecheck the whole workspace. Exits non-zero if anything fails,
# so it can be dropped into CI as-is.
set -uo pipefail
cd "$(dirname "$0")/.."
fail=0
# Paths, not bare names. Two authoring surfaces sit outside `packages/` and are
# typechecked with everything else rather than left to rot:
#   plugins/*  — the packs SHIPPED inside the release binary. Product, not demos.
#   examples/  — demonstration scripts an author copies from.
# The packs moved out of `examples/` once they became something a release
# embeds: a broken example is a bad afternoon, a broken shipped pack is a bad
# release, and the two do not deserve the same level of scrutiny by accident.
for dir in packages/protocol packages/adb packages/toolchain packages/drivers packages/scrcpy packages/sdk \
           packages/session packages/harness packages/core packages/node packages/studio packages/probe-server \
           plugins/networking plugins/tiktok-automation-pack \
           examples; do
  p="${dir##*/}"
  printf '%-10s ' "$p"
  if bunx tsc --noEmit -p "$dir" >/tmp/tc-$p.log 2>&1; then
    echo "OK"
  else
    echo "FAILED"
    sed 's/^/    /' "/tmp/tc-$p.log" | head -10
    fail=1
  fi
done
exit $fail
