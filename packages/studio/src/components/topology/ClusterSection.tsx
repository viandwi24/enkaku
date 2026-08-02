'use client'

import { ChevronDown, ChevronRight } from 'lucide-react'
import type { DeviceInfo, DeviceStatus } from '@enkaku/protocol'
import type { TopologyActiveJob } from '@/lib/api'
import { DeviceTile } from './DeviceTile'
import { cn } from '@/lib/utils'

const STATUS_ORDER: DeviceStatus[] = ['idle', 'busy', 'manual', 'quarantined', 'offline']
const STATUS_WORD: Record<DeviceStatus, string> = {
  idle: 'idle',
  busy: 'busy',
  manual: 'controlled',
  quarantined: 'quarantined',
  offline: 'offline',
}

/** `8 devices · 6 idle · 2 busy` (plan 32 §3.6) — only the statuses actually present, so an all-idle section does not read `0 quarantined`. */
function summarise(devices: DeviceInfo[]): string {
  const counts = new Map<DeviceStatus, number>()
  for (const d of devices) counts.set(d.status, (counts.get(d.status) ?? 0) + 1)
  const parts = STATUS_ORDER.filter((s) => (counts.get(s) ?? 0) > 0).map((s) => `${counts.get(s)} ${STATUS_WORD[s]}`)
  return [`${devices.length} device${devices.length === 1 ? '' : 's'}`, ...parts].join(' · ')
}

/**
 * One cluster's header (name, live counts, collapse toggle) plus its tile
 * grid (plan 32 §4.2). A cluster resolving to zero devices says so, rather
 * than rendering a silently empty box (plan 32 §4.3, acceptance #7) — that
 * is a real misconfiguration worth surfacing, not a data error.
 */
export function ClusterSection({
  title,
  devices,
  clusterCountByDevice,
  activeJobsByDevice,
  tempThresholdC,
  now,
  compact,
  collapsed,
  onToggleCollapse,
  emptyMessage,
}: {
  title: string
  devices: DeviceInfo[]
  clusterCountByDevice: Map<string, number>
  activeJobsByDevice: Map<string, TopologyActiveJob>
  tempThresholdC: number
  now: number
  compact: boolean
  collapsed: boolean
  onToggleCollapse: () => void
  /** Shown instead of the grid when `devices` is empty. */
  emptyMessage?: string
}) {
  return (
    <section className="space-y-2.5">
      <button
        type="button"
        onClick={onToggleCollapse}
        aria-expanded={!collapsed}
        className="flex w-full items-center gap-2 text-left"
      >
        {collapsed ? (
          <ChevronRight className="size-3.5 shrink-0 text-fg-subtle" aria-hidden />
        ) : (
          <ChevronDown className="size-3.5 shrink-0 text-fg-subtle" aria-hidden />
        )}
        <h2 className="text-[13px] font-semibold tracking-tight">{title}</h2>
        <span className="readout truncate text-[11.5px] text-fg-muted">{summarise(devices)}</span>
      </button>

      {!collapsed &&
        (devices.length === 0 ? (
          <p className={cn('rounded-lg border border-dashed px-4 py-3 text-[12px] text-fg-muted', 'ml-5')}>
            {emptyMessage ?? 'No devices currently match this cluster.'}
          </p>
        ) : (
          <div
            className={cn(
              'grid gap-2 pl-5',
              compact
                ? 'grid-cols-[repeat(auto-fill,minmax(140px,1fr))]'
                : 'grid-cols-[repeat(auto-fill,minmax(200px,1fr))]',
            )}
          >
            {devices.map((d) => (
              <DeviceTile
                key={d.id}
                device={d}
                clusterCount={clusterCountByDevice.get(d.id) ?? 0}
                runningJob={activeJobsByDevice.get(d.id) ?? null}
                tempThresholdC={tempThresholdC}
                now={now}
                compact={compact}
              />
            ))}
          </div>
        ))}
    </section>
  )
}
