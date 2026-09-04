import type { BlockedDevice, ForgetResult } from '../../device/lifecycle'
import type { DeviceLifecycle } from '../../device/lifecycle'
import type { BatteryMonitor } from '../../device/battery'

export async function forgetDevice(
  lifecycle: DeviceLifecycle,
  deviceId: string,
  opts: { deleteHistory: boolean; actor: { userId: string | null } },
): Promise<ForgetResult> {
  return lifecycle.forget(deviceId, opts)
}

export async function blockDevice(
  lifecycle: DeviceLifecycle,
  deviceId: string,
  opts: { reason?: string; actor: { userId: string | null } },
): Promise<BlockedDevice> {
  return lifecycle.block(deviceId, opts)
}

/** `unquarantine` (plan 207 §4.2) — `false` means "not quarantined", mapped to `skipped` by the router. */
export function unquarantineDevice(battery: Pick<BatteryMonitor, 'unquarantine'> | null, deviceId: string): boolean {
  return battery?.unquarantine(deviceId) ?? false
}
