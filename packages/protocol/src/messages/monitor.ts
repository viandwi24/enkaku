import { z } from 'zod'

/**
 * The read-only device monitors (plan 24 §4.3, §3.7). This file is the ONLY
 * place a monitor's OPTIONS are typed — the command strings themselves are
 * built in exactly one other place, `packages/core/src/device/monitors.ts`,
 * from these validated shapes. There is no path from an operator's browser
 * to an arbitrary shell string: every value here is either an enum or is
 * shell-quoted before it ever reaches a device.
 */
/**
 * `crash` (plan 37 §4.1) is the crash watcher's own feed — `logcat -b
 * crash,main -v threadtime -T 1` (see `packages/core/src/device/monitors.ts`)
 * — read-only and fixed like every other kind here. It takes no options
 * (`optionsSchemaFor` below falls through to `EmptyMonitorOptionsSchema`), so
 * a human viewer who picks it in the Monitor tab and the always-on crash
 * watcher resolve to the exact same command and therefore the exact same
 * shared stream (plan 37 §3, acceptance #8) — there is nothing kind-specific
 * about sharing; it is the same (deviceId, kind, options) → one hub entry
 * rule every other monitor already gets.
 */
export const MonitorKindSchema = z.enum(['logcat', 'top', 'thermal', 'crash', 'ps', 'meminfo', 'df'])
export type MonitorKind = z.infer<typeof MonitorKindSchema>

/** Which kinds open a lane stream (§4.3) — the rest are one-shot request/response. */
export const STREAMING_MONITOR_KINDS: readonly MonitorKind[] = ['logcat', 'top', 'thermal', 'crash']
/** Runs once through the normal per-device queue and returns a single payload. */
export const ONE_SHOT_MONITOR_KINDS: readonly MonitorKind[] = ['ps', 'meminfo', 'df']

export const LogcatOptionsSchema = z.object({
  priority: z.enum(['V', 'D', 'I', 'W', 'E', 'F']).default('V').describe('Minimum log priority to include'),
  buffer: z.enum(['main', 'system', 'crash', 'events', 'all']).default('main').describe('Which logcat ring buffer to read'),
  /** Matched on the device with `grep -F`; shell-quoted, never interpolated raw (§4.3). */
  filter: z.string().max(200).optional().describe('Plain-text filter, matched with grep -F on the device'),
  tag: z
    .string()
    .regex(/^[A-Za-z0-9_.:-]{1,64}$/)
    .optional()
    .describe('Restrict to one logcat tag'),
})
export type LogcatOptions = z.infer<typeof LogcatOptionsSchema>

/** `top` and `thermal` take no options today; kept as an explicit empty object rather
 * than `undefined` so a monitor.start payload always has a consistent `options` shape. */
export const EmptyMonitorOptionsSchema = z.object({}).strict()

/**
 * The options shape for a given kind, resolved by `monitor.start` (§4.4).
 * `logcat` is the only kind with real options today; every other kind
 * accepts none, and passing any is rejected rather than silently ignored.
 */
export function optionsSchemaFor(kind: MonitorKind): z.ZodType {
  return kind === 'logcat' ? LogcatOptionsSchema : EmptyMonitorOptionsSchema
}
