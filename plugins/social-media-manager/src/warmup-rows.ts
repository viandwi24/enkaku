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
 * `warmup:<groupId>:<runId>:<phase>:<deviceId>` — one row per phone PER PHASE,
 * inside one RUN of the session.
 *
 * Two things are in this key that a reader might expect to be only in the row.
 *
 * **The phase**, because a session with three phases gives a phone three
 * separate pieces of work, each with its own platform and its own schedule.
 * One row per phone would make the second phase overwrite the first.
 *
 * **The run** (0.58.0), because a session is a thing you start AGAIN. The
 * owner put it plainly: start it on the 20th, start it again on the 21st, and
 * *"tanggal 20 masih ada, tapi tanggal 21 juga ada juga"*. Without the runId
 * the second start would write over the first phone-for-phone, and the
 * session would be a thing with no memory — which is the opposite of what
 * somebody looks at a warm-up for.
 *
 * The prefix read is still `warmup:<groupId>:`, so the router sees every run
 * of every session in one scan and the rows say which run they belong to.
 */
export function warmupRowKey(groupId: string, runId: string, phase: number, deviceId: string): string {
  return `${WARMUP_PREFIX}${groupId}:${runId}:${phase}:${deviceId}`
}

/** Just one run's rows. */
export function warmupRunPrefix(groupId: string, runId: string): string {
  return `${WARMUP_PREFIX}${groupId}:${runId}:`
}

/**
 * A run id from the moment it started: `r-<unix seconds>-<4 hex>`.
 *
 * Sortable by name, which is what makes "the newest run" a string comparison
 * rather than a scan — and readable, so a key in a storage dump says when its
 * run began without anything having to decode it.
 */
export function newRunId(nowSec: number): string {
  return `r-${nowSec}-${Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0')}`
}

/**
 * The id a row written before runs existed belongs to.
 *
 * Every session made before 0.58.0 had exactly one run, and its rows have no
 * runId in their key or their value. They are read as this run rather than
 * skipped: a farm that upgrades keeps its history, which is the whole point of
 * the feature that introduced the field.
 */
export const LEGACY_RUN_ID = 'r-first'

/**
 * Everything under one session, for a prefix read.
 *
 * A note on the two words this plugin now uses, because they were one word
 * until 0.58.0 and the collision was confusing: a **row** is one phone's work
 * in one pass over the fleet — this file. A **run** is one of those passes,
 * with its own id, its own start and its own history. A session that has been
 * started three times has three runs, and each run has one row per phone.
 */
