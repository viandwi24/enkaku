/**
 * The `getevent` line parser (plan 1000 §4.3) — pure, so the whole evdev
 * half of this feature is testable without a phone.
 *
 * `getevent -lt` is the only device-side command physical touch capture
 * runs, and it prints one line per kernel input event:
 *
 * ```
 * [   28065.685745] /dev/input/event3: EV_ABS       ABS_MT_POSITION_X    000002a5
 * ```
 *
 * Three things about that format cost real debugging time if they are not
 * handled here, all three seen in the wild on Android phones:
 *
 * 1. **`-l` is best-effort.** toybox's `getevent` prints the NAME of a type
 *    or code it knows and the raw hex of one it does not, per field, in the
 *    same run — so a line can be half-labelled (`EV_ABS  003c  00000001`).
 *    Both forms are resolved to numbers here; a consumer never sees a label.
 * 2. **The value is an unsigned hex rendering of a SIGNED 32-bit int.**
 *    `ABS_MT_TRACKING_ID`'s lift-off value is `ffffffff`, which is -1 — read
 *    as unsigned it is 4294967295, a perfectly plausible tracking id, and
 *    every contact stays "down" for ever.
 * 3. **The timestamp is `CLOCK_MONOTONIC`, not wall clock.** It is the exact
 *    clock for every interval this feature reports; mapping it to a wall
 *    clock happens once per stream, at a single anchor point, and nowhere
 *    else (`TouchStroke.at`, see `messages/touch-capture.ts`).
 *
 * Lines that are not events at all — `add device 1: /dev/input/event3`, the
 * `name:` line under it, a blank line — return `null` rather than throwing:
 * this parser is fed a live stream, and a stream that dies on an unexpected
 * line is a stream that dies.
 */

/** One kernel input event, normalised out of whatever shape `getevent` printed it in. */
export interface EvdevEvent {
  /** `/dev/input/eventN`. */
  path: string
  /** The device's monotonic clock in ms, or `null` when the stream was opened without `-t`. */
  tsMs: number | null
  type: number
  code: number
  /** Signed, as the kernel meant it. */
  value: number
}

export const EV_SYN = 0x00
export const EV_KEY = 0x01
export const EV_ABS = 0x03

export const SYN_REPORT = 0x00
export const SYN_MT_REPORT = 0x02

export const BTN_TOUCH = 0x14a

export const ABS_X = 0x00
export const ABS_Y = 0x01
export const ABS_PRESSURE = 0x18
export const ABS_MT_SLOT = 0x2f
export const ABS_MT_POSITION_X = 0x35
export const ABS_MT_POSITION_Y = 0x36
export const ABS_MT_TRACKING_ID = 0x39
export const ABS_MT_PRESSURE = 0x3a

/** The labels this parser resolves. Deliberately short: only what the stroke assembler acts on — anything else is passed through as its numeric code and ignored downstream. */
const TYPE_BY_NAME: Record<string, number> = {
  EV_SYN,
  EV_KEY,
  EV_ABS,
}

const CODE_BY_NAME: Record<string, number> = {
  SYN_REPORT,
  SYN_MT_REPORT,
  BTN_TOUCH,
  ABS_X,
  ABS_Y,
  ABS_PRESSURE,
  ABS_MT_SLOT,
  ABS_MT_POSITION_X,
  ABS_MT_POSITION_Y,
  ABS_MT_TRACKING_ID,
  ABS_MT_PRESSURE,
}

/** `[   28065.685745] /dev/input/event3: <type> <code> <value>` — the timestamp group is optional (`getevent -l` with no `-t`). */
const LINE_RE = /^(?:\[\s*(\d+\.\d+)\s*\]\s*)?(\/dev\/input\/event\d+):\s+(\S+)\s+(\S+)\s+(\S+)\s*$/

/**
 * The value column, which is not always a number.
 *
 * `getevent -l` prints a KEY event's value as the WORDS `DOWN` and `UP`
 * (AOSP's own `getevent.c`, and toybox's), not as `00000001`/`00000000`.
 * Reading it as hex fails on both — `DOWN` is not hex at all — so a
 * single-touch panel, whose contacts are delimited by `BTN_TOUCH` and
 * nothing else, would report no strokes whatsoever while the labelled
 * stream looked perfectly healthy.
 *
 * Everything else is hex, and it is an UNSIGNED rendering of a SIGNED
 * 32-bit value — see this file's header, point 2.
 */
function parseValue(token: string): number | null {
  if (token === 'DOWN') return 1
  if (token === 'UP') return 0
  if (!/^[0-9a-fA-F]{1,8}$/.test(token)) return null
  const raw = Number.parseInt(token, 16)
  if (!Number.isFinite(raw)) return null
  return raw > 0x7fffffff ? raw - 0x100000000 : raw
}

function resolve(token: string, byName: Record<string, number>): number | null {
  const named = byName[token]
  if (named !== undefined) return named
  // A code `-l` did not know, printed as bare hex (no `0x`): `003c`.
  if (/^[0-9a-fA-F]{1,8}$/.test(token)) {
    const n = Number.parseInt(token, 16)
    return Number.isFinite(n) ? n : null
  }
  // A label this parser does not care about (`ABS_MT_TOUCH_MAJOR`, `KEY_POWER`).
  return null
}

/** One line in, one event out — or `null` for anything that is not an event line. */
export function parseEvdevLine(line: string): EvdevEvent | null {
  const m = LINE_RE.exec(line.trimEnd())
  if (!m) return null
  const [, ts, path, typeTok, codeTok, valueTok] = m
  if (!path || !typeTok || !codeTok || valueTok === undefined) return null
  const type = resolve(typeTok, TYPE_BY_NAME)
  if (type === null) return null
  const code = resolve(codeTok, CODE_BY_NAME)
  if (code === null) return null
  const value = parseValue(valueTok)
  if (value === null) return null
  return {
    path,
    // `ts` is seconds with microsecond precision; ms keeps every digit that matters and matches every other duration in this codebase.
    tsMs: ts === undefined ? null : Math.round(Number.parseFloat(ts) * 1000 * 1000) / 1000,
    type,
    code,
    value,
  }
}
