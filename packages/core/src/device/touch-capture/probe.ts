import type { TouchProtocol } from '@enkaku/protocol'
import { ABS_MT_POSITION_X, ABS_MT_POSITION_Y, ABS_MT_PRESSURE, ABS_MT_SLOT, ABS_PRESSURE, ABS_X, ABS_Y, BTN_TOUCH } from './evdev'

/**
 * `getevent -pl`'s device table, parsed (plan 1000 §4.2) — pure, like every
 * other file in this directory.
 *
 * The probe answers the two questions the stream cannot: WHICH
 * `/dev/input/eventN` is a touch panel, and what its axis maxima are — the
 * divisor behind every normalised coordinate this feature reports. Without
 * it a stroke could only ever be raw panel counts, which mean nothing
 * without the panel.
 *
 * ```
 * add device 3: /dev/input/event3
 *   name:     "goodix_ts"
 *   events:
 *     KEY (0001): BTN_TOUCH
 *     ABS (0003): ABS_MT_SLOT           : value 0, min 0, max 9, fuzz 0, flat 0, resolution 0
 *                 ABS_MT_POSITION_X     : value 0, min 0, max 1079, fuzz 0, flat 0, resolution 0
 * ```
 *
 * Two shapes to keep in mind, both real:
 *
 * - The axis lines CONTINUE across lines with no `ABS (0003):` prefix, so an
 *   axis is recognised by its own `<name> : value …, min …, max …` tail and
 *   never by the prefix.
 * - `-l` is best-effort here too, so `0035 : value 0, min 0, max 1079` is the
 *   same axis as `ABS_MT_POSITION_X` and is read as one.
 */

/** A touch-capable input device, as the probe found it. */
export interface TouchPanelProfile {
  path: string
  name: string
  protocol: TouchProtocol
  maxX: number
  maxY: number
  /** `ABS_MT_PRESSURE`/`ABS_PRESSURE`'s maximum, when the panel reports pressure at all. */
  pressureMax: number | null
  /**
   * The farm's own UHID pointer rather than a finger.
   *
   * Matched on the device NAME, which `ScrcpyUhidInput` sets to
   * `Enkaku Pointer` (`packages/drivers/src/input/scrcpy-input.ts`) — it
   * binds to `hid-multitouch` and so appears here as an ordinary protocol-B
   * touch panel, indistinguishable from the glass by its axes alone. It is
   * reported, not filtered: comparing what the farm injected against what
   * the panel saw is the second thing this feature is for.
   */
  synthetic: boolean
}

/** Names that mean "not a finger" (see `TouchPanelProfile.synthetic`). */
const SYNTHETIC_NAME_RE = /enkaku|scrcpy|uhid|virtual/i

/** `add device 3: /dev/input/event3` */
const DEVICE_RE = /^add device \d+:\s*(\/dev\/input\/event\d+)\s*$/
/** `  name:     "goodix_ts"` */
const NAME_RE = /^\s*name:\s*"(.*)"\s*$/
/** `… ABS_MT_POSITION_X : value 0, min 0, max 1079, fuzz 0, flat 0, resolution 0` */
const AXIS_RE = /(\S+)\s*:\s*value\s+-?\d+,\s*min\s+(-?\d+),\s*max\s+(-?\d+)/
/** `    KEY (0001): BTN_TOUCH            BTN_TOOL_FINGER` */
const KEY_LINE_RE = /^\s*(?:KEY \(0001\):)?\s*(BTN_\S+|[0-9a-fA-F]{4}(?:\s+[0-9a-fA-F]{4})*)\s*$/

const AXIS_CODE_BY_NAME: Record<string, number> = {
  ABS_X,
  ABS_Y,
  ABS_PRESSURE,
  ABS_MT_SLOT,
  ABS_MT_POSITION_X,
  ABS_MT_POSITION_Y,
  ABS_MT_PRESSURE,
}

