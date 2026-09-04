'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { Bot, OctagonX, ScreenShare, X } from 'lucide-react'
import {
  DeviceActivityMessage,
  DeviceDetailResponseSchema,
  DeviceLabelStateSchema,
  DeviceViewersResponseSchema,
  JobCancelResponseSchema,
  type BatteryState,
  type DeviceLabelState,
  type DevicePreparation,
  type RegistryResponse,
  type Viewer,
} from '@enkaku/protocol'
import { LiveView, markLiveViewIntent } from '@/components/LiveView'
import { AskAnAgentDialog } from '@/components/AskAnAgentDialog'
import { AgentAlertChip } from '@/components/guest-agent/AgentAlertChip'
import { LabelStateBadge } from '@/components/device/LabelStateBadge'
import {
  BatteryTempInline,
  DeviceDetailsPopover,
  ViewersPopover,
  type DeviceDetailInfo,
} from '@/components/device/DeviceHeader'
import { fetchRegistry } from '@/components/schema-form/useEnumSource'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  DeviceName,
  api,
  formatDeviceName,
  useAction,
} from '@enkaku/ui'
import { applyActivityEvent, hasJob, runningJobId } from '@/lib/activity'
import { fetchGuestAgentStatus } from '@/lib/api'
import { ws } from '@/lib/ws'
import { useNow } from '@/lib/useNow'
import { usePreparation } from '@/lib/use-preparation'
import { HardwareRail } from './HardwareRail'
import { componentLabel } from './PreparationPanel'
import { SidePanel } from './SidePanel'

/**
 * Plan 106 §5 step 106.7 — which component (if any) to name on the
 * screen-panel overlay. More than one component can theoretically be
 * `provisioning` at once (the guest agent's own engine and a registry
 * component's `ensureAll` sweep are two independent engines that CAN run
 * concurrently, per `api/device-preparation.ts`'s bridged `POST
 * /:id/preparation`) — the overlay has room for exactly one line, so this
 * picks the guest agent first (the component the owner's own report named
 * first) and otherwise the lexicographically first id, deterministic
 * rather than whichever happened to resolve its `Object.entries` position.
 *
 * Returns `null` the instant nothing is `provisioning` any more — including
 * when a component lands on `failed`. That is deliberate, not a missed
 * case: the overlay only ever says WHICH component and for how long, never
 * why one didn't make it — a multi-line adb error has no room on a video
 * overlay, and restating it there would just be a second, worse-formatted
 * copy of what `PreparationPanel`'s own row already shows. The overlay
 * disappearing IS the signal to go look at Settings › Preparation.
 */
export function provisioningComponentFor(preparation: DevicePreparation | null): { componentId: string; label: string; startedAt: number } | null {
  if (!preparation) return null
  const provisioningIds = Object.entries(preparation)
    .filter(([, status]) => status.state === 'provisioning')
    .map(([id]) => id)
  if (provisioningIds.length === 0) return null
  const id = provisioningIds.includes('guest-agent') ? 'guest-agent' : [...provisioningIds].sort((a, b) => a.localeCompare(b))[0]!
  const status = preparation[id]!
  return { componentId: id, label: componentLabel(id), startedAt: status.checkedAt ?? Math.floor(Date.now() / 1000) }
}