export function warmupRowPrefix(groupId: string): string {
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
export const WARMUP_ROW_STATES = ['pending', 'running', 'done', 'partial', 'failed', 'skipped'] as const
export type WarmupRowState = (typeof WARMUP_ROW_STATES)[number]

export const WarmupRowSchema = z.object({
  version: z.literal(1),
  groupId: z.string().min(1),
  /**
   * Which RUN of the session this row belongs to (0.58.0).
   *
   * Defaulted, and the default is the whole migration: a row written before
   * runs existed is read as the session's first run rather than skipped, so a
   * farm that upgrades keeps every session's history instead of appearing to
   * lose it.
   */
  runId: z.string().min(1).default(LEGACY_RUN_ID),
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
  state: z.enum(WARMUP_ROW_STATES).default('pending'),
  summary: z.string().max(200).nullable().default(null),
  /**
   * This RUN is stopped: the router sends nothing for it until it is started
   * again (0.59.0).
   *
   * On the row and not on the session, because stopping is a thing you do to a
   * RUN. A session is a definition — "warm the fleet up like this" — and
   * stopping a definition is meaningless; what an operator wants stopped is
   * tonight's pass, while last night's history stays exactly as it was. The
   * session list's Stop therefore aims at the newest run, which is what
   * somebody pressing it means.
   *
   * Every row of a run carries the same value. That is not duplication for its
   * own sake: stopping already rewrites every row to pull its work back, so
   * the flag rides along for free, and the rows stay the single source of
   * truth about what a run is doing — the same reason `runsOf` derives a run's
   * report from them rather than from a record beside them.
   */
  stopped: z.boolean().default(false),
  /**
   * This row's place in its run's queue (0.64.0, `warmup-queue.ts`). Drawn once when the run is
   * made, a shuffle of the phones, so the queue is random but stays the order it was. `null` on a
   * row written before the queue existed.
   */
  queueSeq: z.number().int().nonnegative().nullable().default(null),
  /** When the queue let this row out (0.64.0). `null` while it is still waiting its turn. */
  admittedAt: z.number().int().nonnegative().nullable().default(null),
})
export type WarmupRow = z.infer<typeof WarmupRowSchema>

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
  /** Which run of the session these rows belong to. */
  runId: string
  assignments: readonly WarmupAssignment[]
  phase: number
  startedAt: number
  names?: ReadonlyMap<string, string>
  sequence?: 'jobs' | 'workflow'
  /** Each phone's place in the run's queue — the same for all of its phases. */
  queueSeq?: ReadonlyMap<string, number>
}): WarmupRow[] {
  const { groupId, runId, assignments, phase, startedAt, names } = input
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
    const run: WarmupRow = {
      version: 1,
      groupId,
      runId,
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
      stopped: false,
      queueSeq: input.queueSeq?.get(assignment.deviceId) ?? null,
      admittedAt: null,
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
export function nextStep(run: WarmupRow, now: number): WarmupStepRow | null {
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
export function dueSequence(run: WarmupRow, now: number): WarmupStepRow[] | null {
  if (run.sequence !== 'workflow') return null
  if (run.steps.some((step) => step.state === 'queued')) return null
  const pending = run.steps.filter((step) => step.state === 'pending')
  const first = pending[0]
  if (!first || first.notBeforeAt > now) return null
  return pending
}

/** Is this run finished — nothing pending, nothing out? */
export function isRunOver(run: WarmupRow): boolean {
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
export function warmupRowState(steps: readonly { state: WarmupStepState }[]): WarmupRowState {
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
export function warmupRunSummary<S extends { state: WarmupStepState }>(run: { steps: readonly S[]; note: string | null; platform: string | null }): string {
  if (run.steps.length === 0) return run.note ?? 'Nothing to do'
  const done = run.steps.filter((step) => step.state === 'success').length
  const failed = run.steps.filter((step) => step.state === 'failed').length
  const where = run.platform ?? 'no platform'
  const state = warmupRowState(run.steps)
  if (state === 'pending') return `${where} — waiting to start`
  if (state === 'running') return `${where} — ${done + failed} of ${run.steps.length} done`
  if (state === 'done') return `${where} — all ${run.steps.length} activities done`
  if (state === 'failed') return `${where} — all ${run.steps.length} failed`
  return `${where} — ${done} done, ${failed} failed`
}

/**
 * The row with its state and summary recomputed from its own steps, so the two
 * can never disagree.
 *
 * Generic since 0.59.2, for the same reason `retryFailedSteps` is: the browser
 * runs Retry and Stop now, and it holds a narrower mirror of this schema. When
 * this was service-only, a retried row kept its old `failed` state on screen
 * until the router next WROTE it — and the router only writes a row it
 * changes, so "failed" sat there until the activity was dispatched. A state
 * that contradicts the steps beside it is exactly the ghost the operator
 * taught us to hunt.
 */
export function withRunSummary<S extends { state: WarmupStepState }, R extends { steps: readonly S[]; note: string | null; platform: string | null }>(
  run: R,
): R & { state: WarmupRowState; summary: string } {
  const state = warmupRowState(run.steps)
  return { ...run, state, summary: warmupRunSummary(run) }
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
export function warmupProgress(runs: readonly WarmupRow[]): WarmupProgress {
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
  const byDevice = new Map<string, WarmupRowState[]>()
  for (const run of runs) {
    const list = byDevice.get(run.deviceId)
    if (list) list.push(warmupRowState(run.steps))
    else byDevice.set(run.deviceId, [warmupRowState(run.steps)])
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
export function rollUpPhases(states: readonly WarmupRowState[]): WarmupRowState {
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
 * Refusals the farm will repeat, whatever it is asked again.
 *
 * `E_BAD_INPUT` is the one this exists for: the params are wrong, and they
 * will be exactly as wrong in fifteen seconds. `E_FORBIDDEN` and `E_NO_GRANT`
 * are the same shape — the plugin lacks a permission, and only an operator can
 * change that.
 *
 * Everything else is transient and SHOULD be retried: `E_DEVICE_CONFLICT` and
 * `E_DEVICE_OFFLINE` are a phone that is busy or away, `E_DEADLINE` and
 * `E_INTERNAL` are the farm having a bad moment.
 *
 * ## Why this matters more than it looks
 *
 * A dispatch that throws leaves its step PENDING on purpose — a row claiming a
 * job that does not exist would wait for an answer for ever. For a transient
 * fault that is exactly right. For a permanent one it is a trap, and the trap
 * has teeth: `planWarmupTick` claims the phone for a row BEFORE the dispatch
 * is attempted, so a row that can never be sent starves every other row on
 * that phone. One bad activity stops a phone's whole warm-up, and every
 * session still reads healthy.
 */
const PERMANENT_DISPATCH_CODES = new Set(['E_BAD_INPUT', 'E_FORBIDDEN', 'E_NO_GRANT', 'E_PARAMS_INVALID', 'invalid_job_params', 'E_SCRIPT_NOT_FOUND', 'script_not_found', 'E_NOT_SUPPORTED'])

/**
 * Will the farm refuse this dispatch again, however long we wait?
 *
 * Reads the error's CODE, and falls back to its text only for the callers that
 * have lost the object. Matching on message substrings was how this was first
 * written, and it missed the very case it was built for: the broker's refusal
 * message names the capability and the actor and never the code, so an
 * `E_BAD_INPUT` about a missing `query` read as transient and retried for ever
 * (owner's farm, 2026-09-21).
 */
export function isPermanentDispatchFailure(err: unknown): boolean {
  const code = typeof err === 'object' && err !== null && 'code' in err ? String((err as { code: unknown }).code) : null
  if (code !== null && PERMANENT_DISPATCH_CODES.has(code)) return true
  const text = err instanceof Error ? err.message : String(err ?? '')
  return [...PERMANENT_DISPATCH_CODES].some((known) => text.includes(known))
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
export function retryFailedSteps<S extends { state: WarmupStepState }, R extends { steps: readonly S[] }>(run: R, now: number): R | null {
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
    again(step.state) ? ({ ...step, state: 'pending', jobId: null, error: null, startedAt: null, settledAt: null, notBeforeAt: now } as S) : step,
  )
  /*
    The caller applies `withRunSummary` — it is generic now, so the browser can
    too. Leaving the state stale here was a real bug for a moment: the router
    only writes a row it CHANGES, so a retried row kept saying `failed` until
    its activity was dispatched, which could be minutes.
  */
  return { ...run, steps }
}

/** Which platforms a session's rows actually covered, for the page's header. */
export function platformsCovered(runs: readonly WarmupRow[]): PlatformId[] {
  const seen = new Set<PlatformId>()
  for (const run of runs) if (run.platform !== null) seen.add(run.platform)
  return [...seen]
}
