'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { toast } from 'sonner'
import { ReconnectOutcomeSchema, ScriptListItemSchema, type Readiness } from '@enkaku/protocol'
import {
  Download,
  EthernetPort,
  ExternalLink,
  FileTerminal,
  FolderOpen,
  ListChecks,
  Moon,
  Play,
  RefreshCw,
  Settings as SettingsIcon,
  Sun,
  Trash2,
  Unplug,
  type LucideIcon,
} from 'lucide-react'
import type { ClusterInfo, DeviceInfo } from '@enkaku/protocol'
import { BulkForgetDialog } from '@/components/BulkForgetDialog'
import { OutcomeSummary } from '@/components/bulk/OutcomeSummary'
import { SkippedGroups, type NamedOutcome } from '@/components/bulk/SkippedGroups'
import { CutoverDialog } from '@/components/device/CutoverDialog'
import type { DeviceDetailInfo } from '@/components/device/DeviceHeader'
import { DisconnectDeviceDialog } from '@/components/DisconnectDeviceDialog'
import { ForgetDeviceDialog } from '@/components/ForgetDeviceDialog'
import { InstallBatchDialog } from '@/components/InstallBatchDialog'
import { deriveReadinessAction } from '@/components/ReadinessControl'
import { RunScriptDialog, type ScriptRow } from '@/components/RunScriptDialog'
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  api,
  describeApiError,
  useAction,
} from '@enkaku/ui'
import { setDeviceReadiness } from '@/lib/readiness'
import { fetchAllPages } from '@/lib/api'
import { AdbCommandDialog } from './AdbCommandDialog'
import { FilesPopup, JobsPopup } from './ReadPopups'
import { SettingsPopup } from './SettingsPopup'

/**
 * One row of the compact action list (plan 103 §4.2). A single shape for
 * every row — icon, label, and either an `onSelect` or a `disabledReason` —
 * so the list stays the fixed height it needs to be to fit without
 * scrolling (§4.2's own rule: anything that grows this list has to displace
 * something, not append to it). `disabledReason` renders a genuinely
 * `disabled`, tooltipped row rather than a link that looks dead but still
 * responds to a click (`docs/design.md`'s quality floor).
 */
function Row({
  icon: Icon,
  label,
  onSelect,
  disabledReason,
  trailing,
  href,
}: {
  icon: LucideIcon
  label: string
  onSelect?: () => void
  disabledReason?: string | null
  trailing?: React.ReactNode
  href?: string
}) {
  const disabled = Boolean(disabledReason)
  const body = (
    <div
      className={
        'flex h-8 items-center gap-2 rounded-md px-2 text-[12.5px] ' +
        (disabled ? 'text-fg-subtle' : 'text-fg hover:bg-surface-2')
      }
    >
      <Icon className="size-3.5 shrink-0" aria-hidden />
      <span className="flex-1 truncate text-left">{label}</span>
      {trailing}
    </div>
  )
  // A row with `trailing` but no `onSelect`/`href` of its own renders as a
  // plain, non-interactive container instead of a second nested `<button>`,
  // which would be invalid HTML and would give the row two competing
  // accessible names.
  //
  // Wake/Sleep used to be that row — it embedded `ReadinessControl`, which
  // brings its own `<Button>`, so the list read "Wake/Sleep" with a boxed
  // "Wake" beside it while every other row was click-the-row. It is an
  // ordinary `onSelect` row now (see its own comment below), and no row
  // currently takes this branch. It is kept rather than deleted because the
  // shape is still the correct answer if one ever needs a trailing readout —
  // but a row that needs a trailing CONTROL is a sign the list is being
  // asked to hold something that belongs in a popup.
  if (!href && !onSelect && !disabled) return body
  const interactive = href ? (
    <Link href={href} className="block">
      {body}
    </Link>
  ) : (
    <button type="button" className="block w-full" onClick={onSelect} aria-label={label}>
      {body}
    </button>
  )
  if (!disabled) return interactive
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* Styling-only disabled, never the `disabled` attribute — a
            disabled native button stops firing hover/focus events in some
            browsers, which would silence the tooltip explaining WHY. The
            click is what actually gates it (`preventDefault`, no handler
            beyond it), the same trick `DeviceHeader.tsx`'s own disabled
            Connection item uses for the identical reason. */}
        <div>
          <button type="button" className="block w-full cursor-not-allowed" aria-disabled aria-label={label} onClick={(e) => e.preventDefault()}>
            {body}
          </button>
        </div>
      </TooltipTrigger>
      <TooltipContent side="left" className="max-w-64">
        {disabledReason}
      </TooltipContent>
    </Tooltip>
  )
}

