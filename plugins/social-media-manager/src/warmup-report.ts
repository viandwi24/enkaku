import { WARMUP_STEP_STATES, rollUpPhases, type WarmupRowState, type WarmupStepState } from './warmup-rows'

/**
 * What a warm-up session looks like when you stand back from it.
 *
 * The rows are stored one per phone PER PHASE, because that is what the
 * dispatcher needs: a phase is a separate pass over the fleet with its own
 * platform and its own schedule. It is not what a person needs. A three-phase
 * session over fourteen phones stores forty-two rows, and the detail screen
 * rendered them as forty-two lines — three of them for the same phone, with
 * the phone's name repeated and nothing saying the three belonged together
 * (owner, 2026-09-20: *"bisa di gruping lagi ngga ... biar enak per 1 devices
 * 1 field"*).
 *
 * So this module is the other view of the same rows: one entry per PHONE, with
 * its phases inside it, plus the numbers a person actually asks for — how many
 * answered, how many of those were good, how long it has been running, when
 * the last planned activity is due.
 *
 * Pure, and deliberately separate from `warmup-runs.ts`. That module owns what
 * the dispatcher writes; this one owns what the screen reads. Neither imports
 * the other's job, and a test can ask either one directly.
 */

/**
 * What this module needs of a step and a run — and nothing else.
 *
 * Deliberately NOT `WarmupRow`. The same rows are read in two places with two
 * schemas: the plugin's own (`warmup-runs.ts`, which also carries `params`,
 * `script` and `sequence` because the dispatcher needs them) and the browser
 * mirror in `ui/shared.ts`, which parses what the storage API returns and
 * types `platform` as a plain string. Both satisfy the shapes below, so one
 * implementation and one set of tests serve both, and neither side has to
 * widen its schema to borrow the other's reader.
 */
export interface ReportStep {
  state: WarmupStepState
  notBeforeAt: number
  startedAt: number | null
  settledAt: number | null
}

export interface ReportRun {
  deviceId: string
  deviceName: string | null
  phase: number
  platform: string | null
  note: string | null
  state: WarmupRowState
  steps: readonly ReportStep[]
}

/** Every step state, counted. Always all five keys, so a caller can read one without checking. */
export type StepCounts = Record<WarmupStepState, number>

const emptyCounts = (): StepCounts => ({ pending: 0, queued: 0, success: 0, failed: 0, skipped: 0 })

/** One phone, with every phase it was planned for. Generic, so a caller gets its OWN run type back in `phases`. */
export interface DeviceRollup<R extends ReportRun = ReportRun> {
  deviceId: string
  deviceName: string | null
  /** This phone's rows, in phase order — including the phases it was given nothing in. */
  phases: R[]
  /**
   * Only the phases that actually got a platform.
   *
   * A session covering three platforms writes three rows per phone, and a
   * phone carrying two of them has a third that `planWarmup` deliberately
   * leaves empty so the same account is never warmed up twice. That row is
   * bookkeeping, not an outcome, and a screen that draws it makes the operator
   * ask what is wrong with it.
   */
  covered: R[]
  /** The platforms it was actually given, in phase order, each once. */
  platforms: string[]
  /** Rolled up across the phases, by the same rule a run uses over its steps. */
  state: WarmupRowState
  counts: StepCounts
  /** Activities planned for this phone across every phase. */
  activities: number
  /** True when no phase gave it anything — `note` says why. */
  idle: boolean
  note: string | null
}

/**
 * The phase states of one phone, as one state.
 *
 * The ladder itself lives in `warmup-runs.ts`, because the session LIST needs
 * it too — its one-line summary counts phones, and counting rows there is what
 * made a fourteen-phone farm report "42 phones". One implementation, so the
 * list and the detail page cannot disagree about what a phone is doing.
 */
export function rollUpState(states: readonly WarmupRowState[]): WarmupRowState {
  return rollUpPhases(states)
}

