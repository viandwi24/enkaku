import { isDeviceFree, type RouterDevice } from './posts'
import { dueSequence, nextStep, type WarmupRow, type WarmupStepRow } from './warmup-rows'

/**
 * The decisions a warm-up tick makes, separated from the calls it makes
 * (plan 900 D1, wave 3).
 *
 * `index.ts` owns the reads, the dispatches and the writes; everything that has
 * to be RIGHT lives here, where a test can ask it directly. The same split
 * `planDispatch` has, for the same reason: a router tick is the one code path
 * that is hardest to reproduce by hand and easiest to get subtly wrong.
 */

/**
 * What a tick decided to send.
 *
 * `steps` is one activity on a job-per-activity row and the WHOLE remaining
 * sequence on a workflow one (plan 908) — the caller sends one job either way,
 * and marks exactly these steps as queued against it.
 */
export interface WarmupDispatch {
  run: WarmupRow
  steps: WarmupStepRow[]
  deviceId: string
  /** How to send it: one script job, or one workflow job carrying the lot. */
  as: 'job' | 'workflow'
}

/**
 * Which activities go out this tick.
 *
 * Three rules, and each of them cost something to learn on the posting side:
 *
 * - **one phone, one job.** A phone already carrying a Social job — a post
 *   dispatched this same tick (`claimed`), or a warm-up step still out — takes
 *   nothing else. `device.list`'s `activities` was read before either job
 *   existed, so it cannot see a job this tick just made.
 * - **a busy or offline phone is skipped, not failed.** It frees itself, and
 *   the step keeps its place in the queue; the next tick tries again.
 * - **posting wins a tie.** The caller passes the phones the post pass already
 *   claimed, so a warm-up never takes a phone out from under a real upload.
 *   A warm-up is the lowest-value work on the farm and should behave like it.
 *
 * Deliberately NOT capped by the session's `concurrency`. The spread is the
 * start jitter — eighty phones each waiting a random 0-120 s — and a second
 * cap on top of it would hold a phone past its turn and stretch the gaps the
 * operator chose into whatever the queue happened to be doing.
 */
export function planWarmupTick(input: {
  runs: readonly WarmupRow[]
  devices: ReadonlyMap<string, RouterDevice>
  /** Phones already spoken for this tick, by the post pass or by a warm-up step still in the air. */
  claimed: ReadonlySet<string>
  now: number
}): WarmupDispatch[] {
  const { runs, devices, claimed, now } = input
  const taken = new Set(claimed)
  const out: WarmupDispatch[] = []
  for (const run of runs) {
    if (taken.has(run.deviceId)) continue
    const sequence = dueSequence(run, now)
    const step = sequence === null ? nextStep(run, now) : null
    if (sequence === null && step === null) continue
    const device = devices.get(run.deviceId)
    // A phone that has left the farm is not a failure of this step: the session
    // keeps it, and it runs if the phone comes back. `planDispatch` gives a row
    // whose phone stays away long enough its own failure; a warm-up has no
    // deadline to miss, so it simply waits.
    if (!device || !isDeviceFree(device)) continue
    taken.add(run.deviceId)
    out.push(sequence !== null ? { run, steps: sequence, deviceId: run.deviceId, as: 'workflow' } : { run, steps: [step as WarmupStepRow], deviceId: run.deviceId, as: 'job' })
  }
  return out
}

/** The phones a set of runs already has jobs out on — they take nothing else this tick. */
export function phonesInFlight(runs: readonly WarmupRow[]): Set<string> {
  const out = new Set<string>()
  for (const run of runs) if (run.steps.some((step) => step.state === 'queued')) out.add(run.deviceId)
  return out
}

/** The step rows of one run, with `activityId` moved to `state`, leaving the rest untouched. */
export function withStepState(run: WarmupRow, activityId: string, patch: Partial<WarmupStepRow>): WarmupRow {
  return { ...run, steps: run.steps.map((step) => (step.activityId === activityId ? { ...step, ...patch } : step)) }
}

/** Every queued step that has a job to ask about. */
export function queuedSteps(run: WarmupRow): WarmupStepRow[] {
  return run.steps.filter((step) => step.state === 'queued' && step.jobId !== null)
}
