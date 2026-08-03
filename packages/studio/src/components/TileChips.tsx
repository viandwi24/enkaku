import { Battery, Thermometer } from 'lucide-react'
import type { DeviceInfo } from '@enkaku/protocol'
import { DeviceStatusBadge, ReadinessBadge } from '@/components/StatusBadge'
import { cn } from '@/lib/utils'

export type TileChipKind = 'battery' | 'temperature' | 'readiness' | 'status'

/** Canonical order (Plan 48 §3.2) — battery, temperature, readiness, status,
 * always in this order. Exported so a caller that only wants a subset (e.g.
 * topology's `DeviceTile`, which already shows readiness/status next to its
 * label) states its choice as a set, never a re-ordering: the JSX below
 * renders in this fixed sequence regardless of what order `chips` lists. */
export const ALL_TILE_CHIPS: TileChipKind[] = ['battery', 'temperature', 'readiness', 'status']

/** Wall tiles have no farm-configured hot threshold plumbed through yet, so
 * they keep the fixed number the Wall used before this component existed. */
const DEFAULT_HOT_THRESHOLD_C = 45

/**
 * Battery · temperature · readiness · status, in one scannable row (Plan 48
 * §3.2, §4.2). Shared by the Wall's `WallTile` and topology's `DeviceTile` so
 * the low-battery / hot colour rules can never drift between the two.
 *
 * Order is fixed and never reflows. A missing value (no battery reading yet)
 * renders a dash IN PLACE of that one chip rather than collapsing the row —
 * a chip that disappears shifts every chip after it, and grid columns stop
 * lining up across tiles (§6.3).
 */
export function TileChips({
  device,
  chips = ALL_TILE_CHIPS,
  /** The farm's auto-quarantine threshold (plan 32 §4) when a caller has
   * one; defaults to the Wall's existing fixed number otherwise. */
  tempThresholdC = DEFAULT_HOT_THRESHOLD_C,
  className,
}: {
  device: DeviceInfo
  /** Which chips to render — any subset, any order given; always drawn in
   * the fixed canonical order above. Defaults to all four. */
  chips?: TileChipKind[]
  tempThresholdC?: number
  className?: string
}) {
  const show = new Set(chips)
  const hot = device.battery !== null && device.battery.temperatureC >= tempThresholdC
  const lowBattery = device.battery !== null && device.battery.level < 20

  return (
    /* `flex-wrap` and `min-w-0`, not a plain row: a 200px tile leaves about
       184px of usable width, and battery + temperature + readiness + status
       with their gaps need roughly 234px. Without wrapping the row simply
       overflowed the tile and ran off the screen. Each chip keeps `shrink-0`
       so wrapping moves a whole chip down rather than squashing one into
       something unreadable. */
    <div className={cn('flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-[10.5px]', className)}>
      {show.has('battery') && (
        <span className={cn('readout flex shrink-0 items-center gap-1', lowBattery ? 'text-led-warn' : 'text-fg-muted')}>
          <Battery className="size-2.5" aria-hidden />
          {device.battery ? `${device.battery.level}%` : '—'}
        </span>
      )}
      {show.has('temperature') && (
        <span className={cn('readout flex shrink-0 items-center gap-1', hot ? 'text-led-danger' : 'text-fg-muted')}>
          <Thermometer className="size-2.5" aria-hidden />
          {device.battery ? `${device.battery.temperatureC.toFixed(1)}°C` : '—'}
        </span>
      )}
      {show.has('readiness') && <ReadinessBadge readiness={device.readiness} className="scale-90" />}
      {show.has('status') && <DeviceStatusBadge status={device.status} className="scale-90" />}
    </div>
  )
}
