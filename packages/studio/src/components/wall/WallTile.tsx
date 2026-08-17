'use client'

import { useEffect, useRef } from 'react'
import type { Ref } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { MoonStar, Play, ScreenShare } from 'lucide-react'
import type { DeviceInfo, JobInfo } from '@enkaku/protocol'
import { LiveView } from '@/components/LiveView'
import { explainQuarantine } from '@/components/DeviceCard'
import { HolderBadge } from '@/components/HolderBadge'
import { cn } from '@enkaku/ui'

/**
 * How long a single click waits before it commits (plan 91 §3.11, F13). The
 * browser fires `click` before `dblclick` — without a delay the tile would
 * already have acted on the single click by the time a second click could
 * ever be recognised as a double-click, so F13's "nothing to conflict with"
 * stops being true the moment something else DOES want the double-click.
 * 220ms sits comfortably under every OS's own double-click interval, so a
 * deliberate double-click is still caught, and a genuine single click still
 * commits — just not synchronously inside the same tick.
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
 * One tile on the fleet Wall. Plan 101.7 (owner-specified, 2026-08-16)
 * rebuilt this component around one rule: **the tile shows the screencast
 * and nothing else.** Everything that used to sit in a header block above
 * the picture — the number, the label, the connection glyph, `TileChips`
 * (battery/temperature/readiness/status), `AgentAlertChip` — is gone. What
 * is left:
 *
 *  - the picture itself (`LiveView` at the `wall` quality profile, or one of
 *    the placeholder states below when there is no picture to show);
 *  - the device's name, floated over a scrim at the top of the picture,
 *    horizontally centred (§3.6 there — matches `refs/ui`'s own tile
 *    exactly: a scrim over the top 36%, the name at `top: 8px`, centred);
 *  - `.status-rail`, kept deliberately (the plan's own words: it "carries no
 *    text and costs no layout," and without it a device that is streaming
 *    fine but quarantined — or holding a failed guest agent — would be
 *    indistinguishable from a healthy one). It is now ALSO the guest-agent
 *    alert's new home: `AgentAlertChip` used to flag `failed`/`outdated`
 *    with a chip; that signal is folded into the rail's colour instead of
 *    being dropped, so a tile that looks fine is not silently lying about a
 *    broken agent. See the rail's own `data-agent-alert` below.
 *
 * Two things plan 89/92 gave this tile are deliberately NOT carried onto the
 * new, minimal picture: the per-device number (composed beside the label so
 * renaming a device could never destroy it) and the connection glyph. Both
 * still exist — `DeviceCard`'s own header, unchanged by this step — but the
 * Wall tile itself no longer shows either. Reported, not silently dropped:
 * see plan 101 §5 step 101.7's own note and this repo's step-101.7 report.
 *
 * Plan 101 §5 step 101.8 (owner-specified, 2026-08-16, side-by-side against
 * `refs/ui`): the tile ALSO lost the persistent `ReadinessControl` (Wake/
 * Sleep) overlay it still carried after 101.7 — the last piece of chrome on
 * the tile face beyond the picture and the floated name. `refs/ui`'s own
 * tile has nothing on it but the picture, the centred name, and (when the
 * picture is empty) a centred watermark; a persistent Wake button on every
 * asleep tile was exactly the kind of per-device chrome that rule rules out.
 * The affordance did not disappear: right-clicking a tile (or a selection)
 * opens the SAME context menu (`DeviceContextMenu`, plan 101 §5 step 101.5)
 * with "Wake selected"/"Sleep selected", and the floating selection bar
 * (`app/page.tsx`) carries the identical buttons — both already routed
 * through `wakeOrSleepSelected` before this step, so removing the on-tile
 * control cost no functionality, only the chrome duplicating it.
 *
 * Four screen states (Plan 92 §4.7):
 *  - `live`: streaming, at the `wall` quality profile (or shared as-is at
 *    `control` quality if a colleague is already driving the device — the
 *    server decides that, never this component).
 *  - **budgeted** — eligible, awake, but outside `wall.maxTiles`: a quiet
 *    neutral screen area, the whole tile already the "Show live" target
 *    (`onClick` below), with a small "Show live" glyph revealed on
 *    hover/focus.
 *  - **asleep** — a screen-off placeholder; waking it is reached through the
 *    context menu or the selection bar, not a button on the tile (see above).
 *  - offline / quarantined: a static picture with the reason, never a blank
 *    rectangle.
 *
 * The whole tile is a `next/link` — a plain `<a>` would remount everything
 * on click and kill the WS. Tiles are read-only: `LiveView` is given
 * `inputEnabled={false}` unconditionally, and the server refuses input
 * without a lease regardless. `href` still points at `/device?id=…` so
 * keyboard activation (Enter), screen readers, and a modified click
 * (ctrl/cmd/middle-click — "open in a new tab") all keep working exactly as
 * a link should; only the PLAIN single click is repurposed, below.
 *
 * Plan 101 §5 step 101.7's second owner note (2026-08-16, folded in mid-step
 * — see the git history for the exact wording): **no checkbox anywhere.** A
 * plain click on the tile now toggles selection directly — `refs/ui`'s own
 * model (`handleDeviceMouseDown` selects, `handleDeviceDoubleClick` opens
 * the remote-control modal) — instead of navigating. Double-click still
 * opens the device popup (plan 91 §3.11; plan 103's `DevicePopup.tsx`),
 * which already carries its own "open the full device page" row, so the
 * page this tile used to jump to in one click is still one MORE click away
 * rather than gone. `Wall.tsx` is this component's only caller and always supplies
 * `onToggleSelect`, so in practice a click always selects now; `onToggleSelect`
 * stays optional here (rather than required) only so a click still falls
 * back to navigating if some future caller genuinely has no selection
 * concept — never silently do nothing.
 */