/** One entry per phone, phones in the order their rows first appear. */
export function rollUpByDevice<R extends ReportRun>(runs: readonly R[]): DeviceRollup<R>[] {
  const byId = new Map<string, R[]>()
  for (const run of runs) {
    const list = byId.get(run.deviceId)
    if (list) list.push(run)
    else byId.set(run.deviceId, [run])
  }

  const out: DeviceRollup<R>[] = []
  for (const [deviceId, rows] of byId) {
    const phases = [...rows].sort((a, b) => a.phase - b.phase)
    const counts = emptyCounts()
    let activities = 0
    const platforms: string[] = []
    for (const run of phases) {
      if (run.platform !== null && !platforms.includes(run.platform)) platforms.push(run.platform)
      for (const step of run.steps) {
        counts[step.state] += 1
        activities += 1
      }
    }
    out.push({
      deviceId,
      deviceName: phases.find((run) => run.deviceName !== null)?.deviceName ?? null,
      phases,
      covered: phases.filter((run) => run.platform !== null),
      platforms,
      state: rollUpState(phases.map((run) => run.state)),
      counts,
      activities,
      idle: activities === 0,
      note: phases.find((run) => run.note !== null)?.note ?? null,
    })
  }
  return out
}

/** The numbers above the table. */
export interface SessionReport {
  /** Phones with a row — the fleet this session was planned over. */
  phones: number
  /** Of those, the ones given something to do. */
  working: number
  /** And the ones given nothing, each for a reason its row carries. */
  idle: number
  activities: number
  counts: StepCounts
  /** Activities that have an answer: success plus failed. Not skipped — nobody asked those. */
  settled: number
  /**
   * `success / settled`, or `null` when nothing has answered yet.
   *
   * Null rather than 0, and the screen must render it as "—". A session two
   * minutes old with nothing settled has not got a 0% success rate; it has no
   * success rate, and showing one reads as a fleet-wide failure.
   */
  successRate: number | null
  /** When the first activity actually started, not when the session was planned. */
  startedAt: number | null
  /** The last answer's instant. */
  lastSettledAt: number | null
  /** First start to last answer, or to now while anything is still out. */
  elapsedSec: number | null
  /**
   * Seconds until the last activity still waiting is DUE — the plan's own
   * pacing, not a forecast of how long the scripts take.
   *
   * `0` means everything waiting is already due and is queueing; `null` means
   * nothing is waiting. It is called `due` and not `eta` on purpose: the
   * honest thing this data supports is "the last one is due in 4 minutes",
   * never "this session finishes at 15:12".
   */
  lastDueInSec: number | null
  /** True when no activity is pending or queued. */
  finished: boolean
}

export function sessionReport(runs: readonly ReportRun[], now: number): SessionReport {
  const counts = emptyCounts()
  let activities = 0
  let phones = 0
  let idle = 0
  let startedAt: number | null = null
  let lastSettledAt: number | null = null
  let lastDueAt: number | null = null

  for (const device of rollUpByDevice(runs)) {
    phones += 1
    if (device.idle) idle += 1
    activities += device.activities
    for (const state of WARMUP_STEP_STATES) counts[state] += device.counts[state]
    for (const run of device.phases) {
      for (const step of run.steps) {
        if (step.startedAt !== null && (startedAt === null || step.startedAt < startedAt)) startedAt = step.startedAt
        if (step.settledAt !== null && (lastSettledAt === null || step.settledAt > lastSettledAt)) lastSettledAt = step.settledAt
        if (step.state === 'pending' && (lastDueAt === null || step.notBeforeAt > lastDueAt)) lastDueAt = step.notBeforeAt
      }
    }
  }

  const settled = counts.success + counts.failed
  const waiting = counts.pending + counts.queued
  const finished = waiting === 0
  return {
    phones,
    working: phones - idle,
    idle,
    activities,
    counts,
    settled,
    successRate: settled === 0 ? null : counts.success / settled,
    startedAt,
    lastSettledAt,
    elapsedSec: startedAt === null ? null : Math.max(0, (finished && lastSettledAt !== null ? lastSettledAt : now) - startedAt),
    lastDueInSec: lastDueAt === null ? null : Math.max(0, lastDueAt - now),
    finished,
  }
}

/** `3m 20s`, `1h 04m`, `12s` — a duration a person reads, never a raw second count. */
export function readDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`
  const h = Math.floor(m / 60)
  return `${h}h ${String(m % 60).padStart(2, '0')}m`
}
