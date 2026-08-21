import { PROXY_FAILOVER_EVENT, PROXY_PROBE_SKIP_REASON, type ProxyProbeResult, type ProxyRecord, type ProxyUpstream } from '../shared'
import { proxySubject, type LogSink } from './logbook'
import type { UpstreamHolder } from './listener'
import type { Upstream } from './upstream'

/**
 * The per-record failure counter and confirmation-probe-gated switch (plan
 * 121 §3.2, §4.2, step 121.3; widened by step 121.4 for per-slot secrets).
 *
 * ## The false-positive problem this exists to solve
 *
 * A dial failure through the active upstream is ambiguous on its own: it
 * could mean the upstream itself is down, or it could mean the target
 * site is having a bad day. Switching on the first kind is the whole point
 * of this plan; switching on the second kind burns through a fleet's backup
 * upstreams for nothing (plan 121 §0.1, the owner's own words). So a streak
 * of failures against the CURRENTLY ACTIVE upstream only earns a
 * CONFIRMATION probe — `runEgressProbe`, dialled through that exact same
 * upstream (§3.1) — and only a probe that ALSO fails earns a switch. A probe
 * that succeeds means the streak was target-site-specific: the counter
 * resets and nothing else happens, silently, on purpose (§4.2, the single
 * most important behaviour this file has).
 *
 * ## Why the counter lives per-(record, active upstream), not per-record
 *
 * If a record has already failed over to backup #2, a fresh failure streak
 * against #2 must count independently of whatever streak preceded the
 * earlier switch — otherwise a record could cascade through every backup in
 * one confused burst driven by a stale count (plan 121 §3.2). Switching
 * upstream (by a threshold-triggered failover, or later by 121.5's
 * auto-failback) always resets `consecutiveFailures` to zero.
 *
 * ## What step 121.6 added on top of that
 *
 * Every switch — a forward failover, the two ways a fallback list can be
 * exhausted, and a failback (automatic or manual) — now logs through
 * `emitFailoverEvent` below, which tags the line with `subject:
 * proxySubject(host.id)` (so it lands beside every other line about this same
 * record in the Logs tab) and a `fields.event: PROXY_FAILOVER_EVENT` marker
 * plus the switch's own `recordId`/`from`/`to`/`reason`/`at`. This is a
 * structured `ctx.log` call, not a new WS message type — see
 * `PROXY_FAILOVER_EVENT`'s own comment in `shared.ts` for why a plugin has no
 * other broadcast channel to use. `host.log` remains the only visible effect
 * of a switch beyond the state object itself; what changed is that the line
 * now carries a shape a reader can act on, not only prose.
 *

 * ## What step 121.4 added on top of this
 *
 * `buildUpstream`/`probe` on `FailoverHost` below both gained a `slot`
 * parameter — the upstream slot a build is FOR, or the slot currently being
 * probed — so the host can look up and scrub THAT slot's own stored
 * credential instead of reusing whichever password it was given for a
 * different slot (`shared.ts`'s `proxySecretSlotKeyFor`, `supervisor.ts`'s
 * wiring). Nothing about the switching LOGIC in this file changed — only what
 * the host is told about the slot it is acting on.
 *
 * ## What step 121.5 (auto-failback) added on top of that
 *
 * `primaryRecoveryStreak` is now read and written: `checkPrimaryRecovery()`
 * is the new entry point `supervisor.ts`'s periodic sweep calls once per
 * tick, ONLY for a record currently on a backup (`activeIndex !== 0`, §4.4).
 * It builds a fresh, throwaway primary `Upstream` (slot 0) and runs the exact
 * same `host.probe()` a confirmation check uses — reusing `probeEntry`'s own
 * `ENKAKU_NETWORK_PROBE_URL`-unset skip discipline for free, since both paths
 * are wired through the same callback in `supervisor.ts`.
 *
 * A successful probe advances the streak; a FAILED probe resets it to zero
 * (the anti-flap guard's whole point — a flaky primary must never carry
 * partial credit across a gap). An UNCONFIGURED probe endpoint
 * (`PROXY_PROBE_SKIP_REASON`) is neither: this file cannot tell "primary is
 * actually fine" from "primary is still down" when nothing was measured, so
 * it leaves the streak exactly where it was — advancing it would be a
 * fabricated success, and resetting it would punish an operator who simply
 * has not set the probe endpoint. Once the streak reaches
 * `RECOVERY_STREAK_THRESHOLD` (2, fixed, not owner-configurable — an internal
 * anti-flap guard, not a product setting) AND `record.failover.autoFailback`
 * is true, the switch happens automatically. `autoFailback: false` leaves the
 * streak advancing (so Studio can show "primary looks healthy again" as
 * information, 121.6's job) but never auto-switches — only `resetToPrimary()`
 * (the manual "reset to primary" seam 121.6's Studio action will call) moves
 * `activeIndex` back to 0 in that mode.
 */

