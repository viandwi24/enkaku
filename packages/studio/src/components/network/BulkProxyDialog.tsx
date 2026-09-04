'use client'

import { useEffect, useMemo, useState } from 'react'
import { DeviceNetworkStatusResponseSchema, type ActionResult, type DeviceInfo, type GroupInfo } from '@enkaku/protocol'
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Input, Label, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, useAction } from '@enkaku/ui'
import { OutcomeSummary, type OutcomeCounts } from '@/components/bulk/OutcomeSummary'
import { SkippedGroups, deviceNameIn, type NamedOutcome } from '@/components/bulk/SkippedGroups'
import { Choice, ChoiceGroup } from '@/components/guest-agent/RouteChoice'
import { parseHttpProxyUrl } from '@/components/guest-agent/HttpProxyFields'
import { parseSocks5Url } from '@/components/guest-agent/VpnRouteFields'
import { HTTP_MODE_DESCRIPTION, HTTP_PROXY_ADVISORY, VPN_MODE_DESCRIPTION } from '@/components/guest-agent/proxy-copy'
import { TargetPicker } from '@/components/target/TargetPicker'
import { useTargetSelection, type Target } from '@/components/target/useTargetSelection'
import { runAction, awaitOperation } from '@/lib/actions'
import { resolveTargetDeviceIds } from '@/lib/operations'

/**
 * Set one proxy route across a selection (plan 114 §3.9, step 114.8) — the
 * owner asked for it twice, in their own words: *"support manage multiple
 * device set nya"* and *"dengan mudah mau set ke bulk device atau specific
 * device"*.
 *
 * Composed exactly like every other bulk dialog in this repo rather than as a
 * new pattern: a module-scope `TARGET_ALLOW`, `useTargetSelection` +
 * `TargetPicker` (plan 104), `reset()` on open rather than on every render, the
 * dialog stays open and swaps its body form → report, and the footer swaps
 * Cancel/Apply → Close. The resolved count comes from the hook, never from a
 * count this file computes for itself, so the title can never disagree with
 * what Apply will send.
 *
 * **Three things are specific to this action and none of them is decoration.**
 *
 * 1. **The modes are not equals, and that has to survive being said about forty
 *    phones at once.** The two sentences below are the same strings the
 *    single-device selector renders (`@/components/guest-agent/proxy-copy`),
 *    imported rather than retyped — plan 114 risk 1 defends this wording in
 *    three independent places precisely because one quiet softening in one file
 *    would undo the lot, and a bulk screen is the easiest place for that to
 *    happen unnoticed.
 * 2. **Partial failure is the case that actually happens** and is the whole
 *    point of the step. Forty devices, three distinct reasons; the report puts
 *    failures first, groups by the exact reason text, and every count expands
 *    to the named devices behind it (`docs/design.md`: *"a number that cannot be
 *    expanded into a device list is not a real report — it is a rumour"*).
 * 3. **"Applied, unverified" is not a failure.** It is the normal terminal state
 *    of both HTTP rungs, and counting it as a failure would tell an operator
 *    that thirty-seven working phones were broken. It gets its own line under
 *    the summary instead, carrying the same advisory sentence — because the
 *    distinction it draws is the one the whole plan turns on.
 *
 * There is no **Off** mode here, deliberately rather than by omission: turning a
 * route off is `DELETE /api/devices/:id/network`, which restores each phone's
 * own captured original values (§3.6) — a per-device restore, not one shared
 * config, and `POST /network/apply` carries a route to apply rather than an
 * absence. See this step's report; it is a named gap, not a silent one.
 */
const TARGET_ALLOW: Target[] = ['single', 'group', 'devices']

/** The three modes an operator picks between, minus Off — see the note above. */
type ProxyMode = 'http' | 'vpn'

/** Where the proxy is, inside HTTP mode (plan 114 §3.2's two rungs). */
type Placement = 'direct' | 'farm'

/**
 * A code's plain-language half, from the user's side. The message the server
 * sent is appended verbatim after it and is what actually distinguishes two
 * devices blocked for the same coded reason — twenty phones whose agent failed
 * identically collapse into one row, and a twenty-first that failed differently
 * stays visible instead of being absorbed into a count (plan 114 §3.9's own
 * variation on `docs/design.md`'s grouping rule: the key is the code PLUS the
 * message, never the code alone).
 *
 * An unknown code renders as itself rather than as "something went wrong" — a
 * code an operator can search for beats a sentence that says nothing.
 */
