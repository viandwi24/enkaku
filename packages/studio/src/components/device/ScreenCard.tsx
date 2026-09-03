'use client'

import { Circle, MonitorPlay, ScanSearch } from 'lucide-react'
import { LiveView } from '@/components/LiveView'
import { InspectorPanel } from '@/components/InspectorPanel'
import { RecordPanel } from '@/components/recording/RecordPanel'
import { useRecording } from '@/components/recording/useRecording'
import { Tooltip, TooltipContent, TooltipTrigger, cn } from '@enkaku/ui'

export type ScreenMode = 'live' | 'inspect' | 'record'

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
 * panel nobody was looking at. The gap in that reasoning is that reading the
 * UI tree needs the device to be reachable at all — while every
 * `Live ⇄ Inspect` flip paid a full cold start. The attachment now follows
 * whether the device is online instead of the mode, inside `InspectorPanel`;
 * going offline still detaches, which is what plan 56's acceptance #8 was
 * actually protecting.
 *
 * **`record` is a third mode, not a second thing bolted beside the first two**
 * (plan 94 §4.10, F17, §5 step 94.4). Recording tees the operator's own
 * manual input on the core (plan 94 §3.3) — the picture on screen and the WS
 * connection carrying it are exactly the ones `live` already uses, so this
 * mode keeps the video mounted and visible (`videoVisible` below covers both)
 * and only adds a step strip alongside it. `useRecording` is called at THIS
 * component's own top level, not inside a child that only renders while
 * `mode === 'record'`, for the same reason the inspector's attachment
 * follows whether the device is online rather than the mode: flipping to
 * `Live` to check something and back must not lose a step already captured,
 * or the video underneath it.
 */
