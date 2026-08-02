import { eq } from 'drizzle-orm'
import type { BatchOrder, BatchStatusEvent, JobInfo, ScheduleFiredEvent, ScheduleRunOutcome } from '@enkaku/protocol'
import type { AuditLogger } from '../auth/audit'
import { createBatch, type BatchDispatchDeps } from '../clusters/dispatch'
import { recomputeBatchStatus } from '../clusters/status'
import type { Db } from '../db'
import { batches, schedules, scheduleRuns, type ScheduleRow } from '../db/schema'
import type { JobStore } from '../queue/job-store'
import type { Scheduler } from '../queue/scheduler'
import { EnkakuError } from '../util/errors'
import type { Logger } from '../util/logger'
import { nextFire, occurrencesBetween } from './cron'

export interface ScheduleRunner {
  start(): void
  stop(): void
  /** Re-read the table after a create/update/delete. */
  reload(): void
  /** Next fire time (unix seconds) per enabled schedule, for the UI. */
  nextFires(): Map<string, number>
}

export interface ScheduleRunnerDeps {
  db: Db
  jobStore: JobStore
  scheduler: Scheduler
  audit: AuditLogger
  log: Logger
  onJobStatus: (info: JobInfo) => void
  broadcastBatchStatus: (msg: BatchStatusEvent) => void
  broadcastFired: (msg: ScheduleFiredEvent) => void
  /** Same validation `createBatch` already takes (plan 20 §4.4) — kept optional for tests. */
  validateScript?: (scriptId: string, params: unknown) => unknown
  /** Injected for deterministic tests — never `Date.now()` in a test assertion (plan 21 §21.5). */
  clock?: () => Date
  /** Injected so jitter tests do not have to sleep for real. */
  random?: () => number
  sleep?: (ms: number) => Promise<void>
  /** A defensive backstop tick alongside the precise wake timer (plan 21 §4.2) — never a per-schedule timer. */
  fallbackIntervalMs?: number
}

interface ResolvedDeps extends ScheduleRunnerDeps {
  clock: () => Date
  random: () => number
  sleep: (ms: number) => Promise<void>
  fallbackIntervalMs: number
}

function resolveDeps(deps: ScheduleRunnerDeps): ResolvedDeps {
  return {
    ...deps,
    clock: deps.clock ?? (() => new Date()),
    random: deps.random ?? Math.random,
    sleep: deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))),
    fallbackIntervalMs: deps.fallbackIntervalMs ?? 15_000,
  }
}

/** `jitterSec` delays each dispatch by a random amount in [0, jitterSec] — drawn per fire (plan 21 §3.6). */
export function pickJitterMs(jitterSec: number, random: () => number = Math.random): number {
  if (jitterSec <= 0) return 0
  return Math.floor(random() * (jitterSec * 1000 + 1))
}

/** Exactly one of clusterId / deviceIds is populated on a schedule row (plan 21 §9 open question #3). */
export function scheduleTarget(schedule: ScheduleRow): { clusterId: string } | { deviceIds: string[] } {
  if (schedule.clusterId) return { clusterId: schedule.clusterId }
  return { deviceIds: (schedule.deviceIds as string[] | null) ?? [] }
}

function isBatchActive(db: Db, batchId: string | null): boolean {
  if (!batchId) return false
  const row = db.select().from(batches).where(eq(batches.id, batchId)).get()
  return row ? row.status === 'queued' || row.status === 'running' : false
}

/**
 * Process one fire decision for one schedule (plan 21 §4.2, §3.2, §3.6).
 * Triggers a **batch** through plan 20's `createBatch` — never a bare job.
 *
 * `schedules.lastFiredAt` is advanced to `dueAt` synchronously, before any
 * `await` (jitter or otherwise): a concurrent wake recomputing "what is due"
 * must never see this same occurrence as still pending, or it would dispatch
 * twice. Everything after that point (the overlap check's own DB writes
 * aside) may safely be async.
 */
