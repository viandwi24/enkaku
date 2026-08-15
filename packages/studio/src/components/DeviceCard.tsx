'use client'

import Link from 'next/link'
import { Battery, Bug, MoreVertical, Play, RefreshCw, ScreenShare, Thermometer, Trash2, Unplug } from 'lucide-react'
import type { DeviceInfo, JobInfo } from '@enkaku/protocol'
import { Button } from '@/components/ui/button'
import { AgentAlertChip } from '@/components/guest-agent/AgentAlertChip'
import { ConnectionBadge } from '@/components/ConnectionBadge'
import { DeviceStatusBadge, ReadinessBadge } from '@/components/StatusBadge'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { ReadinessControl } from '@/components/ReadinessControl'
import { HolderBadge } from '@/components/HolderBadge'
import { tileIdentityOf } from '@/components/wall/tile-identity'
import { cn } from '@/lib/utils'

/**
 * The device card as a "rack unit": status rail down the left edge, identity
 * on top, instrument readouts (battery, temperature) in the middle, actions
 * at the bottom.
 *
 * The rail is this Studio's signature — scanning a column of colour is far
 * faster than reading status text one card at a time across a dozen devices.
 */
export function DeviceCard({
  device,
  runningJob,
  onReleaseQuarantine,
  canReleaseQuarantine = true,
  onRequestForget,
  onRequestDisconnect,
  onReconnect,
  selectable,
  selected,
  onToggleSelect,
}: {
  device: DeviceInfo
  runningJob?: JobInfo | null
  onReleaseQuarantine?: () => void
  /**
   * Whether the signed-in user may actually call `onReleaseQuarantine`
   * (`device.quarantine`, admin-only in `packages/core/src/auth/acl.ts`) —
   * defaults to `true` so a caller that does not care about the distinction
   * (every caller before this) keeps today's behaviour. `false` keeps the
   * button on screen rather than removing it: an operator who cannot act
   * still needs to see that a way out exists and who to ask, the same
   * reasoning the offline-device buttons below are disabled-with-a-reason
   * rather than hidden. Studio-side convenience only — the server refuses
   * the same call regardless (spec §10.1).
   */
  canReleaseQuarantine?: boolean
  /** Opens the Forget/Block dialog for this device (plan 47 §4.5). */
  onRequestForget?: () => void
  /**
   * Opens the disconnect confirmation for this device (plan 88 §3.7, §3.8,
   * §4.6, §5 step 88.4) — the SAME words `DeviceHeader`'s Connection group
   * uses ("a verb keeps its name through the whole flow",
   * `DeviceHeader.tsx`). Disabled-with-a-reason on a `usb` device, never
   * hidden and never a silent no-op.
   */
  onRequestDisconnect?: () => void
  /** Dials this device's last known address (plan 88 §3.3, §4.4, §4.6) — fires directly, no confirmation. */
  onReconnect?: () => void
  /** Multi-select for a batch action (plan 39 §4.7 — "Install on selected"). */
  selectable?: boolean
  selected?: boolean
  onToggleSelect?: () => void
}) {
  const offline = device.status === 'offline'
  const hot = device.battery && device.battery.temperatureC >= 45
  const lowBattery = device.battery && device.battery.level < 20
  // The plans-88/89 fields, behind one adapter (plan 92 §4.8, H4) — same
  // adapter `WallTile` reads, so the number and the connection glyph read
  // identically wherever a device appears.
  const identity = tileIdentityOf(device)

  return (
    <div
      className={cn(
        'relative overflow-hidden rounded-lg border bg-surface transition-colors',
        offline ? 'opacity-60' : 'hover:border-line-strong',
      )}
    >
      <span
        className="status-rail"
        data-status={device.status}
        data-live={device.status === 'busy' ? 'true' : 'false'}
        aria-hidden
      />

      {selectable && (
        <label className="absolute right-3 top-3 z-10 flex size-5 cursor-pointer items-center justify-center rounded border bg-surface">
          <input
            type="checkbox"
            checked={Boolean(selected)}
            onChange={onToggleSelect}
            aria-label={`Select ${device.label} for a batch action`}
            className="size-3.5"
          />
        </label>
      )}

      <div className="space-y-3 p-4 pl-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            {/* The label is a link in every state, offline included (plan 59
                §3.6). `Control` is correctly disabled for an offline device —
                you cannot drive a phone that is not there — but that was the
                card's ONLY route to the page, so an offline device became
                unreachable without knowing the URL. Its logs, jobs, crashes,
                settings and past artifacts are exactly what an operator wants
                when a device drops off; that is usually why they are looking.
                It is also where people already try to click. */}
            <h3 className="flex min-w-0 items-baseline gap-1.5 truncate text-[14px] font-semibold tracking-tight">
              {/* The same number the Wall's tile shows on its own line 1
                  (plan 92 §4.8, plan 48 §9 Q1, plan 89 §3.3) — so the two
                  views read as the same fleet rather than two different
                  ones. Outside the link: it identifies the row, it is not
                  part of what the label navigates to. Number first, per
                  §3.3: it is the key an operator scans for. Never
                  concatenated into `label` — a separate span composed
                  beside it. `null` only for a device whose reservation was
                  explicitly released (§3.2), rendered honestly as a dash
                  rather than a fake `#0`. */}
              <span className="readout shrink-0 text-[11px] font-normal text-fg-subtle" aria-hidden="true">
                {identity.number !== null ? `#${identity.number}` : '—'}
              </span>
              <Link
                href={`/device?id=${encodeURIComponent(device.id)}`}
                className="min-w-0 truncate transition-colors hover:text-accent-strong"
              >
                {device.label}
              </Link>
            </h3>
            {/* Badge + address (plan 88 §3.1, §4.1, F27) — replaces the raw
                adb serial this used to print unlabelled. For a TCP device
                that serial happened to look like an address by coincidence;
                for USB it looked like nothing anyone but adb could read. The
                badge names what kind of connection this is; the second half
                is the real address when `connection` has one (TCP), or the
                device's own USB serial when it does not — never blank. */}
            <div className="mt-0.5 flex min-w-0 items-center gap-1.5">
              <ConnectionBadge connection={device.connection} />
              <span className="readout truncate text-[11px] text-fg-subtle">
                {device.connection.address ?? device.serial}
              </span>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {/* A device crashing repeatedly should be visible without opening
                it (plan 37 §4.5) — server-populated only within the last
                hour (`listDevicesWithTags`), so this is never stale. */}
            {device.lastCrashAt !== null && (
              <span
                className="inline-flex items-center gap-1 rounded-full border border-led-danger/40 bg-led-danger/10 px-1.5 py-0.5 text-[10px] font-medium text-led-danger"
                title="An app crashed on this device in the last hour"
              >
                <Bug className="size-3" aria-hidden />
                Crash
              </span>
            )}
            {/* Plan 90 §5 step 90.6 — quiet for `ready`/`absent`/`provisioning`/`unsupported`; only `failed`/`outdated` need an operator (F10). */}
            <AgentAlertChip agent={device.agent ?? 'absent'} />
            <DeviceStatusBadge status={device.status} />
            {(onRequestForget || onRequestDisconnect || onReconnect) && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon" className="size-6" aria-label={`More actions for ${device.label}`}>
                    <MoreVertical className="size-3.5" aria-hidden />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {/* The Connection group (plan 88 §3.7, §3.8, §4.6, §5 step
                      88.4) — the SAME words and the SAME disabled-with-a-
                      reason USB case `DeviceHeader`'s menu has, above its
                      own separator from the destructive Remove item below. */}
                  {(onRequestDisconnect || onReconnect) && (
                    <>
                      {onRequestDisconnect &&
                        ((device.connection?.kind ?? 'usb') === 'usb' ? (
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
                          <DropdownMenuItem onSelect={onRequestDisconnect}>
                            <Unplug className="size-3.5" aria-hidden />
                            Disconnect from the network
                          </DropdownMenuItem>
                        ))}
                      {onReconnect && (
                        <DropdownMenuItem onSelect={onReconnect}>
                          <RefreshCw className="size-3.5" aria-hidden />
                          Reconnect
                        </DropdownMenuItem>
                      )}
                      {onRequestForget && <DropdownMenuSeparator />}
                    </>
                  )}
                  {onRequestForget && (
                    <DropdownMenuItem onSelect={onRequestForget} className="text-led-danger focus:text-led-danger">
                      <Trash2 className="size-3.5" aria-hidden />
                      Remove from farm…
                    </DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        </div>

        {/* Who holds this device — a person, an agent, or a job (plan 71
            §3.2, §3.8) — read straight off `DeviceInfo.heldBy`, server-
            published and kept live by `device.added`/`device.status`, never
            polled (replaces `lib/agent-holders.ts`, deleted). */}
        {device.heldBy && (
          <div onClick={(e) => e.stopPropagation()}>
            <HolderBadge holder={device.heldBy} />
          </div>
        )}

        {/* Who is ASSISTING this device (plan 91 §3.4 item 4, §4.4, F25) —
            a narrow, subordinate grant, never a takeover: `heldBy` above is
            unaffected by it. `?? []` covers a caller that predates the
            field (`assistedBy` defaults server-side, but a fixture built as
            a plain object rather than parsed by `DeviceInfoSchema` has no
            such default to fall back on). */}
        {(device.assistedBy ?? []).length > 0 && (
          <div onClick={(e) => e.stopPropagation()} className="flex flex-wrap gap-1">
            {(device.assistedBy ?? []).map((a) => (
              <HolderBadge key={a.id} holder={a} variant="assists" />
            ))}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-1">
          {/* Readiness — a second, orthogonal axis to status (plan 43 §4.6). */}
          <ReadinessBadge readiness={device.readiness} />
          {/* The cluster is always shown, even when empty — "Unclustered" muted
              rather than omitted, so the field reads as a field (plan 22.0 §4.5). */}
          <span
            className={cn(
              'rounded-full px-1.5 py-0.5 text-[10px] font-medium',
              device.cluster ? 'bg-accent/10 text-accent-strong' : 'text-fg-subtle',
            )}
          >
            {device.cluster ? device.cluster.name : 'Unclustered'}
          </span>
          {device.tags.map((tag) => (
            <span key={tag} className="readout rounded-full bg-surface-2 px-1.5 py-0.5 text-[10px] text-fg-muted">
              {tag}
            </span>
          ))}
        </div>

        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11.5px]">
          <div className="flex justify-between gap-2">
            <dt className="text-fg-subtle">Android</dt>
            <dd className="readout">
              {device.androidVersion ?? '—'}
              {device.apiLevel ? ` · ${device.apiLevel}` : ''}
            </dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt className="text-fg-subtle">Screen</dt>
            <dd className="readout">
              {device.screenW && device.screenH ? `${device.screenW}×${device.screenH}` : '—'}
            </dd>
          </div>
          {device.battery && (
            <>
              <div className="flex items-center justify-between gap-2">
                <dt className="flex items-center gap-1 text-fg-subtle">
                  <Battery className="size-3" aria-hidden /> Battery
                </dt>
                <dd className={cn('readout', lowBattery && 'text-led-warn')}>
                  {device.battery.level}%
                  {device.battery.status === 'charging' && (
                    <span className="ml-1 text-fg-subtle">charging</span>
                  )}
                </dd>
              </div>
              <div className="flex items-center justify-between gap-2">
                <dt className="flex items-center gap-1 text-fg-subtle">
                  <Thermometer className="size-3" aria-hidden /> Temp
                </dt>
                <dd className={cn('readout', hot && 'text-led-danger')}>
                  {device.battery.temperatureC.toFixed(1)}°C
                </dd>
              </div>
            </>
          )}
        </dl>

        {/* A busy device explains WHY it cannot be used right now. */}
        {device.status === 'busy' && runningJob && (
          <Link
            href={`/jobs/detail?id=${runningJob.jobId}`}
            className="block rounded border border-led-active/30 bg-led-active/5 px-2.5 py-1.5 text-[11.5px] hover:border-led-active/50"
          >
            Running a job — view details
          </Link>
        )}

        {/* Quarantine shows the reason and the way out in the same place. */}
        {device.status === 'quarantined' && (
          <div className="rounded border border-led-danger/30 bg-led-danger/5 px-2.5 py-2">
            <p className="text-[11.5px] text-led-danger">
              {device.quarantineReason
                ? `Pulled from the queue: ${explainQuarantine(device.quarantineReason)}`
                : 'Pulled from the queue, with no reason recorded.'}
            </p>
            {onReleaseQuarantine && (
              <Button
                variant="outline"
                size="sm"
                className="mt-2 h-7 text-[11.5px]"
                disabled={!canReleaseQuarantine}
                title={canReleaseQuarantine ? undefined : 'Only an admin can return a quarantined device to the queue'}
                onClick={onReleaseQuarantine}
              >
                Return to queue
              </Button>
            )}
          </div>
        )}

        {/* An offline device gets genuinely disabled buttons, not links that
            look dead but are still clickable — each naming the state it needs
            (plan 59 §3.6). The way in to the page itself is the label above:
            not being able to CONTROL an offline phone is not a reason to be
            unable to READ about it. */}
        <div className="flex gap-2 pt-0.5">
          {offline ? (
            <>
              <Button
                size="sm"
                variant="secondary"
                className="h-8 flex-1 text-[12px]"
                disabled
                title="The device is not connected to this farm — open it to read its logs, jobs and settings"
              >
                <ScreenShare className="size-3.5" aria-hidden />
                Control
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-8 text-[12px]"
                disabled
                title="The device is not connected to this farm — a script needs a device that is online"
              >
                <Play className="size-3.5" aria-hidden />
                Run
              </Button>
            </>
          ) : (
            <>
              <Button asChild size="sm" variant="secondary" className="h-8 flex-1 text-[12px]">
                <Link href={`/device?id=${encodeURIComponent(device.id)}`}>
                  <ScreenShare className="size-3.5" aria-hidden />
                  Control
                </Link>
              </Button>
              <Button asChild size="sm" variant="ghost" className="h-8 text-[12px]">
                <Link href={`/scripts?device=${encodeURIComponent(device.id)}`}>
                  <Play className="size-3.5" aria-hidden />
                  Run
                </Link>
              </Button>
            </>
          )}
          {/* Wake/Sleep without opening video (plan 43 §1) — refused
              server-side exactly as the WS message would be; the button
              itself only pre-disables for offline/quarantined. */}
          <ReadinessControl device={device} className="h-8" />
        </div>
      </div>
    </div>
  )
}

/** `thermal:49.8C` is not a sentence — turn it into something readable. Reused by the Wall (plan 42 §4.6) for the same reason text. */
export function explainQuarantine(reason: string): string {
  const thermal = /^thermal:([\d.]+)C$/.exec(reason)
  if (thermal) return `temperature reached ${thermal[1]}°C`
  return reason
}
