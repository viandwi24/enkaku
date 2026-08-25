'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { Smartphone, Sunrise } from 'lucide-react'
import { AdbStatsResponseSchema, SettingsResponseSchema, type DeviceInfo, type JobInfo } from '@enkaku/protocol'
import { WallTile } from './WallTile'
import { TileGrid } from './TileGrid'
import { TileSkeleton } from './TileSkeleton'
import { useLiveSet } from './useLiveSet'
import { ws } from '@/lib/ws'
import { READINESS_BLOCKED_REASON } from '@/lib/readiness'
import { Button, EmptyState, api } from '@enkaku/ui'

/**
 * `wall.rampConcurrency`'s schema default (plan 92 §5 step 92.1,
 * `packages/protocol/src/settings.ts`) — used until `/api/settings`
 * answers. Unlike `maxTiles`, this number is never allowed to gate the
 * skeleton: it is a client-side courtesy only (plan 92 §3.3 — the
 * authoritative bound is server-side, `session.maxConcurrentBuilds`), so
 * starting the live set with the schema default and correcting it a moment
 * later (the common case: nobody has changed it) costs nothing worth a
 * second loading state for.
 */
const DEFAULT_RAMP_CONCURRENCY = 2

/**
 * Fallback only: before `/api/adb/stats` answers, or for a fixture body that
 * predates the `video` block entirely (`AdbStatsResponseSchema.video` is
 * `.optional()` on the wire for exactly that reason — plan 92 §5 step
 * 92.3's own note). The real running core always sends `video.maxTiles`
 * ACTUALLY APPLIED — `computeAutoTiles(...)` already resolved server-side
 * when `wall.maxTiles` is `0` (auto, §3.7), never the raw `0` itself — so
 * this component never has to duplicate that arithmetic; it only has to
 * cover the moment before that number has arrived at all.
 */
const DEFAULT_MAX_TILES = 8

/**
 * A stable empty array for the `devices === null` (loading) case, passed to
 * `useLiveSet` below. A fresh `[]` literal on every render would give that
 * hook's own effect a NEW `devices` reference every time — and since one of
 * that effect's own outputs (`output` state) triggers a re-render of this
 * component, `devices ?? []` written inline would tight-loop for the entire
 * time `devices` is `null`. One shared reference breaks the cycle.
 */
const EMPTY_DEVICES: DeviceInfo[] = []

/**
 * The same stable-reference trick as `EMPTY_DEVICES`, for the stream-error
 * latch below: `setStreamErrors` returns THIS map (not a fresh `new Map()`)
 * whenever nothing actually changed, so a no-op update never re-renders the
 * whole grid. On a wall decoding 24-40 H.264 streams that is not a
 * micro-optimisation — every avoidable re-render of this component is a
 * re-render of every tile in it.
 */
const NO_STREAM_ERRORS: ReadonlyMap<string, string> = new Map()

/**
 * What "Wake N devices" (plan 125 §3.5, §4.3, answering plan 92 §9 Q2) will
 * actually do, computed ONCE from the devices this wall is showing and used
 * for both the button's own count and the request it sends. One computation,
 * so the number on the button and the set that is acted on cannot disagree —
 * the discipline `TargetPicker` already states as a rule ("no dialog can show
 * a number that disagrees with what it will actually submit",
 * `docs/design.md`).
 */
export interface WallWakeTarget {
  /** Asleep and wakeable — the count the button names. */
  wake: DeviceInfo[]
  /** Asleep but refusable up front, with the reason a human reads. Reported, never silently dropped: `docs/design.md`'s "no count without names". */
  skipped: Array<{ device: DeviceInfo; reason: string }>
}

/**
 * Pure, exported for `Wall.test.tsx`.
 *
 * "Visible" means **the devices this wall is currently showing** — the list
 * after the page's search and filters — not the `IntersectionObserver`
 * viewport `useLiveSet` maintains. Two reasons, and the choice is deliberate
 * rather than convenient: scroll position is not a set an operator can name
 * or predict (a wake that depends on exactly how far you had scrolled is the
 * "alarming" half of plan 92 §9 Q2's own hesitation), and the filtered list
 * is precisely the set the operator composed on purpose and can see the size
 * of.
 *
 * `offline`/`quarantined` are split out rather than filtered away because
 * the core refuses a Wake for both (plan 43 §3.4, corrected by plan 49 §3.1)
 * — sending those requests would produce failures that say nothing new, and
 * dropping them silently would leave asleep tiles the report never mentions.
 * Devices that are already `awake`/`hot` are not "skipped": they were never
 * in scope.
 */
