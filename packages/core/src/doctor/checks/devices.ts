import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { formatDeviceLabel } from '../../registry/device-number'
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
interface RegistryDeviceRow {
  status: string
  /** Plan 89 §1, §5 step 89.4 — the number the rack itself carries, joined in below. `null` for a device with no reservation (a real state, never an error). */
  display: string
}

/**
 * Joins `device_numbers` in the same read (plan 89 §5 step 89.4) — a LEFT
 * JOIN, since a numberless device (an explicit release, §3.2) is a real
 * state this check must still show, never a row this query silently drops.
 */
function readRegistrySerials(dataDir: string): Map<string, RegistryDeviceRow> | null {
  const path = join(dataDir, 'enkaku.db')
  if (!existsSync(path)) return null
  let sqlite: Database
  try {
    sqlite = new Database(path, { readonly: true, create: false })
  } catch {
    return null
  }
  try {
    const rows = sqlite
      .query(
        'SELECT d.serial AS serial, d.status AS status, d.label AS label, n.number AS number FROM devices d LEFT JOIN device_numbers n ON n.stable_id = d.stable_id',
      )
      .all() as Array<{ serial: string; status: string | null; label: string; number: number | null }>
    return new Map(rows.map((r) => [r.serial, { status: r.status ?? 'offline', display: formatDeviceLabel(r.number, r.label) }]))
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
          : `registry: ${[...registry.entries()].map(([serial, r]) => `${r.display} (${serial}):${r.status}`).join(', ')}`
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
        const r = registry.get(d.serial)
        if (d.state === 'device' && r?.status === 'offline') {
          disagreements.push(`${r.display} (${d.serial}): adb sees it connected, the registry still has it marked offline`)
        }
      }
      for (const [serial, r] of registry) {
        if (r.status !== 'offline' && !list.some((d) => d.serial === serial)) {
          disagreements.push(`${r.display} (${serial}): the registry has it as ${r.status}, adb does not see it at all`)
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
