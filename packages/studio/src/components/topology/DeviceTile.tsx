'use client'

import Link from 'next/link'
import { Boxes } from 'lucide-react'
import type { DeviceInfo } from '@enkaku/protocol'
import type { TopologyActiveJob } from '@/lib/api'
import { DeviceStatusBadge, ReadinessBadge } from '@/components/StatusBadge'
import { TileChips } from '@/components/TileChips'
import { DeviceName, duration, cn } from '@enkaku/ui'

/**
 * One device on the fleet map (plan 32 §3.4). Built entirely from the
 * existing design-system rack-unit vocabulary (the status rail, `.readout`,
 * `DeviceStatusBadge`) — no new visual language for this one screen, and no
 * graph library (plan 32 §3.3).
 *
 * The whole tile is a single `<Link>`, so Tab moves tile to tile and Enter
 * navigates — the map navigates, it does not act (plan 32 §2).
 */
export function DeviceTile({
  device,
  clusterCount,
  runningJob,
  tempThresholdC,
  now,
  compact = false,
}: {
  device: DeviceInfo
  /** How many cluster sections this same device appears in (plan 32 §3.2) — shown so a repeat never reads as a data error. */
  clusterCount: number
  runningJob?: TopologyActiveJob | null
  /** The farm's auto-quarantine threshold (plan 32 §4, not a hardcoded number). */
  tempThresholdC: number
  now: number
  compact?: boolean
}) {
  const offline = device.status === 'offline'

  return (
    <Link
      href={`/device?id=${encodeURIComponent(device.id)}`}
      className={cn(
        'relative flex min-w-0 flex-col gap-1.5 overflow-hidden rounded-lg border bg-surface px-3 py-2.5 pl-4 transition-colors',
        offline ? 'opacity-60' : 'hover:border-line-strong',
      )}
    >
      <span
        className="status-rail"
        data-status={device.status}
        data-live={device.status === 'busy' ? 'true' : 'false'}
        aria-hidden
      />

      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          {/* Plan 124 §4.4 Group B, step 124.2 — the fleet map named a
              device by label alone, which on a rack of physically identical
              phones names nothing; its sibling `wall/WallTile.tsx` has shown
              the number since plan 89 and this tile now matches it. The
              `flex` in `className` overrides `<DeviceName>`'s own
              `inline-flex` on purpose: as a block-level flex box it takes the
              width of this `min-w-0` column, which is what actually lets the
              label's `truncate` engage. A device with no number renders the
              bare label with no leading gap (criterion 7) — the spacing comes
              from the flex container, not from padding on either span. */}
          <p className="text-[13px] font-medium leading-tight">
            <DeviceName number={device.number} label={device.label} className="flex" />
          </p>
          <p className="readout truncate text-[10.5px] text-fg-subtle">{device.stableId}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {/* Readiness (plan 43 §4.6) — the same badge the Wall and the devices list use. */}
          <ReadinessBadge readiness={device.readiness} className={compact ? 'scale-90' : undefined} />
          <DeviceStatusBadge status={device.status} />
        </div>
      </div>

      {!compact && (
        <>
          {/* Battery + temperature only (plan 48 §5 step 48.4) — readiness
              and status are already shown above, next to the label, so this
              tile does not duplicate them. Sharing `TileChips` here keeps
              the low-battery / hot colour rules from drifting against the
              Wall's version of the same row. */}
          <TileChips
            device={device}
            chips={['battery', 'temperature']}
            tempThresholdC={tempThresholdC}
            className="gap-3 text-[11px] [&_svg]:size-3"
          />

          {device.status === 'busy' && runningJob && (
            <p className="truncate rounded border border-led-active/30 bg-led-active/5 px-2 py-1 text-[11px] text-fg-muted">
              {runningJob.scriptName ?? 'running a job'}
              <span className="readout ml-1.5 text-fg-subtle">{duration(runningJob.startedAt, null, now)}</span>
            </p>
          )}

          {clusterCount > 1 && (
            <span className="readout inline-flex w-fit items-center gap-1 rounded-full bg-surface-2 px-1.5 py-0.5 text-[10px] text-fg-muted">
              <Boxes className="size-2.5" aria-hidden />
              in {clusterCount} clusters
            </span>
          )}
        </>
      )}
    </Link>
  )
}
