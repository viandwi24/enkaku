import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { DEFAULT_DEVICE_LABEL_STATE, DeviceLabelStateSchema, DeviceSettingsSchema, FarmSettingsSchema, defaultFarmSettings } from '@enkaku/protocol'
import { DEVICE_LABEL_SURFACE } from '../../config/constants'
import { formatDeviceLabel } from '../../registry/device-number'
import type { Check } from '../types'

/** Three answers, not two — a db that will not open is not a farm with no db. */
type LabelledRead = { kind: 'none' } | { kind: 'unreadable'; reason: string } | { kind: 'rows'; rows: LabelledDeviceRow[] }

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
function readLabelledDevices(dataDir: string): LabelledRead {
  const path = join(dataDir, 'enkaku.db')
  if (!existsSync(path)) return { kind: 'none' }
  let sqlite: Database
  try {
    sqlite = new Database(path, { readonly: true, create: false })
  } catch (err) {
    // `skip` on a database that exists and will not open is a false benign
    // state — "nothing to report" and "we could not look" are different
    // sentences, and this check's own doc comment says so about the case it
    // already handled. Same fix as `devices.ts`.
    return { kind: 'unreadable', reason: err instanceof Error ? err.message : String(err) }
  }
  try {
    const farmRow = sqlite.query('SELECT value FROM farm_settings WHERE id = 1').get() as { value: string } | null
    const farmParsed = farmRow ? FarmSettingsSchema.safeParse(JSON.parse(farmRow.value)) : null
    const farmDeviceLabel = farmParsed?.success ? farmParsed.data.general.deviceLabel : defaultFarmSettings().general.deviceLabel

    const rows = sqlite
      .query(
        'SELECT d.label AS label, d.stable_id AS stableId, d.settings AS settings, d.label_state AS labelState, n.number AS number FROM devices d LEFT JOIN device_numbers n ON n.stable_id = d.stable_id',
      )
      .all() as Array<{ label: string; stableId: string; settings: string | null; labelState: string | null; number: number | null }>
    const mapped = rows.map((r) => {
      const settingsParsed = DeviceSettingsSchema.safeParse(r.settings ? JSON.parse(r.settings) : {})
      const content = settingsParsed.success ? (settingsParsed.data.overrides.deviceLabel ?? farmDeviceLabel) : farmDeviceLabel
      const mode: 'off' | 'lock-screen' | 'wallpaper' = content === 'off' ? 'off' : DEVICE_LABEL_SURFACE
      const stateParsed = DeviceLabelStateSchema.safeParse(r.labelState ? JSON.parse(r.labelState) : null)
      const state = stateParsed.success ? stateParsed.data : DEFAULT_DEVICE_LABEL_STATE
      return { display: formatDeviceLabel(r.number, r.label), mode, state: state.state, reason: state.reason }
    })
    return { kind: 'rows', rows: mapped }
  } catch (err) {
    return { kind: 'unreadable', reason: err instanceof Error ? err.message : String(err) }
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
    const read = readLabelledDevices(ctx.dataDir)
    if (read.kind === 'none') {
      return { status: 'skip', observed: 'no local database yet' }
    }
    if (read.kind === 'unreadable') {
      return {
        status: 'warn',
        observed: `enkaku.db is there but could not be read — ${read.reason}`,
        remedy: 'run the db check above for the full diagnosis; labelling has nothing to report until this database opens',
      }
    }
    const rows = read.rows
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
