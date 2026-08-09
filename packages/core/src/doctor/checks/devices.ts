import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import type { Check } from '../types'

/**
 * The registry's last-known view, read directly off `enkaku.db` (plan 85
 * §3.3, §5 step 85.2 — testing H3). Deliberately NOT routed through
 * `DoctorContext.core.probe()`: that surface only exposes an aggregate
 * device count and the quarantined list, never a per-serial view a check
 * could actually diff adb's own truth against, and extending it would mean
 * editing `context.ts`/`types.ts` (owned by a parallel worker on this same
 * plan's step 85.6). Reading the SQLite file directly, read-only, mirrors
 * `context.ts`'s own `inspectDb` — and it works with or without a live
 * core process, which is the whole point of `enkaku doctor` (§4.3, §7:
 * "no check may require real hardware" — no check requires a live PROCESS
 * either).
 *
 * A missing or unreadable database is a legitimate "nothing to compare
 * yet" state (first run, or the `db` check above already owns reporting a
 * corrupt one) — this returns `null`, never throws.
 */
function readRegistrySerials(dataDir: string): Map<string, string> | null {
  const path = join(dataDir, 'enkaku.db')
  if (!existsSync(path)) return null
  let sqlite: Database
  try {
    sqlite = new Database(path, { readonly: true, create: false })
  } catch {
    return null
  }
  try {
    const rows = sqlite.query('SELECT serial, status FROM devices').all() as Array<{ serial: string; status: string | null }>
    return new Map(rows.map((r) => [r.serial, r.status ?? 'offline']))
  } catch {
    return null
  } finally {
    sqlite.close()
  }
}

export const devicesCheck: Check = {
  id: 'devices',
  title: 'Devices',
  async run(ctx) {
    const list = await ctx.devices.list()
    const registry = readRegistrySerials(ctx.dataDir)

    const adbSummary = list.length === 0 ? 'adb: no devices' : `adb: ${list.map((d) => `${d.serial}:${d.state}`).join(', ')}`
    const registrySummary =
      registry === null
        ? 'registry: no local database yet'
        : registry.size === 0
          ? 'registry: no devices enrolled'
          : `registry: ${[...registry.entries()].map(([serial, status]) => `${serial}:${status}`).join(', ')}`
    const observed = `${adbSummary}; ${registrySummary}`

    // Disagreements (plan 85 §3.3, §5 step 85.2 — this is what makes H3
    // falsifiable instead of a guess): adb and the registry's last-known
    // status for the SAME serial pointing opposite directions is exactly
    // the F9/F10 defect this plan fixes. A serial adb sees that the
    // registry has never heard of at all is NOT a disagreement by
    // itself — that is either a brand-new device the tracker has not
    // finished probing yet or one still waiting in the Discovered tray
    // (plan 56), both ordinary states, not a fault.
    const disagreements: string[] = []
    if (registry) {
      for (const d of list) {
        if (d.state === 'device' && registry.get(d.serial) === 'offline') {
          disagreements.push(`${d.serial}: adb sees it connected, the registry still has it marked offline`)
        }
      }
      for (const [serial, status] of registry) {
        if (status !== 'offline' && !list.some((d) => d.serial === serial)) {
          disagreements.push(`${serial}: the registry has it as ${status}, adb does not see it at all`)
        }
      }
    }
    if (disagreements.length > 0) {
      return {
        status: 'fail',
        observed,
        remedy: `${disagreements.join('; ')} — POST /api/devices/rescan (or the Studio Rescan button) reconciles this immediately; otherwise the next discovery.scanIntervalSec pass will`,
      }
    }

    if (list.length === 0) {
      return { status: 'ok', observed: 'no devices seen by adb — connect one over USB and accept the RSA prompt' }
    }
    const bad = list.filter((d) => d.state === 'unauthorized' || d.state === 'offline')
    if (bad.length === 0) {
      return { status: 'ok', observed }
    }
    const remedy = bad
      .map((d) =>
        d.state === 'unauthorized'
          ? `${d.serial} is unauthorized — accept the RSA prompt on the device`
          : `${d.serial} is offline — reconnect the USB cable or the Wi-Fi debugging link`,
      )
      .join('; ')
    return { status: 'warn', observed, remedy }
  },
}
