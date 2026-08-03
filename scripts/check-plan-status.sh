#!/usr/bin/env bash
# Compare each plan's declared status against whether its code actually exists.
#
# The plan documents are the contract an AI agent builder reads to decide what
# to work on next. When a shipped plan still says `draft`, an agent told to
# "work the plans in order" re-implements finished work; when an unstarted one
# claims to be implemented, it gets skipped. Both happened in this repo — six
# of eight plans checked by hand were shipped while still marked draft — so
# the drift is not hypothetical and no one notices it by reading.
#
# A plan opts in by declaring the artefact that proves it shipped:
#
#   > Status: implemented — ...
#   > Ships: packages/core/src/events/recorder.ts
#
# Plans with no `Ships:` line are skipped and counted, not guessed at.
#
# Exits non-zero when anything disagrees, so it can gate a release.
set -uo pipefail
cd "$(dirname "$0")/.."

mismatch=0
skipped=0

for plan in docs/plans/*.md; do
  ships=$(grep -m1 '^> Ships: ' "$plan" | sed 's/^> Ships: //' | tr -d '\r')
  if [ -z "$ships" ]; then
    skipped=$((skipped + 1))
    continue
  fi

  status=$(grep -m1 '^> Status: ' "$plan" | sed 's/^> Status: //' | tr -d '\r')
  claims_shipped=false
  case "$status" in
    implemented*) claims_shipped=true ;;
  esac

  if [ -e "$ships" ]; then exists=true; else exists=false; fi

  if [ "$claims_shipped" != "$exists" ]; then
    mismatch=$((mismatch + 1))
    if [ "$exists" = true ]; then
      printf '  MISMATCH %-46s says "%s" but %s exists\n' "$(basename "$plan")" "${status:0:24}" "$ships"
    else
      printf '  MISMATCH %-46s claims implemented but %s is missing\n' "$(basename "$plan")" "$ships"
    fi
  fi
done

total=$(ls docs/plans/*.md | wc -l | tr -d ' ')
checked=$((total - skipped))
echo "  checked $checked of $total plans ($skipped declare no Ships: artefact)"

if [ "$mismatch" -gt 0 ]; then
  echo "  $mismatch plan(s) disagree with the code — fix the status line or the code"
  exit 1
fi
echo "  every plan that declares an artefact agrees with the code"