/** One entry in a record's failover history — bounded, most-recent-first. */
export interface FailoverHistoryEntry {
  /** Unix seconds, matching `ProxyProbeResult.at`'s own unit on this same catalogue. */
  at: number
  from: number
  to: number
  reason: string
}

/**
 * How many `history` entries a record keeps before the oldest is dropped.
 * There is no product requirement for a specific number yet (Studio does not
 * read this list until step 121.5) — twenty is generous for a detail popover
 * and bounds the array so a flapping upstream cannot grow it without limit
 * for as long as the core stays up.
 */
const MAX_HISTORY = 20

/**
 * One record's in-memory failover state (plan 121 §4.2). Never persisted —
 * see plan 121 §2: a core restart always starts a record back at
 * `activeIndex: 0` and lets ordinary failure detection re-discover whether
 * primary is actually down.
 */
export interface FailoverState {
  /** `0` = the record's own `upstream`; `1..n` = `fallbackUpstreams[i - 1]`. */
  activeIndex: number
  /** Consecutive dial failures against `activeIndex`'s upstream only (§3.2). */
  consecutiveFailures: number
  /**
   * Consecutive successful BACKGROUND probes of the primary while
   * `activeIndex !== 0` (step 121.5, §4.4) — advanced and reset by
   * `checkPrimaryRecovery()` below; always `0` while `activeIndex === 0`,
   * since there is nothing to recover to.
   */
  primaryRecoveryStreak: number
  history: FailoverHistoryEntry[]
}

/**
 * How many consecutive successful background primary probes it takes before
 * auto-failback switches back (plan 121 §4.4) — fixed, not read from
 * `record.failover` or anywhere else: this is an internal anti-flap guard,
 * not a product-facing setting a farm operator tunes.
 */
const RECOVERY_STREAK_THRESHOLD = 2

function createFailoverState(): FailoverState {
  return { activeIndex: 0, consecutiveFailures: 0, primaryRecoveryStreak: 0, history: [] }
}

/**
 * What this file needs from the supervisor, and nothing more — so a test
 * supplies fakes for all four rather than a real listener, a real
 * `createUpstream`, or a real probe endpoint.
 */
export interface FailoverHost {
  /** For the one log line a switch (or an exhausted fallback list) writes. */
  id: string
  /**
   * The record's CURRENT `fallbackUpstreams`/`failover` config, read fresh on
   * every dial result — a record can be edited (and re-read by
   * `supervisor.ts`'s `refresh()`) between one failure and the next, and a
   * stale snapshot captured at listener-start would ignore that edit for the
   * life of the listener.
   */
  getRecord(): ProxyRecord
  /**
   * The SAME holder the listener dials through (plan 121 §4.3) — reassigning
   * `.current` here is what makes a switch take effect on the very next
   * accepted connection, with every already-open connection untouched.
   */
  holder: UpstreamHolder
  /**
   * Build a fresh `Upstream` for one of this record's OWN upstream slots
   * (the primary, or one of `fallbackUpstreams`) — reuses plan 117's
   * `createUpstream()` unchanged; this file only decides WHICH `ProxyUpstream`
   * to hand it.
   *
   * `slot` is the same addressing `FailoverState.activeIndex` uses — `0` for
   * the primary, `1..n` for `fallbackUpstreams[slot - 1]` — the upstream slot
   * this build is FOR, i.e. the index it is about to become active as. Added
   * in step 121.4 so the host can look up THAT slot's own stored credential
   * (`proxySecretSlotKeyFor`) instead of reusing whatever password it was
   * given for a different slot.
   */
  buildUpstream(upstream: ProxyUpstream, slot: number): Promise<Upstream>
  /**
   * Dial the confirmation probe THROUGH the given `Upstream` — reuses
   * `runEgressProbe()` unchanged (§0.2, §3.1); this file only decides WHEN to
   * call it and what to do with the result.
   *
   * `slot` is the CURRENTLY active slot (`FailoverState.activeIndex`) — added
   * in step 121.4 so the host can scrub THAT slot's own password out of any
   * error text the probe returns, instead of always scrubbing the primary's.
   */
  probe(upstream: Upstream, slot: number): Promise<ProxyProbeResult>
  log: LogSink
}

