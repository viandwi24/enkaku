import { eq } from 'drizzle-orm'
import {
  ScriptRefSchema,
  type AgentRunStatus,
  type BatchOrder,
  type BatchStatusEvent,
  type JobInfo,
  type NotificationContext,
  type OnApprovalRequired,
  type ScheduleFiredEvent,
  type ScheduleRunOutcome,
  type ScheduleThreadMode,
} from '@enkaku/protocol'
import type { AuditLogger } from '../auth/audit'
import { createBatch, type BatchDispatchDeps } from '../clusters/dispatch'
import { resolveCluster, resolveTarget } from '../clusters/resolve'
import { recomputeBatchStatus } from '../clusters/status'
import type { Db } from '../db'
import { batches, clusters, schedules, scheduleAgentTargets, scheduleRuns, type ScheduleAgentTargetRow, type ScheduleRow } from '../db/schema'
import type { JobStore } from '../queue/job-store'
import type { Scheduler } from '../queue/scheduler'
import { resolveScriptRef } from '../scripts/resolve'
import type { ScriptRegistry } from '../scripts/registry'
import { EnkakuError } from '../util/errors'
import type { Logger } from '../util/logger'
import { nextFire, occurrencesBetween } from './cron'

/**
 * The agent side of the dispatcher (plan 68 §3.1, §4.2) — implemented by
 * `agent/runner.ts` (the only thing with the machinery to launch a run) and
 * injected here, exactly like `jobStore`/`scheduler` already are. Optional
 * on `ScheduleRunnerDeps`: a schedule only ever reaches this when a
 * `scheduleAgentTargets` row exists for it, which no pre-plan-68 test ever
 * creates — so every existing test's `ScheduleRunnerDeps` literal keeps
 * compiling and running exactly as before, untouched (acceptance #2).
 */
export interface ScheduleAgentDispatch {
  /** False if the agent id no longer exists or is disabled. */
  agentExists: (agentId: string) => boolean
  /** null if the run no longer exists. */
  runStatus: (runId: string) => AgentRunStatus | null
  /** Cancels a run (and its descendants) — `onOverlap: 'cancel-previous'`. */
  cancelRun: (runId: string, cancelledBy: string | null) => void
  /** Farm-wide count of scheduled-origin runs currently active — the scheduled-concurrency ceiling (§3.3). */
  countActiveScheduledRuns: () => number
  /** Farm-wide output tokens spent by scheduled-origin runs since `windowStart` — the spend cap (§3.3). */
  spentOutputTokensSince: (windowStart: Date) => number
  /** Resolves the thread (new or continue), narrows devices, appends the prompt, and starts (or queues) a run. */
  dispatch: (input: {
    scheduleId: string
    agentId: string
    prompt: string
    threadMode: ScheduleThreadMode
    existingThreadId: string | null
    onApprovalRequired: OnApprovalRequired
    deviceIds: string[] | null
  }) => { runId: string; threadId: string }
}

