'use client'

import { useEffect, useRef } from 'react'
import type { Ref } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { MoonStar, Play, ScreenShare } from 'lucide-react'
import { connectionBadge, type DeviceInfo, type JobInfo } from '@enkaku/protocol'
import { LiveView } from '@/components/LiveView'
import { AgentAlertChip } from '@/components/guest-agent/AgentAlertChip'
import { connectionTooltip } from '@/components/ConnectionBadge'
import { ReadinessControl } from '@/components/ReadinessControl'
import { TileChips } from '@/components/TileChips'
import { explainQuarantine } from '@/components/DeviceCard'
import { HolderBadge } from '@/components/HolderBadge'
import { tileIdentityOf, TILE_CONNECTION_ICON } from './tile-identity'
import { cn } from '@/lib/utils'

/**
 * How long a single click waits before it actually navigates (plan 91 §3.11,
 * F13). The browser fires `click` before `dblclick` — without a delay the
 * tile would already have navigated away by the time a second click could
 * ever be recognised as a double-click, so F13's "nothing to conflict with"
 * stops being true the moment something else DOES want the double-click.
 * 220ms sits comfortably under every OS's own double-click interval, so a
 * deliberate double-click is still caught, and a genuine single click still
 * lands on `/device?id=…` — just not synchronously inside the same tick.
 */
const DOUBLE_CLICK_WINDOW_MS = 220

/**
 * Mirrors `next/link`'s own `isModifiedEvent` (`linkClicked`,
 * `next/dist/client/link.js`) — a modified click (ctrl/cmd/shift/alt, or the
 * middle button) is the browser's own "open in a new tab" gesture and must
 * reach it untouched, not this tile's click/double-click disambiguation.
 */
