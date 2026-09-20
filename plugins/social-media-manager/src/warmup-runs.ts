import { z } from 'zod'
import { PlatformIdSchema, type PlatformId } from './platforms'
import { ATTEMPT_ERROR_MAX, type SettleableJob } from './posts'
import type { WarmupAssignment } from './warmup'

/**
 * One phone's warm-up in one session — the row an operator watches (plan 900
 * D4, wave 3).
 *
 * ## Why a row is per DEVICE, and a post row is per VIDEO
 *
 * They are different jobs and the row follows the job. A post session asks
 * "where did this video get to", so its row is a video and its columns are
 * platforms. A warm-up session asks "what did this phone do", so its row is a
 * phone and its columns are the activities it drew. Forcing one shape onto both
 * would give the operator a table whose rows mean two things depending on which
 * page they are on.
 *
 * ## Why the steps are stored, not recomputed
 *
 * The plan is drawn from `random`, so recomputing it would give a different
 * answer every tick — a different style, a different order, different counts.
 * The draw happens ONCE, when the session starts, and the row is what the phone
 * is actually doing. That is the same reason a post session stores its shuffled
 * order rather than reshuffling on every look.
 *
 * ## One activity at a time
 *
 * A phone runs its activities in sequence: `nextStep` returns at most one, and
 * only when nothing is already out on that phone. Two warm-up jobs on one phone
 * would fight over the same screen, and the whole point of a warm-up is that it
 * looks like one person using one phone.
 */

export const WARMUP_PREFIX = 'warmup:'

export function warmupRunKey(groupId: string, deviceId: string): string {
  return `${WARMUP_PREFIX}${groupId}:${deviceId}`
}

/** Everything under one session, for a prefix read. */
export function warmupRunPrefix(groupId: string): string {
  return `${WARMUP_PREFIX}${groupId}:`
}

/**
 * What one activity did.
 *
 * `queued` covers queued AND running — both mean "not an answer yet", the same
 * word `posts.ts` uses for the same reason. `skipped` is an activity the
 * operator will never get an answer for because the phone was given nothing.
 */
export const WARMUP_STEP_STATES = ['pending', 'queued', 'success', 'failed', 'skipped'] as const
export type WarmupStepState = (typeof WARMUP_STEP_STATES)[number]

export const WarmupStepRowSchema = z.object({
  activityId: z.string().min(1),
  title: z.string().min(1),
  script: z.string().min(1),
  params: z.record(z.string(), z.unknown()).default({}),
  /** Seconds after the session started before this step may go out — the planner's pacing, kept. */
  atSec: z.number().int().nonnegative(),
  /** The same thing as an absolute instant, so a restarted plugin resumes the same schedule. */
  notBeforeAt: z.number().int().nonnegative(),
  state: z.enum(WARMUP_STEP_STATES).default('pending'),
  jobId: z.string().min(1).nullable().default(null),
  error: z.string().max(ATTEMPT_ERROR_MAX).nullable().default(null),
  startedAt: z.number().int().nonnegative().nullable().default(null),
  settledAt: z.number().int().nonnegative().nullable().default(null),
})
export type WarmupStepRow = z.infer<typeof WarmupStepRowSchema>

/** A run's state, rolled up from its steps. */
export const WARMUP_RUN_STATES = ['pending', 'running', 'done', 'partial', 'failed', 'skipped'] as const
export type WarmupRunState = (typeof WARMUP_RUN_STATES)[number]

export const WarmupRunSchema = z.object({
  version: z.literal(1),
  groupId: z.string().min(1),
  deviceId: z.string().min(1),
  deviceName: z.string().max(120).nullable().default(null),
  /** 0-based; a session with several phases writes one row per phase. */
  phase: z.number().int().nonnegative().default(0),
  /** `null` when the phone was given nothing — `note` says why. */
  platform: PlatformIdSchema.nullable(),
  styleId: z.string().min(1).nullable().default(null),
  styleTitle: z.string().max(120).nullable().default(null),
  note: z.string().max(ATTEMPT_ERROR_MAX).nullable().default(null),
  steps: z.array(WarmupStepRowSchema),
  state: z.enum(WARMUP_RUN_STATES).default('pending'),
  summary: z.string().max(200).nullable().default(null),
})
export type WarmupRun = z.infer<typeof WarmupRunSchema>

