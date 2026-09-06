#!/usr/bin/env bash
#
# Every pack embedded in a release binary must also be tested and typechecked.
#
# Four independent lists decide a pack's fate and nothing derived them from
# one another:
#
#   scripts/build-packs.ts        PACK_ENTRIES — what is compiled INTO the binary
#   .github/workflows/release.yml               — what is TESTED before a tag ships
#   .github/workflows/ci.yml                    — what is TESTED on every push
#   scripts/typecheck.sh                        — what is TYPECHECKED at all
#
# They drifted twice. The first time, `google-automation-pack` and
# `youtube-automation-pack` reached PACK_ENTRIES and ci.yml but not the
# release workflow, so both would have shipped inside a tagged binary with
# their tests never run on the path that produced it. That is what this script
# was written for, and it only ever compared those two.
#
# The second time was worse and this script could not see it:
# `plugins/instagram-automation-pack` existed, bundled, passed its own tests
# and typechecked cleanly — and appeared in NONE of the four lists. It shipped
# nowhere, ran in no CI job, and was typechecked never; a complete, working
# plugin that no release has ever contained (found 2026-09-06).
#
# So the comparison is against all four now. A pack is either product — in
# every list — or it is not embedded at all.
set -euo pipefail

cd "$(dirname "$0")/.."

# The directory of each entry in PACK_ENTRIES: 'plugins/<dir>/src/index.ts'.
packed=$(grep -oE "'plugins/[^/]+/src/index\.ts'" scripts/build-packs.ts | sed -E "s|'plugins/([^/]+)/src/index\.ts'|\1|" | sort -u)

list_tested() {
  grep -oE "bun run --cwd plugins/[^ ]+ test" "$1" | sed -E 's|bun run --cwd plugins/([^ ]+) test|\1|' | sort -u
}

status=0

# `comm` needs both sides sorted; every producer above ends in `sort -u`.
compare() {
  local label="$1" other="$2" remedy="$3"
  local missing extra
  missing=$(comm -23 <(echo "$packed") <(echo "$other"))
  extra=$(comm -13 <(echo "$packed") <(echo "$other"))
  if [ -n "$missing" ]; then
    echo "error: embedded in the release binary but absent from ${label}:" >&2
    echo "$missing" | sed 's/^/  - plugins\//' >&2
    echo "  ${remedy}" >&2
    status=1
  fi
  if [ -n "$extra" ]; then
    echo "error: listed in ${label} but not embedded in the binary:" >&2
    echo "$extra" | sed 's/^/  - plugins\//' >&2
    echo "  add it to PACK_ENTRIES in scripts/build-packs.ts, or drop it from ${label}" >&2
    status=1
  fi
}

compare ".github/workflows/release.yml" "$(list_tested .github/workflows/release.yml)" \
  "add a 'bun run --cwd plugins/<name> test' step to .github/workflows/release.yml"
compare ".github/workflows/ci.yml" "$(list_tested .github/workflows/ci.yml)" \
  "add a 'bun run --cwd plugins/<name> test' step to EVERY job in .github/workflows/ci.yml"
compare "scripts/typecheck.sh" \
  "$(grep -oE "plugins/[a-z0-9-]+" scripts/typecheck.sh | sed -E 's|plugins/||' | sort -u)" \
  "add plugins/<name> to the 'for dir in' list in scripts/typecheck.sh"

# ci.yml runs the packs in more than one job (check, check-windows). A pack
# tested in only one of them is half-covered, and the union above cannot see
# it — so the per-job counts must agree.
jobs=$(grep -cE "^\s+- run: bun run --cwd plugins/networking test" .github/workflows/ci.yml)
expected=$(( $(echo "$packed" | wc -l | tr -d ' ') * jobs ))
actual=$(grep -cE "^\s+- run: bun run --cwd plugins/[a-z0-9-]+ test" .github/workflows/ci.yml)
if [ "$actual" -ne "$expected" ]; then
  echo "error: ci.yml runs ${actual} pack test steps across ${jobs} job(s); ${expected} expected" >&2
  echo "  every job that tests one pack must test all of them" >&2
  status=1
fi

if [ "$status" -eq 0 ]; then
  echo "  every embedded pack is tested (ci + release) and typechecked ($(echo "$packed" | wc -l | tr -d ' ') packs, ${jobs} ci jobs)"
fi
exit "$status"
