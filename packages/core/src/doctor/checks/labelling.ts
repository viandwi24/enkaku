import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { DEFAULT_DEVICE_LABEL_STATE, DeviceLabelStateSchema, DeviceSettingsSchema } from '@enkaku/protocol'
import { formatDeviceLabel } from '../../registry/device-number'
import type { Check } from '../types'

interface LabelledDeviceRow {
  display: string
  mode: 'off' | 'lock-screen' | 'wallpaper'
  state: 'off' | 'applied' | 'partial' | 'stale' | 'unavailable' | 'unknown'
  reason: string | null
}

/**
 * Reads `enkaku.db` directly, read-only (plan 89 §4.7, §5 step 89.9) — the
 * SAME pattern `devices.ts`'s own check already uses and for the identical
 * reason: this works with or without a live core process (§4.3, §7: no
 * doctor check may require real hardware, and none here requires a live
 * PROCESS either). Every JSON column is Zod-validated before use (CLAUDE.md
 * — never trust a JSON DB column raw); a corrupt or pre-migration row reads
 * as `mode: 'off'`/`DEFAULT_DEVICE_LABEL_STATE`, the same fallback
 * `labelling.ts`'s own `readCached`/`readDeviceSettings` give an invalid row,
 * never a thrown error that would abort the whole check.
 */
function readLabelledDevices(dataDir: string): LabelledDeviceRow[] | null {
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
        'SELECT d.label AS label, d.stable_id AS stableId, d.settings AS settings, d.label_state AS labelState, n.number AS number FROM devices d LEFT JOIN device_numbers n ON n.stable_id = d.stable_id',
      )
      .all() as Array<{ label: string; stableId: string; settings: string | null; labelState: string | null; number: number | null }>
    return rows.map((r) => {
      const settingsParsed = DeviceSettingsSchema.safeParse(r.settings ? JSON.parse(r.settings) : {})
      const mode = settingsParsed.success ? settingsParsed.data.labelling.mode : 'off'
      const stateParsed = DeviceLabelStateSchema.safeParse(r.labelState ? JSON.parse(r.labelState) : null)
      const state = stateParsed.success ? stateParsed.data : DEFAULT_DEVICE_LABEL_STATE
      return { display: formatDeviceLabel(r.number, r.label), mode, state: state.state, reason: state.reason }
    })
  } catch {
    return null
  } finally {
    sqlite.close()
  }
}

/**
 * Physical labelling (plan 89 §4.7): a diagnostic snapshot off the LAST
 * KNOWN `labelState` each device wrote — never a live probe (that is
 * `LabellingService.status`'s own job, reached through the HTTP endpoints,
 * not doctor). `skip` when no device has labelling enabled (`mode !== 'off'`)
 * — never a false `ok`, the rule this check exists to keep honest: a farm
 * that never opted in has nothing to report, which is a different statement
 * from "everything is fine."
 */
export const labellingCheck: Check = {
  id: 'labelling',
  title: 'Labelling',
  async run(ctx) {
    const rows = readLabelledDevices(ctx.dataDir)
    if (rows === null) {
      return { status: 'skip', observed: 'no local database yet' }
    }
    const enabled = rows.filter((r) => r.mode !== 'off')
    if (enabled.length === 0) {
      return { status: 'skip', observed: 'no device has physical labelling enabled' }
    }

    const applied = enabled.filter((r) => r.state === 'applied')
    const partial = enabled.filter((r) => r.state === 'partial')
    const stale = enabled.filter((r) => r.state === 'stale')
    const unavailable = enabled.filter((r) => r.state === 'unavailable')

    const parts = [`${applied.length} of ${enabled.length} labelled`]
    if (stale.length > 0) parts.push(`${stale.length} stale`)
    if (partial.length > 0) parts.push(`${partial.length} partial`)
    if (unavailable.length > 0) {
      const first = unavailable[0]!
      parts.push(`${unavailable.length} unavailable (${first.reason ?? 'no reason recorded'} on ${first.display})`)
    }
    const observed = parts.join(' · ')

    const trouble = [...partial, ...stale, ...unavailable]
    if (trouble.length === 0) {
      return { status: 'ok', observed }
    }
    return {
      status: 'warn',
      observed,
      remedy: `run 'Apply labels' on the devices page (or POST /api/devices/labels/apply) to re-push ${trouble.length} device${trouble.length === 1 ? '' : 's'} — ${trouble.map((r) => r.display).join(', ')}`,
    }
  },
}
