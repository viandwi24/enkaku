import { DeviceSettingsSchema, type DeviceSettings, type DeviceSettingsPatch, type RotationApplyResult } from '@enkaku/protocol'
import { eq } from 'drizzle-orm'
import type { Db } from '../../db'
import { devices } from '../../db/schema'
import { EnkakuError } from '../../util/errors'
import type { SessionManager } from '@enkaku/session'

/**
 * The `settings` verb's merge (plan 207 §4.2, §8 risk table). `rawPatch` is
 * the WIRE object (pre-Zod), `parsedPatch` its `DeviceSettingsPatchSchema`-
 * validated counterpart. Both are needed: Zod fills in each block's own
 * per-field defaults for a key the caller never sent (verified against this
 * Zod version, 2026-09-04 — `z.object({...}).partial()` does not leave an
 * absent nested key `undefined` the way a flat `.partial()` does when the
 * PARENT key is present but a child key is not), so using the parsed patch
 * alone to decide "what changed" would silently reset every sibling field in
 * a block the operator only partly touched — the exact hazard `devices.ts`'s
 * old `POST /prep/apply` avoided with five explicit `if` checks. Reading
 * "which keys were sent" off `rawPatch` and the VALUES off `parsedPatch`
 * keeps both: a wrong type at any leaf still fails validation, and a field
 * the caller did not mention is never touched.
 */
export function mergeSettingsPatch(
  current: DeviceSettings,
  rawPatch: Record<string, unknown>,
  parsedPatch: DeviceSettingsPatch,
): { next: DeviceSettings; changed: string[] } {
  const next: Record<string, unknown> = { ...(current as unknown as Record<string, unknown>) }
  const changed: string[] = []
  for (const blockKey of Object.keys(rawPatch)) {
    const rawBlock = rawPatch[blockKey]
    const parsedBlock = (parsedPatch as Record<string, unknown>)[blockKey]
    if (rawBlock && typeof rawBlock === 'object' && !Array.isArray(rawBlock) && parsedBlock && typeof parsedBlock === 'object') {
      const merged: Record<string, unknown> = { ...(next[blockKey] as Record<string, unknown> | undefined) }
      for (const fieldKey of Object.keys(rawBlock as Record<string, unknown>)) {
        merged[fieldKey] = (parsedBlock as Record<string, unknown>)[fieldKey]
        changed.push(`${blockKey}.${fieldKey}`)
      }
      next[blockKey] = merged
    } else {
      next[blockKey] = parsedBlock
      changed.push(blockKey)
    }
  }
  return { next: DeviceSettingsSchema.parse(next), changed }
}

export interface SettingsResult {
  changed: string[]
  rotation: RotationApplyResult | null
}

/**
 * `settings` (plan 207 §4.2) — read the row, merge the patch, write, record
 * `settings.changed`; when `prep.rotation` is in the patch, the live re-lock
 * of `devices.ts:800-830` (skipped with `state: 'busy'` when a job activity
 * is live); when any `video` key is in the patch, the session restart of
 * `devices.ts:1236-1240` unless a job activity is live.
 */
export async function applySettings(
  deps: {
    db: Db
    record?: (e: { deviceId: string; stream: 'main'; kind: string; actor: string | null; meta: Record<string, unknown> }) => void
    runningJobOf: (deviceId: string) => boolean
    sessions: () => Pick<SessionManager, 'get' | 'restartAt' | 'setRotation'> | null
  },
  deviceId: string,
  rawPatch: Record<string, unknown>,
  parsedPatch: DeviceSettingsPatch,
  actor: string | null,
): Promise<SettingsResult> {
  const row = deps.db.select().from(devices).where(eq(devices.id, deviceId)).get()
  if (!row) throw new EnkakuError('device_not_found', `no such device: ${deviceId}`)
  const current = DeviceSettingsSchema.safeParse(row.settings ?? {})
  if (!current.success) {
    throw new EnkakuError(
      'E_SETTINGS_UNREADABLE',
      `this device's stored settings do not parse, so they cannot be merged into (${current.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')})`,
    )
  }
  const { next, changed } = mergeSettingsPatch(current.data, rawPatch, parsedPatch)
  if (changed.length > 0) {
    deps.db
      .update(devices)
      .set({
        settings: next,
        transport: next.engines.transport,
        display: next.engines.display,
        input: next.engines.input,
        inspection: next.engines.inspection,
      })
      .where(eq(devices.id, deviceId))
      .run()
    deps.record?.({ deviceId, stream: 'main', kind: 'settings.changed', actor, meta: { keys: changed, source: 'bulk' } })
  }

  let rotation: RotationApplyResult | null = null
  if (rawPatch.prep && typeof rawPatch.prep === 'object' && 'rotation' in (rawPatch.prep as Record<string, unknown>)) {
    const mode = next.prep.rotation
    if (deps.runningJobOf(deviceId)) {
      rotation = { mode, state: 'busy', reason: 'a job is running on this device — the new rotation applies to its next session' }
    } else {
      const outcome = (await deps.sessions()?.setRotation?.(deviceId, mode)) ?? null
      if (!outcome) rotation = { mode, state: 'no-session' }
      else if (outcome.applied) rotation = { mode, state: 'applied' }
      else rotation = { mode, state: 'failed', ...(outcome.reason ? { reason: outcome.reason } : {}) }
    }
  }
  if (changed.some((k) => k.startsWith('video.')) && !deps.runningJobOf(deviceId)) {
    const sessionsApi = deps.sessions()
    const current2 = sessionsApi?.get(deviceId)
    if (current2) void sessionsApi?.restartAt?.(deviceId, current2.quality, 'applying new video settings')
  }
  return { changed, rotation }
}
