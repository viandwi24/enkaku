'use client'

import { useEffect, useState } from 'react'
import { DeviceNetworkStatusResponseSchema } from '@enkaku/protocol'
import { Button, ConfirmDialog, ErrorState, LoadingRows, Switch, api, cn, duration, relativeTime, useAction } from '@enkaku/ui'
import { HttpProxyFields } from '@/components/guest-agent/HttpProxyFields'
import { Choice, ChoiceGroup } from '@/components/guest-agent/RouteChoice'
// Step 114.8 — the two sentences moved to their own module so `BulkProxyDialog`
// renders the SAME words about N devices rather than a second copy that can be
// softened independently (plan 114 risk 1). Nothing about them changed.
import { HTTP_MODE_DESCRIPTION, VPN_MODE_DESCRIPTION } from '@/components/guest-agent/proxy-copy'
import { VpnRouteFields } from '@/components/guest-agent/VpnRouteFields'
import {
  disableNetworkRoute,
  enableNetworkRoute,
  fetchNetworkStatus,
  retryNetworkRoute,
  type GeoObservation,
  type NetworkEngineId,
  type NetworkHealth,
  type NetworkRecoveryStatus,
  type NetworkStatus,
  type RouteCheck,
  type RouteCheckId,
  type RouteCheckState,
} from '@/lib/api'
import { useNow } from '@/lib/useNow'

/**
 * The three modes an operator chooses between (plan 114 §3.10). Deliberately
 * NOT the same list as `NetworkEngineId`: HTTP proxy is two engines, because
 * an authenticated HTTP proxy is only possible when the proxy runs on this
 * farm's machine (plan 114 §3.2, F6), and "where is the proxy?" is a question
 * the operator has to answer anyway. Off is `engine: 'none'`.
 */
type ProxyMode = 'off' | 'http' | 'vpn'

/** The two advisory rungs — `settings put global http_proxy`, which an app is free to ignore. */
function isHttpEngine(engine: NetworkEngineId): boolean {
  return engine === 'adb-proxy' || engine === 'adb-reverse-proxy'
}

function modeOfEngine(engine: NetworkEngineId): ProxyMode {
  if (engine === 'vpn-helper') return 'vpn'
  if (isHttpEngine(engine)) return 'http'
  return 'off'
}

/**
 * What the `mode` row of the status readout says about the route that is
 * actually applied. Names the rung, not just the family: "HTTP proxy" alone
 * would hide the single most consequential difference between the two of them,
 * which is where the proxy — and therefore any account it needs — lives.
 */
const MODE_READOUT: Record<NetworkEngineId, string> = {
  none: 'off',
  'adb-proxy': 'HTTP proxy · a proxy the phone can reach',
  'adb-reverse-proxy': 'HTTP proxy · a proxy on this machine',
  'vpn-helper': 'VPN',
}

/** Honest wording for a health value — `unverified` must never read as success (plan 44 §4.6, point 3). */
const HEALTH_LABEL: Record<NetworkHealth, string> = {
  ok: 'confirmed live',
  unverified: 'applied, not confirmed',
  degraded: 'degraded',
  unknown: 'unknown',
}
const HEALTH_TONE: Record<NetworkHealth, string> = {
  ok: 'text-led-ok border-led-ok/35 bg-led-ok/10',
  unverified: 'text-led-warn border-led-warn/35 bg-led-warn/10',
  degraded: 'text-led-danger border-led-danger/40 bg-led-danger/10',
  unknown: 'text-fg-subtle border-line bg-transparent',
}

function HealthBadge({ health }: { health: NetworkHealth }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium leading-none whitespace-nowrap',
        HEALTH_TONE[health],
      )}
    >
      <span className="size-1.5 rounded-full bg-current" aria-hidden />
      {HEALTH_LABEL[health]}
    </span>
  )
}

/**
 * Plain-language names for the named checks `health` is derived from (plan 51 §4.1, §5.8; plan 114
 * §3.5 added `setting` and `reverse`) —
 * an operator should be able to tell which fact is missing without opening logs (acceptance
 * criterion 9).
 */
const CHECK_LABEL: Record<RouteCheckId, string> = {
  tunnel: 'Tunnel established',
  // Plan 114 §3.5 — deliberately NOT worded as success. `pass` here says the device accepted the
  // write and reads it back, which is a strictly weaker fact than "this phone's traffic goes
  // through that proxy"; the advisory sentence beside the HTTP fields is what makes the
  // difference plain.
  setting: 'Setting confirmed on the device',
  reverse: 'Tunnel to this machine is live',
  upstream: 'Reaches the proxy',
  egress: 'Traffic actually leaves through it',
  geo: 'Exit matches the expected region',
  dns: 'DNS resolver belongs to the proxy',
  leak: 'IPv6 blocked',
}