export async function fireOnce(rawDeps: ScheduleRunnerDeps, schedule: ScheduleRow, dueAt: Date, missedCount = 0): Promise<void> {
  const deps = resolveDeps(rawDeps)
  const active = isBatchActive(deps.db, schedule.lastBatchId)

  // Claim this fire time first — see the doc comment above.
  deps.db.update(schedules).set({ lastFiredAt: dueAt }).where(eq(schedules.id, schedule.id)).run()

  let outcome: ScheduleRunOutcome
  let batchId: string | null = null
  let detail: string | null = null

  if (active && schedule.onOverlap === 'skip') {
    outcome = 'skipped-overlap'
    detail = `the previous batch (${schedule.lastBatchId}) has not finished`
  } else {
    if (active && schedule.onOverlap === 'cancel-previous' && schedule.lastBatchId) {
      const cancelled = deps.jobStore.cancelQueuedInBatch(schedule.lastBatchId)
      recomputeBatchStatus({ db: deps.db, jobStore: deps.jobStore, broadcast: deps.broadcastBatchStatus }, schedule.lastBatchId)
      detail = `cancelled ${cancelled} queued job(s) from the previous run before starting`
    }

    // Resolved once, at dispatch — shifts the batch creation time, never the
    // cron evaluation, so the schedule itself does not drift (plan 21 §3.6).
    const jitterMs = pickJitterMs(schedule.jitterSec, deps.random)
    if (jitterMs > 0) await deps.sleep(jitterMs)

    const batchDeps: BatchDispatchDeps = {
      db: deps.db,
      scheduler: deps.scheduler,
      audit: deps.audit,
      onJobStatus: deps.onJobStatus,
      ...(deps.validateScript ? { validateScript: deps.validateScript } : {}),
    }
    try {
      // The queue timeout lives on the job, set from whatever created it
      // (plan 21 §3.3) — a schedule is simply the first caller to set it.
      const expiresAt =
        schedule.queueTimeoutSec != null ? Math.floor(deps.clock().getTime() / 1000) + schedule.queueTimeoutSec : null
      const { batch } = createBatch(batchDeps, {
        scriptId: schedule.scriptId,
        params: schedule.params,
        target: scheduleTarget(schedule),
        concurrency: schedule.concurrency,
        order: schedule.order as BatchOrder,
        priority: schedule.priority,
        createdBy: schedule.createdBy,
        expiresAt,
      })
      batchId = batch.id
      outcome = 'dispatched'
    } catch (err) {
      outcome = err instanceof EnkakuError && err.code === 'E_NO_TARGETS' ? 'no-targets' : 'error'
      detail = err instanceof Error ? err.message : String(err)
      deps.log.warn(`schedule ${schedule.id} (${schedule.name}) did not dispatch: ${detail}`)
    }
  }

  const firedAt = deps.clock()
  deps.db
    .insert(scheduleRuns)
    .values({
      id: crypto.randomUUID(),
      scheduleId: schedule.id,
      dueAt,
      firedAt,
      outcome,
      batchId,
      detail,
      missedCount,
    })
    .run()

  if (batchId) deps.db.update(schedules).set({ lastBatchId: batchId }).where(eq(schedules.id, schedule.id)).run()

  deps.broadcastFired({
    type: 'schedule.fired',
    payload: { scheduleId: schedule.id, outcome, batchId, dueAt: Math.floor(dueAt.getTime() / 1000) },
  })
}

/**
 * At startup, before the first wake: for each enabled schedule with a
 * `lastFiredAt`, count occurrences missed while the core was stopped and
 * apply `catchUp` (plan 21 §3.4, §4.2). `once` collapses every miss into a
 * single immediate run; `skip` only records them. Either way the checkpoint
 * moves to `now`, so a later restart never recounts the same gap.
 */
export async function runStartupCatchUp(rawDeps: ScheduleRunnerDeps): Promise<void> {
  const deps = resolveDeps(rawDeps)
  const now = deps.clock()
  const rows = deps.db.select().from(schedules).where(eq(schedules.enabled, true)).all()

  for (const schedule of rows) {
    if (!schedule.lastFiredAt) continue // never fired — the regular loop covers the first occurrence, nothing was missed
    const missed = occurrencesBetween(schedule.cron, schedule.timezone, schedule.lastFiredAt, now)
    if (!missed.ok) {
      deps.log.warn(`schedule ${schedule.id} (${schedule.name}): invalid cron at catch-up: ${missed.error}`)
      continue
    }
    if (missed.value === 0) continue

    if (schedule.catchUp === 'once') {
      await fireOnce(rawDeps, schedule, now, missed.value)
      continue
    }

    // 'skip' (default) — record the misses, run nothing (plan 21 §3.4).
    deps.db
      .insert(scheduleRuns)
      .values({
        id: crypto.randomUUID(),
        scheduleId: schedule.id,
        dueAt: now,
        firedAt: now,
        outcome: 'skipped-missed',
        batchId: null,
        detail: `${missed.value} fire(s) missed while the core was stopped`,
        missedCount: missed.value,
      })
      .run()
    deps.db.update(schedules).set({ lastFiredAt: now }).where(eq(schedules.id, schedule.id)).run()
    deps.broadcastFired({
      type: 'schedule.fired',
      payload: { scheduleId: schedule.id, outcome: 'skipped-missed', batchId: null, dueAt: Math.floor(now.getTime() / 1000) },
    })
  }
}

