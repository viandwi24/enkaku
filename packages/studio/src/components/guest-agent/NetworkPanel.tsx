'use client'

import { useEffect, useState } from 'react'
import { GuestAgentStatusResponseSchema } from '@enkaku/protocol'
import { z } from 'zod'
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
  const { run, pending, isPending } = useAction()

  const load = () => {
    setLoadError(null)
    fetchGuestAgentStatus(deviceId)
      .then(setStatus)
      .catch((e) => setLoadError(e instanceof Error ? e.message : String(e)))
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, [deviceId])

  /**
   * Installing pushes a ~31 MB APK and provisions it, and the HTTP response
   * only lands at the very end. That one request used to be the panel's ONLY
   * source of truth, and **a request dying is not the same as the operation
   * failing** — observed directly: an install that finished fine on the device
   * answered the browser with `Failed to fetch`, so the panel toasted an error
   * and went on offering an Install button for an agent that was already
   * installed. Only a page refresh showed the truth, which is how it was
   * reported.
   *
   * So the panel never treats the response as authoritative. It polls while an
   * action is in flight, and re-reads once it settles **whichever way it went**
   * — the device's own state is the answer, not what happened to the fetch.
   */
  useEffect(() => {
    if (!pending) return
    const id = setInterval(load, 4000)
    return () => clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending, deviceId])

  /** `run()` never rejects — it resolves to null on failure — so this re-reads on both paths. */
  const settle = (p: Promise<unknown>) => void p.then(load)

  const install = () =>
    settle(
      run('install', () => api(`/api/devices/${deviceId}/guest-agent`, GuestAgentStatusResponseSchema, { method: 'POST' }), {
        success: `Guest agent installed on ${deviceLabel}`,
        failure: 'Could not install the guest agent',
      }),
    )

  const repair = () =>
    settle(
      run('repair', () => api(`/api/devices/${deviceId}/guest-agent`, GuestAgentStatusResponseSchema, { method: 'POST' }), {
        success: `Guest agent repaired on ${deviceLabel}`,
        failure: 'Could not repair the guest agent',
      }),
    )

  const uninstall = () =>
    settle(
      // `DELETE /:id/guest-agent` returns `{ ok: true }` (`packages/core/src/api/guest-agent.ts`),
      // NOT the guest-agent status envelope the plan named for this file's two `POST` calls above
      // — no envelope for `{ ok }` exists in `@enkaku/protocol` yet, and this call site never reads
      // the body (the panel re-polls status separately via `settle`/`load`), so a small ad-hoc
      // schema rather than a new export for a value nothing reads.
      run('uninstall', () => api(`/api/devices/${deviceId}/guest-agent`, z.object({ ok: z.boolean() }), { method: 'DELETE' }), {
        success: `Guest agent uninstalled from ${deviceLabel}`,
        failure: 'Could not uninstall the guest agent',
      }),
    )

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
              {/* Observed anywhere from seconds to ~2m40s on the same device, so the copy commits
                  to no number. Without it the panel looks stuck, which is what led to this being
                  reported as a broken button. */}
              {isPending('install') && (
                <span className="text-[12px] text-fg-muted">
                  Pushing the APK and provisioning it — this can take a couple of minutes. Safe to leave this tab.
                </span>
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
