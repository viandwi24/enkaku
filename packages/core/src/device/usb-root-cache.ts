import { usbRootOf } from '@enkaku/session'
import type { TrackedDevice } from '@enkaku/adb'

/**
 * A thin, single-purpose cache — NOT a second detector (plan 223 §4.6). It
 * reuses `usbRootOf` (`@enkaku/session`, plan 206 §4.2) verbatim; the only
 * new code here is a `cacheMs`-scoped memo over one `AdbClient.listDevices()`
 * call, the same pattern `always-on.ts`'s own `USB_ROOT_CACHE_MS` already
 * uses internally for the SAME purpose in the builder. Two independent
 * 5-second caches over one cheap `host:devices-l` call is acceptable
 * duplication of a CACHE, not of the CLASSIFIER.
 */

export interface UsbRootCacheDeps {
  listDevices: () => Promise<TrackedDevice[]>
  cacheMs?: number // default 5_000, matches always-on.ts's USB_ROOT_CACHE_MS
}

export interface UsbRootCache {
  /** Resolves a serial's USB root hub (`usbRootOf`'s own return shape: the bus number, `'network'`, or `'unknown'`). Never throws — a `listDevices` rejection or a serial absent from the listing resolves `'unknown'`, bounded only by the farm-wide install semaphore, never blocking the caller. */
  rootOf(serial: string): Promise<string>
}

export function createUsbRootCache(deps: UsbRootCacheDeps): UsbRootCache {
  const cacheMs = deps.cacheMs ?? 5_000
  // `-Infinity`, not `0` — a mocked test clock starting at `0` would otherwise
  // read the very first call as already-cached (`0 - 0 < cacheMs`), skipping
  // the initial fetch entirely.
  let cachedAt = -Infinity
  let bySerial = new Map<string, string>()
  async function refresh(): Promise<void> {
    if (Date.now() - cachedAt < cacheMs) return
    try {
      const list = await deps.listDevices()
      bySerial = new Map(list.map((d) => [d.serial, usbRootOf(d.usb)]))
      cachedAt = Date.now()
    } catch {
      // Leave the previous snapshot in place; every lookup this pass falls
      // back to 'unknown' for a serial the stale snapshot does not have.
    }
  }
  return {
    async rootOf(serial) {
      await refresh()
      return bySerial.get(serial) ?? 'unknown'
    },
  }
}
