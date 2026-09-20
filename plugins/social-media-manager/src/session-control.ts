/**
 * Deliberately imports NOTHING from `posts.ts` or `warmup-runs.ts`.
 *
 * The same rows are read with two schemas — the service's and the browser
 * mirror in `ui/shared.ts` — and since 0.57.1 the STOP button runs in the
 * browser (see the header). One implementation has to satisfy both, so this
 * module states the little it needs of a row and the two helpers it needs of
 * `posts.ts`, rather than depending on either schema. `warmup-report.ts` is
 * built the same way for the same reason.
 */

/**
 * Stopping and starting a session, for both kinds.
 *
 * ## What the owner asked for, and what each word has to mean
 *
 * *"bisa di stop. sehingga memaksa yang lagi running di cancel, dan waiting di
 * masukan ke antrian terus ... tapi bisa di start lagi juga"* — so STOP is two
 * separate promises and START is a third:
 *
 * 1. **Nothing new goes out.** The router gate (`group.stopped`) does that, and
 *    it is the only half that needs no cleanup: a row that was never sent is
 *    already in the state it should be in.
 * 2. **What is out right now is pulled back.** A job is cancelled on the farm
 *    AND its row is returned to the state it had before it was sent, so the
 *    work is still owed. This is what makes stop different from "wait for it to
 *    finish": the operator pressing stop wants the phone free now.
 * 3. **Start owes the same work, at the same pace.** See `resumeWarmupRow`.
 *
 * ## Why a cancelled attempt is retired, not deleted
 *
 * The post rows keep replaced attempts in `history` (`withRetired`), and a stop
 * uses the same door a retry does. Deleting the attempt instead would leave a
 * session that was stopped mid-flight looking like it was never dispatched, and
 * "did this phone already open the app?" is exactly the question an operator
 * asks after stopping something.
 *
 * ## Why these are pure
 *
 * Cancelling is a farm call and writing is storage; both belong to the member.
 * What has to be RIGHT is which jobs to cancel and what the row becomes, and
 * that is decided here where a test can ask it directly — the same split
 * `planDispatch` and `planWarmupTick` already have.
 */

/** What this module needs of a post attempt. */
export interface ControlAttempt {
  jobId: string
  state: string
  error?: string | null
  settledAt?: number | null
}

/** And of one platform's dispatch on a post row. */
export interface ControlPlatformState {
  attempts: ControlAttempt[]
  history: ControlAttempt[]
  state: string
  deviceCount: number
  note: string | null
}

export interface ControlPost {
  platforms: readonly string[]
  dispatch: Record<string, ControlPlatformState | undefined>
}

/** And of a warm-up step and row. */
export interface ControlStep {
  state: string
  jobId: string | null
  notBeforeAt: number
  startedAt?: number | null
  settledAt?: number | null
  error?: string | null
}

export interface ControlRun {
  steps: ControlStep[]
}

/** How many replaced attempts a platform keeps — `posts.ts`'s own `HISTORY_LIMIT`, restated so this module depends on nothing. */
const HISTORY_LIMIT = 20

/** `posts.ts`'s `rollUp`, restated for the same reason. A platform's state, from the attempts left on it. */
function rollUp(attempts: readonly ControlAttempt[]): string {
  if (attempts.length === 0) return 'pending'
  if (attempts.some((a) => a.state === 'queued')) return 'dispatched'
  const ok = attempts.filter((a) => a.state === 'success').length
  const bad = attempts.filter((a) => a.state === 'failed').length
  if (ok === attempts.length) return 'succeeded'
  if (bad === attempts.length) return 'failed'
  return 'partial'
}

/** A row rewritten by a stop, and the jobs the caller must now cancel. */
export interface StopResult<R> {
  row: R
  /** Distinct job ids, in the order they were found. */
  cancel: string[]
  /** How many units of work went back to owing — attempts for a post, activities for a warm-up. */
  pulled: number
}

