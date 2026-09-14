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
 *
 * ## Sequential batches (plan 316)
 *
 * With `batches.sequential` the sub-groups are barriers, not waves in time: a
 * sub-group is released only when every member of the previous one has
 * settled, and a repetition — a PHASE — starts only when the whole previous
 * phase has. Held runs are ordinary queued runs with `held = 1`, which the
 * claim skips. What to release next is decided by one pure function,
 * `planSequentialStep`, called both when a member settles and by the boot
 * sweep, so a core restarted mid-batch releases exactly what normal operation
 * would have.
 */
export interface BatchPacer {
  /** Repetition 0 for every device, with the stagger baked into the member job's own first run's `notBefore` (plan 94 §3.8). */
  planFirst(batchId: string): void
  /** Called from `recomputeBatchStatus` (F32) when a member settles — the ONE hook, never a second loop. */
  onMemberSettled(batchId: string, deviceId: string): void
  /** Plan 316 — release whatever a sequential batch has due. Idempotent; the boot sweep calls it for every open sequential batch. */
  advance(batchId: string): void
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
 * Which rung of the start ladder a member sits on — the sub-group arithmetic.
 *
 * `waveSize` of 1 is one rung per phone, which is what every batch did before
 * sub-groups existed, so this returns `i` unchanged and nothing moves. `10`
 * puts phones 0-9 on rung 0, 10-19 on rung 1, and so on: the fleet goes out in
 * waves of ten instead of a 70-rung staircase where the last phone waits 35
 * minutes.
 *
 * Total by construction — a row written before the column existed, or one
 * holding a 0 from some other path, is read as 1 rather than dividing by zero.
 */
export function ladderRung(index: number, waveSize: number): number {
  return Math.floor(index / Math.max(1, waveSize))
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

/** One member of a sequential batch as the planner sees it: its sub-group, and its runs that belong to a repetition. */
export interface SequentialMember {
  deviceId: string
  wave: number
  runs: readonly { batchRepeat: number; status: string; held: boolean }[]
}

export type SequentialStep =
  | { kind: 'wait' }
  | { kind: 'release'; repeat: number; wave: number }
  | { kind: 'next-phase'; repeat: number }
  | { kind: 'done' }

/**
 * What a sequential batch should do next — pure, so it is the thing the tests pin.
 *
 * The current phase is the highest repetition any member has a run for. Its sub-groups are walked in order: a
 * sub-group with a run queued-and-released or running is still going (`wait`); one whose remaining runs are all held
 * is next (`release`); one that has fully settled is passed. When every sub-group of the phase has settled, the next
 * phase starts — or the batch is `done`.
 */
export function planSequentialStep(members: readonly SequentialMember[], repeatCount: number): SequentialStep {
  let current = -1
  for (const m of members) for (const r of m.runs) current = Math.max(current, r.batchRepeat)
  if (current < 0) return { kind: 'wait' }

  const waves = [...new Set(members.map((m) => m.wave))].sort((a, b) => a - b)
  for (const wave of waves) {
    const inWave = members
      .filter((m) => m.wave === wave)
      .map((m) => m.runs.filter((r) => r.batchRepeat === current).at(-1))
      .filter((r): r is { batchRepeat: number; status: string; held: boolean } => r !== undefined)
    if (inWave.some((r) => r.status === 'running' || (r.status === 'queued' && !r.held))) return { kind: 'wait' }
    if (inWave.some((r) => r.status === 'queued' && r.held)) return { kind: 'release', repeat: current, wave }
  }
  return current + 1 < repeatCount ? { kind: 'next-phase', repeat: current + 1 } : { kind: 'done' }
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
    return batch.sequential || batch.repeatCount > 1 || batch.deviceIntervalMs > 0 || batch.deviceDelayMaxMs > 0
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
      const wave = ladderRung(i, batch.waveSize)
      if (batch.sequential) {
        // Sub-group 0 goes now, each device at its own jittered instant; every later sub-group is held until the one
        // before it has settled. A held run carries no expiry: its release time is not known yet.
        const delayMs = drawIntervalMs(batch.deviceDelayMinMs, batch.deviceDelayMaxMs, random)
        deps.db
          .update(jobRuns)
          .set(
            wave === 0
              ? { batchRepeat: 0, batchWave: 0, held: false, notBefore: delayMs > 0 ? now + Math.round(delayMs / 1000) : run.notBefore, pacedDelayMs: delayMs > 0 ? delayMs : run.pacedDelayMs }
              : { batchRepeat: 0, batchWave: wave, held: true, notBefore: null, expiresAt: null },
          )
          .where(eq(jobRuns.id, run.id))
          .run()
        continue
      }
      // The ladder positions a device; the draw jitters it. Both are baked
      // into ONE `notBefore` here rather than applied in two passes, so a
      // member's own recorded `pacedDelayMs` is the whole truth about when it
      // was allowed to start — not half of it.
      const staggerMs = wave * batch.deviceIntervalMs + drawIntervalMs(batch.deviceDelayMinMs, batch.deviceDelayMaxMs, random)
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
    deps.log.info(
      `batch ${batchId}: planned repetition 0 for ${members.length} device(s)` +
        (batch.sequential
          ? `, sequential in sub-groups of ${batch.waveSize}`
          : `, stagger ${batch.deviceIntervalMs}ms` + (batch.waveSize > 1 ? ` in waves of ${batch.waveSize}` : '')) +
        (batch.deviceDelayMaxMs > 0 ? `, per-device delay ${batch.deviceDelayMinMs}-${batch.deviceDelayMaxMs}ms` : ''),
    )
    rearm()
  }

  /** The planner's view of a sequential batch, read from its member jobs' repetition runs. */
  function sequentialMembers(batchId: string): { member: typeof jobs.$inferSelect; wave: number; runs: (typeof jobRuns.$inferSelect)[] }[] {
    const members = deps.db.select().from(jobs).where(eq(jobs.batchId, batchId)).orderBy(jobs.batchSeq).all()
    return members.map((member) => {
      // Oldest first, and only runs that belong to a repetition — a manual rerun carries no `batch_repeat`.
      const runs = [...deps.runs.runs(member.id)].reverse().filter((r) => r.batchRepeat != null)
      const wave = runs.find((r) => r.batchWave != null)?.batchWave ?? 0
      return { member, wave, runs }
    })
  }

  function advance(batchId: string): void {
    const batch = loadBatch(batchId)
    if (!batch || !batch.sequential || NON_PLANNING_STATUS.has(batch.status)) return
    const view = sequentialMembers(batchId)
    const step = planSequentialStep(
      view.map((v) => ({ deviceId: v.member.deviceId, wave: v.wave, runs: v.runs.map((r) => ({ batchRepeat: r.batchRepeat ?? 0, status: r.status, held: r.held })) })),
      batch.repeatCount,
    )
    const now = nowSec()

    if (step.kind === 'release') {
      let released = 0
      for (const v of view) {
        if (v.wave !== step.wave) continue
        const run = v.runs.filter((r) => r.batchRepeat === step.repeat).at(-1)
        if (!run || run.status !== 'queued' || !run.held) continue
        // The wait after the previous sub-group, then each device's own jitter inside this one.
        const delayMs = (step.wave > 0 ? batch.deviceIntervalMs : 0) + drawIntervalMs(batch.deviceDelayMinMs, batch.deviceDelayMaxMs, random)
        deps.db
          .update(jobRuns)
          .set({ held: false, notBefore: delayMs > 0 ? now + Math.round(delayMs / 1000) : null, pacedDelayMs: delayMs })
          .where(eq(jobRuns.id, run.id))
          .run()
        released += 1
      }
      deps.log.info(`batch ${batchId}: phase ${step.repeat + 1}/${batch.repeatCount} — released sub-group ${step.wave + 1} (${released} device(s))`)
    } else if (step.kind === 'next-phase') {
      const phaseGapMs = drawIntervalMs(batch.intervalMinMs, batch.intervalMaxMs, random)
      for (const v of view) {
        const delayMs = phaseGapMs + drawIntervalMs(batch.deviceDelayMinMs, batch.deviceDelayMaxMs, random)
        deps.runs.addRun(
          v.member.id,
          v.wave === 0
            ? { trigger: 'batch', batchRepeat: step.repeat, batchWave: 0, held: false, notBefore: now + Math.round(delayMs / 1000), pacedDelayMs: delayMs }
            : { trigger: 'batch', batchRepeat: step.repeat, batchWave: v.wave, held: true },
        )
      }
      deps.log.info(`batch ${batchId}: phase ${step.repeat + 1}/${batch.repeatCount} planned for ${view.length} device(s), starting in ${phaseGapMs}ms`)
    } else {
      return
    }
    rearm()
    deps.scheduler.kick()
  }

  function onMemberSettled(batchId: string, deviceId: string): void {
    const batch = loadBatch(batchId)
    if (!batch) return
    if (NON_PLANNING_STATUS.has(batch.status)) return
    if (!isPaced(batch)) return
    if (batch.sequential) return advance(batchId)

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
    advance,
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
    if (!batch.sequential && batch.repeatCount <= 1 && batch.deviceIntervalMs <= 0 && batch.deviceDelayMaxMs <= 0) continue
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

    if (batch.sequential) {
      // Plan 316 — the same planner a settle calls: whatever became due while the core was down is released now.
      deps.pacer.advance(batch.id)
    } else {
      for (const member of members) {
        const latest = member.latestRunId ? deps.db.select().from(jobRuns).where(eq(jobRuns.id, member.latestRunId)).get() : null
        if (!latest || ACTIVE_RUN_STATUS.has(latest.status)) continue
        deps.pacer.onMemberSettled(batch.id, member.deviceId)
      }
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
