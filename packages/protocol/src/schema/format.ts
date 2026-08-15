import type { DurationUnit, ParamKind } from './vocabulary'

/**
 * The numeric kinds, minus the two string-only ones, plus `'plain'` — the
 * "no semantic kind" case a bare `z.number()` (or an invalid/unrecognised
 * kind) lands on at row 9 of the resolver's precedence table
 * (`packages/studio/src/components/schema-form/plan.ts`). `kind` is never
 * optional on a `number` plan (plan 95 §4.5): a control always has SOME
 * answer for "how do I format this value", and `'plain'` is that answer
 * when nothing more specific was said. Moved here from Studio's `plan.ts`
 * (plan 97 §4.1) alongside `formatValue`, since a `NumberKind` is meaning,
 * not a control — the same boundary that let `formatValue` itself move.
 */
export type NumberKind = Exclude<ParamKind, 'text' | 'packageName'> | 'plain'

/** `12` → `"12"`, `12.5` → `"12.5"`, `12.50000001` → `"12.5"` — the readout
 *  never shows more precision than the value actually carries, and never
 *  trailing zeros from a floating-point division (`§4.6`'s bytes/bitrate
 *  math in particular). */
function trimNumber(n: number): string {
  if (Number.isInteger(n)) return String(n)
  return n.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')
}

function toMs(value: number, unit: DurationUnit): number {
  switch (unit) {
    case 'ms':
      return value
    case 's':
      return value * 1_000
    case 'min':
      return value * 60_000
    case 'h':
      return value * 3_600_000
  }
}

/** `90000` + `'ms'` → `"1 min 30 s"`; `5` + `'s'` → `"5 s"` (plan 95 §5 step
 *  95.3's own worked examples). Shows the largest two non-zero units — a
 *  compound readout beats either a single huge unit ("1.5 min") or a raw
 *  millisecond count nobody can read at a glance. */
function formatDuration(value: number, unit: DurationUnit): string {
  const totalMs = toMs(value, unit)
  if (Math.abs(totalMs) < 1_000) return `${trimNumber(totalMs)} ms`
  const totalSeconds = totalMs / 1_000
  const h = Math.trunc(totalSeconds / 3_600)
  const m = Math.trunc((totalSeconds % 3_600) / 60)
  const s = totalSeconds % 60
  const parts: string[] = []
  if (h !== 0) parts.push(`${h} h`)
  if (m !== 0) parts.push(`${m} min`)
  if (s !== 0 || parts.length === 0) parts.push(`${trimNumber(s)} s`)
  return parts.slice(0, 2).join(' ')
}

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const

/** `536870912` → `"512 MB"` — binary units (1024), matching how the values
 *  themselves are computed (`z.number()` byte caps are always powers of
 *  1024 in this repo: `maxPushBytes`, `maxImageBytes`, ...). */
function formatBytes(value: number): string {
  if (value === 0) return '0 B'
  const sign = value < 0 ? '-' : ''
  let abs = Math.abs(value)
  let unit = 0
  while (abs >= 1024 && unit < BYTE_UNITS.length - 1) {
    abs /= 1024
    unit++
  }
  return `${sign}${trimNumber(abs)} ${BYTE_UNITS[unit]}`
}

const BIT_UNITS = ['bps', 'Kbps', 'Mbps', 'Gbps'] as const

/** `6000000` → `"6 Mbps"` — decimal units (1000): bitrate is conventionally
 *  SI, unlike a byte size. */
function formatBitrate(value: number): string {
  if (value === 0) return '0 bps'
  const sign = value < 0 ? '-' : ''
  let abs = Math.abs(value)
  let unit = 0
  while (abs >= 1000 && unit < BIT_UNITS.length - 1) {
    abs /= 1000
    unit++
  }
  return `${sign}${trimNumber(abs)} ${BIT_UNITS[unit]}`
}

function formatScalar(kind: NumberKind, unit: DurationUnit | undefined, value: number): string {
  switch (kind) {
    case 'count':
    case 'plain':
      return trimNumber(value)
    case 'chance':
      // The vocabulary FIXES a chance's domain to [0,1] (plan 95 §3.2) — the
      // percentage sign is purely a rendering choice, never a stored unit.
      return `${Math.round(value * 100)}%`
    case 'duration':
      return formatDuration(value, unit ?? 'ms')
    case 'bytes':
      return formatBytes(value)
    case 'bitrate':
      return formatBitrate(value)
    case 'pixels':
      return `${trimNumber(value)} px`
    case 'temperature':
      return `${trimNumber(value)} °C`
  }
}

/**
 * The one formatter behind every control's label-row readout (plan 95 §4.6,
 * §5 step 95.3). `kind` says what a value MEANS (§3.2); this says how a
 * person reads it — it never changes what is STORED or SUBMITTED. Bytes and
 * bitrates in particular keep their raw integer end to end (§4.6's own last
 * line: "no unit conversion on input, so no rounding subsystem and no value
 * the schema's bounds would reject") — this only touches the text beside
 * the label.
 *
 * Total: a non-number (an untouched, still-`undefined` field) reads as
 * `"—"` rather than `"NaN"` or a blank — an empty control with no visible
 * value is worse than a plain one (this step's own judgement call).
 *
 * A 2-element array (`PairControl`'s value) formats each half and joins
 * them with `" ~ "` — `formatValue('duration', 's', [5, 20])` →
 * `"5 s ~ 20 s"` — so a pair needs no formatter of its own.
 */
export function formatValue(kind: NumberKind, unit: DurationUnit | undefined, value: unknown): string {
  if (Array.isArray(value)) {
    if (value.length !== 2) return '—'
    const [lo, hi] = value
    if (typeof lo !== 'number' && typeof hi !== 'number') return '—'
    return `${formatValue(kind, unit, lo)} ~ ${formatValue(kind, unit, hi)}`
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
  return formatScalar(kind, unit, value)
}
