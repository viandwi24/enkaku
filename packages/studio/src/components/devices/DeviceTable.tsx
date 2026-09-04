'use client'

import { connectionBadge, type DeviceInfo } from '@enkaku/protocol'
import { Checkbox, StatusDot, cn, formatDeviceName } from '@enkaku/ui'
import { dotStateOf, dotTooltipOf } from './device-state'
import { TaskCell } from './TaskCell'

/** The handoff's grid, character for character. Two `fr` columns, so it cannot be a `<table>` (plan 214 §4.8). */
const COLS = 'grid grid-cols-[38px_44px_1.3fr_108px_92px_138px_70px_74px_62px_62px_62px_76px_1.1fr] items-center'

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
  onToggle,
  onSelectAll,
  queuedFor,
}: {
  devices: DeviceInfo[]
  selected: ReadonlySet<string>
  onItemMouseDown: (id: string, e: React.MouseEvent) => void
  onItemDoubleClick: (id: string) => void
  /** The checkbox's own direct toggle — immediate, not the deferred row click. */
  onToggle: (id: string) => void
  onSelectAll: (checked: boolean) => void
  queuedFor: (deviceId: string) => number
}) {
  const allSelected = devices.length > 0 && devices.every((d) => selected.has(d.id))

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <div role="table" className="min-w-[1324px]">
        <div role="row" className={cn(COLS, 'sticky top-0 z-10 h-[38px] border-b border-line bg-panel-2')}>
          <div className="flex items-center justify-center">
            <Checkbox checked={allSelected} onCheckedChange={(v) => onSelectAll(Boolean(v))} />
          </div>
          <span className={HEAD}>#</span>
          <span className={HEAD}>Device</span>
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

        {devices.map((device, index) => {
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
              className={cn(
                COLS,
                'h-[54px] border-b border-muted-2 transition-colors hover:bg-hover select-none',
                isSelected && 'bg-accent-soft shadow-selected-row',
                offline && 'opacity-60',
              )}
            >
              <div className="flex items-center justify-center" onClick={(e) => e.stopPropagation()}>
                <Checkbox checked={isSelected} onCheckedChange={() => onToggle(device.id)} />
              </div>
              <span className="px-2 font-mono text-[11.5px] text-faint">{String(index + 1).padStart(2, '0')}</span>
              <div className="flex min-w-0 items-center gap-2 px-2">
                <StatusDot state={dotStateOf(device)} title={dotTooltipOf(device)} />
                <div className="min-w-0">
                  <div className="truncate text-row font-medium text-text">{formatDeviceName(device.number, device.label)}</div>
                  <div className="truncate text-label text-faint">{device.model ?? device.stableId}</div>
                </div>
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
