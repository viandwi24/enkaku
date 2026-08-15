import { and, asc, desc, eq } from 'drizzle-orm'
import type { BatchStatusEvent } from '@enkaku/protocol'
import { batches, jobs, type BatchRow, type JobRow } from '../db/schema'
import type { Db } from '../db'
import type { JobStore } from '../queue/job-store'
import { recomputeBatchStatus } from './status'
import type { Scheduler } from '../queue/scheduler'
import type { Logger } from '../util/logger'

/**
 * A batch's repeating clock (plan 94 §3.7, §3.8, §4.8, step 94.7). Nothing
 * here special-cases an unpaced batch (`repeatCount: 1`, every interval
 * field `0`) — the same math just produces a single, unstaggered repetition,
 * which is today's behaviour exactly (§4.9's `pacing` default).
 *
 * The house rule this file follows (F29, `clusters/dispatch.ts`'s own
 * `shuffle` — "nothing depends on a random number that no longer exists"):
 * every draw is materialised on the row it governs BEFORE it is used for
 * anything, never re-derived from a seed. A seeded PRNG was considered and
 * rejected for the same reason `dispatch.ts` rejected one for `order:
 * 'random'` — see plan 94 §3.7's own paragraph.
 */
export interface BatchPacer {
  /** Repetition 0 for every device, with the stagger baked into `notBefore` (plan 94 §3.8). */
  planFirst(batchId: string): void
  /** Called from `recomputeBatchStatus` (F32) when a member settles — the ONE hook, never a second loop. */
  onMemberSettled(batchId: string, deviceId: string): void
  /** Arms one timer at the earliest future `notBefore` across all jobs. */
  rearm(): void
  /** Clears the timer — every process this thing starts is dead after this returns (00-overview §7). */
  stop(): void
}

export interface BatchPacerDeps {
  db: Db
  scheduler: Scheduler
  log: Logger
  /**
   * Testability seam. The real source is `crypto.getRandomValues` (F29) —
   * NEVER `Math.random()`, per the owner's own explicit ask (plan 94's
   * brief: "the draw must be honestly random"). A fake here lets a test
   * prove the draw lands in `[min, max]` and that a fixed sequence is
   * honoured, without depending on the platform RNG's actual entropy.
   */
  randomUint32?: () => number
  /** Testability seam — the real source is `Date.now`. */
  clock?: () => Date
  /** How far ahead the fallback timer is allowed to drift before rearming anyway (ms). Defaults to 2 minutes, matching `schedules/runner.ts`'s own fallback tick order of magnitude. */
  fallbackIntervalMs?: number
}

function defaultRandomUint32(): number {
  const arr = new Uint32Array(1)
  crypto.getRandomValues(arr)
  return arr[0] as number
}

/**
 * A uniform draw in `[min, max]` (inclusive), from a uint32 source (F29).
 * `max <= min` (including the `intervalMs: [0, 0]` default) returns `min`
 * with no draw at all — there is nothing to randomise.
 */
export function drawIntervalMs(min: number, max: number, randomUint32: () => number = defaultRandomUint32): number {
  if (max <= min) return min
  const span = max - min + 1
  return min + (randomUint32() % span)
}

const NON_PLANNING_STATUS = new Set(['stopping', 'success', 'failed', 'cancelled'])

/** Fresh row for one more repetition, copying the template's dispatch-time fields and resetting every execution-time one — the same shape `clusters/dispatch.ts`'s own `toJobRow` builds for repetition 0. */
function nextRepeatJobRow(template: JobRow, opts: { now: Date; notBeforeSec: number; batchRepeat: number; pacedDelayMs: number }): JobRow {
  return {
    ...template,
    id: crypto.randomUUID(),
    status: 'queued',
    leaseExpiresAt: null,
    result: null,
    error: null,
    createdAt: opts.now,
    startedAt: null,
    finishedAt: null,
    notBefore: opts.notBeforeSec,
    batchRepeat: opts.batchRepeat,
    pacedDelayMs: opts.pacedDelayMs,
    failureClass: null,
    errorPhase: null,
    infraAttempts: 0,
    triggeredByJobId: null,
    rootJobId: null,
    depth: 0,
    triggerKey: null,
    peakRssBytes: null,
    assistCount: 0,
    resultStatus: null,
    resultBytes: null,
    resultSummary: null,
    resultIssues: null,
  }
}

