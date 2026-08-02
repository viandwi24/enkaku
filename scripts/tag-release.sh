#!/usr/bin/env bash
# One-command release: bump the core version, tag, push — GitHub Actions
# (.github/workflows/release.yml) then builds all platforms, smoke tests them
# on Linux/macOS/Windows, and publishes the GitHub Release by itself.
#
# Usage:
#   bash scripts/tag-release.sh patch    # v0.1.3 -> v0.1.4 (bug fixes)
#   bash scripts/tag-release.sh minor    # v0.1.3 -> v0.2.0 (new features)
#   bash scripts/tag-release.sh major    # v0.1.3 -> v1.0.0 (breaking changes)
#   bash scripts/tag-release.sh v2.0.0   # explicit version
#
# The current version is read from the latest v* tag (fallback: the version in
# packages/core/package.json), so you never need to know it beforehand.
set -euo pipefail
cd "$(dirname "$0")/.."

BUMP="${1:?usage: bash scripts/tag-release.sh patch|minor|major|vX.Y.Z}"

git diff --quiet && git diff --cached --quiet || {
  echo "working tree is not clean — commit or stash first"
  exit 1
}

current="$(git describe --tags --abbrev=0 --match 'v*' 2>/dev/null || true)"
if [ -z "$current" ]; then
  current="v$(bun -e 'console.log((await Bun.file("packages/core/package.json").json()).version)')"
  echo "no release tag yet — starting from package.json: $current"
fi
IFS=. read -r MAJOR MINOR PATCH <<< "${current#v}"

case "$BUMP" in
  patch) VERSION="v$MAJOR.$MINOR.$((PATCH + 1))" ;;
  minor) VERSION="v$MAJOR.$((MINOR + 1)).0" ;;
  major) VERSION="v$((MAJOR + 1)).0.0" ;;
  v[0-9]*.[0-9]*.[0-9]*)
    [[ "$BUMP" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "explicit version must be vX.Y.Z"; exit 1; }
    VERSION="$BUMP"
    ;;
  *) echo "unknown bump '$BUMP' — use patch, minor, major, or vX.Y.Z"; exit 1 ;;
esac

git rev-parse "$VERSION" >/dev/null 2>&1 && {
  echo "tag $VERSION already exists"
  exit 1
}

echo "==> Release $current -> $VERSION"

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
