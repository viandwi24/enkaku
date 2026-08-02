import { Cron } from 'croner'

/**
 * A thin wrapper over croner (plan 21 §3.1, §21.3). Only the parsing and
 * next-occurrence part of croner is used — the firing loop is ours
 * (`runner.ts`), because a library timer that lives in memory cannot answer
 * "what should have fired while the process was down".
 *
 * croner resolves timezones through the built-in `Intl` API and defines DST
 * behaviour itself: a fire time that falls in a DST gap resolves forward to
 * the next valid wall-clock instant (it never fires twice for one nominal
 * slot), and one in a DST overlap fires exactly once, at the first
 * occurrence — verified with fixed timestamps in `cron.test.ts`. This wrapper
 * adds nothing on top of that except turning a throw into a typed result — a
 * cron field with no preview, or one that silently crashes the runner on a
 * typo, is a trap (plan 21 §4.4).
 */

export type CronResult<T> = { ok: true; value: T } | { ok: false; error: string }

function toEpochSec(d: Date): number {
  return Math.floor(d.getTime() / 1000)
}

function buildCron(expr: string, timezone: string): Cron | { error: string } {
  try {
    return new Cron(expr, { timezone })
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

/** The next `count` fire times (unix seconds) at or after `from`, in `timezone`. */
export function nextFires(expr: string, timezone: string, count: number, from: Date = new Date()): CronResult<number[]> {
  const cron = buildCron(expr, timezone)
  if ('error' in cron) return { ok: false, error: cron.error }
  try {
    const dates = cron.nextRuns(count, from)
    return { ok: true, value: dates.map(toEpochSec) }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** A single next fire time (unix seconds) strictly after `from`, or null if the pattern never fires again. */
export function nextFire(expr: string, timezone: string, from: Date = new Date()): CronResult<number | null> {
  const cron = buildCron(expr, timezone)
  if ('error' in cron) return { ok: false, error: cron.error }
  try {
    const date = cron.nextRun(from)
    return { ok: true, value: date ? toEpochSec(date) : null }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

// A hard cap so a pathological pattern (a per-second cron over a multi-year
// gap) cannot spin the startup catch-up pass forever (plan 21 §3.4).
const MAX_COUNTED_OCCURRENCES = 10_000

/**
 * How many times `expr` would have fired strictly after `from`, up to and
 * including `to` (plan 21 §3.4, §21.3). Used only at startup, to size the
 * catch-up decision — never to replay them.
 */
export function occurrencesBetween(expr: string, timezone: string, from: Date, to: Date): CronResult<number> {
  const cron = buildCron(expr, timezone)
  if ('error' in cron) return { ok: false, error: cron.error }
  try {
    let count = 0
    let cursor: Date = from
    const toMs = to.getTime()
    while (count < MAX_COUNTED_OCCURRENCES) {
      const next = cron.nextRun(cursor)
      if (!next || next.getTime() > toMs) break
      count++
      cursor = next
    }
    return { ok: true, value: count }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
