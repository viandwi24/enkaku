'use client'

import { useEffect, useState } from 'react'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { AgentStateBadge } from '@/components/guest-agent/AgentStateBadge'
import { NetworkRouteForm } from '@/components/guest-agent/NetworkRouteForm'
import { Button } from '@/components/ui/button'
import { ErrorState, LoadingRows } from '@/components/states'
import { api, useAction } from '@/lib/actions'
import { fetchGuestAgentStatus, type GuestAgentStatus } from '@/lib/api'

/**
 * The device page's Network tab (plan 44 §4.6) — moved here from a
 * standalone `/guest-agents` list page, because this is a per-device
 * concern and per-device concerns belong on the device page, the same
 * reasoning behind every other tab here (Files, Terminal, Monitor, ...).
 *
 * Named "Network" rather than "Guest Agent": the operator's concern is this
 * device's network route, not the implementation detail that makes it
 * possible. Below the fold this renders the on-device agent's install
 * state and — once it is `ready` — the SOCKS5 route form
 * (`NetworkRouteForm`).
 *
 * Was `GuestAgentRow`, one row of a fleet-wide table with an
 * expand/collapse chevron; refactored into a single-device panel since
 * list semantics (row, expand toggle) no longer apply here.
 */
export function NetworkPanel({
  deviceId,
  deviceLabel,
  canUse,
}: {
  deviceId: string
  deviceLabel: string
  /**
   * The same server-authoritative gate every other mutating control on this
   * page uses (`iHoldControl && !busy`) — a convenience only, the server
   * checks the lease itself on every `guest-agent`/`network` request
   * regardless (both endpoint groups require a held manual lease).
   */
  canUse: boolean
}) {
  const [status, setStatus] = useState<GuestAgentStatus | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const { run, isPending } = useAction()

  const load = () => {
    setLoadError(null)
    fetchGuestAgentStatus(deviceId)
      .then(setStatus)
      .catch((e) => setLoadError(e instanceof Error ? e.message : String(e)))
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, [deviceId])

  const install = () =>
    run('install', () => api<GuestAgentStatus>(`/api/devices/${deviceId}/guest-agent`, { method: 'POST' }), {
      success: `Guest agent installed on ${deviceLabel}`,
      failure: 'Could not install the guest agent',
      onSuccess: setStatus,
    })

  const repair = () =>
    run('repair', () => api<GuestAgentStatus>(`/api/devices/${deviceId}/guest-agent`, { method: 'POST' }), {
      success: `Guest agent repaired on ${deviceLabel}`,
      failure: 'Could not repair the guest agent',
      onSuccess: setStatus,
    })

  const uninstall = () =>
    run('uninstall', () => api(`/api/devices/${deviceId}/guest-agent`, { method: 'DELETE' }), {
      success: `Guest agent uninstalled from ${deviceLabel}`,
      failure: 'Could not uninstall the guest agent',
      // Re-read rather than assume: the same "show what the device
      // reported" principle the network status panel follows.
      onSuccess: load,
    })

  // A gated panel always renders its controls, disabled, with one line
  // saying why — never a sentence INSTEAD of the panel (Plan 42 §3.2,
  // §4.2), the same treatment the Files tab uses: "Take control" takes
  // effect immediately without a tab switch.
  const disabled = !canUse

  return (
    <div className="px-5 py-4">
      {disabled && (
        <p className="mb-4 rounded-lg border bg-surface px-3.5 py-2.5 text-[12.5px] text-fg-muted">
          Take control of this device to install, repair, or configure its network route.
        </p>
      )}

      {loadError ? (
        <ErrorState message={loadError} onRetry={load} />
      ) : status === null ? (
        <LoadingRows rows={2} />
      ) : (
        <div className="max-w-3xl space-y-4">
          <section className="rounded-lg border bg-surface p-4">
            <h3 className="text-[13.5px] font-semibold tracking-tight">Guest agent</h3>
            <p className="mt-1 text-[12px] leading-relaxed text-fg-muted">
              The on-device helper that carries a SOCKS5 route to the device. A package being present does not mean it
              can be driven — "installed" and "ready" are shown as different states on purpose.
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <AgentStateBadge state={status.state} />
              {status.state === 'unsupported' && status.reason && (
                <span className="text-[12px] text-fg-muted">{status.reason}</span>
              )}
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {status.state === 'not-installed' && (
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={disabled || isPending('install')}
                  onClick={() => void install()}
                >
                  {isPending('install') ? 'Installing…' : 'Install'}
                </Button>
              )}
              {(status.state === 'installed' || status.state === 'unreachable') && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={disabled || isPending('repair')}
                  onClick={() => void repair()}
                >
                  {isPending('repair') ? 'Repairing…' : 'Repair'}
                </Button>
              )}
              {/* Repair and Uninstall are not alternatives, they are escalation: Uninstall
                  is the way out when Repair does not work, so it is offered in every state
                  where the package is actually present on the device. */}
              {(status.state === 'installed' || status.state === 'ready' || status.state === 'unreachable') && (
                <ConfirmDialog
                  trigger={
                    <Button size="sm" variant="ghost" disabled={disabled}>
                      Uninstall
                    </Button>
                  }
                  title={`Uninstall the guest agent from ${deviceLabel}?`}
                  description="Any active proxy route on this device is torn down first. The ACTIVATE_VPN grant is tied to this app's uid, so uninstalling drops it too — reinstalling later means going through the whole provisioning sequence again."
                  confirmLabel="Uninstall"
                  onConfirm={uninstall}
                />
              )}
            </div>
          </section>

          {status.state === 'ready' && <NetworkRouteForm deviceId={deviceId} canUse={canUse} />}
        </div>
      )}
    </div>
  )
}
