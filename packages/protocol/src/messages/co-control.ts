import { z } from 'zod'
import { LeaseHolderSchema } from '../device'
import { MirrorActionSchema } from './input'

/**
 * Co-control (plan 91 §4.4): **Assist**, a narrow grant to touch a device
 * someone/something else already controls (§3.2), and **Mirror**, one
 * operator's input fanned out to many devices at once (§3.8, §3.9). Twelve
 * messages total.
 *
 * Neither half ever moves or widens the lease. `assist.*` never calls
 * `acquireManual` and never changes `DeviceStatus` (§3.2's table); `mirror.*`
 * acquires no multi-device lock at all — a busy member becomes an `assist`
 * grant, exactly like a single-device Assist would, never a takeover
 * (§3.9). The confirmation a caller shows before either is a WARNING, not a
 * permission request: control stays with whoever already holds it (§3.12).
 */

/**
 * Why a grant (or a mirror member's assist) ended (plan 91 §3.2, §3.9, §4.2).
 * Declared here rather than imported from `packages/core/src/lease/
 * co-control.ts`'s own `AssistEndReason` TS type — the same reasoning
 * `LeaseRevokedMessage.payload.reason` (`./job.ts`) already applies: a wire
 * message owns its own vocabulary, independent of the internal type that
 * happens to produce it today.
 */
export const AssistEndReasonSchema = z.enum(['released', 'ttl', 'disconnected', 'primary_ended', 'mode_off'])
export type AssistEndReason = z.infer<typeof AssistEndReasonSchema>

/**
 * One resolved member of a mirror group, at `mirror.start` and after every
 * `mirror.changed`/`input.mirror.result` reconciliation (plan 91 §3.9, §4.7).
 *
 * `reason` is `orientation_mismatch` for `mode: 'partial'`; one of
 * `unavailable` | `installing` | `node_owned` | `assist_taken` |
 * `assist_not_allowed` | `repeated_failures` for `mode: 'skipped'`; `null`
 * for `lease`/`assist`, which have nothing to report. `aspectDrift` is
 * flagged once, at `mirror.start` (§3.7 item 2), and rendered as a
 * persistent chip on that member's tile — it never blocks input, unlike
 * `orientation_mismatch`, which withholds pointer actions only (§3.7 item 1).
 */
export const MirrorMemberSchema = z.object({
  deviceId: z.string(),
  label: z.string(),
  /**
   * The device's number from `device_numbers` (plan 89 §3.1), or `null` for a
   * device that has no reservation — plan 124 §3.7.
   *
   * A SEPARATE field, not `#7` pre-composed into `label` above, for the two
   * reasons plan 124 §3.1 gives: the number composes with the label at render
   * time and never enters it, and a consumer that already knows the number
   * from somewhere else (`DevicePopup`'s `labelFor` falls back to the
   * `DeviceInfo` it holds, which carries `number` of its own) would otherwise
   * compose a second `#7` onto a string that already had one. `label` stays
   * exactly what `devices.label` says; this is the other half.
   */
  number: z.number().int().nullable(),
  mode: z.enum(['lease', 'assist', 'partial', 'skipped']),
  reason: z.string().nullable(),
  aspectDrift: z.boolean(),
})
export type MirrorMember = z.infer<typeof MirrorMemberSchema>

/**
 * One device's outcome for one fanned-out action (plan 91 §3.8, §4.7) — every
 * `input.mirror` returns exactly one of these per live member. "Never
 * silence" (§1's goals) is the point: a member that could not be reached
 * reports `ok: false` with a `code`, it is never simply absent from the
 * results array.
 */
export const MirrorResultSchema = z.object({
  deviceId: z.string(),
  ok: z.boolean(),
  code: z.string().nullable(),
  latencyMs: z.number(),
})
export type MirrorResult = z.infer<typeof MirrorResultSchema>

// ---- client -> server ----

/**
 * Ask to assist a device someone/something else controls (plan 91 §3.2,
 * §3.12) — sent only after the caller has shown the warning naming the job
 * (or user) currently in control and the operator confirmed it. Refused
 * `assist_not_allowed` / `assist_taken` / `assist_denied_by_script` /
 * `device_not_held` (§4.2); never calls `acquireManual` and never changes
 * `DeviceStatus`.
 */
export const AssistStartMessage = z.object({
  type: z.literal('assist.start'),
  id: z.string().optional(),
  payload: z.object({ deviceId: z.string() }),
})

/** Ends the caller's own grant early. A grant also ends on its own (TTL, the primary holder's hold ending, or WS close) without this message. */
export const AssistStopMessage = z.object({
  type: z.literal('assist.stop'),
  id: z.string().optional(),
  payload: z.object({ deviceId: z.string() }),
})

