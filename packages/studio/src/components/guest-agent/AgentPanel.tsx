'use client'

import { useEffect, useState } from 'react'
import { GuestAgentStatusResponseSchema } from '@enkaku/protocol'
import { z } from 'zod'
import { ConfirmDialog, Button, ErrorState, LoadingRows, api, useAction, relativeTime } from '@enkaku/ui'
import { AgentStateBadge } from '@/components/guest-agent/AgentStateBadge'
import type { GuestAgentState } from '@/lib/api'

/**
 * The device page's Agent tab (plan 90 §5 step 90.6, fixes F10, F11, F20's
 * operator half described in §3.9). Everything this panel renders was
 * already returned by `GET /api/devices/:id/guest-agent` before this step —
 * `appVersion`, `androidSdkInt`, `capabilities` — and Studio rendered none
 * of it (F11). This is the surface that fixes that.
 *
 * Moved here from `NetworkPanel` (plan 90 §5 step 90.6): the agent's
 * lifecycle — install, repair, update, retry, remove — is a property of the
 * DEVICE (§3.8), not of its network route, so it earns its own tab rather
 * than living under "Network".
 *
 * `state` widens to seven values on the wire (`GuestAgentStatusResponseSchema`,
 * `@enkaku/protocol`) — the pre-plan-90 five plus `outdated`/`failed`, the
 * states `AgentProvisioner` already computes. This panel renders every one
 * of them; see the schema's own doc comment for why the endpoint behind it
 * does not send `outdated`/`failed` YET (a core-side wiring gap out of this
 * step's file allowlist, flagged there rather than silently worked around).
 */

/**
 * Raw `hello().capabilities` strings group into the four facets plan 90
 * §3.1 actually ships — an operator does not care that the route facet
 * advertises four separate capability strings (`socks5-route`/`vpn-status`/
 * `egress-probe`/`route-hold`), only that "the route" works. Unrecognised
 * strings (a future facet this build of Studio predates) render as-is
 * rather than vanishing — the same "never silently drop a real value" rule
 * `planField`'s escape hatches follow (docs/design.md).
 */
const FACET_LABELS: Record<string, string> = {
  'socks5-route': 'Network route',
  'vpn-status': 'Network route',
  'egress-probe': 'Network route',
  'route-hold': 'Network route',
  'screen-label': 'Screen label',
  'text-input': 'Keyboard',
  'mock-location': 'Location',
}

/** Fixed order (plan 90 §5 step 90.6's own list) — never reflows with wire order, the same rule `TileChips`' `ALL_TILE_CHIPS` follows. */
const FACET_ORDER = ['Network route', 'Screen label', 'Keyboard', 'Location']

function namedFacets(capabilities: string[] | undefined): string[] {
  if (!capabilities || capabilities.length === 0) return []
  const names = new Set(capabilities.map((c) => FACET_LABELS[c] ?? c))
  return [...names].sort((a, b) => {
    const ia = FACET_ORDER.indexOf(a)
    const ib = FACET_ORDER.indexOf(b)
    if (ia === -1 && ib === -1) return a.localeCompare(b)
    if (ia === -1) return 1
    if (ib === -1) return -1
    return ia - ib
  })
}

/** One primary action per state (plan 90 §3.8, §3.9) — Install / Update / Retry, the same install+probe call underneath every one of them; `ready`/`unsupported` have none. */
function primaryActionLabel(state: GuestAgentState): string | null {
  switch (state) {
    case 'not-installed':
      return 'Install'
    case 'outdated':
      return 'Update agent'
    case 'installed':
    case 'unreachable':
    case 'failed':
      return 'Retry'
    // Not 'Retry': the last pass did not go wrong. Android's VPN consent has
    // to be accepted on the phone itself, and this re-probes once it has been.
    case 'consent-required':
      return 'Check again'
    case 'ready':
    case 'unsupported':
      return null
  }
}

/** Remove is offered whenever a package might actually be on the device — not for a state that never got one. */
function removeOffered(state: GuestAgentState): boolean {
  return state !== 'not-installed' && state !== 'unsupported'
}

