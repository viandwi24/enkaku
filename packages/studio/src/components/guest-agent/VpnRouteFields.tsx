'use client'

import { useEffect, useRef, useState } from 'react'
import { DeviceNetworkCredentialRevealResponseSchema, DeviceNetworkStatusResponseSchema } from '@enkaku/protocol'
import {
  Button,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  api,
  useAction,
} from '@enkaku/ui'
import {
  VpnAgentPrecondition,
  agentBlocksVpn,
  useGuestAgentReadiness,
  vpnBlockedReason,
} from '@/components/guest-agent/VpnAgentPrecondition'
import type { NetworkStatus, NetworkUdpMode } from '@/lib/api'
import { isAdmin, useAuth } from '@/lib/auth'

/**
 * A `socks5://user:pass@host:port` URL, parsed in the browser only — the raw
 * URL is never sent anywhere, it just fills the fields below (plan 44 §4.6:
 * "Accept a SOCKS5 URL paste as a convenience... Parse it in the browser; do
 * not send the raw URL."). Returns null for anything that is not a
 * `socks5:` URL with an explicit host and port.
 *
 * Note the deliberate asymmetry with `parseHttpProxyUrl` in `HttpProxyFields`:
 * this one KEEPS the userinfo, because this is the rung that can carry an
 * account — the credential is encrypted into `network_credentials` and never
 * written to the device. The HTTP one refuses it, because Android's system
 * proxy value has nowhere to put an account and every app on the phone can
 * read it (plan 114 §3.8).
 */