export interface FailoverController {
  /** A live read of the current state — for a future WS snapshot (121.6) and for tests. */
  readonly state: Readonly<FailoverState>
  /**
   * Feed one dial attempt's outcome for the CURRENTLY ACTIVE upstream. Never
   * throws — the same "always resolves" discipline `runEgressProbe` itself
   * follows, because this is called from `listener.ts`'s own dial
   * `.then()`/`.catch()` and a rejection there would be an unhandled promise
   * inside the negotiator's own flow.
   */
  onDialResult(ok: boolean): Promise<void>
  /**
   * Run one background confirmation probe against the PRIMARY upstream (plan
   * 121 §4.4, step 121.5). `supervisor.ts`'s existing periodic probe sweep is
   * the only caller — one call per sweep tick, and only for a record where
   * `state.activeIndex !== 0` (a record already on primary has nothing to
   * recover to; this is a no-op then, so a caller that forgets to guard the
   * call does not corrupt anything). A successful probe advances
   * `primaryRecoveryStreak`; a failed one resets it to zero; an unconfigured
   * probe endpoint leaves it untouched (see this file's own header for why).
   * Reaching `RECOVERY_STREAK_THRESHOLD` while `record.failover.autoFailback`
   * is true switches back to primary automatically.
   */
  checkPrimaryRecovery(): Promise<void>
  /**
   * Force the active upstream back to primary right now, regardless of
   * `autoFailback` or how far `primaryRecoveryStreak` has climbed — the seam
   * a future Studio "reset to primary" action (121.6) calls, so it does not
   * need to reach into this controller's internal state. A no-op when
   * already on primary. Resets both counters and appends a `history` entry,
   * same as an automatic failback.
   */
  resetToPrimary(): Promise<void>
}

/**
 * Append one entry to `state.history`, most-recent-first, bounded to
 * `MAX_HISTORY` — and return it, so the caller can hand the SAME `at` to
 * `emitFailoverEvent` rather than taking a second, slightly later timestamp.
 */
function pushHistory(state: FailoverState, from: number, to: number, reason: string): FailoverHistoryEntry {
  const entry: FailoverHistoryEntry = { at: Math.floor(Date.now() / 1000), from, to, reason }
  state.history.unshift(entry)
  if (state.history.length > MAX_HISTORY) state.history.length = MAX_HISTORY
  return entry
}

/**
 * The one place a switch (or an exhausted fallback list) becomes a log line —
 * see this file's own header, "What step 121.6 added on top of that". Every
 * call site hands in the exact `FailoverHistoryEntry` `pushHistory` just
 * produced, so the log line and the `history` array can never disagree about
 * `from`/`to`/`reason`/`at`.
 */
function emitFailoverEvent(host: FailoverHost, entry: FailoverHistoryEntry, level: 'warn' | 'info', message: string): void {
  host.log[level](message, {
    subject: proxySubject(host.id),
    event: PROXY_FAILOVER_EVENT,
    recordId: host.id,
    from: entry.from,
    to: entry.to,
    reason: entry.reason,
    at: entry.at,
  })
}

/**
 * Build a `FailoverController` for one live proxy entry.
 *
 * `state.fallbackUpstreams.length === 0` is checked FIRST, before anything
 * else touches `state` — a record with no configured backups must be
 * provably inert (plan 121 §6 criterion 1): no counter increments, no probe
 * ever fires, `holder.current` is never touched. That is also why the check
 * re-reads `host.getRecord()` on every call rather than being decided once
 * at construction: a record edited down to zero backups mid-flight must go
 * inert on its very next dial result, not merely a newly-created one.
 */