/**
 * The scheduler loop (plan 21 §4.2). Separate from `queue/scheduler.ts` —
 * that one dispatches queued jobs to devices; this one decides when work is
 * created. A single dynamic timer wakes on the earliest next fire across all
 * enabled schedules, recomputed on every change — never a per-schedule timer.
 */
export function createScheduleRunner(rawDeps: ScheduleRunnerDeps): ScheduleRunner {
  const deps = resolveDeps(rawDeps)
  let wakeTimer: ReturnType<typeof setTimeout> | null = null
  let fallbackTimer: ReturnType<typeof setInterval> | null = null
  let running = false
  /** scheduleId → next fire (unix seconds). Recomputed whenever a schedule changes. */
  const nextFireCache = new Map<string, number>()

  function computeNext(schedule: ScheduleRow, from: Date): number | null {
    const result = nextFire(schedule.cron, schedule.timezone, from)
    if (!result.ok) {
      deps.log.warn(`schedule ${schedule.id} (${schedule.name}): invalid cron, will not fire: ${result.error}`)
      return null
    }
    return result.value
  }

  function recomputeCache(): void {
    nextFireCache.clear()
    const rows = deps.db.select().from(schedules).where(eq(schedules.enabled, true)).all()
    for (const schedule of rows) {
      const from = schedule.lastFiredAt ?? schedule.createdAt
      const next = computeNext(schedule, from)
      if (next !== null) nextFireCache.set(schedule.id, next)
    }
  }

  function armTimer(): void {
    if (wakeTimer) {
      clearTimeout(wakeTimer)
      wakeTimer = null
    }
    if (!running) return
    let earliest: number | null = null
    for (const t of nextFireCache.values()) {
      if (earliest === null || t < earliest) earliest = t
    }
    if (earliest === null) return
    const delayMs = Math.max(0, earliest * 1000 - deps.clock().getTime())
    wakeTimer = setTimeout(() => void wake(), delayMs)
  }

  async function wake(): Promise<void> {
    if (!running) return
    const nowSec = Math.floor(deps.clock().getTime() / 1000)
    const due = [...nextFireCache.entries()].filter(([, t]) => t <= nowSec).map(([id]) => id)
    for (const id of due) {
      const schedule = deps.db.select().from(schedules).where(eq(schedules.id, id)).get()
      if (!schedule || !schedule.enabled) continue
      const dueAt = new Date((nextFireCache.get(id) ?? nowSec) * 1000)
      // Not awaited: `fireOnce` claims `lastFiredAt` synchronously before its
      // first `await`, so the immediate `recomputeCache()` below is race-free.
      void fireOnce(rawDeps, schedule, dueAt).catch((err) => deps.log.error(`schedule ${id} fire failed: ${String(err)}`))
    }
    recomputeCache()
    armTimer()
  }

  return {
    start() {
      if (running) return
      running = true
      void runStartupCatchUp(rawDeps).then(() => {
        recomputeCache()
        armTimer()
      })
      // One extra safety tick (system sleep, clock skew), never a per-schedule timer.
      fallbackTimer = setInterval(() => void wake(), deps.fallbackIntervalMs)
    },
    stop() {
      running = false
      if (wakeTimer) clearTimeout(wakeTimer)
      wakeTimer = null
      if (fallbackTimer) clearInterval(fallbackTimer)
      fallbackTimer = null
    },
    reload() {
      recomputeCache()
      armTimer()
    },
    nextFires() {
      return new Map(nextFireCache)
    },
  }
}
