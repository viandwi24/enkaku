import { desc, eq } from 'drizzle-orm'
import type { JobTraceEvent } from '@enkaku/protocol'
import type { Db } from '../../db'
import { jobEvents, type JobEventInsert } from '../../db/schema'
import { createLogger } from '../../util/logger'

const log = createLogger('jobs.trace')

/**
 * Everything `record()` needs. `id` and `seq` are the RECORDER's to assign
 * and are deliberately absent here — see `createTraceRecorder`'s doc on why
 * this module is the single `seq` authority. `atMs` may be supplied because
 * only the caller knows the instant an event really happened.
 */
export interface TraceRecordInput {
  jobId: string
  /** Unix MILLISECONDS. Defaults to `Date.now()` — pass it explicitly when the event's real instant is earlier than the moment it reaches the recorder (an action's frame settles after the action did). */
  atMs?: number
  /** 1-based; a rebound job has more than one. Defaults to 1. */
  attempt?: number
  phase?: JobTraceEvent['phase']
  nodeId?: string | null
  kind: JobTraceEvent['kind']
  name: string
  durationMs?: number | null
  ok?: boolean | null
  errorCode?: string | null
  meta?: Record<string, unknown> | null
  frameHash?: string | null
  frameStatus?: JobTraceEvent['frameStatus']
  uiHash?: string | null
}

export interface TraceRecorder {
  /**
   * Fire-and-forget. Buffered; NEVER awaits the database, and never throws —
   * a script's device call must not pay for a SQLite insert (plan 128 §3.6).
   * Returns the event it just published, so a caller that needs the assigned
   * `id`/`seq` has them without a read-back.
   */
  record(e: TraceRecordInput): JobTraceEvent
  /**
   * Writes everything buffered right now. Called when a job settles, so a
   * finished job's timeline is complete the instant its status changes
   * (plan 128 §3.6, step 128.5) — a Timeline tab opened on the job the
   * millisecond it turns `failed` must not be missing its last 250 ms.
   *
   * `jobId` also releases that job's in-memory `seq` counter: the buffer is
   * empty afterwards, so the next event for the same id re-seeds from the
   * rows already on disk (see `nextSeq`) rather than restarting at 1.
   */
  flush(jobId?: string): void
  /** Flush and stop — called on daemon shutdown. */
  stop(): Promise<void>
}

/**
 * Buffers job trace events in memory and flushes them in one transaction, on
 * a timer or when the buffer fills — whichever comes first. Modelled on
 * `events/recorder.ts`, which already solved exactly this for `device_events`
 * (plan 18 §3.5), with the same defaults and the same two rules:
 *
 * - **`record()` never awaits the database.** The tee that calls it sits one
 *   line away from a script's device call (plan 128 §3.1), and the whole
 *   design constraint is the owner's: *"async aja intinya jangan sampai
 *   mengganggu script nya jalan."*
 * - **`publish` fires synchronously, before the row is written.** The live
 *   `job.trace` tail must feel instant, and losing an unflushed batch to a
 *   hard crash is an accepted loss for this log class.
 *
 * Two things this recorder needs that the device-event one does not:
 *
 * - **`seq`** — per-job monotonic, assigned here rather than taken from the
 *   clock (§3.3), because `(job_id, seq)` is a UNIQUE index, the sort key,
 *   and the keyset cursor. It is seeded from the highest `seq` already stored
 *   for that job, so a job whose events were written by an earlier process
 *   (a daemon restarted mid-run, a rebound job) continues the sequence
 *   instead of colliding with it.
 *
 *   This recorder is the ONLY `seq` authority, and that is load-bearing. The
 *   per-attempt tee in `@enkaku/session` (step 128.3) numbers events for its
 *   own attempt; a rebound job builds a second tee for the SAME job id, and
 *   two independent counters both starting at 1 would fail the unique index
 *   on every event of the second attempt. So a caller may hand `record()` a
 *   fully-shaped event — `id` and `seq` on it are ignored and reassigned, and
 *   the event this function RETURNS (not the one passed in) is the one that
 *   was published and stored.
 * - **A flush that cannot take the daemon down.** A batch is written inside a
 *   `try`: this table has a unique index and flushes run from a timer
 *   callback, where an uncaught throw is an unhandled rejection rather than a
 *   failed request. A trace is diagnostic data — dropping a batch with a
 *   logged error is correct; killing the farm's daemon over it is not.
 */
