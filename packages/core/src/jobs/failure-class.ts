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
import { isDeviceGone } from '@enkaku/adb'

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
 *    (`DEVICE_DISCONNECTED`), the job's own heartbeat expired
 *    (`HEARTBEAT_EXPIRED`, plan 205 §4.7), the runner could not even acquire the
 *    device session for the next attempt (`SESSION_ACQUIRE_FAILED`), or the
 *    child never sent `ready` at all (`STARTUP_TIMEOUT`, plan 74 §3.2,
 *    §4.2 — a child that never started is a farm problem, not the script's,
 *    and unconditionally infra: unlike a run `TIMEOUT`, it never depends on
 *    `timeoutIsInfra`, because there is no script behaviour to blame here),
 *  - the tunnel/cloud vocabulary (`node_offline`, `E_DEVICE_NOT_READY`).
 *
 * One infra failure is NOT in this set and cannot be: adb's own "device '<serial>' not found",
 * which arrives as the text of an ordinary command's FAIL rather than as a code, and is matched on
 * the message by `isDeviceGone` in the classifier below.
 */
const INFRA_CODES = new Set<string>([
  'E_ADB_TIMEOUT',
  'E_ADB_CONNECT_TIMEOUT',
  'E_ADB_HANDSHAKE_TIMEOUT',
  'E_ADB_UNAVAILABLE',
  'E_DEVICE_NOT_READY',
  'node_offline',
  'device_not_found',
  'device_not_ready',
  'engine_not_found',
  'port_range_exhausted',
  'CHILD_CRASHED',
  'DEVICE_DISCONNECTED',
  'HEARTBEAT_EXPIRED',
  'SESSION_ACQUIRE_FAILED',
  'STARTUP_TIMEOUT',
])

/**
 * Infra codes that are NOT the device's fault, so they must never reach the
 * health tracker (`executor-host.ts` calls `health.note()` on `blameDevice`).
 *
 * Every one of these describes something the farm shares. Blaming the device
 * for it is the same misattribution that mass-quarantined a 73-phone farm
 * through `DeviceHealth` (2026-09-17/18): the condition hits every run at
 * once, so every device on the farm accumulates a streak it did nothing to
 * earn, and the fleet quarantines itself as `adb:unreachable` while nothing
 * is wrong with any phone.
 *
 * - `E_ADB_CONNECT_TIMEOUT` — `AdbSocket.connect` could not reach the adb
 *   server at 127.0.0.1:5037. The serial is not in that code path.
 * - `E_ADB_UNAVAILABLE` — `ensureServer()` gave up after three attempts.
 *   This code's whole meaning is "the adb server is not there".
 * - `node_offline` — "the node that owns this device is currently
 *   disconnected". One node carries many devices; the node is the fault.
 * - `port_range_exhausted` — the HOST ran out of forward ports.
 * - `engine_not_found` — a configuration problem, true of every device that
 *   asks for that engine.
 *
 * They stay `infra`: still retried, still rebound to another device, still
 * capped by `JOB_MAX_INFRA_REBINDS`. Only the blame changes.
 *
 * `E_ADB_TIMEOUT` and `E_ADB_HANDSHAKE_TIMEOUT` are deliberately NOT here.
 * Both keep real per-device meaning (a slow phone, a wedged transport), and
 * the farm-wide detector in `device/health.ts` is what stops them
 * mass-quarantining when the true cause is load.
 */
const NOT_THE_DEVICES_FAULT = new Set<string>([
  'E_ADB_CONNECT_TIMEOUT',
  'E_ADB_UNAVAILABLE',
  'node_offline',
  'port_range_exhausted',
  'engine_not_found',
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
 * that it exists — plan 36 deliberately left it out; plan 98 §3.6 adds
 * `MEMORY_LIMIT` alongside it). Every one of these would already classify
 * `script`/`blameDevice: false` by falling through to the default below; the
 * set exists so that fact is asserted directly rather than left to an
 * implicit default:
 *  - per plan 37 acceptance #10, a crash is a RESULT (the script's target app
 *    broke), never the farm's fault;
 *  - per plan 98 §3.6, a script that blew its own DECLARED memory budget is
 *    likewise a result, not the farm's — `MEMORY_LIMIT` must never feed plan
 *    23's health tracker or spend the infra retry budget, and is retried
 *    only up to the script's own `retries` (default 0), never with backoff.
 */
const SCRIPT_CODES = new Set<string>(['APP_CRASHED', 'MEMORY_LIMIT'])

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
    return { class: 'infra', code, message, blameDevice: !NOT_THE_DEVICES_FAULT.has(code) }
  }
  /*
    The one infra failure with no code of its own — and the largest single bucket of "failed" jobs
    on the owner's farm: 187 of 1305 (14%) over three days, every one of them recorded against the
    script that happened to be running.

    adb reports a phone it no longer has as the FAIL TEXT of an otherwise ordinary command,
    `device '<serial>' not found`, so the failure arrives as a plain `E_ADB_FAIL` and falls past
    every check above into the default. That default is `script`, which is right for an UNKNOWN
    failure and wrong for this one: a USB flap, a hub reset or an adb-tcp drop is the farm's
    problem, not the script's, and classifying it as the script's spends the script's retry budget
    and leaves the device's own health untouched.

    Matched on the MESSAGE, which is not a shortcut. `packages/adb/src/errors.ts` has carried
    `isDeviceGone` for this exact text since the farm collapsed twice over it, and its header says
    why there is no code to match: adb sends this as command output, and inventing an
    `AdbErrorCode` would not change what the server sends. Nothing had ever asked it here.

    Blamed on the device, like `E_ADB_TIMEOUT` and unlike the farm-wide codes above: a transport
    that keeps dropping is a real per-device fact, and `device/health.ts`'s farm-wide detector is
    what stops a hub-sized outage from quarantining everything.

    Placed after the code checks so an explicit code always wins, and before the default so an
    unknown failure still classifies as `script`.
  */
  if (isDeviceGone(message)) {
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
