'use client'

import { useState } from 'react'
import type { DeviceInfo } from '@enkaku/protocol'
import type { DeviceDetailInfo } from '@/components/device/DeviceHeader'
import { InspectorPanel } from '@/components/InspectorPanel'
import { RecordPanel } from '@/components/recording/RecordPanel'
import { useRecording } from '@/components/recording/useRecording'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@enkaku/ui'
import { ActionsList } from './ActionsList'

/**
 * The device popup's right-hand panel content — `Actions | Inspector` (plan
 * 103 §4.1, §5 step 103.2, filled in by step 103.5). Both are real panels
 * beside the SAME `LiveView` the popup already streams (plan 103 §3.4):
 * switching tabs is a visibility change, never a remount OF `LiveView` —
 * LiveView lives in `DevicePopup`'s own centre panel, a sibling of this
 * whole component, so nothing here can touch it regardless of which tab is
 * active. `InspectorPanel` never opens a second VIDEO session for a device
 * this popup is already streaming (G7/G8 — exactly what `WallTile`'s own
 * focused-placeholder exists to prevent one level up, at the Wall) — it has
 * no video path of its own to begin with.
 *
 * **Terminal is no longer a tab here (plan 103 §9 Q4, answered
 * 2026-08-16).** It used to be — a `TerminalPane` mounted only while its own
 * tab was active, reached by the Actions tab's "Adb command" row switching
 * this component's own `tab` state. The owner asked twice for something
 * different: *"fitur terminal keknya jadi satu aja dengan adb command ga
 * sih? terus bentuknya modal juga dan bisa deteksi device juga, jadi bisa
 * running banyak devices"* — and, on seeing it still a tab, *"terminal
 * kenapa masih ada tab nya? ... ketika di tekan muncul popup modal
 * tersendiri ... tapi outputnya harus bisa dilihat langsung juga?"* "Adb
 * command" now opens `AdbCommandDialog` directly from `ActionsList.tsx`
 * (a NON-MODAL popup, plan 103 §3.2's own path, exactly like every other
 * action row) instead of switching a tab here — `TerminalPane` itself moved
 * into that dialog unchanged (its own doc comment has the full account of
 * why an interactive one-device session and a fan-out command coexist in
 * one modal), it was not dropped.
 *
 * **Inspector stays a panel** — nothing in the owner's Terminal instruction
 * touches it, and §3.4's own reasoning still holds for it specifically: you
 * tap the phone and watch the UI tree change, so both need to be visible at
 * once, which a modal (even a non-modal one, floating OVER the screen) does
 * not give as directly as a panel beside it.
 *
 * **Inspector mounts only while its own tab is active** — Radix's default
 * `TabsContent` behaviour, deliberately not overridden with `forceMount`: it
 * opens its own `inspect.attach` WS subscription the instant it mounts, and
 * a popup opened just to watch the screen should not pay for a subscription
 * it never asked for. Switching away drops the attachment (a real cost,
 * named here rather than silently accepted) — switching back re-attaches,
 * the same as opening the device page's own Control-Inspect tab fresh.
 *
 * **Inspector reuses the device page's own panel unchanged**
 * (`InspectorPanel` — what this plan's own "you tap the phone and watch the
 * UI tree change" line describes; the device page's OTHER `logcat`/`top`/
 * `thermal` pane, `MonitorPane`, is a different surface — plan 24's
 * streaming-lane monitor — and is not one of the twelve rows or two tabs
 * this plan names, so it stays unreached from the popup for now). It gates
 * its own mutating affordances on `canUseLive` (the SAME `iHoldControl &&
 * !busy` fact the Actions tab's Assist row and rail buttons already read) —
 * an Assist grant does NOT extend to `inspect.*` (plan 91 §3.4 lists exactly
 * five input verbs, and it is not one of them), so someone assisting a job
 * sees the same "take control" prompt anyone else would.
 *
 * **`tabs` (plan 103 §5 step 103.10, extended by step 103.11's audit
 * closure)** — which of `Actions | Inspector | Record` a caller wants,
 * defaulting to all three (this component's own long-standing shape for
 * `Actions | Inspector`, extended when Record joined it — `DevicePopup`
 * itself is unaffected either way, since it never passes `tabs`). The
 * right-click context menu (`components/wall/DeviceContextMenu.tsx`, the
 * owner's own ask: "the same thing panel 3 renders") is the one caller that
 * passes `['actions']` — a STATED decision, not a silently rendered subset.
 * Inspector AND Record both fail plan 103 §3.4's own test ("does this need
 * to be open *while you are touching the phone*?") for that surface
 * specifically: the popup's centre screen panel is what makes either legible
 * ("you tap the phone and watch the UI tree change" / "you record by
 * interacting with the phone"), and the context menu has no screen beside it
 * at all — it is a transient popover that dismisses on the next outside
 * click, so a live `inspect.attach` subscription (or a recording session
 * kept alive by a popover that can vanish on the next click elsewhere)
 * mounted there would be a real cost with no screen to show the result
 * against. Actions needs none of that: every action row opens its OWN
 * self-contained, non-modal dialog (§3.2) that does not depend on a screen
 * being visible beside it, which is why Actions survives the merge and the
 * other two do not.
 *
 * **Record (plan 103 §5, closing step 103.11's audit row 3, 2026-08-17)** —
 * the third tab, applying §3.3's own test the SAME way Inspector already
 * does: recording is not "a view you read", it is something you DO to the
 * live screen (§3.3's own words: *"Recording does [need to be open while you
 * are touching the phone] — you record by interacting"*), so it earns a
 * panel beside `LiveView`, not a popup over it. `useRecording(deviceId)` is
 * called at THIS component's own top level (not inside `TabsContent`,
 * mirroring `ScreenCard.tsx`'s own reasoning for the identical hook) so a
 * step already captured survives switching to Actions/Inspector and back —
 * the recording belongs to the popup SESSION, not to whichever tab happens
 * to be on screen. The small red pulsing dot on the tab trigger itself
 * (`RecordPanel`'s own indicator, reproduced here rather than imported,
 * since `ScreenCard`'s `ModeButton` is a different, page-only component)
 * follows a recording across tab switches the same way `ScreenCard`'s own
 * mode switch already does — the whole reason `ScreenCard`'s doc comment
 * gives for calling the hook unconditionally. `RecordPanel` itself is reused
 * UNCHANGED (§4.2's own "reuse, never reimplement"); the ONLY new code here
 * is the disabled-reason plumbing `ScreenCard` already established
 * (`canUseLive` — the same manual-lease-only gate `recording.start`'s own
 * server check enforces, `ws-handlers.ts`: recording is a side-channel on
 * the LEASE holder's own input, never the Assist fallback) and a structural
 * block for a node-owned (cloud) device, which has no local recorder to
 * attach to (the same `device.nodeId` check `app/device/page.tsx` uses for
 * its own `ScreenCard`).
 */
