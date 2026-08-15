'use client'

import { useEffect, useRef, useState } from 'react'
import { DeviceNetworkStatusResponseSchema } from '@enkaku/protocol'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { ErrorState, LoadingRows } from '@/components/states'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { api, useAction } from '@/lib/actions'
import {
  disableNetworkRoute,
  enableNetworkRoute,
  fetchNetworkStatus,
  retryNetworkRoute,
  type GeoObservation,
  type NetworkHealth,
  type NetworkRecoveryStatus,
  type NetworkStatus,
  type NetworkUdpMode,
  type RouteCheck,
  type RouteCheckId,
  type RouteCheckState,
} from '@/lib/api'
import { duration } from '@/lib/format'
import { useNow } from '@/lib/useNow'
import { cn } from '@/lib/utils'

/**
 * A `socks5://user:pass@host:port` URL, parsed in the browser only — the raw
 * URL is never sent anywhere, it just fills the fields below (plan 44 §4.6:
 * "Accept a SOCKS5 URL paste as a convenience... Parse it in the browser; do
 * not send the raw URL."). Returns null for anything that is not a
 * `socks5:` URL with an explicit host and port.
 */
function parseSocks5Url(
  raw: string,
): { host: string; port: number; username?: string; password?: string } | null {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    return null
  }
  if (url.protocol !== 'socks5:' || !url.hostname || !url.port) return null
  const port = Number(url.port)
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null
  return {
    host: url.hostname,
    port,
    username: url.username ? decodeURIComponent(url.username) : undefined,
    password: url.password ? decodeURIComponent(url.password) : undefined,
  }
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
 * Plain-language names for the six named checks `health` is derived from (plan 51 §4.1, §5.8) —
 * an operator should be able to tell which fact is missing without opening logs (acceptance
 * criterion 9).
 */
const CHECK_LABEL: Record<RouteCheckId, string> = {
  tunnel: 'Tunnel established',
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
      <div className="flex items-start gap-2">
        <span className={cn('mt-1 size-1.5 shrink-0 rounded-full', CHECK_STATE_DOT[check.state])} aria-hidden />
        <div>
          <div className="text-[12px] text-fg">{CHECK_LABEL[check.id]}</div>
          {check.detail && <div className="text-[11px] leading-relaxed text-fg-muted">{check.detail}</div>}
        </div>
      </div>
      <span className={cn('shrink-0 text-[11px] font-medium whitespace-nowrap', CHECK_STATE_TEXT[check.state])}>
        {CHECK_STATE_LABEL[check.state]}
      </span>
    </div>
  )
}

type ToggleTone = 'off' | 'ok' | 'warn' | 'danger'

/**
 * The on/off toggle's rendering, driven by exactly the three states called
 * out in the spec — plus the transient fourth (enabled, no observation
 * reported yet) that falls out of the same fields. `enabled: true` with
 * `observed.up === false` is deliberately its own, alarming state rather
 * than folded into a neutral "on": that silent gap — WiFi up, network
 * `VALIDATED`, no usable internet because the upstream nobody was
 * listening on anymore — is the exact failure this toggle exists to catch.
 */
