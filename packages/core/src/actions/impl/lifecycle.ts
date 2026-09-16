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

/** `quarantine` — `false` means the device was not `online` (offline, or already quarantined), mapped to `skipped` by the router. */
export function quarantineDevice(
  battery: Pick<BatteryMonitor, 'quarantine'> | null,
  deviceId: string,
  reason: string | null,
): boolean {
  return battery?.quarantine(deviceId, reason) ?? false
}

/** `unquarantine` (plan 207 §4.2) — `false` means "not quarantined", mapped to `skipped` by the router. */
export function unquarantineDevice(battery: Pick<BatteryMonitor, 'unquarantine'> | null, deviceId: string): boolean {
  return battery?.unquarantine(deviceId) ?? false
}