export function AgentPanel({
  deviceId,
  deviceLabel,
  canUse,
}: {
  deviceId: string
  deviceLabel: string
  /** Same server-authoritative gate every other mutating control on the device page uses. */
  canUse: boolean
}) {
  const [status, setStatus] = useState<z.infer<typeof GuestAgentStatusResponseSchema> | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const { run, pending, isPending } = useAction()

  const load = () => {
    setLoadError(null)
    api(`/api/devices/${deviceId}/guest-agent`, GuestAgentStatusResponseSchema)
      .then(setStatus)
      .catch((e) => setLoadError(e instanceof Error ? e.message : String(e)))
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, [deviceId])

  /**
   * Installing pushes an APK and provisions it, and the HTTP response only
   * lands at the very end — a request dying is not the same as the
   * operation failing (the exact defect `NetworkPanel` used to guard
   * against before this block moved here). So this never treats the
   * response as authoritative: it polls while an action is in flight, and
   * re-reads once it settles whichever way it went.
   */
  useEffect(() => {
    if (!pending) return
    const id = setInterval(load, 4000)
    return () => clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending, deviceId])

  const settle = (p: Promise<unknown>) => void p.then(load)

  const installOrRepair = (label: string) =>
    settle(
      run('install', () => api(`/api/devices/${deviceId}/guest-agent`, GuestAgentStatusResponseSchema, { method: 'POST' }), {
        success: `${label} started on ${deviceLabel}`,
        failure: `Could not ${label.toLowerCase()} the guest agent`,
      }),
    )

  const remove = () =>
    settle(
      // `DELETE /:id/guest-agent` returns `{ ok: true }`, not the guest-agent
      // status envelope the two POST-shaped actions above use — this call
      // site never reads the body (a re-poll via `settle`/`load` is the
      // source of truth), so a small ad-hoc schema rather than a new export
      // for a value nothing reads (same reasoning `NetworkPanel` used to
      // carry for this exact call before it moved here).
      run('remove', () => api(`/api/devices/${deviceId}/guest-agent`, z.object({ ok: z.boolean() }), { method: 'DELETE' }), {
        success: `Guest agent removed from ${deviceLabel}`,
        failure: 'Could not remove the guest agent',
      }),
    )

  const disabled = !canUse

  return (
    /*
     * Same reasoning as `NetworkPanel`: `px-5` belongs to the device page's own
     * tab, which supplies no padding; the Settings popup's section pane does.
     * The container element is separate from the padded one because a size
     * container's own padding feeds back into the width its queries read.
     */
    <div className="@container">
      <div className="py-4 @min-[32rem]:px-5">
        {disabled && (
          <p className="mb-4 rounded-lg border bg-surface px-3.5 py-2.5 text-[12.5px] text-fg-muted">
            Take control of this device to install, update, or remove its guest agent.
          </p>
        )}

        {loadError ? (
          <ErrorState message={loadError} onRetry={load} />
        ) : status === null ? (
          <LoadingRows rows={2} />
        ) : (
          <div className="max-w-3xl space-y-4">
            <section className="@container rounded-lg border bg-surface p-4">
              <h3 className="text-[13.5px] font-semibold tracking-tight">Guest agent</h3>
              <p className="mt-1 text-[12px] leading-relaxed text-fg-muted">
                The on-device helper behind the network route, the screen label, non-ASCII typing, and mock location —
                one app, four facets, negotiated by capability (plan 90). A package being present does not mean it can
                be driven — "installed" and "ready" are shown as different states on purpose.
              </p>

              <div className="mt-3 flex flex-wrap items-center gap-2">
                <AgentStateBadge state={status.state} />
                {status.reason && <span className="text-[12px] text-fg-muted">{status.reason}</span>}
              </div>

              {/* Two `label … value` rows sit side by side once the card can
                  give each about 11.5rem: 2 × 11.5 + 0.375rem gap ≈ 24rem of
                  the CARD's width (a container query, so a narrow dialog pane
                  stacks them while the device page keeps two columns). */}
              <dl className="mt-3 grid gap-1.5 @min-[24rem]:grid-cols-2">
                <Row label="app version" value={status.appVersion ?? '—'} />
                <Row label="Android SDK" value={status.androidSdkInt !== undefined ? String(status.androidSdkInt) : '—'} />
                {/*
                  `checkedAt` (plan 90 §4.7's stated extension) has no producer
                  on this endpoint yet — see `GuestAgentStatusResponseSchema`'s
                  own doc comment (`@enkaku/protocol`). Rendered as `—`, the
                  same "no data" convention every other looked-up fact on this
                  page already uses (`DeviceHeader`'s popover), never a fake
                  timestamp.
                */}
                <Row label="last checked" value={status.checkedAt ? relativeTime(status.checkedAt) : '—'} />
              </dl>

              <div className="mt-3">
                <h4 className="text-[11px] font-medium uppercase tracking-wide text-fg-subtle">Capabilities</h4>
                {namedFacets(status.capabilities).length > 0 ? (
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {namedFacets(status.capabilities).map((facet) => (
                      <span
                        key={facet}
                        className="inline-flex items-center rounded-full border bg-surface-2 px-2 py-0.5 text-[11px] font-medium text-fg-muted"
                      >
                        {facet}
                      </span>
                    ))}
                  </div>
                ) : (
                  <p className="mt-1 text-[12px] text-fg-subtle">Not reported yet — the agent has not answered a handshake.</p>
                )}
              </div>

              <div className="mt-4 flex flex-wrap items-center gap-2 border-t pt-3">
                {primaryActionLabel(status.state) && (
                  <Button
                    size="sm"
                    variant={status.state === 'not-installed' ? 'secondary' : 'outline'}
                    disabled={disabled || isPending('install')}
                    onClick={() => void installOrRepair(primaryActionLabel(status.state)!)}
                  >
                    {isPending('install') ? `${primaryActionLabel(status.state)}…` : primaryActionLabel(status.state)}
                  </Button>
                )}
                {/* Observed anywhere from seconds to ~2m40s on the same device, so the copy commits
                    to no number. Without it the panel looks stuck, which is what led to this being
                    reported as a broken button (carried over from the old NetworkPanel block). */}
                {isPending('install') && (
                  <span className="text-[12px] text-fg-muted">
                    Pushing the APK and provisioning it — this can take a couple of minutes. Safe to leave this tab.
                  </span>
                )}
                {removeOffered(status.state) && (
                  <ConfirmDialog
                    trigger={
                      <Button size="sm" variant="ghost" disabled={disabled}>
                        Remove
                      </Button>
                    }
                    title={`Remove the guest agent from ${deviceLabel}?`}
                    description="Any active network route on this device is torn down first. The ACTIVATE_VPN grant is tied to this app's uid, so removing it drops that too — reinstalling later means going through the whole provisioning sequence again."
                    confirmLabel="Remove"
                    onConfirm={remove}
                  />
                )}
              </div>
            </section>
          </div>
        )}
      </div>
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-[12px] text-fg-subtle">{label}</dt>
      <dd className="readout min-w-0 truncate text-[12px]" title={value}>
        {value}
      </dd>
    </div>
  )
}