export function parseSocks5Url(
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

/**
 * One revealed field — its value in a monospaced box with a copy button, and
 * nothing else. Small on purpose: the whole point of a reveal is that the
 * operator can get the value OUT (into a colleague's message, into the
 * upstream's own dashboard to rotate it), and a value you can read but not copy
 * is a value you retype wrong.
 *
 * `select-all` rather than a text input: this is not a field being edited, and
 * an `<input>` here would be offered to the browser's password manager, which
 * is the one place a revealed secret must not end up.
 */
function RevealedValue({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="flex items-baseline gap-2">
      <span className="w-16 shrink-0 text-[11px] text-fg-subtle">{label}</span>
      <code className="min-w-0 flex-1 break-all select-all font-mono text-[11.5px] text-fg">{value}</code>
      <button
        type="button"
        className="shrink-0 text-[11px] underline text-fg-muted hover:text-fg"
        onClick={() => {
          void navigator.clipboard?.writeText(value).then(
            () => {
              setCopied(true)
              window.setTimeout(() => setCopied(false), 1500)
            },
            () => {
              // A clipboard the browser refused (an insecure origin, a denied permission) is not
              // worth a toast — the value is on screen and selectable, which is the fallback.
            },
          )
        }}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  )
}

/**
 * VPN mode's body (plan 114 §3.10) — the SOCKS5 route form, moved out of
 * `NetworkRouteForm` unchanged rather than rewritten. Every field, default and
 * caveat here is plan 44/52/54/55's and is deliberately untouched by plan 114;
 * what changed is only that it is now one of three bodies under a mode
 * selector instead of the whole screen.
 *
 * **Step 114.7 landed the agent precondition here** (plan 114 §3.4).
 * `NetworkPanel` no longer gates the whole panel on the guest agent being
 * `ready` (F12), so an agent-less phone now has a working proxy screen; the
 * gate lives inside this one body, as `VpnAgentPrecondition` above the fields.
 * Nothing outside this component knows the agent's state, which is the point of
 * the split: the mode selector and the two HTTP rungs never had a reason to
 * care, and now structurally cannot.
 *
 * The precondition **blocks Apply and nothing else**. The fields stay live so
 * an operator can fill the route in while the agent installs, and the mode
 * stays selected throughout — but a selection that cannot be applied saves
 * nothing, and `unsavedSelection` is what makes that visible instead of leaving
 * a chosen radio reading as a setting that took effect.
 */
export function VpnRouteFields({
  deviceId,
  canUse,
  status,
  onApplied,
  unsavedSelection = false,
  onCancelSelection,
  onChooseHttp,
}: {
  deviceId: string
  /** Same server-authoritative gate as every other mutating control on the page — the server checks the control activity itself regardless. */
  canUse: boolean
  status: NetworkStatus
  onApplied: (next: NetworkStatus) => void
  /** VPN is the mode being looked at, but not the one applied — plan 114 §3.4 rule 4's "not saved, nothing applied", made visible. */
  unsavedSelection?: boolean
  /** Puts the mode selector back on whatever is actually applied. */
  onCancelSelection?: () => void
  /** The explicit second choice when the agent cannot serve this mode. Never taken automatically — see `VpnAgentPrecondition`. */
  onChooseHttp?: () => void
}) {
  // Plan 114 §3.4 — read from `devices.preparation['guest-agent']`, the
  // authoritative record since plan 106 step 106.5.
  const agent = useGuestAgentReadiness(deviceId)
  const agentBlocks = agentBlocksVpn(agent)
  const blockedReason = vpnBlockedReason(agent)
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
  // Plan 54 §4.2, §5.6 — defaults true (the safe reading) until the server's own value is seeded
  // in, matching `resolveFailClosed()`'s own default so the switch never flashes "off" for an
  // instant on a route that will read `true` a moment later.
  const [failClosed, setFailClosed] = useState(true)
  // Asking for an anonymous upstream has to be explicit: blank credential fields mean "keep the
  // stored one", because the API never returns a username for them to be seeded from.
  const [clearCredential, setClearCredential] = useState(false)
  const [pasteUrl, setPasteUrl] = useState('')
  const [pasteError, setPasteError] = useState<string | null>(null)

  /**
   * The revealed credential, held in this component's state and nowhere else —
   * never in `localStorage`, never in a ref that outlives the panel, never
   * merged back into `status`. Null is the ONLY state this starts in and the
   * state it returns to on Hide, which is what keeps the value out of the DOM
   * until somebody asks for it: the block below is not rendered-and-hidden, it
   * does not exist.
   */
  const [revealed, setRevealed] = useState<{ credentialRef: string; username: string | null; password: string; revealedAt: number } | null>(null)
  const { user } = useAuth()
  // Convenience only — the core re-checks the role itself and refuses with 403
  // regardless of what this says (spec §10.1). It is here so an operator learns
  // the precondition from the disabled button rather than from a red toast.
  const canReveal = isAdmin(user)

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

  const config = status.config?.engine === 'vpn-helper' ? status.config : null

  useEffect(() => {
    if (config && !seeded.current) {
      seeded.current = true
      setHost(config.host)
      setPort(String(config.port))
      setUdpMode(config.udpMode)
      setFailClosed(status.failClosed)
      const expect = config.expect
      setExpectCountry(expect?.country ?? '')
      setExpectRegion(expect?.region ?? '')
      setExpectCity(expect?.city ?? '')
      setExpectAsn(expect?.asn !== undefined ? String(expect.asn) : '')
      setExpectIsp(expect?.isp ?? '')
      setOnGeoFail(config.onGeoFail)
    }
  }, [config, status.failClosed])

  // A route repointed at a different stored credential (by this operator, by a plugin, by the
  // proxy manager) must not leave the previous one's plaintext on screen labelled as this route's.
  useEffect(() => {
    setRevealed((prev) => (prev && prev.credentialRef !== config?.credentialRef ? null : prev))
  }, [config?.credentialRef])

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
    canUse &&
    // Plan 114 §3.4 — never `true` on an agent state we could not read
    // (`agentBlocksVpn`'s own note): a failed read must not refuse a phone
    // whose agent is fine.
    !agentBlocks &&
    host.trim().length > 0 &&
    Number.isInteger(portNum) &&
    portNum >= 1 &&
    portNum <= 65535

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
            // Plan 114 §4.1 — the discriminator. Optional on the wire (the
            // schema defaults it) so a core that predates the union still
            // accepts this body, but sent explicitly because a post-114 core
            // parses a PUT body through the bare union, where an untagged
            // request is a client bug rather than a value to guess at.
            engine: 'vpn-helper',
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
          onApplied(s)
          // Already sent; nothing left for the field to do, and it should
          // not linger in the DOM longer than it has to.
          setPassword('')
          // A save may have replaced the very credential that was on screen. Keeping the old
          // plaintext visible under a route that no longer uses it is worse than showing nothing:
          // it reads as the current password. Reveal again to see what is actually stored now.
          setRevealed(null)
        },
      },
    )

  /**
   * The deliberate act. One `POST`, one response, one audit row — never fired
   * by the panel's own polling, by a render, or by an effect: only by the click
   * that runs this.
   */
  const revealCredential = () =>
    run(
      'reveal',
      () =>
        api(`/api/devices/${deviceId}/network/credential/reveal`, DeviceNetworkCredentialRevealResponseSchema, { method: 'POST' }),
      {
        failure: 'Could not show the stored credential',
        onSuccess: setRevealed,
      },
    )

  return (
    <div className="space-y-4">
      {/* Plan 114 §3.4 — above the fields, never instead of them: a phone that
          cannot run the agent still shows what VPN mode would ask for, which is
          how an operator can tell the difference between "not available here"
          and "this farm cannot do this at all". */}
      <VpnAgentPrecondition
        deviceId={deviceId}
        canUse={canUse}
        agent={agent}
        unsavedSelection={unsavedSelection}
        {...(onCancelSelection ? { onCancelSelection } : {})}
        {...(onChooseHttp ? { onChooseHttp } : {})}
      />

      <form
        /* `@container`, not `sm:` — see `NetworkRouteForm`'s own note: this card
           renders full width on the device page and inside one column of a
           ~400px dialog pane, and a viewport breakpoint describes neither. */
        className="@container rounded-lg border bg-surface p-3.5"
        onSubmit={(e) => {
          e.preventDefault()
          void applyRoute()
        }}
      >
        <h3 className="rack-label mb-2.5">socks5 upstream</h3>

        <div className="mb-3 flex flex-wrap items-end gap-2">
          <div className="min-w-0 flex-1 space-y-1.5">
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

        {/* Same arithmetic as `HttpProxyFields`: 7rem port + 0.75rem gap + a
            13rem minimum for the host = 21rem of container width. */}
        <div className="grid gap-3 @min-[21rem]:grid-cols-[minmax(0,1fr)_7rem]">
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

        {/* Two text fields side by side need ~11.5rem each to still read as
            fields rather than boxes: 2 × 11.5rem + 0.75rem gap ≈ 24rem. */}
        <div className="mt-3 grid gap-3 @min-[24rem]:grid-cols-2">
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
            {/* This line used to read "Never shown back — type it again to change the route." It
                stopped being true the moment the reveal below existed, and a sentence that
                contradicts the button under it is worse than no sentence. What is still true is
                that the field itself never pre-fills: leaving it blank keeps whatever is stored. */}
            <p className="text-[11px] text-fg-subtle">
              {config?.credentialRef
                ? 'Leave blank to keep the stored password. It is never filled in here — use Show stored credential below to read it back.'
                : 'Type one to give this route an account. It is never filled back in here after a save.'}
            </p>
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
          ) : config?.credentialRef ? (
            <p className="text-fg-subtle">
              Authenticating with stored credential <span className="font-mono text-fg-muted">{config.credentialRef}</span>
              {/* The username is not a secret — it is the session string that says WHICH upstream
                  identity this phone is on (`package-…-sessionid-…` on a rotating residential
                  pool). Showing only the opaque ref made every route look alike. */}
              {config.credentialUsername ? (
                <>
                  {' '}
                  as <span className="font-mono text-fg-muted">{config.credentialUsername}</span>
                </>
              ) : null}
              . Leave the fields above blank to keep it, or type a new username and password to replace it.{' '}
              <button type="button" className="underline" onClick={() => setClearCredential(true)} disabled={!canUse}>
                Use no authentication
              </button>
            </p>
          ) : (
            <p className="text-fg-subtle">This route has no stored credential — it connects to the upstream anonymously.</p>
          )}
        </div>

        {/*
          The reveal (see `POST /:id/network/credential/reveal` in
          `packages/core/src/network/route-service.ts`). Three deliberate properties, all of them
          visible from this block alone:

          1. It is an ACT, not a field. Nothing here fetches on render or on poll — the panel's
             `GET /:id/network` never carries a password — and `revealed` starts null, so the
             plaintext is not in the DOM, hidden or otherwise, until the button is pressed.
          2. It says, before the click, that the click is recorded. People behave differently when
             they know, which is the entire reason the audit row is worth having.
          3. There is a way back. Hide drops the value from state, which unmounts it.
        */}
        {config?.credentialRef && (
          <div className="mt-2 rounded border bg-bg px-2.5 py-2">
            {revealed ? (
              <div className="space-y-1.5">
                <RevealedValue label="Username" value={revealed.username ?? '(none)'} />
                <RevealedValue label="Password" value={revealed.password} />
                <div className="flex flex-wrap items-center justify-between gap-2 pt-0.5">
                  <span className="text-[11px] text-fg-subtle">
                    Shown to you at {new Date(revealed.revealedAt * 1000).toLocaleTimeString()} and recorded in the audit log.
                  </span>
                  <button type="button" className="text-[11px] underline text-fg-muted hover:text-fg" onClick={() => setRevealed(null)}>
                    Hide
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={!canReveal || isPending('reveal')}
                  title={canReveal ? undefined : 'Only an admin can read a stored upstream password back.'}
                  onClick={() => void revealCredential()}
                >
                  {isPending('reveal') ? 'Showing…' : 'Show stored credential'}
                </Button>
                <span className="text-[11px] leading-relaxed text-fg-muted">
                  {canReveal
                    ? 'Shows the username and password this route authenticates with. The farm records who showed it, for which device, and when.'
                    : 'Only an admin can read a stored upstream password back — setting a route is operator work, taking its account out of the farm is not. Ask an admin; the reveal is recorded under their name.'}
                </span>
              </div>
            )}
          </div>
        )}

        <div className="mt-3 space-y-1.5">
          <Label htmlFor={`udp-${deviceId}`} className="text-[12px] font-normal">
            UDP mode
          </Label>
          <Select value={udpMode} onValueChange={(v) => setUdpMode(v as NetworkUdpMode)} disabled={!canUse}>
            <SelectTrigger id={`udp-${deviceId}`} className="w-full @min-[20rem]:w-48">
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
        {/* Its own `@container`: this box sits inside the form's own padding, so
            measuring the form would over-report the width these five fields
            actually get by 1.25rem on each side. A nested container measures the
            box itself, which is what the variants below are about. */}
        <div className="@container mt-3 rounded border bg-bg px-2.5 py-2.5">
          <h4 className="text-[12px] font-medium text-fg">Expected exit</h4>
          <p className="mt-0.5 text-[11px] leading-relaxed text-fg-muted">
            Where this route should exit. Only fields filled in here are checked — declaring just a
            country will not fail on a city change, but a drift is still shown.
          </p>
          <div className="mt-2.5 grid gap-2.5 @min-[22rem]:grid-cols-2">
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
            <div className="space-y-1.5 @min-[22rem]:col-span-2">
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
                <SelectTrigger id={`on-geo-fail-${deviceId}`} className="w-full @min-[22rem]:w-56">
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

        {/* A control that cannot be used is genuinely disabled and says why
            (`docs/design.md` quality floor) — never hidden, and never left to
            fail against the server so the operator learns the precondition
            from a red toast. The banner above carries the fix; this is the
            one line at the point of the click. */}
        <div className="mt-4 flex flex-wrap items-center gap-2 border-t pt-3">
          <Button
            type="submit"
            size="sm"
            disabled={!canApply || isPending('apply')}
            title={agentBlocks && blockedReason ? blockedReason : undefined}
          >
            {isPending('apply') ? 'Applying…' : config ? 'Update route' : 'Apply route'}
          </Button>
          {agentBlocks && blockedReason && <span className="text-[11.5px] text-fg-muted">{blockedReason}</span>}
        </div>
      </form>
    </div>
  )
}
