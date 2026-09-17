'use client'

import { connectionBadge, type DeviceInfo } from '@enkaku/protocol'
import { Checkbox, LabelChip, StatusDot, cn } from '@enkaku/ui'
import { dotStateOf, dotTooltipOf } from './device-state'
import { TaskCell } from './TaskCell'

/**
 * The handoff's grid, character for character, minus its first column. Two
 * `fr` columns, so it cannot be a `<table>` (plan 214 §4.8).
 *
 * The 38px checkbox gutter is gone (owner, 2026-09-17): clicking the row
 * toggles it, so a checkbox on every row was a second control for the same
 * act, and the Screens grid never had one to match. Select-all survives in
 * the `#` header cell, which is why that column is wider than the two digits
 * it holds.
 */
const COLS =
  'grid grid-cols-[70px_1.3fr_1fr_108px_92px_138px_70px_74px_62px_62px_62px_76px_1.1fr] items-center'

const HEAD = 'px-2 text-left text-label font-medium text-faint'
const MONO = 'px-2 font-mono text-[12px] text-text-3'

/** The handoff: "Disconnected rows render at `opacity: 0.6` and show `—` for every metric." */
function Metric({ value, className }: { value: string | null; className?: string }) {
  return <span className={cn('px-2 text-body', value === null ? 'text-faint-2' : className)}>{value ?? '—'}</span>
}

const battClass = (level: number) => (level < 20 ? 'text-danger' : level < 45 ? 'text-warn' : 'text-accent')

