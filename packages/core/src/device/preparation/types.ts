import type { DeviceRow } from '../../db/schema'

/**
 * A single registered on-device component (plan 106 §3.2, §4). Adding a
 * future component is one of these, registered in `registry.ts` — not a new
 * subsystem, not a new schema, not a new runner. `guest-agent` is
 * deliberately NOT one of these yet (plan 106 §9 Q2, decided in step
 * 106.1 — see `db/schema.ts`'s `preparation` column comment): it keeps
 * provisioning itself through `agent-provisioner.ts` until step 106.5
 * migrates it onto this registry as its first entry. `scrcpy-server` is
 * deliberately never one of these at all (plan 106 §3.2, §9 Q1) — it is
 * pushed fresh every session and deletes itself, so an "installed state"
 * for it would be a lie that looks tidy; it is verified at use, by the
 * session that pushes it, a different and already-correct mechanism.
 */
export interface PreparationComponent {
  /** Stable id — the key this component's status is stored under in `devices.preparation`. */
  id: string
  /** Operator-facing name, for logs and (later) the popup. */
  label: string
  /**
   * Whether this device is eligible for this component at all — checked
   * BEFORE any retry math, exactly like `agent-provisioner.ts`'s SDK-floor
   * check. `false` resolves `unsupported`, terminal, never retried — an old
   * device is not a broken one (plan 106 §3.2).
   */
  applicable(row: DeviceRow): boolean
  /** Shown as the component's `reason` when `applicable()` returns false. */
  unsupportedReason(row: DeviceRow): string
  /**
   * Verify → install → repair-once, exactly the `verify → install → repair
   * once → degrade` shape `agent-provisioner.ts`'s own `runOnePass` and the
   * `ui-server`/`guest-agent` launchers already use. Must rethrow an
   * `EnkakuError` coded `E_ADB_UNAVAILABLE` UNCHANGED (never translate it
   * into `state: 'failed'`) — that is how the runner tells "the adb
   * subsystem was not ready for this pass" (defer, do not count) apart from
   * "the device itself would not install/verify" (count against the bound),
   * per plan 106 §3.3 / hotfix §96.25's second fix. Any other thrown error
   * is treated by the runner as a device-side `failed` — a well-behaved
   * component should already return `{ state: 'failed', reason }` itself
   * rather than throw, but the runner does not crash a whole pass over one
   * component's surprise either way.
   */
  run(row: DeviceRow): Promise<PreparationRunResult>
}

export interface PreparationRunResult {
  state: 'ready' | 'outdated' | 'failed'
  /** Free-form on-device version — displayed verbatim, never parsed. */
  version: string | null
  reason: string | null
}
