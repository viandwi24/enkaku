'use client'

import Link from 'next/link'
import { Play } from 'lucide-react'
import type { DeviceInfo, JobInfo } from '@enkaku/protocol'
import { LiveView } from '@/components/LiveView'
import { ReadinessControl } from '@/components/ReadinessControl'
import { TileChips } from '@/components/TileChips'
import { explainQuarantine } from '@/components/DeviceCard'
import { HolderBadge } from '@/components/HolderBadge'
import { cn } from '@/lib/utils'

/**
 * One tile on the fleet Wall (Plan 42 §3.5, §4.6): a small, read-only
 * `LiveView` at the `wall` quality profile — the SAME video stream and
 * decode path as the device page, never a new transport — plus label,
 * a chip row (battery, temperature, readiness, status — plan 48 §3.2), and
 * an actions overlay on the screen itself rather than a permanent footer
 * (plan 48 §3.1, §4.1): one chrome block instead of two, so more of the
 * tile is the actual picture. The overlay is horizontally centred at the
 * bottom edge (plan 49 §3.3/§4.3), not tucked into a corner, and a busy
 * tile's running-job caption keeps its own strip, so the two no longer
 * compete for one slot.
 *
 * Three screen states:
 *  - `live`: streaming, at the `wall` quality profile (or shared as-is at
 *    `control` quality if a colleague is already driving the device — the
 *    server decides that, never this component).
 *  - eligible but paged out (beyond `wall.maxTiles`): a placeholder with a
 *    "Show live" action that swaps it into the live set.
 *  - offline / quarantined: a static card with the reason, never a blank
 *    rectangle (acceptance #13).
 *
 * The whole tile is a `next/link` — a plain `<a>` would remount everything
 * on click and kill the WS (Plan 42 §4.6). Tiles are read-only: `LiveView`
 * is given `inputEnabled={false}` unconditionally, and the server refuses
 * input without a lease regardless.
 *
 * The actions overlay (Wake/Sleep) is revealed on hover AND keyboard focus,
 * always visible on coarse pointers, and always visible on any tile with no
 * live picture to protect — plan 48 §3.3, all three required. It is built
 * with `opacity`/`pointer-events`, never conditional rendering, so a control
 * that has not (yet) faded in can still receive keyboard focus.
 */
export function WallTile({
  device,
  runningJob,
  live,
  onShowLive,
}: {
  device: DeviceInfo
  runningJob?: JobInfo | null
  /** Within the live set (Plan 42 §4.6) — actually streams when true. */
  live: boolean
  /** Promote this tile into the live set, swapping out the least-recently-shown one. */
  onShowLive: () => void
}) {
  const offline = device.status === 'offline'
  const quarantined = device.status === 'quarantined'
  const eligible = !offline && !quarantined
  const asleep = device.readiness.actual === 'asleep'

  // No picture worth protecting: not streaming (offline/quarantined/paged
  // out beyond the cap) or asleep (the screen would be black regardless).
  // These tiles show their action persistently instead of on hover — plan
  // 48 §3.3 rule 3, acceptance #6. `ReadinessControl` already disables
  // itself with an explanatory tooltip for offline/quarantined devices
  // (it always has), so showing it persistently there is a real, working
  // affordance rather than a dead control.
  const hasPicture = eligible && live && !asleep
  const showCaption = device.status === 'busy' && !!runningJob?.scriptName

  return (
    <Link
      href={`/device?id=${encodeURIComponent(device.id)}`}
      className={cn(
        'group relative flex min-w-0 flex-col overflow-hidden rounded-lg border bg-surface transition-colors',
        offline ? 'opacity-60' : 'hover:border-line-strong',
      )}
    >
      <div className="flex min-w-0 flex-col gap-1 px-2 py-1.5">
        <span className="truncate text-[11.5px] font-medium leading-tight">{device.label}</span>
        <TileChips device={device} />
        {/* Server-published, live (plan 71 §3.2, §3.8) — replaces `lib/agent-holders.ts`'s 15s poll. */}
        {device.heldBy && (
          <div onClick={(e) => e.stopPropagation()}>
            <HolderBadge holder={device.heldBy} className="w-fit" />
          </div>
        )}
      </div>

      <div className="relative aspect-[9/16] w-full overflow-hidden bg-black">
        {eligible && live ? (
          <LiveView deviceId={device.id} inputEnabled={false} quality="wall" compact />
        ) : eligible ? (
          <button
            type="button"
            onClick={(e) => {
              e.preventDefault()
              e.stopPropagation()
              onShowLive()
            }}
            className="flex size-full flex-col items-center justify-center gap-1.5 text-[11px] text-fg-subtle hover:text-fg-muted"
          >
            <Play className="size-4" aria-hidden />
            Show live
          </button>
        ) : (
          <div className="flex size-full flex-col items-center justify-center gap-1 px-3 text-center text-[11px] text-fg-subtle">
            {offline ? (
              <span>Offline</span>
            ) : (
              <span className="text-led-danger">
                {device.quarantineReason ? explainQuarantine(device.quarantineReason) : 'Quarantined'}
              </span>
            )}
          </div>
        )}

        {/* Caption strip, laid OVER the picture rather than a border-t
            footer beneath it (plan 48 §3.1). The wrapper itself takes no
            pointer events so it never blocks clicks on the video. */}
        {showCaption && (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 p-1.5">
            <span className="readout truncate rounded bg-black/60 px-1.5 py-0.5 text-[10px] text-fg-muted">
              {runningJob?.scriptName}
            </span>
          </div>
        )}

        {/* Action overlay, floated at the bottom and horizontally centred
            (plan 49 §3.3/§4.3, adjusted live per operator feedback: centred
            in the middle of the tile covered too much of the picture, so it
            stays anchored to the bottom edge like the caption, just centred
            instead of tucked into the corner). It is its own absolute layer
            rather than sharing the caption's flex row, so a busy tile still
            shows both — the caption's own strip is unaffected. The wrapper
            itself takes no pointer events; the control re-enables them only
            where it actually needs to. */}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center p-1.5">
          <div
            className={cn(
              'shrink-0 rounded-md bg-black/70 p-1 backdrop-blur-sm transition-opacity',
              hasPicture
                ? // Hidden until hover or keyboard focus reaches the tile
                  // (plan 48 §3.3 rule 1), except on coarse pointers, which
                  // get it permanently (rule 2). Opacity/pointer-events
                  // only — never unmount, or focus could never land here.
                  cn(
                    'pointer-events-none opacity-0',
                    'group-hover:pointer-events-auto group-hover:opacity-100',
                    'group-focus-within:pointer-events-auto group-focus-within:opacity-100',
                    'hover-none:pointer-events-auto hover-none:opacity-100',
                  )
                : // No live picture to protect (rule 3): shown persistently.
                  'pointer-events-auto opacity-100',
            )}
          >
            <ReadinessControl device={device} className="h-5 gap-1 px-1.5 py-0 text-[10px] [&_svg]:size-2.5" />
          </div>
        </div>
      </div>
    </Link>
  )
}
