import { and, eq } from 'drizzle-orm'
import type { BatchStatusEvent } from '@enkaku/protocol'
import { batches, jobRuns, jobs, type BatchRow } from '../db/schema'
import type { Db } from '../db'
import type { JobStore } from '../queue/job-store'
import type { RunStore } from '../jobs/runs/store'
import { recomputeBatchStatus } from './status'
import type { Scheduler } from '../queue/scheduler'
import type { Logger } from '../util/logger'

/**
 * A batch's repeating clock (plan 94 §3.7, §3.8, §4.8, step 94.7, plan 211
 * §3.2 decision 3: a paced repetition is a RUN on the same member job, not a
 * new job). Nothing here special-cases an unpaced batch (`repeatCount: 1`,
 * every interval field `0`) — the same math just produces a single,
 * unstaggered run, which is today's behaviour exactly (§4.9's `pacing`
 * default).
 */
export interface BatchPacer {
  /** Repetition 0 for every device, with the stagger baked into the member job's own first run's `notBefore` (plan 94 §3.8). */
  planFirst(batchId: string): void
  /** Called from `recomputeBatchStatus` (F32) when a member settles — the ONE hook, never a second loop. */
  onMemberSettled(batchId: string, deviceId: string): void
  /** Arms one timer at the earliest future `notBefore` across all runs. */
  rearm(): void
  /** Clears the timer — every process this thing starts is dead after this returns (00-overview §7). */
  stop(): void
}

export interface BatchPacerDeps {
  db: Db
  runs: RunStore
  scheduler: Scheduler
  log: Logger
  randomUint32?: () => number
  clock?: () => Date
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
    const members = deps.db.select().from(jobs).where(eq(jobs.batchId, batchId)).orderBy(jobs.batchSeq).all()
    const now = nowSec()
    for (let i = 0; i < members.length; i++) {
      const member = members[i]
      if (!member?.latestRunId) continue
      const run = deps.db.select().from(jobRuns).where(eq(jobRuns.id, member.latestRunId)).get()
      if (!run) continue
      const staggerMs = i * batch.deviceIntervalMs
      deps.db
        .update(jobRuns)
        .set({
          notBefore: staggerMs > 0 ? now + Math.round(staggerMs / 1000) : run.notBefore,
          batchRepeat: 0,
          pacedDelayMs: staggerMs > 0 ? staggerMs : run.pacedDelayMs,
        })
        .where(eq(jobRuns.id, run.id))
        .run()
    }
    deps.log.info(`batch ${batchId}: planned repetition 0 for ${members.length} device(s), stagger ${batch.deviceIntervalMs}ms`)
    rearm()
  }

  function onMemberSettled(batchId: string, deviceId: string): void {
    const batch = loadBatch(batchId)
    if (!batch) return
    if (NON_PLANNING_STATUS.has(batch.status)) return
    if (!isPaced(batch)) return

    const member = deps.db
      .select()
      .from(jobs)
      .where(and(eq(jobs.batchId, batchId), eq(jobs.deviceId, deviceId)))
      .get()
    if (!member) return
    const memberRuns = deps.runs.runs(member.id)
    if (memberRuns.length === 0) return
    const last = memberRuns[0] as (typeof memberRuns)[number]
    const completed = memberRuns.length
    if (completed >= batch.repeatCount) return
    const nextRepeat = (last.batchRepeat ?? 0) + 1
    if (nextRepeat >= batch.repeatCount) return

    const delayMs = drawIntervalMs(batch.intervalMinMs, batch.intervalMaxMs, random)
    const now = nowSec()
    deps.runs.addRun(member.id, {
      trigger: 'batch',
      notBefore: now + Math.round(delayMs / 1000),
      batchRepeat: nextRepeat,
      pacedDelayMs: delayMs,
    })
    deps.log.info(`batch ${batchId}: device ${deviceId} repetition ${nextRepeat}/${batch.repeatCount - 1} planned, waiting ${delayMs}ms`)
    rearm()
    deps.scheduler.kick()
  }

  function rearm(): void {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    const rows = deps.db.select({ notBefore: jobRuns.notBefore }).from(jobRuns).where(eq(jobRuns.status, 'queued')).all()
    let earliestSec: number | null = null
    for (const r of rows) {
      if (r.notBefore == null) continue
      if (earliestSec === null || r.notBefore < earliestSec) earliestSec = r.notBefore
    }
    if (earliestSec === null) return
    const delayMs = Math.min(fallbackIntervalMs, Math.max(0, earliestSec * 1000 - nowMs()))
    timer = setTimeout(() => deps.scheduler.kick(), delayMs)
  }

  return {
    planFirst,
    onMemberSettled,
    rearm,
    stop: () => {
      if (timer) clearTimeout(timer)
      timer = null
    },
  }
}

const ACTIVE_RUN_STATUS = new Set(['queued', 'running'])

/**
 * Boot-time re-plan sweep (plan 94 §4.8 "Restart safety"; the orphan half
 * closed by step 94.11; re-keyed to runs by plan 211).
 */
export function replanAfterRestart(deps: {
  db: Db
  runs: RunStore
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
    const members = deps.db.select().from(jobs).where(eq(jobs.batchId, batch.id)).all()

    if (members.length === 0) {
      deps.log?.warn(`batch ${batch.id}: paced batch has no job rows at all — closing as failed rather than leaving it orphaned`)
      deps.db.update(batches).set({ status: 'failed', finishedAt: new Date() }).where(eq(batches.id, batch.id)).run()
      deps.broadcast?.({
        type: 'batch.status',
        payload: { batchId: batch.id, status: 'failed', counts: { total: 0, queued: 0, running: 0, success: 0, failed: 0, cancelled: 0, expired: 0, failedScript: 0, failedInfra: 0 } },
      })
      continue
    }

    for (const member of members) {
      const latest = member.latestRunId ? deps.db.select().from(jobRuns).where(eq(jobRuns.id, member.latestRunId)).get() : null
      if (!latest || ACTIVE_RUN_STATUS.has(latest.status)) continue
      deps.pacer.onMemberSettled(batch.id, member.deviceId)
    }

    if (deps.jobStore && deps.broadcast) {
      const before = batch.status
      const result = recomputeBatchStatus({ db: deps.db, runs: deps.runs, jobStore: deps.jobStore, broadcast: deps.broadcast }, batch.id)
      if (result && result.status !== before && result.status !== 'queued' && result.status !== 'running') {
        deps.log?.info(`batch ${batch.id}: closed an orphaned paced batch on boot (was "${before}", every repetition already terminal) — ${result.status}`)
      }
    }
  }
  deps.pacer.rearm()
}