const WAS_STOPPED = 'The session was stopped, so this attempt was cancelled. Starting the session sends it again.'

/**
 * Pull back one post row.
 *
 * Only `queued` attempts are touched. A `success`, a `failed` and an
 * `unverified` are all answers that already happened, and a stop must not
 * rewrite history — least of all a success, which would send a video twice.
 */
export function stopPostRow<P extends ControlPost>(post: P, now: number): StopResult<P> {
  const dispatch: Record<string, ControlPlatformState | undefined> = { ...post.dispatch }
  const cancel: string[] = []
  let pulled = 0

  for (const platformId of post.platforms) {
    const state = post.dispatch[platformId]
    if (!state) continue
    const inFlight = state.attempts.filter((attempt) => attempt.state === 'queued')
    if (inFlight.length === 0) continue
    const kept = state.attempts.filter((attempt) => attempt.state !== 'queued')
    const retired = inFlight.map((attempt) => ({ ...attempt, state: 'failed', error: WAS_STOPPED, settledAt: now }))
    for (const attempt of inFlight) if (!cancel.includes(attempt.jobId)) cancel.push(attempt.jobId)
    pulled += inFlight.length
    dispatch[platformId] = { ...state, attempts: kept, history: [...state.history, ...retired].slice(-HISTORY_LIMIT), state: rollUp(kept), deviceCount: kept.length, note: WAS_STOPPED }
  }

  return { row: pulled === 0 ? post : { ...post, dispatch }, cancel, pulled }
}

/**
 * Pull back one warm-up row.
 *
 * A queued activity goes back to `pending` with its job forgotten. It keeps its
 * place in the sequence and its `notBeforeAt`, which `resumeWarmupRow` then
 * re-bases — so a stopped-and-started session runs the rest of the plan, not a
 * compressed version of it.
 */
export function stopWarmupRow<R extends ControlRun>(run: R, now: number): StopResult<R> {
  const cancel: string[] = []
  let pulled = 0
  const steps = run.steps.map((step) => {
    if (step.state !== 'queued') return step
    if (step.jobId !== null && !cancel.includes(step.jobId)) cancel.push(step.jobId)
    pulled += 1
    return { ...step, state: 'pending', jobId: null, startedAt: null, settledAt: null, error: null, notBeforeAt: Math.max(step.notBeforeAt, now) }
  })
  /* The caller applies `withRunSummary`, which is generic, so browser and service both can. */
  return { row: pulled === 0 ? run : { ...run, steps }, cancel, pulled }
}

/**
 * Re-base a stopped warm-up's remaining schedule onto now.
 *
 * A session stopped for three hours has every waiting activity due long in the
 * past, and starting it would hand the whole remaining plan to the router at
 * once — one activity per phone per tick, so no flood, but with every gap the
 * operator chose collapsed to fifteen seconds. The pacing IS the feature here:
 * a warm-up that fires four activities back to back on one phone is the exact
 * shape a platform looks for.
 *
 * So every waiting step shifts by the SAME amount — the gap between the
 * earliest one and now — which preserves the intervals between them rather
 * than re-drawing them. A step that was already due before the stop is due
 * immediately again; one that was ten minutes behind it stays ten minutes
 * behind it.
 *
 * Returns the row unchanged when nothing is waiting or nothing is overdue,
 * so a session started again within its own pacing keeps the plan it had.
 */
export function resumeWarmupRow<R extends ControlRun>(run: R, now: number): R {
  const waiting = run.steps.filter((step) => step.state === 'pending')
  if (waiting.length === 0) return run
  const earliest = Math.min(...waiting.map((step) => step.notBeforeAt))
  const shift = now - earliest
  if (shift <= 0) return run
  return { ...run, steps: run.steps.map((step) => (step.state === 'pending' ? { ...step, notBeforeAt: step.notBeforeAt + shift } : step)) }
}