/**
 * The device popup's `Actions` tab (plan 103 §3.3, §4.2, §5 steps 103.3–
 * 103.6) — `Reconnect · Disconnect · [Move to the network…, USB only] ·
 * Install apk · Adb command · Run script · Wake/Sleep · Assist · Files ·
 * Jobs · Settings · Forget · Open full device page`, in that exact order.
 * Every ACTION dialog opened from here goes through 103.1's non-modal path
 * (`nonModal` on each dialog) so the live screen beside this list stays
 * visible and interactive while the dialog is open — the whole point of
 * this plan (§3.2); the READ popups (Jobs, Files — §3.3, step 103.4) and the
 * sectioned Settings popup (step 103.6) are always non-modal, with no
 * toggle, since nothing else ever opens them.
 *
 * Every row is real. Eleven open their existing dialog/popup
 * (`RunScriptDialog`, `AssistDialog` — that ONE dialog instance is owned and
 * rendered by `DevicePopup` itself, since its countdown banner lives above
 * the tabs; this row only calls `onAssistSelect` — `DisconnectDeviceDialog`,
 * `CutoverDialog`, `ForgetDeviceDialog`, `InstallBatchDialog`, `JobsPopup`,
 * `FilesPopup`, `SettingsPopup`, `AdbCommandDialog`); two need no dialog at
 * all (Reconnect fires directly; Wake/Sleep reuses `ReadinessControl`
 * unchanged). "Jobs" opens `JobsPopup`, which also carries Crashes and Logs
 * as its own internal tabs — a deliberate reading of a conflict between this
 * fixed twelve-row list (one row for this whole category) and step 103.4
 * naming four separate surfaces; see `ReadPopups.tsx`'s own doc comment for
 * the full reasoning, flagged in this plan's own status line as a judgement
 * call rather than an owner ruling.
 *
 * **The list is thirteen rows on a USB device, twelve on a TCP one — a
 * deliberate, conditional exception to the fixed-twelve rule, not a silent
 * 13th row (see the "Move to the network…" row's own comment below for the
 * full reasoning).** Before this fix, a USB device's "Reconnect" row
 * silently opened the cutover wizard instead of reconnecting — actively
 * misleading, and a live UX defect an operator hit this session, not a
 * design choice (`docs/plans/96-m61-hotfixes.md`). Reconnect now always
 * reconnects; the cutover wizard has its own honestly-named row.
 *
 * **"Adb command" opens a modal, not a side-panel tab (plan 103 §9 Q4,
 * answered 2026-08-16).** It used to switch `SidePanel` to a "Terminal" tab
 * — the owner asked twice for one thing instead, device-aware and able to
 * run on several devices at once, with output visible live. `SidePanel` no
 * longer has a Terminal tab at all (see that file's own doc comment); this
 * row now opens `AdbCommandDialog` (`./AdbCommandDialog.tsx`), which carries
 * the SAME `TerminalPane` for a single device (the interactive session, not
 * dropped — just relocated) and the fleet console's own `RunReport` for a
 * cluster or a multi-device selection.
 *
 * **This list is now also what the right-click context menu renders (plan
 * 103 §5 step 103.10)**, not a copy of it — `components/wall/
 * DeviceContextMenu.tsx` mounts this same component through `SidePanel`.
 * The old context menu acted on a SELECTION (`Wake selected`, `Forget
 * selected`); this list, historically, acted on the one FOCUSED device only
 * (`deviceId`/`device`), which is why merging the two wordings needed more
 * than renaming — a row that silently kept acting on one device while a
 * multi-selection sat behind it would have been the exact "quietly drops a
 * capability" failure the merge exists to remove, not a cosmetic difference.
 * `candidateIds` below (`deviceId` unioned with `selectedIds` — the SAME
 * union `initialSelectedIds`/`defaultInstallDevices` already computed for
 * `RunScriptDialog`/`InstallBatchDialog`/`AdbCommandDialog`'s own
 * `TargetPicker` defaults) is now also what **Wake/Sleep** and **Forget**
 * act on: at exactly one candidate, both render byte-for-byte the same as
 * before this step (the existing "twelve rows, no more" test is unchanged);
 * at more than one, Wake/Sleep becomes two explicit rows (a single dynamic
 * label cannot describe eight devices in mixed states) reporting through
 * `OutcomeSummary`/`SkippedGroups` (the same shape `app/page.tsx`'s own
 * `wakeOrSleepSelected` already used, moved here rather than reinvented),
 * and Forget opens `BulkForgetDialog` (fleet-wide typed confirmation)
 * instead of the single-device `ForgetDeviceDialog`. This also fixes a
 * latent gap in `DevicePopup` itself: opening the popup with a live Wall
 * selection behind it already arms Mirror and states "Input reaches N
 * devices" (plan 104 §3.3), but Wake/Sleep/Forget from the SAME Actions tab
 * silently touched only the one focused device until now — not a
 * context-menu-only fix.
 *
 * **Not every old context-menu capability gained a row.** "Push file…" /
 * "Pull file…" (`BulkTransferDialog`) and "Apply labels" (`POST
 * /api/devices/labels/apply`) have no home in this fixed list — neither did
 * before this step (plan 104 §10 already recorded the Push/Pull gap for
 * this exact list, unresolved through two plans), and §4.2's own list is
 * already at its budget once Wake/Sleep's conditional second row is counted.
 * Both stay reachable exactly as they always have: the Wall's own floating
 * selection toolbar (`app/page.tsx`, unchanged by this step) calls the
 * identical `applyLabelsToSelected`/`setBulkTransferOpen` handlers the old
 * context menu called — so this is a route removed, not a capability lost.
 * Named here, not silently dropped, per this step's own instruction.
 */
