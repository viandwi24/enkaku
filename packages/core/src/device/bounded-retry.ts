import type { AgentState } from '@enkaku/protocol'

/**
 * Bounded-retry bookkeeping (plan 90 §3.7, §3.8; plan 106 §3.3) — extracted
 * from `agent-provisioner.ts`'s own `ensureImpl` (which this module now
 * calls into) once plan 106 needed the IDENTICAL shape for a second caller
 * (`device/preparation/runner.ts`). "Three attempts, capped, with a
 * schedule" is not a guest-agent-specific idea; it is a general answer to
 * "this thing gives up after N tries and must say so, clearably" — plan
 * 106's own brief names this directly: "ask: where else does this shape
 * appear?" This is the one place the arithmetic lives, so a future third
 * caller inherits it instead of copying it a second time.
 *
 * Deliberately pure and synchronous: no db, no clock of its own (the caller
 * supplies `checkedAt`), no adb — so a "gives up after N attempts, then a
 * forced retry clears it" test needs no fakes beyond plain numbers.
 */

export interface BoundedRetryInput {
  /**
   * This pass's settled state. Only `'failed'` accumulates attempts —
   * `'ready'`/`'outdated'` both reset the bound (`'outdated'` is a "repaired
   * once, still wrong" verdict, not a transient install failure, so it does
   * not accumulate attempts; agent-provisioner.ts's own documented
   * reasoning, unchanged here). `'consent-required'` resets it for the same
   * reason and one more: retrying cannot clear it — only a human accepting a
   * dialog on the phone can, and burning three automatic attempts against
   * that would replace a standing, readable state with an exhausted-budget
   * one that says less. `'absent'`/`'provisioning'`/`'unsupported'`
   * are accepted for typing convenience (a caller's settled-state type is
   * often the full `AgentState` enum) but are never actually produced by a
   * completed pass in this codebase — `'unsupported'` in particular is
   * terminal and handled before any retry math, exactly as
   * `agent-provisioner.ts`'s SDK-floor check already does; were one to
   * arrive here anyway, it resets the bound exactly like `'ready'`, never
   * silently counts as a failure.
   */
  result: AgentState
  /** The attempts already recorded, BEFORE this pass. */
  priorAttempts: number
  /** Unix epoch seconds this pass completed. */
  checkedAt: number
  /** e.g. `[5, 20, 60]` — one entry per attempt, in order; its length is the bound. */
  retryBackoffS: number[]
  /** An explicit retry (an operator's click, or a `force: true` caller) — the honest version of "try again from scratch": it must not inherit an already-exhausted budget. */
  forced: boolean
}

export interface BoundedRetryOutput {
  attempts: number
  nextAttemptAt: number | null
}

/** The next `{ attempts, nextAttemptAt }` pair to persist after one pass. */
export function nextBoundedRetry(input: BoundedRetryInput): BoundedRetryOutput {
  const priorAttempts = input.forced ? 0 : input.priorAttempts
  if (input.result !== 'failed') {
    return { attempts: 0, nextAttemptAt: null }
  }
  const attempts = Math.min(priorAttempts + 1, input.retryBackoffS.length)
  const backoff = input.retryBackoffS[Math.min(attempts, input.retryBackoffS.length) - 1] ?? input.retryBackoffS[input.retryBackoffS.length - 1]!
  const nextAttemptAt = attempts < input.retryBackoffS.length ? input.checkedAt + backoff : null
  return { attempts, nextAttemptAt }
}

/** True once a standing `failed` state has spent every attempt the backoff schedule allows — only an explicit (`force: true`) retry can move it. */
export function hasExhaustedRetryBudget(prior: { state: string; attempts: number }, retryBackoffS: number[]): boolean {
  return prior.state === 'failed' && prior.attempts >= retryBackoffS.length
}

/** True while a standing `failed` state is still waiting out its own backoff window (and has NOT exhausted its budget — callers check `hasExhaustedRetryBudget` first). */
export function isWithinBackoffWindow(prior: { nextAttemptAt: number | null }, checkedAt: number): boolean {
  return prior.nextAttemptAt !== null && checkedAt < prior.nextAttemptAt
}
