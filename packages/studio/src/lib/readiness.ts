'use client'

import type { DeviceReadiness, Readiness } from '@enkaku/protocol'
import { api } from './actions'
import { ws } from './ws'

/**
 * Set a device's `desired` readiness (plan 43 §4.5) — server-authoritative:
 * every refusal in §3.4, corrected by plan 49 §3.1 (offline/quarantined for a
 * Wake, a running job or another operator's manual lease for a Sleep —
 * watching never blocks it) is enforced by the core itself, so a rejected
 * request throws with the server's own reason (`ApiError`, via `api()`),
 * meant to be shown verbatim (the same pattern `useAction` already uses for
 * every other action in this app).
 *
 * `clientId` carries this tab's WS session id, when one exists yet, so the
 * server can tell "I already hold the lease" apart from "someone else does"
 * for the Sleep permission check (§3.4's "you hold the lease" clause) — the
 * same `clientId` convention the adb-endpoint and transfer routes use.
 */
export function setDeviceReadiness(deviceId: string, desired: Readiness): Promise<DeviceReadiness> {
  return api<{ readiness: DeviceReadiness }>(`/api/devices/${encodeURIComponent(deviceId)}/readiness`, {
    method: 'PUT',
    json: { desired, ...(ws.getSessionId() ? { clientId: ws.getSessionId() } : {}) },
  }).then((b) => b.readiness)
}

/** Human copy for `ReadinessBlockedReason` — shown as the disabled control's tooltip and in toasts. */
export const READINESS_BLOCKED_REASON: Record<string, string> = {
  offline: 'the device is offline',
  quarantined: 'the device is quarantined',
  hot_budget_full: 'the farm-wide hot device limit is reached',
  locked: 'the device has a lock screen adb cannot dismiss',
  error: 'the last attempt failed',
}
