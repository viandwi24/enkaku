'use client'

import { useEffect, useMemo, useState } from 'react'
import { Smartphone } from 'lucide-react'
import { AdbStatsResponseSchema, SettingsResponseSchema, type DeviceInfo, type JobInfo } from '@enkaku/protocol'
import { WallTile } from './WallTile'
import { TileGrid } from './TileGrid'
import { TileSkeleton } from './TileSkeleton'
import { useLiveSet } from './useLiveSet'
import { EmptyState } from '@/components/states'
import { api } from '@/lib/actions'
import { cn } from '@/lib/utils'
import { useAdbVideoStatsPoll } from '@/components/video/useAdbVideoStatsPoll'
import { formatMbps } from '@/components/video/video-quality'

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
  selectable = false,
  selectedIds,
  onToggleSelect,
  focusId = null,
  onFocus,
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
   * Group selection (plan 91 §3.11/§5 step 91.8, F11/F12) — the SAME
   * `useBulkSelection` instance the parent already drives the List view
   * with, so selecting on one and switching to the other never loses it.
   */
  selectable?: boolean
  selectedIds?: readonly string[]
  onToggleSelect?: (id: string) => void
  /** `?focus=` (plan 91 §3.11) — the one tile currently in the focus overlay. */
  focusId?: string | null
  onFocus?: (id: string) => void
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

  // The status strip's video-rate figure (§3.9, §5 step 92.9 — the piece
  // 92.6 deferred here explicitly and 92.8 could not pick up because this
  // directory sat outside its own file-ownership boundary). Polled every
  // 10s while the tab is visible, mirroring the settings page's own
  // `MeasuredBlock` (`FarmVideoFields.tsx`, `useAdbVideoStatsPoll`) — same
  // hook, same cadence, same endpoint, so the two readers of "what is the
  // farm actually spending right now" can never disagree with each other.
  // Deliberately a SEPARATE poll from the one-shot `maxTiles` fetch above:
  // the live-tile budget only has to be known once before the first tile
  // decides whether to stream (F14); the spend figure is worth refreshing
  // continuously for as long as an operator is looking at it.
  //
  // Honesty note: `transport.videoBytesPerSec` is farm-wide across EVERY
  // open session, wall and control quality alike — the two share one WS
  // transport (plan 85's own H1) and the wire carries no per-quality
  // split — so this is labelled "across the farm", never implied to be
  // this wall's own spend alone.
  //
  // What this does NOT include, and why it is not faked here: §4.7's own
  // status-strip mockup also shows an average fps and the real (as-
  // negotiated) resolution — e.g. "4.8 fps · 480×1040". Producing either
  // needs each live tile's own `stream.started` event plus a running frame
  // counter, and the only place those numbers exist today is inside
  // `LiveView` (`packages/studio/src/components/LiveView.tsx`), which sits
  // outside `packages/studio/src/components/wall/**` — this step's own
  // file-ownership boundary, the identical reason 92.8's own status note
  // gives for leaving this exact gap open. Closing it needs an additive
  // `LiveView` stats callback plus `WallTile` forwarding it: real feature
  // work, not something to smuggle into a documentation step by editing a
  // file outside its remit. Left open for a follow-up step — see
  // `docs/plans/92-m57-wall-first-and-video-quality.md`'s step 92.9 entry.
  const { stats: videoStats } = useAdbVideoStatsPoll(10_000)

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

  // The status strip's blocked/budgeted breakdown (Plan 92 §4.7, §3.9): a
  // wall showing 12 of 100 live must say what the other 88 are doing, or the
  // 88 read as unexplained blanks even though every one of their tiles
  // already explains itself individually (`WallTile`'s own placeholders).
  const blockedCounts = useMemo(() => {
    const counts = { asleep: 0, offline: 0, quarantined: 0 }
    for (const reason of liveSet.blocked.values()) counts[reason]++
    return counts
  }, [liveSet.blocked])
  const budgetedCount = liveSet.budgeted.size
  const breakdownParts: string[] = []
  if (budgetedCount > 0) breakdownParts.push(`${budgetedCount} outside the live budget`)
  if (blockedCounts.asleep > 0) breakdownParts.push(`${blockedCounts.asleep} asleep`)
  if (blockedCounts.offline > 0) breakdownParts.push(`${blockedCounts.offline} offline`)
  if (blockedCounts.quarantined > 0) breakdownParts.push(`${blockedCounts.quarantined} quarantined`)

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
    <div className="space-y-2">
      <p className="text-[11.5px] text-fg-muted">
        <span
          className={cn(breakdownParts.length > 0 && 'cursor-help border-b border-dotted border-fg-subtle')}
          title={breakdownParts.length > 0 ? breakdownParts.join(' · ') : undefined}
        >
          {Math.min(liveSet.live.size, devices.length)} of {devices.length} device{devices.length === 1 ? '' : 's'} live
        </span>{' '}
        · capped at {maxTiles} at once
        {videoStats && (
          <>
            {' '}
            · <span className="readout">{formatMbps(videoStats.transport.videoBytesPerSec * 8)}</span> across the farm
          </>
        )}
      </p>
      <div className="space-y-5">
        {sections.map(([title, list]) => (
          <div key={title ?? '__all__'}>
            {title !== null && (
              <h3 className="rack-label mb-2">
                {title} <span className="text-fg-subtle">· {list.length}</span>
              </h3>
            )}
            <TileGrid minTileWidthPx={minTileWidthPx}>
              {list.map((d) => (
                <WallTile
                  key={d.id}
                  device={d}
                  runningJob={jobByDevice.get(d.id) ?? null}
                  live={liveSet.live.has(d.id)}
                  onShowLive={() => liveSet.showLive(d.id)}
                  selectable={selectable}
                  selected={selectedSet.has(d.id)}
                  onToggleSelect={() => onToggleSelect?.(d.id)}
                  focused={d.id === focusId}
                  onFocus={() => onFocus?.(d.id)}
                  rootRef={liveSet.tileRef(d.id)}
                />
              ))}
            </TileGrid>
          </div>
        ))}
      </div>
    </div>
  )
}
