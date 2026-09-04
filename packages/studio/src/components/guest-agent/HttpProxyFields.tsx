'use client'

import { useEffect, useRef, useState } from 'react'
import { DeviceNetworkStatusResponseSchema } from '@enkaku/protocol'
import { Button, Input, Label, useAction } from '@enkaku/ui'
import { runOnDevice } from '@/lib/actions'
import { Choice, ChoiceGroup } from '@/components/guest-agent/RouteChoice'
import { HTTP_PROXY_ADVISORY } from '@/components/guest-agent/proxy-copy'
import type { NetworkStatus } from '@/lib/api'

/**
 * Re-exported, not redeclared. The string moved to `./proxy-copy` in step 114.8
 * once `BulkProxyDialog` needed the same sentence about N devices — see that
 * module's own note on why a second copy of this particular sentence is the
 * failure mode rather than a convenience. The export stays here so every
 * existing importer (and acceptance criterion 2's literal-string test) is
 * unaffected by where it now lives.
 */
export { HTTP_PROXY_ADVISORY } from '@/components/guest-agent/proxy-copy'

/** Plan 114 §3.7 — what the farm promises across a reboot or a replug, per rung. Never "your traffic goes through this". */
const PERSISTENCE_NOTE = {
  direct:
    'This setting stays on the phone across reboots and reconnects. The farm checks it whenever the phone comes back and re-applies it if something changed it.',
  farm:
    'This setting stays on the phone across reboots and reconnects, and the tunnel from the phone to this machine is rebuilt every time the phone reconnects or the farm restarts. Between the phone coming back and the tunnel being rebuilt, apps using the proxy will fail to connect.',
} as const

/** Where the proxy the phone is pointed at actually runs — plan 114 §3.2's two HTTP rungs, asked as the one question an operator has to answer anyway. */
type Placement = 'direct' | 'farm'

const PLACEMENT_ENGINE = { direct: 'adb-proxy', farm: 'adb-reverse-proxy' } as const

/**
 * What a paste can turn out to be. A refusal is a first-class result carrying
 * its reason, not a bare `null` — the operator has to be told WHY the string
 * they already have cannot go here, or they will conclude the screen is broken
 * (plan 114 §3.8, risk 2).
 */
export type HttpProxyPaste =
  | { ok: true; host: string; port: number }
  | { ok: false; reason: 'userinfo' }
  | { ok: false; reason: 'socks'; hasAuth: boolean }
  | { ok: false; reason: 'shape' }

/**
 * Parses a pasted proxy address for HTTP mode, in the browser only — the raw
 * string is never sent anywhere, it fills the fields below (the same rule
 * `parseSocks5Url` follows in `VpnRouteFields`).
 *
 * **It refuses userinfo rather than dropping it**, which is the entire reason
 * this function is separate from the SOCKS5 one. `settings put global
 * http_proxy` takes `host:port` and nothing else; Android has nowhere to put a
 * username or password, and the value it does hold is world-readable by every
 * app on the phone (spec §7.9, plan 114 F6). An operator moving between modes
 * pastes the credentialled URL they already have, and quietly stripping the
 * account would produce a route that connects anonymously — against a provider
 * that also allows IP-whitelist auth that does not even fail, it just serves a
 * default-pool exit while the screen reports success. A refusal that names the
 * alternative is the only honest outcome.
 *
 * A schemeless `user:pass@host:1080` is refused on the same ground: the `@` is
 * checked before the host/port split, so the account can never be parsed away
 * as part of a hostname.
 */
