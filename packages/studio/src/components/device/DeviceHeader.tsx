'use client'

import { useState } from 'react'
import Link from 'next/link'
import {
  Battery,
  BatteryCharging,
  Bot,
  Check,
  Copy,
  EthernetPort,
  Eye,
  Hand,
  Info,
  MoreVertical,
  Play,
  RefreshCw,
  Settings,
  Thermometer,
  Trash2,
  TriangleAlert,
  Unplug,
} from 'lucide-react'
import type { BatteryState, DeviceInfo, DeviceLabelState, DeviceStatus, LeaseHolder, RegistryResponse, Viewer } from '@enkaku/protocol'
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  cn,
  formatDeviceName,
} from '@enkaku/ui'
import { AgentAlertChip } from '@/components/guest-agent/AgentAlertChip'
import { LabelStateBadge } from '@/components/device/LabelStateBadge'
import { DeviceStatusBadge } from '@/components/StatusBadge'
import { PageHeader } from '@/components/layout/PageHeader'
import { ViewerList } from '@/components/ViewerList'
import { UNAVAILABLE_REASON } from '@/components/DevicePicker'
import { AskAnAgentDialog } from '@/components/AskAnAgentDialog'
import { HolderBadge } from '@/components/HolderBadge'
import { TakeControlDialog } from '@/components/TakeControlDialog'

/**
 * The device page's header (plan 57 §4.1).
 *
 * It exists because the right column did not: four stacked panels held an
 * 18rem column open at all times for facts that are mostly *looked up*, not
 * watched (§3.3). Each one is placed here by how it is used —
 *
 * - battery and temperature are read passively while working, so they are
 *   inline and never behind a hover: they are the farm's early warning for a
 *   phone cooking itself, and a warning nobody opens is not a warning;
 * - the viewer count is watched, the viewer list is looked up — count inline,
 *   list in a popover;
 * - the engines matter only when one has fallen back, so they live in the `ⓘ`
 *   popover until that happens and then get promoted to a visible chip
 *   (plan 34 §3.1);
 * - stable id, serial, api level, screen, density are looked up rarely — `ⓘ`;
 * - `Remove device` is not reversible the way `Run a script` is, so it sits in
 *   the same `⋮` menu the fleet card already uses for it (§3.6).
 *
 * No hooks of its own: every value is a prop, so the derived states below can
 * be tested by calling this function directly (the workspace has no DOM
 * renderer — see `TileChips.test.tsx` for the established pattern).
 */

/** The device's effective engines — from GET /api/devices/:id. */
export interface DeviceDetailInfo extends DeviceInfo {
  transport: string
  display: string
  /**
   * Plan 100 §4.3, step 100.6 (closes G11/96.22) — the engine ACTUALLY
   * running, sourced live from the open session; `null` when no session is
   * open. Can legitimately disagree with `display` above (the CONFIGURED
   * engine) — a device on the screencap-loop fallback reports
   * `display: 'scrcpy'` (nothing rewrote the stored setting) while
   * `liveDisplay: 'screencap-loop'` says what is actually being served.
   */
  liveDisplay: string | null
  input: string
  inspection: string
  settings: unknown
  /**
   * Set only for a node-owned (cloud) device — there is no local `Inspector`
   * to attach to (plan 56 §2 non-goals), so the screen card's `Inspect` mode is
   * disabled rather than left to dead-end at a server refusal.
   */
  nodeId: string | null
}

export const ENGINE_ROWS = [
  { key: 'transport', label: 'transport', reg: 'transports' },
  { key: 'display', label: 'video', reg: 'displays' },
  { key: 'input', label: 'input', reg: 'inputs' },
  { key: 'inspection', label: 'inspection', reg: 'inspectors' },
] as const

/** The same thresholds the fleet card paints with, so one device never looks hot in two places and fine in a third. */
const HOT_C = 45
const LOW_BATTERY_PCT = 20

export function engineName(registry: RegistryResponse | null, key: string, id: string): string {
  const entries = registry?.[key as keyof RegistryResponse] as Array<{ id: string; displayName: string }> | undefined
  return entries?.find((e) => e.id === id)?.displayName ?? id
}

