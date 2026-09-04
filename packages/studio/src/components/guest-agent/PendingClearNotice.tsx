'use client'

import { Hourglass } from 'lucide-react'
import { relativeTime } from '@enkaku/ui'
import type { NetworkStatus } from '@/lib/api'

/** The debt itself — `PersistedNetworkRoute.pendingClear` as it arrives on `GET /:id/network`. */
type PendingClear = NonNullable<NetworkStatus['pendingClear']>

/**
 * **A teardown this farm owes a phone it could not reach.**
 *
 * `DELETE /:id/network` and `POST /:id/network/disable` now accept an OFFLINE
 * device (`requireNetworkDisarmAdmission`, `packages/core/src/network/
 * route-service.ts`) — before that, "turn this off" was unreachable for an
 * absent phone, so a device could go offline carrying an armed, fail-closed
 * VPN and re-apply it on reconnect before an operator could get near it. The
 * price of accepting the request is that the record and the DEVICE now
 * disagree for a while, and `pendingClear` is the only field that says so.
 *
 * Without this component that disagreement was invisible: the panel showed a
 * route that is `enabled: false` yet still fully described, and nothing on
 * screen said the phone was never told, why, since when, or — after a `DELETE`
 * — that the row will vanish on its own once it finally is.
 *
 * **This is not an error, and it must not be styled as one.** Nothing failed,
 * nothing is retryable, and no action is required: `clearOrphanedRoute` settles
 * the debt on the device's next admission. `led-warn` is the ceiling
 * (`led-danger` elsewhere in this product means a phone is actually cut off,
 * and spending it here would teach an operator to ignore it there) — and the
 * only saturated colour in the whole notice is the icon and the heading, with
 * the body in the ordinary `fg-muted` every other explanatory paragraph on this
 * panel uses. It is closer to "queued" than to "broken", which is what the
 * hourglass says before a single word is read.
 *
 * Equally it may not be under-stated: while the debt is outstanding the phone
 * IS still carrying the route, and its traffic IS still going through that
 * proxy — the measured incident behind the whole mechanism was a farm billed
 * for a metered residential upstream a day after the operator turned it off.
 * So the first paragraph says that plainly rather than describing a bookkeeping
 * mismatch.
 */
export function PendingClearNotice({ pendingClear, now }: { pendingClear: PendingClear; now?: number }) {
  const isVpn = pendingClear.engine === 'vpn-helper'

  return (
    /*
     * No viewport breakpoints and no `@container` query of its own: every row
     * here is `flex-wrap` and every long value carries `wrap-anywhere`, so the
     * notice reflows the same way at the device page's ~768px and at the
     * ~360px worst case inside the device popup's Settings pane. A breakpoint
     * would be a statement about the browser window, which is a lie inside a
     * modal (`NetworkRouteForm`'s own note on the same trap).
     */
    <div className="rounded-lg border border-led-warn/35 bg-led-warn/5 p-3.5">
      <div className="flex items-start gap-2.5">
        <Hourglass className="mt-0.5 size-4 shrink-0 text-led-warn" aria-hidden />
        <div className="min-w-0 flex-1">
          {/* 1. What is true right now. The subject is the PHONE, not the record. */}
          <h4 className="text-[13px] font-medium text-led-warn">
            {isVpn ? 'The phone is still carrying this tunnel' : 'The phone is still carrying this proxy'}
          </h4>
          <p className="mt-1 wrap-anywhere text-[11.5px] leading-relaxed text-fg-muted">
            {isVpn ? (
              <>
                This farm has stopped wanting it, and the device was never told to stop. Until it is, this phone’s
                traffic still goes out through that tunnel — through a metered upstream, if that is what it points at.
              </>
            ) : (
              <>
                This farm has stopped wanting it, and the device was never told. Until it is, this phone’s traffic
                still goes out through that proxy — through a metered one, if that is what it points at.
              </>
            )}
          </p>

          {/*
            2. Why — the server's own sentence, verbatim. Never parsed and never
            paraphrased: it is written per engine at the seam that actually knows
            ("the device was offline, so its proxy setting was never cleared" /
            "…so it was never told to stop"), and a client that rewords it will
            drift from the reason the device event log carries for the same fact.
            `wrap-anywhere` for the same reason every other server string on this
            panel has it — the reason can carry an unbroken error code.
          */}
          <p className="mt-2 flex flex-wrap items-baseline gap-x-1.5 text-[11.5px] leading-relaxed">
            <span className="shrink-0 text-fg-subtle">Why:</span>
            <span className="min-w-0 wrap-anywhere text-fg">{pendingClear.reason}</span>
          </p>

          {/*
            4. What happens next — and that nothing is required. This is the
            single most important sentence in the notice: the honest answer is
            "you do not have to do anything", and an operator who does not know
            that goes hunting for a button that does not exist. So it is `text-fg`,
            not muted, and it leads with the reassurance rather than ending on it.
          */}
          <p className="mt-2 wrap-anywhere text-[11.5px] leading-relaxed text-fg">
            <span className="font-medium">Nothing is required of you.</span> The farm settles this by itself the next
            time the device is admitted — it tells the phone then, and this note disappears.
          </p>

          {/*
            `forget` is not a detail: after a `DELETE` the whole row goes when the
            debt settles (the saved address and credentials with it), and after a
            `/disable` only the teardown is owed. Those are materially different
            futures for a credential the operator typed once, and the panel below
            still shows that config either way — so which of the two is coming has
            to be said here rather than left to be discovered when the row vanishes.
          */}
          <p className="mt-1.5 wrap-anywhere text-[11.5px] leading-relaxed text-fg-muted">
            {pendingClear.forget ? (
              <>
                The saved route goes with it: its address, and any saved credentials, are erased once the phone has
                been told. They are still on record — and still shown below — only because the farm needs them to put
                this device back the way it found it.
              </>
            ) : (
              <>
                The saved route stays. Only the teardown is owed, so the address and any saved credentials are kept and
                you can switch it back on later without retyping them.
              </>
            )}
          </p>

          {/*
            3. Since when, plus the two facts an operator reading the phone by
            hand needs to recognise what they are looking at. `relativeTime` is
            what every other time on this panel uses; `since` is deliberately NOT
            refreshed by a later failed attempt on the core side, so how long the
            phone has been carrying this is exactly what this reads.
          */}
          <dl className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1 border-t border-led-warn/20 pt-2 text-[11px]">
            <div className="flex min-w-0 items-baseline gap-1.5">
              <dt className="shrink-0 text-fg-subtle">owed since</dt>
              <dd className="readout min-w-0 text-fg-muted">{relativeTime(pendingClear.since, now)}</dd>
            </div>
            {/* The engine the DEVICE is carrying, which is not necessarily what
                `config` says by now — an engine switch that could not tear the
                incumbent down is exactly the case where the two differ. */}
            <div className="flex min-w-0 items-baseline gap-1.5">
              <dt className="shrink-0 text-fg-subtle">on the phone</dt>
              <dd className="readout min-w-0 wrap-anywhere text-fg-muted">{pendingClear.engine}</dd>
            </div>
            {pendingClear.devicePort !== undefined && (
              /* The loopback address the phone itself still dials, so an
                 operator running `settings get global http_proxy` by hand
                 recognises the value they are looking at as this farm's. */
              <div className="flex min-w-0 items-baseline gap-1.5">
                <dt className="shrink-0 text-fg-subtle">the phone dials</dt>
                <dd className="readout min-w-0 wrap-anywhere text-fg-muted">127.0.0.1:{pendingClear.devicePort}</dd>
              </div>
            )}
          </dl>
        </div>
      </div>
    </div>
  )
}