export function createBatchPacer(deps: BatchPacerDeps): BatchPacer {
  const random = deps.randomUint32 ?? defaultRandomUint32
  const clock = deps.clock ?? (() => new Date())
  const fallbackIntervalMs = deps.fallbackIntervalMs ?? 120_000
  let timer: ReturnType<typeof setTimeout> | null = null

  const nowMs = (): number => clock().getTime()
  const nowSec = (): number => Math.floor(nowMs() / 1000)

  function loadBatch(batchId: string): BatchRow | null {
    return deps.db.select().from(batches).where(eq(batches.id, batchId)).get() ?? null
  }

  function isPaced(batch: BatchRow): boolean {
    return batch.repeatCount > 1 || batch.deviceIntervalMs > 0
  }

  function planFirst(batchId: string): void {
    const batch = loadBatch(batchId)
    if (!batch || !isPaced(batch)) return
    const members = deps.db.select().from(jobs).where(eq(jobs.batchId, batchId)).orderBy(asc(jobs.batchSeq)).all()
    const now = nowSec()
    for (let i = 0; i < members.length; i++) {
      const member = members[i] as JobRow
      // The stagger is a phase offset applied ONCE, at a device's first
      // repetition (plan 94 §3.8) — deterministic in the device's dispatch
      // order (`batchSeq`), not drawn: device n starts ~n * deviceIntervalMs
      // after device 0.
      const staggerMs = i * batch.deviceIntervalMs
      deps.db
        .update(jobs)
        .set({
          notBefore: staggerMs > 0 ? now + Math.round(staggerMs / 1000) : member.notBefore,
          batchRepeat: 0,
          pacedDelayMs: staggerMs > 0 ? staggerMs : member.pacedDelayMs,
        })
        .where(eq(jobs.id, member.id))
        .run()
    }
    deps.log.info(`batch ${batchId}: planned repetition 0 for ${members.length} device(s), stagger ${batch.deviceIntervalMs}ms`)
    rearm()
  }

  function onMemberSettled(batchId: string, deviceId: string): void {
    const batch = loadBatch(batchId)
    if (!batch) return
    // §3.9: no further repetition is EVER planned once the batch is
    // stopping, and none is needed once it has already reached a terminal
    // outcome. This is the FIRST thing checked, so there is no window in
    // which a repetition sneaks in after a stop was requested.
    if (NON_PLANNING_STATUS.has(batch.status)) return
    if (!isPaced(batch)) return

    const deviceJobs = deps.db
      .select()
      .from(jobs)
      .where(and(eq(jobs.batchId, batchId), eq(jobs.deviceId, deviceId)))
      .orderBy(desc(jobs.batchRepeat))
      .all()
    if (deviceJobs.length === 0) return
    const last = deviceJobs[0] as JobRow
    const completed = deviceJobs.length
    if (completed >= batch.repeatCount) return
    const nextRepeat = (last.batchRepeat ?? 0) + 1
    if (nextRepeat >= batch.repeatCount) return

    const delayMs = drawIntervalMs(batch.intervalMinMs, batch.intervalMaxMs, random)
    const now = nowSec()
    const row = nextRepeatJobRow(last, {
      now: clock(),
      notBeforeSec: now + Math.round(delayMs / 1000),
      batchRepeat: nextRepeat,
      pacedDelayMs: delayMs,
    })
    deps.db.insert(jobs).values(row).run()
    deps.log.info(`batch ${batchId}: device ${deviceId} repetition ${nextRepeat}/${batch.repeatCount - 1} planned, waiting ${delayMs}ms`)
    rearm()
    deps.scheduler.kick()
  }

  function rearm(): void {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    // Every non-terminal, non-stopping paced batch's jobs — the earliest
    // future `notBefore` across all of them is when the pacer next has
    // anything to do. `claimNext`'s own 2s fallback tick already covers the
    // "no timer at all" case (§3.8) — this timer only tightens the latency
    // for a sub-2s stagger; it is never the only thing standing between a
    // job and getting claimed.
    const rows = deps.db.select({ notBefore: jobs.notBefore }).from(jobs).where(eq(jobs.status, 'queued')).all()
    let earliestSec: number | null = null
    for (const r of rows) {
      if (r.notBefore == null) continue
      if (earliestSec === null || r.notBefore < earliestSec) earliestSec = r.notBefore
    }
    if (earliestSec === null) return
    const delayMs = Math.min(fallbackIntervalMs, Math.max(0, earliestSec * 1000 - nowMs()))
    timer = setTimeout(() => deps.scheduler.kick(), delayMs)
  }

  return { planFirst, onMemberSettled, rearm, stop: () => {
    if (timer) clearTimeout(timer)
    timer = null
  } }
}

