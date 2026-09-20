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

/**
 * `warmup:<groupId>:<phase>:<deviceId>` — one row per phone PER PHASE.
 *
 * The phase is in the key and not only in the row because a session with three
 * phases gives a phone three separate pieces of work, each with its own
 * platform and its own schedule. One row per phone would make the second phase
 * overwrite the first, and the operator would watch a session that kept losing
 * its own history.
 */
export function warmupRunKey(groupId: string, phase: number, deviceId: string): string {
  return `${WARMUP_PREFIX}${groupId}:${phase}:${deviceId}`
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
  /**
   * How this row's activities go out — copied from the session's settings at
   * plan time, not read from the group each tick.
   *
   * A session whose mode changed half way through would otherwise have rows
   * that were dispatched one way being settled another, and the row is the
   * record of what the phone actually did.
   */
  sequence: z.enum(['jobs', 'workflow']).default('jobs'),
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
export function runsFromPlan(input: {
  groupId: string
  assignments: readonly WarmupAssignment[]
  phase: number
  startedAt: number
  names?: ReadonlyMap<string, string>
  sequence?: 'jobs' | 'workflow'
}): WarmupRun[] {
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
      sequence: input.sequence ?? 'jobs',
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
  // A workflow row goes out whole, through `dueSequence` — never one step at a time.
  if (run.sequence === 'workflow') return null
  if (run.steps.some((step) => step.state === 'queued')) return null
  const next = run.steps.find((step) => step.state === 'pending')
  if (!next) return null
  return next.notBeforeAt <= now ? next : null
}

/**
 * The whole sequence, when this row goes out as ONE workflow job — or `null`.
 *
 * All-or-nothing on purpose. A workflow job carries its own delays, so the
 * steps after the first are not separately "due"; dispatching a second one
 * while the first is still walking the phone is the very thing `nextStep`
 * refuses for the job-per-activity path.
 */
export function dueSequence(run: WarmupRun, now: number): WarmupStepRow[] | null {
  if (run.sequence !== 'workflow') return null
  if (run.steps.some((step) => step.state === 'queued')) return null
  const pending = run.steps.filter((step) => step.state === 'pending')
  const first = pending[0]
  if (!first || first.notBeforeAt > now) return null
  return pending
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

/**
 * Which activities a failed WORKFLOW sequence actually got through.
 *
 * A workflow row has every activity against one job, so a failed job first read
 * as "all of them failed" — and on the run that found this, three of four had
 * gone green as the workflow's own child jobs before the fourth met a bad
 * screen. "All 4 failed" is not a rounding error; it is the opposite of what
 * happened, and an operator reading it would go looking for four broken
 * activities.
 *
 * The engine walks the document in order and stops at the first failure, and
 * the failure message names the node (`step "s2" failed: …`). `warmupSequenceDoc`
 * numbers its script nodes `s0, s1, …` in the order of `steps`, so that name is
 * the index: everything before it ran, everything after it never did.
 *
 * Reading an index out of a message is fragile, and this is deliberately the
 * only thing that depends on it: when the name is not there, every activity is
 * marked failed exactly as before, with the job's own error. A wrong guess here
 * would be worse than the crude answer.
 */
export function sequenceOutcome(steps: readonly WarmupStepRow[], error: string | null): { activityId: string; state: WarmupStepState }[] | null {
  const named = /step "s(\d+)" failed/.exec(error ?? '')
  const at = named ? Number(named[1]) : Number.NaN
  if (!Number.isInteger(at) || at < 0 || at >= steps.length) return null
  return steps.map((step, index) => ({
    activityId: step.activityId,
    state: index < at ? ('success' as const) : index === at ? ('failed' as const) : ('skipped' as const),
  }))
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
  /*
    Counted PER PHONE, not per row.

    A session stores a row per phone per phase, so a three-phase session over
    fourteen phones has forty-two rows — and this used to report them as
    "42 phones", on a farm with fourteen. The owner read it and asked whether
    the states were real at all (2026-09-20: *"jangan sampai ghost state"*).
    They were real; the NOUN was wrong, which is worse, because a number that
    cannot be checked against the farm makes every number beside it suspect.

    So the phases of one phone roll up first, by the same ladder
    `warmup-report.ts` uses — one phone, one verdict, and the total is a number
    the operator can count on the shelf.
  */
  const byDevice = new Map<string, WarmupRunState[]>()
  for (const run of runs) {
    const list = byDevice.get(run.deviceId)
    if (list) list.push(warmupRunState(run.steps))
    else byDevice.set(run.deviceId, [warmupRunState(run.steps)])
  }

  const out: WarmupProgress = { devices: byDevice.size, waiting: 0, running: 0, done: 0, partial: 0, failed: 0, skipped: 0 }
  for (const states of byDevice.values()) {
    const state = rollUpPhases(states)
    if (state === 'pending') out.waiting += 1
    else if (state === 'running') out.running += 1
    else if (state === 'done') out.done += 1
    else if (state === 'partial') out.partial += 1
    else if (state === 'failed') out.failed += 1
    else out.skipped += 1
  }
  return out
}

/**
 * One phone's phases, as one state.
 *
 * Kept here rather than imported from `warmup-report.ts` so the two sides of
 * this plugin cannot disagree about it — `warmup-report.ts`'s `rollUpState`
 * delegates to this one, and `warmup-report.test.ts` holds them equal.
 */
export function rollUpPhases(states: readonly WarmupRunState[]): WarmupRunState {
  const live = states.filter((state) => state !== 'skipped')
  if (live.length === 0) return states.length === 0 ? 'pending' : 'skipped'
  if (live.some((state) => state === 'running')) return 'running'
  if (live.some((state) => state === 'partial')) return 'partial'
  const done = live.filter((state) => state === 'done').length
  const failed = live.filter((state) => state === 'failed').length
  const pending = live.filter((state) => state === 'pending').length
  // Something answered and something has not: still running. Calling it
  // `partial` would claim the session is over.
  if (pending > 0 && done + failed > 0) return 'running'
  if (pending > 0) return 'pending'
  if (done > 0 && failed > 0) return 'partial'
  return failed > 0 ? 'failed' : 'done'
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
  const phones = `${progress.devices} ${progress.devices === 1 ? 'phone' : 'phones'}`
  return parts.length === 0 ? phones : `${parts.join(', ')} of ${phones}`
}

/**
 * Codes the farm answers with when the request itself is wrong, and will be
 * wrong again in fifteen seconds.
 *
 * `invalid_job_params` is the one this exists for. A dispatch that throws
 * leaves its step PENDING on purpose — a row claiming a job that does not
 * exist would wait for an answer for ever — and for a transient fault that is
 * exactly right: the next tick tries again.
 *
 * For a permanent one it is a trap. The owner's own farm hit it: one activity
 * sent a param outside the member's range, the farm refused it, and the phone
 * re-sent the same activity every fifteen seconds. Its whole warm-up sat
 * behind that one step, with a green session, no failed row, and nothing
 * anywhere an operator looks that could say why the phone had stopped.
 *
 * So a refusal the farm will repeat FAILS the step by name and the sequence
 * moves on. Being one activity short is a smaller loss than being stopped, and
 * the row says which one and why.
 */
const PERMANENT_DISPATCH_CODES = ['invalid_job_params', 'E_PARAMS_INVALID', 'E_SCRIPT_NOT_FOUND', 'script_not_found', 'E_NOT_SUPPORTED']

/** Will the farm refuse this dispatch again, however long we wait? */
export function isPermanentDispatchFailure(message: string): boolean {
  return PERMANENT_DISPATCH_CODES.some((code) => message.includes(code))
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
  /*
    `skipped` goes again too, and that is not a generalisation — it is what a
    stopped sequence leaves behind.

    A workflow row's failure stops the engine, so every activity after it is
    marked `skipped`: it never ran. Retrying only the failed one would send a
    three-activity sequence back as a one-activity sequence and quietly drop the
    two the operator is still waiting for. Found on hardware (2026-09-20), on
    the very run that proved `sequenceOutcome` right.

    A `skipped` step on a job-per-activity row carries the same fact — nothing
    was sent for it — so this is one rule rather than a mode-dependent one.
  */
  const again = (state: WarmupStepState): boolean => state === 'failed' || state === 'skipped'
  if (!run.steps.some((step) => again(step.state))) return null
  const steps = run.steps.map((step) =>
    again(step.state) ? { ...step, state: 'pending' as const, jobId: null, error: null, startedAt: null, settledAt: null, notBeforeAt: now } : step,
  )
  return withRunSummary({ ...run, steps })
}

/** Which platforms a session's rows actually covered, for the page's header. */
export function platformsCovered(runs: readonly WarmupRun[]): PlatformId[] {
  const seen = new Set<PlatformId>()
  for (const run of runs) if (run.platform !== null) seen.add(run.platform)
  return [...seen]
}
