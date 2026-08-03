/**
 * Retry classification (plan 36 §3.2, §4.1): a job failure is `infra`
 * (the farm's problem — retry with backoff, prefer another device, blame the
 * device's health), `load` (the queue was saturated — retry, but NEVER blame
 * the device, per plan 22.1 §3.1 / plan 23 §3.6), or `script` (the result —
 * only retried up to the script's own `retries`, no backoff).
 *
 * This is a single exported table so adding a code is a one-line change with
 * a test, never a scattered `if` (§4.1). An unrecognised code classifies as
 * `script` — defaulting an unknown failure to "retry as infra" would let a
 * novel bug loop forever; defaulting to "report it" is the honest failure
 * mode (§3.2, acceptance #9).
 */
export type FailureClass = 'infra' | 'script' | 'load'

export interface ClassifiedFailure {
  class: FailureClass
  code: string
  message: string
  /** True when this device should be blamed (feeds plan 23's health tracker). */
  blameDevice: boolean
}

/**
 * Codes that mean "the device is not answering" or "the farm lost it mid-run"
 * (plan 36 §3.2). Sourced from:
 *  - `@enkaku/adb`'s coded errors (plan 22.1 §4.2),
 *  - `SessionError` codes that mean the session/device layer itself failed
 *    to come up (`packages/session/src/errors.ts`) — as opposed to codes that
 *    mean the session answered but the script's own request was unsatisfiable
 *    (`element_not_found`, `waitfor_timeout`, `artifact_too_large`), which are
 *    `script`,
 *  - codes synthesised by the runner/host for farm-caused endings: the child
 *    process was killed by the OS without reporting a result
 *    (`CHILD_CRASHED`), the device vanished from track-devices mid-job
 *    (`DEVICE_DISCONNECTED`), the job lease was force-expired
 *    (`LEASE_FORCE_RELEASED`), or the runner could not even acquire the
 *    device session for the next attempt (`SESSION_ACQUIRE_FAILED`),
 *  - the tunnel/cloud vocabulary (`agent_offline`, `E_DEVICE_NOT_READY`).
 */
const INFRA_CODES = new Set<string>([
  'E_ADB_TIMEOUT',
  'E_ADB_CONNECT_TIMEOUT',
  'E_ADB_HANDSHAKE_TIMEOUT',
  'E_ADB_UNAVAILABLE',
  'E_DEVICE_NOT_READY',
  'agent_offline',
  'device_not_found',
  'device_not_ready',
  'engine_not_found',
  'port_range_exhausted',
  'CHILD_CRASHED',
  'DEVICE_DISCONNECTED',
  'LEASE_FORCE_RELEASED',
  'SESSION_ACQUIRE_FAILED',
])

/**
 * Load, not infra (plan 22.1 §3.1, plan 23 §3.6): the queue was saturated,
 * not the device. Retried, but `blameDevice` is always false — Plan 23 split
 * these clocks precisely so this distinction exists (acceptance #5).
 */
const LOAD_CODES = new Set<string>(['E_ADB_BUSY'])

/** The job's own per-attempt timeout — ambiguous, so it is configurable (§3.3). */
const TIMEOUT_CODE = 'TIMEOUT'

/**
 * Explicit script-class codes (plan 37 §4.4's `APP_CRASHED`, added here now
 * that it exists — plan 36 deliberately left it out). Every one of these
 * would already classify `script`/`blameDevice: false` by falling through to
 * the default below; the set exists so that fact is asserted directly rather
 * than left to an implicit default, per plan 37 acceptance #10: a crash is a
 * RESULT (the script's target app broke), never the farm's fault, so it must
 * never feed plan 23's health tracker or trigger a device-blaming retry.
 */
const SCRIPT_CODES = new Set<string>(['APP_CRASHED'])

export function classifyFailure(err: unknown, opts: { timeoutIsInfra: boolean }): ClassifiedFailure {
  const { code, message } = toCodeAndMessage(err)

  if (code === TIMEOUT_CODE) {
    return opts.timeoutIsInfra
      ? { class: 'infra', code, message, blameDevice: true }
      : { class: 'script', code, message, blameDevice: false }
  }
  if (LOAD_CODES.has(code)) {
    return { class: 'load', code, message, blameDevice: false }
  }
  if (INFRA_CODES.has(code)) {
    return { class: 'infra', code, message, blameDevice: true }
  }
  if (SCRIPT_CODES.has(code)) {
    return { class: 'script', code, message, blameDevice: false }
  }
  // Unknown → script (§3.2, acceptance #9): the honest failure mode.
  return { class: 'script', code, message, blameDevice: false }
}

function toCodeAndMessage(err: unknown): { code: string; message: string } {
  if (err && typeof err === 'object') {
    const code = 'code' in err && typeof (err as { code: unknown }).code === 'string' ? (err as { code: string }).code : 'UNKNOWN'
    const message = 'message' in err && typeof (err as { message: unknown }).message === 'string' ? (err as { message: string }).message : String(err)
    return { code, message }
  }
  return { code: 'UNKNOWN', message: String(err) }
}
