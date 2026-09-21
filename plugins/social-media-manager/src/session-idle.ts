/**
 * When a session has nothing left that any connected phone can do (0.63.0).
 *
 * The owner, watching a warm-up over 73 phones with 20 connected (2026-09-21): the twenty ran and
 * finished, the other fifty-three waited — for ever, since a warm-up has no deadline to miss — and
 * the moment those phones were plugged back in, every one of them had a pile of overdue activities
 * and they all went at once: *"sekali konek langsung rebutan script warmup langsung jalan"*. What they
 * asked for was two things: detect that nothing can be worked on and pause, and let THEM decide when
 * it starts again.
 *
 * This module is the first half: the verdict. It depends on nothing and knows nothing of storage, so
 * the router (which acts on it) and the page (which explains it) read one rule.
 *
 * ## Idle means all four
 *
 * 1. There is work left — a warm-up activity still pending, a post platform still waiting.
 * 2. Nothing is in flight — no activity queued, no post dispatched. A job out is progress in waiting.
 * 3. No connected phone could take any of it. A phone that is BUSY frees itself; one that is offline
 *    needs a person, which is the only wait worth pausing for.
 * 4. That has been true for `AUTO_PAUSE_AFTER_SEC`. Phones drop for a minute all the time — a cable, a
 *    reboot — and pausing a session over that would be the router inventing an outage.
 *
 * A session that is merely FINISHED is never idle: there is nothing to pause.
 */

/** Ten minutes. Longer than a phone's routine drop-out, far shorter than a shift. */
export const AUTO_PAUSE_AFTER_SEC = 10 * 60

export interface IdleVerdict {
  idle: boolean
  /** How many phones (warm-up) or posts (post session) are waiting. Zero when not idle. */
  waiting: number
  /** The sentence the page shows beside a session this paused. `null` when not idle. */
  reason: string | null
}

const NOT_IDLE: IdleVerdict = { idle: false, waiting: 0, reason: null }

/** What this module needs of a warm-up step and row — a structural subset of `WarmupRow`. */
export interface IdleStep {
  state: string
  notBeforeAt: number
  startedAt?: number | null
  settledAt?: number | null
}

export interface IdleRun {
  deviceId: string
  stopped?: boolean
  steps: readonly IdleStep[]
}

/**
 * Is this warm-up RUN idle? `rows` are every row of one run; `online` the ids of connected phones.
 *
 * "Last sign of life" is the latest step started or settled anywhere in the run. A run in which no
 * step ever went out — every phone offline from the start — is measured from the earliest time any
 * of its activities fell due, so it pauses ten minutes after it could first have started.
 */
export function warmupRunIdle(rows: readonly IdleRun[], online: ReadonlySet<string>, now: number, afterSec: number = AUTO_PAUSE_AFTER_SEC): IdleVerdict {
  // A row an older build stopped is not waiting for a phone; it is stopped.
  const waiting = rows.filter((row) => !row.stopped && row.steps.some((step) => step.state === 'pending'))
  if (waiting.length === 0) return NOT_IDLE
  if (rows.some((row) => row.steps.some((step) => step.state === 'queued'))) return NOT_IDLE
  const phones = new Set(waiting.map((row) => row.deviceId))
  for (const id of phones) if (online.has(id)) return NOT_IDLE

  /*
    The last sign of life: the latest step started or settled, or the latest moment a pending step FELL
    DUE, whichever is later. The second is what gives a run its window after it is started again: Start
    re-times every waiting step to now, so the run is not paused on the very next tick for a stall it
    has only just been rescued from. Only steps already due count — work scheduled for later (a phase
    still an hour off) is not waiting yet, and must not keep a stuck run looking alive.
  */
  const due = waiting.flatMap((row) => row.steps.filter((step) => step.state === 'pending' && step.notBeforeAt <= now).map((step) => step.notBeforeAt))
  if (due.length === 0) return NOT_IDLE
  let last = Math.max(...due)
  for (const row of rows) for (const step of row.steps) last = Math.max(last, step.startedAt ?? 0, step.settledAt ?? 0)
  if (now - last < afterSec) return NOT_IDLE

  const n = phones.size
  return {
    idle: true,
    waiting: n,
    reason: `Paused automatically: the ${n} phone${n === 1 ? '' : 's'} with activities still to do ${n === 1 ? 'is' : 'are'} all offline. Connect them and press Start again.`,
  }
}

/** What this module needs of a post and its platforms — a structural subset of `Post`. */
export interface IdleAttempt {
  /** When the attempt was sent (`Attempt.at`). */
  at?: number | null
  settledAt?: number | null
}

export interface IdlePlatformState {
  state: string
  attempts?: readonly IdleAttempt[]
  waitingSince?: number | null
}

export interface IdlePost {
  platforms: readonly string[]
  dispatch: Record<string, IdlePlatformState | undefined>
}

/**
 * Is this post SESSION idle? `posts` are every row of one session; `hasOnlinePhone(post, platform)`
 * answers whether any connected phone may take that platform of that post — the router's own rule
 * (`allowedPhonesFor`), passed in so this module stays free of fleet and labels.
 *
 * A post session measures its last sign of life from its attempts, and falls back to the moment the
 * router first saw a platform waiting (`waitingSince`). A platform with neither has not been looked at
 * by the router yet, and a session is never paused on a reading it has not taken.
 */
export function postSessionIdle<P extends IdlePost>(
  posts: readonly P[],
  hasOnlinePhone: (post: P, platform: string) => boolean,
  now: number,
  afterSec: number = AUTO_PAUSE_AFTER_SEC,
): IdleVerdict {
  const waiting: { post: P; platform: string; state: IdlePlatformState | undefined }[] = []
  for (const post of posts) {
    for (const platform of post.platforms) {
      const state = post.dispatch[platform]
      if (state?.state === 'dispatched') return NOT_IDLE
      if (state === undefined || state.state === 'pending') waiting.push({ post, platform, state })
    }
  }
  if (waiting.length === 0) return NOT_IDLE
  for (const pair of waiting) if (hasOnlinePhone(pair.post, pair.platform)) return NOT_IDLE

  /*
    `waitingSince` is the router's own record of when it first found a platform unable to go. It is
    written only once a row's turn has come, so a row still waiting for its turn (or for room under the
    session's "how many at once") has none, and is left out of the clock rather than holding it open.
    But at least ONE must be there: a session none of whose platforms the router has read since they
    last changed — new, or just started again (Start clears the clock) — is never paused on a reading
    it has not taken, which is also what stops Start being undone on the very next tick.
  */
  const seen = waiting.map((pair) => pair.state?.waitingSince ?? null).filter((at): at is number => at !== null)
  if (seen.length === 0) return NOT_IDLE
  let last = Math.max(...seen)
  for (const post of posts) {
    for (const platform of post.platforms) {
      for (const attempt of post.dispatch[platform]?.attempts ?? []) last = Math.max(last, attempt.at ?? 0, attempt.settledAt ?? 0)
    }
  }
  if (now - last < afterSec) return NOT_IDLE

  const n = new Set(waiting.map((pair) => pair.post)).size
  return {
    idle: true,
    waiting: n,
    reason: `Paused automatically: the ${n} post${n === 1 ? '' : 's'} still to go ${n === 1 ? 'is' : 'are'} waiting for phones that are all offline. Connect them and press Start again.`,
  }
}
