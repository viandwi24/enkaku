'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { ChevronRight } from 'lucide-react'
import { AgentStateBadge } from '@/components/guest-agent/AgentStateBadge'
import { NetworkRouteForm } from '@/components/guest-agent/NetworkRouteForm'
import { Button } from '@enkaku/ui'
import { fetchGuestAgentStatus, type GuestAgentStatus } from '@/lib/api'

/**
 * The device page's Network tab (plan 44 §4.6) — moved here from a
 * standalone `/guest-agents` list page, because this is a per-device
 * concern and per-device concerns belong on the device page, the same
 * reasoning behind every other tab here (Files, Terminal, Monitor, ...).
 *
 * Named "Network" rather than "Guest Agent": the operator's concern is this
 * device's network route, not the implementation detail that makes it
 * possible. Below the fold this renders the proxy screen itself
 * (`NetworkRouteForm`) — a mode selector with three modes and a body for
 * whichever one is chosen.
 *
 * **Step 114.7 removed this panel's `state === 'ready'` gate** (plan 114 F12,
 * §3.4). It used to render the route form only when the guest agent was
 * `ready`, which meant a phone with no agent had no proxy screen at all — not
 * even the two HTTP rungs, which never needed the agent, and which are the
 * whole point of the mode split. The agent state now gates exactly one thing,
 * inside exactly one place: VPN mode's own body, as a precondition with a fix
 * (`VpnAgentPrecondition`). It never gates the screen, and it never silently
 * downgrades a chosen VPN to the advisory rung.
 *
 * The summary row's own fetch is likewise never allowed to take the screen
 * down with it: a device that cannot answer `GET /:id/guest-agent` (offline,
 * mid-reconnect) still gets its proxy screen, with the failure stated verbatim
 * on the one row it actually belongs to.
 *
 * Plan 90 §5 step 90.6: the agent's own lifecycle (install/repair/update/
 * retry/uninstall, version, capabilities) moved OUT of this panel and into
 * the device page's own **Agent** tab (`AgentPanel`) — this tab stops being
 * where agent lifecycle lives, and keeps only a one-line summary linking to
 * it.
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
   * checks the control activity itself on every `network` request regardless.
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
    /*
     * `px-5` was written for a device-page TAB, which supplies no padding of
     * its own. The Settings popup's section pane does, so the same 40px there
     * is 10% of a ~400px pane spent twice. `@container` lets the panel keep the
     * page's breathing room and drop it in the dialog, without a prop that says
     * "I am in a modal".
     *
     * The container is a SEPARATE element from the padded one on purpose: a
     * size container's own padding changes the width its own queries read, so
     * `@container` and `@min-…:px-5` on one element can oscillate.
     */
    <div className="@container">
      <div className="py-4 @min-[32rem]:px-5">
        {disabled && (
          <p className="mb-4 rounded-lg border bg-surface px-3.5 py-2.5 text-[12.5px] text-fg-muted">
            Take control of this device to configure its network route.
          </p>
        )}

        <div className="max-w-3xl space-y-4">
          {/*
            `flex-wrap`, and the right-hand sentence is no longer `shrink-0`:
            a non-shrinking flex child sized to a full sentence is a guaranteed
            overflow the moment the row is narrower than that sentence, which is
            most of the width range this panel is now hosted at.
          */}
          <Link
            href={agentHref}
            className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 rounded-lg border bg-surface px-3.5 py-2.5 text-[12.5px] transition-colors hover:border-line-strong"
          >
            <span className="flex min-w-0 items-center gap-2">
              <span className="shrink-0 text-fg-muted">Guest agent</span>
              {/*
                Three renderings, none of which is allowed to become the whole
                screen: the state once it is known, a quiet "checking" while it
                is not, and the failure verbatim when the fetch itself did not
                answer. A failed read here says nothing about the proxy modes
                below it — only VPN mode needs the agent, and it reads
                `devices.preparation` for itself.
              */}
              {loadError ? (
                <span className="min-w-0 truncate text-led-danger" title={loadError}>
                  {loadError}
                </span>
              ) : status === null ? (
                <span className="text-fg-subtle">checking…</span>
              ) : (
                <AgentStateBadge state={status.state} />
              )}
            </span>
            <span className="flex min-w-0 items-center gap-1 text-fg-subtle">
              Install, update, or view capabilities in the Agent tab
              <ChevronRight className="size-3.5 shrink-0" aria-hidden />
            </span>
          </Link>

          {loadError && (
            <div>
              <Button type="button" size="sm" variant="outline" onClick={load}>
                Check the agent again
              </Button>
            </div>
          )}

          {/* Plan 114 F12 — unconditional. A phone with no agent, an agent that
              failed, or one this farm has never asked about all get the same
              working proxy screen; what differs is only what VPN mode's own body
              says when it is opened. */}
          <NetworkRouteForm deviceId={deviceId} canUse={canUse} />
        </div>
      </div>
    </div>
  )
}