/** Plan 68 §3.3 — read fresh on every firing, exactly like every other settings-derived accessor in this codebase. */
export interface ScheduledAgentCeilings {
  spendCapOutputTokensPer24h: number | null
  maxConcurrentScheduledRuns: number
}

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
  /** Plan 68 §4.2 — the agent side of dispatch. See `ScheduleAgentDispatch`'s own doc for why this is optional. */
  agentDispatch?: ScheduleAgentDispatch
  /** Plan 68 §3.3 — read fresh on every agent-target firing. Omitted defaults to `{spendCapOutputTokensPer24h: null, maxConcurrentScheduledRuns: 3}`, matching `FarmSettingsSchema.scheduledAgents`'s own defaults. */
  scheduledAgentCeilings?: () => ScheduledAgentCeilings
  /** Plan 68 §3.3, §3.5 — a SYSTEM-generated notification (never rate-limited; not a `notify.send` capability call): a spend-cap refusal or an auto-denied approval. Optional so every pre-plan-68 test keeps compiling unedited. */
  notifySystem?: (input: { level: 'info' | 'warn' | 'error'; title: string; body?: string; context?: NotificationContext }) => void
  /**
   * Plan 82 §3.3, §3.5 — resolving through the registry (rather than the
   * raw `resolveScriptRef`) is what makes a schedule refuse a dev-only
   * target with the named `script_is_dev` error (criterion 18): `resolve()`
   * called with no `allowDev` throws exactly that when a reference would
   * only match an unpublished dev slot. Optional so every pre-plan-82 test
   * keeps compiling unedited and falls back to the old direct call.
   */
  registry?: ScriptRegistry
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

  // Plan 68 §4.2 — branch once, at the very top, on whether an AGENT target exists for this
  // schedule. Presence of a `scheduleAgentTargets` row IS the discriminator (see that table's own
  // doc comment in `db/schema.ts` for why a companion table, not a column on `schedules` itself).
  // Every pre-plan-68 schedule has no such row, so it falls straight through to the script branch
  // below, byte-for-byte unchanged from plan 62.
  const agentTarget = deps.db.select().from(scheduleAgentTargets).where(eq(scheduleAgentTargets.scheduleId, schedule.id)).get()
  if (agentTarget) {
    return fireAgentOnce(deps, schedule, agentTarget, dueAt, missedCount)
  }

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
      // Resolved once, at the moment of dispatch — never per job (plan 62
      // §3.4): a batch of twenty devices from one firing must run exactly
      // one version, even if a publish lands mid-dispatch. `@latest` is
      // recomputed on EVERY firing, which is the whole point of writing
      // `checkout@latest` on a schedule instead of a concrete version.
      const parsedRef = ScriptRefSchema.safeParse(schedule.scriptRef)
      if (!parsedRef.success) {
        throw new EnkakuError('script_ref_unresolved', `"${schedule.scriptRef}" is not a valid script reference`)
      }
      const resolved = deps.registry ? deps.registry.resolve(parsedRef.data) : resolveScriptRef(deps.db, parsedRef.data)

      // The queue timeout lives on the job, set from whatever created it
      // (plan 21 §3.3) — a schedule is simply the first caller to set it.
      const expiresAt =
        schedule.queueTimeoutSec != null ? Math.floor(deps.clock().getTime() / 1000) + schedule.queueTimeoutSec : null
      const { batch } = createBatch(batchDeps, {
        scriptId: resolved.id,
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
      const code = err instanceof EnkakuError ? err.code : null
      outcome = code === 'E_NO_TARGETS' ? 'no-targets' : 'error'
      detail = err instanceof EnkakuError ? `${err.code}: ${err.message}` : err instanceof Error ? err.message : String(err)
      deps.log.warn(`schedule ${schedule.id} (${schedule.name}) did not dispatch: ${detail}`)
      // A reference that cannot resolve (plan 62 §4.5, acceptance #12) — and
      // any other coded dispatch failure — gets its own audit trail entry
      // naming the code, distinct from the routine "no usable devices right
      // now" case (E_NO_TARGETS), which is not a schedule malfunction.
      if (code && code !== 'E_NO_TARGETS') {
        deps.audit.record({
          userId: schedule.createdBy,
          action: 'schedule.failed',
          target: schedule.id,
          meta: { code, message: err instanceof Error ? err.message : String(err) },
        })
      }
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
 * Resolves a schedule's device target (cluster or explicit list) to a
 * concrete, USABLE device id list (plan 68 §3.1: "a schedule with an agent
 * target and a device list passes those devices to the run as its device
 * narrowing"). Reuses the exact resolvers `createBatch` itself calls
 * (`clusters/resolve.ts`) — no second resolution logic. Throws
 * `E_NO_TARGETS` on zero usable devices, the SAME coded error the script
 * branch's `createBatch` throws for the same condition, so both branches'
 * `catch` blocks map it to the `no-targets` outcome identically.
 */
function resolveScheduleDeviceIds(db: Db, schedule: ScheduleRow): string[] {
  const target = scheduleTarget(schedule)
  const resolved =
    'clusterId' in target
      ? (() => {
          const cluster = db.select().from(clusters).where(eq(clusters.id, target.clusterId)).get()
          if (!cluster) throw new EnkakuError('cluster_not_found', `no such cluster: ${target.clusterId}`)
          return resolveCluster(db, cluster)
        })()
      : resolveTarget(db, { tags: [], deviceIds: target.deviceIds })
  if (resolved.usable.length === 0) {
    throw new EnkakuError(
      'E_NO_TARGETS',
      resolved.skipped.length > 0
        ? `no usable devices — every match was unavailable: ${resolved.skipped.map((s) => `${s.deviceId} (${s.reason})`).join(', ')}`
        : 'no devices matched this target',
    )
  }
  return resolved.usable.map((u) => u.deviceId)
}

/**
 * The agent branch of `fireOnce` (plan 68 §3.1, §4.2) — shares the SAME
 * overlap semantics and jitter as the script branch above (§3.2, §3.6:
 * "a change to any of those cannot apply to one kind and not the other"):
 * `skip`/`queue`/`cancel-previous` mean the same thing here that they mean
 * there, and `jitterSec` shifts the dispatch the same way, via the exact
 * same `pickJitterMs`. The scheduled-concurrency ceiling and the spend cap
 * (§3.3) are additional checks that exist ONLY for an agent target — a
 * script schedule has no LLM spend to cap — each implemented as its own
 * single, shared function rather than duplicated per call site, so a
 * future change to either cannot apply inconsistently.
 */
async function fireAgentOnce(deps: ResolvedDeps, schedule: ScheduleRow, target: ScheduleAgentTargetRow, dueAt: Date, missedCount: number): Promise<void> {
  const agentDispatch = deps.agentDispatch
  if (!agentDispatch) {
    // Defensive: a `scheduleAgentTargets` row exists but no dispatcher was wired — should not
    // happen in production (`daemon.ts` always supplies one), but never silently drop the fire.
    deps.log.error(`schedule ${schedule.id} (${schedule.name}) targets an agent but no agent dispatcher is wired on this host`)
    return
  }

  const activeStatus = target.lastAgentRunId ? agentDispatch.runStatus(target.lastAgentRunId) : null
  const active = activeStatus === 'queued' || activeStatus === 'running' || activeStatus === 'paused'

  // Claim this fire time first — same rule, same reasoning, as the script branch above.
  deps.db.update(schedules).set({ lastFiredAt: dueAt }).where(eq(schedules.id, schedule.id)).run()

  const ceilings = deps.scheduledAgentCeilings?.() ?? { spendCapOutputTokensPer24h: null, maxConcurrentScheduledRuns: 3 }
  // Plan 68 §3.3 — "further firings follow their overlap policy": the ceiling is treated exactly
  // like "the previous run is still going" for the skip/queue/cancel-previous decision below.
  const ceilingReached = !active && agentDispatch.countActiveScheduledRuns() >= ceilings.maxConcurrentScheduledRuns

  let outcome: ScheduleRunOutcome
  let detail: string | null = null

  if ((active || ceilingReached) && schedule.onOverlap === 'skip') {
    outcome = 'skipped-overlap'
    detail = active
      ? `the previous agent run (${target.lastAgentRunId}) has not finished`
      : `the scheduled-concurrency ceiling (${ceilings.maxConcurrentScheduledRuns}) is reached`
  } else {
    if (active && schedule.onOverlap === 'cancel-previous' && target.lastAgentRunId) {
      agentDispatch.cancelRun(target.lastAgentRunId, `schedule:${schedule.id}`)
      detail = `cancelled the previous agent run (${target.lastAgentRunId}) before starting`
    }

    const jitterMs = pickJitterMs(schedule.jitterSec, deps.random)
    if (jitterMs > 0) await deps.sleep(jitterMs)

    // Plan 68 §3.3 — the spend cap, checked right before dispatch, farm-wide, SCHEDULED runs only.
    // An interactive run (`agent/runner.ts`'s `postMessage`) never calls anything in this file at
    // all, which is the structural reason it can never be blocked by this check (criterion 7).
    const spendCap = ceilings.spendCapOutputTokensPer24h
    const spent = spendCap != null ? agentDispatch.spentOutputTokensSince(new Date(deps.clock().getTime() - 24 * 60 * 60 * 1000)) : 0
    if (spendCap != null && spent >= spendCap) {
      outcome = 'spend-cap'
      detail = `farm-wide scheduled-run spend cap reached (${spent}/${spendCap} output tokens in the last 24h)`
      deps.log.warn(`schedule ${schedule.id} (${schedule.name}) refused: ${detail}`)
      deps.notifySystem?.({
        level: 'warn',
        title: 'Scheduled run refused: spend cap reached',
        body: `"${schedule.name}" was not fired — ${detail}`,
        context: { scheduleId: schedule.id },
      })
      deps.audit.record({ userId: schedule.createdBy, action: 'schedule.failed', target: schedule.id, meta: { code: 'E_SPEND_CAP', message: detail } })
    } else {
      try {
        if (!agentDispatch.agentExists(target.agentId)) {
          throw new EnkakuError('agent_not_found', `no such agent: ${target.agentId}`)
        }
        const deviceIds = resolveScheduleDeviceIds(deps.db, schedule)
        const result = agentDispatch.dispatch({
          scheduleId: schedule.id,
          agentId: target.agentId,
          prompt: target.prompt,
          threadMode: target.threadMode as ScheduleThreadMode,
          existingThreadId: target.threadId,
          onApprovalRequired: target.onApprovalRequired as OnApprovalRequired,
          deviceIds,
        })
        outcome = 'dispatched'

        // Persists the reused thread (the first firing of `continue` mode) and the run id this
        // firing's overlap check reads next time.
        const targetPatch: Partial<ScheduleAgentTargetRow> = { lastAgentRunId: result.runId }
        if (target.threadMode === 'continue' && !target.threadId) targetPatch.threadId = result.threadId
        deps.db.update(scheduleAgentTargets).set(targetPatch).where(eq(scheduleAgentTargets.scheduleId, schedule.id)).run()
      } catch (err) {
        const code = err instanceof EnkakuError ? err.code : null
        outcome = code === 'E_NO_TARGETS' ? 'no-targets' : 'error'
        detail = err instanceof EnkakuError ? `${err.code}: ${err.message}` : err instanceof Error ? err.message : String(err)
        deps.log.warn(`schedule ${schedule.id} (${schedule.name}) did not dispatch: ${detail}`)
        if (code && code !== 'E_NO_TARGETS') {
          deps.audit.record({
            userId: schedule.createdBy,
            action: 'schedule.failed',
            target: schedule.id,
            meta: { code, message: err instanceof Error ? err.message : String(err) },
          })
        }
      }
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
      batchId: null,
      detail,
      missedCount,
    })
    .run()

  deps.broadcastFired({
    type: 'schedule.fired',
    payload: { scheduleId: schedule.id, outcome, batchId: null, dueAt: Math.floor(dueAt.getTime() / 1000) },
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
