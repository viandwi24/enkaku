import { z } from 'zod'
import { AgentStateSchema } from './device'

/**
 * Device preparation (plan 106 §3.1, §3.2, §4) — generalises the ONE state
 * that already existed for the guest agent (`AgentStateSchema`,
 * `device.ts`) so every installable on-device component uses the same
 * vocabulary instead of a second, parallel one growing beside it. This is
 * deliberately a re-export, not a parallel `z.enum([...])` with the same six
 * strings written out again: two schemas that happen to agree today can
 * silently drift the next time either one gains or loses a state, and nobody
 * would notice until a value valid in one failed to parse in the other.
 *
 * `absent` — never installed (or removed).
 * `provisioning` — a pass is in flight right now.
 * `outdated` — installed, but the wrong build after one repair attempt — a
 *   named, actionable state ("Update"), never a crash.
 * `ready` — installed, matches what the toolchain expects, verified.
 * `failed` — a pass could not install or verify the component, with a
 *   verbatim reason. NEVER quarantines, blocks, or changes scheduling (plan
 *   106 §2) — a device with a failed component still streams, takes input,
 *   and runs work that does not need it.
 * `unsupported` — the device is not eligible for this component at all (e.g.
 *   an SDK floor), terminal by design, not a failure to retry. Distinct from
 *   `failed` on purpose (plan 106 §3.2): an old phone is not a broken one.
 */
export const PreparationStateSchema = AgentStateSchema
export type PreparationState = z.infer<typeof PreparationStateSchema>

/**
 * One component's persisted status for one device (plan 106 §3.1) — the
 * shape `AgentStatus` already proved for the guest agent, generalised.
 * `attempts`/`nextAttemptAt` mirror the SAME bounded-retry shape (plan 90
 * §3.7, `DEFAULT_RETRY_BACKOFF_S`) — `packages/core/src/device/bounded-retry.ts`
 * is the one place that arithmetic lives, shared by every component and by
 * the guest agent's own provisioner, rather than reimplemented per caller.
 */
export const PreparationComponentStatusSchema = z.object({
  state: PreparationStateSchema,
  /** Free-form on-device version (an APK versionName/versionCode, a build id) — displayed verbatim, never parsed. */
  version: z.string().nullable(),
  /** Verbatim failure/skip reason, shown directly to an operator (never summarised) — same rule `AgentStatus.reason` follows. */
  reason: z.string().nullable(),
  /** Unix epoch seconds of the last completed pass for this component; null before the first pass ever runs. */
  checkedAt: z.number().int().nullable(),
  attempts: z.number().int(),
  nextAttemptAt: z.number().int().nullable(),
})
export type PreparationComponentStatus = z.infer<typeof PreparationComponentStatusSchema>

/** A component that has never had a pass run against it — the default entry, and the safe fallback for a stored value that fails validation. */
export const DEFAULT_PREPARATION_COMPONENT_STATUS: PreparationComponentStatus = {
  state: 'absent',
  version: null,
  reason: null,
  checkedAt: null,
  attempts: 0,
  nextAttemptAt: null,
}

/**
 * `devices.preparation` (plan 106 §3.1, §4): one record keyed by component
 * id, open-ended by design (§3.2 — "adding a future component is a registry
 * entry, not a new subsystem"). Component ids themselves are core's registry
 * concern (`packages/core/src/device/preparation/registry.ts`), never fixed
 * in this schema — the protocol package only fixes the SHAPE every
 * component's status must use, not the roster.
 *
 * `scrcpy-server` is deliberately NOT a component id that will ever appear
 * here (plan 106 §3.2, §9 Q1): it is pushed fresh every session and calls
 * `unlinkSelf()` to delete itself, so an "installed state" for it would be a
 * lie that looks tidy. It is verified at use, by the session that pushes it
 * (`packages/scrcpy/src/session.ts`), which is a different, already-correct
 * mechanism — not a gap this schema needs to paper over.
 */
export const DevicePreparationSchema = z.record(z.string(), PreparationComponentStatusSchema)
export type DevicePreparation = z.infer<typeof DevicePreparationSchema>

/** No component has ever had a pass run for this device — the default for a brand-new row. */
export const DEFAULT_DEVICE_PREPARATION: DevicePreparation = {}
