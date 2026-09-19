#!/usr/bin/env bun
/**
 * A plugin whose source changed since the last release, at the same version number, is a plugin
 * whose change will never reach a farm.
 *
 * ## Why this gate exists
 *
 * Embedded packs are seeded ONCE, keyed on `${name}@${version}`, with the record kept in
 * `<dataDir>/seeded-packs.json` (`packages/core/src/plugins/seed-embedded.ts`). A version already
 * in that file is skipped entirely on every later boot. So when two different builds share one
 * version, the second one is never loaded on any farm that has already run the first: the change
 * sits in the repo, fully tested, green in CI, and never once reaches a phone.
 *
 * This is not hypothetical and it is not rare. Plan 124 rebuilt two plugin UIs without renumbering
 * them and every fix in them was dormant until a field report found it. It happened again on
 * 2026-09-18: `v0.2.61` was tagged in the middle of an investigation and shipped `instagram@0.12.0`
 * and `youtube@0.43.0`, and the root-cause fixes that landed hours later kept those same numbers.
 * That was caught by hand, while checking something else. The next one would not have been.
 *
 * Nothing else in CI can see this. `bun test` passes, `typecheck` passes, `check-release-packs.sh`
 * confirms every pack is built and tested — all true, and all silent about whether the built pack
 * will ever be loaded.
 *
 * ## What it checks
 *
 * For each plugin: if anything under `src/` changed between the last `v*` tag and HEAD, the version
 * in `package.json` must have changed too.
 *
 * Tests and fixtures are excluded, because `build-packs` bundles from `src/index.ts` and a
 * `*.test.ts` never enters the artifact. A test-only change genuinely ships nothing and must not be
 * made to look like it does — a gate that cries wolf is a gate people learn to re-run until it goes
 * green.
 *
 * ## When it stays quiet
 *
 * With no `v*` tag reachable (a shallow clone, or a fork with no tags fetched) there is nothing to
 * compare against, so it says so and exits 0. A check that fails when it cannot see is worse than
 * no check: it teaches everyone to ignore it.
 *
 * Usage: `bun scripts/check-pack-versions.ts [tag] [head]`. Both arguments exist so this script can
 * be pointed at a known-bad point in history and shown to catch it — a gate nobody has watched fail
 * is a gate nobody knows works. `bun scripts/check-pack-versions.ts v0.2.61 ce17d4bc` reproduces
 * the 2026-09-18 collision described above.
 */
import { readdirSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const PLUGINS_DIR = 'plugins'

function git(args: string[]): { ok: boolean; out: string } {
  const proc = Bun.spawnSync(['git', ...args])
  return { ok: proc.exitCode === 0, out: new TextDecoder().decode(proc.stdout).trim() }
}

function versionAt(ref: string, name: string): string | null {
  const shown = git(['show', `${ref}:${PLUGINS_DIR}/${name}/package.json`])
  if (!shown.ok) return null
  try {
    const parsed = JSON.parse(shown.out) as { version?: unknown }
    return typeof parsed.version === 'string' ? parsed.version : null
  } catch {
    return null
  }
}

function currentVersion(name: string): string | null {
  // Read from the worktree for the ordinary run, and from git for a historical one, so the same
  // comparison works either way.
  if (head !== 'HEAD') return versionAt(head, name)
  const path = join(PLUGINS_DIR, name, 'package.json')
  if (!existsSync(path)) return null
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { version?: unknown }
    return typeof parsed.version === 'string' ? parsed.version : null
  } catch {
    return null
  }
}

/**
 * Files under `src/` that actually ship, changed between the two refs.
 *
 * Filtered HERE rather than with git's `:(exclude)` pathspecs, which is how this was first written
 * and which silently did not work. The excluding pattern required a directory between `src` and the
 * file, so a test sitting directly in `src` — `readings.test.ts` — was never excluded, and a
 * test-only commit was reported as a missing version bump. Git's glob rules are subtle enough that
 * a wrong pattern looks exactly like a right one until something trips it. A plain list and an
 * explicit filter cannot fail that way.
 */
function shippingFilesChanged(ref: string, head: string, name: string): string[] {
  const base = `${PLUGINS_DIR}/${name}/src`
  const diff = git(['diff', '--name-only', `${ref}..${head}`, '--', base])
  if (!diff.ok || diff.out === '') return []
  return diff.out
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .filter((line) => !/\.test\.tsx?$/.test(line))
    .filter((line) => !line.includes('/__fixtures__/'))
    .filter((line) => !/\.type-test\.tsx?$/.test(line))
}

const tag = Bun.argv[2] ?? git(['describe', '--tags', '--abbrev=0', '--match', 'v*']).out
const head = Bun.argv[3] ?? 'HEAD'

if (!tag) {
  console.log('  no v* tag is reachable — nothing to compare against, so nothing is checked')
  process.exit(0)
}

const names = readdirSync(PLUGINS_DIR, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(join(PLUGINS_DIR, entry.name, 'package.json')))
  .map((entry) => entry.name)
  .sort()

const stale: { name: string; version: string; files: number }[] = []
let compared = 0

for (const name of names) {
  const released = versionAt(tag, name)
  // A plugin that did not exist at that tag has nothing to collide with.
  if (released === null) continue
  const now = currentVersion(name)
  if (now === null) continue
  compared += 1
  const changed = shippingFilesChanged(tag, head, name)
  if (changed.length === 0) continue
  if (now !== released) continue
  stale.push({ name, version: now, files: changed.length })
}

if (stale.length > 0) {
  console.error(`\ncheck-pack-versions: ${stale.length} plugin(s) changed since ${tag} without a new version.\n`)
  for (const entry of stale) {
    console.error(`  ${entry.name}@${entry.version} — ${entry.files} file(s) changed under src/ since ${tag}, version unchanged`)
  }
  console.error(
    [
      '',
      'A farm that already seeded this version will SKIP the new build for ever, so these changes',
      'would never reach a phone. Bump all three sites together:',
      '',
      '  plugins/<name>/package.json      "version"',
      '  plugins/<name>/src/index.ts      version:',
      '  plugins/<name>/src/index.test.ts the assertion',
      '',
      'then add the reason to the changelog block in src/index.ts and run `bun run build:packs`.',
      'Minor for anything an operator meets; patch only for something genuinely invisible.',
      '',
    ].join('\n'),
  )
  process.exit(1)
}

console.log(`  every plugin changed since ${tag} carries a new version (${compared} compared)`)
