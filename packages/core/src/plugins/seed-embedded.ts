import { join } from 'node:path'
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