export function SidePanel({
  deviceId,
  device,
  devices,
  selectedIds,
  assistState,
  canUseLive,
  takeControlDisabledReason,
  onAssistSelect,
  onDeviceReloaded,
  onForgotten,
  onClaimControl,
  tabs = ['actions', 'inspector', 'record'],
}: {
  deviceId: string
  device: DeviceDetailInfo
  /** Plan 104 (M69) §3.2 — passed straight through to `ActionsList`'s own identically-named prop; see that file's doc comment. */
  devices: DeviceInfo[]
  selectedIds?: readonly string[]
  assistState: 'unavailable' | 'off' | 'busy' | 'available'
  /** `iHoldControl && !busy` — the real manual lease, never an Assist grant (see the file header). Gates Inspector's `canUse`; `ActionsList` reads the same fact for `AdbCommandDialog`'s own `TerminalPane` gate. */
  canUseLive: boolean
  /** Why the Inspector tab's inline "take control" cannot be pressed right now, or `null` when it can (plan 59 §3.1's pattern). Only read when `tabs` includes `'inspector'`. */
  takeControlDisabledReason?: string | null
  onAssistSelect: () => void
  onDeviceReloaded: () => void
  onForgotten: () => void
  /** The Inspector tab's own inline "take control" — `DevicePopup`'s `claimControl`, the same `lease.acquire` request the popup's own auto-claim effect sends. Only read when `tabs` includes `'inspector'`. */
  onClaimControl?: () => void
  /**
   * Which of `Actions | Inspector | Record` to render (plan 103 §5 step
   * 103.10, extended by step 103.11's audit closure) — defaults to all
   * three, `DevicePopup`'s own long-standing shape (unchanged for
   * `Actions | Inspector`, since it never passes `tabs`). The right-click
   * context menu (`components/wall/DeviceContextMenu.tsx`) is the one caller
   * that passes `['actions']`: see the file header's own note on why
   * Inspector and Record are both a stated, reasoned exclusion there rather
   * than an accidental subset.
   */
  tabs?: readonly ('actions' | 'inspector' | 'record')[]
}) {
  const [tab, setTab] = useState('actions')
  const showInspector = tabs.includes('inspector')
  const showRecord = tabs.includes('record')

  // Called unconditionally at THIS component's own top level (not inside
  // `TabsContent value="record"`) so a step already captured survives a flip
  // to Actions/Inspector and back — see the file header's own note, the same
  // "attachment/state follows the session, not the mode" reasoning
  // `ScreenCard.tsx` documents for calling this identical hook the same way.
  const recording = useRecording(deviceId)
  const recordingIndicatorActive = recording.phase === 'active' || recording.phase === 'stopping'
  // Recording requires the SAME manual lease `recording.start`'s own server
  // check enforces (`ws-handlers.ts`'s own `checkInputAllowed` — never the
  // Assist fallback), the identical rule `ScreenCard.tsx`'s
  // `startRecordingDisabledReason` already applies for the device page's own
  // Record mode.
  const recordDisabledReason = canUseLive ? undefined : (takeControlDisabledReason ?? 'Take control to record.')

  return (
    <Tabs value={tab} onValueChange={setTab} className="min-h-0 flex-1">
      <TabsList className="w-full">
        <TabsTrigger value="actions">Actions</TabsTrigger>
        {showInspector && <TabsTrigger value="inspector">Inspector</TabsTrigger>}
        {showRecord && (
          <TabsTrigger value="record" className="gap-1.5">
            Record
            {/* A small red dot even while a DIFFERENT tab is on screen — a
                recording keeps running on the core regardless of which tab
                this panel happens to be showing, the identical indicator
                `ScreenCard.tsx`'s own `ModeButton` renders for the device
                page's Record mode. */}
            {recordingIndicatorActive && (
              <span className="size-1.5 animate-pulse rounded-full bg-led-danger" aria-label="Recording in progress" />
            )}
          </TabsTrigger>
        )}
      </TabsList>
      {/* `min-h-0 overflow-y-auto` — the ONE place in the whole popup that
          may scroll besides an already-self-contained pane (plan 103's
          layout restructure, owner-specified: "nothing scrolls except the
          actions panel … only when its own height genuinely cannot hold
          the list"). Twelve rows fit without scrolling at the popup's
          DEFAULT size (§4.2, §6) — this only engages once the operator
          resizes the container smaller than that, which is a legitimate
          outcome for a list, not a layout defect. */}
      <TabsContent value="actions" className="min-h-0 overflow-y-auto">
        <ActionsList
          deviceId={deviceId}
          device={device}
          devices={devices}
          selectedIds={selectedIds}
          assistState={assistState}
          canUseLive={canUseLive}
          onAssistSelect={onAssistSelect}
          onDeviceReloaded={onDeviceReloaded}
          onForgotten={onForgotten}
        />
      </TabsContent>
      {/* Plain, un-forced `TabsContent` — mounts only while active (see the
          file header). `InspectorPanel` manages its own bounded internal
          scroll area already. Skipped entirely when `tabs` excludes
          `'inspector'` (the context menu's own stated decision, file
          header) — there is then no trigger to select it, and no reason to
          keep `onClaimControl`'s type non-optional for a caller that never
          reads it. */}
      {showInspector && (
        <TabsContent value="inspector" className="flex min-h-0 flex-1 flex-col">
          <InspectorPanel
            deviceId={deviceId}
            canUse={canUseLive}
            onTakeControl={onClaimControl ?? (() => {})}
            {...(takeControlDisabledReason ? { takeControlDisabledReason } : {})}
            // Always true: this whole element only mounts when the Inspector
            // tab is active (see the file header), so there is no "mounted
            // but hidden" state left for this prop to distinguish here.
            visible
          />
        </TabsContent>
      )}
      {/* Plain, un-forced `TabsContent` — mounts only while active, same as
          Inspector above. `useRecording` (not this content) is what keeps
          the recording's own state alive across the switch (file header).
          Skipped entirely when `tabs` excludes `'record'` (the context
          menu's own stated exclusion, file header). */}
      {showRecord && (
        <TabsContent value="record" className="min-h-0 overflow-y-auto">
          {device.nodeId ? (
            <p className="p-3 text-[11.5px] text-fg-subtle">Recording is not available for cloud (node-owned) devices yet.</p>
          ) : (
            <RecordPanel
              deviceId={deviceId}
              phase={recording.phase}
              steps={recording.steps}
              stepCount={recording.stepCount}
              startedAt={recording.startedAt}
              endedAt={recording.endedAt}
              stoppedReason={recording.stoppedReason}
              error={recording.error}
              disabledReason={recordDisabledReason}
              onStart={recording.start}
              onStop={recording.stop}
              onDiscard={recording.discard}
              onReset={recording.reset}
            />
          )}
        </TabsContent>
      )}
    </Tabs>
  )
}
