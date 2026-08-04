import type { AdbClient } from '@enkaku/adb'

export interface DeviceProbeResult {
  stableId: string
  model: string | null
  androidVersion: string | null
  apiLevel: number | null
  screenW: number | null
  screenH: number | null
  density: number | null
}

/** `wm size` → {w,h}; `Override size:` beats `Physical size:`. */
export function parseWmSize(raw: string): { w: number; h: number } | null {
  const override = raw.match(/Override size:\s*(\d+)x(\d+)/)
  const physical = raw.match(/Physical size:\s*(\d+)x(\d+)/)
  const m = override ?? physical
  if (!m || !m[1] || !m[2]) return null
  return { w: Number.parseInt(m[1], 10), h: Number.parseInt(m[2], 10) }
}

/** `wm density` → density; `Override density:` menang. */
export function parseWmDensity(raw: string): number | null {
  const override = raw.match(/Override density:\s*(\d+)/)
  const physical = raw.match(/Physical density:\s*(\d+)/)
  const m = override ?? physical
  if (!m || !m[1]) return null
  return Number.parseInt(m[1], 10)
}

const isInvalidSerialno = (s: string): boolean =>
  s.length === 0 || s === 'unknown' || s === '0'

const isInvalidAndroidId = (s: string): boolean => s.length === 0 || s === 'null'

/**
 * stableId (spec §7.5): ro.serialno → ANDROID_ID fallback → tertiary
 * 'serial:<adb-serial>' (an edge case the caller must log.warn about — Open questions Q2).
 */
export function pickStableId(serialno: string, androidId: string, serial: string): string {
  const sn = serialno.trim()
  if (!isInvalidSerialno(sn)) return sn
  const aid = androidId.trim()
  if (!isInvalidAndroidId(aid)) return aid
  return `serial:${serial}`
}

const intOrNull = (s: string): number | null => {
  const n = Number.parseInt(s.trim(), 10)
  return Number.isNaN(n) ? null : n
}

/**
 * Probe device identity and props (plan 01 §4.5). Everything goes through client.exec —
 * automatically serialised by the per-device queue.
 */
export async function probeDeviceIdentity(client: AdbClient, serial: string): Promise<DeviceProbeResult> {
  const [
    { stdout: serialno },
    { stdout: androidId },
    { stdout: model },
    { stdout: version },
    { stdout: sdk },
    { stdout: wmSize },
    { stdout: wmDensity },
  ] = await Promise.all([
    client.exec(serial, 'getprop ro.serialno', { profile: 'probe' }),
    client.exec(serial, 'settings get secure android_id', { profile: 'probe' }),
    client.exec(serial, 'getprop ro.product.model', { profile: 'probe' }),
    client.exec(serial, 'getprop ro.build.version.release', { profile: 'probe' }),
    client.exec(serial, 'getprop ro.build.version.sdk', { profile: 'probe' }),
    client.exec(serial, 'wm size', { profile: 'probe' }),
    client.exec(serial, 'wm density', { profile: 'probe' }),
  ])
  const size = parseWmSize(wmSize)
  return {
    stableId: pickStableId(serialno, androidId, serial),
    model: model.trim() || null,
    androidVersion: version.trim() || null,
    apiLevel: intOrNull(sdk),
    screenW: size?.w ?? null,
    screenH: size?.h ?? null,
    density: parseWmDensity(wmDensity),
  }
}
