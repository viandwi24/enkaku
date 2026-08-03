'use client'

import { useEffect, useMemo, useState } from 'react'
import { Smartphone } from 'lucide-react'
import type { DeviceInfo, JobInfo } from '@enkaku/protocol'
import { WallTile } from './WallTile'
import { TileGrid } from './TileGrid'
import { EmptyState, LoadingRows } from '@/components/states'
import { api } from '@/lib/actions'

/** Fallback only until `/api/settings` answers. */
const DEFAULT_MAX_TILES = 8

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
 */
export function Wall({
  devices,
  jobs,
  groups,
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
}) {
  const [maxTiles, setMaxTiles] = useState(DEFAULT_MAX_TILES)
  // The ordered set of devices actually streaming right now (Plan 42 §4.6) —
  // capped at `maxTiles`. Backfilled from newly-eligible devices as the farm
  // changes, but a manual "Show live" swap always wins over the default order.
  const [liveIds, setLiveIds] = useState<string[]>([])

  useEffect(() => {
    void api<{ settings: { wall: { maxTiles: number } } }>('/api/settings')
      .then((b) => setMaxTiles(b.settings.wall.maxTiles))
      .catch(() => undefined)
  }, [])

  const eligibleIds = useMemo(
    () => (devices ?? []).filter((d) => d.status !== 'offline' && d.status !== 'quarantined').map((d) => d.id),
    [devices],
  )

  // Keep the live set full and valid as the fleet changes: drop ids that
  // went offline/quarantined, then backfill from eligible devices not
  // already live, up to the cap — without disturbing a manual "Show live"
  // choice already in the set.
  useEffect(() => {
    setLiveIds((prev) => {
      const eligible = new Set(eligibleIds)
      const kept = prev.filter((id) => eligible.has(id))
      if (kept.length >= maxTiles) return kept.slice(0, maxTiles)
      const next = [...kept]
      for (const id of eligibleIds) {
        if (next.length >= maxTiles) break
        if (!next.includes(id)) next.push(id)
      }
      return next
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eligibleIds.join(','), maxTiles])

  const showLive = (id: string) =>
    setLiveIds((prev) => {
      if (prev.includes(id)) return prev
      const next = [...prev, id]
      // At the cap: the least-recently-shown tile (the front of the list)
      // makes room, so the wall never exceeds `wall.maxTiles` live decoders
      // (Plan 42 §3.5, acceptance #11).
      if (next.length > maxTiles) next.shift()
      return next
    })

  const liveSet = useMemo(() => new Set(liveIds), [liveIds])
  const jobByDevice = useMemo(() => new Map(jobs.map((j) => [j.deviceId, j])), [jobs])

  if (devices === null) return <LoadingRows rows={4} />
  if (devices.length === 0) {
    return (
      <EmptyState
        icon={<Smartphone className="size-4" aria-hidden />}
        title="No devices match"
        description="Change the search or pick a different filter to see the wall."
      />
    )
  }

  const sections = groups ?? [[null, devices] as [string | null, DeviceInfo[]]]

  return (
    <div className="space-y-2">
      <p className="text-[11.5px] text-fg-muted">
        {Math.min(liveSet.size, devices.length)} of {devices.length} device{devices.length === 1 ? '' : 's'} live ·
        capped at {maxTiles} at once
      </p>
      <div className="space-y-5">
        {sections.map(([title, list]) => (
          <div key={title ?? '__all__'}>
            {title !== null && (
              <h3 className="rack-label mb-2">
                {title} <span className="text-fg-subtle">· {list.length}</span>
              </h3>
            )}
            <TileGrid minTileWidthPx={180}>
              {list.map((d) => (
                <WallTile
                  key={d.id}
                  device={d}
                  runningJob={jobByDevice.get(d.id) ?? null}
                  live={liveSet.has(d.id)}
                  onShowLive={() => showLive(d.id)}
                />
              ))}
            </TileGrid>
          </div>
        ))}
      </div>
    </div>
  )
}