export function WallTile({
  device,
  runningJob,
  live,
  onShowLive,
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
  /** A tint + accent border (`refs/ui`'s own rule: selection is the card's own background/border, never a badge) — never a checkbox, since plan 101 §5 step 101.7 removed the last one. */
  selected?: boolean
  /**
   * Click-to-toggle (plan 101 §5 step 101.7, folded in mid-step) — when
   * provided, a plain click calls this INSTEAD of navigating; when absent, a
   * plain click falls back to `router.push(href)` (see the file header).
   * `Wall.tsx` always provides it today.
   */
  onToggleSelect?: () => void
  /**
   * This is the tile named by `?focus=` (plan 91 §3.11) — swaps the live
   * picture for the "Controlling here" placeholder. The focus overlay
   * itself is 91.9's own component; this step only owns the placeholder and
   * the URL it reads from.
   */
  focused?: boolean
  /** Double-click opens the focus overlay (plan 91 §3.11, F13) — this tile's own equivalent of `refs/ui`'s "double-click opens remote control." */
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
  const href = `/device?id=${encodeURIComponent(device.id)}`

  // Plan 101 §5 step 101.7's own note: `AgentAlertChip` left this tile, but
  // the fact it flagged — an agent that failed, or one pinned to an outdated
  // build — must not vanish along with it, or a device casting a perfectly
  // good picture with a genuinely broken agent would read as healthy. Quiet
  // for the exact same states the chip was quiet for (ready/absent/
  // provisioning/unsupported — plan 90 §5 step 90.6, F10); tinted only for
  // `failed`/`outdated`, and only when the device's own status is not
  // already showing offline/quarantined — the rail's two loudest colours
  // already say "something is wrong here," and there is nothing useful an
  // operator can do about the agent on a device that is not even connected.
  // Plan 106 §5 step 106.4 confirmed this still holds after the guest agent
  // migrated onto the preparation registry (step 106.5): `device.agent` is
  // now DERIVED from `devices.preparation['guest-agent']`
  // (`deriveAgentState`, `registry/device-registry.ts`) instead of the old
  // standalone column, but the wire shape and the six `AgentState` values
  // are unchanged, so this tile needed no edit at all — the rail already
  // "folds into the existing signal" the step asked for. What this signal
  // does NOT cover, named rather than silently assumed complete: any OTHER
  // registered preparation component (`ui-server` today, whatever is added
  // next) has no equivalent on `DeviceInfo` at all, so a tile cannot flag
  // "ui-server failed" without a per-device fetch per tile — the exact
  // fan-out plan 100/F27 already paid down once. Extending this rail to
  // every component needs a compact, precomputed summary field riding
  // `DeviceInfo`'s own broadcast (core work, out of this pass's
  // `packages/studio`-only scope) — reported in plan 106's own status
  // line, the same gap plan 107 step 107.4 already found and named for its
  // own operation tray, rather than approximated with a per-tile fetch.
  const agentState = device.agent ?? 'absent'
  const agentAlert = agentState === 'failed' || agentState === 'outdated' ? agentState : null
  const showAgentAlertOnRail = agentAlert !== null && !offline && !quarantined

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
      // Toggle selection instead of navigating (plan 101 §5 step 101.7,
      // folded in mid-step) — `onToggleSelect?.()` is the real behaviour
      // today (`Wall.tsx` always supplies it); the `router.push` fallback
      // only covers a caller with no selection concept at all, so a click
      // never silently does nothing.
      if (onToggleSelect) onToggleSelect()
      else router.push(href)
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
        // `select-none` on the whole tile, not just while dragging.
        //
        // `refs/ui` only suppresses selection mid-drag (`userSelect:
        // dragSelecting ? 'none' : 'auto'`) because its tiles have no
        // double-click. Ours do — double-click opens the focus overlay
        // (plan 91 §3.11) — and a double-click IS the browser's
        // select-a-word gesture, so every time an operator opened remote
        // control the device name lit up highlighted behind the overlay.
        // Click-to-toggle (plan 101 §5 step 101.7) made it worse: a click
        // with a few pixels of travel drag-selects the label.
        //
        // Nothing is lost. This tile carries no copyable identifier — the
        // serial and stable id live on the device page's header, which has
        // its own explicit Copy button rather than relying on the operator
        // dragging across text.
        'group relative flex min-w-0 select-none overflow-hidden rounded-lg border bg-surface transition-colors',
        offline ? 'opacity-60' : 'hover:border-line-strong',
        selected && 'border-accent ring-1 ring-accent',
      )}
    >
      {/* `.status-rail` — the one thing plan 101.7 keeps, and now the
          tile's only ambient status signal now that the header/chips/agent
          chip are gone (`docs/design.md`'s "signature element"). Spans the
          tile's full height since the tile no longer has a separate header
          block to exclude. */}
      <span
        className="status-rail"
        data-status={device.status}
        data-live={device.status === 'busy' ? 'true' : 'false'}
        data-agent-alert={showAgentAlertOnRail ? agentAlert : undefined}
        aria-hidden
      />

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
          // opened.
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

        {/* The scrim + centred name (plan 101 §5 step 101.7, requirement 2)
            — `refs/ui`'s own tile exactly: a scrim over the top 36%
            (`linear-gradient(to bottom, rgba(0,0,0,0.55), transparent)`),
            the name at `top: 8px`, horizontally centred. Built from the
            same `black`/`white` opacity vocabulary the holder badges and
            caption strip below already use over video, never a hex literal
            — this is a scrim over arbitrary video pixels, not a themed
            surface, so it deliberately does not use a `--color-*` token the
            way a themed panel would. */}
        <div className="pointer-events-none absolute inset-x-0 top-0 h-[36%] bg-linear-to-b from-black/55 to-transparent" />
        <span className="pointer-events-none absolute inset-x-0 top-2 truncate px-2 text-center text-[12.5px] font-semibold text-white/90">
          {device.label}
        </span>

        {/* Who holds (and who assists) this device — plan 92 §4.8, fixes
            F31. */}
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
                the same guard `DeviceCard` uses. Plan 105 §3.2/§4: the
                "assisting" vs "may assist" split is computed inside
                `HolderBadge` (`deriveAssistActivity`), never here — this
                tile has no per-client control state of its own (F11: input
                is unconditionally off), so it has nothing to feed the full
                `useControlState` hook that `DevicePopup` reads; it shares
                only the activity-derivation logic, via the badge. */}
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

      </div>
    </Link>
  )
}
