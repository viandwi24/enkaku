import { deviceState, type DeviceInfo } from '@enkaku/protocol'
import type { StatusDotState } from '@enkaku/ui'
import { relativeTime } from '@enkaku/ui'

/**
 * The one mapping between plan 205's `deviceState()` (`free | controlled |
 * job | offline | warn`) and plan 204's `StatusDot` (`free | controlled |
 * job | offline | unauthorized`). The two lists differ in exactly one entry,
 * and the difference is a word, not a colour: the handoff calls the amber
 * state "unauthorized" (README, Screens view), the MVP's stored status is
 * `quarantined` (plan 205 §4.1), and `var(--warn)` is what both mean.
 *
 * There is deliberately no second copy of this map anywhere; a screen that
 * needs a dot imports from here (plan 214 §3.3).
 */
export const DOT_STATE: Record<ReturnType<typeof deviceState>, StatusDotState> = {
  free: 'free',
  controlled: 'controlled',
  job: 'job',
  offline: 'offline',
  warn: 'unauthorized',
}

export function dotStateOf(device: DeviceInfo): StatusDotState {
  return DOT_STATE[deviceState(device)]
}

/**
 * The filter menu's "Free"/"Running job" rows (design handoff, Devices
 * toolbar) read the same mapping through this, rather than calling
 * `deviceState()` themselves — `GREP_214_DEVICE_STATE` (plan 214 §10.3)
 * proves there is exactly one file in this screen that names it.
 */
export function isDeviceState(device: Pick<DeviceInfo, 'status' | 'activities'>, state: 'free' | 'controlled' | 'job'): boolean {
  return deviceState(device) === state
}

/**
 * The dot's hover tooltip, in the handoff's own four shapes ("Job ·
 * tiktok_warmup.py", "Controlled by rz@studio", "Free · idle", "Last seen 12m
 * ago"). Built from the activity list, so it can never disagree with the Task
 * cell beside it.
 */
export function dotTooltipOf(device: DeviceInfo): string {
  if (device.status === 'offline') return `Last seen ${relativeTime(device.lastSeen)}`
  if (device.status === 'quarantined') return device.quarantineReason ? `Quarantined · ${device.quarantineReason}` : 'Quarantined'
  const job = device.activities.find((a) => a.kind === 'job' || a.kind === 'workflow-job')
  if (job) return `Job · ${job.label}`
  const control = device.activities.find((a) => a.kind === 'control')
  if (control) return `Controlled by ${control.actor.label}`
  const other = device.activities[0]
  if (other) return other.label
  return 'Free · idle'
}