const CHECK_STATE_LABEL: Record<RouteCheckState, string> = {
  pass: 'confirmed',
  fail: 'failed',
  skip: 'not checked',
  unknown: 'not yet run',
}

const CHECK_STATE_DOT: Record<RouteCheckState, string> = {
  pass: 'bg-led-ok',
  fail: 'bg-led-danger',
  skip: 'bg-fg-subtle',
  unknown: 'bg-led-warn',
}

const CHECK_STATE_TEXT: Record<RouteCheckState, string> = {
  pass: 'text-led-ok',
  fail: 'text-led-danger',
  skip: 'text-fg-subtle',
  unknown: 'text-led-warn',
}

/** Renders a `GeoObservation` for the exit history list — whatever the provider could attribute, `—` for what it could not. */
function describeExitLocation(o: GeoObservation): string {
  const place = [o.city, o.region, o.country].filter((v): v is string => v !== null).join(', ')
  const network = o.isp ?? (o.asn !== null ? `AS${o.asn}` : null)
  return [place || null, network].filter(Boolean).join(' · ') || '—'
}

/** One row of the per-check breakdown — names the fact, its state, and (when present) why, without needing logs (plan 51 §5.8, acceptance criterion 9). */
function CheckRow({ check }: { check: RouteCheck }) {
  return (
    <div className="flex items-start justify-between gap-3 py-1">
      {/* `min-w-0` on both the row's left half and the text block inside it:
          without it a flex child's minimum is its own min-content, so a
          squeezed check row pushes past the panel instead of wrapping — the
          overlapping labels in the same report. */}
      <div className="flex min-w-0 items-start gap-2">
        <span className={cn('mt-1 size-1.5 shrink-0 rounded-full', CHECK_STATE_DOT[check.state])} aria-hidden />
        <div className="min-w-0">
          <div className="text-[12px] text-fg">{CHECK_LABEL[check.id]}</div>
          {/* `wrap-anywhere`, not `break-words`: a check detail is server text
              and routinely carries an unbreakable token (`ENKAKU_NETWORK_PROBE_DNS_ZONE`,
              `packages/probe-server/README.md`). Only `overflow-wrap: anywhere`
              lowers an element's MIN-CONTENT width — `break-word` wraps the
              visible line but still reports the long word as the minimum, which
              is what forced this whole panel to 327px and put a horizontal
              scrollbar under the popup. */}
          {check.detail && <div className="wrap-anywhere text-[11px] leading-relaxed text-fg-muted">{check.detail}</div>}
        </div>
      </div>
      <span className={cn('shrink-0 text-[11px] font-medium whitespace-nowrap', CHECK_STATE_TEXT[check.state])}>
        {CHECK_STATE_LABEL[check.state]}
      </span>
    </div>
  )
}

/**
 * `asked` is its own tone, and that is the whole point of it (plan 114 §3.1
 * rule 2). An HTTP proxy that the device has accepted is a real state, but it
 * is neither a success (`ok`, green — the farm cannot know an app used it) nor
 * a warning (`warn`, amber — nothing is wrong). Painting it either colour
 * would be the wording problem in a different medium.
 */
type ToggleTone = 'off' | 'ok' | 'asked' | 'warn' | 'danger'

/**
 * The on/off toggle's rendering, per mode.
 *
 * The VPN branches are the spec's three states — plus the transient fourth
 * (enabled, no observation reported yet) that falls out of the same fields.
 * `enabled: true` with `observed.up === false` is deliberately its own,
 * alarming state rather than folded into a neutral "on": that silent gap —
 * WiFi up, network `VALIDATED`, no usable internet because the upstream nobody
 * was listening on anymore — is the exact failure this toggle exists to catch.
 *
 * The HTTP branches (plan 114 §3.1) say `asked`, never `on`, and never borrow
 * the VPN wording: there is no device observation in these modes and there
 * never will be one, so "the device has not reported an observation yet" would
 * be a sentence that stays true forever while implying it will not.
 */
