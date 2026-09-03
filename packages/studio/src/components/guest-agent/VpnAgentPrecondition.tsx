'use client'

import { Loader2 } from 'lucide-react'
import {
  DEFAULT_PREPARATION_COMPONENT_STATUS,
  GuestAgentStatusResponseSchema,
  PreparationComponentStatusSchema,
  type PreparationComponentStatus,
  type PreparationState,
} from '@enkaku/protocol'
import { Button, api, cn, duration, useAction } from '@enkaku/ui'
import { usePreparation } from '@/lib/use-preparation'
import { useNow } from '@/lib/useNow'

/**
 * VPN mode's guest-agent precondition (plan 114 §3.4) — the owner asked for
 * this by name: *"pastikan handler kaya misal kalau pilih vpn gimana kalau
 * guest agentnya belum ke install dll itu tolong dipikirkan juga."*
 *
 * Before step 114.7 an agent-less phone had **no proxy screen at all** (plan
 * 114 F12): `NetworkPanel` gated the whole panel on `state === 'ready'`, so a
 * device that will never run the agent could not even be given the two HTTP
 * rungs, which do not need it. That gate is gone; what replaces it lives here,
 * scoped to the one mode that actually needs the agent.
 *
 * Three rules govern everything below, and none of them is negotiable:
 *
 * 1. **A precondition is not a failure** (plan 59). Nothing has gone wrong on a
 *    phone that simply has no agent yet; the panel names the real state and
 *    offers the fix, rather than painting a red error over an ordinary,
 *    fixable situation.
 * 2. **Never a silent downgrade** (plan 114 §3.1, §3.4 rule 4). If VPN cannot
 *    be applied, nothing falls back to HTTP proxy. The two modes are not
 *    equals — an app can ignore the system proxy and cannot leave the tunnel —
 *    so quietly applying the weaker one would leave an operator believing
 *    traffic is captured when it is not. HTTP proxy is offered as an
 *    *explicit* second choice, with its bypassable sentence attached, needing
 *    a second deliberate click.
 * 3. **Nothing is applied by choosing a mode.** Selecting VPN on a phone that
 *    cannot run it saves nothing, and the panel says so in words rather than
 *    leaving the operator staring at a selected radio that did nothing.
 *
 * The state comes from `devices.preparation['guest-agent']`, which is
 * authoritative since plan 106 step 106.5 — **not** from
 * `GET /:id/guest-agent`, whose `state` is a second, parallel vocabulary that
 * this panel deliberately does not re-derive. `usePreparation` is the same
 * hook the device popup's Preparation section reads (see its own doc comment
 * for why it polls: there is no event for a pass *starting*, only for one
 * finishing), so an install kicked off from here shows its progress here, and
 * an install kicked off from the Agent tab shows up here too.
 */

/** The component id in `devices.preparation`. One string, so a typo cannot silently read an always-absent key. */
export const GUEST_AGENT_COMPONENT_ID = 'guest-agent'

export type AgentReadiness = {
  /** The component's persisted status, or `null` while it has not been read (or could not be). */
  status: PreparationComponentStatus | null
  /** `null` means *we do not know* — never `absent`, which is a claim about the phone. */
  state: PreparationState | null
  /**
   * The record loaded but carries no `guest-agent` key at all. Treated as
   * `absent` (the same synthesis `PreparationPanel` makes, from the protocol
   * package's own default), because every admission/reconnect hook runs a pass
   * — a missing key is a startup race, not a steady state. The distinction is
   * kept because the copy for it differs: the farm has not looked yet, and
   * saying "not installed" flatly would be a claim it has not earned.
   */
  neverChecked: boolean
  loading: boolean
  loadError: string | null
  reload: () => void
  patch: (next: PreparationComponentStatus) => void
}

export function useGuestAgentReadiness(deviceId: string): AgentReadiness {
  const { preparation, loadError, reload, patch } = usePreparation(deviceId)
  const stored = preparation ? (preparation[GUEST_AGENT_COMPONENT_ID] ?? null) : null
  const status = preparation ? (stored ?? DEFAULT_PREPARATION_COMPONENT_STATUS) : null
  return {
    status,
    state: status?.state ?? null,
    neverChecked: preparation !== null && stored === null,
    loading: preparation === null && loadError === null,
    loadError,
    reload,
    patch: (next) => patch(GUEST_AGENT_COMPONENT_ID, next),
  }
}

