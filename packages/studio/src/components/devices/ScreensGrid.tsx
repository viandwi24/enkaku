'use client'

import { useEffect, useState } from 'react'
import { AdbStatsResponseSchema, type DeviceInfo } from '@enkaku/protocol'
import { api } from '@enkaku/ui'
import { CARD_WIDTH_PX, type CardWidth } from './DevicesToolbar'
import { DeviceScreenCard } from './DeviceScreenCard'
import { useLiveSet } from './useLiveSet'
import type { DeviceSelection } from './useDeviceSelection'

const DEFAULT_MAX_TILES = 8
const DEFAULT_RAMP_CONCURRENCY = 2

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
      .then((b) => setMaxTiles(b.video && b.video.maxTiles > 0 ? b.video.maxTiles : DEFAULT_MAX_TILES))
      .catch(() => setMaxTiles(DEFAULT_MAX_TILES))
  }, [])

  // Plan 212 §4.1 — `wall.rampConcurrency` is the constant `WALL_RAMP_CONCURRENCY`
  // now (default 2, matching `DEFAULT_RAMP_CONCURRENCY` above); no live fetch.
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
