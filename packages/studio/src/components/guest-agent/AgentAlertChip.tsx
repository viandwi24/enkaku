'use client'

import { TriangleAlert } from 'lucide-react'
import type { AgentState } from '@enkaku/protocol'
import { Popover, PopoverContent, PopoverTrigger, cn } from '@enkaku/ui'
import { AgentAlertDetail } from '@/components/guest-agent/AgentAlertDetail'

/**
 * A fleet-card/wall-tile chip for the guest agent's coarse state
 * (`DeviceInfo.agent`, plan 90 §4.7) — deliberately quiet for the common
 * case. `ready` and `absent` render nothing: a healthy or never-provisioned
 * agent is not news, and a farm of twenty phones must not grow twenty chips
 * for a state nobody needs to act on (plan 90 §5 step 90.6's own words).
 * Only `failed` and `outdated` — the two states an operator can actually do
 * something about — earn a chip; `provisioning` and `unsupported` stay
 * quiet too (a pass in flight resolves itself, and a floor is not
 * actionable).
 *
 * Reads the SAME narrow `DeviceInfo.agent` field `DeviceHeader`'s chip and
 * `AgentPanel`'s full detail both trace back to — no per-card fetch, which
 * is exactly why that field is a bare enum rather than the full
 * `AgentStatus` (its own doc comment in `packages/protocol/src/device.ts`).
 *
 * **The chip is a button now** (the owner's own ask: *"kalau ada agent
 * failed badge harusnya ada tombol cepat dong buat retry, terus kalau ada
 * error failed tampilkan juga errornya kenapa dong"*). It used to carry one
 * fixed `title` — "the guest agent could not be installed or reached" —
 * which is true of every possible cause and therefore told an operator
 * nothing and offered them nothing. It opens `AgentAlertDetail` instead: the
 * verbatim reason, how many attempts have failed and when, and a retry. A
 * hover `title` could never have held any of that; the reasons this farm
 * produces run to a full Java stack trace.
 *
 * What does NOT change: which states show a chip at all, and the fact that
 * nothing is fetched until an operator actually opens one. The reason lives
 * behind `GET /api/devices/:id/preparation`, fetched on demand by the panel
 * — see `AgentAlertDetail`'s own file header for that decision and its cost.
 */
export function AgentAlertChip({
  agent,
  deviceId,
  deviceLabel,
  className,
}: {
  agent: AgentState
  deviceId: string
  /** For the panel's own outcome sentences ("The guest agent is ready on moto g06 now."). */
  deviceLabel: string
  className?: string
}) {
  if (agent !== 'failed' && agent !== 'outdated') return null

  const label = agent === 'failed' ? 'Agent failed' : 'Agent outdated'
  const tone =
    agent === 'failed'
      ? 'text-led-danger border-led-danger/40 bg-led-danger/10 hover:bg-led-danger/20'
      : 'text-led-warn border-led-warn/35 bg-led-warn/10 hover:bg-led-warn/20'

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            'inline-flex cursor-pointer items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] leading-none font-medium transition-colors',
            tone,
            className,
          )}
          title={
            agent === 'failed'
              ? 'The guest agent could not be installed or reached — open for the reason, and a retry.'
              : 'A newer guest agent build is pinned — open for the detail, and an update.'
          }
        >
          <TriangleAlert className="size-2.5" aria-hidden />
          {label}
        </button>
      </PopoverTrigger>
      {/* `max-w-[calc(100vw-2rem)]` plus Radix's own collision handling: this
          chip renders on a fleet card at the right edge of the grid and in
          the device popup's meta row, and a fixed-width panel at either would
          hang off the window. The panel's own long text is `wrap-anywhere`
          and its stack trace scrolls inside itself, so nothing in here can
          push this box wider than the width set here.

          The height bound is Radix's OWN `--radix-popover-content-available-height`,
          not a `70vh` guess — measured against this trigger's actual position
          with `collisionPadding` already subtracted. A card in the third row
          of the fleet grid has barely 400 px of window below it, and a
          viewport-relative cap does not know that: with the stack trace open
          this panel's Retry button was cut off below the fold on the real
          farm before this line existed. */}
      <PopoverContent
        align="start"
        collisionPadding={12}
        className="max-h-(--radix-popover-content-available-height) w-[26rem] max-w-[calc(100vw-2rem)] overflow-y-auto"
      >
        <AgentAlertDetail deviceId={deviceId} deviceLabel={deviceLabel} fallbackState={agent} />
      </PopoverContent>
    </Popover>
  )
}