export function parseHttpProxyUrl(raw: string): HttpProxyPaste {
  const text = raw.trim()
  if (!text) return { ok: false, reason: 'shape' }

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    let url: URL
    try {
      url = new URL(text)
    } catch {
      return { ok: false, reason: 'shape' }
    }
    const hasAuth = url.username !== '' || url.password !== ''
    const proto = url.protocol.slice(0, -1).toLowerCase()
    // SOCKS first, so `socks5://user:pass@host:1080` — the string an operator
    // with a real SOCKS5 account actually holds — gets the answer that names
    // the mode which CAN carry it, rather than only the one that cannot.
    if (proto === 'socks' || proto === 'socks4' || proto === 'socks5' || proto === 'socks5h') {
      return { ok: false, reason: 'socks', hasAuth }
    }
    if (hasAuth) return { ok: false, reason: 'userinfo' }
    if (proto !== 'http' && proto !== 'https') return { ok: false, reason: 'shape' }
    if (!url.hostname || !url.port) return { ok: false, reason: 'shape' }
    const port = Number(url.port)
    if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, reason: 'shape' }
    return { ok: true, host: url.hostname, port }
  }

  if (text.includes('@')) return { ok: false, reason: 'userinfo' }
  const cut = text.lastIndexOf(':')
  if (cut <= 0) return { ok: false, reason: 'shape' }
  const host = text.slice(0, cut).trim()
  const port = Number(text.slice(cut + 1).trim())
  if (!host || /\s/.test(host)) return { ok: false, reason: 'shape' }
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, reason: 'shape' }
  return { ok: true, host, port }
}

/**
 * The refusal an operator reads. Every one of them names where the thing they
 * pasted DOES work — "no" on its own is unactionable, and the operator with a
 * credentialled account is not doing anything unreasonable.
 */
function refusalMessage(paste: Extract<HttpProxyPaste, { ok: false }>): string {
  if (paste.reason === 'userinfo') {
    return 'That address carries a username and password. Android’s system proxy setting is host:port — there is nowhere to put an account, and every app on the phone can read the value, so the farm will not write one there. To use a proxy that needs an account, run it on this farm’s machine: the phone dials it over the adb connection and the account never reaches the phone.'
  }
  if (paste.reason === 'socks') {
    return paste.hasAuth
      ? 'That is a SOCKS5 address with an account on it. Android’s system proxy setting carries an HTTP proxy only, and has nowhere to put a username or password. VPN mode is what carries a SOCKS5 upstream, and it keeps the account off the phone.'
      : 'That is a SOCKS5 address. Android’s system proxy setting carries an HTTP proxy only. VPN mode is what carries a SOCKS5 upstream.'
  }
  return 'Not an http://host:port address, or a host:port pair with an explicit port.'
}

/**
 * HTTP proxy mode's body (plan 114 §3.10) — the "where is the proxy?"
 * sub-choice, the address fields for whichever rung that picks, and the
 * permanent advisory sentence underneath.
 *
 * **There are no credential fields here and there deliberately never will be.**
 * See `parseHttpProxyUrl` above for why. The absence is stated on screen
 * rather than left to be noticed — an absent field with no explanation reads
 * as a missing feature, and the operator's next move is to paste the account
 * into the host box.
 */
