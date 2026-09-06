'use client'

import { useEffect, useState } from 'react'
import { AdbStatsResponseSchema, type DeviceInfo } from '@enkaku/protocol'
import { api } from '@enkaku/ui'
import { CARD_WIDTH_PX, type CardWidth } from './DevicesToolbar'
import { DeviceScreenCard } from './DeviceScreenCard'
import { useLiveSet } from './useLiveSet'
import type { DeviceSelection } from './useDeviceSelection'

/**
 * Only ever reached when `/api/adb/stats` does not answer. It used to be 8,
 * far below the ~24 `computeAutoTiles` actually resolves on a local farm, so
 * a slow or failed stats call silently capped a twenty-phone grid at eight
 * live tiles — and nothing on screen said why. Matching
 * `WALL_DECODE_TILE_CEILING` makes the fallback agree with the real budget.
 */
const DEFAULT_MAX_TILES = 24
/** Mirrors `WALL_RAMP_CONCURRENCY`'s own default; the server sends the real one. */
const DEFAULT_RAMP_CONCURRENCY = 12

/**
 * The auto-fill card grid (design handoff, "Screens view (card grid)") and
 * the live-set wiring, moved verbatim from the old fleet screen's tile grid
 * (plan 214 §3.9, §4.10): `maxTiles` from `/api/adb/stats`'s `video.maxTiles`,
 * `rampConcurrency` from `/api/settings`, both read once at mount.
 */
export function ScreensGrid({
  devices,
  cardWidth,
  selection,
  onItemContextMenu,
}: {
  devices: DeviceInfo[]
  cardWidth: CardWidth
  selection: DeviceSelection
  /** Right-click on a card: the same device context menu the table rows open. */
  onItemContextMenu: (id: string, e: React.MouseEvent) => void
}) {
  const [maxTiles, setMaxTiles] = useState<number | null>(null)
  const [rampConcurrency, setRampConcurrency] = useState(DEFAULT_RAMP_CONCURRENCY)

  useEffect(() => {
    void api('/api/adb/stats', AdbStatsResponseSchema)
      .then((b) => {
        setMaxTiles(b.video && b.video.maxTiles > 0 ? b.video.maxTiles : DEFAULT_MAX_TILES)
        // `WALL_RAMP_CONCURRENCY`, as the farm actually resolved it. The
        // setter used to exist with no caller, so the constant and its
        // `ENKAKU_WALL_RAMP_CONCURRENCY` override reached nothing.
        if (b.video && b.video.rampConcurrency > 0) setRampConcurrency(b.video.rampConcurrency)
      })
      .catch(() => setMaxTiles(DEFAULT_MAX_TILES))
  }, [])

  const liveSet = useLiveSet({ devices, maxTiles: maxTiles ?? 0, rampConcurrency })

  return (
    <div className="min-h-0 flex-1 select-none overflow-auto p-[14px]" onMouseDown={selection.onMarqueeMouseDown}>
      <div
        className="grid gap-3"
        style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${CARD_WIDTH_PX[cardWidth]}px, 1fr))` }}
      >
        {devices.map((device) => (
          <DeviceScreenCard
            key={device.id}
            device={device}
            selected={selection.selected.has(device.id)}
            live={liveSet.live.has(device.id) && device.status === 'online'}
            tileRef={liveSet.tileRef(device.id)}
            onMouseDown={(e) => selection.onItemMouseDown(device.id, e)}
            onDoubleClick={() => selection.onItemDoubleClick(device.id)}
            onContextMenu={(e) => onItemContextMenu(device.id, e)}
          />
        ))}
      </div>
    </div>
  )
}
