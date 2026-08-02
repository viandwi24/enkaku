#!/usr/bin/env bash
# One-command release: bump the core version, tag, push — GitHub Actions
# (.github/workflows/release.yml) then builds all platforms, smoke tests them
# on Linux/macOS/Windows, and publishes the GitHub Release by itself.
#
# Usage: bash scripts/tag-release.sh v0.2.0
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION="${1:?usage: bash scripts/tag-release.sh vX.Y.Z}"
[[ "$VERSION" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || {
  echo "version must look like vX.Y.Z (got: $VERSION)"
  exit 1
}
git diff --quiet && git diff --cached --quiet || {
  echo "working tree is not clean — commit or stash first"
  exit 1
}
git rev-parse "$VERSION" >/dev/null 2>&1 && {
  echo "tag $VERSION already exists"
  exit 1
}

echo "==> Typecheck"
bun run typecheck

echo "==> Bumping enkaku-core to ${VERSION#v}"
bun -e '
  const file = "packages/core/package.json"
  const pkg = await Bun.file(file).json()
  pkg.version = process.argv[1]
  await Bun.write(file, JSON.stringify(pkg, null, 2) + "\n")
' "${VERSION#v}"

git add packages/core/package.json
git commit -m "chore(release): $VERSION"
git tag -a "$VERSION" -m "$VERSION"
git push origin HEAD "$VERSION"

echo "Done. Watch the release workflow: gh run watch (or the Actions tab)."
