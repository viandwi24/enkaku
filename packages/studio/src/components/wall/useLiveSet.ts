'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DeviceInfo } from '@enkaku/protocol'

/**
 * The Wall's live-set policy (plan 92 §3.2, §4.6) — replaces "first N of the
 * filtered list" (F13) with a policy an operator can predict: what is on
 * screen, what is already hot, what is awake. Split in two on purpose, per
 * this step's own brief: keep the decision provable without a browser.
 *
 *  - `computeLiveSet` is the PURE decision function. No clock read, no
 *    `IntersectionObserver`, no timers — given the same inputs it always
 *    returns the same outputs, so `useLiveSet.test.ts` can assert ordering,
 *    eviction, budgeting and the ramp gate directly, with no DOM at all.
 *  - `useLiveSet` is the hook that owns the three things a pure function
 *    cannot: the `IntersectionObserver` (viewport membership, §3.2 rule 2),
 *    the per-tile dwell timers (`DWELL_MS` — "continuously visible", the
 *    mechanism that makes a fast scroll start zero streams), and the ramp
 *    counter (`rampConcurrency` — at most N tiles newly ask for a stream at
 *    once while the wall fills in, §3.3).
 *
 * Together they fix:
 *  - **F12** — an `asleep` device is a BLOCKED state (`blocked`), never a
 *    candidate for `live`/`pending`/`budgeted` at all. There is no way to
 *    stream a device without waking it (plan 92 F11), so "looked at" and
 *    "woken up" cannot both follow from opening the wall. `WallTile` itself
 *    also checks `asleep` ahead of `live` (plan 92 §5 step 92.6) — this is
 *    belt-and-braces at the bookkeeping layer, not the only guard.
 *  - **F13** — ordering within the budget is pinned → hot-and-visible →
 *    already-live-and-visible → newly-visible-and-awake → grid order, never
 *    fleet-list order, and eviction always takes the LOWEST-ranked member of
 *    the previous live set first (see `rankOf` below).
 *  - **F14** — this module has no opinion on when it is safe to call
 *    `useLiveSet` with a real `maxTiles`; `Wall.tsx` holds the skeleton
 *    until `/api/adb/stats` answers with the number ACTUALLY APPLIED
 *    (plan 92 §5 step 92.3), then calls in with that number, never `0`
 *    meaning "auto" (that resolution already happened server-side).
 */

/** A tile must be continuously visible this long before it is even a candidate to stream (§3.2 rule 2). Scrolling past dozens of tiles in less than this starts zero streams — that IS the guarantee, not a side effect of one. */
export const DWELL_MS = 400

/**
 * How long a newly-promoted batch is assumed to occupy its ramp slot before
 * the next batch gets a turn (§3.3: "a wall tile that waits ~900ms for its
 * turn is correct"). This is a CLIENT-side courtesy only — sessions are
 * always on now (plan 206 §4.3), so a wall tile's `stream.start` attaches to
 * an already-built entry rather than racing a build; nothing server-side
 * needs pacing to protect any more. Nothing here can gate on a real
 * "connected" signal instead: `LiveView` reports no such callback, and this
 * step's file-ownership boundary excludes `LiveView.tsx` (a concurrent
 * worker's file for plan 94 step 94.2).
 */
export const RAMP_STEP_MS = 800

export type BlockedReason = 'asleep' | 'offline' | 'quarantined'

export interface LiveSetInput {
  devices: DeviceInfo[]
  /**
   * `wall.maxTiles` AS ACTUALLY APPLIED — plan 92 §5 step 92.3's
   * `/api/adb/stats` `video.maxTiles`, already resolved server-side
   * (`computeAutoTiles`) when the stored setting is `0`/auto. This function
   * never re-derives that arithmetic; `0` here means "no budget is known
   * yet" (the caller's job to avoid, per `Wall.tsx`'s own loading state),
   * not "auto".
   */
  maxTiles: number
  /** `wall.rampConcurrency` (`/api/settings`) — how many tiles may newly ask for a stream at the same time while the wall fills in (§3.3). */
  rampConcurrency: number
  /** Ids currently intersecting the viewport (plus one row of margin) AND already past `DWELL_MS` — newest (most recently became a candidate) first. `useLiveSet` computes this; a test of the pure function supplies whatever set it wants to prove against. */
  visibleIds: string[]
  /** Ids the operator promoted by hand (a budgeted tile's "Show live" action) — always win over the automatic order, most-recently-pinned first. */
  pinnedIds: string[]
  /** The previous computation's own `live` output, read back in. This is what makes eviction stable (an already-streaming tile is never churned out by a same-tier newcomer) and what makes the ramp gate only ever apply to NEW starts. */
  liveIds: string[]
  /** Reserved for a future per-tile "longest time off screen" tie-break (§3.2 rule 4) once a caller threads per-id last-visible timestamps through. Today's tie-break for equally-ranked, equally-invisible candidates is grid order, which is deterministic and sufficient for this step's own verifiable result; accepted here so this function's shape matches plan 92 §4.6's own sketch and so that future change is additive, not a signature break. */
  now: number
}