/**
 * Turn one phase's plan into stored rows.
 *
 * `startedAt` is the session's own start, and every step's `notBeforeAt` is
 * computed from it once. The alternative — "now plus the gap, each tick" —
 * drifts by however long the farm was busy, and a warm-up whose gaps stretch
 * because the queue was full is not the pacing the operator chose.
 */
export function runsFromPlan(input: { groupId: string; assignments: readonly WarmupAssignment[]; phase: number; startedAt: number; names?: ReadonlyMap<string, string> }): WarmupRun[] {
  const { groupId, assignments, phase, startedAt, names } = input
  return assignments.map((assignment) => {
    const steps: WarmupStepRow[] = assignment.steps.map((step) => ({
      activityId: step.activityId,
      title: step.title,
      script: step.script,
      params: step.params,
      atSec: step.atSec,
      notBeforeAt: startedAt + step.atSec,
      state: 'pending' as const,
      jobId: null,
      error: null,
      startedAt: null,
      settledAt: null,
    }))
    const run: WarmupRun = {
      version: 1,
      groupId,
      deviceId: assignment.deviceId,
      deviceName: names?.get(assignment.deviceId) ?? null,
      phase,
      platform: assignment.platform,
      styleId: assignment.styleId,
      styleTitle: assignment.styleTitle,
      note: assignment.note,
      steps,
      state: steps.length === 0 ? 'skipped' : 'pending',
      summary: null,
    }
    return withRunSummary(run)
  })
}

/**
 * The next activity this phone should be sent, or `null`.
 *
 * At most one, and only when nothing is already out: a phone runs its warm-up
 * in sequence. A step whose turn has not come holds the phone — the gaps are
 * the pacing, and skipping ahead past a gap would compress the session into the
 * burst it exists to avoid.
 */
export function nextStep(run: WarmupRun, now: number): WarmupStepRow | null {
  if (run.steps.some((step) => step.state === 'queued')) return null
  const next = run.steps.find((step) => step.state === 'pending')
  if (!next) return null
  return next.notBeforeAt <= now ? next : null
}

/** Is this run finished — nothing pending, nothing out? */
export function isRunOver(run: WarmupRun): boolean {
  return !run.steps.some((step) => step.state === 'pending' || step.state === 'queued')
}

/**
 * A run's state from its steps.
 *
 * `partial` exists for the same reason it does on a post row: "some of it
 * worked" is a different fact from "it worked" and from "it failed", and an
 * operator deciding whether to press Retry needs to be told which. A failing
 * activity never ends the run (plan 900 D6.5), so `partial` is the common
 * outcome of a phone that met one bad screen.
 */
export function warmupRunState(steps: readonly WarmupStepRow[]): WarmupRunState {
  if (steps.length === 0) return 'skipped'
  const counts = { success: 0, failed: 0, pending: 0, queued: 0 }
  for (const step of steps) {
    if (step.state === 'success') counts.success += 1
    else if (step.state === 'failed') counts.failed += 1
    else if (step.state === 'queued') counts.queued += 1
    else if (step.state === 'pending') counts.pending += 1
  }
  /*
    A phone with a job OUT ON IT is running, even when nothing has come back
    yet. The first cut of this said `pending` until something finished, which
    reads to an operator as "this phone has not started" while the phone is in
    the middle of scrolling — caught by the session-counts test, which is the
    one that looks at all six buckets at once.
  */
  if (counts.queued > 0) return 'running'
  if (counts.pending > 0) return counts.success + counts.failed > 0 ? 'running' : 'pending'
  if (counts.failed === 0) return 'done'
  return counts.success > 0 ? 'partial' : 'failed'
}

/** The one line the sessions table shows for a phone. */
export function warmupRunSummary(run: WarmupRun): string {
  if (run.steps.length === 0) return run.note ?? 'Nothing to do'
  const done = run.steps.filter((step) => step.state === 'success').length
  const failed = run.steps.filter((step) => step.state === 'failed').length
  const where = run.platform ?? 'no platform'
  const state = warmupRunState(run.steps)
  if (state === 'pending') return `${where} — waiting to start`
  if (state === 'running') return `${where} — ${done + failed} of ${run.steps.length} done`
  if (state === 'done') return `${where} — all ${run.steps.length} activities done`
  if (state === 'failed') return `${where} — all ${run.steps.length} failed`
  return `${where} — ${done} done, ${failed} failed`
}

