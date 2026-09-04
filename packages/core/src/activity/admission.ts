import type { ActivityKind } from '@enkaku/protocol'
import { E_DEVICE_CONFLICT } from '@enkaku/protocol'
import { EnkakuError } from '../util/errors'
import type { DeviceStateMachine } from '../device/state-machine'
import type { ActivityRegistry } from './registry'
import { evaluate, type ControlPolicySettings, type EvaluateOptions } from './policy'

/**
 * The one admission door for a device-touching capability or HTTP route
 * (plan 205 §4.9): never acquires anything, just asks the policy and throws
 * on `forbid`. `admitHttp` in the plan's own table is this same function.
 */
export function requireAdmission(
  activities: Pick<ActivityRegistry, 'list'>,
  settings: () => ControlPolicySettings,
  states: Pick<DeviceStateMachine, 'current'>,
  deviceId: string,
  kind: ActivityKind,
  opts?: EvaluateOptions,
): { warning: string | null } {
  const status = states.current(deviceId)
  if (status === null) throw new EnkakuError('device_not_found', `no such device: ${deviceId}`)
  if (status !== 'online') throw new EnkakuError('device_unavailable', `the device is ${status}`)

  const decision = evaluate(kind, activities.list(deviceId), settings(), opts)
  if (decision.decision === 'forbid') throw new EnkakuError(E_DEVICE_CONFLICT, decision.message)
  return { warning: decision.decision === 'warn' ? decision.message : null }
}

export { requireAdmission as admitHttp }