/**
 * Start a mirror group (plan 91 §3.9, §4.7): resolve every requested device
 * independently, in one call, and report an outcome for each — never a
 * multi-device lock. `focusDeviceId` names the geometry reference §3.7's
 * orientation gate and aspect-drift flag compare every other member against.
 */
export const MirrorStartMessage = z.object({
  type: z.literal('mirror.start'),
  id: z.string().optional(),
  payload: z.object({ focusDeviceId: z.string(), deviceIds: z.array(z.string()) }),
})

export const MirrorStopMessage = z.object({
  type: z.literal('mirror.stop'),
  id: z.string().optional(),
  payload: z.object({ groupId: z.string() }),
})

/**
 * One action fanned out to every live member of a mirror group (plan 91
 * §3.8, §4.7) — the browser sends exactly ONE message regardless of member
 * count; the core fans out over each device's own already-open scrcpy
 * socket (§3.8's arithmetic). `seq` correlates this action's
 * `input.mirror.result`, taking the place of the envelope's usual `id`.
 * `soloDeviceId`, when set, narrows delivery to that one member — the
 * Alt-held / "Focused only" escape hatch for the moment divergence becomes
 * visible (§3.9's "Solo").
 */
export const InputMirrorMessage = z.object({
  type: z.literal('input.mirror'),
  payload: z.object({
    groupId: z.string(),
    seq: z.number().int(),
    action: MirrorActionSchema,
    soloDeviceId: z.string().optional(),
  }),
})

// ---- server -> client ----

/**
 * Reply to `assist.start`. `primary` names whoever/whatever still holds the
 * device — the job or user being assisted, never displaced (§3.2). Its
 * `takeable` is always `false`: an assist target is never a takeover
 * candidate through this flow.
 */
export const AssistStartedMessage = z.object({
  type: z.literal('assist.started'),
  id: z.string().optional(),
  payload: z.object({ deviceId: z.string(), expiresAt: z.number(), primary: LeaseHolderSchema }),
})

/**
 * Unicast to the (former) assisting connection. `id` is set only on a direct
 * reply to `assist.stop`; every other delivery — the grant expiring
 * (`ttl`), the connection already gone (`disconnected`), the primary hold
 * ending (`primary_ended`), or the farm switch turning off mid-grant
 * (`mode_off`) — is a push and omits it, the same convention
 * `DeviceReadinessMessage` (`../device.ts`) already documents for its own
 * request-vs-push `id`.
 */
export const AssistStoppedMessage = z.object({
  type: z.literal('assist.stopped'),
  id: z.string().optional(),
  payload: z.object({ deviceId: z.string(), reason: AssistEndReasonSchema }),
})

/**
 * Broadcast to every viewer of this device whenever who is assisting it
 * changes (plan 91 §3.4 item 4, F25) — reaches the wall tile, the device
 * card, the picker and the header with no new plumbing, the same broadcast
 * shape `LeaseChangedMessage` (`./job.ts`) already established for `heldBy`.
 */
export const AssistChangedMessage = z.object({
  type: z.literal('assist.changed'),
  payload: z.object({ deviceId: z.string(), assistedBy: z.array(LeaseHolderSchema) }),
})

/** Reply to `mirror.start` — one `MirrorMember` per requested device, never a silent omission (§3.9's resolution table). */
export const MirrorStartedMessage = z.object({
  type: z.literal('mirror.started'),
  id: z.string().optional(),
  payload: z.object({ groupId: z.string(), focusDeviceId: z.string(), members: z.array(MirrorMemberSchema) }),
})

export const MirrorStoppedMessage = z.object({
  type: z.literal('mirror.stopped'),
  id: z.string().optional(),
  payload: z.object({ groupId: z.string() }),
})

/**
 * Unicast reply to `input.mirror`, correlated by `seq` (not the envelope's
 * `id` — see `InputMirrorMessage` above). One entry per live member, always:
 * an action that completes with a missing result is exactly the silence
 * this plan's goals (§1) rule out.
 */
export const InputMirrorResultMessage = z.object({
  type: z.literal('input.mirror.result'),
  payload: z.object({ groupId: z.string(), seq: z.number().int(), results: z.array(MirrorResultSchema) }),
})

/**
 * Unicast to the mirror's owner whenever `reconcile` changes a member's mode
 * after `mirror.start` — a job ended and the device rejoins, a member
 * auto-dropped after `mirror.dropAfterConsecutiveFailures` (plan 91 §3.9),
 * or an `internal:install` job started and a member had to leave (F27).
 */
export const MirrorChangedMessage = z.object({
  type: z.literal('mirror.changed'),
  payload: z.object({ groupId: z.string(), members: z.array(MirrorMemberSchema) }),
})