export function wallWakeTarget(devices: readonly DeviceInfo[]): WallWakeTarget {
  const wake: DeviceInfo[] = []
  const skipped: Array<{ device: DeviceInfo; reason: string }> = []
  for (const d of devices) {
    if (d.readiness.actual !== 'asleep') continue
    if (d.status === 'offline') skipped.push({ device: d, reason: READINESS_BLOCKED_REASON.offline ?? 'offline' })
    else if (d.status === 'quarantined') skipped.push({ device: d, reason: READINESS_BLOCKED_REASON.quarantined ?? 'quarantined' })
    else wake.push(d)
  }
  return { wake, skipped }
}

/**
 * The devices list's Wall mode (Plan 42 §3.5, §4.6): every device's screen
 * live, at once, capped at `wall.maxTiles` — the wall is the existing video
 * stream at a low-rate quality profile, decoded by the existing path, never
 * a new transport.
 *
 * Filters/search from the List view apply unchanged (Plan 42 §9 open
 * question — the wall is a mode on this page, not its own route), so this
 * component takes the already-filtered device list from its parent rather
 * than fetching its own.
 *
 * Group selection and the focused tile (plan 91 §3.11/§5 step 91.8, F11,
 * F12, F13) are likewise state the parent owns and this component only
 * renders: `selectedIds`/`onToggleSelect` are the same `useBulkSelection`
 * instance the List view's `DeviceCard`s already use, and `focusId` is read
 * straight off the page's own `?focus=` query param.
 */
