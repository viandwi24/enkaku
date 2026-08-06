'use client'

import { useState } from 'react'
import Link from 'next/link'
import {
  Battery,
  BatteryCharging,
  Bot,
  Check,
  Copy,
  Eye,
  Hand,
  Info,
  MoreVertical,
  Play,
  Settings,
  Thermometer,
  Trash2,
  TriangleAlert,
} from 'lucide-react'
import type { BatteryState, DeviceInfo, DeviceStatus, LeaseHolder, RegistryResponse, Viewer } from '@enkaku/protocol'
import { Button } from '@/components/ui/button'
import { DeviceStatusBadge } from '@/components/StatusBadge'
import { PageHeader } from '@/components/layout/PageHeader'
import { ViewerList } from '@/components/ViewerList'
import { UNAVAILABLE_REASON } from '@/components/DevicePicker'
import { AskAnAgentDialog } from '@/components/AskAnAgentDialog'
import { HolderBadge } from '@/components/HolderBadge'
import { TakeControlDialog } from '@/components/TakeControlDialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

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
  onRemove,
  takeOverOpen,
  onTakeOverOpenChange,
  askAgentOpen,
  onAskAgentOpenChange,
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
}) {
  const canTakeControl = status === 'idle'
  const charging = battery?.status === 'charging'
  const hot = battery !== null && battery.temperatureC >= HOT_C
  const lowBattery = battery !== null && battery.level < LOW_BATTERY_PCT
  const settingsHref = `/device?id=${encodeURIComponent(device.id)}&tab=settings`

  return (
    <>
      <PageHeader
      title={device.label}
      description={`${device.serial} · ${device.androidVersion ? `Android ${device.androidVersion}` : 'Android version unknown'}`}
      meta={
        <div className="flex flex-wrap items-center gap-2.5">
          <DeviceStatusBadge status={status} />

          {/* "A device says who holds it" (plan 71 §3.2) — the lease already knows the holder;
              this renders it (person, agent, or job) instead of leaving a `manual`/`busy` status
              badge to speak for an actor nobody can identify. */}
          {heldBy && !iHoldControl && <HolderBadge holder={heldBy} />}

          {/* Deliberately NOT behind a popover (§3.3): a swelling battery or a
              phone cooking itself is only useful as a warning if it is seen
              without anyone thinking to look for it. */}
          {battery && (
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
          )}

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

          <Popover>
            <PopoverTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 gap-1.5 px-2 text-[12px]"
                aria-label={`Viewers (${viewers.length})`}
              >
                <Eye className="size-3.5" aria-hidden />
                <span className="readout">{viewers.length}</span>
              </Button>
            </PopoverTrigger>
            <PopoverContent>
              <h2 className="rack-label mb-2.5">watching now</h2>
              <ViewerList
                viewers={viewers}
                now={now}
                mySessionId={mySessionId}
                hoveredSessionId={hoveredSessionId}
                onHoverSession={onHoverSession}
              />
            </PopoverContent>
          </Popover>

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
                      value={
                        fallback
                          ? `${engineName(registry, r.reg, fallback.to)} (fallback)`
                          : engineName(registry, r.reg, device[r.key])
                      }
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
        </div>
      }
      actions={
        <>
          {status === 'offline' || status === 'quarantined' ? (
            <Button variant="outline" size="sm" disabled>
              <Play className="size-4" aria-hidden />
              Run a script
            </Button>
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
              <Button variant="ghost" size="icon-sm" aria-label={`More actions for ${device.label}`}>
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
          deviceLabel={device.label}
          holder={heldBy}
          open={takeOverOpen}
          onOpenChange={onTakeOverOpenChange}
          onTaken={onControlTaken}
        />
      )}
      <AskAnAgentDialog deviceId={device.id} deviceLabel={device.label} open={askAgentOpen} onOpenChange={onAskAgentOpenChange} />
    </>
  )
}

function Row({ label, value, copyable, warn }: { label: string; value: string; copyable?: boolean; warn?: boolean }) {
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