export interface LiveSetOutput {
  /** Streaming right now — always a subset of the top-`maxTiles`-ranked eligible devices. */
  live: string[]
  /** Ranked within the budget, wants to stream, waiting for a ramp slot. */
  pending: string[]
  /** Eligible (awake or hot; not offline/quarantined/asleep) but ranked outside `maxTiles`. */
  budgeted: string[]
  /** Not a candidate at all, because of the device's own condition — never promoted, never woken by being ranked (F12). */
  blocked: Array<{ id: string; reason: BlockedReason }>
}

/**
 * Rank order, ascending (lower = higher priority):
 *  0. pinned — the operator asked for this tile by hand, and that always wins.
 *  1. visible AND `readiness.actual === 'hot'` — a hot device's session is
 *     already open (plan 92 F26), so promoting it costs one map lookup and a
 *     primed keyframe rather than a fresh build (H2).
 *  2. visible AND already live — stability: a same-tier newcomer must not
 *     evict a tile that is already decoding.
 *  3. visible AND awake, never (yet) live — a genuinely new candidate.
 *  4. everything else eligible — not currently visible. This is exactly
 *     where a tile that scrolled off screen while live ends up: still
 *     eligible, but lowest priority, so under budget pressure the FIRST
 *     thing evicted is the tile that has been off screen longest (§3.2 rule
 *     4), never one still on screen.
 */
function rankOf(d: DeviceInfo, visible: ReadonlySet<string>, pinned: ReadonlySet<string>, live: ReadonlySet<string>): number {
  if (pinned.has(d.id)) return 0
  const isVisible = visible.has(d.id)
  if (isVisible && d.readiness.actual === 'hot') return 1
  if (isVisible && live.has(d.id)) return 2
  if (isVisible) return 3
  return 4
}

/**
 * The pure policy (plan 92 §4.6's own artefact). Called fresh each time by
 * `useLiveSet` below; called directly, with hand-built inputs, by
 * `useLiveSet.test.ts` to prove ordering/eviction/budgeting/ramp without a
 * DOM.
 */
