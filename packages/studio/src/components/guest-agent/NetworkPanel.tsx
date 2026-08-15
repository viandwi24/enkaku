'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { ChevronRight } from 'lucide-react'
import { AgentStateBadge } from '@/components/guest-agent/AgentStateBadge'
import { NetworkRouteForm } from '@/components/guest-agent/NetworkRouteForm'
import { ErrorState, LoadingRows } from '@/components/states'
import { fetchGuestAgentStatus, type GuestAgentStatus } from '@/lib/api'

/**
 * The device page's Network tab (plan 44 §4.6) — moved here from a
 * standalone `/guest-agents` list page, because this is a per-device
 * concern and per-device concerns belong on the device page, the same
 * reasoning behind every other tab here (Files, Terminal, Monitor, ...).
 *
 * Named "Network" rather than "Guest Agent": the operator's concern is this
 * device's network route, not the implementation detail that makes it
 * possible. Below the fold this renders — once the agent is `ready` — the
 * SOCKS5 route form (`NetworkRouteForm`).
 *
 * Plan 90 §5 step 90.6: the agent's own lifecycle (install/repair/update/
 * retry/uninstall, version, capabilities) moved OUT of this panel and into
 * the device page's own **Agent** tab (`AgentPanel`) — this tab stops being
 * where agent lifecycle lives, and keeps only a one-line summary linking to
 * it. The status fetch itself stays: `NetworkRouteForm` is only ever shown
 * once the agent is `ready`, and this panel is what decides that.
 *
 * Was `GuestAgentRow`, one row of a fleet-wide table with an
 * expand/collapse chevron; refactored into a single-device panel since
 * list semantics (row, expand toggle) no longer apply here.
 */
export function NetworkPanel({
  deviceId,
  canUse,
}: {
  deviceId: string
  /**
   * The same server-authoritative gate every other mutating control on this
   * page uses (`iHoldControl && !busy`) — a convenience only, the server
   * checks the lease itself on every `network` request regardless.
   */
  canUse: boolean
}) {
  const [status, setStatus] = useState<GuestAgentStatus | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  const load = () => {
    setLoadError(null)
    fetchGuestAgentStatus(deviceId)
      .then(setStatus)
      .catch((e) => setLoadError(e instanceof Error ? e.message : String(e)))
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, [deviceId])

  const agentHref = `/device?id=${encodeURIComponent(deviceId)}&tab=agent`

  // A gated panel always renders its controls, disabled, with one line
  // saying why — never a sentence INSTEAD of the panel (Plan 42 §3.2,
  // §4.2), the same treatment the Files tab uses: "Take control" takes
  // effect immediately without a tab switch.
  const disabled = !canUse

  return (
    <div className="px-5 py-4">
      {disabled && (
        <p className="mb-4 rounded-lg border bg-surface px-3.5 py-2.5 text-[12.5px] text-fg-muted">
          Take control of this device to configure its network route.
        </p>
      )}

      {loadError ? (
        <ErrorState message={loadError} onRetry={load} />
      ) : status === null ? (
        <LoadingRows rows={2} />
      ) : (
        <div className="max-w-3xl space-y-4">
          <Link
            href={agentHref}
            className="flex items-center justify-between gap-3 rounded-lg border bg-surface px-3.5 py-2.5 text-[12.5px] transition-colors hover:border-line-strong"
          >
            <span className="flex items-center gap-2">
              <span className="text-fg-muted">Guest agent</span>
              <AgentStateBadge state={status.state} />
            </span>
            <span className="flex items-center gap-1 text-fg-subtle">
              Install, update, or view capabilities in the Agent tab
              <ChevronRight className="size-3.5" aria-hidden />
            </span>
          </Link>

          {status.state === 'ready' && <NetworkRouteForm deviceId={deviceId} canUse={canUse} />}
        </div>
      )}
    </div>
  )
}
