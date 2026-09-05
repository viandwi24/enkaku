import type { CSSProperties } from 'react'
import type { DeviceInfo } from '@enkaku/protocol'
import { Spinner, StatusDot, cn } from '@enkaku/ui'
import { LiveView } from '@/components/LiveView'
import { AgentAlertChip } from '@/components/guest-agent/AgentAlertChip'
import { dotStateOf, dotTooltipOf, reconnectingAttempt } from './device-state'

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
  onContextMenu,
}: {
  device: DeviceInfo
  selected: boolean
  live: boolean
  tileRef: (node: Element | null) => void
  onMouseDown: (e: React.MouseEvent) => void
  onDoubleClick: () => void
  onContextMenu: (e: React.MouseEvent) => void
}) {
  // A device the farm is actively rebuilding a session for reads as
  // "Reconnecting", not as an ordinary dead tile — see `reconnectingAttempt`.
  const reconnecting = reconnectingAttempt(device)

  return (
    <div
      data-device-id={device.id}
      ref={tileRef}
      onMouseDown={onMouseDown}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
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
          Three lines, and the NUMBER is the big one (owner, 2026-09-04).

          The old block put `#1 NAME` together on top with the serial beneath,
          which buried the number inside the name's line — at tile size, on a
          wall of the same phone model, the number is the only thing an
          operator actually reads. So it carries the weight, and the two
          identities above it (the one the phone was born with, then the one
          someone gave it) stay quiet.

          No `#`: with the number set this large the sigil is noise, and the
          monospace figures are already unmistakably a number. `formatDeviceName`
          still writes `#N` everywhere a number appears INSIDE running text,
          where it is doing real work — this is the one place the number
          stands alone.
        */}
        <div className="pointer-events-none absolute inset-x-0 top-0 flex flex-col items-center gap-0.5 bg-gradient-to-b from-panel-a to-transparent px-1 pt-1.5 pb-3">
          <span className="max-w-full truncate font-mono text-tip text-faint">{device.serial}</span>
          <span className="max-w-full truncate text-[11px] text-dim">{device.label}</span>
          {device.number != null && (
            <span className="max-w-full truncate font-mono text-[19px] font-semibold leading-none text-text">{device.number}</span>
          )}
        </div>
        {!live && (
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-1.5">
            {reconnecting !== null ? (
              <>
                <Spinner className="size-4 text-accent" />
                <span className="text-label text-accent">{reconnecting > 0 ? `Reconnecting · ${reconnecting}` : 'Connecting'}</span>
              </>
            ) : (
              <span className={cn('text-label', device.status === 'quarantined' ? 'text-warn' : 'text-faint-2')}>{idleLabelOf(device)}</span>
            )}
          </div>
        )}
        <StatusDot ring state={dotStateOf(device)} title={dotTooltipOf(device)} className="absolute bottom-1.5 left-1.5" />
        {/*
          The guest agent alert, back on a tile.
          
          `AgentAlertChip` renders nothing unless the agent is `failed`,
          `outdated` or `consent-required`, and it carries the only Update
          button in Studio. It used to live on `WallTile.tsx`, which plan 214
          replaced with this card — and it was never re-mounted, so from that
          plan until now a phone running an obsolete agent said so nowhere and
          offered nothing (found 2026-09-04, chasing why a farm was still on
          the pre-`ui-tree` build).
        */}
        <AgentAlertChip
          agent={device.agent}
          deviceId={device.id}
          deviceLabel={device.label}
          deviceNumber={device.number}
          className="absolute right-1.5 bottom-1.5"
        />
      </div>
    </div>
  )
}