export function computeLiveSet(input: LiveSetInput): LiveSetOutput {
  const { devices, maxTiles, rampConcurrency, visibleIds, pinnedIds, liveIds } = input

  const visible = new Set(visibleIds)
  const pinned = new Set(pinnedIds)
  const live = new Set(liveIds)

  // Eligibility by readiness, not only by status (§3.2 rule 1, fixes F12):
  // `asleep` joins `offline`/`quarantined` as a state that never streams,
  // checked FIRST and unconditionally — nothing below this loop can put an
  // asleep device back into `live`/`pending`/`budgeted`.
  const blocked: Array<{ id: string; reason: BlockedReason }> = []
  const eligible: DeviceInfo[] = []
  for (const d of devices) {
    if (d.status === 'offline') blocked.push({ id: d.id, reason: 'offline' })
    else if (d.status === 'quarantined') blocked.push({ id: d.id, reason: 'quarantined' })
    else if (d.readiness.actual === 'asleep') blocked.push({ id: d.id, reason: 'asleep' })
    else eligible.push(d)
  }

  const pinnedOrder = new Map(pinnedIds.map((id, i) => [id, i]))
  const visibleOrder = new Map(visibleIds.map((id, i) => [id, i]))
  const gridOrder = new Map(devices.map((d, i) => [d.id, i]))

  const ranked = [...eligible].sort((a, b) => {
    const ra = rankOf(a, visible, pinned, live)
    const rb = rankOf(b, visible, pinned, live)
    if (ra !== rb) return ra - rb
    if (ra === 0) return (pinnedOrder.get(a.id) ?? 0) - (pinnedOrder.get(b.id) ?? 0)
    // Tiers 1-3 all require `visible`, so `visibleOrder` (newest-first) is
    // the right tie-break inside each of them; tier 4 (not visible at all)
    // falls back to grid order (see the file header on `now`).
    if (ra === 4) return (gridOrder.get(a.id) ?? 0) - (gridOrder.get(b.id) ?? 0)
    return (visibleOrder.get(a.id) ?? 0) - (visibleOrder.get(b.id) ?? 0)
  })

  // The cap (§3.2 rule 4, §3.7): `maxTiles` couples the two video knobs to
  // one budget, and it is honoured here as a hard slice — nothing beyond it
  // is ever in `live`, whatever its rank.
  //
  // Membership follows the viewport (§3.2 rule 2) — a rank-4 device (not
  // pinned, not visible, not already live) is NEVER a candidate, even when
  // the cap has room to spare: a farm of 100 devices with only 2 tiles ever
  // observed as visible must not fill the other `maxTiles - 2` slots with
  // devices nobody has looked at. Slicing `ranked` by `cap` alone would do
  // exactly that (rank-4 entries sort last, but they would still fall
  // inside a slice that has room), so rank-4 devices are routed straight to
  // `budgeted` regardless of cap pressure, and the cap only ever competes
  // among genuine candidates (rank 0-3).
  const cap = Math.max(0, Math.floor(maxTiles))
  const target: DeviceInfo[] = []
  const budgeted: string[] = []
  for (const d of ranked) {
    const isCandidate = rankOf(d, visible, pinned, live) < 4
    if (isCandidate && target.length < cap) target.push(d)
    else budgeted.push(d.id)
  }

  // The ramp gate (§3.3): of the ids newly wanted (ranked inside the cap,
  // not already live), only the first `rampConcurrency` are promoted this
  // call. The rest wait as `pending` — `useLiveSet` below re-calls this
  // function `RAMP_STEP_MS` later, by which point today's promotions have
  // joined `liveIds`, freeing their ramp slots for the next batch.
  const newlyWanted = target.filter((d) => !live.has(d.id)).map((d) => d.id)
  const rampSlots = Math.max(0, Math.floor(rampConcurrency))
  const promoted = new Set(newlyWanted.slice(0, rampSlots))
  const pending = newlyWanted.slice(rampSlots)

  const liveOut = target.map((d) => d.id).filter((id) => live.has(id) || promoted.has(id))

  return { live: liveOut, pending, budgeted, blocked }
}

export interface UseLiveSetResult {
  live: Set<string>
  pending: Set<string>
  budgeted: Set<string>
  blocked: Map<string, BlockedReason>
  /** Promote a tile out of turn — the "Show live" action on a budgeted tile (mirrors the pre-92.4 manual override, now expressed as a pin that always wins §3.2's automatic order for everyone else). */
  showLive: (id: string) => void
  /**
   * A STABLE ref callback for tile `id`'s own root DOM node — attach it so
   * the shared `IntersectionObserver` can see it. The SAME function
   * identity is returned for the same id across renders (cached, not
   * recreated inline): a devices-list update is frequent on a live farm,
   * and an inline `ref={(el) => ...}` would re-observe (and so reset the
   * dwell timer of) every mounted tile on every such update, which would
   * quietly defeat the whole "continuously visible" guarantee.
   */
  tileRef: (id: string) => (node: Element | null) => void
}

/**
 * The stateful half. `Wall.tsx` calls this once with the full, flat device
 * list (never a per-section slice — the live-tile cap is a single farm-wide
 * budget, plan 92 §4.6's own note) and the resolved `maxTiles`/
 * `rampConcurrency`, and reads `live`/`budgeted`/`blocked` back to decide
 * what each `WallTile` renders.
 */
