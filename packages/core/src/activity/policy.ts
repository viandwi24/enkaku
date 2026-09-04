import type { ActivityKind, DeviceActivity, PolicyDecision } from '@enkaku/protocol'

export type Decision = 'allow' | 'warn' | 'forbid'
export type StartingKind = ActivityKind
export type ExistingKind = ActivityKind

/**
 * MVP 04 §1.3, transcribed. Rows are the activity about to start, columns the
 * one already on the device. A column absent from the table is `allow`.
 * `job` and `workflow-job` share a row and a column. `wake` and `network-apply`
 * share a row. `control` over `control` is read from `settings.overControl`,
 * never from this table. The `prep` and `agent` rows are proposed (§9 Q1).
 */
export const POLICY: Record<StartingKind, Partial<Record<ExistingKind, Decision>>> = {
  job: { job: 'forbid', 'workflow-job': 'forbid', install: 'forbid', control: 'allow', command: 'warn', prep: 'warn' },
  'workflow-job': { job: 'forbid', 'workflow-job': 'forbid', install: 'forbid', control: 'allow', command: 'warn', prep: 'warn' },
  install: { job: 'forbid', 'workflow-job': 'forbid', install: 'forbid', control: 'allow', command: 'warn', prep: 'warn' },
  // A person taking control of a device a job is driving is ALLOWED, with no
  // sentence to dismiss (CEO, 2026-09-04, revising MVP 04 §2's table). The
  // warn this replaces read "your taps will interfere", which states the
  // opposite of the intent: an operator reaching into a running job is
  // usually helping it past something, and that is the whole point of being
  // able to watch a farm work. Only job-over-job stays exclusive.
  control: { job: 'allow', 'workflow-job': 'allow', install: 'allow', command: 'allow', prep: 'allow' },
  command: { job: 'warn', 'workflow-job': 'warn', install: 'warn', control: 'allow', command: 'allow', prep: 'allow' },
  transfer: { job: 'allow', 'workflow-job': 'allow', install: 'forbid', control: 'allow', command: 'allow', prep: 'allow' },
  wake: { job: 'forbid', 'workflow-job': 'forbid', install: 'forbid', control: 'allow', command: 'allow', prep: 'allow' },
  'network-apply': { job: 'forbid', 'workflow-job': 'forbid', install: 'forbid', control: 'allow', command: 'allow', prep: 'allow' },
  // Proposed (§9 Q1): a preparation pass reinstalls on-device tooling, so it never runs under a job or an install.
  prep: { job: 'forbid', 'workflow-job': 'forbid', install: 'forbid', control: 'allow', command: 'allow', prep: 'forbid' },
  // Proposed (§9 Q1): an agent is an operator with a longer attention span; same row as `control`.
  agent: { job: 'warn', 'workflow-job': 'warn', install: 'warn', control: 'allow', command: 'allow', prep: 'allow' },
}

export interface ControlPolicySettings {
  overControl: 'allow' | 'warn' | 'forbid'
  idleSec: number
}

export interface EvaluateOptions {
  /** Ids to ignore in `existing`: the caller's own marker (`control:<clientId>`) or its own agent activity. */
  selfIds?: string[]
  /** Capability-declared extra exclusions (§4.4): any live activity of these kinds is `forbid`. */
  exclusiveWith?: ActivityKind[]
}

const DECISION_RANK: Record<Decision, number> = { allow: 0, warn: 1, forbid: 2 }

export const SENTENCES: Record<Decision, (starting: StartingKind, conflicting: DeviceActivity) => string> = {
  allow: () => '',
  warn: (s, c) => (s === 'control' || s === 'agent' ? `${c.label}; your taps will interfere` : `${c.label}; starting ${s} anyway`),
  forbid: (s, c) => `${c.label}; ${s} cannot start until it ends`,
}

/** The worst decision over every live activity wins; `forbid` > `warn` > `allow`. */
export function evaluate(starting: StartingKind, existing: DeviceActivity[], settings: ControlPolicySettings, opts?: EvaluateOptions): PolicyDecision {
  const selfIds = new Set(opts?.selfIds ?? [])
  const exclusiveWith = new Set(opts?.exclusiveWith ?? [])
  let worst: Decision = 'allow'
  let worstActivity: DeviceActivity | undefined

  for (const activity of existing) {
    if (selfIds.has(activity.id)) continue

    let decision: Decision
    if (exclusiveWith.has(activity.kind)) {
      decision = 'forbid'
    } else if (starting === 'control' && activity.kind === 'control') {
      decision = settings.overControl
    } else {
      decision = POLICY[starting]?.[activity.kind] ?? 'allow'
    }

    if (DECISION_RANK[decision] > DECISION_RANK[worst]) {
      worst = decision
      worstActivity = activity
    }
  }

  if (worst === 'allow' || !worstActivity) return { decision: 'allow', message: '' }
  return { decision: worst, message: SENTENCES[worst](starting, worstActivity), conflicting: worstActivity }
}