function describeToggle(
  status: NetworkStatus,
  engine: NetworkEngineId,
): { checked: boolean; tone: ToggleTone; title: string; note: string } {
  if (!status.config) {
    return {
      checked: false,
      tone: 'off',
      title: 'Route off',
      note: 'Nothing saved yet — choose a mode below, then switch it on.',
    }
  }
  if (isHttpEngine(engine)) {
    if (!status.enabled) {
      return {
        checked: false,
        tone: 'off',
        title: 'Proxy off',
        note: 'The saved proxy address is kept — switch back on without retyping it.',
      }
    }
    const setting = status.checks.find((c) => c.id === 'setting')
    if (setting?.state === 'fail') {
      return {
        checked: true,
        tone: 'danger',
        title: 'Proxy on — the device did not accept the setting',
        note: `${setting.detail ?? 'What the device reads back does not match what was written'}. The phone is not using this proxy.`,
      }
    }
    if (setting?.state === 'pass') {
      return {
        checked: true,
        tone: 'asked',
        title: 'Proxy set — the device was asked to use it',
        note: 'The phone holds the setting and reads it back. Apps that honour it will use this proxy; nothing here can tell you which apps did.',
      }
    }
    return {
      checked: true,
      tone: 'asked',
      title: 'Proxy set — not read back from the device yet',
      note: 'The setting has been written. Nothing has confirmed it on the phone yet.',
    }
  }
  if (!status.enabled) {
    return {
      checked: false,
      tone: 'off',
      title: 'Route off',
      note: 'Saved credentials are kept — switch back on anytime without retyping the password.',
    }
  }
  if (status.observed?.up === true) {
    return {
      checked: true,
      tone: 'ok',
      title: 'Route on',
      note: 'The device confirms traffic is flowing through this route.',
    }
  }
  // Plan 54 §4.1, §4.3 — a HELD route is deliberately blocking traffic, not accidentally leaking
  // it, and must read as neither "ok" (it is not carrying traffic) nor the same alarming "may
  // leak" copy as a genuine down (the whole reason `state` exists on the wire). Recovery is
  // automatic and bounded (plan 54 §3.2) — this is a "wait, or fix the upstream" state, not a
  // "go turn the route off before it leaks" one.
  if (status.observed?.state === 'held') {
    return {
      checked: true,
      tone: 'warn',
      title: 'Route held closed',
      note:
        (status.lastError?.message ?? 'The tunnel could not carry traffic') +
        ' — the device is blocking its own traffic on purpose rather than falling back to its real address. It will recover on its own once the upstream answers again, within a few bounded attempts.',
    }
  }
  if (status.observed?.up === false) {
    return {
      checked: true,
      tone: 'danger',
      title: 'Route on — not carrying traffic',
      note: status.failClosed
        ? 'The device reports this route is not passing traffic. With "fail closed" on, it should hold rather than leak — if this persists, the agent build may predate that protection.'
        : 'The device reports this route is not passing traffic, and "fail closed" is off for this device — it may be sending on its real address. Check the upstream, or turn the route off.',
    }
  }
  return {
    checked: true,
    tone: 'warn',
    title: 'Route on — not yet confirmed',
    note: 'Switched on, but the device has not reported an observation yet.',
  }
}

/**
 * Bounded automatic route recovery, in plain language (plan 90 §3.7 rule 5,
 * fixes F20) — before this the only operator-visible artefact of exhaustion
 * was a static string on the route form; "why was this device dark for four
 * minutes" was unanswerable after the fact. `null` when no automatic
 * recovery has ever run for this route, or once it has genuinely recovered
 * (`attempts` resets to 0 the moment a pass reaches `ready`, plan 90 §3.7
 * rule 1) — this is not shown as a permanent ledger, only a live one.
 *
 * VPN-only in practice: there is nothing to recover in HTTP mode, so
 * `recovery` is null for those engines (plan 114 §4.4) — a settings write
 * either reads back or it does not, and retrying it on a backoff would be
 * theatre.
 */
function describeRecovery(recovery: NetworkRecoveryStatus | null, nowMs: number): string | null {
  if (!recovery || recovery.attempts === 0) return null
  const nowSec = Math.floor(nowMs / 1000)
  const countdown =
    recovery.nextAttemptAt !== null && recovery.nextAttemptAt > nowSec ? duration(nowSec, recovery.nextAttemptAt, nowMs) : null
  if (recovery.exhausted) {
    return countdown
      ? `Gave up after ${recovery.maxAttempts} attempts — retrying in ${countdown}`
      : `Gave up after ${recovery.maxAttempts} attempts — retrying shortly`
  }
  return countdown
    ? `Retrying in ${countdown} (attempt ${recovery.attempts} of ${recovery.maxAttempts})`
    : `Attempt ${recovery.attempts} of ${recovery.maxAttempts} in progress`
}