function isModifiedClick(e: React.MouseEvent): boolean {
  return e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button === 1
}

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
 * Four screen states (Plan 92 §4.7, fixes F16's neighbour finding F12 —
 * `docs/design.md:49`'s "no unexplained blank tile" applies per-tile, not
 * only per-screen):
 *  - `live`: streaming, at the `wall` quality profile (or shared as-is at
 *    `control` quality if a colleague is already driving the device — the
 *    server decides that, never this component).
 *  - **budgeted** — eligible, awake, but outside `wall.maxTiles`: a quiet
 *    neutral screen area, the whole tile already the "Show live" target
 *    (`onClick` below), with a small glyph revealed on hover/focus like a
 *    live tile's own action overlay — never a persistent button. This is a
 *    wall-policy state, not a fact about the phone (Plan 92 §3.4's
 *    narrowing of plan 48 rule 3): a farm where most tiles are budgeted
 *    must not read as sixty alarms.
 *  - **asleep** — a screen-off placeholder (dimmed screen area, "Screen
 *    off") with a PERSISTENT Wake action (the overlay below, same as
 *    offline/quarantined): looking at the wall must never wake a phone
 *    nobody asked to wake (Plan 92 §3.2 rule 1, F12) — checked ahead of
 *    `live` on purpose, so an asleep device already in the live set still
 *    never mounts a decoder.
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
 *
 * Plan 91 §3.11/§5 step 91.8 (F11, F12, F13) adds three things, all living
 * on the SAME `next/link` root rather than a second wrapper:
 *  - **group selection** — a checkbox-shaped toggle in the header, the same
 *    `selectable`/`selected`/`onToggleSelect` shape `DeviceCard` already
 *    uses, so a `useBulkSelection` instance in the parent page drives both
 *    surfaces identically. `preventDefault`+`stopPropagation` on its own
 *    click, exactly like the existing "Show live" button below.
 *  - **a selected outline** — `border-accent`/`ring-accent`, `docs/design.md`'s
 *    "interactive" colour rather than a status LED colour, since selection
 *    is a UI interaction, not a device state.
 *  - **double-click to focus** (`?focus=`, §3.11) — `onDoubleClick` sets
 *    focus; single click still navigates, unchanged. The two coexist on one
 *    element only because `onClick` is rewritten to wait
 *    `DOUBLE_CLICK_WINDOW_MS` before navigating manually (`router.push`)
 *    instead of letting `Link`'s own synchronous `onClick` run — otherwise
 *    the FIRST click of a double-click would already have navigated away
 *    before `dblclick` could ever fire. The focused tile itself renders the
 *    "Controlling here" placeholder in place of its picture (stops
 *    decoding — the one decoder that matters moves to the focus overlay,
 *    91.9's own component, instead of doubling up).
 */
export function WallTile({
  device,
  runningJob,
  live,
  onShowLive,
  selectable = false,
  selected = false,
  onToggleSelect,
  focused = false,
  onFocus,
  rootRef,
}: {
  device: DeviceInfo
  runningJob?: JobInfo | null
  /** Within the live set (Plan 42 §4.6) — actually streams when true. */
  live: boolean
  /** Promote this tile into the live set, swapping out the least-recently-shown one. */
  onShowLive: () => void
  /**
   * Group selection (plan 91 §3.11/§5 step 91.8, F11/F12) — mirrors
   * `DeviceCard`'s own `selectable`/`selected`/`onToggleSelect` shape so the
   * two surfaces behave identically off one shared `useBulkSelection`.
   */
  selectable?: boolean
  selected?: boolean
  onToggleSelect?: () => void
  /**
   * This is the tile named by `?focus=` (plan 91 §3.11) — swaps the live
   * picture for the "Controlling here" placeholder. The focus overlay
   * itself is 91.9's own component; this step only owns the placeholder and
   * the URL it reads from.
   */
  focused?: boolean
  /** Double-click opens the focus overlay (plan 91 §3.11, F13). */
  onFocus?: () => void
  /**
   * The live-set policy's own viewport hook (plan 92 §4.6, `useLiveSet`'s
   * `tileRef`) — forwarded straight onto the tile's root `Link`, the only
   * DOM node this component owns, rather than wrapping it in a second
   * element just to have somewhere to attach a ref. `next/link`'s `Link`
   * already forwards `ref` to the underlying `<a>`.
   */
  rootRef?: Ref<HTMLAnchorElement>
}) {
  const router = useRouter()
  const clickTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (clickTimer.current) clearTimeout(clickTimer.current)
    },
    [],
  )

  const offline = device.status === 'offline'
  const quarantined = device.status === 'quarantined'
  const asleep = device.readiness.actual === 'asleep'
  // A device CONDITION, not a wall-policy state (Plan 92 §3.2 rule 1, §3.4):
  // offline, quarantined, and now asleep — plan 42 §4.6 extended, because
  // there is no way to stream a device without waking it (F11), so "stream
  // every eligible device" and "do not wake the farm" cannot both be true.
  const blocked = offline || quarantined || asleep
  const href = `/device?id=${encodeURIComponent(device.id)}`
  // The plans-88/89 fields, behind one adapter (plan 92 §4.8, H4).
  const identity = tileIdentityOf(device)
  const ConnectionIcon = TILE_CONNECTION_ICON[connectionBadge(identity.connection)]

  // The bottom action overlay (Wake/Sleep) is shown PERSISTENTLY only for a
  // device condition — plan 48 §3.3 rule 3, narrowed by plan 92 §3.4 to
  // exclude "budgeted" (outside `wall.maxTiles`), which is a wall-policy
  // state, not a fact about the phone: a live tile and a budgeted tile both
  // reveal it on hover/focus instead. `ReadinessControl` already disables
  // itself with an explanatory tooltip for offline/quarantined devices, so
  // showing it persistently there is a real, working affordance rather than
  // a dead control; for asleep it is the one working Wake action available.
  const revealOnHover = !blocked && !focused
  const showCaption = device.status === 'busy' && !!runningJob?.scriptName
  // "node 2/4" (plan 99 §4.9, §4.11, step 99.10) — from `job.status`'s own
  // `node` block. `JobInfo` (`runningJob`'s declared type) carries no such
  // field; it only ever arrives on a row a live WS push has touched, read
  // defensively rather than declared as a wider prop type for that reason
  // (the same pattern `JobsList.tsx`'s own `liveNode` establishes).
  const node = (runningJob as (JobInfo & { node?: { seq: number; total: number } | null }) | null | undefined)?.node ?? null

  const handleClick = (e: React.MouseEvent) => {
    if (isModifiedClick(e)) return
    e.preventDefault()
    if (clickTimer.current) return
    clickTimer.current = setTimeout(() => {
      clickTimer.current = null
      router.push(href)
    }, DOUBLE_CLICK_WINDOW_MS)
  }

  const handleDoubleClick = (e: React.MouseEvent) => {
    if (isModifiedClick(e) || !onFocus) return
    e.preventDefault()
    if (clickTimer.current) {
      clearTimeout(clickTimer.current)
      clickTimer.current = null
    }
    onFocus()
  }

  return (
    <Link
      ref={rootRef}
      href={href}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
      className={cn(
        // `@container` (plan 92 §4.8): establishes THIS tile's own box as
        // the query context `TileChips`' drop order reads from, so a drop
        // reflects the tile's real width, not the viewport's — the reason
        // the whole grid drops in lockstep (every tile in an `auto-fill
        // minmax` grid shares one width) rather than tile-by-tile.
        'group relative flex min-w-0 flex-col overflow-hidden rounded-lg border bg-surface transition-colors @container',
        offline ? 'opacity-60' : 'hover:border-line-strong',
        selected && 'border-accent ring-1 ring-accent',
      )}
    >
      <div className="flex min-w-0 flex-col gap-1 px-2 py-1.5">
        <div className="flex min-w-0 items-center gap-1.5">
          {/* The tile's own root is a `next/link` (see the file header) —
              `preventDefault` on the label's click below cancels the
              checkbox's own native toggle too (one Event, one set of
              default actions), so `onToggleSelect` is called directly
              rather than relying on `onChange`, which would never fire once
              that default is cancelled. */}
          {selectable && (
            <label
              className="flex size-4 shrink-0 cursor-pointer items-center justify-center rounded border border-line-strong bg-surface"
              onClick={(e) => {
                e.preventDefault()
                e.stopPropagation()
                onToggleSelect?.()
              }}
            >
              <input
                type="checkbox"
                checked={selected}
                onChange={() => {}}
                aria-label={`Select ${device.label} for a batch action`}
                className="pointer-events-none size-3"
              />
            </label>
          )}
          {/* Line 1 — number · label · connection glyph (plan 92 §4.8, plan
              89 §3.3). A fixed-width slot so a tile's height and the
              label's start-x never move as numbers grow into three digits;
              `null` (a released reservation, §3.2) renders a dash rather
              than a fake `#0`. None of the three ever drops under a narrow
              container — only the chip row below does. */}
          <span className="readout w-8 shrink-0 text-right text-[10px] text-fg-subtle" aria-hidden="true">
            {identity.number !== null ? `#${identity.number}` : '—'}
          </span>
          <span className="truncate text-[11.5px] font-medium leading-tight">{device.label}</span>
          {/* A glyph, not a badge (§4.8): the *kind* of connection is what
              gets scanned down a column of tiles, and one lucide icon does
              that in a fraction of the width a text badge (`ConnectionBadge`,
              used by `DeviceCard` where there is room) would cost here. The
              IP itself is deliberately NOT here — it is the glyph's
              accessible name/tooltip, searchable, and filterable instead
              (`page.tsx`). */}
          <span className="ml-auto shrink-0" title={connectionTooltip(identity.connection)}>
            <ConnectionIcon className="size-3 text-fg-subtle" aria-hidden />
            <span className="sr-only">{connectionTooltip(identity.connection)}</span>
          </span>
        </div>
        <TileChips device={device} />
        {/* Plan 90 §5 step 90.6 — quiet for `ready`/`absent`; a farm of 20 healthy phones must not grow 20 chips (F10). */}
        <AgentAlertChip agent={device.agent ?? 'absent'} />
      </div>

      <div className="relative aspect-[9/16] w-full overflow-hidden bg-black">
        {focused ? (
          // The "Controlling here" placeholder (plan 91 §3.11) — the
          // picture itself moved to the focus overlay (91.9), so this tile
          // deliberately stops decoding rather than running a second
          // decoder for the same device.
          <div className="flex size-full flex-col items-center justify-center gap-1.5 px-3 text-center text-[11px] text-fg-subtle">
            <ScreenShare className="size-4 text-accent-strong" aria-hidden />
            <span className="text-fg-muted">Controlling here</span>
          </div>
        ) : offline ? (
          <div className="flex size-full flex-col items-center justify-center gap-1 px-3 text-center text-[11px] text-fg-subtle">
            <span>Offline</span>
          </div>
        ) : quarantined ? (
          <div className="flex size-full flex-col items-center justify-center gap-1 px-3 text-center text-[11px] text-fg-subtle">
            <span className="text-led-danger">
              {device.quarantineReason ? explainQuarantine(device.quarantineReason) : 'Quarantined'}
            </span>
          </div>
        ) : asleep ? (
          // The screen-off placeholder (Plan 92 §3.2 rule 1, §4.7, fixes
          // F12): checked BEFORE `live` so an asleep device that is still
          // (incorrectly, or before Plan 92's live-set policy lands in
          // 92.4) sitting in the live set never mounts `LiveView` — the
          // wall shows the farm, it does not change the farm by being
          // opened. The identity block above (label, chips) stays fully
          // legible; only the screen area itself is dimmed.
          <div className="flex size-full flex-col items-center justify-center gap-1.5 px-3 text-center text-[11px] text-fg-subtle">
            <MoonStar className="size-4" aria-hidden />
            <span>Screen off</span>
          </div>
        ) : live ? (
          <LiveView deviceId={device.id} inputEnabled={false} quality="wall" compact />
        ) : (
          // Budgeted (outside `wall.maxTiles`): a quiet neutral screen area
          // — the whole tile is already the "Show live" target via the
          // root `Link`'s own click handler, so this button only supplies
          // the glyph, revealed on hover/focus like a live tile's own
          // overlay rather than shown persistently (Plan 92 §3.4's
          // narrowing of plan 48 rule 3 — being paged out is a wall-policy
          // state, not a device condition, and a farm of mostly-budgeted
          // tiles must not read as a wall of alarms).
          <button
            type="button"
            onClick={(e) => {
              e.preventDefault()
              e.stopPropagation()
              onShowLive()
            }}
            className={cn(
              'flex size-full flex-col items-center justify-center gap-1.5 text-[11px] text-fg-subtle transition-opacity',
              'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 hover-none:opacity-100',
            )}
          >
            <Play className="size-4" aria-hidden />
            Show live
          </button>
        )}

        {/* Who holds (and who assists) this device — moved OFF the header
            and onto the picture (plan 92 §4.8, fixes F31): a third header
            line appeared only while someone was driving the device, which
            reflowed the whole grid the moment a colleague took control.
            Plan 48 §3.2's own reasoning applies exactly: who is driving is
            about the picture, so it belongs on the picture, with the same
            scrim treatment the running-job caption below uses. Placed AFTER
            the picture content above (same reason the caption/action
            overlays below are too — a later sibling paints on top of an
            earlier one within the positioned layer, without needing a
            `z-index`), so it is never hidden behind `LiveView`'s own canvas. */}
        {(device.heldBy || (device.assistedBy ?? []).length > 0) && (
          <div className="pointer-events-none absolute inset-x-0 top-0 flex flex-col items-start gap-1 p-1.5">
            {/* `asLink={false}` (plan 91 §3.4 item 4 gap 3): this tile's own
                root IS a `next/link` already, so a `job`/`agent` holder
                renders as a plain, non-interactive span here rather than a
                second, nested `<Link>` — invalid HTML. */}
            {device.heldBy && (
              <span className="max-w-full truncate rounded bg-black/60 p-0.5">
                <HolderBadge holder={device.heldBy} className="w-fit" asLink={false} />
              </span>
            )}
            {/* Who is ASSISTING this device (plan 91 §3.4 item 4, §4.4, F25)
                — a narrow, subordinate grant beside `heldBy` above, never a
                takeover. `?? []` covers a caller that predates the field,
                the same guard `DeviceCard` uses. */}
            {(device.assistedBy ?? []).map((a) => (
              <span key={a.id} className="max-w-full truncate rounded bg-black/60 p-0.5">
                <HolderBadge holder={a} variant="assists" className="w-fit" asLink={false} />
              </span>
            ))}
          </div>
        )}

        {/* Caption strip, laid OVER the picture rather than a border-t
            footer beneath it (plan 48 §3.1). The wrapper itself takes no
            pointer events so it never blocks clicks on the video. */}
        {showCaption && (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 p-1.5">
            <span className="readout truncate rounded bg-black/60 px-1.5 py-0.5 text-[10px] text-fg-muted">
              {runningJob?.scriptName}
              {node && ` · node ${node.seq + 1}/${node.total}`}
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
              revealOnHover
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
                : // A device condition (rule 3, narrowed by plan 92 §3.4):
                  // offline, quarantined, asleep — shown persistently.
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
