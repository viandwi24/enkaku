import type { CSSProperties } from 'react'
import type { DeviceInfo } from '@enkaku/protocol'
import { StatusDot, cn, formatDeviceName } from '@enkaku/ui'
import { LiveView } from '@/components/LiveView'
import { dotStateOf, dotTooltipOf } from './device-state'

/** The handoff's "135° 6px stripe pattern at `opacity: 0.7`" for a screen that is not live. */
const STRIPE: CSSProperties = {
  backgroundImage: 'repeating-linear-gradient(135deg, var(--muted-2) 0 3px, var(--panel-2) 3px 6px)',
}

export function DeviceScreenCard({
  device,
  selected,
  live,
  tileRef,
  onMouseDown,
  onDoubleClick,
}: {
  device: DeviceInfo
  selected: boolean
  live: boolean
  tileRef: (node: Element | null) => void
  onMouseDown: (e: React.MouseEvent) => void
  onDoubleClick: () => void
}) {
  return (
    <div
      data-device-id={device.id}
      ref={tileRef}
      onMouseDown={onMouseDown}
      onDoubleClick={onDoubleClick}
      className={cn(
        'rounded-panel border p-[6px] transition-colors',
        selected ? 'border-accent bg-accent-soft' : 'border-line-2',
      )}
    >
      <div className="relative aspect-[9/19.5] overflow-hidden rounded-inner bg-muted-2">
        {live ? (
          <LiveView deviceId={device.id} inputEnabled={false} quality="wall" compact />
        ) : (
          <div className="absolute inset-0 opacity-70" style={STRIPE} />
        )}
        <div className="pointer-events-none absolute inset-x-0 top-0 flex flex-col items-center gap-0.5 bg-gradient-to-b from-panel-a to-transparent px-1 pt-1.5 pb-3">
          <span className="max-w-full truncate text-[12px] font-medium text-text">{formatDeviceName(device.number, device.label)}</span>
          <span className="max-w-full truncate font-mono text-tip text-faint">{device.serial}</span>
        </div>
        {!live && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <span className={cn('text-label', device.status === 'quarantined' ? 'text-warn' : 'text-faint-2')}>
              {device.status === 'quarantined' ? 'Quarantined' : 'Disconnected'}
            </span>
          </div>
        )}
        <StatusDot ring state={dotStateOf(device)} title={dotTooltipOf(device)} className="absolute bottom-1.5 left-1.5" />
      </div>
    </div>
  )
}
