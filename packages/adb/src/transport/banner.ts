/**
 * The `device::...` system banner the shim's CNXN reply carries (plan 27
 * §4.1) — built from the device row (model, product, API level), not
 * queried live: the endpoint is short-lived and per-lease, so there is no
 * value in a round-trip to the device just to describe it to the user's own
 * adb client.
 *
 * The feature list is fixed, not derived from the target device's real
 * `adbd` features: the shim is a byte-transparent bridge (plan §3.2 — every
 * `OPEN` maps onto one opaque smartsocket byte stream), so whichever
 * protocol form the user's adb client picks based on this banner (`shell:`
 * v1 or `shell,v2,...:` v2) is carried through unmodified to the REAL local
 * adb server and the REAL device's REAL `adbd`, which is what actually has
 * to understand it. `cmd`/`shell_v2`/`stat_v2` are safe to claim unconditionally
 * because they only change which service-string FORM a real, modern (API
 * 24+) `adbd` is asked to speak — never something this shim itself has to
 * implement (plan §4.1's warning is about carrying a claimed feature, not
 * about implementing its wire format, and pass-through always carries it).
 */
export const ADBD_SHIM_FEATURES = ['cmd', 'shell_v2', 'stat_v2'] as const

export interface BannerInfo {
  /** Falls back to `stableId` when no product model is known, same as `device-registry.ts` derives `label`. */
  model: string
  /** A stable, host-unique token — the device's own serial/stableId works well; never user-controlled. */
  product: string
  device: string
  apiLevel?: number | null
}

/**
 * The banner format is `key=value` pairs joined with `;` — `;`, `\0`, and
 * newlines in a value would corrupt the framing for whatever reads it next
 * (the user's real adb client), so they are stripped. Device labels are
 * usually plain (`Pixel 7`, a stableId), but a farm operator can rename a
 * device to anything, so this is a genuine defensive measure, not paranoia.
 */
function sanitize(value: string): string {
  return value.replace(/[;\0\r\n]/g, '')
}

export function buildDeviceBanner(info: BannerInfo): string {
  const parts = [
    `ro.product.name=${sanitize(info.product)}`,
    `ro.product.model=${sanitize(info.model)}`,
    `ro.product.device=${sanitize(info.device)}`,
    ...(info.apiLevel != null ? [`ro.build.version.sdk=${info.apiLevel}`] : []),
    `features=${ADBD_SHIM_FEATURES.join(',')}`,
  ]
  return `device::${parts.join(';')}`
}