export function ScreenCard({
  deviceId,
  mode,
  onModeChange,
  inspectDisabledReason,
  recordDisabledReason,
  jobRunning,
  inputEnabled,
  canInspect,
  onActivity,
  autoReconnect,
  visible,
  warning,
  configuredDisplay,
}: {
  deviceId: string
  mode: ScreenMode
  onModeChange: (mode: ScreenMode) => void
  /** Why `Inspect` cannot be used here — a node-owned device has no local inspector (plan 56 §2). */
  inspectDisabledReason?: string
  /** Why `Record` cannot be used here — today, that is only a node-owned device (`recording.start`'s own `E_NOT_SUPPORTED` refusal, `ws-handlers.ts`); `Start recording` inside the panel is separately disabled while `!inputEnabled`, with its own reason, so this prop is for a STRUCTURAL block rather than "the device is offline". */
  recordDisabledReason?: string
  jobRunning: boolean
  inputEnabled: boolean
  /** `online` (plan 205 §4.9) — the same server-published fact the other panels read. */
  canInspect: boolean
  onActivity?: () => void
  autoReconnect: boolean
  /** Whether the Control tab itself is the one on screen — the video asks for a fresh keyframe when this or the mode brings it back into view. */
  visible: boolean
  /**
   * A one-line, non-blocking notice above the screen (plan 205 §4.9) — the
   * server's own `device.activity.warning` broadcast (a concurrent-activity
   * heads-up from the admission policy), shown for as long as the caller
   * keeps it. Replaces the old secondary-operator banner/badge pair — never
   * an overlay, never a confirmation.
   */
  warning?: string | null
  /** Plan 100 §3.7 item 1, step 100.6 — `DeviceDetailInfo.display`, forwarded to `LiveView` so it can tell a deliberate screencap-loop configuration apart from a degraded fallback. */
  configuredDisplay?: string
}) {
  // `record` keeps the SAME video the `live` mode shows (§4.10 — "the card
  // keeps the live picture and gains a step strip along its edge"); only
  // `inspect` swaps the picture for a frozen dump. `inspectVisible` is the
  // one narrower check that used to be spelled `!liveVisible`, back when
  // there were only two modes.
  const videoVisible = mode === 'live' || mode === 'record'
  const inspectVisible = mode === 'inspect'
  // Called unconditionally (this component's own top level, not inside a
  // child gated on `mode === 'record'`) so a step already captured survives
  // a flip to `Live`/`Inspect` and back — see the doc comment above. Note
  // this hook does NOT itself run a ticking clock — `RecordPanel` owns that,
  // and only while it is mounted (`mode === 'record'`), so a device page
  // left on `Live` never pays for a duration timer nobody is looking at.
  const recording = useRecording(deviceId)
  const startRecordingDisabledReason = inputEnabled ? undefined : 'The device is offline.'
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <div className="inline-flex rounded-md border bg-surface p-0.5" role="group" aria-label="Screen mode">
          <ModeButton
            active={mode === 'live'}
            icon={MonitorPlay}
            label="Live"
            onClick={() => onModeChange('live')}
          />
          <ModeButton
            active={mode === 'inspect'}
            icon={ScanSearch}
            label="Inspect"
            disabledReason={inspectDisabledReason}
            onClick={() => onModeChange('inspect')}
          />
          <ModeButton
            active={mode === 'record'}
            icon={Circle}
            label="Record"
            disabledReason={recordDisabledReason}
            // A small red dot even while a DIFFERENT mode is on screen — a
            // recording keeps running on the core regardless of which mode
            // this tab happens to be looking at, and the operator should not
            // have to switch back to `Record` just to remember one is open.
            indicatorActive={recording.phase === 'active' || recording.phase === 'stopping'}
            onClick={() => onModeChange('record')}
          />
        </div>

        {/* The one status the deleted banner (§3.2) genuinely said on its own:
            input is off even for whoever holds control, and only a running job
            explains that. Everything else it used to say is already in the
            video's own footer, one screen region closer to its subject. */}
        {jobRunning && !warning && (
          <span className="flex flex-wrap items-center gap-2 rounded-full border border-led-active/35 bg-led-active/10 py-0.5 pl-2.5 pr-1 text-[11.5px] text-led-active">
            <span>A job is running on this device.</span>
          </span>
        )}
        {/* Plan 205 §4.9 — a `device.activity.warning` from the server's own
            admission policy: something else is concurrently using the
            device (a `warn`-tier conflict), not a hard refusal. Never an
            overlay, never a confirmation — one muted line for as long as
            the caller keeps it. */}
        {warning && <span className="rack-label text-led-warn">{warning}</span>}
      </div>

      <div hidden={!videoVisible} aria-hidden={!videoVisible}>
        <div>
          <LiveView
            deviceId={deviceId}
            inputEnabled={inputEnabled}
            onActivity={onActivity}
            autoReconnect={autoReconnect}
            active={visible && videoVisible}
            configuredDisplay={configuredDisplay}
          />
        </div>
        {/* Record mode's own edge panel (§4.10, F17, step 94.4) — rendered
            beside the SAME video above, never in place of it: entering
            `record` must not restart the stream, and it does not, because
            this whole block only toggles `hidden` on a container that was
            never unmounted (plan 42 §3.1's own treatment, extended here). */}
        {mode === 'record' && (
          <div className="mt-3">
            <RecordPanel
              deviceId={deviceId}
              phase={recording.phase}
              steps={recording.steps}
              stepCount={recording.stepCount}
              startedAt={recording.startedAt}
              endedAt={recording.endedAt}
              stoppedReason={recording.stoppedReason}
              error={recording.error}
              disabledReason={startRecordingDisabledReason}
              onStart={recording.start}
              onStop={recording.stop}
              onDiscard={recording.discard}
              onReset={recording.reset}
            />
          </div>
        )}
      </div>

      {/* The same `hidden` treatment as the video above (plan 59 §4.2) — a
          conditional render here tore the panel down on every mode flip, and
          rebuilding it meant a fresh attach and a fresh 334–584 ms dump before
          anything appeared. `visible` is still passed through, because a
          mounted panel that nobody is looking at must stop *polling* even
          though it stays attached (§3.5). */}
      {/* A device with no inspector at all (node-owned) never mounts one:
          `Inspect` is disabled above, so this panel could only ever sit hidden
          and attach an engine that does not exist. */}
      {!inspectDisabledReason && (
        <div hidden={!inspectVisible} aria-hidden={!inspectVisible}>
          <InspectorPanel
            deviceId={deviceId}
            canUse={canInspect}
            visible={visible && inspectVisible}
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
  indicatorActive = false,
  onClick,
}: {
  active: boolean
  icon: typeof MonitorPlay
  label: string
  disabledReason?: string
  /** A small red dot beside the label — a recording keeps running on the core no matter which mode this tab is showing, so the operator should not need to switch back to `Record` just to be reminded one is open (plan 94 §5 step 94.4). */
  indicatorActive?: boolean
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
      {indicatorActive && (
        <span className="size-1.5 animate-pulse rounded-full bg-led-danger" aria-label="Recording in progress" />
      )}
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