export function ActionsList({
  deviceId,
  device,
  devices,
  selectedIds = [],
  assistState,
  canUseLive,
  onAssistSelect,
  onDeviceReloaded,
  onForgotten,
}: {
  deviceId: string
  device: DeviceDetailInfo
  /**
   * Plan 104 (M69) §3.2 — the Wall's full (unfiltered) device list, the
   * same pool `DevicePopup` already carries for Mirror's own candidate set.
   * Every action dialog opened from this list that offers `devices`/
   * `cluster` modes needs the WHOLE pool to pick from, not just this one
   * focused device.
   */
  devices: DeviceInfo[]
  /**
   * Plan 104 (M69) §3.2 — the Wall's own live selection (unioned with
   * `deviceId` below before being handed to a dialog as its pre-fill):
   * "a device popup while N devices are selected arrives pre-filled with
   * those N". Empty by default so every existing caller keeps today's
   * single-device default until it is wired to the Wall's own state.
   */
  selectedIds?: readonly string[]
  /**
   * `'unavailable'` — nobody holds the device, Assist has nothing to do.
   * `'off'` — the farm turned co-control off.
   * `'busy'` — already assisting; the countdown/Stop-assisting control lives
   *   in the banner above the tabs, not duplicated here.
   * `'available'` — the row is a live button.
   */
  assistState: 'unavailable' | 'off' | 'busy' | 'available'
  /** `iHoldControl && !busy` — the real manual lease, never an Assist grant. Gates the Files popup's own mutating controls, the same fact the device page's Files tab reads. */
  canUseLive: boolean
  onAssistSelect: () => void
  /** Called after Reconnect, Disconnect, Cutover, or a Settings save changes the device — the caller re-fetches it. */
  onDeviceReloaded: () => void
  /** Called after a successful Forget/Block — the device just left the fleet, so the caller closes the whole popup. */
  onForgotten: () => void
}) {
  const { run } = useAction()
  // Derived once, read by the Wake/Sleep row below — the same helper
  // `ReadinessControl` uses, so the two can never disagree about which
  // action a device is currently offering.
  const readinessAction = deriveReadinessAction(device.readiness)
  const readinessUnreachable = device.status === 'offline' || device.status === 'quarantined'
  const [scripts, setScripts] = useState<ScriptRow[]>([])
  const [clusters, setClusters] = useState<ClusterInfo[]>([])
  const [runOpen, setRunOpen] = useState(false)
  const [installOpen, setInstallOpen] = useState(false)
  const [disconnectOpen, setDisconnectOpen] = useState(false)
  const [cutoverOpen, setCutoverOpen] = useState(false)
  const [forgetOpen, setForgetOpen] = useState(false)
  const [filesOpen, setFilesOpen] = useState(false)
  const [jobsOpen, setJobsOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [adbOpen, setAdbOpen] = useState(false)
  // Plan 103 §5 step 103.10 — Wake/Sleep's own bulk report, the same
  // `OutcomeSummary`/`SkippedGroups` shape `app/page.tsx`'s own
  // `wakeOrSleepSelected` already used for the identical operation from the
  // selection toolbar; moved here, not reinvented, so a right-click "Sleep"
  // on eight devices names every refusal exactly as the toolbar's own
  // button already does.
  const [readinessReport, setReadinessReport] = useState<{ verb: 'Wake' | 'Sleep'; okCount: number; total: number; refused: NamedOutcome[] } | null>(
    null,
  )

  // Fetched once, the same list the device page loads for its own Run
  // script dialog (`ScriptListItemSchema` — plan 95 §5 step 95.5, F8: a
  // `paramsSchema` is author-controlled input, parsed here rather than
  // trusted). Dev-slot scripts (`GET /api/plugins/dev`) are deliberately not
  // merged in here — they never survive a restart, and this popup's own
  // scope (step 103.3) is the six dialogs that already exist, not full G1
  // parity with the device page's dev-slot support.
  useEffect(() => {
    let cancelled = false
    void fetchAllPages('/api/scripts', undefined, ScriptListItemSchema)
      .then((rows) => {
        if (!cancelled) setScripts((rows as ScriptRow[]).filter((s) => s.enabled))
      })
      .catch(() => {
        if (!cancelled) setScripts([])
      })
    return () => {
      cancelled = true
    }
  }, [])

  // Plan 104 (M69) §3.4 — Install apk's own `TargetPicker` needs a cluster
  // list to offer `cluster` mode at all, the same list `RunScriptDialog`
  // already fetches for itself.
  useEffect(() => {
    let cancelled = false
    void fetchAllPages<ClusterInfo>('/api/clusters')
      .then((rows) => {
        if (!cancelled) setClusters(rows)
      })
      .catch(() => {
        if (!cancelled) setClusters([])
      })
    return () => {
      cancelled = true
    }
  }, [])

  const isUsb = (device.connection?.kind ?? 'usb') === 'usb'

  // Plan 103 §5 step 103.10 — the ONE candidate set every target-aware row
  // below reads: the focused device unioned with whatever is selected
  // behind it (the Wall's own selection, or the empty set from a popup
  // opened with nothing else selected). This is the SAME union
  // `initialSelectedIds`/`defaultInstallDevices` below already computed
  // ad hoc for `RunScriptDialog`/`InstallBatchDialog` — pulled into one
  // memo so Wake/Sleep and Forget can read the identical set rather than
  // each re-deriving their own.
  const candidateIds = useMemo(() => [...new Set([deviceId, ...selectedIds])], [deviceId, selectedIds])
  const candidateDevices = useMemo(() => devices.filter((d) => candidateIds.includes(d.id)), [devices, candidateIds])

  // Plan 104 (M69) §3.2's own table: nothing else selected → this row's
  // dialogs default to `deviceId`, single; N devices selected on the Wall
  // behind this popup → they arrive pre-filled with the union of `deviceId`
  // and that selection, `devices` mode — still fully editable either way
  // (§3.2's "the default is a starting point, never a lock"). `undefined`
  // (not `[]`) when nothing else is selected, so `computeDefaultTarget`
  // falls through to its single-device branch instead of a one-device
  // "devices" mode.
  const initialSelectedIds = candidateIds.length > 1 ? candidateIds : undefined
  // `InstallBatchDialog` takes its pre-fill as a `DeviceInfo[]` (not a
  // separate initial-ids prop, unlike `RunScriptDialog`/`useTargetSelection`
  // context) — so the same union above becomes a device LIST here.
  const defaultInstallDevices = initialSelectedIds ? candidateDevices : [device]

  // Plan 103 §5 step 103.10 — Wake/Sleep on the WHOLE candidate set, one
  // `PUT .../readiness` per device settled independently (`Promise.
  // allSettled`, exactly `wakeOrSleepSelected`'s own shape) so one device's
  // refusal (a running job, another viewer) never blocks the rest. Only
  // reached when `candidateIds.length > 1` — the single-candidate case below
  // keeps calling `setDeviceReadiness` directly, unchanged.
  async function bulkSetReadiness(desired: Readiness, verb: 'Wake' | 'Sleep') {
    const ids = candidateIds
    const results = await Promise.allSettled(ids.map((id) => setDeviceReadiness(id, desired)))
    const okCount = results.filter((r) => r.status === 'fulfilled').length
    const refused: NamedOutcome[] = results.flatMap((r, i) => {
      if (r.status === 'fulfilled') return []
      const id = ids[i]
      if (!id) return []
      return [{ deviceId: id, label: devices.find((d) => d.id === id)?.label ?? id, reason: describeApiError(r.reason) }]
    })
    setReadinessReport({ verb, okCount, total: ids.length, refused })
  }

  const reconnect = () =>
    run(
      'popup-reconnect',
      () => api(`/api/devices/${deviceId}/connection/reconnect`, ReconnectOutcomeSchema, { method: 'POST', json: {} }),
      {
        failure: 'Could not reconnect the device',
        onSuccess: (outcome) => {
          if (outcome.result === 'already-connected') toast.success(`${device.label} is already connected`)
          else if (outcome.result === 'connected') toast.success(`${device.label} reconnected from ${outcome.address}`)
          else if (outcome.result === 'not-found')
            toast.error(`Could not find ${device.label} on the network`, { description: 'It did not answer at any remembered address.' })
          else toast.error(`Could not reconnect ${device.label}`, { description: outcome.detail })
          onDeviceReloaded()
        },
      },
    )

  return (
    <div className="space-y-0.5">
      {/* Two verbs, two rows — "Reconnect" always redials (§4.2's own
          words: "dials its last known address"), on USB and TCP alike (a
          USB device that adb still lists is an immediate `already-connected`
          no-op, which is a legitimate, honest answer, not a dead click).
          Before this fix, a USB device's "Reconnect" row silently opened the
          cutover wizard instead — actively misleading, since an operator
          reading "Reconnect" expects a redial of a connection that already
          existed, never "move this phone to the network" (found in-browser
          this session; see `docs/plans/96-m61-hotfixes.md` for the entry). */}
      <Row icon={RefreshCw} label="Reconnect" onSelect={() => void reconnect()} />
      <Row
        icon={Unplug}
        label="Disconnect"
        onSelect={isUsb ? undefined : () => setDisconnectOpen(true)}
        disabledReason={isUsb ? 'adb has no way to release a single USB transport. Unplug the cable to disconnect it.' : null}
      />
      {/* The cutover wizard's own honest row (plan 88 §3.4 — "Move
          {device.label} to the network", `CutoverDialog.tsx:152`'s own
          dialog title). USB-only, matching `DeviceHeader.tsx`'s identical
          Connection-group item and its own reasoning: a device already on
          the network has nowhere left to move TO with this flow.

          §4.2's list is fixed at twelve for the common case, and growing it
          is supposed to displace something rather than be appended (§4.2's
          own words) — but there IS already a precedent for a DELIBERATE,
          conditional exception rather than a silent 13th row: Wake/Sleep
          below grows from one row to two only once there is more than one
          candidate, because a single dynamic label genuinely cannot
          describe eight devices in mixed states (plan 103 §5 step 103.10).
          The same reasoning applies here in the other direction — this row
          only exists at all for a USB device (never for one already on the
          network), so the list is thirteen rows on a USB device and twelve
          on a TCP one, never thirteen unconditionally. Nothing else in the
          fixed list was a good candidate to displace instead: every other
          row names a capability with no natural second reading to fold this
          one into (unlike Disconnect/Reconnect, which stay two rows for the
          identical reason — DeviceHeader.tsx's own Connection group already
          proves three independent rows read correctly together, and
          collapsing two of them here to make room would reintroduce a
          different version of the exact ambiguity this whole fix exists to
          remove). This dialog stays single-device, deliberately, matching
          plan 104 §10's own recorded reasoning for `CutoverDialog.tsx`
          ("there is no multi-device reading of 'cut this device over' that
          means anything" for a row bound to one focused device) — the
          Devices page's own fleet menu ("Move to network…",
          `BulkCutoverDialog.tsx`) is where targeting several phones at once
          lives. */}
      {isUsb && <Row icon={EthernetPort} label="Move to the network (Wi-Fi/OTG)…" onSelect={() => setCutoverOpen(true)} />}
      <Row icon={Download} label="Install apk" onSelect={() => setInstallOpen(true)} />
      <Row icon={FileTerminal} label="Adb command" onSelect={() => setAdbOpen(true)} />
      <Row icon={Play} label="Run script" onSelect={() => setRunOpen(true)} />
      {/* One row, one action, named for what it will do — not a row whose
          label lists both states with a second button bolted to its right.
          `ReadinessControl` was reused here verbatim at first, and it brings
          its own `<Button>`: the row then read "Wake/Sleep" with a boxed
          "Wake" beside it, so every other row in this list was "click the
          row" while this one was "click the thing inside the row". The
          owner reported it on sight.
          Only the WIDGET is dropped. `deriveReadinessAction` (the same
          helper `ReadinessControl` itself calls) still decides the label,
          and `setDeviceReadiness` still performs it, so plan 49 §3.2's rule
          survives intact: the label comes from `actual`, never `desired` —
          reading `desired` produced two reported bugs, a label flipping to
          "Sleep" the instant Wake was pressed, and a device sitting at
          `desired: asleep` by design while its control still said "Wake".
          `transitioning` deliberately does not disable the row, for the
          reason that component's own comment gives at length: `desired !==
          actual` is a normal steady state for as long as anyone is watching
          the device, so treating it as in-flight left Sleep permanently
          dead. The server stays the only gate.

          Plan 103 §5 step 103.10 — a single dynamic-label row cannot
          describe eight devices in mixed readiness states, so at more than
          one candidate this becomes two explicit rows instead (the old
          context menu's own "Wake selected"/"Sleep selected" wording,
          unconditional regardless of any one device's current state) —
          exactly what the row count stays 12 for at the default,
          single-candidate case (the existing "twelve rows" test is
          unaffected), and grows by one only while a multi-selection makes
          the extra row meaningful. */}
      {candidateIds.length > 1 ? (
        <>
          <Row icon={Sun} label="Wake" onSelect={() => void bulkSetReadiness('awake', 'Wake')} />
          <Row icon={Moon} label="Sleep" onSelect={() => void bulkSetReadiness('asleep', 'Sleep')} />
        </>
      ) : (
        <Row
          icon={Moon}
          label={readinessAction.label}
          onSelect={() => {
            void run(`readiness-${device.id}`, () => setDeviceReadiness(device.id, readinessAction.target), {
              failure: `Could not ${readinessAction.label.toLowerCase()} ${device.label}`,
            })
          }}
          disabledReason={readinessUnreachable ? `Device is ${device.status} — readiness cannot be changed` : null}
        />
      )}
      <Row
        icon={ListChecks}
        label={assistState === 'busy' ? 'Assisting' : 'Assist'}
        onSelect={assistState === 'available' ? onAssistSelect : undefined}
        disabledReason={
          assistState === 'unavailable'
            ? 'Only needed while someone else holds this device.'
            : assistState === 'off'
              ? 'Assisting is turned off for this farm.'
              : assistState === 'busy'
                ? 'Already assisting — see the banner above for the countdown and Stop assisting.'
                : null
        }
      />
      <Row icon={FolderOpen} label="Files" onSelect={() => setFilesOpen(true)} />
      <Row icon={ListChecks} label="Jobs" onSelect={() => setJobsOpen(true)} />
      <Row icon={SettingsIcon} label="Settings" onSelect={() => setSettingsOpen(true)} />
      {/* Plan 103 §5 step 103.10 — the same row, but WHICH dialog it opens
          now depends on the candidate set: one device keeps the existing
          `ForgetDeviceDialog` (delete-history switch, "Block instead" on
          refusal — real per-device state `BulkForgetDialog` does not carry,
          plan 104 §10's own reason for never routing this row through it);
          more than one opens `BulkForgetDialog` (fleet-wide typed
          confirmation), matching the old context menu's own "Forget
          selected" rather than silently forgetting only the focused device
          out of a visible multi-selection. */}
      <Row icon={Trash2} label="Forget" onSelect={() => setForgetOpen(true)} />
      <Row icon={ExternalLink} label="Open full device page" href={`/device?id=${encodeURIComponent(deviceId)}`} />

      {/* Plan 104 (M69) §3.2 — no longer `lockedDevice`: the popup's own
          focus device is still the default (`initialDevice`), but the
          operator can switch to Cluster or Multiple devices, and a live
          Wall selection behind this popup arrives pre-filled
          (`initialSelectedIds`). `devices` is the Wall's WHOLE pool, not
          just this one device, so the picker has something to pick from
          once switched. */}
      <RunScriptDialog
        script={null}
        scripts={runOpen ? scripts : undefined}
        devices={devices}
        initialDevice={deviceId}
        initialSelectedIds={initialSelectedIds}
        onClose={() => setRunOpen(false)}
        onLaunched={() => setRunOpen(false)}
        nonModal
      />
      <InstallBatchDialog
        open={installOpen}
        onOpenChange={setInstallOpen}
        devices={defaultInstallDevices}
        allDevices={devices}
        clusters={clusters}
        nonModal
      />
      <DisconnectDeviceDialog device={device} open={disconnectOpen} onOpenChange={setDisconnectOpen} onDone={onDeviceReloaded} nonModal />
      <CutoverDialog device={device} open={cutoverOpen} onOpenChange={setCutoverOpen} onDone={onDeviceReloaded} nonModal />
      {candidateIds.length > 1 ? (
        <BulkForgetDialog devices={candidateDevices} allDevices={devices} open={forgetOpen} onOpenChange={setForgetOpen} onDone={onForgotten} nonModal />
      ) : (
        <ForgetDeviceDialog device={device} open={forgetOpen} onOpenChange={setForgetOpen} onDone={onForgotten} nonModal />
      )}
      {/* Plan 103 §9 Q4 (answered 2026-08-16) — see `AdbCommandDialog.tsx`'s
          own doc comment. `selectedIds` (the RAW Wall selection, not the
          `deviceId`-unioned `initialSelectedIds` above) is passed straight
          through — the dialog does that same union itself. */}
      <AdbCommandDialog
        deviceId={deviceId}
        devices={devices}
        selectedIds={selectedIds}
        clusters={clusters}
        canUseLive={canUseLive}
        open={adbOpen}
        onOpenChange={setAdbOpen}
      />
      <FilesPopup deviceId={deviceId} canUse={canUseLive} open={filesOpen} onOpenChange={setFilesOpen} />
      <JobsPopup
        deviceId={deviceId}
        deviceLabel={device.label}
        deviceOffline={device.status === 'offline'}
        open={jobsOpen}
        onOpenChange={setJobsOpen}
      />
      <SettingsPopup
        deviceId={deviceId}
        device={device}
        canUse={canUseLive}
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        onDeviceUpdated={onDeviceReloaded}
      />
      {/* Plan 103 §5 step 103.10 — Wake/Sleep's own bulk report, only ever
          populated by `bulkSetReadiness` (the `candidateIds.length > 1`
          branch above). The single-candidate row keeps its existing
          `useAction` toast — unchanged — so this dialog only ever appears
          for the case it exists to name. */}
      <Dialog open={readinessReport !== null} onOpenChange={(o) => !o && setReadinessReport(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{readinessReport?.verb} — result</DialogTitle>
          </DialogHeader>
          {readinessReport && (
            <div className="space-y-3">
              <OutcomeSummary
                counts={{ ok: readinessReport.okCount, failed: readinessReport.refused.length, skipped: 0, total: readinessReport.total }}
                label={`${readinessReport.verb} progress`}
              />
              <SkippedGroups failed={readinessReport.refused} skipped={[]} />
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setReadinessReport(null)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
