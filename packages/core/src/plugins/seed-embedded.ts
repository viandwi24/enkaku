import { join } from 'node:path'
import { compareSemver } from '@enkaku/protocol'
import type { EmbeddedPack } from '../embedded'
import type { Logger } from '../util/logger'
import type { PluginRuntime } from './runtime'

/**
 * Seed the example plugin packs carried inside a compiled binary (§3.7's normal
 * stage → verify path, just with the bundle coming from the executable instead
 * of an HTTP body).
 *
 * Two deliberate limits:
 *
 * - **Staged, never activated.** Activation writes `scripts` rows and puts
 *   `tiktok/auto-scroll` in front of every operator on the farm. That is a
 *   choice the operator makes with one click on the Plugins page, not one a
 *   fresh install makes for them.
 * - **Seeded once, by `name@version`.** A record of what has been seeded lives
 *   next to the database, so removing a pack is permanent: without it, the next
 *   boot would find no `plugins` row and helpfully resurrect what the operator
 *   had just deleted. A pack whose version changed in a core upgrade is a new
 *   key, so it does arrive as a new staged version — which is the point.
 *
 * Failure here is never fatal: a pack that will not verify leaves a `failed`
 * row and a log line, and the farm carries on. Nothing about a device, a job,
 * or a session depends on it.
 */
export async function seedEmbeddedPacks(opts: {
  runtime: PluginRuntime
  packs: EmbeddedPack[]
  dataDir: string
  log: Logger
}): Promise<void> {
  const { runtime, packs, dataDir, log } = opts
  if (packs.length === 0) return

  const markerPath = join(dataDir, 'seeded-packs.json')
  const seeded = new Set(await readMarker(markerPath, log))

  for (const pack of packs) {
    const key = `${pack.name}@${pack.version}`
    if (seeded.has(key)) continue
    // Belt and braces: a marker lost to a half-restored data dir must not turn
    // into a duplicate-name crash — `stage` rejects an existing (name, version).
    if (runtime.get(pack.name, pack.version)) {
      seeded.add(key)
      continue
    }

    try {
      const bundle = await Bun.file(pack.path).text()
      // A tier-C pack's screen rides along (plan 111 step 111.7). `stage`
      // writes them through the same asset store a `.enkaku` upload uses, and
      // it does so BEFORE inserting the row — so a version that exists is a
      // version whose `ui/index.js` exists. Empty for every tier-A pack, which
      // stages exactly as it did before.
      const ui = await Promise.all((pack.ui ?? []).map(async (asset) => ({ path: asset.name, data: await Bun.file(asset.path).bytes() })))
      const row = await runtime.stage({ name: pack.name, version: pack.version, bundle, source: 'bundled', ui })
      const report = await runtime.verify(row.id)
      if (report.ok) {
        log.info(`seeded ${key} (staged — activate it on the Plugins page)`)
      } else {
        log.warn(`seeded ${key} but it failed verification: ${report.error ?? 'unknown error'}`)
      }
      // Recorded either way: a pack that fails to verify is a `failed` row the
      // operator can see and remove, not something to retry on every boot.
      seeded.add(key)
    } catch (err) {
      log.warn(`could not seed ${key}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  await writeMarker(markerPath, [...seeded], log)
  warnStaleActive({ runtime, packs, log })
}

/**
 * Say out loud when the farm is RUNNING an older version of a pack than the
 * one this binary ships.
 *
 * The two limits above are both deliberate and neither is going away, but
 * together they have a consequence nothing used to state: seeding is keyed on
 * `name@version`, so a core upgrade does bring the new version in — and it
 * brings it in `staged`, so the farm keeps serving the OLD one until somebody
 * clicks. That is correct for a fresh install and silent for an upgrade, and
 * the silence is what cost the owner an afternoon: Studio moved
 * `@enkaku/host`'s only export in plan 216, mikrotik-routing 0.14.0 followed
 * the same day, and a farm still running 0.13.0 answered the routing screen
 * with `does not provide an export named 'DeviceWallWithPicker'` — three
 * staged versions later, with nothing anywhere saying so.
 *
 * A log line, and deliberately nothing more. Activating for the operator is
 * the one thing this file must not do: activation writes `scripts` rows and
 * decides what `@latest` resolves to for every queued job on the farm, which
 * is the operator's call — the same call the "staged, never activated" limit
 * exists to protect. What was missing was never the click, it was knowing the
 * click was owed. Studio says the same thing where an operator is actually
 * looking (`app/plugins/page.tsx`'s staged pill, and the failing view's own
 * panel); this is the half a headless farm's logs can carry.
 *
 * `source === 'bundled'` only. A version an operator uploaded themselves is
 * their build and their choice of when to move off it, and a farm pinned to a
 * fork does not need a line every boot telling it so.
 */
function warnStaleActive(opts: { runtime: PluginRuntime; packs: EmbeddedPack[]; log: Logger }): void {
  const { runtime, packs, log } = opts
  for (const pack of packs) {
    const active = runtime.active(pack.name)
    if (!active || active.source !== 'bundled') continue
    if (compareSemver(pack.version, active.version) <= 0) continue
    log.warn(
      `${pack.name} is ACTIVE at ${active.version}, but this build ships ${pack.version} — the newer version is staged, not active, so nothing is using it. Activate it on the Plugins page.`,
    )
  }
}

async function readMarker(path: string, log: Logger): Promise<string[]> {
  const file = Bun.file(path)
  if (!(await file.exists())) return []
  try {
    const parsed: unknown = JSON.parse(await file.text())
    if (!Array.isArray(parsed)) throw new Error('not an array')
    return parsed.filter((v): v is string => typeof v === 'string')
  } catch (err) {
    // A corrupt marker must not resurrect deleted packs, so treat it as
    // "everything already seeded" is wrong too — the safest reading is empty,
    // and the `runtime.get` guard above still prevents a duplicate.
    log.warn(`ignoring an unreadable ${path}: ${err instanceof Error ? err.message : String(err)}`)
    return []
  }
}

async function writeMarker(path: string, keys: string[], log: Logger): Promise<void> {
  try {
    await Bun.write(path, `${JSON.stringify(keys.sort(), null, 2)}\n`)
  } catch (err) {
    log.warn(`could not record seeded packs in ${path}: ${err instanceof Error ? err.message : String(err)}`)
  }
}