const CODE_LABEL: Record<string, string> = {
  E_DEVICE_OFFLINE: 'Offline',
  E_DEVICE_CONFLICT: 'Someone is using it',
  E_AGENT_NOT_READY: 'Guest agent not ready',
  E_UNSUPPORTED: 'Not supported on this phone',
  E_SETTING_NOT_ACCEPTED: 'The phone declined the setting',
  E_REVERSE_FAILED: 'The tunnel to this machine did not come up',
  E_ROUTE_LOCK_HELD: 'Its current route could not be turned off first',
  E_HTTP_PROXY_NO_AUTH: 'A proxy account cannot go on a phone',
}

function reasonText(code: string, message: string): string {
  return `${CODE_LABEL[code] ?? code} — ${message}`
}

export function BulkProxyDialog({
  open,
  onOpenChange,
  devices,
  allDevices,
  groups = [],
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The pre-filled default target — still fully editable through the picker below. */
  devices: DeviceInfo[]
  /** The whole pool `TargetPicker`'s Group/Multiple devices modes choose from. Defaults to `devices` for a caller not yet updated to pass the whole fleet. */
  allDevices?: DeviceInfo[]
  groups?: GroupInfo[]
}) {
  const pool = allDevices ?? devices
  const { run, isPending } = useAction()
  const [mode, setMode] = useState<ProxyMode>('http')
  const [placement, setPlacement] = useState<Placement>('direct')
  const [host, setHost] = useState('')
  const [port, setPort] = useState('')
  const [hostPort, setHostPort] = useState('')
  const [paste, setPaste] = useState('')
  const [pasteError, setPasteError] = useState<string | null>(null)
  const [vpnHost, setVpnHost] = useState('')
  const [vpnPort, setVpnPort] = useState('')
  const [vpnUser, setVpnUser] = useState('')
  const [vpnPass, setVpnPass] = useState('')
  const [udpMode, setUdpMode] = useState<'udp' | 'tcp'>('udp')
  const [results, setResults] = useState<ActionResult[] | null>(null)

  // See `InstallBatchDialog`'s identical comment: `Infinity` for a caller that
  // has not been updated to pass `allDevices`, so an un-updated caller never
  // sees a fleet-wide gate comparing the picked set to itself.
  const targetSelection = useTargetSelection({ usableCount: allDevices ? allDevices.length : Number.POSITIVE_INFINITY, groups })
  const { target, deviceId, deviceIds, groupId, resolvedCount, hasTarget, fleetConfirmed } = targetSelection

  // Plan 124 §4.4, step 124.3 — the two-field form `NamedOutcome` carries, so
  // the number stays apart from the label and `SkippedGroups` can dim it. The
  // report below is this dialog's only device-naming site.
  const deviceName = (id: string) => deviceNameIn(pool, id)

  // Re-default whenever the dialog OPENS (plan 104 §3.2) — never on every
  // render, which would stomp an operator's own edit the moment the device list
  // refreshed underneath them.
  useEffect(() => {
    if (!open) return
    setResults(null)
    setPasteError(null)
    targetSelection.reset({
      devices: pool,
      allow: TARGET_ALLOW,
      initialDeviceId: devices[0]?.id ?? null,
      initialSelectedIds: devices.length > 1 ? devices.map((d) => d.id) : undefined,
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  function fillFromPaste(): void {
    const parsed = parseHttpProxyUrl(paste)
    if (!parsed.ok) {
      setPasteError(
        parsed.reason === 'userinfo'
          ? 'That address carries a username and password. Android’s system proxy setting is host:port — there is nowhere to put an account, and every app on the phone can read it. To use a proxy that needs an account, run it on this farm’s machine, or use VPN mode.'
          : parsed.reason === 'socks'
            ? 'That is a SOCKS5 address. Android’s system proxy setting carries an HTTP proxy only — VPN mode is what carries a SOCKS5 upstream, and it keeps the account off the phone.'
            : 'Not an http://host:port address, or a host:port pair with an explicit port.',
      )
      return
    }
    setPasteError(null)
    setHost(parsed.host)
    setPort(String(parsed.port))
    setPaste('')
  }

  function fillVpnFromPaste(): void {
    const parsed = parseSocks5Url(paste)
    if (!parsed) {
      setPasteError('Not a socks5://host:port address.')
      return
    }
    setPasteError(null)
    setVpnHost(parsed.host)
    setVpnPort(String(parsed.port))
    if (parsed.username !== undefined) setVpnUser(parsed.username)
    if (parsed.password !== undefined) setVpnPass(parsed.password)
    setPaste('')
  }

  const portNum = Number(port)
  const hostPortNum = Number(hostPort)
  const vpnPortNum = Number(vpnPort)
  const isPort = (n: number) => Number.isInteger(n) && n >= 1 && n <= 65535

  const routeReady =
    mode === 'vpn'
      ? vpnHost.trim().length > 0 && isPort(vpnPortNum)
      : placement === 'direct'
        ? host.trim().length > 0 && isPort(portNum)
        : isPort(hostPortNum)

  /** The exact body `POST /api/devices/network/apply` carries — one route for every device in the target. */
  function routeBody(): Record<string, unknown> {
    if (mode === 'vpn') {
      return {
        engine: 'vpn-helper',
        host: vpnHost.trim(),
        port: vpnPortNum,
        udpMode,
        // Blank means "no account", exactly as the single-device form treats
        // it. The core turns a username/password into a stored credential per
        // device (`network_credentials`, never the device) — which is what
        // applying this same route one phone at a time would already do.
        ...(vpnUser.trim() ? { username: vpnUser.trim() } : {}),
        ...(vpnPass ? { password: vpnPass } : {}),
      }
    }
    if (placement === 'farm') return { engine: 'adb-reverse-proxy', hostPort: hostPortNum }
    return { engine: 'adb-proxy', host: host.trim(), port: portNum }
  }

  // The one resolver every other bulk dialog uses (plan 107 §3.6's own helper)
  // — never a second copy of "what does `group` mean", which is exactly how a
  // dialog ends up submitting a set that disagrees with the count it displayed.
  const targetDeviceIds = useMemo(
    () => resolveTargetDeviceIds({ target, deviceId, deviceIds, groupId }, pool),
    [target, deviceId, deviceIds, groupId, pool],
  )

  const canSubmit = hasTarget && fleetConfirmed && routeReady && targetDeviceIds.length > 0

  // Plan 207 §4.2, §4.9 — `POST /api/devices/network/apply` is gone; this is
  // now the actions API's own `set-network` verb, `op: 'set'`
  // (`runAction('set-network', target, { op: 'set', route })`), settled via
  // `awaitOperation`. `ActionResult.status` already carries forbidden/
  // skipped/failed/done directly — no second classification needed.
  const submit = () =>
    run(
      'bulk-proxy',
      async () => {
        const response = await runAction('set-network', { deviceIds: targetDeviceIds }, { op: 'set', route: routeBody() })
        const operation = await awaitOperation(response.operationId)
        return operation.results
      },
      {
        failure: 'Could not apply the proxy route',
        onSuccess: (rows) => setResults(rows),
      },
    )

  // ---- the report ----
  //
  // Failures first, then skips, each grouped by its exact reason text —
  // `SkippedGroups` renders `failed` before `skipped` for exactly this reason,
  // matching the Plugins page's own failed-first convention.
  const report = useMemo(() => {
    if (!results) return null
    const failed: NamedOutcome[] = []
    const skipped: NamedOutcome[] = []
    let ok = 0
    let unverified = 0
    for (const r of results) {
      if (r.status === 'failed' || r.status === 'forbidden') {
        failed.push({ deviceId: r.deviceId, ...deviceName(r.deviceId), reason: reasonText(r.code ?? r.status, r.message ?? '') })
      } else if (r.status === 'skipped' || r.status === 'warned') {
        skipped.push({ deviceId: r.deviceId, ...deviceName(r.deviceId), reason: r.message ?? r.status })
      } else if (r.status === 'done') {
        ok += 1
        // NOT a failure — the normal terminal state of both HTTP rungs. Counted
        // separately so the sentence below can be honest about what was and was
        // not proven, without ever moving one of these devices into the failed
        // column (plan 114 §3.5, §3.9).
        const parsed = DeviceNetworkStatusResponseSchema.safeParse(r.detail)
        if (parsed.success && parsed.data.health !== 'ok') unverified += 1
      }
    }
    const counts: OutcomeCounts = { ok, failed: failed.length, skipped: skipped.length, total: results.length }
    return { counts, failed, skipped, unverified }
  }, [results, pool])

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o)
        if (!o) setResults(null)
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            Set proxy on {resolvedCount} device{resolvedCount === 1 ? '' : 's'}
          </DialogTitle>
          <DialogDescription>
            One route, applied to every device in the selection through each device’s own Network → Proxy setting. Each
            device reports its own outcome — this dialog stays open to show it, named device by named device.
          </DialogDescription>
        </DialogHeader>

        {!report ? (
          <div className="space-y-3">
            {/* Plan 114 §3.1 rule 1 — the difference between the modes is stated
                HERE, at the point of choice, in the same words the single-device
                selector uses. Applying to forty phones does not make it less
                important; it makes it forty times more so. */}
            <ChoiceGroup label="mode">
              <Choice
                name="bulk-proxy-mode"
                value="http"
                checked={mode === 'http'}
                onSelect={() => {
                  setMode('http')
                  setPasteError(null)
                }}
                title="HTTP proxy"
                description={HTTP_MODE_DESCRIPTION}
              />
              <Choice
                name="bulk-proxy-mode"
                value="vpn"
                checked={mode === 'vpn'}
                onSelect={() => {
                  setMode('vpn')
                  setPasteError(null)
                }}
                title="VPN"
                description={VPN_MODE_DESCRIPTION}
              />
            </ChoiceGroup>

            {mode === 'http' ? (
              <>
                <ChoiceGroup label="where is the proxy?" className="border-0 bg-transparent p-0">
                  <Choice
                    name="bulk-proxy-placement"
                    value="direct"
                    checked={placement === 'direct'}
                    onSelect={() => setPlacement('direct')}
                    title="A proxy every selected phone can reach"
                    description="Each phone dials the address itself. No username or password — Android’s setting has nowhere to put one, and every app on the phone can read it."
                  />
                  <Choice
                    name="bulk-proxy-placement"
                    value="farm"
                    checked={placement === 'farm'}
                    onSelect={() => setPlacement('farm')}
                    title="A proxy on this farm’s machine"
                    description="Each phone dials its own loopback, carried back here over its adb connection. The account stays on this machine and never reaches any phone — and each phone gets its own tunnel."
                  />
                </ChoiceGroup>

                {placement === 'direct' ? (
                  <>
                    <div className="flex items-end gap-2">
                      <div className="flex-1 space-y-1.5">
                        <Label htmlFor="bulk-proxy-paste" className="text-[12px] font-normal text-fg-muted">
                          Paste an http://host:port address to fill the fields below
                        </Label>
                        <Input
                          id="bulk-proxy-paste"
                          placeholder="http://proxy.example.com:8080"
                          value={paste}
                          onChange={(e) => setPaste(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault()
                              fillFromPaste()
                            }
                          }}
                        />
                      </div>
                      <Button type="button" variant="outline" size="sm" onClick={fillFromPaste} disabled={!paste.trim()}>
                        Fill fields
                      </Button>
                    </div>
                    <div className="grid gap-3 sm:grid-cols-[1fr_7rem]">
                      <div className="space-y-1.5">
                        <Label htmlFor="bulk-proxy-host" className="text-[12px] font-normal">
                          Proxy host
                        </Label>
                        <Input id="bulk-proxy-host" value={host} onChange={(e) => setHost(e.target.value)} placeholder="proxy.example.com" />
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor="bulk-proxy-port" className="text-[12px] font-normal">
                          Proxy port
                        </Label>
                        <Input id="bulk-proxy-port" inputMode="numeric" value={port} onChange={(e) => setPort(e.target.value)} placeholder="8080" />
                      </div>
                    </div>
                    <p className="text-[11px] leading-relaxed text-fg-subtle">
                      There is no username or password here, and there will not be one. Android’s system proxy value is
                      host:port with nowhere to put an account, and every app on the phone can read it — so every
                      selected phone would carry it in the clear.
                    </p>
                  </>
                ) : (
                  <div className="space-y-1.5">
                    <Label htmlFor="bulk-proxy-host-port" className="text-[12px] font-normal">
                      Port on this machine
                    </Label>
                    <Input
                      id="bulk-proxy-host-port"
                      inputMode="numeric"
                      className="sm:w-40"
                      value={hostPort}
                      onChange={(e) => setHostPort(e.target.value)}
                      placeholder="9902"
                    />
                    <p className="text-[11px] leading-relaxed text-fg-subtle">
                      Where the proxy already listens on this farm’s own machine. Each phone dials a loopback port of
                      its own, allocated per device — it is never typed here.
                    </p>
                  </div>
                )}

                {/* Plan 114 §3.5, §3.1 rule 3 — always on screen, never only
                    after something fails. */}
                <p className="rounded border border-led-warn/35 bg-led-warn/5 px-2.5 py-2 text-[11.5px] leading-relaxed text-led-warn">
                  {HTTP_PROXY_ADVISORY}
                </p>
              </>
            ) : (
              <>
                <div className="flex items-end gap-2">
                  <div className="flex-1 space-y-1.5">
                    <Label htmlFor="bulk-vpn-paste" className="text-[12px] font-normal text-fg-muted">
                      Paste a socks5://host:port address (an account on it is kept, and stored on this machine)
                    </Label>
                    <Input
                      id="bulk-vpn-paste"
                      placeholder="socks5://user:pass@proxy.example.com:1080"
                      value={paste}
                      onChange={(e) => setPaste(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault()
                          fillVpnFromPaste()
                        }
                      }}
                    />
                  </div>
                  <Button type="button" variant="outline" size="sm" onClick={fillVpnFromPaste} disabled={!paste.trim()}>
                    Fill fields
                  </Button>
                </div>
                <div className="grid gap-3 sm:grid-cols-[1fr_7rem_7rem]">
                  <div className="space-y-1.5">
                    <Label htmlFor="bulk-vpn-host" className="text-[12px] font-normal">
                      SOCKS5 host
                    </Label>
                    <Input id="bulk-vpn-host" value={vpnHost} onChange={(e) => setVpnHost(e.target.value)} placeholder="proxy.example.com" />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="bulk-vpn-port" className="text-[12px] font-normal">
                      Port
                    </Label>
                    <Input id="bulk-vpn-port" inputMode="numeric" value={vpnPort} onChange={(e) => setVpnPort(e.target.value)} placeholder="1080" />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-[12px] font-normal">UDP</Label>
                    <Select value={udpMode} onValueChange={(v) => setUdpMode(v as 'udp' | 'tcp')}>
                      <SelectTrigger className="h-8 w-full text-[12.5px]">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="udp">UDP</SelectItem>
                        <SelectItem value="tcp">TCP only</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor="bulk-vpn-user" className="text-[12px] font-normal">
                      Username (optional)
                    </Label>
                    <Input id="bulk-vpn-user" value={vpnUser} onChange={(e) => setVpnUser(e.target.value)} autoComplete="off" />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="bulk-vpn-pass" className="text-[12px] font-normal">
                      Password (optional)
                    </Label>
                    <Input id="bulk-vpn-pass" type="password" value={vpnPass} onChange={(e) => setVpnPass(e.target.value)} autoComplete="off" />
                  </div>
                </div>
                {/* Plan 114 §3.4 rule 4, §3.9 — the bulk half of "never a silent
                    downgrade". A phone whose guest agent is not ready is named
                    in the report and left alone; it never quietly receives the
                    advisory rung instead, which would read as "proxy on" on a
                    screen while an app walked straight past it. */}
                <p className="rounded border border-led-warn/35 bg-led-warn/5 px-2.5 py-2 text-[11.5px] leading-relaxed text-led-warn">
                  VPN mode needs the Enkaku guest agent on each phone. Any selected phone whose agent is missing, still
                  installing, outdated or failed is <span className="font-medium">skipped and named below</span> — it is
                  never given an HTTP proxy instead. Install the agent on those phones, then run this again.
                </p>
              </>
            )}

            {pasteError && (
              <p className="rounded border border-led-warn/35 bg-led-warn/5 px-2.5 py-2 text-[11.5px] leading-relaxed text-led-warn">
                {pasteError}
              </p>
            )}

            <TargetPicker selection={targetSelection} devices={pool} groups={groups} allow={TARGET_ALLOW} />
          </div>
        ) : (
          <div className="space-y-3">
            <OutcomeSummary counts={report.counts} label="Set proxy progress" />
            {report.unverified > 0 && (
              <p className="rounded border border-led-warn/35 bg-led-warn/5 px-2.5 py-2 text-[11.5px] leading-relaxed text-led-warn">
                {report.unverified} of the {report.counts.ok} that applied {report.unverified === 1 ? 'is' : 'are'}{' '}
                <span className="font-medium">applied, not confirmed</span> — which is not a failure. {HTTP_PROXY_ADVISORY}
              </p>
            )}
            <SkippedGroups failed={report.failed} skipped={report.skipped} />
            {report.failed.length === 0 && report.skipped.length === 0 && (
              <p className="text-[11.5px] text-fg-subtle">Every device in the selection took the route.</p>
            )}
          </div>
        )}

        <DialogFooter>
          {!report ? (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button onClick={() => void submit()} disabled={!canSubmit || isPending('bulk-proxy')}>
                {isPending('bulk-proxy') ? 'Applying…' : `Apply to ${resolvedCount} device${resolvedCount === 1 ? '' : 's'}`}
              </Button>
            </>
          ) : (
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Close
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