/**
 * Boot-time re-plan sweep (plan 94 §4.8 "Restart safety"; the orphan half
 * closed by step 94.11). The decision is derived entirely from rows —
 * `repeatCount` against a `COUNT(*)` of a device's own jobs in the batch —
 * so a crash between repetitions loses nothing but the in-memory timer,
 * rearmed here. Idempotent: a batch that lost nothing (every device already
 * at `repeatCount`, or the next repetition's row already exists) is a no-op
 * for every one of its members.
 *
 * **The orphan case (step 94.11):** `pacer.onMemberSettled` above plans the
 * NEXT repetition when one is owed, but says nothing about a batch whose
 * LAST device just finished its LAST repetition — normally
 * `clusters/status.ts`'s `recomputeBatchStatus` runs synchronously right
 * after that settle and flips `batches.status` to `success`/`failed`, but a
 * crash in that exact window (the job row committed `finishedAt`, the core
 * died before the status recompute ran) leaves the batch cached at
 * `queued`/`running` forever with zero live jobs — invisible to every other
 * sweep in this codebase, because nothing else ever looks at a batch whose
 * OWN status already claims it is done. `jobStore`/`broadcast` are optional,
 * the same graceful-degradation shape every other accessor in this file's
 * callers uses (`api/batches.ts`'s own `BatchRoutesDeps`): unwired (a test
 * harness with no interest in it), the re-plan above still runs correctly,
 * it is only the orphan-closing reconciliation that is skipped. Wired (every
 * real host, `daemon.ts`), `recomputeBatchStatus` is called once per batch
 * AFTER the per-device re-plan loop — never per device, and never with a
 * `settledDeviceId` (that argument is `onMemberSettled`'s OWN hook, already
 * invoked directly above; passing it here too would plan the same next
 * repetition twice). It is safe to call unconditionally: for a batch that
 * genuinely still has live jobs, or that just got a fresh repetition planned
 * by the loop above, the recomputed status is `queued`/`running` again — a
 * no-op write, not a false closure.
 *
 * A batch in `'stopping'` is never even selected by the query below — that
 * status is a written state (§3.9), not a derived one, and this sweep must
 * never resurrect a batch an operator stopped; `onMemberSettled`'s own first
 * check (`NON_PLANNING_STATUS`) would refuse to plan anything for it anyway,
 * but excluding it from `nonTerminal` here keeps this sweep from touching
 * (or reconciling) it at all, which is the more honest boundary.
 */
const ACTIVE_JOB_STATUS = new Set(['queued', 'running'])

export function replanAfterRestart(deps: {
  db: Db
  pacer: BatchPacer
  jobStore?: JobStore
  broadcast?: (msg: BatchStatusEvent) => void
  log?: Logger
}): void {
  const nonTerminal = deps.db
    .select()
    .from(batches)
    .where(eq(batches.status, 'queued'))
    .all()
    .concat(deps.db.select().from(batches).where(eq(batches.status, 'running')).all())
  for (const batch of nonTerminal) {
    if (batch.repeatCount <= 1 && batch.deviceIntervalMs <= 0) continue
    const members = deps.db.select().from(jobs).where(eq(jobs.batchId, batch.id)).orderBy(desc(jobs.createdAt)).all()

    // Defensive: a paced batch with NO job rows at all (`createBatch` is
    // expected to insert the batch row and its repetition-0 members in the
    // same call, so this should never happen in practice) has nothing for
    // `recomputeBatchStatus` to tally — that function is a no-op on an
    // empty batch (`status.ts:103`'s own early return) — so it would
    // otherwise sit at `queued`/`running` with zero live jobs forever,
    // exactly the orphan this step exists to close. Logged and marked
    // `failed` directly rather than silently left for the operator to
    // discover only when the batch never moves.
    if (members.length === 0) {
      deps.log?.warn(`batch ${batch.id}: paced batch has no job rows at all — closing as failed rather than leaving it orphaned`)
      deps.db.update(batches).set({ status: 'failed', finishedAt: new Date() }).where(eq(batches.id, batch.id)).run()
      deps.broadcast?.({
        type: 'batch.status',
        payload: { batchId: batch.id, status: 'failed', counts: { total: 0, queued: 0, running: 0, success: 0, failed: 0, cancelled: 0, expired: 0, failedScript: 0, failedInfra: 0 } },
      })
      continue
    }

    const lastByDevice = new Map<string, JobRow>()
    for (const m of members) {
      // Rows come back newest-first (`createdAt DESC`); the first one seen
      // per device is its most recent repetition.
      if (!lastByDevice.has(m.deviceId)) lastByDevice.set(m.deviceId, m)
    }
    for (const [deviceId, last] of lastByDevice) {
      // Only a device whose most recent repetition already SETTLED before
      // the crash is a candidate for "the crash interrupted the pacer, not
      // the job itself" — a still-`queued`/`running` job is left alone; its
      // own eventual settle calls `onMemberSettled` the ordinary way
      // (`clusters/status.ts`'s `recomputeBatchStatus`).
      if (ACTIVE_JOB_STATUS.has(last.status ?? 'queued')) continue
      deps.pacer.onMemberSettled(batch.id, deviceId)
    }

    // Reconcile the cached status AFTER the re-plan loop above, so a fresh
    // repetition (if one was just planned) is already counted — see this
    // function's own doc comment for why this call carries no
    // `settledDeviceId`.
    if (deps.jobStore && deps.broadcast) {
      const before = batch.status
      const result = recomputeBatchStatus({ db: deps.db, jobStore: deps.jobStore, broadcast: deps.broadcast }, batch.id)
      if (result && result.status !== before && result.status !== 'queued' && result.status !== 'running') {
        deps.log?.info(`batch ${batch.id}: closed an orphaned paced batch on boot (was "${before}", every repetition already terminal) — ${result.status}`)
      }
    }
  }
  deps.pacer.rearm()
}