const TOGGLE_TONE_CLASS: Record<ToggleTone, string> = {
  off: 'text-fg-muted',
  ok: 'text-led-ok',
  asked: 'text-fg',
  warn: 'text-led-warn',
  danger: 'text-led-danger',
}

/**
 * The `set by` row (plan 114 §3.3, step 114.9), for each of the three answers
 * the farm can honestly give.
 *
 * The third one is why this is a function and not `status.setBy?.id ?? '—'`. A
 * dash reads as "unknown", and it is not unknown: a route with no actor either
 * predates the attribution or was re-applied by the farm itself when the phone
 * came back, and neither is somebody setting a route. A device showing a proxy
 * nobody remembers setting is exactly the confusion this row exists to prevent,
 * so the honest sentence is said rather than left as a gap for the operator to
 * fill in with a guess.
 *
 * `you` is deliberately NOT said. This panel does not know which user is
 * looking at it, and "set by you" in front of the wrong operator would be a
 * confident false statement — the id is the fact, and it is what the audit log
 * and the device event log both carry.
 */
function setByReadout(setBy: NetworkStatus['setBy'], now: number): string {
  if (!setBy) return 'the farm — no operator or plugin claimed this route'
  const who = setBy.kind === 'plugin' ? `${setBy.id} (plugin)` : setBy.id
  return `${who}, ${relativeTime(setBy.at, now)}`
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

/**
 * The device's Network → Proxy screen: a mode selector, the body for whichever
 * mode is chosen, and the route status readout (plan 114 §3.10).
 *
 * **The mode selector renders on every device, whatever the guest agent's
 * state.** That is the structural point of the split — VPN is one of three
 * modes, not the price of admission to the screen. Step 114.7 is what removes
 * `NetworkPanel`'s remaining `state === 'ready'` gate and moves the precondition
 * into `VpnRouteFields`, where it belongs; nothing here reads the agent's state
 * and nothing here needs to.
 */
export function NetworkRouteForm({
  deviceId,
  canUse,
}: {
  deviceId: string
  /** Same server-authoritative gate as the rest of the device page's mutating controls — disables the form without hiding the route status above it. */
  canUse: boolean
}) {
  const [status, setStatus] = useState<NetworkStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const { run, isPending } = useAction()
  // The recovery countdown ticks on its own (plan 90 §3.7 rule 5) — a
  // stopped clock reading "retrying in 14s" forever is worse than the
  // static sentence it replaces.
  const now = useNow()
  /**
   * `null` means "follow whatever is applied", which is why this is not seeded
   * from the status in an effect: a seeding effect would have to guard against
   * re-seeding after every apply, and would still stomp an operator who picked
   * a mode while the first fetch was in flight.
   */
  const [picked, setPicked] = useState<ProxyMode | null>(null)

  const load = () => {
    setError(null)
    fetchNetworkStatus(deviceId)
      .then(setStatus)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, [deviceId])

  const removeRoute = () =>
    run('remove', () => api(`/api/devices/${deviceId}/network`, DeviceNetworkStatusResponseSchema, { method: 'DELETE' }), {
      success: 'Route removed',
      failure: 'Could not remove the route',
      onSuccess: load,
    })

  const enableRoute = () =>
    run('enable', () => enableNetworkRoute(deviceId), {
      success: 'Route switched on',
      failure: 'Could not switch the route on',
      onSuccess: setStatus,
    })

  const disableRoute = () =>
    run('disable', () => disableNetworkRoute(deviceId), {
      success: 'Route switched off',
      failure: 'Could not switch the route off',
      onSuccess: setStatus,
    })

  /**
   * Plan 90 §3.7 rule 4 — the honest version of the disable-then-enable
   * workaround (F17): clears the recovery bound and applies once,
   * immediately, without the teardown round trip or the misleading "route
   * is off" UI state along the way.
   */
  const retryRecovery = () =>
    run('retry', () => retryNetworkRoute(deviceId), {
      success: 'Retrying now',
      failure: 'Could not retry the route',
      onSuccess: setStatus,
    })

  if (error) return <ErrorState message={error} onRetry={load} />
  if (status === null) return <LoadingRows rows={2} />

  // What is actually applied on the device, as opposed to what the operator is
  // currently looking at. `status.engine` is the fallback for a route written
  // by a core that predates the union and carries no tag of its own.
  const appliedEngine: NetworkEngineId = status.config?.engine ?? status.engine
  const appliedIsHttp = isHttpEngine(appliedEngine)
  const mode = picked ?? modeOfEngine(appliedEngine)

  const toggle = describeToggle(status, appliedEngine)
  const toggling = isPending('enable') || isPending('disable')
  const recoveryNote = describeRecovery(status.recovery, now)
  const settingCheck = status.checks.find((c) => c.id === 'setting')

  return (
    /*
     * `@container` (Tailwind v4 container queries), not `lg:` — this panel is
     * hosted at two very different widths: the device page's Network tab
     * (~768px, `NetworkPanel`'s own `max-w-3xl`) and the device popup's
     * Settings → Network section (~400px today, ~600-800px once the popup's
     * frame widens). A viewport breakpoint is a statement about the BROWSER
     * WINDOW, and inside a dialog the window is not the box: `lg:` fired on a
     * wide monitor, demanded `1fr + 20rem` inside a ~400px pane, collapsed the
     * flexible column to roughly one word per line and still overflowed —
     * which is the horizontal scrollbar an operator reported. Every breakpoint
     * below is now measured against the width this panel was actually given.
     */
    <div className="@container space-y-4">
      {/*
       * Always visible, never gated on whether a route exists — the bug
       * this fixes is precisely that the old off-switch only appeared once
       * a route was applied, so an operator staring at a device with no
       * visible control had no way to tell the feature had one. Disabled
       * (never hidden) when there is nothing saved to switch on.
       */}
      <div className="flex flex-wrap items-center gap-3 rounded-lg border bg-surface p-3.5">
        <Switch
          checked={toggle.checked}
          disabled={!canUse || !status.config || toggling}
          aria-label={toggle.checked ? 'Turn the network route off' : 'Turn the network route on'}
          onCheckedChange={(checked) => void (checked ? enableRoute() : disableRoute())}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className={cn('text-[13px] font-medium', TOGGLE_TONE_CLASS[toggle.tone])}>{toggle.title}</span>
            {toggling && <span className="text-[11.5px] text-fg-subtle">Working…</span>}
          </div>
          {/* The note embeds server text (`setting.detail`, `lastError.message`), so
              it needs the same `wrap-anywhere` as the check rows below. */}
          <p className="mt-0.5 wrap-anywhere text-[11.5px] leading-relaxed text-fg-muted">{toggle.note}</p>
          {/* Plan 90 §3.7 rule 5, fixes F20 — an attempt count and a live
              countdown instead of the static "not routed" sentence this
              banner showed before this. */}
          {recoveryNote && (
            <p className="mt-1 flex flex-wrap items-center gap-2 text-[11.5px] text-led-warn">
              {recoveryNote}
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-6 px-2 text-[11px]"
                disabled={!canUse || isPending('retry')}
                onClick={() => void retryRecovery()}
              >
                {isPending('retry') ? 'Retrying…' : 'Retry now'}
              </Button>
            </p>
          )}
        </div>
        {status.config && (
          <ConfirmDialog
            trigger={
              <Button type="button" variant="ghost" size="sm" disabled={!canUse}>
                Remove
              </Button>
            }
            title="Remove the saved network route?"
            description={
              appliedIsHttp ? (
                <>
                  This clears the saved proxy and puts the phone’s own proxy setting back the way the farm found
                  it — unlike "turn off", which keeps the address for next time.
                </>
              ) : (
                <>
                  This clears the saved host, port, and credentials — unlike "turn off", which keeps them for next
                  time. Reapplying afterwards means retyping the password.
                </>
              )
            }
            confirmLabel="Remove"
            onConfirm={removeRoute}
          />
        )}
      </div>

      {/*
        The split engages at 45rem (720px) of CONTAINER width, and the number is
        arithmetic rather than taste: the status column is a rigid 20rem, the gap
        is `gap-4` (1rem), and the left column needs 24rem before it stops being
        a column of single words — its own worst case is the host/port row
        inside a `p-3.5` card, i.e. 24rem − 1.75rem of padding = 22.25rem, of
        which the port takes 7rem and the gap 0.75rem, leaving 14.5rem for the
        host field. 24 + 1 + 20 = 45rem. Below that the two panels stack, which
        is always correct and never overflows.

        `minmax(0,1fr)` rather than `1fr`: a bare `1fr` is `minmax(auto,1fr)`,
        so the flexible column refuses to shrink below its own min-content and
        pushes the grid wider than its container — the second half of the same
        overflow bug.
      */}
      <div className="grid gap-4 @min-[45rem]:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="space-y-4">
          {/*
            Plan 114 §3.1 rule 1, acceptance criterion 2 — the difference
            between the modes is stated HERE, at the point of choice, in
            ordinary words. Not in a tooltip, not in the docs, and not only
            after the operator has already picked one. The two sentences are
            asserted verbatim by a test for exactly that reason: the whole
            feature turns on an operator not believing HTTP proxy captures
            their traffic.
          */}
          <ChoiceGroup label="mode">
            <Choice
              name={`mode-${deviceId}`}
              value="off"
              checked={mode === 'off'}
              onSelect={() => setPicked('off')}
              disabled={!canUse}
              title="Off"
              description="No proxy. The phone uses whatever network path it already has."
            />
            <Choice
              name={`mode-${deviceId}`}
              value="http"
              checked={mode === 'http'}
              onSelect={() => setPicked('http')}
              disabled={!canUse}
              title="HTTP proxy"
              description={HTTP_MODE_DESCRIPTION}
            />
            <Choice
              name={`mode-${deviceId}`}
              value="vpn"
              checked={mode === 'vpn'}
              onSelect={() => setPicked('vpn')}
              disabled={!canUse}
              title="VPN"
              description={VPN_MODE_DESCRIPTION}
            />
          </ChoiceGroup>

          {mode === 'off' && (
            <div className="rounded-lg border bg-surface p-3.5">
              <h3 className="rack-label mb-2.5">off</h3>
              {status.config ? (
                <>
                  {/*
                    One sentence about THIS phone, not a sentence about both
                    possibilities (plan 114 §3.6 rule 4, criterion 6). Restoring
                    a captured value and clearing the keys are different
                    outcomes, and an operator deciding whether to press the
                    button needs to know which one they are about to get.
                    `captured` is optional on the wire because a core older than
                    step 114.10 answers without it — `undefined` there means
                    "this farm cannot say", which is a third answer and is
                    worded as one rather than being rounded down to "cleared".
                  */}
                  <p className="text-[11.5px] leading-relaxed text-fg-muted">
                    {status.captured === undefined ? (
                      <>
                        Turning the proxy off clears the saved route and puts the phone’s own proxy setting back the
                        way the farm found it — if it captured one. This farm is not reporting whether it did, so
                        which of those happens cannot be shown here.
                      </>
                    ) : status.captured ? (
                      <>
                        Turning the proxy off clears the saved route and puts this phone’s own proxy setting back to
                        what the farm found on it, captured {relativeTime(status.captured.at)}.
                      </>
                    ) : (
                      <>
                        Turning the proxy off clears the saved route and clears this phone’s proxy setting. The farm
                        never captured an original value for it — a route saved before this existed, or a phone that
                        was unreachable when it was applied — so there is nothing to put back, which is not the same
                        as restoring.
                      </>
                    )}
                  </p>
                  <p className="mt-1.5 text-[11px] leading-relaxed text-fg-subtle">
                    To keep the saved route and stop using it for now, use the switch above instead.
                  </p>
                  <div className="mt-3 border-t pt-3">
                    <ConfirmDialog
                      trigger={
                        <Button type="button" size="sm" variant="outline" disabled={!canUse}>
                          Turn off and restore
                        </Button>
                      }
                      title="Turn the proxy off?"
                      description={
                        <>
                          The saved route is cleared and the phone’s own proxy setting is put back the way the farm
                          found it.
                        </>
                      }
                      confirmLabel="Turn off"
                      onConfirm={removeRoute}
                    />
                  </div>
                </>
              ) : (
                <p className="text-[11.5px] leading-relaxed text-fg-muted">
                  No proxy is set on this phone. It reaches the network on its own address.
                </p>
              )}
            </div>
          )}

          {mode === 'http' && (
            <HttpProxyFields
              deviceId={deviceId}
              canUse={canUse}
              status={status}
              onApplied={setStatus}
              onChooseVpn={() => setPicked('vpn')}
            />
          )}

          {mode === 'vpn' && (
            <VpnRouteFields
              deviceId={deviceId}
              canUse={canUse}
              status={status}
              onApplied={setStatus}
              /*
               * Plan 114 §3.4 rule 4 — VPN is what the operator is LOOKING at,
               * not what the phone has. `picked` is local state: nothing is
               * saved until Apply, and on a phone whose agent cannot serve this
               * mode there may be no Apply to press. The precondition says so
               * in words rather than leaving a selected radio to read as a
               * setting that took effect — and the panel never resolves it by
               * quietly applying the advisory rung instead.
               */
              unsavedSelection={picked === 'vpn' && modeOfEngine(appliedEngine) !== 'vpn'}
              onCancelSelection={() => setPicked(null)}
              /* The explicit second choice, never an automatic downgrade. */
              onChooseHttp={() => setPicked('http')}
            />
          )}
        </div>

        <div className="rounded-lg border bg-surface p-3.5">
          <h3 className="rack-label mb-2.5">route status</h3>
          <dl className="space-y-1.5">
            {/* Plan 114 §3.10 — above `engine`, because "which of the three
                modes is this phone in" is the operator's question and
                `adb-reverse-proxy` is a registry id they never typed. */}
            <Row label="mode" value={MODE_READOUT[appliedEngine]} />
            <Row label="engine" value={status.engine} />
            {/*
              `asked`, not `yes` (plan 114 §3.1 rule 2). The farm asked the
              device to use this proxy; it cannot know the device obeyed, and
              no app on the phone is obliged to. The VPN rung keeps `yes`
              because the route it applies is not one an app can decline.
            */}
            <Row label="enabled" value={status.enabled ? (appliedIsHttp ? 'asked' : 'yes') : 'no'} />
            {appliedIsHttp && (
              <Row
                label="setting confirmed on the device"
                value={
                  settingCheck?.state === 'pass'
                    ? 'yes'
                    : settingCheck?.state === 'fail'
                      ? 'no'
                      : settingCheck?.state === 'skip'
                        ? 'not checked'
                        : 'not checked yet'
                }
              />
            )}
            {/* Fail-closed is a property of the VPN tunnel. Showing it in HTTP
                mode would read as a promise this rung cannot make — there is
                no tunnel to hold closed, and an app that ignores the setting
                was never inside anything to be held. */}
            {!appliedIsHttp && <Row label="fail closed" value={status.failClosed ? 'yes' : 'no — may leak on failure'} />}
            {/*
              Who set this (plan 114 §3.3, step 114.9). Shown whenever a route
              exists, INCLUDING when nobody claimed it — see `setByReadout`.
              An operator and the proxy-manager plugin can both write this
              device's route, resolved as last-write-wins with attribution
              rather than a lock (a lock between a person and a plugin produces
              a device nobody can fix), so the attribution is the only thing
              that makes the outcome legible.
            */}
            {status.config && <Row label="set by" value={setByReadout(status.setBy, now)} />}
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-[12px] text-fg-subtle">health</dt>
              <dd>
                <HealthBadge health={status.health} />
              </dd>
            </div>
          </dl>

          {status.health === 'unverified' && (
            <p className="mt-2.5 text-[11.5px] leading-relaxed text-fg-muted">
              {appliedIsHttp
                ? 'This is the normal, permanent state for an HTTP proxy: the setting is on the phone, and no check can confirm an app actually used it.'
                : 'The route was applied and the device accepted it, but no egress check has confirmed traffic is actually leaving through this proxy yet.'}
            </p>
          )}

          {/* The per-check breakdown health is derived from (plan 51 §4.1, §5.8) — an operator
              can see WHICH fact is missing or failed without opening logs (acceptance criterion 9),
              rather than staring at one opaque enum. Always shown once a route exists, even when
              every check is still `unknown`. */}
          {status.checks.length > 0 && (
            <div className="mt-2.5 divide-y border-t">
              {status.checks.map((check) => (
                <CheckRow key={check.id} check={check} />
              ))}
            </div>
          )}

          {status.drift && (
            <div className="mt-2.5 rounded border border-led-warn/35 bg-led-warn/5 px-2.5 py-2 text-[11.5px] text-led-warn">
              What the device reports does not match what was requested — see the readings below.
            </div>
          )}

          {status.config === null ? (
            <p className="mt-2.5 border-t pt-2.5 text-[11.5px] text-fg-subtle">No route saved yet.</p>
          ) : status.config.engine === 'adb-proxy' ? (
            <dl className="mt-2.5 space-y-1.5 border-t pt-2.5">
              <Row label="requested proxy" value={`${status.config.host}:${status.config.port}`} />
            </dl>
          ) : status.config.engine === 'adb-reverse-proxy' ? (
            <dl className="mt-2.5 space-y-1.5 border-t pt-2.5">
              <Row label="proxy on this machine" value={`127.0.0.1:${status.config.hostPort}`} />
              {/* The loopback address the phone itself dials — allocated by the
                  farm, never typed, and worth showing so an operator reading
                  `settings get global http_proxy` on the device recognises it. */}
              <Row
                label="the phone dials"
                value={status.config.devicePort ? `127.0.0.1:${status.config.devicePort}` : 'not established yet'}
              />
            </dl>
          ) : (
            <dl className="mt-2.5 space-y-1.5 border-t pt-2.5">
              <Row label="requested upstream" value={`${status.config.host}:${status.config.port}`} />
              <Row label="requested udp mode" value={status.config.udpMode} />
            </dl>
          )}

          {appliedIsHttp ? (
            <p className="mt-2.5 border-t pt-2.5 text-[11.5px] text-fg-subtle">
              This mode has nothing for the device to report beyond the setting itself, which is checked above.
            </p>
          ) : status.observed ? (
            <dl className="mt-2.5 space-y-1.5 border-t pt-2.5">
              {/* Plan 54 §4.1, §5.7 — `up` alone reads `no` for both `held` and `down`; the state
                  row is what actually distinguishes "blocking on purpose" from "not routed at
                  all", the same distinction the toggle banner above states in plain language. */}
              <Row
                label="up (device)"
                value={status.observed.state === 'held' ? 'no — held closed' : status.observed.up ? 'yes' : 'no'}
              />
              <Row label="upstream (device)" value={status.observed.upstream ?? '—'} />
            </dl>
          ) : (
            <p className="mt-2.5 border-t pt-2.5 text-[11.5px] text-fg-subtle">
              The device has not reported a route observation yet.
            </p>
          )}

          {status.lastError && (
            <div className="mt-2.5 rounded border border-led-danger/40 bg-led-danger/5 px-2.5 py-2 text-[11.5px]">
              {/* Same reason as `CheckRow`'s detail: an error code and an
                  upstream's message are both unbroken tokens often enough. */}
              <span className="readout wrap-anywhere font-medium text-led-danger">{status.lastError.code}</span>
              <p className="mt-0.5 wrap-anywhere text-fg-muted">{status.lastError.message}</p>
            </div>
          )}

          {/* Plan 90 §3.7 rule 5, fixes F20 — the full bookkeeping behind the
              banner's short countdown, so "why was this device dark for four
              minutes" is answerable from this panel, not only the Logs tab's
              `network.recovery.*` events. */}
          {status.recovery && (
            <div className="mt-2.5 border-t pt-2.5">
              <div className="flex items-center justify-between gap-2">
                <h4 className="text-[12px] font-medium text-fg-subtle">automatic recovery</h4>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2 text-[11px]"
                  disabled={!canUse || isPending('retry')}
                  onClick={() => void retryRecovery()}
                >
                  {isPending('retry') ? 'Retrying…' : 'Retry now'}
                </Button>
              </div>
              <dl className="mt-1 space-y-1.5">
                <Row label="attempts" value={`${status.recovery.attempts} of ${status.recovery.maxAttempts}`} />
                <Row label="exhausted" value={status.recovery.exhausted ? 'yes' : 'no'} />
                <Row
                  label="next attempt"
                  value={status.recovery.nextAttemptAt ? new Date(status.recovery.nextAttemptAt * 1000).toLocaleTimeString() : '—'}
                />
                <Row label="resets this hour" value={`${status.recovery.reconnectCycles}`} />
              </dl>
            </div>
          )}

          {/* Plan 55 §3.4, §4.3, §4.4 — a short list, not a chart: three addresses in an
              afternoon is itself the signal a rotating pool is drifting, visible without reading
              logs (acceptance criterion 7). Only rendered once there is at least one observation
              — an unconfigured geo provider means this stays empty forever, which is honest. */}
          {status.exitHistory.length > 0 && (
            <div className="mt-2.5 border-t pt-2.5">
              <h4 className="text-[12px] font-medium text-fg-subtle">exit history</h4>
              <ul className="mt-1.5 space-y-1">
                {status.exitHistory.map((o, i) => (
                  // eslint-disable-next-line react/no-array-index-key -- addresses can repeat; (address, at) pairs are the real key but at can collide within the same second too.
                  // Three facts on one line only while there is room for three:
                  // the timestamp is `shrink-0` (a truncated date is useless), so
                  // below roughly 20rem it wraps to its own line instead of
                  // squeezing the address and the location into two ellipses.
                  <li key={`${o.at}-${i}`} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 text-[11.5px]">
                    <span className="readout min-w-0 truncate text-fg">{o.address}</span>
                    <span className="min-w-0 truncate text-fg-muted">{describeExitLocation(o)}</span>
                    <span className="shrink-0 text-fg-subtle">{new Date(o.at * 1000).toLocaleString()}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