export function mmss(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

/**
 * Battery level and temperature, inline and unconditional (plan 103 §5 —
 * closes step 103.11's audit row 22). Extracted so `DevicePopup.tsx` can
 * mount the SAME warning this header always has, rather than a thinner
 * reimplementation of it — `docs/design.md`'s own words: *"the farm's early
 * warning for a phone cooking itself, and a warning nobody opens is not a
 * warning."* Renders nothing while `battery` is `null` (not yet known),
 * exactly like the inline block this replaces.
 */
export function BatteryTempInline({ battery }: { battery: BatteryState | null }) {
  if (!battery) return null
  const charging = battery.status === 'charging'
  const hot = battery.temperatureC >= HOT_C
  const lowBattery = battery.level < LOW_BATTERY_PCT
  return (
    <span className="flex items-center gap-2.5">
      <span className={cn('readout flex items-center gap-1 text-[12px]', lowBattery && 'text-led-warn')}>
        {charging ? (
          <BatteryCharging className="size-3.5 text-fg-subtle" aria-hidden />
        ) : (
          <Battery className="size-3.5 text-fg-subtle" aria-hidden />
        )}
        {battery.level}%
      </span>
      <span className={cn('readout flex items-center gap-1 text-[12px]', hot && 'text-led-danger')}>
        <Thermometer className="size-3.5 text-fg-subtle" aria-hidden />
        {battery.temperatureC.toFixed(1)}°C
      </span>
    </span>
  )
}

/**
 * Who is watching this device — the count is what an operator watches, the
 * list is what they look up (§3.3 above). Extracted (plan 103 §5, closes
 * step 103.11's audit row 20) so `DevicePopup.tsx` can mount the SAME
 * popover instead of a thinner one.
 */
export function ViewersPopover({
  viewers,
  now,
  mySessionId,
  hoveredSessionId,
  onHoverSession,
}: {
  viewers: Viewer[]
  now: number
  mySessionId: string | null
  hoveredSessionId: string | null
  onHoverSession: (sessionId: string | null) => void
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm" className="h-7 gap-1.5 px-2 text-[12px]" aria-label={`Viewers (${viewers.length})`}>
          <Eye className="size-3.5" aria-hidden />
          <span className="readout">{viewers.length}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent>
        <h2 className="rack-label mb-2.5">watching now</h2>
        <ViewerList viewers={viewers} now={now} mySessionId={mySessionId} hoveredSessionId={hoveredSessionId} onHoverSession={onHoverSession} />
      </PopoverContent>
    </Popover>
  )
}

/**
 * Cluster, stable id, serial (both copyable), api level, screen resolution,
 * density, guest agent version, and the active engines with the live
 * fallback warning — everything an operator looks up rather than watches
 * (§3.3 above). Extracted (plan 103 §5, closes step 103.11's audit row 21)
 * so `DevicePopup.tsx` can mount the SAME popover `DeviceHeader` always has
 * — including the serial an operator would paste into an external `adb`
 * command — instead of a thinner reimplementation.
 */
export function DeviceDetailsPopover({
  device,
  registry,
  inspectorFallback,
  agentVersion,
  settingsHref,
}: {
  device: DeviceDetailInfo
  registry: RegistryResponse | null
  /** The EFFECTIVE inspector engine dropped to the fallback for this session (plan 34 §4.6), or null. */
  inspectorFallback: { to: string; reason: string } | null
  agentVersion?: string | null
  settingsHref: string
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon-sm" className="size-7" aria-label="Device details">
          <Info className="size-4" aria-hidden />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80">
        <h2 className="rack-label mb-2.5">this device</h2>
        <dl className="space-y-1.5">
          {/* Always shown, even unclustered — a field, not an omission (plan 22.0 §4.5). */}
          <Row label="cluster" value={device.cluster ? device.cluster.name : 'Unclustered'} />
          <Row label="stable id" value={device.stableId} copyable />
          <Row label="serial" value={device.serial} copyable />
          <Row label="api level" value={device.apiLevel ? String(device.apiLevel) : '—'} />
          <Row label="screen" value={device.screenW && device.screenH ? `${device.screenW}×${device.screenH}` : '—'} />
          <Row label="density" value={device.density ? `${device.density} dpi` : '—'} />
          <Row label="guest agent" value={agentVersion ?? '—'} />
        </dl>

        <h2 className="rack-label mb-2.5 mt-4">active engines</h2>
        <dl className="space-y-1.5">
          {ENGINE_ROWS.map((r) => {
            // The `inspection` row reports the EFFECTIVE engine, not just
            // what is configured (plan 34 §3.1, §4.6): a session that fell
            // back to `uiautomator-dump` is running the slow path.
            const fallback = r.key === 'inspection' ? inspectorFallback : null
            return (
              <Row
                key={r.key}
                label={r.label}
                value={fallback ? `${engineName(registry, r.reg, fallback.to)} (fallback)` : engineName(registry, r.reg, device[r.key])}
                warn={fallback !== null}
              />
            )
          })}
        </dl>
        <Button asChild variant="ghost" size="sm" className="mt-2 h-7 w-full text-[12px]">
          <Link href={settingsHref}>Change</Link>
        </Button>
      </PopoverContent>
    </Popover>
  )
}

export function DeviceHeader({
  device,
  status,
  battery,
  registry,
  inspectorFallback,
  viewers,
  mySessionId,
  hoveredSessionId,
  onHoverSession,
  now,
  secondsLeft,
  holder,
  heldBy,
  iHoldControl,
  acquiring,
  canRunScript,
  onRunScript,
  onTakeControl,
  onControlTaken,
  onReleaseControl,
  onDisconnect,
  onReconnect,
  onOpenCutover,
  onRemove,
  takeOverOpen,
  onTakeOverOpenChange,
  askAgentOpen,
  onAskAgentOpenChange,
  agentVersion,
  labelState,
  assistGrantTtlSec,
}: {
  device: DeviceDetailInfo
  status: DeviceStatus
  /** The live reading (a `device.battery` broadcast), falling back to whatever the first fetch returned. */
  battery: BatteryState | null
  registry: RegistryResponse | null
  /** The EFFECTIVE inspector engine dropped to the fallback for this session (plan 34 §4.6), or null. */
  inspectorFallback: { to: string; reason: string } | null
  viewers: Viewer[]
  mySessionId: string | null
  hoveredSessionId: string | null
  onHoverSession: (sessionId: string | null) => void
  now: number
  /** Seconds before an idle lease is released, or null when we hold none. */
  secondsLeft: number | null
  /** The Plan 31 presence viewer who holds control, when it is a WS-connected browser tab — used only to highlight it in the viewer popover on hover. */
  holder: Viewer | null
  /** Who holds the device's manual lease, server-published (plan 71 §3.2) — a person, an agent, or a job, or null when free. The single source of truth for the take-control button and dialog, replacing `heldByOther`/`agentHolder`. */
  heldBy: LeaseHolder | null
  iHoldControl: boolean
  acquiring: boolean
  canRunScript: boolean
  onRunScript: () => void
  /** Acquire an unheld device directly — no confirmation needed (nobody is displaced). */
  onTakeControl: () => void
  /** A takeover succeeded via the confirmation dialog — the new lease's expiry. */
  onControlTaken: (expiresAt: number) => void
  onReleaseControl: () => void
  /** Opens the disconnect confirmation for this device (plan 88 §3.7, §3.8, §4.6, §5 step 88.4) — a `tcp` device only; the menu item itself disables on USB. */
  onDisconnect: () => void
  /** Dials this device's last known address (plan 88 §3.3, §4.4, §4.6) — fires directly, no confirmation (it is not destructive). */
  onReconnect: () => void
  /** Opens the USB → network cutover wizard (plan 88 §3.4, §4.6, §5 step 88.5) — a `usb` device only; the menu item itself hides on a device already on the network. */
  onOpenCutover: () => void
  onRemove: () => void
  /**
   * Whether the takeover confirmation dialog is open, and how to change that
   * — lifted to the CALLER rather than kept as this component's own
   * `useState` (this file's own doc comment: "No hooks of its own... so it
   * can be called directly like any other function", which
   * `DeviceHeader.test.tsx` relies on literally — a hook call inside a
   * plain, un-rendered function call throws "Invalid hook call").
   */
  takeOverOpen: boolean
  onTakeOverOpenChange: (open: boolean) => void
  /** Plan 73 §3.5, §4.6 — "Ask an agent" dialog visibility, lifted for the same reason as
   * `takeOverOpen` above: this component keeps no hooks of its own. */
  askAgentOpen: boolean
  onAskAgentOpenChange: (open: boolean) => void
  /**
   * The on-device guest agent's `appVersion` (plan 90 §5 step 90.6, fixes
   * F11) — a looked-up fact, so it lives in the `ⓘ` popover per this file's
   * own placement rule (§3.3), never inline. `null` while unknown (loading,
   * or the agent has never answered a handshake) — this component still has
   * no hooks of its own, so the caller fetches it (`GET .../guest-agent`)
   * and hands it down like every other prop here. Optional so a caller that
   * predates this field (an existing test fixture) keeps compiling.
   */
  agentVersion?: string | null
  /**
   * Physical labelling's applied state (plan 89 §3.5, §5 step 89.8) — `null`
   * until the caller's own `GET .../label` resolves, or on a host with
   * nothing to report yet. Optional for the same reason `agentVersion` is:
   * an existing test fixture predating this field keeps compiling.
   */
  labelState?: DeviceLabelState | null
  /**
   * `coControl.grantTtlSec`, the real farm setting (plan 105 §3.2) — passed
   * to the `assistedBy` badge below so its "Assisting"/"May assist" split
   * (`HolderBadge`'s own `deriveAssistActivity`) is computed from the actual
   * TTL rather than the component's shipped-default fallback. Optional so an
   * existing test fixture (or a caller before this plan) keeps compiling —
   * `HolderBadge` itself falls back to the same default either way.
   */
  assistGrantTtlSec?: number
}) {
  const canTakeControl = status === 'idle'
  const settingsHref = `/device?id=${encodeURIComponent(device.id)}&tab=settings`
  // `?? null` guards a hand-built test fixture that omits the field
  // entirely (undefined) — `DeviceInfoSchema.number` is `.default(null)` on
  // a real parse, so `undefined` only ever happens off a fixture, never a
  // real response.
  const number = device.number ?? null
  // Plan 124 §4.4 Group B, step 124.2 — the SAME composition `PageHeader`'s
  // `title` below already did inline since plan 89, hoisted so the rest of
  // this header stops re-deriving it three different ways. Everything on this
  // page that names the device as a `string` now reads this one value: the
  // "More actions" `aria-label`, the guest-agent alert panel, the take-over
  // dialog and the ask-an-agent dialog. A second spelling of the same rule in
  // the same file is exactly how the number went missing from most of the UI
  // in the first place (plan 124 §0.1).
  const deviceName = formatDeviceName(number, device.label)

  return (
    <>
      <PageHeader
      title={deviceName}
      description={`${device.serial} · ${device.androidVersion ? `Android ${device.androidVersion}` : 'Android version unknown'}`}
      meta={
        <div className="flex flex-wrap items-center gap-2.5">
          <DeviceStatusBadge status={status} />

          {/* "A device says who holds it" (plan 71 §3.2) — the lease already knows the holder;
              this renders it (person, agent, or job) instead of leaving a `manual`/`busy` status
              badge to speak for an actor nobody can identify. */}
          {heldBy && !iHoldControl && <HolderBadge holder={heldBy} />}

          {/* Who is ASSISTING this device (plan 91 §3.4 item 4, §4.4, F25) —
              orthogonal to `heldBy` above: an assist grant never moves the
              lease, so it is shown regardless of `iHoldControl`. `?? []`
              covers a caller that predates the field (an existing test
              fixture, the same guard `DeviceCard`/`WallTile` use). */}
          {(device.assistedBy ?? []).map((a) => (
            <HolderBadge key={a.id} holder={a} variant="assists" {...(assistGrantTtlSec ? { grantTtlSec: assistGrantTtlSec } : {})} />
          ))}

          {/* Plan 90 §5 step 90.6 (fixes F10) — quiet for `ready`/`absent`/
              `provisioning`/`unsupported`, the same restraint every other
              chip in this row already practises (`inspectorFallback` below
              is the identical shape: silent when nominal, promoted to a
              visible chip only when it needs a look). The version itself
              lives in the `ⓘ` popover below, per this file's placement
              rule for looked-up facts. */}
          <AgentAlertChip agent={device.agent ?? 'absent'} deviceId={device.id} deviceLabel={device.label} deviceNumber={number} />

          {/* Physical labelling (plan 89 §3.5, §5 step 89.8) — the one place
              this page shows whether the phone's own screen actually says
              what Studio thinks it says. Renders nothing for `off`/`unknown`
              (nothing to claim either way); `partial`/`unavailable` never
              share `applied`'s green (`LabelStateBadge`'s own rule). */}
          <LabelStateBadge state={labelState ?? null} />

          {/* Deliberately NOT behind a popover (§3.3): a swelling battery or a
              phone cooking itself is only useful as a warning if it is seen
              without anyone thinking to look for it.
              Called as a PLAIN FUNCTION, not `<BatteryTempInline .../>` —
              this component has no hooks of its own (same reasoning
              `DeviceHeader` itself is called directly, this file's own
              header), and `DeviceHeader.test.tsx`'s own walker deliberately
              never invokes a child COMPONENT (its own doc comment) — calling
              it here splices its actual output straight into the tree the
              walker already descends through `children`, exactly as if this
              were still inlined JSX. */}
          {BatteryTempInline({ battery })}

          {/* An engine that fell back is the one engine fact worth interrupting
              for — the slow path is running and nothing else says so. */}
          {inspectorFallback && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span
                  tabIndex={0}
                  className="flex cursor-help items-center gap-1 rounded-full border border-led-warn/35 bg-led-warn/10 px-2 py-0.5 text-[11px] text-led-warn"
                >
                  <TriangleAlert className="size-3" aria-hidden />
                  inspection fell back
                </span>
              </TooltipTrigger>
              <TooltipContent className="max-w-xs">
                Configured as {engineName(registry, 'inspectors', device.inspection)}, but this session dropped to{' '}
                {engineName(registry, 'inspectors', inspectorFallback.to)}: {inspectorFallback.reason}
              </TooltipContent>
            </Tooltip>
          )}

          {/* Both called as PLAIN FUNCTIONS, same reasoning as
              `BatteryTempInline` above — `DeviceHeader.test.tsx`'s own
              `rowValue`/`textOf` helpers need the actual `Row`/text nodes
              spliced into this tree, not an opaque, uninvoked component
              instance. */}
          {ViewersPopover({ viewers, now, mySessionId, hoveredSessionId, onHoverSession })}

          {DeviceDetailsPopover({ device, registry, inspectorFallback, agentVersion, settingsHref })}
        </div>
      }
      actions={
        <>
          {/* Only `quarantined` blocks a run. An offline device takes a job
              perfectly well — `createJobStore.enqueue` rejects that one
              status and no other, and `claimNext` holds the job until the
              device reaches `idle`, which it does by itself on reconnect.
              This button used to disable both, so a job the core would have
              queued and run could not be started from the one page an
              operator is most likely to start it from.

              Unlike `Take control` below, the old disabled branch carried no
              tooltip at all — the button simply went grey. Quarantined now
              says why, in the same shape that control already uses. */}
          {status === 'quarantined' ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <span tabIndex={0}>
                  <Button variant="outline" size="sm" disabled>
                    <Play className="size-4" aria-hidden />
                    Run a script
                  </Button>
                </span>
              </TooltipTrigger>
              <TooltipContent>{UNAVAILABLE_REASON.quarantined}</TooltipContent>
            </Tooltip>
          ) : (
            <Button variant="outline" size="sm" disabled={!canRunScript} onClick={onRunScript}>
              <Play className="size-4" aria-hidden />
              Run a script
            </Button>
          )}

          {iHoldControl ? (
            <span className="flex items-center gap-2">
              {/* The idle countdown, kept when the banner it used to live in was
                  deleted (§3.2): the lease going quiet is the one thing here
                  nothing else on the page reports. */}
              {secondsLeft !== null && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span tabIndex={0} className="readout cursor-help text-[11.5px] text-fg-muted">
                      {mmss(secondsLeft)}
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>Control is released automatically after this long without activity.</TooltipContent>
                </Tooltip>
              )}
              <Button size="sm" variant="secondary" onClick={onReleaseControl}>
                Release control
              </Button>
            </span>
          ) : heldBy && heldBy.takeable ? (
            // Reads a fact the server published (`DeviceInfo.heldBy`, plan 71
            // §3.2), not a local inference — the same reasoning that makes the
            // reported two-browser symptom impossible by construction (plan
            // 31 §4.3), now covering a person, an agent, or a job alike.
            // ENABLED and visible (§3.6) — the button being disabled here was
            // the actual defect: it presented an operator's own phone as
            // unavailable to them. Clicking opens the confirmation dialog,
            // never takes over silently.
            <span onMouseEnter={() => holder && onHoverSession(holder.sessionId)} onMouseLeave={() => onHoverSession(null)}>
              <Button size="sm" variant="outline" onClick={() => onTakeOverOpenChange(true)}>
                <Hand className="size-4" aria-hidden />
                Take control
              </Button>
            </span>
          ) : heldBy && !heldBy.takeable ? (
            // A job's hold is never takeable, whatever is passed (plan 71
            // §3.4) — genuinely disabled, naming the job and its script, with
            // a link to it (where Cancel lives) rather than a dead end.
            <span className="flex items-center gap-1.5">
              <Tooltip>
                <TooltipTrigger asChild>
                  <span tabIndex={0}>
                    <Button size="sm" variant="outline" disabled>
                      <Hand className="size-4" aria-hidden />
                      Take control
                    </Button>
                  </span>
                </TooltipTrigger>
                <TooltipContent>
                  {heldBy.label} is running on this device — wait for it to finish or cancel it.
                </TooltipContent>
              </Tooltip>
              <Button asChild size="sm" variant="ghost">
                <Link href={`/jobs/detail?id=${encodeURIComponent(heldBy.id)}`}>View job</Link>
              </Button>
            </span>
          ) : canTakeControl ? (
            <Button size="sm" disabled={acquiring} onClick={onTakeControl}>
              <Hand className="size-4" aria-hidden />
              {acquiring ? 'Taking…' : 'Take control'}
            </Button>
          ) : (
            // A lit-up primary button that cannot be pressed is a trap — when
            // control genuinely is not available, show a clearly disabled
            // button and say why.
            <Tooltip>
              <TooltipTrigger asChild>
                <span tabIndex={0}>
                  <Button size="sm" variant="outline" disabled>
                    <Hand className="size-4" aria-hidden />
                    Take control
                  </Button>
                </span>
              </TooltipTrigger>
              <TooltipContent>{UNAVAILABLE_REASON[status] ?? 'The device is unavailable'}</TooltipContent>
            </Tooltip>
          )}

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label={`More actions for ${deviceName}`}>
                <MoreVertical className="size-4" aria-hidden />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem asChild>
                <Link href={settingsHref}>
                  <Settings className="size-3.5" aria-hidden />
                  Device settings
                </Link>
              </DropdownMenuItem>
              {/* Plan 73 §3.5, §4.6 — a device page can hand the phone to an agent; the picker
                  filters to agents that may actually reach it. */}
              <DropdownMenuItem onSelect={() => onAskAgentOpenChange(true)}>
                <Bot className="size-3.5" aria-hidden />
                Ask an agent…
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              {/* The Connection group (plan 88 §3.7, §3.8, §4.6, §5 steps
                  88.4/88.5): Disconnect and Remove sound alike and mean very
                  different things — Disconnect only drops the adb link and
                  keeps the device's record, so it sits ABOVE its own
                  separator, visually apart from the destructive Remove item
                  below. */}
              {/* `?? 'usb'` matches `DeviceInfoSchema.connection`'s own
                  default (plan 88 §4.1) — a caller that predates this plan
                  (an existing test fixture, a fallback with no live
                  derivation to hand) leaves `connection` undefined, and the
                  safe assumption for an unknown transport is the one that
                  disables the menu item rather than the one that enables it. */}
              {(device.connection?.kind ?? 'usb') === 'usb' ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <DropdownMenuItem
                      onSelect={(e) => e.preventDefault()}
                      className="text-fg-subtle data-[highlighted]:bg-transparent data-[highlighted]:text-fg-subtle"
                    >
                      <Unplug className="size-3.5" aria-hidden />
                      Disconnect from the network
                    </DropdownMenuItem>
                  </TooltipTrigger>
                  <TooltipContent>adb has no way to release a single USB transport. Unplug the cable to disconnect it.</TooltipContent>
                </Tooltip>
              ) : (
                <DropdownMenuItem onSelect={onDisconnect}>
                  <Unplug className="size-3.5" aria-hidden />
                  Disconnect from the network
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onSelect={onReconnect}>
                <RefreshCw className="size-3.5" aria-hidden />
                Reconnect
              </DropdownMenuItem>
              {/* §3.8's third Connection item, the cutover wizard (§5 step
                  88.5) — USB only: a device already on the network has
                  nowhere left to move TO with this flow (Disconnect/
                  Reconnect, or the settings page's declared-medium
                  correction, cover that case instead). */}
              {(device.connection?.kind ?? 'usb') === 'usb' && (
                <DropdownMenuItem onSelect={onOpenCutover}>
                  <EthernetPort className="size-3.5" aria-hidden />
                  Move to the network (Wi-Fi/OTG)…
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              {/* The same words the fleet card's menu uses, opening the same
                  dialog — a verb keeps its name through the whole flow. */}
              <DropdownMenuItem onSelect={onRemove} className="text-led-danger focus:text-led-danger">
                <Trash2 className="size-3.5" aria-hidden />
                Remove from farm…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      }
      />
      {heldBy && (
        <TakeControlDialog
          deviceId={device.id}
          // Plan 124 §4.4 — `deviceLabel: string` props are not widened into
          // objects; the caller composes.
          deviceLabel={deviceName}
          holder={heldBy}
          open={takeOverOpen}
          onOpenChange={onTakeOverOpenChange}
          onTaken={onControlTaken}
        />
      )}
      <AskAnAgentDialog deviceId={device.id} deviceLabel={deviceName} open={askAgentOpen} onOpenChange={onAskAgentOpenChange} />
    </>
  )
}

// Exported for `DeviceHeader.test.tsx` (plan 90 §5 step 90.6): this file's
// own testing convention never invokes a child component (its own doc
// comment) — a value only `Row` itself renders (never inlined in
// `DeviceHeader`'s own JSX) is otherwise invisible to `textOf`'s walk, the
// same reason `engineName`/`mmss` are exported below.
export function Row({ label, value, copyable, warn }: { label: string; value: string; copyable?: boolean; warn?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-[12px] text-fg-muted">{label}</dt>
      <dd className={cn('flex min-w-0 items-baseline gap-1', warn && 'text-led-warn')}>
        <span className="readout min-w-0 truncate text-[12px]" title={value}>
          {value}
        </span>
        {copyable && <CopyButton value={value} label={label} />}
      </dd>
    </div>
  )
}

/** Serial and stable id are pasted into adb commands often enough to earn a button (§9 Q2). */
function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      aria-label={`Copy ${label}`}
      className="shrink-0 text-fg-subtle transition-colors hover:text-fg"
      onClick={() => {
        void navigator.clipboard
          .writeText(value)
          .then(() => {
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
          })
          .catch(() => undefined)
      }}
    >
      {copied ? <Check className="size-3 text-led-ok" aria-hidden /> : <Copy className="size-3" aria-hidden />}
    </button>
  )
}
