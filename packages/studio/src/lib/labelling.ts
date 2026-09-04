import { z } from 'zod'
import { DeviceDetailResponseSchema, DeviceLabelStateSchema, DeviceResponseSchema, type ActionResult, type DeviceLabelState } from '@enkaku/protocol'
import { api } from '@enkaku/ui'
import { runOnDevice } from '@/lib/actions'
import type { NamedOutcome } from '@/components/bulk/SkippedGroups'
import type { OutcomeCounts } from '@/components/bulk/OutcomeSummary'

/**
 * The two client-side halves of plan 124 §3.5/§4.6's one-click "Set number as
 * wallpaper", plus the one way a `POST /api/devices/labels/apply` report is
 * turned into `OutcomeSummary`/`SkippedGroups` rows.
 *
 * This is a `lib/` module for the same reason `lib/readiness.ts` is one: the
 * SAME sequence is fired from two unrelated surfaces — the device popup's
 * `ActionsList` row (one device, or the popup's whole candidate set) and the
 * Devices page's selection toolbar — and the sequence is subtle enough that
 * two hand-written copies would drift. In particular `withWallpaperMode`
 * below is a read-modify-write whose failure mode is silent and destructive
 * (see its own comment), which is exactly the kind of thing that must have
 * one definition.
 */

/**
 * `device.settings` is a free-form JSON blob (`DeviceDetailInfo.settings` is
 * typed `unknown`, and the column really is arbitrary JSON), so it is parsed
 * rather than `as`-cast — CLAUDE.md's rule for JSON DB columns applies to the
 * browser's copy of one too. A blob that is not an object at all (`null`, a
 * legacy scalar) degrades to `{}` instead of throwing: the operator pressed a
 * button to set a wallpaper, and refusing on the shape of an unrelated
 * settings field would be a worse answer than writing a well-formed one.
 */
const SettingsBlobSchema = z.record(z.string(), z.unknown())

function asBlob(value: unknown): Record<string, unknown> {
  const parsed = SettingsBlobSchema.safeParse(value)
  return parsed.success ? parsed.data : {}
}

/**
 * The device's whole `settings` blob with ONLY `labelling.mode` changed.
 *
 * **`PATCH /api/devices/:id` replaces the entire `settings` blob — there is no
 * per-key patch** (plan 124 §3.5, and `AdmitDeviceDialog.tsx`'s own note on
 * the same hazard). Sending `{ settings: { labelling: { mode: 'wallpaper' } } }`
 * would therefore not "set the labelling mode": it would silently erase this
 * device's proxy, video, preparation and timing settings. Every key already on
 * the blob is spread back, and every key already inside `labelling`
 * (`showName`, whatever a later plan adds) with it.
 */
function withWallpaperMode(settings: unknown): Record<string, unknown> {
  const base = asBlob(settings)
  return { ...base, labelling: { ...asBlob(base.labelling), mode: 'wallpaper' } }
}

/**
 * Step 1 of §3.5: set this device's labelling mode to `wallpaper`, preserving
 * everything else on its settings blob.
 *
 * `knownSettings` is the caller's already-loaded `device.settings` — the popup
 * holds a full `DeviceDetailInfo` and must not pay for a re-fetch. Omit it and
 * this fetches the device first, which is what the Devices page's selection
 * toolbar has to do: its `devices` are `DeviceInfo`s, and `DeviceInfo` carries
 * no `settings` at all. That is one extra GET per selected device, and it is
 * the honest price of a whole-blob PATCH — guessing the blob is the one thing
 * that must not happen (see `withWallpaperMode`).
 */
export async function setWallpaperLabelMode(deviceId: string, knownSettings?: unknown): Promise<void> {
  const settings =
    knownSettings === undefined ? (await api(`/api/devices/${deviceId}`, DeviceDetailResponseSchema)).device.settings : knownSettings
  await api(`/api/devices/${deviceId}`, DeviceResponseSchema, { method: 'PATCH', json: { settings: withWallpaperMode(settings) } })
}

/**
 * Step 2 of §3.5, and the truthful one. Plan 207 §4.2, §4.9 — `POST
 * /:id/label/apply` is gone; this is now the actions API's own `set-label`
 * verb (`runOnDevice('set-label', deviceId, {})`), whose `done` result
 * carries the device's real `DeviceLabelState` as its `detail`, parsed
 * through the protocol's own schema (never an `as`-cast — the whole point of
 * this call is that its `state` is reported verbatim, so it had better be
 * the shape it claims).
 */
export async function applyDeviceLabel(deviceId: string): Promise<DeviceLabelState> {
  const result = await runOnDevice('set-label', deviceId, {})
  return DeviceLabelStateSchema.parse(result.detail)
}

/** Both halves, in order — the whole of one press of "Set number as wallpaper" for ONE device. */
export async function setNumberAsWallpaper(deviceId: string, knownSettings?: unknown): Promise<DeviceLabelState> {
  await setWallpaperLabelMode(deviceId, knownSettings)
  return applyDeviceLabel(deviceId)
}

/**
 * The `set-label` actions verb's per-device results (plan 207 §4.9 — was
 * `POST /api/devices/labels/apply`'s own report), turned into the
 * `OutcomeSummary` + `SkippedGroups` pair every bulk surface in Studio shares.
 *
 * **Only `applied` counts as ok.** That is plan 124 §4.6's "Apply labels stops
 * lying" fix, stated positively: the previous version of this mapping counted
 * `state: 'off'` as a success, so on a farm where every device is `off` — the
 * default — pressing "Apply labels" on 45 phones wrote nothing, changed
 * nothing, and reported 45 × ok (§0.4). `off` is now a SKIPPED row with a
 * reason an operator can act on, which is what it always was.
 *
 * `partial`, `unavailable`, `stale` and `unknown` are real, reported outcomes
 * of the labelling service — not thrown errors — so they group under
 * `skipped`, each carrying the service's OWN reason text verbatim (plan 93
 * §3.15's rule: never invented, never paraphrased). A non-`done`
 * `ActionResult` (`failed`/`forbidden`/`skipped`/`warned`) is the only
 * `failed` row now — the actions API's own refusal, named by its `message`.
 */
export function summariseLabelApply(
  results: readonly ActionResult[],
  total: number,
  nameOf: (deviceId: string) => { label: string; number: number | null },
): { counts: OutcomeCounts; failed: NamedOutcome[]; skipped: NamedOutcome[] } {
  const named = (deviceId: string, reason: string): NamedOutcome => ({ deviceId, ...nameOf(deviceId), reason })
  const states = results.map((r) => ({ r, state: r.status === 'done' ? DeviceLabelStateSchema.safeParse(r.detail) : null }))
  const ok = states.filter(({ state }) => state?.success && state.data.state === 'applied').length
  const failed = states
    .filter(({ r, state }) => r.status !== 'done' || !state?.success)
    .map(({ r }) => named(r.deviceId, r.message ?? r.status))
  const skipped = states
    .filter(({ state }) => state?.success && state.data.state !== 'applied')
    .map(({ r, state }) => {
      const data = (state as { success: true; data: DeviceLabelState }).data
      return named(
        r.deviceId,
        // `off` is the one state the service leaves `reason: null` on, because
        // from its side there is nothing to explain — it was asked to apply a
        // mode of `off` and did exactly that. From the operator's side it is
        // the single most important thing this report can say, so it is
        // spelled out here rather than degrading to the bare word "off".
        data.state === 'off' ? 'labelling is off for this device' : (data.reason ?? data.state ?? 'not applied'),
      )
    })
  return { counts: { ok, failed: failed.length, skipped: skipped.length, total }, failed, skipped }
}
