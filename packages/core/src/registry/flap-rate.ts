/**
 * How often each device has dropped off and come back lately (0.2.74).
 *
 * A `device.flap` is a device whose adb transport vanished and returned inside the grace, so it never
 * went offline and no status ever changed. That is exactly why nothing that reads `status` can see
 * one — and on the owner's farm (2026-09-21) one hub's twenty phones flapped every ten to twenty
 * seconds for hours, every job on them was reset over and over, and the SMM plugin kept sending more
 * because every phone read `online`. This counts them per device over a rolling window, so
 * `device.list` can say how steady a phone is and a plugin can leave an unsteady one alone.
 *
 * In memory, like the registry's own flap counter: it is about the last few minutes, not history.
 */
export const FLAP_WINDOW_SEC = 600

export interface FlapRate {
  note(deviceId: string, atMs?: number): void
  /** Flaps inside the window, as of `atMs`. */
  recent(deviceId: string, atMs?: number): number
}

export function createFlapRate(windowSec: number = FLAP_WINDOW_SEC): FlapRate {
  const seen = new Map<string, number[]>()
  const trim = (deviceId: string, now: number): number[] => {
    const list = (seen.get(deviceId) ?? []).filter((t) => now - t < windowSec * 1000)
    if (list.length === 0) seen.delete(deviceId)
    else seen.set(deviceId, list)
    return list
  }
  return {
    note(deviceId, atMs = Date.now()) {
      const list = trim(deviceId, atMs)
      list.push(atMs)
      seen.set(deviceId, list)
    },
    recent(deviceId, atMs = Date.now()) {
      return trim(deviceId, atMs).length
    },
  }
}
