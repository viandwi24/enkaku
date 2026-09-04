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
for dir in packages/protocol packages/expr packages/ui packages/adb packages/toolchain packages/drivers packages/scrcpy packages/sdk \
           packages/session packages/harness packages/core packages/node packages/studio packages/probe-server \
           plugins/networking plugins/proxy-manager plugins/tiktok-automation-pack plugins/mikrotik-routing \
           plugins/google-automation-pack plugins/youtube-automation-pack \
           examples; do
  p="${dir##*/}"
  printf '%-10s ' "$p"
  if bunx tsc --noEmit -p "$dir" >/tmp/tc-$p.log 2>&1; then
    echo "OK"
  else
    echo "FAILED"
    # Show every error, not just the first few — a truncated view here once
    # cost this project hours (a 9-error package reported as 4, because this
    # script silently cut the tail). If the log is genuinely enormous, keep
    # it readable but SAY how many lines were hidden rather than cutting
    # silently.
    total=$(wc -l < "/tmp/tc-$p.log" | tr -d ' ')
    limit=500
    if [ "$total" -gt "$limit" ]; then
      sed 's/^/    /' "/tmp/tc-$p.log" | head -"$limit"
      echo "    ... ($((total - limit)) more lines hidden — see /tmp/tc-$p.log for the full output)"
    else
      sed 's/^/    /' "/tmp/tc-$p.log"
    fi
    fail=1
  fi
done
exit $fail