export function createTraceRecorder(deps: {
  db: Db
  /** Fan an event out to subscribed WS clients as `job.trace`. Called synchronously from `record()`. */
  publish: (jobId: string, ev: JobTraceEvent) => void
  flushIntervalMs?: number
  maxBufferedRows?: number
}): TraceRecorder {
  const flushIntervalMs = deps.flushIntervalMs ?? 250
  const maxBufferedRows = deps.maxBufferedRows ?? 200

  let buffer: JobEventInsert[] = []
  let timer: ReturnType<typeof setTimeout> | null = null
  let stopped = false
  /** Per-job `seq` cursor; seeded lazily from the DB and released on `flush(jobId)`. */
  const seqByJob = new Map<string, number>()

  function nextSeq(jobId: string): number {
    const known = seqByJob.get(jobId)
    if (known !== undefined) {
      const next = known + 1
      seqByJob.set(jobId, next)
      return next
    }
    // First event for this job in this process. `(job_id, seq)` is unique, so
    // starting at 1 blindly would make the whole batch fail to insert for any
    // job that already has rows. The index makes this a one-row lookup.
    const highest = deps.db
      .select({ seq: jobEvents.seq })
      .from(jobEvents)
      .where(eq(jobEvents.jobId, jobId))
      .orderBy(desc(jobEvents.seq))
      .limit(1)
      .get()
    const next = (highest?.seq ?? 0) + 1
    seqByJob.set(jobId, next)
    return next
  }

  function writeBuffered(): void {
    if (buffer.length === 0) return
    const batch = buffer
    buffer = []
    try {
      // One transaction per flush, not one per event (plan 128 §3.6).
      deps.db.transaction((tx) => {
        tx.insert(jobEvents).values(batch).run()
      })
    } catch (err) {
      log.error('dropped a trace batch', { rows: batch.length, jobId: batch[0]?.jobId, err: String(err) })
    }
  }

  function flushNow(): void {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    writeBuffered()
  }

  function scheduleFlush(): void {
    if (timer || stopped) return
    timer = setTimeout(flushNow, flushIntervalMs)
  }

  return {
    record(e) {
      // A stopped recorder writes nothing and publishes nothing, but it must
      // not throw at a call site that is one line from a device call — and it
      // must not burn a `seq` either, so the counter is never touched here.
      const event: JobTraceEvent = {
        id: crypto.randomUUID(),
        jobId: e.jobId,
        seq: stopped ? 0 : nextSeq(e.jobId),
        atMs: e.atMs ?? Date.now(),
        attempt: e.attempt ?? 1,
        phase: e.phase ?? null,
        nodeId: e.nodeId ?? null,
        kind: e.kind,
        name: e.name,
        durationMs: e.durationMs ?? null,
        ok: e.ok ?? null,
        errorCode: e.errorCode ?? null,
        meta: e.meta ?? null,
        frameHash: e.frameHash ?? null,
        frameStatus: e.frameStatus ?? null,
        uiHash: e.uiHash ?? null,
      }
      if (stopped) return event
      buffer.push({ ...event })
      // Before the write, always — see this module's doc. Guarded because
      // `publish` fans out to WS clients: a broadcast that throws must not
      // travel back up into a running script's device call.
      try {
        deps.publish(e.jobId, event)
      } catch (err) {
        log.warn('trace publish failed', { jobId: e.jobId, seq: event.seq, err: String(err) })
      }
      if (buffer.length >= maxBufferedRows) flushNow()
      else scheduleFlush()
      return event
    },

    flush(jobId) {
      flushNow()
      if (jobId !== undefined) seqByJob.delete(jobId)
    },

    async stop() {
      stopped = true
      flushNow()
      seqByJob.clear()
    },
  }
}