function axisCode(token: string): number | null {
  const named = AXIS_CODE_BY_NAME[token]
  if (named !== undefined) return named
  if (/^[0-9a-fA-F]{1,4}$/.test(token)) {
    const n = Number.parseInt(token, 16)
    return Number.isFinite(n) ? n : null
  }
  return null
}

interface Draft {
  path: string
  name: string
  axes: Map<number, number>
  hasBtnTouch: boolean
}

function finish(draft: Draft): TouchPanelProfile | null {
  const mtX = draft.axes.get(ABS_MT_POSITION_X)
  const mtY = draft.axes.get(ABS_MT_POSITION_Y)
  const stX = draft.axes.get(ABS_X)
  const stY = draft.axes.get(ABS_Y)

  let protocol: TouchProtocol
  let maxX: number | undefined
  let maxY: number | undefined
  if (mtX !== undefined && mtY !== undefined) {
    // A slot axis is what makes it protocol B: contacts are addressed by
    // slot and lifted with `ABS_MT_TRACKING_ID -1`. Without it the panel
    // is protocol A, which delimits contacts with `SYN_MT_REPORT` instead.
    protocol = draft.axes.has(ABS_MT_SLOT) ? 'mt-b' : 'mt-a'
    maxX = mtX
    maxY = mtY
  } else if (stX !== undefined && stY !== undefined && draft.hasBtnTouch) {
    // Single-touch. `BTN_TOUCH` is required here and not above on purpose:
    // ABS_X/ABS_Y alone is also what a joystick, a tablet's dial and several
    // sensors report, and admitting those would invent strokes from a device
    // nobody is touching.
    protocol = 'st'
    maxX = stX
    maxY = stY
  } else {
    return null
  }

  if (maxX === undefined || maxY === undefined || maxX <= 0 || maxY <= 0) return null
  const pressureMax = draft.axes.get(ABS_MT_PRESSURE) ?? draft.axes.get(ABS_PRESSURE) ?? null
  return {
    path: draft.path,
    name: draft.name,
    protocol,
    maxX,
    maxY,
    pressureMax: pressureMax !== null && pressureMax > 0 ? pressureMax : null,
    synthetic: SYNTHETIC_NAME_RE.test(draft.name),
  }
}

/** Every touch-capable device in a `getevent -pl` dump, in the order it listed them. */
export function parseTouchPanels(probeOutput: string): TouchPanelProfile[] {
  const found: TouchPanelProfile[] = []
  let draft: Draft | null = null

  const close = () => {
    if (!draft) return
    const profile = finish(draft)
    if (profile) found.push(profile)
    draft = null
  }

  for (const line of probeOutput.split('\n')) {
    const device = DEVICE_RE.exec(line.trimEnd())
    if (device?.[1]) {
      close()
      draft = { path: device[1], name: '', axes: new Map(), hasBtnTouch: false }
      continue
    }
    if (!draft) continue

    const name = NAME_RE.exec(line)
    if (name) {
      draft.name = name[1] ?? ''
      continue
    }

    const axis = AXIS_RE.exec(line)
    if (axis?.[1] && axis[3] !== undefined) {
      const code = axisCode(axis[1])
      if (code !== null) draft.axes.set(code, Number.parseInt(axis[3], 10))
      continue
    }

    const keys = KEY_LINE_RE.exec(line)
    if (keys?.[1]) {
      const touchHex = BTN_TOUCH.toString(16).padStart(4, '0')
      if (keys[1] === 'BTN_TOUCH' || keys[1].split(/\s+/).includes(touchHex)) draft.hasBtnTouch = true
      continue
    }
    // Android's own `getevent -pl` prints `BTN_TOUCH` among several codes on
    // one line, which the single-token rule above misses; a plain substring
    // check catches it without loosening that rule into matching prose.
    if (line.includes('BTN_TOUCH')) draft.hasBtnTouch = true
  }
  close()
  return found
}
