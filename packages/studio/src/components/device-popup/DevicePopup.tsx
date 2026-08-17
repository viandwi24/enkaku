'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Bot, OctagonX, ScreenShare, X } from 'lucide-react'
import {
  DeviceDetailResponseSchema,
  DeviceLabelStateSchema,
  DeviceViewersResponseSchema,
  JobCancelResponseSchema,
  SettingsResponseSchema,
  type BatteryState,
  type CoControlMode,
  type DeviceInfo,
  type DeviceLabelState,
  type DevicePreparation,
  type DeviceStatus,
  type LeaseHolder,
  type MirrorMember,
  type MirrorResult,
  type RegistryResponse,
  type Viewer,
} from '@enkaku/protocol'
import { LiveView } from '@/components/LiveView'
import { AskAnAgentDialog } from '@/components/AskAnAgentDialog'
import { AssistDialog } from '@/components/device/AssistDialog'
import { AgentAlertChip } from '@/components/guest-agent/AgentAlertChip'
import { LabelStateBadge } from '@/components/device/LabelStateBadge'
import {
  BatteryTempInline,
  DeviceDetailsPopover,
  ViewersPopover,
  mmss,
  type DeviceDetailInfo,
} from '@/components/device/DeviceHeader'
import { fetchRegistry } from '@/components/schema-form/useEnumSource'
import { LoadingRows } from '@/components/states'
import { TakeControlDialog } from '@/components/TakeControlDialog'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { api, useAction } from '@/lib/actions'
import { fetchGuestAgentStatus } from '@/lib/api'
import { newId, ws } from '@/lib/ws'
import { useNow } from '@/lib/useNow'
import { usePreparation } from '@/lib/use-preparation'
import { assistEndCopy, assistRowState, useControlState } from './ControlState'
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

/** How many candidate devices a Mirror group needs before it means anything — one device mirroring itself is just ordinary control. */
const MIN_MIRROR_DEVICES = 2

/** Milliseconds an accidental "Release control" click stays reversible for
 * (plan 105 §5 step 105.5) — long enough to notice and undo, short enough
 * that a genuine release still takes effect promptly. Deliberately not a
 * `ConfirmDialog` (see the file header): the lease stays with THIS client
 * the whole time it counts down, so nobody else can claim the device while
 * it does — an accidental click costs nothing, rather than needing a second
 * click of permission up front the way a modal would for every release.
 * Exported so `DevicePopup.test.tsx` can size its own `waitFor` timeouts
 * against the real value instead of a duplicated guess. */