export function useLiveSet({
  devices,
  maxTiles,
  rampConcurrency,
}: {
  devices: DeviceInfo[]
  maxTiles: number
  rampConcurrency: number
}): UseLiveSetResult {
  const [visibleIds, setVisibleIds] = useState<string[]>([])
  const [pinnedIds, setPinnedIds] = useState<string[]>([])
  const [rampTick, setRampTick] = useState(0)
  const [output, setOutput] = useState<LiveSetOutput>({ live: [], pending: [], budgeted: [], blocked: [] })

  // Read back into the next `computeLiveSet` call without being a `useEffect`
  // dependency itself — `liveIds` is an OUTPUT of the effect below; making it
  // an input dependency too would be a feedback loop that reruns forever.
  const liveIdsRef = useRef<string[]>([])
  const rampTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const result = computeLiveSet({
      devices,
      maxTiles,
      rampConcurrency,
      visibleIds,
      pinnedIds,
      liveIds: liveIdsRef.current,
      now: Date.now(),
    })
    liveIdsRef.current = result.live
    setOutput(result)

    if (rampTimerRef.current) {
      clearTimeout(rampTimerRef.current)
      rampTimerRef.current = null
    }
    // Advance the ramp: schedule one more tick only while something is still
    // waiting on a slot. `rampTick` itself carries no data — bumping it just
    // forces this effect to run again, and by then `liveIdsRef.current`
    // already includes the batch just promoted, so the next call's
    // `newlyWanted` naturally excludes them and the next `rampConcurrency`
    // pending ids get their turn.
    if (result.pending.length > 0) {
      rampTimerRef.current = setTimeout(() => setRampTick((t) => t + 1), RAMP_STEP_MS)
    }
    return () => {
      if (rampTimerRef.current) {
        clearTimeout(rampTimerRef.current)
        rampTimerRef.current = null
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [devices, maxTiles, rampConcurrency, visibleIds, pinnedIds, rampTick])

  // --- IntersectionObserver + per-tile dwell timers (§3.2 rule 2) ---
  const dwellTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  const observerRef = useRef<IntersectionObserver | null>(null)
  const nodeForIdRef = useRef(new Map<string, Element>())
  const idForNodeRef = useRef(new WeakMap<Element, string>())
  const refCacheRef = useRef(new Map<string, (node: Element | null) => void>())

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const id = idForNodeRef.current.get(entry.target)
          if (!id) continue
          const timers = dwellTimersRef.current
          if (entry.isIntersecting) {
            // Already dwelling (or already dwelled) — a re-fired entry for
            // the same still-visible tile must not restart its timer.
            if (timers.has(id)) continue
            timers.set(
              id,
              setTimeout(() => {
                timers.delete(id)
                setVisibleIds((prev) => (prev.includes(id) ? prev : [id, ...prev]))
              }, DWELL_MS),
            )
          } else {
            // Left the viewport before dwelling — the timer never fires, so
            // this id never becomes a candidate. THIS is the mechanism that
            // makes a fast scroll past forty tiles start zero streams.
            const t = timers.get(id)
            if (t) {
              clearTimeout(t)
              timers.delete(id)
            }
            setVisibleIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : prev))
          }
        }
      },
      // One row of margin (§3.2 rule 2): a tile just below the fold starts
      // dwelling before it is fully in frame, so it is ready the instant a
      // slow scroll settles on it, without treating the whole document as
      // "visible" — which would defeat the fast-scroll guarantee entirely.
      { rootMargin: '200px 0px' },
    )
    observerRef.current = observer
    return () => {
      observer.disconnect()
      for (const t of dwellTimersRef.current.values()) clearTimeout(t)
      dwellTimersRef.current.clear()
    }
  }, [])

  // Prune tiles that left the device list entirely (filtered out, removed
  // from the farm) — calls the SAME detach path a tile's own unmount ref
  // callback would, so nothing keeps observing a node nobody renders any more.
  useEffect(() => {
    const ids = new Set(devices.map((d) => d.id))
    for (const id of [...refCacheRef.current.keys()]) {
      if (!ids.has(id)) {
        refCacheRef.current.get(id)?.(null)
        refCacheRef.current.delete(id)
      }
    }
  }, [devices])

  const tileRef = useCallback((id: string) => {
    const cached = refCacheRef.current.get(id)
    if (cached) return cached
    const cb = (node: Element | null) => {
      const observer = observerRef.current
      const prevNode = nodeForIdRef.current.get(id)
      if (prevNode && prevNode !== node) {
        observer?.unobserve(prevNode)
        idForNodeRef.current.delete(prevNode)
      }
      if (node) {
        nodeForIdRef.current.set(id, node)
        idForNodeRef.current.set(node, id)
        observer?.observe(node)
      } else {
        nodeForIdRef.current.delete(id)
        const t = dwellTimersRef.current.get(id)
        if (t) {
          clearTimeout(t)
          dwellTimersRef.current.delete(id)
        }
        setVisibleIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : prev))
      }
    }
    refCacheRef.current.set(id, cb)
    return cb
  }, [])

  const showLive = useCallback((id: string) => {
    setPinnedIds((prev) => (prev[0] === id ? prev : [id, ...prev.filter((x) => x !== id)]))
  }, [])

  return useMemo(
    () => ({
      live: new Set(output.live),
      pending: new Set(output.pending),
      budgeted: new Set(output.budgeted),
      blocked: new Map(output.blocked.map((b) => [b.id, b.reason] as const)),
      showLive,
      tileRef,
    }),
    [output, showLive, tileRef],
  )
}