/**
 * Whether a VPN route genuinely cannot be applied right now.
 *
 * **False while the state is unknown**, deliberately. Blocking the one control
 * that could work, on the strength of a read that failed, would be the
 * inverse mistake of the one this step fixes: a phone whose agent is
 * perfectly ready would be refused by Studio because Studio could not read a
 * record. The server checks the agent itself on every apply and refuses with a
 * real reason, so an unknown state costs at most one honest server error —
 * where a false block costs a working device.
 */
export function agentBlocksVpn(agent: AgentReadiness): boolean {
  return agent.state !== null && agent.state !== 'ready'
}

/** The one-line reason for the disabled Apply button (`docs/design.md` quality floor: a disabled control explains itself). */
export function vpnBlockedReason(agent: AgentReadiness): string | null {
  switch (agent.state) {
    case null:
    case 'ready':
      return null
    case 'absent':
      return 'This phone does not have the Enkaku guest agent yet, and VPN mode needs it.'
    case 'provisioning':
      return 'The guest agent is installing — this becomes available the moment it finishes.'
    case 'outdated':
      return 'The installed guest agent is older than this farm’s. Update it first.'
    case 'failed':
      return 'The guest agent could not be prepared on this phone.'
    case 'unsupported':
      return 'This phone cannot run the Enkaku guest agent.'
    case 'consent-required':
      return 'Android’s VPN permission has to be accepted on the phone itself before this can be applied.'
  }
}

/** Heading and body per state (plan 114 §3.4's own list, worded for an operator rather than for the registry). */
function describeState(agent: AgentReadiness): { title: string; body: string } | null {
  switch (agent.state) {
    case null:
    case 'ready':
      return null
    case 'absent':
      return agent.neverChecked
        ? {
            title: 'The guest agent has not been checked on this phone yet',
            body: 'VPN mode routes this phone’s traffic through the Enkaku guest agent, so it has to be installed before a VPN route can be applied. The farm has not recorded a preparation pass for this phone yet, so this is its starting assumption — installing checks and repairs, and is safe to run even if the app is already there.',
          }
        : {
            title: 'This phone does not have the Enkaku guest agent yet',
            body: 'VPN mode routes this phone’s traffic through the guest agent, so it has to be installed before a VPN route can be applied. Nothing else about this device changes: it still streams, takes input, and runs work that does not need the agent.',
          }
    case 'provisioning':
      return {
        title: 'Installing the guest agent…',
        body: 'VPN mode stays selected. These fields become usable the moment the install finishes — nothing is applied to the phone in the meantime.',
      }
    case 'outdated':
      return {
        title: 'The installed agent is older than this farm’s',
        body: 'Update it to use VPN mode. The route this farm applies is negotiated by capability, so an older build may not carry the tunnel this mode needs.',
      }
    case 'failed':
      return {
        title: 'The guest agent could not be prepared on this phone',
        body: 'The reason the last pass gave is below, verbatim. Retrying clears the standing bound and runs one fresh pass — it does not touch anything else on the device, and a failed agent never stops this phone streaming, taking input, or running work that does not need it.',
      }
    case 'unsupported':
      return {
        title: 'This phone cannot run the Enkaku guest agent',
        body: 'There is nothing to retry — this phone is below what the agent needs (an Android version floor), and an old phone is not a broken one. VPN mode will not become available on this device.',
      }
    // Blocking here is deliberate: `agentBlocksVpn` treats anything other than
    // `ready` as a block, and consent genuinely is one — Android will not let
    // the agent open a tunnel until the dialog is accepted. Applying anyway
    // would report a route as live while the phone kept using its own network,
    // which is the exact "advisory worded as enforcing" failure VPN mode exists
    // to avoid.
    case 'consent-required':
      return {
        title: 'This phone is waiting for you to allow the VPN',
        body: 'The agent is installed and answering — Android just will not let it open a tunnel until someone accepts the system VPN dialog on the phone itself. On some builds (ColorOS among them) adb cannot grant that permission, so there is nothing the farm can do remotely. Accept it on the device, then check again.',
      }
  }
}