function describeToggle(status: NetworkStatus): { checked: boolean; tone: ToggleTone; title: string; note: string } {
  if (!status.config) {
    return {
      checked: false,
      tone: 'off',
      title: 'Route off',
      note: 'Nothing saved yet — apply a route below, then switch it on.',
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
  warn: 'text-led-warn',
  danger: 'text-led-danger',
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
 * The route status and the apply/remove form for a `ready` device (plan 44
 * §4.6). Only ever rendered for a device whose guest agent is `ready` —
 * `NetworkPanel` gates that, this component does not re-check it.
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
  // The form is seeded from `config` exactly once, the first time it
  // loads — re-seeding on every reload would stomp on an operator's
  // in-progress edit the moment `apply`'s response comes back.
  const seeded = useRef(false)

  const [host, setHost] = useState('')
  const [port, setPort] = useState('')
  const [username, setUsername] = useState('')
  // Never pre-filled from the server — the API does not return one, and this
  // stays true even after a successful apply (plan 44 §4.6, point 4).
  const [password, setPassword] = useState('')
  const [udpMode, setUdpMode] = useState<NetworkUdpMode>('udp')
  // Plan 54 §4.2, §5.6 — defaults true (the safe reading) until the server's own value is seeded
  // in, matching `resolveFailClosed()`'s own default so the switch never flashes "off" for an
  // instant on a route that will read `true` a moment later.
  const [failClosed, setFailClosed] = useState(true)
  // Asking for an anonymous upstream has to be explicit: blank credential fields mean "keep the
  // stored one", because the API never returns a username for them to be seeded from.
  const [clearCredential, setClearCredential] = useState(false)
  const [pasteUrl, setPasteUrl] = useState('')
  const [pasteError, setPasteError] = useState<string | null>(null)

  // Plan 55 §3.1, §4.1, §4.4 — the expected-exit fields. `country` alone enables the `geo` check
  // (acceptance criterion 1); the rest narrow it further, per §3.3's "match at the narrowest
  // level declared". Blank means "not declared", never a guessed default.
  const [expectCountry, setExpectCountry] = useState('')
  const [expectRegion, setExpectRegion] = useState('')
  const [expectCity, setExpectCity] = useState('')
  const [expectAsn, setExpectAsn] = useState('')
  const [expectIsp, setExpectIsp] = useState('')
  // Plan 55 §3.5, §4.1, §5.6 — defaults to the safe reading until the server's own value is
  // seeded in, matching `resolveOnGeoFail()`'s own default.
  const [onGeoFail, setOnGeoFail] = useState<'report' | 'hold'>('report')

  const load = () => {
    setError(null)
    fetchNetworkStatus(deviceId)
      .then(setStatus)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, [deviceId])

  useEffect(() => {
    if (status?.config && !seeded.current) {
      seeded.current = true
      setHost(status.config.host)
      setPort(String(status.config.port))
      setUdpMode(status.config.udpMode)
      setFailClosed(status.failClosed)
      const expect = status.config.expect
      setExpectCountry(expect?.country ?? '')
      setExpectRegion(expect?.region ?? '')
      setExpectCity(expect?.city ?? '')
      setExpectAsn(expect?.asn !== undefined ? String(expect.asn) : '')
      setExpectIsp(expect?.isp ?? '')
      setOnGeoFail(status.config.onGeoFail)
    }
  }, [status])

  function fillFromPastedUrl() {
    const parsed = parseSocks5Url(pasteUrl)
    if (!parsed) {
      setPasteError('Not a socks5://user:pass@host:port URL with an explicit port')
      return
    }
    setPasteError(null)
    setHost(parsed.host)
    setPort(String(parsed.port))
    setUsername(parsed.username ?? '')
    setPassword(parsed.password ?? '')
    setPasteUrl('')
  }

  const portNum = Number(port)
  const canApply =
    canUse && host.trim().length > 0 && Number.isInteger(portNum) && portNum >= 1 && portNum <= 65535

  const expectAsnNum = expectAsn.trim() ? Number(expectAsn.trim()) : undefined
  // A bare country is enough to enable the check (Plan 55 §4.1); everything else is optional and
  // only sent when actually filled in. No country at all means "no expectation" — omit `expect`
  // entirely rather than send an empty object the server would reject (`country` is required).
  const expect = expectCountry.trim()
    ? {
        country: expectCountry.trim().toUpperCase(),
        ...(expectRegion.trim() ? { region: expectRegion.trim() } : {}),
        ...(expectCity.trim() ? { city: expectCity.trim() } : {}),
        ...(expectAsnNum !== undefined && Number.isInteger(expectAsnNum) && expectAsnNum > 0 ? { asn: expectAsnNum } : {}),
        ...(expectIsp.trim() ? { isp: expectIsp.trim() } : {}),
      }
    : undefined

  const applyRoute = () =>
    run(
      'apply',
      () =>
        api(`/api/devices/${deviceId}/network`, DeviceNetworkStatusResponseSchema, {
          method: 'PUT',
          json: {
            host: host.trim(),
            port: portNum,
            username: username.trim() ? username.trim() : undefined,
            password: password ? password : undefined,
            udpMode,
            failClosed,
            clearCredential: clearCredential ? true : undefined,
            expect,
            onGeoFail,
          },
        }),
      {
        success: 'Route applied',
        failure: 'Could not apply the route',
        onSuccess: (s) => {
          setStatus(s)
          // Already sent; nothing left for the field to do, and it should
          // not linger in the DOM longer than it has to.
          setPassword('')
        },
      },
    )

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

  const toggle = describeToggle(status)
  const toggling = isPending('enable') || isPending('disable')
  const recoveryNote = describeRecovery(status.recovery, now)

  return (
    <div className="space-y-4">
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
          <p className="mt-0.5 text-[11.5px] leading-relaxed text-fg-muted">{toggle.note}</p>
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
              <>
                This clears the saved host, port, and credentials — unlike "turn off", which keeps them for next
                time. Reapplying afterwards means retyping the password.
              </>
            }
            confirmLabel="Remove"
            onConfirm={removeRoute}
          />
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_20rem]">
        <form
          className="rounded-lg border bg-surface p-3.5"
          onSubmit={(e) => {
            e.preventDefault()
            void applyRoute()
          }}
        >
          <h3 className="rack-label mb-2.5">socks5 upstream</h3>

          <div className="mb-3 flex items-end gap-2">
            <div className="flex-1 space-y-1.5">
              <Label htmlFor={`paste-${deviceId}`} className="text-[12px] font-normal text-fg-muted">
                Paste a socks5:// URL to fill the fields below
              </Label>
              <Input
                id={`paste-${deviceId}`}
                placeholder="socks5://user:pass@host:1080"
                value={pasteUrl}
                onChange={(e) => setPasteUrl(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    fillFromPastedUrl()
                  }
                }}
                disabled={!canUse}
              />
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={fillFromPastedUrl}
              disabled={!canUse || !pasteUrl.trim()}
            >
              Fill fields
            </Button>
          </div>
          {pasteError && <p className="mb-3 text-[11.5px] text-led-danger">{pasteError}</p>}

          <div className="grid gap-3 sm:grid-cols-[1fr_7rem]">
            <div className="space-y-1.5">
              <Label htmlFor={`host-${deviceId}`} className="text-[12px] font-normal">
                Host
              </Label>
              <Input
                id={`host-${deviceId}`}
                value={host}
                onChange={(e) => setHost(e.target.value)}
                placeholder="proxy.example.com"
                disabled={!canUse}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`port-${deviceId}`} className="text-[12px] font-normal">
                Port
              </Label>
              <Input
                id={`port-${deviceId}`}
                inputMode="numeric"
                value={port}
                onChange={(e) => setPort(e.target.value)}
                placeholder="1080"
                disabled={!canUse}
              />
            </div>
          </div>

          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor={`username-${deviceId}`} className="text-[12px] font-normal">
                Username
              </Label>
              <Input
                id={`username-${deviceId}`}
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="off"
                disabled={!canUse}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`password-${deviceId}`} className="text-[12px] font-normal">
                Password
              </Label>
              <Input
                id={`password-${deviceId}`}
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="off"
                disabled={!canUse}
              />
              <p className="text-[11px] text-fg-subtle">Never shown back — type it again to change the route.</p>
            </div>
          </div>

          {/*
            Which credential this route actually authenticates with. Without this the fields above
            read blank on a route that HAS one, and saving again dropped it — connecting anonymously
            to an upstream that may accept it and hand back a default-pool exit, so the route looks
            healthy while the requested targeting is silently gone.
          */}
          <div className="mt-2 text-[11px]">
            {clearCredential ? (
              <p className="text-led-warn">
                Saving will drop the stored credential and connect with no authentication.{' '}
                <button type="button" className="underline" onClick={() => setClearCredential(false)}>
                  Keep it
                </button>
              </p>
            ) : status?.config?.credentialRef ? (
              <p className="text-fg-subtle">
                Authenticating with stored credential <span className="font-mono text-fg-muted">{status.config.credentialRef}</span>. Leave
                the fields above blank to keep it, or type a new username and password to replace it.{' '}
                <button type="button" className="underline" onClick={() => setClearCredential(true)} disabled={!canUse}>
                  Use no authentication
                </button>
              </p>
            ) : (
              <p className="text-fg-subtle">This route has no stored credential — it connects to the upstream anonymously.</p>
            )}
          </div>

          <div className="mt-3 space-y-1.5">
            <Label htmlFor={`udp-${deviceId}`} className="text-[12px] font-normal">
              UDP mode
            </Label>
            <Select value={udpMode} onValueChange={(v) => setUdpMode(v as NetworkUdpMode)} disabled={!canUse}>
              <SelectTrigger id={`udp-${deviceId}`} className="w-full sm:w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="udp">UDP (native)</SelectItem>
                <SelectItem value="tcp">TCP only</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Plan 54 §4.2, §5.6, §5.7 — the default IS the safe behaviour (does not leak); this
              switch is the explicit opt-out for an operator debugging by hand, not a knob most
              people ever need to touch. The consequence is stated plainly either way, since a
              held-but-unreachable device still needs an operator to know that's what happened. */}
          <div className="mt-3 flex items-start gap-2.5 rounded border bg-bg px-2.5 py-2">
            <Switch
              id={`fail-closed-${deviceId}`}
              checked={failClosed}
              onCheckedChange={setFailClosed}
              disabled={!canUse}
              className="mt-0.5"
              aria-label="Fail closed on tunnel failure"
            />
            <Label htmlFor={`fail-closed-${deviceId}`} className="text-[12px] font-normal">
              <span className="text-fg">Fail closed</span>
              <p className="mt-0.5 text-[11px] leading-relaxed text-fg-muted">
                {failClosed
                  ? 'When the tunnel breaks, the device blocks its own traffic instead of falling back to its real address. Recommended, and the default.'
                  : 'Off: a broken tunnel falls back to the device’s real address instead of blocking traffic — only useful while debugging the route by hand.'}
              </p>
            </Label>
          </div>

          {/* Plan 55 §3.1, §3.3, §4.4 — country alone enables the `geo` check; everything else
              narrows it. Matching happens at the narrowest level declared, so filling in only the
              country is never failed by a city or ISP change — the drift is still visible in the
              check's own detail line and in the exit history below. */}
          <div className="mt-3 rounded border bg-bg px-2.5 py-2.5">
            <h4 className="text-[12px] font-medium text-fg">Expected exit</h4>
            <p className="mt-0.5 text-[11px] leading-relaxed text-fg-muted">
              Where this route should exit. Only fields filled in here are checked — declaring just a
              country will not fail on a city change, but a drift is still shown.
            </p>
            <div className="mt-2.5 grid gap-2.5 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor={`expect-country-${deviceId}`} className="text-[12px] font-normal">
                  Country (ISO 2-letter)
                </Label>
                <Input
                  id={`expect-country-${deviceId}`}
                  value={expectCountry}
                  onChange={(e) => setExpectCountry(e.target.value.slice(0, 2))}
                  placeholder="JP"
                  disabled={!canUse}
                  maxLength={2}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`expect-region-${deviceId}`} className="text-[12px] font-normal">
                  Region (optional)
                </Label>
                <Input
                  id={`expect-region-${deviceId}`}
                  value={expectRegion}
                  onChange={(e) => setExpectRegion(e.target.value)}
                  placeholder="Tokyo"
                  disabled={!canUse}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`expect-city-${deviceId}`} className="text-[12px] font-normal">
                  City (optional)
                </Label>
                <Input
                  id={`expect-city-${deviceId}`}
                  value={expectCity}
                  onChange={(e) => setExpectCity(e.target.value)}
                  placeholder="Shibuya"
                  disabled={!canUse}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`expect-isp-${deviceId}`} className="text-[12px] font-normal">
                  ISP (optional)
                </Label>
                <Input
                  id={`expect-isp-${deviceId}`}
                  value={expectIsp}
                  onChange={(e) => setExpectIsp(e.target.value)}
                  placeholder="NTT"
                  disabled={!canUse}
                />
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor={`expect-asn-${deviceId}`} className="text-[12px] font-normal">
                  ASN (optional)
                </Label>
                <Input
                  id={`expect-asn-${deviceId}`}
                  inputMode="numeric"
                  value={expectAsn}
                  onChange={(e) => setExpectAsn(e.target.value)}
                  placeholder="4713"
                  disabled={!canUse}
                />
              </div>
            </div>

            {expectCountry.trim() && (
              <div className="mt-3 space-y-1.5">
                <Label htmlFor={`on-geo-fail-${deviceId}`} className="text-[12px] font-normal">
                  On mismatch
                </Label>
                <Select value={onGeoFail} onValueChange={(v) => setOnGeoFail(v as 'report' | 'hold')} disabled={!canUse}>
                  <SelectTrigger id={`on-geo-fail-${deviceId}`} className="w-full sm:w-56">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="report">Report only</SelectItem>
                    <SelectItem value="hold">Hold the device closed</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-[11px] leading-relaxed text-fg-muted">
                  {onGeoFail === 'hold'
                    ? 'A drifted exit blocks the device’s own traffic on purpose, the same as a failed tunnel — it recovers on its own once the exit is back in range. Only turn this on if presenting the wrong identity is worse than no connectivity at all.'
                    : 'A drifted exit only shows up in health and the checks below — the device keeps routing.'}
                </p>
              </div>
            )}
          </div>

          <div className="mt-4 flex items-center gap-2 border-t pt-3">
            <Button type="submit" size="sm" disabled={!canApply || isPending('apply')}>
              {isPending('apply') ? 'Applying…' : status.config ? 'Update route' : 'Apply route'}
            </Button>
          </div>
        </form>

        <div className="rounded-lg border bg-surface p-3.5">
          <h3 className="rack-label mb-2.5">route status</h3>
          <dl className="space-y-1.5">
            <Row label="engine" value={status.engine} />
            <Row label="enabled" value={status.enabled ? 'yes' : 'no'} />
            <Row label="fail closed" value={status.failClosed ? 'yes' : 'no — may leak on failure'} />
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-[12px] text-fg-subtle">health</dt>
              <dd>
                <HealthBadge health={status.health} />
              </dd>
            </div>
          </dl>

          {status.health === 'unverified' && (
            <p className="mt-2.5 text-[11.5px] leading-relaxed text-fg-muted">
              The route was applied and the device accepted it, but no egress check has confirmed traffic is
              actually leaving through this proxy yet.
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

          {status.config ? (
            <dl className="mt-2.5 space-y-1.5 border-t pt-2.5">
              <Row label="requested upstream" value={`${status.config.host}:${status.config.port}`} />
              <Row label="requested udp mode" value={status.config.udpMode} />
            </dl>
          ) : (
            <p className="mt-2.5 border-t pt-2.5 text-[11.5px] text-fg-subtle">No route saved yet.</p>
          )}

          {status.observed ? (
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
              <span className="readout font-medium text-led-danger">{status.lastError.code}</span>
              <p className="mt-0.5 text-fg-muted">{status.lastError.message}</p>
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
                  <li key={`${o.at}-${i}`} className="flex items-baseline justify-between gap-3 text-[11.5px]">
                    <span className="readout text-fg">{o.address}</span>
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
