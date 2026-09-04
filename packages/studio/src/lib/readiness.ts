'use client'

import { DeviceReadinessSchema, type DeviceReadiness, type Readiness } from '@enkaku/protocol'
import { runOnDevice } from './actions'

/**
 * Set a device's `desired` readiness (plan 43 §4.5) — server-authoritative:
 * every refusal in §3.4, corrected by plan 49 §3.1 (offline/quarantined for a
 * Wake, a running job or another operator's manual control activity for a
 * Sleep — watching never blocks it) is enforced by the core itself, so a
 * rejected request throws with the server's own reason (`ActionRefusedError`,
 * via `runOnDevice`), meant to be shown verbatim (the same pattern
 * `useAction` already uses for every other action in this app).
 *
 * The actions API (plan 207 §4.2) has a verb for `'awake'` (`wake`) and
 * `'asleep'` (`sleep`), and none for `'hot'` — an operator never asks a
 * device to become hot directly; it is a state the device's own activity
 * produces. `hot` is plan 206 §9 Q3's own open question, deliberately left
 * unanswered here rather than guessed at (plan 207 §4.9's own table entry
 * for this file).
 */
export function setDeviceReadiness(deviceId: string, desired: Readiness): Promise<DeviceReadiness> {
  if (desired === 'hot') return Promise.reject(new Error('hot is not an action'))
  const verb = desired === 'awake' ? 'wake' : 'sleep'
  return runOnDevice(verb, deviceId, {}).then((r) => DeviceReadinessSchema.parse(r.detail))
}

/** Human copy for `ReadinessBlockedReason` — shown as the disabled control's tooltip and in toasts. */
export const READINESS_BLOCKED_REASON: Record<string, string> = {
  offline: 'the device is offline',
  quarantined: 'the device is quarantined',
  hot_budget_full: 'the farm-wide hot device limit is reached',
  locked: 'the device has a lock screen adb cannot dismiss',
  error: 'the last attempt failed',
}
