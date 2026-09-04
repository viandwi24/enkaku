/**
 * The handoff's own width formula (README.md:240-241): the cast column is
 * sized from the device's live aspect ratio so it fits the 640px window
 * height without overflowing, then the 52px rail and the 274px info column
 * are added. Derived from the LIVE stream size, never from
 * `DeviceInfo.screenW/screenH`, which goes stale on rotation (plan 215 §3.2 D3).
 */
export const RAIL_WIDTH_PX = 52
export const INFO_WIDTH_PX = 274
/** The cast column's own floor and the height budget the 560 comes from. */
export const CAST_MIN_WIDTH_PX = 380

/** `max(560 * (w/h) + 36, 380)`. */
export function castWidthPx(ratio: number): number {
  return Math.max(560 * ratio + 36, CAST_MIN_WIDTH_PX)
}

/** The whole window: `max(560 * (w/h) + 36, 380) + 52 + 274`. */
export function windowWidthPx(ratio: number): number {
  return Math.max(560 * ratio + 36, 380) + 52 + 274
}

/** Before the first frame: a 9:19.5 phone, which resolves to the 380px floor and a 706px window. */
export const DEFAULT_RATIO = 9 / 19.5
