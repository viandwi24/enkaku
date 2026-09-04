/**
 * The handoff's own width formula (README.md:240-241): the cast column is
 * sized from the device's live aspect ratio so it fits the window height
 * without overflowing, then the 52px rail and the 274px info column are
 * added. Derived from the LIVE stream size, never from
 * `DeviceInfo.screenW/screenH`, which goes stale on rotation (plan 215 §3.2 D3).
 *
 * The handoff fixed the height at 640px, which made the width a pure function
 * of the ratio and left the window unresizable. The CEO asked for resize back
 * on 2026-09-04, so the height is now an input and the SAME formula derives
 * the width from it. That is what keeps the promise the fixed height was
 * protecting: the cast column always fits, so the picture is never cropped
 * and never floats in dead space, whatever size the operator drags to.
 */
export const RAIL_WIDTH_PX = 52
export const INFO_WIDTH_PX = 274
/** The cast column's own floor and the height budget the 560 comes from. */
export const CAST_MIN_WIDTH_PX = 380

/** The handoff's window height, and the default a farm starts at. */
export const DEFAULT_WINDOW_HEIGHT_PX = 640
/** Header, tab strip and padding above and below the cast — `640 - 560` in the handoff's own numbers. */
export const WINDOW_CHROME_PX = 80
/** Below this the info column's rows stop fitting; above it the cast outgrows any laptop. */
export const MIN_WINDOW_HEIGHT_PX = 420
export const MAX_WINDOW_HEIGHT_PX = 1400

/** The cast column's height inside a window `height` tall. */
export function castHeightPx(height: number): number {
  return Math.max(height - WINDOW_CHROME_PX, 0)
}

/** `max(castHeight * (w/h) + 36, 380)`. */
export function castWidthPx(ratio: number, height: number = DEFAULT_WINDOW_HEIGHT_PX): number {
  return Math.max(castHeightPx(height) * ratio + 36, CAST_MIN_WIDTH_PX)
}

/** The whole window: the cast column plus the rail and the info column. */
export function windowWidthPx(ratio: number, height: number = DEFAULT_WINDOW_HEIGHT_PX): number {
  return castWidthPx(ratio, height) + RAIL_WIDTH_PX + INFO_WIDTH_PX
}

/** Clamp a dragged height to what the window and the viewport can both carry. */
export function clampWindowHeight(height: number, viewportHeight: number): number {
  const ceiling = Math.min(MAX_WINDOW_HEIGHT_PX, Math.max(MIN_WINDOW_HEIGHT_PX, viewportHeight - 48))
  return Math.min(Math.max(height, MIN_WINDOW_HEIGHT_PX), ceiling)
}

/** Before the first frame: a 9:19.5 phone, which resolves to the 380px floor and a 706px window. */
export const DEFAULT_RATIO = 9 / 19.5
