'use client'

import { useEffect, useRef, useState } from 'react'
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
  type NetworkHealth,
  type NetworkStatus,
  type NetworkUdpMode,
} from '@/lib/api'
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
  if (status.observed?.up === false) {
    return {
      checked: true,
      tone: 'danger',
      title: 'Route on — not carrying traffic',
      note: 'The device reports this route is not passing traffic. It may be left with no usable internet — check the upstream, or turn the route off.',
    }
  }
  return {
    checked: true,
    tone: 'warn',
    title: 'Route on — not yet confirmed',
    note: 'Switched on, but the device has not reported an observation yet.',
  }
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
  const [pasteUrl, setPasteUrl] = useState('')
  const [pasteError, setPasteError] = useState<string | null>(null)

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
      setUsername(status.config.username ?? '')
      setUdpMode(status.config.udpMode)
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

  const applyRoute = () =>
    run(
      'apply',
      () =>
        api<NetworkStatus>(`/api/devices/${deviceId}/network`, {
          method: 'PUT',
          json: {
            host: host.trim(),
            port: portNum,
            username: username.trim() ? username.trim() : undefined,
            password: password ? password : undefined,
            udpMode,
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
    run('remove', () => api(`/api/devices/${deviceId}/network`, { method: 'DELETE' }), {
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

  if (error) return <ErrorState message={error} onRetry={load} />
  if (status === null) return <LoadingRows rows={2} />

  const toggle = describeToggle(status)
  const toggling = isPending('enable') || isPending('disable')

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
              <Row label="up (device)" value={status.observed.up ? 'yes' : 'no'} />
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
        </div>
      </div>
    </div>
  )
}
