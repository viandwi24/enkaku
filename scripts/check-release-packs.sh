#!/usr/bin/env bash
#
# Every pack embedded in a release binary must have its own tests run on the
# release path.
#
# `scripts/build-packs.ts`'s `PACK_ENTRIES` decides what gets compiled INTO the
# binary; `.github/workflows/release.yml` decides what gets TESTED before that
# binary is published. Nothing connected the two, and they drifted the first
# time a pack was added: `google-automation-pack` and `youtube-automation-pack`
# reached `PACK_ENTRIES` and `ci.yml` but not the release workflow, so both
# would have shipped inside a tagged binary with their tests never run on the
# path that produces it.
#
# Compares the two lists by directory name and fails naming the difference.
set -euo pipefail

cd "$(dirname "$0")/.."

# The directory of each entry in PACK_ENTRIES: 'plugins/<dir>/src/index.ts'.
packed=$(grep -oE "'plugins/[^/]+/src/index\.ts'" scripts/build-packs.ts | sed -E "s|'plugins/([^/]+)/src/index\.ts'|\1|" | sort -u)

# The directory of each pack test step in the release workflow.
tested=$(grep -oE 'bun run --cwd plugins/[^ ]+ test' .github/workflows/release.yml | sed -E 's|bun run --cwd plugins/([^ ]+) test|\1|' | sort -u)

missing=$(comm -23 <(echo "$packed") <(echo "$tested"))
extra=$(comm -13 <(echo "$packed") <(echo "$tested"))

status=0
if [ -n "$missing" ]; then
  echo "error: embedded in the release binary but never tested by release.yml:" >&2
  echo "$missing" | sed 's/^/  - plugins\//' >&2
  echo "  add a 'bun run --cwd plugins/<name> test' step to .github/workflows/release.yml" >&2
  status=1
fi
if [ -n "$extra" ]; then
  echo "error: tested by release.yml but not embedded in the binary:" >&2
  echo "$extra" | sed 's/^/  - plugins\//' >&2
  echo "  add it to PACK_ENTRIES in scripts/build-packs.ts, or drop the test step" >&2
  status=1
fi

if [ "$status" -eq 0 ]; then
  echo "  every embedded pack is tested on the release path ($(echo "$packed" | wc -l | tr -d ' ') packs)"
fi
exit "$status"