export function HttpProxyFields({
  deviceId,
  canUse,
  status,
  onApplied,
  onChooseVpn,
}: {
  deviceId: string
  /** Same server-authoritative gate as every other mutating control on the page — the server checks the control activity itself regardless. */
  canUse: boolean
  status: NetworkStatus
  onApplied: (next: NetworkStatus) => void
  /** Lets a refused SOCKS5 paste offer the mode that can actually carry it, instead of only saying no. */
  onChooseVpn: () => void
}) {
  const { run, isPending } = useAction()
  const [placement, setPlacement] = useState<Placement>('direct')
  const [host, setHost] = useState('')
  const [port, setPort] = useState('')
  const [hostPort, setHostPort] = useState('')
  const [paste, setPaste] = useState('')
  const [pasteError, setPasteError] = useState<string | null>(null)

  // Seeded from the saved route exactly once, the same rule the VPN form
  // follows: re-seeding on every reload would stomp an in-progress edit the
  // moment an apply response comes back.
  const seeded = useRef(false)
  useEffect(() => {
    if (seeded.current) return
    const config = status.config
    if (config?.engine === 'adb-proxy') {
      seeded.current = true
      setPlacement('direct')
      setHost(config.host)
      setPort(String(config.port))
    } else if (config?.engine === 'adb-reverse-proxy') {
      seeded.current = true
      setPlacement('farm')
      setHostPort(String(config.hostPort))
    }
  }, [status])

  function fillFromPaste() {
    const parsed = parseHttpProxyUrl(paste)
    if (!parsed.ok) {
      setPasteError(refusalMessage(parsed))
      return
    }
    setPasteError(null)
    setHost(parsed.host)
    setPort(String(parsed.port))
    setPaste('')
  }

  const portNum = Number(port)
  const hostPortNum = Number(hostPort)
  const portOk = Number.isInteger(portNum) && portNum >= 1 && portNum <= 65535
  const hostPortOk = Number.isInteger(hostPortNum) && hostPortNum >= 1 && hostPortNum <= 65535
  const canApply = canUse && (placement === 'direct' ? host.trim().length > 0 && portOk : hostPortOk)

  const applyRoute = () =>
    run(
      'apply',
      async () =>
        DeviceNetworkStatusResponseSchema.parse(
          (
            await runOnDevice('set-network', deviceId, {
              op: 'set',
              route:
                placement === 'direct'
                  ? { engine: PLACEMENT_ENGINE.direct, host: host.trim(), port: portNum }
                  : { engine: PLACEMENT_ENGINE.farm, hostPort: hostPortNum },
            })
          ).detail,
        ),
      {
        success: 'Proxy set on the device',
        failure: 'Could not set the proxy',
        onSuccess: onApplied,
      },
    )

  const applied = status.config?.engine === 'adb-proxy' || status.config?.engine === 'adb-reverse-proxy'

  return (
    <form
      /* `@container`, not `sm:` — see `NetworkRouteForm`'s own note. This card
         is rendered both full width (device page) and inside one column of a
         ~400px dialog pane, and a viewport breakpoint cannot tell those apart. */
      className="@container rounded-lg border bg-surface p-3.5"
      onSubmit={(e) => {
        e.preventDefault()
        void applyRoute()
      }}
    >
      <h3 className="rack-label mb-2.5">http proxy</h3>

      <ChoiceGroup label="where is the proxy?" className="border-0 bg-transparent p-0">
        <Choice
          name={`placement-${deviceId}`}
          value="direct"
          checked={placement === 'direct'}
          onSelect={() => setPlacement('direct')}
          disabled={!canUse}
          title="A proxy the phone can reach"
          description="The phone dials the address itself. No username or password — Android’s setting has nowhere to put one, and every app on the phone can read it."
        />
        <Choice
          name={`placement-${deviceId}`}
          value="farm"
          checked={placement === 'farm'}
          onSelect={() => setPlacement('farm')}
          disabled={!canUse}
          title="A proxy on this farm’s machine"
          description="The phone dials its own loopback, carried back here over the adb connection. This is the one way to use a proxy that needs an account: the account stays on this machine and never reaches the phone."
        />
      </ChoiceGroup>

      {placement === 'direct' ? (
        <>
          <div className="mt-3 mb-3 flex flex-wrap items-end gap-2">
            <div className="min-w-0 flex-1 space-y-1.5">
              <Label htmlFor={`http-paste-${deviceId}`} className="text-[12px] font-normal text-fg-muted">
                Paste an http://host:port address to fill the fields below
              </Label>
              <Input
                id={`http-paste-${deviceId}`}
                placeholder="http://proxy.example.com:8080"
                value={paste}
                onChange={(e) => setPaste(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    fillFromPaste()
                  }
                }}
                disabled={!canUse}
              />
            </div>
            <Button type="button" variant="outline" size="sm" onClick={fillFromPaste} disabled={!canUse || !paste.trim()}>
              Fill fields
            </Button>
          </div>
          {pasteError && (
            <div className="mb-3 rounded border border-led-warn/35 bg-led-warn/5 px-2.5 py-2 text-[11.5px] leading-relaxed text-led-warn">
              <p>{pasteError}</p>
              <div className="mt-1.5 flex flex-wrap gap-3">
                <button type="button" className="underline" onClick={() => setPlacement('farm')}>
                  Use a proxy on this farm’s machine
                </button>
                <button type="button" className="underline" onClick={onChooseVpn}>
                  Switch to VPN mode
                </button>
              </div>
            </div>
          )}

          {/* Host beside port only once both fit: port is a rigid 7rem, the gap
              is 0.75rem, and a host field below 13rem shows barely a domain —
              7 + 0.75 + 13 = 20.75rem, rounded to 21rem of container width. */}
          <div className="grid gap-3 @min-[21rem]:grid-cols-[minmax(0,1fr)_7rem]">
            <div className="space-y-1.5">
              <Label htmlFor={`http-host-${deviceId}`} className="text-[12px] font-normal">
                Proxy host
              </Label>
              <Input
                id={`http-host-${deviceId}`}
                value={host}
                onChange={(e) => setHost(e.target.value)}
                placeholder="proxy.example.com"
                disabled={!canUse}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`http-port-${deviceId}`} className="text-[12px] font-normal">
                Proxy port
              </Label>
              <Input
                id={`http-port-${deviceId}`}
                inputMode="numeric"
                value={port}
                onChange={(e) => setPort(e.target.value)}
                placeholder="8080"
                disabled={!canUse}
              />
            </div>
          </div>

          {/* An absent password field with no explanation reads as a missing
              feature, and the operator's next move is to paste the account
              into the host box. Say why, and say where it does go. */}
          <p className="mt-2 text-[11px] leading-relaxed text-fg-subtle">
            There is no username or password here, and there will not be one. Android’s system proxy value is
            host:port with nowhere to put an account, and every app on the phone can read it. A proxy that needs an
            account has to run on this farm’s machine — the choice above.
          </p>
        </>
      ) : (
        <div className="mt-3 space-y-1.5">
          <Label htmlFor={`http-host-port-${deviceId}`} className="text-[12px] font-normal">
            Port on this machine
          </Label>
          <Input
            id={`http-host-port-${deviceId}`}
            inputMode="numeric"
            /* A port needs five characters, not the full width of the card —
               but only narrow it once the card has 18rem to spare. */
            className="@min-[18rem]:w-40"
            value={hostPort}
            onChange={(e) => setHostPort(e.target.value)}
            placeholder="9902"
            disabled={!canUse}
          />
          <p className="text-[11px] leading-relaxed text-fg-subtle">
            Where the proxy already listens on this farm’s own machine. The phone dials a loopback port of its own,
            which the farm allocates and shows in the route status — it is never typed here.
          </p>
        </div>
      )}

      {/* Plan 114 §3.5, §3.1 rule 3 — always on screen, never only after
          something fails: `health` cannot leave `unverified` in this mode, and
          an unexplained `unverified` reads as "still loading". */}
      <p className="mt-3 rounded border border-led-warn/35 bg-led-warn/5 px-2.5 py-2 text-[11.5px] leading-relaxed text-led-warn">
        {HTTP_PROXY_ADVISORY}
      </p>
      <p className="mt-2 text-[11px] leading-relaxed text-fg-subtle">{PERSISTENCE_NOTE[placement]}</p>

      <div className="mt-4 flex items-center gap-2 border-t pt-3">
        <Button type="submit" size="sm" disabled={!canApply || isPending('apply')}>
          {isPending('apply') ? 'Applying…' : applied ? 'Update proxy' : 'Set proxy'}
        </Button>
      </div>
    </form>
  )
}
