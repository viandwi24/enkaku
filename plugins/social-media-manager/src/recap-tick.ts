import { RECAP_CONCURRENCY_DEFAULT } from './recap'

/**
 * Which recap reads this tick sends, and which have waited long enough to give up on.
 *
 * Split out of the router for the reason `warmup-tick.ts` was: everything here
 * has to be right, and a service function that reads, calls and writes cannot
 * be asked a question directly. The router owns the round trips; this owns the
 * decisions.
 *
 * ## The pacing, and why it is a cap and not a delay
 *
 * The first version sent a read to every online phone in a single tick. On the
 * owner's production fleet that is seventy-three apps, seventy-three inspector
 * sessions and seventy-three jobs at one instant — for the least urgent work
 * this plugin does. *"sya di prod 73 devices itu langsung jalan semua
 * serentak"*, 2026-09-21.
 *
 * The fix is a limit on reads IN FLIGHT, not a sleep between batches. A delay
 * has to guess how long a read takes: too short and the next batch lands on
 * top of the last, too long and the farm sits idle between them, and the right
 * guess differs per platform and per phone. A cap needs no guess — a slot
 * frees the moment a phone answers, and the next tick fills it.
 *
 * ## Why expiry keeps scanning after the budget is spent
 *
 * A full send budget must not stop the pass from noticing reads that have been
 * waiting hours for a phone that is never coming back. Those are two different
 * jobs sharing one loop, and stopping the loop at the budget would mean a busy
 * farm never expires anything.
 */

/** Only what a decision needs. The router's rows carry far more. */
export interface RecapCandidate {
  key: string
  deviceId: string
  state: string
  jobId: string
  /** When the read was asked for, or last moved — unix seconds. */
  readAt: number
}

export interface RecapTickPlan<T> {
  /** Reads to send, in order, already within the limit and never two for one phone. */
  send: T[]
  /** Queued reads whose phone has not appeared inside the wait budget. */
  expire: T[]
  /** How many reads are out once this tick's sends are counted — what the router logs. */
  outstanding: number
}

export function planRecapTick<T extends RecapCandidate>(input: {
  rows: readonly T[]
  online: ReadonlySet<string>
  /** Phones already spoken for this tick by the post and warm-up passes. */
  claimed: ReadonlySet<string>
  limit?: number
  now: number
  waitMaxSec: number
}): RecapTickPlan<T> {
  const limit = Math.max(1, input.limit ?? RECAP_CONCURRENCY_DEFAULT)
  const send: T[] = []
  const expire: T[] = []

  /*
    Reads already out. Counted from the rows the router has just SETTLED, so a
    phone that answered this tick frees its slot now rather than in fifteen
    seconds' time.
  */
  const busy = new Set<string>(input.claimed)
  let outstanding = 0
  for (const row of input.rows) {
    if (row.state !== 'reading' || row.jobId === '') continue
    busy.add(row.deviceId)
    outstanding += 1
  }

  for (const row of input.rows) {
    if (row.state !== 'reading' || row.jobId !== '') continue
    if (!input.online.has(row.deviceId)) {
      /*
        A read waits for its phone rather than being refused on the spot — a
        fleet is never all online at once, and a phone that appears in an hour
        should be read then. But it cannot wait for ever, or a recap aimed at
        every phone leaves a row saying "waiting" for each phone that has gone
        for good, with nothing on the page to tell those from the ones still to
        come.
      */
      if (input.now - row.readAt > input.waitMaxSec) expire.push(row)
      continue
    }
    if (outstanding >= limit) continue
    // One read per phone: the three platforms queue behind each other rather
    // than three apps fighting over one screen.
    if (busy.has(row.deviceId)) continue
    busy.add(row.deviceId)
    outstanding += 1
    send.push(row)
  }

  return { send, expire, outstanding }
}