/**
 * The device popup (plan 91 §3.11, §5 step 91.9; evolved into plan 103's
 * shell, §4.1, §5 step 103.2) — the thing that closes what plan 91 step 91.8
 * opened, and the destination the device page (G1) is scheduled to empty
 * into (plan 103 §2). Double-clicking a wall tile sets `?focus=<id>`; this is
 * what reads it (via the `deviceId` prop `app/page.tsx` hands down from that
 * same param) and gives the operator a way back.
 *
 * **Three independent panels in a transparent container, not one panel with
 * three columns** (the owner's own correction to this plan's original shape,
 * landed alongside 103.4–103.7 — see this plan's own status-line note): the
 * hardware rail, the screen, and the identity/actions panel each draw their
 * OWN `rounded-lg border bg-surface shadow-2xl` — the outer `<div>` this
 * component returns has none of those, on purpose. The Wall is visible
 * through the gaps between the three panels, matching the owner's own
 * reference (Android Studio's emulator model: a control strip that floats
 * beside the device window but travels with it). `resize` and the drag
 * affordance belong to the CONTAINER, never to an individual panel — so
 * resizing (there is no drag-to-move yet) moves/resizes all three together.
 *
 * **Not a `Dialog`.** No focus trap, no `aria-modal`, no full-screen backdrop
 * — a plain `fixed`, resizable panel over the Wall, which stays mounted and
 * live behind it (plan 91 §3.11's own reasoning: this is a React overlay in
 * the same route, not a navigation, so nothing here remounts the page or
 * drops the WS).
 *
 * **`Esc` precedence (plan 103 §3.5, written as its own table by §5 step
 * 103.7) — up to three claimants, one key, checked in this exact order:**
 *
 * | # | Claimant | Fires when | Outcome |
 * |---|---|---|---|
 * | 1 | An open action/read popup (Run script, Disconnect, Forget, the Jobs/Files/Settings popups, …) | The popup is open, regardless of anything else | The popup closes itself; nothing below ever sees the key |
 * | 2 | The live canvas | No popup is open, AND the canvas has focus with input enabled | `Esc` becomes Android `BACK` on the device; this popup stays open |
 * | 3 | This device popup | Neither of the above claimed the key | This popup closes |
 *
 * Rule 1 needs NO code here: Radix's `DismissableLayer` attaches its own
 * Escape handler on `document` with `{ capture: true }` (only for the
 * topmost open layer) and calls `event.preventDefault()` before dismissing
 * (`@radix-ui/react-dismissable-layer`'s `handleKeyDown`). Capture always
 * runs before this file's own `window` bubble-phase listener below, so by
 * the time that listener sees the event, `defaultPrevented` is already
 * `true` whenever a dialog or popup was open to consume it.
 *
 * Rule 2 also needs no coupling to another file's internals:
 * `LiveView.tsx`'s own `onKeyDown` calls `preventDefault()` the moment it
 * turns Escape into a keycode, which happens only when the canvas has focus
 * AND input is enabled.
 *
 * Rule 3 is the `else` branch below — checking `defaultPrevented` is a
 * complete, accurate answer to "did something above already use this key",
 * because rules 1 and 2 are both guaranteed to run and call
 * `preventDefault()` strictly before this bubble-phase `window` listener
 * ever fires.
 *
 * **Quality handoff.** This is the ONE place in Studio that renders
 * `<LiveView quality="control" />` for a device also visible as a Wall tile:
 * `WallTile` (plan 91 §5 step 91.8) already stops decoding the focused
 * device and shows the "Controlling here" placeholder instead, so opening
 * this popup moves a decoder rather than adding one (proven in
 * `DevicePopup.test.tsx`, not merely asserted here) — and plan 100's
 * two-entry `SessionManager` (`(deviceId, quality)`) is what makes a
 * `control` session coexist with the tile's own `wall` session instead of
 * restarting it (plan 100 §3.2), so the wall tile behind this popup keeps
 * streaming, undisturbed, for the popup's whole lifetime (plan 103 §6).
 *
 * **No more manual hold, no more secondary operators, no more fan-out
 * groups (plan 205 §4.9, §4.11).** MVP 04 replaced the whole per-holder /
 * secondary-operator / fan-out subsystem this popup used to manage (a
 * manual hold this popup auto-claimed and released, a secondary-operator
 * grant, a fan-out group it owned for its own lifetime) with the device
 * activity model: any operator may act on
 * an ONLINE device immediately — the server's own admission policy decides
 * `allow`/`warn`/`forbid` per action, never a pre-acquired hold this popup
 * had to track, refresh, or give back on close. `online` (`status ===
 * 'online'`) is now the one precondition every control surface in this
 * popup checks. `ActivityBadge` (`@/components/ActivityBadge`) is what
 * other surfaces (`DeviceHeader`, `DeviceCard`, `WallTile`, `DevicePicker`)
 * render for "who is doing what to this device right now" — this popup IS
 * the live screen, so it has no badge of its own to keep in sync.
 */