/** The run with its state and summary recomputed from its own steps, so the two can never disagree. */
export function withRunSummary(run: WarmupRun): WarmupRun {
  const state = warmupRunState(run.steps)
  return { ...run, state, summary: warmupRunSummary({ ...run, state }) }
}

/**
 * Settle one finished job into a step state.
 *
 * Deliberately simpler than `settleJob` in `posts.ts`, and the difference is
 * the point: a post can be "unverified" because pressing Upload and knowing it
 * landed are two different things, and re-sending a post that DID land puts the
 * same video on an account twice. A warm-up activity has no such hazard —
 * scrolling a feed twice is a phone using an app twice — so there is no
 * `unverified` here and a retry is always safe.
 */
export function settleWarmupStep(job: SettleableJob): { state: WarmupStepState; error: string | null } | null {
  const error = job.error?.trim() || null
  switch (job.status) {
    case 'success':
      return { state: 'success', error: null }
    case 'failed':
      return { state: 'failed', error: (error ?? 'The activity failed without an error message. Open its run for the log.').slice(0, ATTEMPT_ERROR_MAX) }
    case 'cancelled':
      return { state: 'failed', error: `The activity was cancelled before it finished.${error !== null ? ` ${error}` : ''}`.slice(0, ATTEMPT_ERROR_MAX) }
    case 'expired':
      return { state: 'failed', error: `The activity expired before a phone ran it.${error !== null ? ` ${error}` : ''}`.slice(0, ATTEMPT_ERROR_MAX) }
    default:
      return null
  }
}

export interface WarmupProgress {
  devices: number
  waiting: number
  running: number
  done: number
  partial: number
  failed: number
  skipped: number
}

/** The session's counts, over its rows. */
export function warmupProgress(runs: readonly WarmupRun[]): WarmupProgress {
  const out: WarmupProgress = { devices: runs.length, waiting: 0, running: 0, done: 0, partial: 0, failed: 0, skipped: 0 }
  for (const run of runs) {
    const state = warmupRunState(run.steps)
    if (state === 'pending') out.waiting += 1
    else if (state === 'running') out.running += 1
    else if (state === 'done') out.done += 1
    else if (state === 'partial') out.partial += 1
    else if (state === 'failed') out.failed += 1
    else out.skipped += 1
  }
  return out
}

/** The session's own one-liner, in the words the Posts page already uses. */
export function warmupSummary(progress: WarmupProgress): string {
  const parts = [
    progress.done > 0 ? `${progress.done} done` : null,
    progress.running > 0 ? `${progress.running} running` : null,
    progress.waiting > 0 ? `${progress.waiting} waiting` : null,
    progress.partial > 0 ? `${progress.partial} part-done` : null,
    progress.failed > 0 ? `${progress.failed} failed` : null,
    progress.skipped > 0 ? `${progress.skipped} skipped` : null,
  ].filter((part): part is string => part !== null)
  return parts.length === 0 ? `${progress.devices} phones` : `${parts.join(', ')} of ${progress.devices} phones`
}

/**
 * Re-queue the failed activities of a run, so "Retry failed" means the same
 * thing it does on the Posts page.
 *
 * Only `failed` steps, and their turn is now: a retry an operator pressed is
 * one they are waiting for, and re-applying the original gaps would make the
 * button look broken for a minute. `null` when there is nothing to retry, so a
 * caller does not write a row it did not change.
 */
export function retryFailedSteps(run: WarmupRun, now: number): WarmupRun | null {
  if (!run.steps.some((step) => step.state === 'failed')) return null
  const steps = run.steps.map((step) =>
    step.state === 'failed' ? { ...step, state: 'pending' as const, jobId: null, error: null, startedAt: null, settledAt: null, notBeforeAt: now } : step,
  )
  return withRunSummary({ ...run, steps })
}

/** Which platforms a session's rows actually covered, for the page's header. */
export function platformsCovered(runs: readonly WarmupRun[]): PlatformId[] {
  const seen = new Set<PlatformId>()
  for (const run of runs) if (run.platform !== null) seen.add(run.platform)
  return [...seen]
}
