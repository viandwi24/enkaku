import type { DeviceReadiness } from '@enkaku/protocol'
import type { ReadinessManager } from '../../device/readiness'

/** `wake`/`sleep` (plan 207 §4.2) — the same `ReadinessManager.set` door `PUT /:id/readiness` used. */
export async function setReadiness(
  readiness: Pick<ReadinessManager, 'set'>,
  deviceId: string,
  desired: 'awake' | 'asleep',
  actor: { userId: string | null },
): Promise<DeviceReadiness> {
  return readiness.set(deviceId, desired, { userId: actor.userId, clientId: null })
}