export function Wall({
  devices,
  jobs,
  groups,
  selectedIds,
  onToggleSelect,
  onDeviceContextMenu,
  focusId = null,
  onFocus,
  onWakeVisible,
  minTileWidthPx = 180,
}: {
  devices: DeviceInfo[] | null
  jobs: JobInfo[]
  /**
   * Optional sectioning (plan 47 §3.6, §4.5) — None | Cluster | Status | Tag,
   * computed once by the parent and shared with the table view so the two
   * never disagree. The live-tile cap below is still computed over the
   * WHOLE flat `devices` list regardless of grouping — sectioning is a
   * rendering concern only, never a second, per-section budget stacking on
   * top of `wall.maxTiles` (plan 42 §3.5).
   */
  groups?: Array<[string, DeviceInfo[]]> | null
  /**
   * Group selection (plan 91 §3.11/§5 step 91.8, F11/F12; no more `selectable`
   * gate as of plan 101 §5 step 101.7 — a `WallTile` click always toggles
   * when `onToggleSelect` is supplied, which this component always does) —
   * the SAME `useBulkSelection` instance the parent already drives the List
   * view with, so selecting on one and switching to the other never loses it.
   */
  selectedIds?: readonly string[]
  onToggleSelect?: (id: string) => void
  /**
   * The right-click context menu (plan 101 §3.9, §5 step 101.5, G15) — the
   * SAME handler `app/page.tsx` wires onto the List view's own `DeviceCard`
   * wrapper, so right-clicking a wall tile and right-clicking a list row
   * open the identical menu, built from the identical toolbar actions.
   * Wall.tsx only wraps each `WallTile` in a plain `data-device-id` div
   * carrying this handler — `WallTile.tsx` itself is untouched, both
   * because its video/live-set wiring sits outside this step's remit and
   * because a wrapper that adds no box styling cannot disturb it.
   */
  onDeviceContextMenu?: (id: string, e: React.MouseEvent) => void
  /** `?focus=` (plan 91 §3.11) — the one tile currently in the focus overlay. */
  focusId?: string | null
  onFocus?: (id: string) => void
  /**
   * "Wake all visible" (plan 125 §3.5, §4.3 — the answer to plan 92 §9 Q2,
   * open since that plan). This component owns the BUTTON and the target
   * set; the parent owns the requests and the report, because the report is
   * the shared `OutcomeSummary`/`SkippedGroups` pair `app/page.tsx` already
   * renders for "Wake selected" (plan 93 §3.15, step 93.11) and a second
   * copy of it here would be exactly the fourth bulk pattern F15 exists to
   * prevent. The `WallWakeTarget` handed over is the identical object the
   * button counted, never a recomputation.
   *
   * Absent ⇒ no button at all: a caller with no way to run the wake must not
   * be given an action that silently does nothing.
   */
  onWakeVisible?: (target: WallWakeTarget) => void
  /**
   * The Tile size control (plan 92 §3.11) — S/M/L maps to 140/180/260px via
   * `TILE_SIZE_PX` in `@/lib/prefs`, and the parent owns that mapping and
   * the localStorage persistence; this component only forwards the number
   * to `TileGrid`. Defaults to the pre-plan-92 constant (`Wall.tsx:142`
   * used to hardcode this) so any other caller keeps today's layout.
   */
  minTileWidthPx?: number
}) {
  // `null` until `/api/adb/stats` answers — held apart from `DEFAULT_MAX_TILES`
  // so the loading state below (§4.7 row "settings unknown", fixes F14's
  // neighbour finding: a farm's real budget must be known before the first
  // stream starts, not corrected a moment later) can tell "not answered yet"
  // from "answered 8".
  const [maxTiles, setMaxTiles] = useState<number | null>(null)
  // `wall.rampConcurrency` — a client-side courtesy only (§3.3), so this
  // never gates the skeleton the way `maxTiles` does; it starts at the
  // schema default and is corrected once `/api/settings` answers.
  const [rampConcurrency, setRampConcurrency] = useState(DEFAULT_RAMP_CONCURRENCY)

  useEffect(() => {
    // `/api/adb/stats`, not `/api/settings`: its `video.maxTiles` is
    // `wall.maxTiles` AS ACTUALLY APPLIED (plan 92 §5 step 92.3), already
    // resolved through `computeAutoTiles` server-side when the stored
    // setting is `0` (auto) — reading `/api/settings` directly here would
    // see that raw `0` and need to re-derive the real number itself.
    void api('/api/adb/stats', AdbStatsResponseSchema)
      .then((b) => setMaxTiles(b.video && b.video.maxTiles > 0 ? b.video.maxTiles : DEFAULT_MAX_TILES))
      .catch(() => setMaxTiles(DEFAULT_MAX_TILES))
  }, [])

  useEffect(() => {
    void api('/api/settings', SettingsResponseSchema)
      .then((b) => setRampConcurrency(b.settings.wall.rampConcurrency))
      .catch(() => undefined)
  }, [])

  // The live-set policy itself (plan 92 §3.2, §4.6) — ordering, eligibility
  // (fixes F12), the viewport/dwell gate, and the ramp counter all live in
  // this one hook so they are provable by `useLiveSet.test.ts` without a
  // browser. Called with the full, flat device list regardless of grouping
  // (`groups` below is a rendering concern only, never a second budget) and
  // `maxTiles ?? 0` while the real budget is still loading — harmless,
  // because the loading branch below never reaches the grid that would read
  // `live`/`budgeted` from it.
  const liveSet = useLiveSet({ devices: devices ?? EMPTY_DEVICES, maxTiles: maxTiles ?? 0, rampConcurrency })

  const jobByDevice = useMemo(() => new Map(jobs.map((j) => [j.deviceId, j])), [jobs])
  const selectedSet = useMemo(() => new Set(selectedIds ?? []), [selectedIds])

  /**
   * The stream-error latch (plan 125 §0.5, §3.5, §4.3) — deviceId → the
   * core's own reason for the session that just died.
   *
   * **One subscription for the whole grid, not one per tile.** `ws.on` adds
   * a handler that is called for every JSON message the core sends, and a
   * 40-tile wall registering 40 of them to watch for a message concerning
   * one device is the kind of per-device cost `docs/design.md` rules out on
   * exactly this surface. `WallTile` therefore takes the reason as a plain
   * prop and owns no WS wiring of its own.
   *
   * `stream.ended` is emitted from ONE place in the core
   * (`daemon.ts`'s `onSessionEnded`, wired to `packages/session`'s
   * `onDisplayError`), so it genuinely means "this session died with an
   * error" — a routine idle close or a last-subscriber-left close does not
   * fire it. That is what makes latching on it safe: there is no ordinary
   * lifecycle event to mistake for a failure.
   */
  const [streamErrors, setStreamErrors] = useState<ReadonlyMap<string, string>>(NO_STREAM_ERRORS)
  useEffect(
    () =>
      ws.on((msg) => {
        if (msg.type !== 'stream.ended') return
        const { deviceId, reason } = msg.payload
        setStreamErrors((prev) => {
          if (prev.get(deviceId) === reason) return prev
          const next = new Map(prev)
          next.set(deviceId, reason)
          return next
        })
      }),
    [],
  )

  /**
   * Clearing the latch. Three cases, and the FIRST one is the only subtle
   * one:
   *
   *  1. **A session is open for this device again** — `readiness.actual`
   *     rising into `hot` (`rawActual`: a live session entry is what makes a
   *     device `hot`). It has to be the RISING EDGE, not the level: at the
   *     instant a display error is reported the device is usually still
   *     `hot`, and clearing on the level would wipe the latch in the same
   *     commit it was set, restoring the exact defect this step fixes.
   *  2. **The device went offline or into quarantine.** Those tile branches
   *     render before the picture anyway, so `WallTile` unmounts `LiveView`;
   *     a latch left behind would be waiting to re-mount it — and start a
   *     session on a possibly-sleeping phone — the moment the device came
   *     back. (`WallTile`'s own `pictureMountedRef` guard already refuses
   *     that; this keeps the state honest as well as harmless.)
   *  3. **The device left the list**, so nothing is holding its entry.
   */
  const prevHotRef = useRef<ReadonlySet<string>>(new Set())
  useEffect(() => {
    if (devices === null) return
    const present = new Set(devices.map((d) => d.id))
    const hot = new Set(devices.filter((d) => d.readiness.actual === 'hot').map((d) => d.id))
    const becameHot = [...hot].filter((id) => !prevHotRef.current.has(id))
    prevHotRef.current = hot
    const unreachable = devices.filter((d) => d.status === 'offline' || d.status === 'quarantined').map((d) => d.id)
    setStreamErrors((prev) => {
      if (prev.size === 0) return prev
      const drop = [...prev.keys()].filter((id) => !present.has(id) || becameHot.includes(id) || unreachable.includes(id))
      if (drop.length === 0) return prev
      if (drop.length === prev.size) return NO_STREAM_ERRORS
      const next = new Map(prev)
      for (const id of drop) next.delete(id)
      return next
    })
  }, [devices])

  /** See `wallWakeTarget` — one computation, shared by the button's count and the request it sends. */
  const wakeTarget = useMemo(() => wallWakeTarget(devices ?? EMPTY_DEVICES), [devices])

  // Loading (Plan 92 §4.7, two rows sharing one skeleton): devices not yet
  // known, or devices known but the real live-tile budget is not — showing
  // tiles before the budget answers is exactly F14 (start the right number
  // of streams once, not the wrong number twice). An EMPTY farm skips the
  // wait entirely: there is nothing to size a budget for.
  if (devices === null) return <TileSkeleton minTileWidthPx={minTileWidthPx} />
  if (devices.length === 0) {
    return (
      <EmptyState
        icon={<Smartphone className="size-4" aria-hidden />}
        title="No devices match"
        description="Change the search or pick a different filter to see the wall."
      />
    )
  }
  if (maxTiles === null) return <TileSkeleton count={devices.length} minTileWidthPx={minTileWidthPx} />

  const sections = groups ?? [[null, devices] as [string | null, DeviceInfo[]]]

  return (
    // Plan 101 §5 step 101.8 (owner-specified, 2026-08-16): the farm-wide
    // status strip that used to sit above this grid ("N of M devices live ·
    // capped at X at once · Y Mbit/s across the farm") is gone — the
    // owner's own instruction was explicit ("gausah ada bilah shortcut kaya
    // '2 total' atau '0 ready'"), and `refs/ui`'s own Devices screen has no
    // farm-wide count anywhere near the grid either. `maxTiles`/`liveSet`
    // still gate which tiles actually stream (unchanged); only the TEXT
    // reporting those numbers is removed. A device that is not live still
    // explains itself individually via its own tile placeholder (offline/
    // quarantined/asleep/"Show live"), so nothing here goes unexplained —
    // it is just no longer summarised in a sentence above the grid.
    //
    // Plan 125 §3.5, §4.3 adds ONE thing back above the grid, and it is
    // deliberately not what 101.8 removed: an ACTION, not a readout. It is
    // absent whenever there is nothing asleep to wake, so a healthy farm
    // still shows a bare grid, and it never reports state the tiles do not
    // already report themselves.
    <div className="space-y-5">
      {onWakeVisible && wakeTarget.wake.length > 0 && (
        // **Plan 92 §9 Q2, answered.** That question — "should the wall offer
        // 'Wake all visible'?" — hesitated for a real reason, quoted in plan
        // 125 §3.5: *"the default view can wake twenty phones with one
        // click, which is either convenient or alarming depending on whose
        // farm it is."* The answer is that the alarming version is the
        // AUTOMATIC one. An action a person presses, that names in its own
        // label exactly how many phones it will touch, and that appears only
        // when there are phones to touch, is neither surprising nor
        // reversible-by-accident.
        //
        // So the label states the count and nothing else: "Wake 12 devices",
        // never a bare "Wake all" whose scope you learn afterwards. Nothing
        // on this row is automatic, nothing on it is a side effect of
        // viewing, and `wakeTarget` is the same object the click submits.
        <div className="flex justify-end">
          <Button size="sm" variant="outline" onClick={() => onWakeVisible(wakeTarget)}>
            <Sunrise className="size-3.5" aria-hidden />
            Wake {wakeTarget.wake.length} device{wakeTarget.wake.length === 1 ? '' : 's'}
          </Button>
        </div>
      )}
      {sections.map(([title, list]) => (
        <div key={title ?? '__all__'}>
          {title !== null && (
            <h3 className="rack-label mb-2">
              {title} <span className="text-fg-subtle">· {list.length}</span>
            </h3>
          )}
          <TileGrid minTileWidthPx={minTileWidthPx}>
            {list.map((d) => (
              // The drag-select/context-menu wrapper (plan 101 §3.9, §5
              // step 101.5, G15) — `data-device-id` is what the parent's
              // `useDragSelect` intersection test looks for, wherever it
              // is nested; `onContextMenu` opens the SAME menu the List
              // view does. A plain, unstyled `div`: CSS Grid's own default
              // `stretch` fills it to the tile's cell exactly as
              // `WallTile` filled that cell directly before, and it adds
              // no box between `WallTile`'s own `rootRef` (the live-set
              // viewport observer) and the anchor that ref actually
              // watches — that wiring is untouched.
              <div key={d.id} data-device-id={d.id} onContextMenu={(e) => onDeviceContextMenu?.(d.id, e)}>
                <WallTile
                  device={d}
                  runningJob={jobByDevice.get(d.id) ?? null}
                  live={liveSet.live.has(d.id)}
                  onShowLive={() => liveSet.showLive(d.id)}
                  selected={selectedSet.has(d.id)}
                  // Only passed through when the CALLER actually supplied
                  // one (plan 101 §5 step 101.7) — `WallTile` reads
                  // `onToggleSelect`'s own presence to decide whether a
                  // click toggles or navigates, so an always-present
                  // wrapper function here would make every click toggle
                  // even for a future caller with no selection concept.
                  onToggleSelect={onToggleSelect ? () => onToggleSelect(d.id) : undefined}
                  focused={d.id === focusId}
                  onFocus={() => onFocus?.(d.id)}
                  rootRef={liveSet.tileRef(d.id)}
                  // Plan 125 §4.3 — the latched reason this device's last
                  // session died, so the tile can keep `LiveView`'s own
                  // retry overlay open instead of swapping it for an inert
                  // "Screen off". `?? null` because `WallTile` treats
                  // `undefined` and `null` alike but reads better with an
                  // explicit absence.
                  streamError={streamErrors.get(d.id) ?? null}
                />
              </div>
            ))}
          </TileGrid>
        </div>
      ))}
    </div>
  )
}