export function DevicePopup({
  deviceId,
  devices,
  selectedIds,
  onClose,
}: {
  deviceId: string
  /** The Wall's full (unfiltered) device list — labels/status for `ActionsList`'s own bulk-target defaults (plan 104 §3.2), never fetched a second time. */
  devices: import('@enkaku/protocol').DeviceInfo[]
  /** The Wall's own selection (plan 104 §3.2) — unioned with `deviceId` itself to form `ActionsList`'s bulk-action candidate set. */
  selectedIds: readonly string[]
  onClose: () => void
}) {
  const [deviceDetail, setDeviceDetail] = useState<DeviceDetailInfo | null>(null)
  const [fetchError, setFetchError] = useState<string | null>(null)
  // Plan 106 §5 step 106.7 — the SAME live preparation record `PreparationPanel`
  // reads (`usePreparation`'s own doc comment: shared source, not two
  // independently-computed ideas of "is this installing right now"). Polled
  // for as long as this popup is open, regardless of which Settings section
  // (if any) is open, because the screen-panel overlay below must reflect an
  // install triggered server-side (admission/reconnect) that this client
  // never clicked a button for.
  const { preparation: liveProvisioning } = usePreparation(deviceId)
  const provisioningOverlay = useMemo(() => provisioningComponentFor(liveProvisioning), [liveProvisioning])

  // Everything below (plan 103 §5, closing step 103.11's audit rows 20-22 —
  // viewer presence, the device-details popover, and battery/temperature)
  // reads the SAME facts `DeviceHeader.tsx` already fetches for the device
  // page, mounted through the SAME extracted components
  // (`BatteryTempInline`/`ViewersPopover`/`DeviceDetailsPopover`) rather than
  // a thinner reimplementation — this popup is a second, simultaneous viewer
  // of exactly the same facts, not a fork of them.
  const [battery, setBattery] = useState<BatteryState | null>(null)
  const [viewers, setViewers] = useState<Viewer[]>([])
  const [hoveredSessionId, setHoveredSessionId] = useState<string | null>(null)
  const [registry, setRegistry] = useState<RegistryResponse | null>(null)
  const [agentVersion, setAgentVersion] = useState<string | null>(null)
  const [inspectorFallback, setInspectorFallback] = useState<{ to: string; reason: string } | null>(null)
  const [labelState, setLabelState] = useState<DeviceLabelState | null>(null)
  // Row 29 (audit) — "Ask an agent…" is a header affordance, not a 13th
  // Actions row: §4.2's own rule is "displace, don't append", and this is a
  // situational handoff (ranked #10 of the absent surfaces), not something
  // that earns a place among the twelve fixed rows.
  const [askAgentOpen, setAskAgentOpen] = useState(false)
  // The same lazy-init-then-`hello`-update shape `app/device/page.tsx` uses
  // for its own `mySessionId` — the WS handshake can complete after this
  // popup's own first render.
  const [mySessionId, setMySessionId] = useState<string | null>(() => ws.getSessionId())
  const [endTaskOpen, setEndTaskOpen] = useState(false)

  const now = useNow()
  const { run, isPending } = useAction()

  /**
   * Plan 125 §4.7, §5 step 125.11 — "the popup open" half of the click→paint
   * mark. Deliberately in the render body behind a ref guard, not in an
   * effect: React runs CHILD effects before parent ones, so a mount effect
   * here would fire after `<LiveView>`'s own stream effect had already looked
   * for a mark and found none — the measurement would silently never happen
   * for any popup opened by something other than a tile double-click.
   * `onlyIfAbsent` because `WallTile`'s double-click already recorded the
   * earlier, truer timestamp on the path that matters most (§0.7's cold cast);
   * this only supplies a start for the other ways a popup opens.
   */
  const intentMarkedForRef = useRef<string | null>(null)
  if (intentMarkedForRef.current !== deviceId) {
    intentMarkedForRef.current = deviceId
    markLiveViewIntent(deviceId, { onlyIfAbsent: true })
  }

  const label = deviceDetail?.label ?? deviceId
  // Plan 124 §4.4 Group B, step 124.2 — every place in this popup that needs
  // the device as a `string` (the region's `aria-label`, the "End task"
  // confirm, and `AskAnAgentDialog`'s own `deviceLabel` prop) reads this, so
  // the popup names the device exactly one way. `deviceDetail` is `null`
  // until the detail fetch lands, and `formatDeviceName` treats the
  // resulting `undefined` number the same as `null` — the bare label, never
  // `#undefined`.
  const deviceName = formatDeviceName(deviceDetail?.number, label)
  // Plan 205 §4.9 — the ONE precondition every control surface in this popup
  // checks now (`canUseLive`, `inputEnabled` below): a device is either
  // reachable or it is not. Replaces `iHoldControl && !busy`.
  const online = deviceDetail?.status === 'online'
  const jobId = deviceDetail ? runningJobId(deviceDetail) : null
  const jobLabel = deviceDetail?.activities.find((a) => a.kind === 'job' || a.kind === 'workflow-job')?.label ?? 'this job'

  // Fetch the focus device's own detail (plan 205 §4.9 — no more auto-claim:
  // admission happens per action now, never as a precondition of opening the
  // popup).
  useEffect(() => {
    let cancelled = false
    setDeviceDetail(null)
    setFetchError(null)
    void api(`/api/devices/${deviceId}`, DeviceDetailResponseSchema)
      .then((b) => {
        if (!cancelled) setDeviceDetail(b.device)
      })
      .catch((e) => {
        if (!cancelled) setFetchError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      cancelled = true
    }
  }, [deviceId])

  // Plan 103 §5, closing step 103.11's audit rows 20-21 — the device-details
  // popover's own facts (registry names, the guest agent's `appVersion`) and
  // the viewer presence popover's own snapshot (`/ws` has no replay — the
  // SAME reasoning `app/device/page.tsx`'s own comment on this fetch gives).
  // `fetchRegistry` is itself cached (module-level, shared across every
  // caller) — this is not a per-popup-open network cost.
  useEffect(() => {
    let cancelled = false
    setAgentVersion(null)
    setLabelState(null)
    setViewers([])
    void fetchRegistry().then((r) => {
      if (!cancelled) setRegistry(r)
    })
    void fetchGuestAgentStatus(deviceId)
      .then((s) => {
        if (!cancelled) setAgentVersion(s.appVersion ?? null)
      })
      .catch(() => {
        if (!cancelled) setAgentVersion(null)
      })
    void api(`/api/devices/${deviceId}/label`, DeviceLabelStateSchema)
      .then((s) => {
        if (!cancelled) setLabelState(s)
      })
      .catch(() => undefined)
    void api(`/api/devices/${deviceId}/viewers`, DeviceViewersResponseSchema)
      .then((b) => {
        if (!cancelled) setViewers(b.viewers)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [deviceId])

  // Kept live, the same shape `app/device/page.tsx` already established for
  // each of these broadcasts — this popup is a second, simultaneous viewer
  // of exactly the same facts, not a fork of them.
  useEffect(() => {
    const off = ws.on((msg) => {
      if (msg.type === 'hello') {
        setMySessionId(msg.payload.sessionId)
      } else if (msg.type === 'device.viewers' && msg.payload.deviceId === deviceId) {
        setViewers(msg.payload.viewers)
      } else if (msg.type === 'device.battery' && msg.payload.deviceId === deviceId) {
        setBattery(msg.payload.battery)
      } else if (msg.type === 'device.inspector.fallback' && msg.payload.deviceId === deviceId) {
        setInspectorFallback({ to: msg.payload.to, reason: msg.payload.reason })
      } else if (msg.type === 'device.inspector.status' && msg.payload.deviceId === deviceId && msg.payload.state === 'starting') {
        // A new session is negotiating its inspector from scratch — any
        // fallback reported for the previous session no longer applies (the
        // same reasoning `app/device/page.tsx`'s own identical handler
        // gives).
        setInspectorFallback(null)
      } else if (msg.type === 'device.status' && msg.payload.id === deviceId) {
        setDeviceDetail((d) => (d ? { ...d, status: msg.payload.status } : d))
      } else if (DeviceActivityMessage.safeParse(msg).success && msg.type === 'device.activity' && msg.payload.deviceId === deviceId) {
        setDeviceDetail((d) => (d ? applyActivityEvent(d, msg.payload) : d))
      }
    })
    return off
  }, [deviceId])

  // `Esc` closes the popup — see the file header's own precedence table
  // (plan 103 §3.5). `defaultPrevented` here is a complete answer for BOTH
  // rule 1 (a Radix dialog dismissed itself) and rule 2 (the canvas sent
  // `BACK`), because both are guaranteed to run and call `preventDefault()`
  // strictly before this bubble-phase `window` listener does.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== 'Escape') return
      if (e.defaultPrevented) return
      onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  // Reconnect/Disconnect/Cutover change `connection`/`serial`, which the
  // `device.status` broadcast handled above does not carry (the same reason
  // `app/device/page.tsx`'s own `reloadDevice` exists) — so `ActionsList`'s
  // three connection-changing rows re-fetch through this rather than
  // trusting a WS broadcast that was never going to arrive.
  function reloadDevice() {
    void api(`/api/devices/${deviceId}`, DeviceDetailResponseSchema)
      .then((b) => setDeviceDetail(b.device))
      .catch(() => undefined)
  }

  return (
    // The BAND (owner-reported 2026-08-17): a pointer-transparent, fixed strip
    // 92vw wide, centred in the viewport, whose ONLY jobs are to give the popup
    // below a definite width to be measured against and to be the `@container`
    // context its panels query. Both jobs need a separate element:
    // `container-type: inline-size` makes an element's inline size independent
    // of its contents, and the popup's width is derived FROM its contents
    // (plan 103 step 103.9), so the two cannot live on the same box. It also
    // fixes what a percentage means inside the popup — `max-w-full` on a
    // `fixed` box resolves against the whole viewport, but against this band it
    // resolves to the 92vw the popup is actually allowed.
    //
    // `pointer-events-none` (with `pointer-events-auto` back on the popup):
    // this strip spans the viewport horizontally, and without it the Wall
    // behind the popup would stop taking clicks either side of it.
    <div className="pointer-events-none fixed inset-x-[4vw] top-1/2 z-40 -translate-y-1/2 @container">
      <div
        role="region"
        aria-label={`Focused control — ${deviceName}`}
        className="pointer-events-auto mx-auto flex w-max max-w-full items-stretch gap-3 overflow-hidden resize-y @max-[600px]:w-full @max-[600px]:flex-col"
        style={{ height: 'min(88vh, 720px)', minWidth: 'min(420px, 100%)', minHeight: 360 }}
      >
        {/* Panel 1 — the hardware rail. Its own background/border/shadow, AND
            its own `self-start` (opting out of the container's
            `items-stretch` so it hugs its content height rather than
            stretching), live inside `HardwareRail.tsx` itself now (not
            applied here), since that component owns exactly what its panel
            looks like. */}
        {deviceDetail && (
          <HardwareRail
            deviceId={deviceId}
            inputEnabled={online}
            settings={deviceDetail.settings}
            onSettingsSaved={(s) => setDeviceDetail((d) => (d ? { ...d, settings: s } : d))}
          />
        )}

        {/* Panel 2 — the screen. Rendered UNCONDITIONALLY — never behind
            `fetchError` or any other flag — so React reconciles one element
            at one position and the instance survives every state change
            around it (plan 125 §0.7, §4.5, §5 step 125.10). */}
        <div className="flex min-h-0 min-w-0 max-w-max flex-1 flex-col @max-[600px]:max-w-full">
          <LiveView
            deviceId={deviceId}
            inputEnabled={online}
            quality="control"
            rail={false}
            fitContainer
            provisioning={provisioningOverlay}
          />
        </div>

        {/* Panel 3 — identity, session state, and the tabs. Its own header
            carries the device label and the Close button (`#01 - moto g06  X`
            in the owner's own reference) — there is no shared title bar
            spanning the container any more, so this is the only place either
            one is drawn. */}
        <aside className="flex w-72 shrink-0 flex-col overflow-hidden rounded-lg border border-line-strong bg-surface shadow-2xl @max-[600px]:w-full @max-[600px]:grow @max-[600px]:basis-0 @max-[600px]:min-h-0">
          <div className="flex shrink-0 items-center justify-between gap-3 border-b px-3 py-2">
            <div className="flex min-w-0 items-center gap-2">
              <ScreenShare className="size-4 shrink-0 text-accent-strong" aria-hidden />
              {/* Plan 124 §3.2, step 124.2 — the header the comment above
                  describes as `#01 - moto g06  X` in the owner's own
                  reference actually rendered the bare label. `<DeviceName>`
                  is the visual form: the number in its own dimmed span, the
                  label truncating beside it, and nothing at all rendered for
                  a device whose reservation was released (criterion 7). */}
              <DeviceName number={deviceDetail?.number} label={label} className="text-[13px] font-medium" />
              {deviceDetail && hasJob(deviceDetail) && <span className="rack-label text-led-active">busy</span>}
            </div>
            <div className="flex shrink-0 items-center gap-0.5">
              {/* Row 29 (audit) — a header affordance, not a 13th Actions row
                  (see the state comment above). Reuses `AskAnAgentDialog`
                  unchanged; it is an ordinary (modal) `Dialog`, not one of this
                  popup's non-modal action popups — the same accepted exception
                  `docs/design.md` already documents for the End-task
                  `AlertDialog`, since editing `AskAnAgentDialog.tsx` itself
                  (outside this plan's own file list) to grow a `nonModal`
                  path is out of scope here. */}
              {deviceDetail && (
                <Button variant="ghost" size="sm" aria-label="Ask an agent…" title="Ask an agent…" onClick={() => setAskAgentOpen(true)}>
                  <Bot className="size-4" aria-hidden />
                </Button>
              )}
              {/* "Open full device page" is `ActionsList`'s own row (plan 103
                  §4.2, item 12), not duplicated here — one link, not two, per
                  §4.2's own "displace, don't append" compactness rule. */}
              <Button variant="ghost" size="sm" aria-label="Close" onClick={onClose} className="shrink-0">
                <X className="size-4" aria-hidden />
              </Button>
            </div>
          </div>

          {/* The identity meta row (plan 103 §5, closing step 103.11's audit
              rows 20-22) — facts an operator LOOKS UP (viewers, group/
              stable-id/serial/engines) get a popover here rather than a row in
              `ActionsList`; battery/temperature are the one fact an operator
              WATCHES, so they render inline and unconditional, exactly as
              `docs/design.md` requires ("a warning nobody opens is not a
              warning") — never behind a click, same as `DeviceHeader.tsx`.
              Reuses the SAME extracted components that file uses, not thinner
              copies of them. Renders only once the device's own detail has
              loaded — there is nothing to look up before then. */}
          {deviceDetail && (
            <div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-3 py-1.5">
              {/* `deviceNumber` (plan 124 §4.4 Group B) — the chip's panel
                  writes outcome sentences naming the device ("The guest
                  agent is ready on … now."), which on a rack of identical
                  models named nothing at all until the number came with it. */}
              <AgentAlertChip
                agent={deviceDetail.agent ?? 'absent'}
                deviceId={deviceId}
                deviceLabel={deviceDetail.label}
                deviceNumber={deviceDetail.number}
              />
              <LabelStateBadge state={labelState} />
              <BatteryTempInline battery={battery ?? deviceDetail.battery ?? null} />
              <span className="ml-auto flex items-center gap-0.5">
                <ViewersPopover viewers={viewers} now={now} mySessionId={mySessionId} hoveredSessionId={hoveredSessionId} onHoverSession={setHoveredSessionId} />
                <DeviceDetailsPopover
                  device={deviceDetail}
                  registry={registry}
                  inspectorFallback={inspectorFallback}
                  agentVersion={agentVersion}
                  settingsHref={`/device?id=${encodeURIComponent(deviceId)}&tab=settings`}
                />
              </span>
            </div>
          )}

          {fetchError && <p className="shrink-0 border-b px-3 py-1.5 text-[11.5px] text-led-danger">{fetchError}</p>}

          <div className="flex min-h-0 flex-1 flex-col gap-3 p-3">
            {jobId && (
              <Button size="sm" variant="outline" className="w-full shrink-0 text-led-danger" onClick={() => setEndTaskOpen(true)}>
                <OctagonX className="size-3.5" aria-hidden />
                End task
              </Button>
            )}

            {deviceDetail && (
              <SidePanel
                deviceId={deviceId}
                device={deviceDetail}
                devices={devices}
                selectedIds={selectedIds}
                canUseLive={online}
                onDeviceReloaded={reloadDevice}
                onForgotten={onClose}
              />
            )}
          </div>
        </aside>

        {/* Row 29 (audit) — reuses `AskAnAgentDialog` unchanged, from the
            header's own Bot-icon button above. Modal (the component has no
            `nonModal` path, and it is outside this plan's own file list to add
            one) — the header comment above has the full reasoning. */}
        {deviceDetail && (
          <AskAnAgentDialog deviceId={deviceId} deviceLabel={deviceName} open={askAgentOpen} onOpenChange={setAskAgentOpen} />
        )}

        {jobId && (
          <AlertDialog open={endTaskOpen} onOpenChange={setEndTaskOpen}>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  End {jobLabel} on {deviceName}?
                </AlertDialogTitle>
                <AlertDialogDescription>The job stops immediately. This cannot be undone.</AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel disabled={isPending('end-task')}>Keep it running</AlertDialogCancel>
                <AlertDialogAction
                  disabled={isPending('end-task')}
                  className="bg-led-danger text-white hover:bg-led-danger/90"
                  onClick={async (e) => {
                    e.preventDefault()
                    await run('end-task', () => api(`/api/jobs/${jobId}/cancel`, JobCancelResponseSchema, { method: 'POST' }), {
                      success: 'Job ended',
                      failure: 'Could not end the job',
                    })
                    setEndTaskOpen(false)
                  }}
                >
                  {isPending('end-task') ? 'Ending…' : 'End task'}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        )}
      </div>
    </div>
  )
}
