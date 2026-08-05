'use client'

import { MonitorPlay, ScanSearch } from 'lucide-react'
import { LiveView } from '@/components/LiveView'
import { InspectorPanel } from '@/components/InspectorPanel'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

export type ScreenMode = 'live' | 'inspect'

/**
 * The screen and its modes (plan 57 §3.1, §4.2).
 *
 * `Inspect` used to be a top-level tab, so inspecting meant leaving the live
 * screen, looking at a still of it, and coming back. The two things it puts
 * side by side — a picture and a tree — are *about* the screen you just
 * navigated away from. So it is a mode of this card instead, switched where
 * the screen already is.
 *
 * The snapshot the inspector shows stays frozen, and that is not a compromise
 * (§3.1): the tree and the picture must come from the same instant, or a
 * node's highlight lands on whatever has scrolled into that rectangle since.
 *
 * **Both panels stay mounted and are merely hidden** (plan 42 §3.1, plan 59
 * §3.3, §4.2). For the video that has always been true: the decoder, the frame
 * subscription and the WS stream registration go down with an unmount, and
 * coming back replays the whole wake sequence.
 *
 * The inspector used to be the exception — mounted on demand, because an
 * attached inspector holds an on-device engine (`instrumentation` lock, an
 * `adb.maxConcurrent` slot) and plan 56 §3.2 did not want that running for a
 * panel nobody was looking at. The gap in that reasoning is that the inspector
 * requires a *manual lease*, and a manual lease has already made the device
 * exclusively one operator's: the scheduler will not pick it and nobody else
 * can take it. So the engine was never being held *from* anyone — while every
 * `Live ⇄ Inspect` flip paid a full cold start. The attachment now follows the
 * lease instead of the mode, inside `InspectorPanel`; releasing control still
 * detaches, which is what plan 56's acceptance #8 was actually protecting.
 */
export function ScreenCard({
  deviceId,
  mode,
  onModeChange,
  inspectDisabledReason,
  jobRunning,
  inputEnabled,
  canInspect,
  onTakeControl,
  takeControlDisabledReason,
  onActivity,
  autoReconnect,
  visible,
}: {
  deviceId: string
  mode: ScreenMode
  onModeChange: (mode: ScreenMode) => void
  /** Why `Inspect` cannot be used here — an agent-owned device has no local inspector (plan 56 §2). */
  inspectDisabledReason?: string
  jobRunning: boolean
  inputEnabled: boolean
  /** The manual lease the inspector needs (plan 56 §3.7) — the same server-published fact the other panels read. */
  canInspect: boolean
  /** Offered by the inspector itself while control is missing (plan 59 §3.1). */
  onTakeControl: () => void
  /** Why control cannot be taken right now, if it cannot. */
  takeControlDisabledReason?: string
  onActivity: () => void
  autoReconnect: boolean
  /** Whether the Control tab itself is the one on screen — the video asks for a fresh keyframe when this or the mode brings it back into view. */
  visible: boolean
}) {
  const liveVisible = mode === 'live'
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <div className="inline-flex rounded-md border bg-surface p-0.5" role="group" aria-label="Screen mode">
          <ModeButton
            active={liveVisible}
            icon={MonitorPlay}
            label="Live"
            onClick={() => onModeChange('live')}
          />
          <ModeButton
            active={!liveVisible}
            icon={ScanSearch}
            label="Inspect"
            disabledReason={inspectDisabledReason}
            onClick={() => onModeChange('inspect')}
          />
        </div>

        {/* The one status the deleted banner (§3.2) genuinely said on its own:
            input is off even for whoever holds control, and only a running job
            explains that. Everything else it used to say is already in the
            video's own footer, one screen region closer to its subject. */}
        {jobRunning && (
          <span className="rounded-full border border-led-active/35 bg-led-active/10 px-2.5 py-0.5 text-[11.5px] text-led-active">
            A job is running — input stays off until it finishes
          </span>
        )}
      </div>

      <div hidden={!liveVisible} aria-hidden={!liveVisible}>
        <LiveView
          deviceId={deviceId}
          inputEnabled={inputEnabled}
          onActivity={onActivity}
          autoReconnect={autoReconnect}
          active={visible && liveVisible}
        />
      </div>

      {/* The same `hidden` treatment as the video above (plan 59 §4.2) — a
          conditional render here tore the panel down on every mode flip, and
          rebuilding it meant a fresh attach and a fresh 334–584 ms dump before
          anything appeared. `visible` is still passed through, because a
          mounted panel that nobody is looking at must stop *polling* even
          though it stays attached (§3.5). */}
      {/* A device with no inspector at all (agent-owned) never mounts one:
          `Inspect` is disabled above, so this panel could only ever sit hidden
          and attach an engine that does not exist. */}
      {!inspectDisabledReason && (
        <div hidden={liveVisible} aria-hidden={liveVisible}>
          <InspectorPanel
            deviceId={deviceId}
            canUse={canInspect}
            onTakeControl={onTakeControl}
            {...(takeControlDisabledReason ? { takeControlDisabledReason } : {})}
            visible={visible && !liveVisible}
          />
        </div>
      )}
    </div>
  )
}

function ModeButton({
  active,
  icon: Icon,
  label,
  disabledReason,
  onClick,
}: {
  active: boolean
  icon: typeof MonitorPlay
  label: string
  disabledReason?: string
  onClick: () => void
}) {
  const button = (
    <button
      type="button"
      aria-pressed={active}
      disabled={Boolean(disabledReason)}
      onClick={onClick}
      className={cn(
        'flex items-center gap-1.5 rounded px-2.5 py-1 text-[12.5px] transition-colors',
        disabledReason
          ? 'cursor-not-allowed text-fg-subtle'
          : active
            ? 'bg-surface-3 font-medium text-fg'
            : 'text-fg-muted hover:text-fg',
      )}
    >
      <Icon className="size-3.5" aria-hidden />
      {label}
    </button>
  )
  if (!disabledReason) return button
  // A control that cannot be used is genuinely disabled, and says why
  // (design.md's quality floor) — the span carries the hover, since a disabled
  // button fires no pointer events of its own.
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0}>{button}</span>
      </TooltipTrigger>
      <TooltipContent>{disabledReason}</TooltipContent>
    </Tooltip>
  )
}