/**
 * The precondition itself: rendered above VPN mode's fields whenever the agent
 * cannot serve them, and `null` when it can. Never rendered *instead of* the
 * mode selector or the two HTTP rungs — those never needed the agent and now
 * structurally cannot ask about it.
 */
export function VpnAgentPrecondition({
  deviceId,
  canUse,
  agent,
  unsavedSelection,
  onCancelSelection,
  onChooseHttp,
}: {
  deviceId: string
  /** The same server-authoritative control-activity gate every other mutating control on this page reads. */
  canUse: boolean
  agent: AgentReadiness
  /**
   * The operator has picked VPN on a device whose applied route is something
   * else. Plan 114 §3.4 rule 4: that choice is **not saved and applies
   * nothing** — which has to be visible, or a selected radio reads as a
   * setting that took effect.
   */
  unsavedSelection: boolean
  /** Puts the selector back on whatever is actually applied, so declining is one click rather than a guess. */
  onCancelSelection?: () => void
  /** Plan 114 §3.4 rule 4 — the explicit second choice. Never taken automatically. */
  onChooseHttp?: () => void
}) {
  const { run, isPending, pending } = useAction()
  const now = useNow(1000)

  // An install pushes an APK and provisions it; the HTTP response only lands
  // at the very end, and a dying request is not the same as a failed install
  // (`AgentPanel` carries the same note). `usePreparation` polls on its own,
  // so the row moves to `provisioning` and then to its outcome regardless of
  // what this promise does; this only re-reads once, promptly, when it settles.
  const settle = (p: Promise<unknown>) => void p.then(agent.reload)

  const install = (label: string) =>
    settle(
      run(
        'install',
        // The SAME endpoint the Agent tab uses (plan 114 §3.4 rule 3) — there
        // is deliberately no second install path, and the APK still resolves
        // through the three tiers CLAUDE.md fixes (env override, a local
        // Gradle build, then the sha256-pinned toolchain artefact). It is
        // never auto-built.
        () => api(`/api/devices/${deviceId}/guest-agent`, GuestAgentStatusResponseSchema, { method: 'POST' }),
        {
          success: `${label} started`,
          failure: `Could not ${label.toLowerCase()} the guest agent`,
        },
      ),
    )

  const retryPreparation = (label: string) =>
    run(
      'retry',
      // Plan 114 §3.4's own instruction for `failed`: the preparation retry
      // endpoint, which clears that ONE component's standing bound, rather
      // than a second retry path of this panel's own.
      () =>
        api(`/api/devices/${deviceId}/preparation/${GUEST_AGENT_COMPONENT_ID}/retry`, PreparationComponentStatusSchema, {
          method: 'POST',
        }),
      {
        success: `${label} finished`,
        failure: `Could not ${label.toLowerCase()} the guest agent`,
        onSuccess: agent.patch,
      },
    )

  if (agent.loading) {
    return (
      <p className="flex items-center gap-2 rounded-lg border bg-surface px-3.5 py-2.5 text-[12px] text-fg-muted">
        <Loader2 className="size-3.5 animate-spin" aria-hidden />
        Checking whether this phone has the guest agent…
      </p>
    )
  }

  // A read that failed is NOT a claim about the phone. Say what could not be
  // read, offer the read again, and leave the form usable — the server checks
  // the agent on every apply and refuses with a real reason, which is a far
  // smaller cost than refusing a device whose agent is fine.
  if (agent.loadError) {
    return (
      <div className="rounded-lg border bg-surface p-3.5">
        <h3 className="text-[12.5px] font-medium text-fg">Could not read this phone’s guest-agent state</h3>
        <p className="mt-1 text-[11.5px] leading-relaxed text-fg-muted">
          {agent.loadError}. VPN mode is not blocked on that account — if the agent turns out to be missing, applying
          says so instead of guessing here.
        </p>
        <div className="mt-3 border-t pt-3">
          <Button type="button" size="sm" variant="outline" onClick={agent.reload}>
            Check again
          </Button>
        </div>
      </div>
    )
  }

  const described = describeState(agent)
  if (!described) return null

  const state = agent.state
  const busy = pending !== null
  const primary =
    state === 'absent'
      ? { label: agent.neverChecked ? 'Install and check' : 'Install', act: () => install('Install') }
      : state === 'outdated'
        ? { label: 'Update agent', act: () => install('Update') }
        : state === 'failed'
          ? { label: 'Retry', act: () => void retryPreparation('Retry') }
          : null

  return (
    <div className="rounded-lg border bg-surface p-3.5">
      <div className="flex flex-wrap items-center gap-2">
        {state === 'provisioning' && <Loader2 className="size-3.5 animate-spin text-led-active" aria-hidden />}
        <h3 className="text-[12.5px] font-medium text-fg">{described.title}</h3>
      </div>
      <p className="mt-1 text-[11.5px] leading-relaxed text-fg-muted">{described.body}</p>

      {/* The reason verbatim, never summarised — plan 106's own rule for
          `reason`, and the only thing that makes a `failed`/`unsupported` row
          actionable rather than an enum an operator has to guess at. */}
      {agent.status?.reason && (
        <p
          className={cn(
            'mt-2 rounded border bg-bg px-2.5 py-2 text-[11.5px] leading-relaxed',
            state === 'failed' ? 'border-led-danger/40 text-led-danger' : 'border-line text-fg-muted',
          )}
        >
          {agent.status.reason}
        </p>
      )}

      {/* No byte progress exists for this install — one opaque push-and-provision
          call, with no tick to render (the same ceiling `PreparationPanel`
          states). Elapsed time, never a fabricated percentage. */}
      {state === 'provisioning' && agent.status?.checkedAt && (
        <p className="mt-2 text-[11.5px] text-fg-muted">
          Running for <span className="readout">{duration(agent.status.checkedAt, null, now)}</span> — no progress
          percentage is available for this install, only whether it is still running.
        </p>
      )}

      {primary && (
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t pt-3">
          <Button
            type="button"
            size="sm"
            variant={state === 'absent' ? 'secondary' : 'outline'}
            disabled={!canUse || busy}
            title={canUse ? undefined : 'Take control of this device first'}
            onClick={primary.act}
          >
            {busy ? `${primary.label}…` : primary.label}
          </Button>
          {isPending('install') && (
            <span className="text-[11.5px] text-fg-muted">
              Pushing the APK and provisioning it — this can take a couple of minutes. Safe to leave this tab.
            </span>
          )}
        </div>
      )}

      {/*
        Plan 114 §3.4 rule 4, and the single worst failure this step could ship
        if it were left out. Choosing VPN here has saved NOTHING — and the
        panel must never resolve that by quietly applying the advisory rung
        instead, which would read as "proxy on" either way while an app walked
        straight past it.
      */}
      {unsavedSelection && (
        <div className="mt-3 border-t pt-3">
          <p className="text-[11.5px] leading-relaxed text-fg-muted">
            <span className="font-medium text-fg">Nothing has been applied.</span> Choosing VPN here does not save a
            mode and does not change this phone — it keeps using whatever the route status shows, and nothing has been
            switched to HTTP proxy on your behalf.
          </p>
          {onCancelSelection && (
            <Button type="button" size="sm" variant="ghost" className="mt-2" onClick={onCancelSelection}>
              Keep the current setting
            </Button>
          )}
        </div>
      )}

      {/*
        The explicit second choice — one deliberate click, with the bypassable
        sentence attached to it rather than discovered afterwards. This is the
        offer plan 114 §3.4 rule 4 asks for, and the reason it is a button and
        not a fallback.
      */}
      {onChooseHttp && (
        <div className="mt-3 border-t pt-3">
          <p className="text-[11.5px] leading-relaxed text-fg-muted">
            HTTP proxy mode works on this phone without the agent, but it is not the same thing: apps can ignore it.
            WebView and many HTTP libraries use it; an app with its own networking does not, and nothing on the phone
            stops it.
          </p>
          <Button type="button" size="sm" variant="outline" className="mt-2" onClick={onChooseHttp}>
            Use HTTP proxy instead
          </Button>
        </div>
      )}
    </div>
  )
}