export function createFailoverController(host: FailoverHost): FailoverController {
  const state = createFailoverState()

  /**
   * Whether a confirmation-probe-and-maybe-switch sequence is already
   * running. A dial failure that arrives while one is in flight still counts
   * (`consecutiveFailures` keeps incrementing above), but does not start a
   * SECOND overlapping probe/switch — the in-flight one already answers the
   * question "is the active upstream actually down", and a second probe
   * racing it could switch twice for one confirmed failure. If failures are
   * still arriving once this one settles, the next one re-triggers normally,
   * because `consecutiveFailures` was never reset below threshold by a mere
   * skip.
   */
  let checking = false

  async function checkAndMaybeSwitch(): Promise<void> {
    const record = host.getRecord()
    const probeResult = await host.probe(host.holder.current, state.activeIndex)
    if (probeResult.ok) {
      // The false-positive case this whole plan exists to avoid (§4.2): the
      // streak was about the target, not this upstream. Reset and say
      // nothing further — no history entry, no log line.
      state.consecutiveFailures = 0
      return
    }

    const maxIndex = record.fallbackUpstreams.length
    if (state.activeIndex >= maxIndex) {
      // Already on the last configured fallback (or, unreachably here since
      // an empty list returns before ever reaching this function, on
      // primary with none configured) and ITS OWN probe just failed too.
      // Stay — cycling back to primary would only repeat a probe already
      // known to be failing (primary's own health is 121.4's own concern).
      state.consecutiveFailures = 0
      const entry = pushHistory(state, state.activeIndex, state.activeIndex, 'no working upstream left')
      emitFailoverEvent(host, entry, 'warn', 'proxy failover: confirmation probe failed and no working upstream left — staying on the last configured fallback')
      return
    }

    const fromIndex = state.activeIndex
    const nextIndex = fromIndex + 1
    const nextUpstream = record.fallbackUpstreams[nextIndex - 1]
    if (!nextUpstream) {
      // Unreachable: `nextIndex - 1 < maxIndex` was just established above.
      // Kept so the narrowing that follows is the compiler's, not a comment's.
      state.consecutiveFailures = 0
      return
    }

    const upstream = await host.buildUpstream(nextUpstream, nextIndex)
    host.holder.current = upstream
    state.activeIndex = nextIndex
    state.consecutiveFailures = 0
    const entry = pushHistory(state, fromIndex, nextIndex, 'confirmation probe failed against the active upstream')
    emitFailoverEvent(host, entry, 'warn', 'proxy failover: switched to the next configured fallback upstream')
  }

  /**
   * Switch the active upstream back to primary — shared by both
   * `checkPrimaryRecovery`'s automatic path and `resetToPrimary`'s manual
   * one, so the two can never drift apart on which counters get reset or
   * what a `history` entry for this transition looks like.
   *
   * `prebuiltUpstream`, when supplied, is reused rather than built a second
   * time — `checkPrimaryRecovery` already built and successfully probed
   * exactly this `Upstream` object moments earlier, so making it live is
   * "use the thing that was just confirmed", not a fresh, unverified build.
   * `resetToPrimary` has no such object to hand in and builds one fresh.
   */
  async function switchToPrimary(reason: string, prebuiltUpstream?: Upstream): Promise<void> {
    const record = host.getRecord()
    const primaryUpstream = prebuiltUpstream ?? (await host.buildUpstream(record.upstream, 0))
    const fromIndex = state.activeIndex
    host.holder.current = primaryUpstream
    state.activeIndex = 0
    state.consecutiveFailures = 0
    state.primaryRecoveryStreak = 0
    const entry = pushHistory(state, fromIndex, 0, reason)
    emitFailoverEvent(host, entry, 'info', 'proxy failover: switched back to primary')
  }

  return {
    get state() {
      return state
    },

    async onDialResult(ok) {
      const record = host.getRecord()
      // Criterion 1: provably inert with no backups configured. Checked
      // before touching `state` at all, and re-checked on every call rather
      // than once at construction — see this function's own header comment.
      if (record.fallbackUpstreams.length === 0) return

      if (ok) {
        state.consecutiveFailures = 0
        return
      }

      state.consecutiveFailures += 1
      if (checking) return
      if (state.consecutiveFailures < record.failover.failureThreshold) return

      checking = true
      try {
        await checkAndMaybeSwitch()
      } finally {
        checking = false
      }
    },

    async checkPrimaryRecovery() {
      // Nothing to recover to — see this method's own doc on `FailoverController`.
      if (state.activeIndex === 0) return

      const record = host.getRecord()
      const primaryUpstream = await host.buildUpstream(record.upstream, 0)
      const probeResult = await host.probe(primaryUpstream, 0)

      if (!probeResult.ok) {
        if (probeResult.error === PROXY_PROBE_SKIP_REASON) {
          // Unmeasurable, not failed (this file's own header explains why):
          // leave the streak exactly where it was. Neither a fabricated
          // success nor an unearned reset.
          return
        }
        // A REAL failed probe resets to zero — the anti-flap guard's whole
        // point (§4.4): a primary that comes and goes must never accumulate
        // partial credit across a gap.
        state.primaryRecoveryStreak = 0
        return
      }

      state.primaryRecoveryStreak += 1
      if (state.primaryRecoveryStreak < RECOVERY_STREAK_THRESHOLD) return
      if (!record.failover.autoFailback) {
        // Still tracked as information (§4.4) — Studio can show "primary
        // looks healthy again" — but only a manual `resetToPrimary()` call
        // may move `activeIndex` in this mode.
        return
      }

      await switchToPrimary('primary confirmed healthy — auto-failback', primaryUpstream)
    },

    async resetToPrimary() {
      if (state.activeIndex === 0) return
      await switchToPrimary('manual reset to primary')
    },
  }
}