/** `4d 2h`, `2h 13m`, `41m` — never more than two units. */
function formatUptime(sec: number | null | undefined): string | null {
  if (sec == null) return null
  const days = Math.floor(sec / 86400)
  const hours = Math.floor((sec % 86400) / 3600)
  const minutes = Math.floor((sec % 3600) / 60)
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${minutes}m`
}

export function DeviceTable({
  devices,
  selected,
  onItemMouseDown,
  onItemDoubleClick,
  onMarqueeMouseDown,
  onItemContextMenu,
  onSelectAll,
  queuedFor,
}: {
  devices: DeviceInfo[]
  selected: ReadonlySet<string>
  onItemMouseDown: (id: string, e: React.MouseEvent) => void
  onItemDoubleClick: (id: string) => void
  /**
   * The scroller's mousedown — the same marquee the Screens grid draws, from
   * the same hook, into the same selection. A drag that starts on a row
   * still promotes to a marquee through `onItemMouseDown`; this one covers
   * the header and the empty space below the last row.
   */
  onMarqueeMouseDown: (e: React.MouseEvent) => void
  /** Right-click on a row: opens the device context menu at the cursor. */
  onItemContextMenu: (id: string, e: React.MouseEvent) => void
  onSelectAll: (checked: boolean) => void
  queuedFor: (deviceId: string) => number
}) {
  const allSelected = devices.length > 0 && devices.every((d) => selected.has(d.id))

  return (
    <div className="min-h-0 flex-1 select-none overflow-auto" onMouseDown={onMarqueeMouseDown}>
      <div role="table" className="min-w-[1448px]">
        <div role="row" className={cn(COLS, 'sticky top-0 z-10 h-[38px] border-b border-line bg-panel-2')}>
          <div className="flex items-center gap-2 px-2">
            <Checkbox checked={allSelected} onCheckedChange={(v) => onSelectAll(Boolean(v))} aria-label="Select all devices" />
            <span className="text-label font-medium text-faint">#</span>
          </div>
          <span className={HEAD}>Device</span>
          <span className={HEAD}>Labels</span>
          <span className={HEAD}>Serial</span>
          <span className={HEAD}>OS</span>
          <span className={HEAD}>Endpoint</span>
          <span className={HEAD}>Batt</span>
          <span className={HEAD}>Temp</span>
          <span className={HEAD}>CPU</span>
          <span className={HEAD}>Mem</span>
          <span className={HEAD}>Disk</span>
          <span className={HEAD}>Uptime</span>
          <span className={HEAD}>Task</span>
        </div>

        {devices.map((device) => {
          const isSelected = selected.has(device.id)
          const offline = device.status === 'offline'
          return (
            <div
              key={device.id}
              role="row"
              data-device-id={device.id}
              data-state={isSelected ? 'selected' : undefined}
              onMouseDown={(e) => onItemMouseDown(device.id, e)}
              onDoubleClick={() => onItemDoubleClick(device.id)}
              onContextMenu={(e) => onItemContextMenu(device.id, e)}
              className={cn(
                COLS,
                'h-[54px] border-b border-muted-2 transition-colors hover:bg-hover select-none',
                isSelected && 'bg-accent-soft shadow-selected-row',
                offline && 'opacity-60',
              )}
            >
              {/*
                The device's OWN number, not its position in this list.

                This cell used to render `index + 1`, which looked right on the
                All tab and was wrong everywhere else: switching to a group tab
                renumbered the whole fleet from 01, so `#03` meant a different
                phone under every tab, and matched nothing written on the
                phone's own label (owner, 2026-09-17). `device.number` is the
                durable key (`device_numbers.number`, CLAUDE.md's
                `$device.number` rule); a device with no reservation shows `—`
                rather than inventing one.

                It carries the `#` because it is now the only place the number
                appears on the row — the Device cell beside it dropped
                `formatDeviceName`'s `#N ` prefix, which was printing the
                number twice on a row that already had a column for it.
              */}
              <span className="px-2 font-mono text-[12px] font-medium text-text-3">
                {device.number == null ? <span className="text-faint-2">—</span> : `#${String(device.number).padStart(2, '0')}`}
              </span>
              <div className="flex min-w-0 items-center gap-2 px-2">
                <StatusDot state={dotStateOf(device)} title={dotTooltipOf(device)} />
                <div className="min-w-0">
                  <div className="truncate text-row font-medium text-text">{device.label}</div>
                  <div className="truncate text-label text-faint">{device.model ?? device.stableId}</div>
                </div>
              </div>
              {/*
                One row of chips, clipped rather than wrapped: the row height
                is fixed at 54px by the handoff's grid, and a device carrying
                six labels must not be allowed to push its neighbours out of
                alignment. `+N` says how many are hidden, and the title
                attribute names them, so nothing is silently lost.
              */}
              <div className="flex min-w-0 items-center gap-1 overflow-hidden px-2">
                {device.labels.slice(0, 2).map((l) => (
                  <LabelChip key={l.id} name={l.name} color={l.color} />
                ))}
                {device.labels.length > 2 && (
                  <span
                    title={device.labels.slice(2).map((l) => l.name).join(', ')}
                    className="flex-none text-label text-faint"
                  >
                    +{device.labels.length - 2}
                  </span>
                )}
                {device.labels.length === 0 && <span className="text-body text-faint-2">—</span>}
              </div>
              <span className={MONO}>{device.serial}</span>
              <span className="px-2 text-body text-text-3">{device.androidVersion ?? '—'}</span>
              <span className={MONO}>
                {device.connection.address ? `${device.connection.address}:${device.connection.port ?? ''}` : connectionBadge(device.connection)}
              </span>
              <Metric value={offline || !device.battery ? null : `${device.battery.level}%`} className={device.battery ? battClass(device.battery.level) : undefined} />
              <Metric
                value={offline || !device.battery ? null : `${device.battery.temperatureC.toFixed(0)}°`}
                className={device.battery && device.battery.temperatureC > 42 ? 'text-danger' : 'text-text-3'}
              />
              <Metric value={offline || device.metrics?.cpuPercent == null ? null : `${Math.round(device.metrics.cpuPercent)}%`} className="text-text-3" />
              <Metric value={offline || device.metrics?.memPercent == null ? null : `${Math.round(device.metrics.memPercent)}%`} className="text-text-3" />
              <Metric value={offline || device.metrics?.diskPercent == null ? null : `${Math.round(device.metrics.diskPercent)}%`} className="text-text-3" />
              <span className={cn('px-2 font-mono text-[12px]', offline ? 'text-faint-2' : 'text-text-3')}>
                {offline ? '—' : (formatUptime(device.metrics?.uptimeSec) ?? '—')}
              </span>
              <TaskCell device={device} queued={queuedFor(device.id)} />
            </div>
          )
        })}
      </div>
    </div>
  )
}
