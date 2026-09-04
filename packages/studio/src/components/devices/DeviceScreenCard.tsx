import type { CSSProperties } from 'react'
import type { DeviceInfo } from '@enkaku/protocol'
import { StatusDot, cn } from '@enkaku/ui'
import { LiveView } from '@/components/LiveView'
import { dotStateOf, dotTooltipOf } from './device-state'

/** The handoff's "135° 6px stripe pattern at `opacity: 0.7`" for a screen that is not live. */
const STRIPE: CSSProperties = {
  backgroundImage: 'repeating-linear-gradient(135deg, var(--muted-2) 0 3px, var(--panel-2) 3px 6px)',
}

/**
 * What a tile says when it is not streaming.
 *
 * `!live` covers three different facts and they must not share one word. A
 * device that is genuinely `offline` is Disconnected; a `quarantined` one is
 * Quarantined; but an ONLINE device is simply not being streamed right now —
 * the wall's tile budget (`useLiveSet`, plan 214 §3.9) keeps only so many
 * encoders alive, and a tile outside the viewport or still ramping is one of
 * them. Calling that "Disconnected" is false, and the owner read it as a
 * casting failure on a phone that was online and under control at the time
 * (field report, 2026-09-04). Under always-on sessions (plan 206) the session
 * is up whatever the tile shows, so the honest word is about the PICTURE, not
 * the connection.
 */
function idleLabelOf(device: DeviceInfo): string {
  if (device.status === 'offline') return 'Disconnected'
  if (device.status === 'quarantined') return 'Quarantined'
  return 'Not streaming'
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
          <LiveView deviceId={device.id} />
        ) : (
          <div className="absolute inset-0 opacity-70" style={STRIPE} />
        )}
        {/*
          Three lines, serial first and number last (owner, 2026-09-04).
          The old two-line block put `#1 NAME` together on top with the serial
          under it, which buried the number inside the name's line and made
          two devices of the same model hard to tell apart at tile size. Read
          top-down it now goes from the identity the phone was born with, to
          the one an operator gave it, to the one they actually say out loud.
        */}
        <div className="pointer-events-none absolute inset-x-0 top-0 flex flex-col items-center gap-0.5 bg-gradient-to-b from-panel-a to-transparent px-1 pt-1.5 pb-3">
          <span className="max-w-full truncate font-mono text-tip text-faint">{device.serial}</span>
          <span className="max-w-full truncate text-[12px] font-medium text-text">{device.label}</span>
          {device.number != null && <span className="max-w-full truncate font-mono text-tip text-dim">#{device.number}</span>}
        </div>
        {!live && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <span className={cn('text-label', device.status === 'quarantined' ? 'text-warn' : 'text-faint-2')}>{idleLabelOf(device)}</span>
          </div>
        )}
        <StatusDot ring state={dotStateOf(device)} title={dotTooltipOf(device)} className="absolute bottom-1.5 left-1.5" />
      </div>
    </div>
  )
}