export const RELEASE_UNDO_MS = 4_000

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
 * | 1 | An open action/read popup (Run script, Assist, Disconnect, Forget, the Jobs/Files/Settings popups, …) | The popup is open, regardless of anything else | The popup closes itself; nothing below ever sees the key |
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
 * Verified empirically, not merely reasoned about: `DevicePopup.test.tsx`'s
 * own Esc-precedence describe block proves rule 1 against a real dialog;
 * `DevicePopup.escape.test.tsx` proves all three against a real `LiveView`
 * canvas; `DevicePopup.escape-precedence.test.tsx` (step 103.7) reproduces
 * this exact table as data and drives one scenario per row from it.
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
 * **Quick control, not a takeover — auto-claim only.** An idle device is
 * claimed automatically on open — the owner's own "double-click to focus
 * remote control" (plan 91 §0.3) — with no separate Take-control step. A
 * device already held by a job or another person is never AUTO-claimed from
 * here.
 *
 * **One control state, not two competing buttons (plan 105, M70).** This
 * component used to dead-end at Assist the moment someone else held the
 * device (plan 103 step 103.11's audit, row 26: *"A device already held by a
 * job or another person is never … taken over from here"*), and gave up a
 * lease it claimed only via the server's own idle timeout — never voluntarily
 * (row 27). Both are closed now: `useControlState` (`./ControlState.tsx`) is
 * the ONE place that decides which single action a device's current state
 * offers — `free` → Take control, `held-by-job` → Assist (the owner's own
 * ruling, plan 91 §0.3: a warning, not a permission request) with a
 * `TakeControlDialog` reachable beside it (which, for a job, correctly shows
 * "View job"/"Close" rather than a takeover button — a job's hold is never
 * takeable), `held-by-human` → both Assist and Take control, deliberately
 * weighted equally because plan 105 §9 Q1 is still open, `i-hold` → Release
 * control (row 27's own fix — `lease.release` is sent from THIS popup for
 * the first time), `i-assist` → Stop assisting. See `./ControlState.tsx`'s
 * own file header for the full design and for why the wall tile and the
 * device card read the SAME hook rather than inventing their own notion of
 * what is on offer.
 *
 * **Two more owner-reported defects, folded into this same plan (105.5,
 * 105.6) rather than a separate pass — both are "a hold ends, and the
 * operator is left with no way back or no way to know":**
 *
 * - **105.5 — releasing control left no way back, and one accidental click
 *   away from another operator or a queued job claiming the device.** Two
 *   different fixes for two different halves: (1) the `free` state below now
 *   renders its own "Take control" row — before this it only ever showed
 *   for the OTHER four states, so a device that became free (by this
 *   client's own release, or anyone else's) had no visible way back short of
 *   switching to the Inspector tab's inline prompt. (2) Release itself is no
 *   longer instantaneous: clicking it starts a `RELEASE_UNDO_MS` countdown
 *   (`requestReleaseControl`/`undoRelease`/`commitRelease` below) — the lease
 *   is NOT given up until the countdown elapses, so an accidental click is
 *   free to reverse with one more click, at zero risk (nobody else can claim
 *   the device while this client still holds it). Deliberately NOT a
 *   `ConfirmDialog`: `docs/design.md`'s own rule is that a confirm guarding
 *   an irreversible action must name the thing at stake, never ask "are you
 *   sure" — but an undo window makes the action reversible instead of
 *   asking permission for it twice, and does not cost a click on every
 *   ordinary, intentional release the way a modal would.
 * - **105.6 — a lease this popup auto-claimed on open should give way when
 *   the popup closes, but ONLY when opening this popup is the reason it
 *   exists.** `leaseOrigin` (below) tracks exactly that: `'auto-claim'` for
 *   the initial claim effect's own idle-device claim, `'explicit'` for
 *   every operator-initiated acquire (`claimControl`, `TakeControlDialog`'s
 *   `onTaken`). **The rule is deliberately narrower than "release on
 *   close"**: if the operator pressed Take control, or already held the
 *   device before this popup opened, closing it must NOT take the device
 *   from them — they may be about to run something. Only `'auto-claim'`
 *   releases on unmount (`leaseOriginRef`/`controlExpiresAtRef` mirror the
 *   state into refs so the unmount cleanup — which runs after this render
 *   has already been torn down — reads the LATEST values, the same pattern
 *   `mirrorGroupIdRef` already uses just below for the identical reason).
 *   Navigating away within Studio (no full page reload) unmounts this
 *   component the ordinary React way, so the SAME cleanup covers it — no
 *   separate code path needed. Tab close / hard navigation is different: the
 *   WS connection drops, and the server's own `handleClose` already releases
 *   every lease that client holds (regardless of origin) as part of its
 *   existing disconnect teardown — but that is a best-effort race against
 *   the browser actually delivering the close frame before the process dies,
 *   so a `pagehide`/`beforeunload` listener below sends the SAME best-effort
 *   `lease.release` (auto-claim origin only) one more way. Neither is a
 *   guarantee — the real backstop, for every path, is still the server's own
 *   idle timeout; this is belt-and-suspenders on top of it, not a
 *   replacement for it. A future reader who "simplifies" this into an
 *   unconditional release-on-close will silently break the explicit-hold
 *   case (row above) — the two are deliberately different rules for
 *   deliberately different situations, not one rule stated twice.
 */
export function DevicePopup({
  deviceId,
  devices,
  selectedIds,
  onClose,
}: {
  deviceId: string
  /** The Wall's full (unfiltered) device list — labels/status for the Mirror candidate set, never fetched a second time. */
  devices: DeviceInfo[]
  /** The Wall's own selection (plan 91 §5 step 91.8) — unioned with `deviceId` itself to form Mirror's candidate set. */
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
  const [controlExpiresAt, setControlExpiresAt] = useState<number | null>(null)
  // Plan 105 §5 step 105.6 — WHY this client holds the manual lease, not just
  // whether it does: `'auto-claim'` only for the initial-open claim below,
  // `'explicit'` for every operator-initiated acquire. See the file header
  // for the full rule this drives (release-on-close applies to the first,
  // never the second).
  const [leaseOrigin, setLeaseOrigin] = useState<'auto-claim' | 'explicit' | null>(null)
  // Plan 105 §5 step 105.5 — Release is no longer instantaneous: clicking it
  // starts an undo countdown (`requestReleaseControl` below) rather than
  // sending `lease.release` immediately, so an accidental click costs
  // nothing while the countdown is still running.
  const [releasePending, setReleasePending] = useState(false)
  const [assisting, setAssisting] = useState<{ expiresAt: number; primary: LeaseHolder } | null>(null)
  const [assistOpen, setAssistOpen] = useState(false)
  // Audit row 26 (plan 105 §5 step 105.1) — reaches `TakeControlDialog` from
  // the popup for the first time, whether the current holder is a job (the
  // dialog itself then shows "View job"/"Close", never a takeover button —
  // `holder.takeable` is `false`) or another person (a real forced takeover).
  const [takeOverOpen, setTakeOverOpen] = useState(false)
  const [notice, setNotice] = useState<{ message: string; offerTakeControl: boolean } | null>(null)
  const [coControlMode, setCoControlMode] = useState<CoControlMode>('operator')
  const [assistGrantTtlSec, setAssistGrantTtlSec] = useState(300)

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

  // Mirror (plan 91 §3.8, §3.9) — this popup's own client-side state for
  // the ONE group it may own; `mirror.stop` on unmount (below) means no
  // group ever outlives the panel that was driving it.
  const [mirrorGroupId, setMirrorGroupId] = useState<string | null>(null)
  const [mirrorMembers, setMirrorMembers] = useState<MirrorMember[]>([])
  const [mirrorStarting, setMirrorStarting] = useState(false)
  const [mirrorLastResults, setMirrorLastResults] = useState<MirrorResult[] | null>(null)
  const [mirrorResultsOpen, setMirrorResultsOpen] = useState(false)
  const [soloToggle, setSoloToggle] = useState(false)
  const [altHeld, setAltHeld] = useState(false)
  const [endTaskOpen, setEndTaskOpen] = useState(false)

  const now = useNow()
  const { run, isPending } = useAction()

  const mirrorGroupIdRef = useRef(mirrorGroupId)
  mirrorGroupIdRef.current = mirrorGroupId

  // Plan 105 §5 step 105.6 — read by the unmount/unload cleanups below,
  // which run after this render's own closures are stale (the same reason
  // `mirrorGroupIdRef` above exists).
  const leaseOriginRef = useRef(leaseOrigin)
  leaseOriginRef.current = leaseOrigin
  const controlExpiresAtRef = useRef(controlExpiresAt)
  controlExpiresAtRef.current = controlExpiresAt
  // Plan 105 §5 step 105.5 — the pending undo timer; a plain ref (not
  // state) since only `requestReleaseControl`/`undoRelease` ever touch it,
  // and neither needs a re-render to do so.
  const releaseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const label = deviceDetail?.label ?? deviceId
  const status: DeviceStatus | null = deviceDetail?.status ?? null
  const busy = status === 'busy'
  const iHoldControl = controlExpiresAt !== null
  const iAmAssisting = assisting !== null
  const inputEnabled = (iHoldControl && !busy) || iAmAssisting
  const assistSecondsLeft = assisting === null ? null : Math.max(0, Math.round((assisting.expiresAt - now) / 1000))
  // The manual lease's own countdown (plan 105 §5 step 105.1) — this popup
  // never showed one before; it lives beside the new "Release control"
  // button (audit row 27) the same way `DeviceHeader.tsx`'s identical
  // countdown lives beside its own "Release control" on the legacy page.
  const secondsLeft = controlExpiresAt === null ? null : Math.max(0, Math.round((controlExpiresAt - now) / 1000))
  const jobId = deviceDetail?.heldBy?.kind === 'job' ? deviceDetail.heldBy.id : null
  const solo = altHeld || soloToggle

  // Fetch the focus device's own detail, and quietly claim it if nobody else
  // holds it (see the file header — no "Take control" rail item exists on
  // purpose). Deliberately does NOT reset `mirrorGroupId`/`mirrorMembers`
  // below: a Mirror group belongs to this whole popup SESSION, not to
  // whichever tile happens to be focused inside it — switching which member
  // you are looking at must not silently stop driving the rest (plan 91 §3.9).
  useEffect(() => {
    let cancelled = false
    setDeviceDetail(null)
    setFetchError(null)
    setControlExpiresAt(null)
    setLeaseOrigin(null)
    cancelPendingRelease()
    setAssisting(null)
    setNotice(null)
    void api(`/api/devices/${deviceId}`, DeviceDetailResponseSchema)
      .then((b) => {
        if (cancelled) return
        setDeviceDetail(b.device)
        if (b.device.status === 'idle') {
          void ws
            .request({ type: 'lease.acquire', id: newId(), payload: { deviceId } })
            .then((res) => {
              if (cancelled) return
              // Plan 105 §5 step 105.6 — the ONE place `leaseOrigin` becomes
              // `'auto-claim'`: this is the popup claiming an idle device for
              // itself on open ("Quick control, not a takeover" — the file
              // header), never something the operator asked for directly.
              if (res.type === 'lease.acquired') {
                setControlExpiresAt(res.payload.expiresAt * 1000)
                setLeaseOrigin('auto-claim')
              }
            })
            .catch(() => {
              // Lost a race to someone else on a busy wall — not an error
              // worth a red banner. The `lease.changed`/`device.status`
              // handlers below pick up the real holder the moment the
              // broadcast lands, and the Assist row picks it up from there.
            })
        }
      })
      .catch((e) => {
        if (!cancelled) setFetchError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      cancelled = true
    }
  }, [deviceId])

  useEffect(() => {
    void api('/api/settings', SettingsResponseSchema)
      .then((b) => {
        setCoControlMode(b.settings.coControl.mode)
        setAssistGrantTtlSec(b.settings.coControl.grantTtlSec)
      })
      .catch(() => undefined)
  }, [])

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
        if (msg.payload.status !== 'manual' && msg.payload.status !== 'busy') {
          setControlExpiresAt(null)
          setLeaseOrigin(null)
          cancelPendingRelease()
        }
      } else if (msg.type === 'lease.changed' && msg.payload.deviceId === deviceId) {
        setDeviceDetail((d) => (d ? { ...d, heldBy: msg.payload.heldBy } : d))
      } else if (msg.type === 'lease.revoked' && msg.payload.deviceId === deviceId) {
        setControlExpiresAt(null)
        setLeaseOrigin(null)
        // A pending undo (plan 105 §5 step 105.5) is moot once the lease is
        // gone some OTHER way (a forced takeover, the server's own idle
        // timeout) — without this, "Releasing… Undo" could keep showing for
        // a hold this client no longer has.
        cancelPendingRelease()
      } else if (msg.type === 'assist.changed' && msg.payload.deviceId === deviceId) {
        setDeviceDetail((d) => (d ? { ...d, assistedBy: msg.payload.assistedBy } : d))
      } else if (msg.type === 'assist.stopped' && msg.payload.deviceId === deviceId) {
        setAssisting(null)
        // Plan 105 (M70) §3.4/§5 step 105.3 — every reason but the
        // operator's own "Stop assisting" click gets its own wording
        // (`assistEndCopy`, `./ControlState.tsx`), and `primary_ended` (§3.3)
        // also flags `offerTakeControl` — the notice below renders a real
        // Take control button for it, not just a fact, because the device
        // just became free at the exact moment access to it was withdrawn.
        setNotice(assistEndCopy(msg.payload.reason, assistGrantTtlSec))
      } else if (msg.type === 'mirror.changed' && mirrorGroupIdRef.current && msg.payload.groupId === mirrorGroupIdRef.current) {
        setMirrorMembers(msg.payload.members)
      }
    })
    return off
    // `assistGrantTtlSec` is included so `assistEndCopy`'s `ttl` wording
    // (which names the real duration) is never built from a stale default —
    // it only ever changes once, when `/api/settings` resolves.
  }, [deviceId, assistGrantTtlSec])

  // Leaving the group behind when the panel closes (unmount, not merely a
  // focus change — see the effect above) is the honest counterpart of plan
  // 91's own "orphaned mirror groups" leak detector: this client stops
  // producing input for it the instant the popup is gone, so the group
  // should not linger server-side either.
  useEffect(
    () => () => {
      const groupId = mirrorGroupIdRef.current
      if (groupId) ws.send({ type: 'mirror.stop', payload: { groupId } })
    },
    [],
  )

  // Plan 105 §5 step 105.5 — a pending undo timer is a plain `setTimeout`,
  // not tied to any `useEffect`'s own cleanup, so nothing cancels it if the
  // popup closes mid-countdown on its own. Without this, closing the popup
  // right after clicking Release control (before the undo window elapses)
  // would leave the timer running in the background, only to fire
  // `commitRelease` — and its `lease.release` — later, for a component that
  // no longer exists. Harmless server-side (`lease.release` is a no-op for a
  // client that no longer holds the lease — the same tolerance `assist.stop`
  // gets), but there is no reason to leave a stray timer and a stray
  // message pending at all.
  useEffect(() => () => {
    if (releaseTimerRef.current) clearTimeout(releaseTimerRef.current)
  }, [])

  // Plan 105 §5 step 105.6 — release a lease this popup auto-claimed for
  // itself on open, but never one the operator explicitly took or already
  // held before opening (the file header has the full rule). Depends on
  // `deviceId` deliberately: if the focused device ever changes without a
  // remount, this cleanup must run for the OLD device before the fetch
  // effect above claims the new one, not just once at final unmount.
  useEffect(
    () => () => {
      if (leaseOriginRef.current === 'auto-claim' && controlExpiresAtRef.current !== null) {
        ws.send({ type: 'lease.release', payload: { deviceId } })
      }
    },
    [deviceId],
  )

  // Same rule, for the paths that are not a React unmount at all: tab close
  // and hard navigation. Best-effort only — `pagehide` fires more reliably
  // than `beforeunload` across browsers (bfcache, mobile Safari), so both
  // are wired to the same handler rather than picking one. The server's own
  // `handleClose` (WS-disconnect teardown) already releases every lease this
  // client holds regardless of origin, and the idle timeout is the backstop
  // behind THAT — this is one more best-effort attempt layered on top, never
  // the thing anything here actually depends on for correctness.
  useEffect(() => {
    function releaseIfAutoClaimed() {
      if (leaseOriginRef.current === 'auto-claim' && controlExpiresAtRef.current !== null) {
        ws.send({ type: 'lease.release', payload: { deviceId } })
      }
    }
    window.addEventListener('pagehide', releaseIfAutoClaimed)
    window.addEventListener('beforeunload', releaseIfAutoClaimed)
    return () => {
      window.removeEventListener('pagehide', releaseIfAutoClaimed)
      window.removeEventListener('beforeunload', releaseIfAutoClaimed)
    }
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

  // `Alt` for solo (plan 91 §3.9) — held, not toggled; `blur` clears it so an
  // Alt-Tab away from the browser never leaves it stuck down.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Alt') setAltHeld(true)
    }
    function onKeyUp(e: KeyboardEvent) {
      if (e.key === 'Alt') setAltHeld(false)
    }
    function onBlur() {
      setAltHeld(false)
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
    }
  }, [])

  function noteActivity() {
    if (assisting) setAssisting((a) => (a ? { ...a, expiresAt: Date.now() + assistGrantTtlSec * 1000 } : a))
  }

  function stopAssisting() {
    ws.send({ type: 'assist.stop', payload: { deviceId } })
    setAssisting(null)
  }

  // The Inspector tab's own inline "take control" prompt (plan 103 §5 step
  // 103.5) — the SAME `lease.acquire` request the initial claim effect above
  // sends for an idle device on open, exposed here because a device that was
  // free when the popup opened can still be held by someone else by the time
  // the operator switches to Inspector (Assist does not grant `inspect.*` —
  // plan 91 §3.4 lists exactly five input verbs, and inspecting is not one
  // of them — so Assist alone can never satisfy this button).
  function claimControl() {
    void ws
      .request({ type: 'lease.acquire', id: newId(), payload: { deviceId } })
      .then((res) => {
        // Plan 105 §5 step 105.6 — an operator-initiated acquire is always
        // `'explicit'`: this button only exists because the operator pressed
        // it (the free-state row, or the Inspector tab's inline prompt), so
        // closing the popup afterward must not take the device back from
        // them (the file header has the full rule).
        if (res.type === 'lease.acquired') {
          setControlExpiresAt(res.payload.expiresAt * 1000)
          setLeaseOrigin('explicit')
        }
      })
      .catch((err) => setNotice({ message: err instanceof Error ? err.message : String(err), offerTakeControl: false }))
  }

  // Audit row 27 (plan 105 §5 step 105.1) — the first thing in this popup
  // that ever sends `lease.release`, now via the undo window below rather
  // than immediately (plan 105 §5 step 105.5).
  function commitRelease() {
    releaseTimerRef.current = null
    ws.send({ type: 'lease.release', payload: { deviceId } })
    setControlExpiresAt(null)
    setLeaseOrigin(null)
    setReleasePending(false)
  }

  /** "Release control" itself — starts the undo countdown instead of
   * releasing immediately. Optimistic about nothing yet: unlike the old
   * immediate release, this makes NO server request until the countdown
   * elapses, so there is nothing to roll back if the operator changes their
   * mind. */
  function requestReleaseControl() {
    setReleasePending(true)
    releaseTimerRef.current = setTimeout(commitRelease, RELEASE_UNDO_MS)
  }

  /** Cancels a pending undo timer, if any, WITHOUT sending anything — shared
   * by the explicit "Undo" click and by every path that makes the countdown
   * moot on its own (the device left this client's hold some other way
   * while it was counting down). */
  function cancelPendingRelease() {
    if (releaseTimerRef.current) {
      clearTimeout(releaseTimerRef.current)
      releaseTimerRef.current = null
    }
    setReleasePending(false)
  }

  const undoRelease = cancelPendingRelease

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

  // Plan 105 (M70) §5 step 105.1 — the ONE hook that decides which single
  // action this device's current state offers (`./ControlState.tsx`'s own
  // file header has the full design). `myLeaseExpiresAt`/`myAssistGrant` are
  // THIS client's own tracked facts (`controlExpiresAt`/`assisting` above),
  // never derived from comparing `deviceDetail.heldBy.id` to anything — see
  // `UseControlStateInput`'s own doc comment for why that comparison is
  // unreliable once a farm has real auth.
  const controlState = useControlState({
    status,
    heldBy: deviceDetail?.heldBy ?? null,
    myLeaseExpiresAt: controlExpiresAt,
    myAssistGrant: assisting,
    coControlMode,
  })
  // `ActionsList`'s own pre-existing "Assist" row shape (`SidePanel.tsx`'s
  // `assistState` prop) — still derived from the SAME `controlState` above,
  // never recomputed independently (see `assistRowState`'s own doc comment).
  const assistState = assistRowState(controlState)

  // Why the Inspector tab's inline "take control" cannot be pressed right
  // now, or null when it can — same rule `app/device/page.tsx`'s own
  // `takeControlReason` follows (plan 59 §3.1: a precondition the operator
  // can satisfy stays a live button; one they cannot is genuinely disabled
  // and names the state it needs).
  const takeControlReason = iHoldControl
    ? null
    : deviceDetail?.heldBy
      ? `Control is held by ${deviceDetail.heldBy.label}.`
      : status === 'idle' || status === null
        ? null
        : 'The device is unavailable'

  const candidateIds = useMemo(() => [...new Set([deviceId, ...selectedIds])], [deviceId, selectedIds])
  const candidateDevices = useMemo(() => devices.filter((d) => candidateIds.includes(d.id)), [devices, candidateIds])
  const canStartMirror = candidateDevices.length >= MIN_MIRROR_DEVICES

  async function startMirror() {
    setMirrorStarting(true)
    try {
      const res = await ws.request({
        type: 'mirror.start',
        id: newId(),
        payload: { focusDeviceId: deviceId, deviceIds: candidateIds },
      })
      if (res.type === 'mirror.started') {
        setMirrorGroupId(res.payload.groupId)
        setMirrorMembers(res.payload.members)
        setMirrorLastResults(null)
      }
    } catch (err) {
      toast.error('Could not start mirroring', { description: err instanceof Error ? err.message : String(err) })
    } finally {
      setMirrorStarting(false)
    }
  }

  function stopMirror() {
    const groupId = mirrorGroupIdRef.current
    if (!groupId) return
    ws.send({ type: 'mirror.stop', payload: { groupId } })
    setMirrorGroupId(null)
    setMirrorMembers([])
    setMirrorLastResults(null)
  }

  // Plan 104 (M69) §3.3 — mirror arms itself from the SELECTION; there is no
  // switch to press. `candidateKey` is the candidate set's own identity (its
  // ids, order-independent) — the effect only (re)acts when that identity
  // actually changes, not on every render `candidateIds` gets a fresh array
  // reference. Fewer than two candidates means mirroring would just be
  // ordinary control of one device, so nothing starts (and anything running
  // stops the moment the selection drops back below two — the operator
  // manages the SELECTION now, not a separate on/off control, per §3.3's own
  // "make the selection the thing an operator manages").
  const candidateKey = [...candidateIds].sort().join(',')
  const armedKeyRef = useRef<string | null>(null)
  useEffect(() => {
    if (!canStartMirror) {
      armedKeyRef.current = null
      if (mirrorGroupIdRef.current) stopMirror()
      return
    }
    if (armedKeyRef.current === candidateKey) return
    armedKeyRef.current = candidateKey
    if (mirrorGroupIdRef.current) {
      ws.send({ type: 'mirror.stop', payload: { groupId: mirrorGroupIdRef.current } })
      setMirrorGroupId(null)
      setMirrorMembers([])
      setMirrorLastResults(null)
    }
    void startMirror()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candidateKey, canStartMirror])

  function labelFor(id: string): string {
    return mirrorMembers.find((m) => m.deviceId === id)?.label ?? devices.find((d) => d.id === id)?.label ?? id
  }

  const activeMemberCount = mirrorMembers.filter((m) => m.mode !== 'skipped').length
  const okResultCount = mirrorLastResults?.filter((r) => r.ok).length ?? 0
  const failedResults = mirrorLastResults?.filter((r) => !r.ok) ?? []
  // Plan 104 §3.3 — the number the "Input reaches" statement below actually
  // shows: the live group's active members, unless "Focused only"/Alt has
  // narrowed input back down to just this one device.
  const reachCount = mirrorGroupId && !solo ? activeMemberCount : 1

  return (
    <div
      role="region"
      aria-label={`Focused control — ${label}`}
      // The TRANSPARENT container (plan 103's layout restructure, landed
      // alongside 103.4–103.7 — see this plan's own status-line note): no
      // background, no border, no shadow of its own. Three independently
      // chromed panels sit inside it, the Wall visible through the gaps
      // between them, matching the owner's own reference (Android Studio's
      // emulator model — a control strip that floats beside the device
      // window but travels with it). `resize` stays HERE, on the
      // container, never on an individual panel: resizing this box resizes
      // all three panels together as one object, which is the entire point
      // of the reference being one container rather than three
      // independently draggable windows.
      //
      // `items-stretch` (the flex default) makes the CENTRE and RIGHT
      // panels share one height — both stretch to fill this container's
      // fixed height exactly. The RAIL opts out with its own `self-start`
      // (set on `HardwareRail`'s own root element, not here) so it hugs its
      // buttons' natural height instead of stretching tall to match —
      // owner-reported: the rail must never grow taller than its own
      // content, only the centre/right pair share a height.
      //
      // `overflow-hidden`, not `overflow-auto` — this container itself must
      // never scroll (nor may the columns wrapper that used to sit inside
      // it, now removed): every panel handles its own sizing internally
      // (the screen panel SHRINKS via `LiveView`'s own `fitContainer`
      // prop; the actions panel is the only one that may ever scroll, and
      // only inside its own tab content — `SidePanel.tsx`'s own comment).
      // `overflow-hidden` (rather than `visible`) is what the native CSS
      // `resize` handle needs to render at all.
      //
      // Plan 103 step 103.9 — `resize-y`, not `resize` (both axes): WIDTH is
      // no longer something the operator drags directly. This container has
      // no `width` of its own below (only `maxWidth`, a viewport safety
      // rail), which — combined with `position: fixed` and only ONE inset
      // (`left`) set — makes its computed width shrink-to-fit its three
      // children (rail + centre + actions), exactly the standard CSS
      // algorithm a floated or absolutely-positioned box with an `auto`
      // width already uses. The centre panel's own width comes from
      // `LiveView`'s `fitContainer` sizing effect (picture aspect ratio ×
      // available height); this container simply hugs whatever that
      // resolves to, so the popup's total width becomes
      // rail + picture + actions, and resizing the HEIGHT (the one
      // dimension still directly draggable) is what makes the width follow.
      className="fixed left-1/2 top-1/2 z-40 flex -translate-x-1/2 -translate-y-1/2 items-stretch gap-3 overflow-hidden resize-y"
      style={{ height: 'min(88vh, 720px)', maxWidth: '92vw', minWidth: 420, minHeight: 360 }}
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
          inputEnabled={inputEnabled}
          onActivity={noteActivity}
          mirror={mirrorGroupId ? { groupId: mirrorGroupId, solo } : undefined}
          settings={deviceDetail.settings}
          onSettingsSaved={(s) => setDeviceDetail((d) => (d ? { ...d, settings: s } : d))}
        />
      )}

      {/* Panel 2 — the screen. `LiveView`'s own outer element already draws
          a rounded, bordered, `bg-surface` box with the status line
          ("● Streaming · fps · WxH · codec") at its own top — that IS this
          panel's chrome, so nothing wraps it in a second one (a wrapper here
          would double the border/background `LiveView` already draws). This
          is also why the status line already lives INSIDE the centre panel
          rather than in a bar spanning the whole popup: it always has, since
          `LiveView` renders it internally regardless of `rail`.
          `fitContainer` (owner-specified): this panel is the one that gives
          way when the popup is resized. Plan 103 step 103.9: it now takes
          the PICTURE's own aspect ratio rather than whatever width `flex-1`
          left over — `LiveView`'s own sizing effect computes an explicit
          pixel width from the stream's aspect ratio and the height it is
          given, so this wrapper only needs `min-h-0` for HEIGHT; it no
          longer claims leftover WIDTH (`flex-1` dropped) — the OUTER
          container above hugs whatever width `LiveView` resolves to
          instead. */}
      <div className="flex min-h-0 flex-col">
        {deviceDetail ? (
          <LiveView
            deviceId={deviceId}
            inputEnabled={inputEnabled}
            onActivity={noteActivity}
            quality="control"
            rail={false}
            fitContainer
            mirror={mirrorGroupId ? { groupId: mirrorGroupId, solo, onResult: setMirrorLastResults } : undefined}
            provisioning={provisioningOverlay}
          />
        ) : (
          !fetchError && (
            // A plausible fixed width before the device's own detail (and so
            // `LiveView`'s own aspect-ratio-derived width) exists yet — the
            // wrapper above no longer has a `flex-1` to fall back on for
            // this branch either.
            <div className="w-80 flex-1 rounded-lg border border-line-strong bg-surface p-3 shadow-2xl">
              <LoadingRows rows={2} />
            </div>
          )
        )}
      </div>

      {/* Panel 3 — identity, session state, and the tabs. Its own header
          carries the device label and the Close button (`#01 - moto g06  X`
          in the owner's own reference) — there is no shared title bar
          spanning the container any more, so this is the only place either
          one is drawn. */}
      {/* `overflow-hidden` on the panel itself (never `overflow-auto`) — the
          panel's OWN edges must stay clean; the one thing allowed to scroll
          is `SidePanel`'s Actions tab content, deep inside, in its own
          bounded box (see that file's own comment). */}
      <aside className="flex w-72 shrink-0 flex-col overflow-hidden rounded-lg border border-line-strong bg-surface shadow-2xl">
        <div className="flex shrink-0 items-center justify-between gap-3 border-b px-3 py-2">
          <div className="flex min-w-0 items-center gap-2">
            <ScreenShare className="size-4 shrink-0 text-accent-strong" aria-hidden />
            <span className="truncate text-[13px] font-medium">{label}</span>
            {busy && <span className="rack-label text-led-active">busy</span>}
          </div>
          <div className="flex shrink-0 items-center gap-0.5">
            {/* Row 29 (audit) — a header affordance, not a 13th Actions row
                (see the state comment above). Reuses `AskAnAgentDialog`
                unchanged; it is an ordinary (modal) `Dialog`, not one of this
                popup's non-modal action popups — the same accepted exception
                `docs/design.md` already documents for the Mirror-confirm and
                End-task `AlertDialog`s, since editing `AskAnAgentDialog.tsx`
                itself (outside this plan's own file list) to grow a
                `nonModal` path is out of scope here. */}
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
            rows 20-22) — facts an operator LOOKS UP (viewers, cluster/
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
            <AgentAlertChip agent={deviceDetail.agent ?? 'absent'} />
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

        {notice && (
          <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b px-3 py-1.5 text-[11.5px] text-led-warn">
            <span>{notice.message}</span>
            {/* `primary_ended` (plan 105 §3.3) — the device just became free
                at the exact moment access to it was withdrawn, so the notice
                offers Take control in place rather than going quiet. */}
            {notice.offerTakeControl && (
              <button
                type="button"
                className="shrink-0 text-[11px] font-medium underline-offset-2 hover:underline"
                onClick={() => {
                  setNotice(null)
                  claimControl()
                }}
              >
                Take control
              </button>
            )}
          </div>
        )}
        {fetchError && <p className="shrink-0 border-b px-3 py-1.5 text-[11.5px] text-led-danger">{fetchError}</p>}

        <div className="flex min-h-0 flex-1 flex-col gap-3 p-3">
          {/* Session state — control state, Assist countdown, Mirror, End
              task. Not part of plan §4.2's fixed 12-row Actions list (they
              are cross-cutting session facts, not one-off device actions),
              so they stay above the tabs rather than inside `SidePanel`'s
              `Actions` tab. Plan 105 (M70) §5 step 105.1: every branch below
              reads `controlState`, the ONE hook that decides which single
              action is on offer — see `./ControlState.tsx`'s own header. */}
          {/* Plan 105 §5 step 105.5 — the round trip: `free` used to render
              NOTHING here (this session panel only ever showed for the other
              four states), so a device that became free — by this client's
              own release, or anyone else's — had no visible way back short
              of switching to the Inspector tab. Release → re-take is now one
              click, in the same place Release control itself lives. */}
          {controlState.kind === 'free' && (
            <div className="flex shrink-0 items-center justify-between rounded-lg border p-2.5">
              <span className="text-[11.5px] text-fg-muted">Nobody holds this device.</span>
              <Button
                size="sm"
                variant="secondary"
                className="h-6 px-2 text-[11px]"
                disabled={Boolean(controlState.primary.disabledReason)}
                title={controlState.primary.disabledReason ?? undefined}
                onClick={claimControl}
              >
                {controlState.primary.label}
              </Button>
            </div>
          )}

          {controlState.kind === 'held-by-job' && (
            <div className="shrink-0 space-y-1 rounded-lg border p-2.5">
              <p className="text-[11.5px] leading-relaxed text-fg-muted">
                <span className="readout text-fg">{controlState.holder.label}</span> is running on this device.
              </p>
              {/* Audit row 26 (plan 105) — reachable even though a job's
                  hold is never takeable: `TakeControlDialog` itself shows
                  "View job"/"Close" for this case, correctly, rather than a
                  takeover button. */}
              <button
                type="button"
                className="text-[11px] text-fg-muted underline-offset-2 hover:text-fg hover:underline"
                onClick={() => setTakeOverOpen(true)}
              >
                {controlState.secondary.label}
              </button>
            </div>
          )}

          {controlState.kind === 'held-by-human' && (
            <div className="shrink-0 space-y-1.5 rounded-lg border p-2.5">
              <p className="text-[11.5px] leading-relaxed text-fg-muted">
                <span className="readout text-fg">{controlState.holder.label}</span> is using this device now.
              </p>
              {/* Plan 105 §9 Q1 — deliberately undecided: both actions are
                  offered, weighted equally, and the caption says so plainly
                  rather than silently picking one for the operator. */}
              <p className="text-[11px] text-fg-subtle">Join them, or take over — not decided which should be the default here.</p>
              <div className="flex gap-2">
                {controlState.options.map((opt) =>
                  opt.kind === 'assist' ? (
                    <Button
                      key={opt.kind}
                      size="sm"
                      variant="outline"
                      className="h-6 px-2 text-[11px]"
                      disabled={Boolean(opt.disabledReason)}
                      title={opt.disabledReason ?? undefined}
                      onClick={() => setAssistOpen(true)}
                    >
                      {opt.label}
                    </Button>
                  ) : (
                    <Button
                      key={opt.kind}
                      size="sm"
                      variant="outline"
                      className="h-6 px-2 text-[11px]"
                      onClick={() => setTakeOverOpen(true)}
                    >
                      {opt.label}
                    </Button>
                  ),
                )}
              </div>
            </div>
          )}

          {controlState.kind === 'i-hold' && (
            <div className="flex shrink-0 items-center justify-between rounded-lg border p-2.5">
              <span className="readout text-[11px] text-fg-muted">{mmss(secondsLeft ?? 0)}</span>
              {/* Audit row 27 (plan 105) — the popup can finally give up a
                  lease it claimed, rather than only ever losing it to the
                  server's idle timeout. Plan 105 §5 step 105.5: the click
                  starts an undo window instead of releasing immediately — an
                  accidental click is free to reverse, at zero risk, since
                  the lease has not actually moved yet. */}
              {releasePending ? (
                <Button size="sm" variant="outline" className="h-6 px-2 text-[11px]" onClick={undoRelease}>
                  Releasing… Undo
                </Button>
              ) : (
                <Button size="sm" variant="secondary" className="h-6 px-2 text-[11px]" onClick={requestReleaseControl}>
                  {controlState.primary.label}
                </Button>
              )}
            </div>
          )}

          {controlState.kind === 'i-assist' && (
            <div className="shrink-0 space-y-1 rounded-lg border border-led-warn p-2.5">
              <p className="rack-label text-led-warn">Assisting — {controlState.primaryHolder.label} still has control</p>
              <div className="flex items-center justify-between">
                <span className="readout text-[11px] text-led-warn">{mmss(assistSecondsLeft ?? 0)}</span>
                <button
                  type="button"
                  onClick={stopAssisting}
                  className="text-[11px] text-fg-muted underline-offset-2 hover:text-fg hover:underline"
                >
                  {controlState.primary.label}
                </button>
              </div>
            </div>
          )}

          {/* Plan 104 (M69) §3.3 — no switch: mirror arms itself the moment
              the candidate set (this device plus whatever is selected on
              the Wall behind the popup) reaches two, and disarms itself the
              moment it drops back below two. What used to be a control the
              operator flips is now a STATEMENT — "how many devices the
              current input reaches" — because the selection is already
              visible (an accent border/tint on every selected tile, the
              cursor badge naming the count at two or more, plan 101) and
              restating it here a second time is what the switch used to do
              redundantly. `reachCount` folds in `solo`/Alt-held: a live
              group of N still reaches only THIS one device while "Focused
              only" (or Alt) is held, and the statement says so rather than
              quoting the group size while input is actually narrowed. */}
          {/* Rendered only when it has something to say (owner's call,
              2026-08-16). On one device this panel read "Input reaches — 1
              device" inside a popup that is visibly showing one device, plus
              a sentence explaining a switch that no longer exists. Both
              restate what is already on screen, which is the same noise the
              cursor badge was trimmed for: it appears at two or more, not at
              one.
              At two or more it is not noise — it is the safety basis for
              having removed the switch at all (§3.3: the selection is the
              consent, so the count a tap will reach has to be visible before
              the tap). So the rule is "show it when the answer is not
              obvious", never "show it always" or "never show it". */}
          {(mirrorGroupId || mirrorStarting || reachCount > 1) && (
          <div className="shrink-0 space-y-2 rounded-lg border p-2.5">
            <div className="flex items-center justify-between">
              <span className="rack-label">Input reaches</span>
              <span className="readout text-[13px] font-medium">
                {reachCount} device{reachCount === 1 ? '' : 's'}
              </span>
            </div>
            {mirrorStarting && <p className="text-[11px] text-fg-subtle">Arming…</p>}
            {mirrorGroupId && (
              <>
                <p className="readout text-[11px] text-fg-muted">
                  {activeMemberCount} / {mirrorMembers.length} devices active
                </p>
                <label className="flex items-center justify-between gap-2 text-[11px] text-fg-muted">
                  Focused only
                  <Switch size="sm" checked={solo} disabled={altHeld} onCheckedChange={setSoloToggle} />
                </label>
                <p className="text-[11px] text-fg-subtle">Hold Alt to send to just this device for a moment.</p>
                {mirrorLastResults && mirrorLastResults.length > 0 && (
                  <div>
                    <button
                      type="button"
                      className="readout text-[11px] underline-offset-2 hover:underline"
                      onClick={() => setMirrorResultsOpen((o) => !o)}
                    >
                      {okResultCount}/{mirrorLastResults.length}
                    </button>
                    {mirrorResultsOpen && failedResults.length > 0 && (
                      <ul className="mt-1 space-y-0.5 text-[11px] text-fg-subtle">
                        {failedResults.map((r) => (
                          <li key={r.deviceId}>
                            {labelFor(r.deviceId)} — {r.code ?? 'failed'}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
          )}

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
              assistState={assistState}
              canUseLive={iHoldControl && !busy}
              takeControlDisabledReason={takeControlReason}
              onAssistSelect={() => setAssistOpen(true)}
              onDeviceReloaded={reloadDevice}
              onForgotten={onClose}
              onClaimControl={claimControl}
            />
          )}
        </div>
      </aside>

      {/* Assist (plan 91 §3.2, §3.12) — reuses `AssistDialog` unchanged,
          opened from `ActionsList`'s own "Assist" row through this popup's
          `assistOpen` state; ONE instance, non-modal (plan 103 §3.2). */}
      {deviceDetail?.heldBy && (
        <AssistDialog
          deviceId={deviceId}
          deviceLabel={label}
          primary={deviceDetail.heldBy}
          grantTtlSec={assistGrantTtlSec}
          open={assistOpen}
          onOpenChange={setAssistOpen}
          onAssisted={(expiresAtMs, primary) => setAssisting({ expiresAt: expiresAtMs, primary })}
          nonModal
        />
      )}

      {/* Row 29 (audit) — reuses `AskAnAgentDialog` unchanged, from the
          header's own Bot-icon button above. Modal (the component has no
          `nonModal` path, and it is outside this plan's own file list to add
          one) — the header comment above has the full reasoning. */}
      {deviceDetail && <AskAnAgentDialog deviceId={deviceId} deviceLabel={label} open={askAgentOpen} onOpenChange={setAskAgentOpen} />}

      {/* Take over (plan 105 §5 step 105.1, audit row 26) — reuses
          `TakeControlDialog` unchanged (per this plan's own instruction: "do
          not write a second"), non-modal for the same reason `AssistDialog`
          above is. Correctly informational rather than actionable when the
          holder is a job (`holder.takeable` is `false`), and a real forced
          takeover when it is a person or an agent. */}
      {deviceDetail?.heldBy && (
        <TakeControlDialog
          deviceId={deviceId}
          deviceLabel={label}
          holder={deviceDetail.heldBy}
          open={takeOverOpen}
          onOpenChange={setTakeOverOpen}
          // Plan 105 §5 step 105.6 — a forced takeover is always `'explicit'`
          // (see the file header): the operator deliberately took the
          // device, so closing the popup afterward must not give it up.
          onTaken={(expiresAtSec) => {
            setControlExpiresAt(expiresAtSec * 1000)
            setLeaseOrigin('explicit')
          }}
          nonModal
        />
      )}

      {jobId && (
        <AlertDialog open={endTaskOpen} onOpenChange={setEndTaskOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                End {deviceDetail?.heldBy?.label ?? 'this job'} on {label}?
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
  )
}
