import { eq } from 'drizzle-orm'
import { compareSemver, isPrereleaseVersion, parseScriptRef, type ScriptRef } from '@enkaku/protocol'
import type { Db } from '../db'
import { scripts, type ScriptRow } from '../db/schema'
import { EnkakuError } from '../util/errors'

/**
 * Resolves a `name@version` (or `name@latest`) reference to a concrete
 * `scripts` row (plan 62 §4.2). `@latest` is the highest semver among
 * ENABLED, NON-PRERELEASE versions — deliberately not the most recently
 * published, because a hotfix onto an old line publishes later while sorting
 * lower (plan 62 §3.2).
 *
 * Four distinguishable failures, because "it did not run" is not an adequate
 * answer to why:
 * - `script_not_found` — no script by that name at all.
 * - `script_version_not_found` — the name exists, that exact version does
 *   not; the message lists the versions that do.
 * - `script_ref_unresolved` — `@latest` on a script with only prereleases or
 *   only disabled versions. Never silently falls back to a prerelease.
 * - `script_disabled` — the resolved concrete version exists but is disabled.
 */
export function resolveScriptRef(db: Db, ref: ScriptRef): ScriptRow {
  const { name, version } = parseScriptRef(ref)
  const versions = db.select().from(scripts).where(eq(scripts.name, name)).all()
  if (versions.length === 0) {
    throw new EnkakuError('script_not_found', `no script named "${name}"`)
  }

  if (version === 'latest') {
    const candidates = versions.filter((v) => (v.enabled ?? true) && !isPrereleaseVersion(v.version))
    if (candidates.length === 0) {
      const published = versions.map((v) => v.version).join(', ')
      throw new EnkakuError(
        'script_ref_unresolved',
        `"${name}@latest" has no resolvable version — published versions: ${published}`,
      )
    }
    // Highest semver first (plan 62 §3.2) — never publish order.
    candidates.sort((a, b) => compareSemver(b.version, a.version))
    return candidates[0] as ScriptRow
  }

  const row = versions.find((v) => v.version === version)
  if (!row) {
    const published = versions.map((v) => v.version).join(', ')
    throw new EnkakuError('script_version_not_found', `${name}@${version} does not exist — published versions: ${published}`)
  }
  if (!(row.enabled ?? true)) {
    throw new EnkakuError('script_disabled', `${name}@${version} is disabled`)
  }
  return row
}
