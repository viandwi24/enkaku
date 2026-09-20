'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AdbRawDevice, AdbRawForward } from '@enkaku/protocol'
import {
  ArrowsClockwiseIcon,
  Button,
  CopyIcon,
  Input,
  PlugsIcon,
  StatusDot,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TerminalIcon,
  TrashIcon,
  cn,
  useAction,
} from '@enkaku/ui'
import { PageHeader } from '@/components/layout/PageHeader'
import {
  adbAddForward,
  adbConnect,
  adbDisconnect,
  adbKillForward,
  adbProbe,
  adbReconnectOffline,
  adbRowLabel,
  adbShell,
  adbStateDot,
  adbTcpip,
  describeAdbState,
  listAdb,
} from '@/components/adb/adb-api'

/** How often the list re-reads itself while the tab is open. adb's own list is cheap; a session is not. */
const POLL_MS = 4000

/** adb's default wireless port, offered wherever a port is asked for. */
const DEFAULT_ADB_PORT = 5555

type Shell = { serial: string; command: string; output: string | null; code: number | null; durationMs: number | null }

/**
 * `/adb` — adb's own device list, and the host services beside it.
 *
 * ## Why this is not the Devices page
 *
 * The Devices page is the FARM: rows an operator admitted, each with a name,
 * a number, a group and a history. This page is what the adb server on this
 * machine currently holds, which is a different list, and the difference is
 * the point. A phone plugged in and still `unauthorized` has no farm row at
 * all — the Devices page cannot show it, and cannot explain why it is
 * missing. A device whose adb-tcp link dropped is `offline` here and still a
 * row there. So every row carries what the farm knows about that serial
 * (`farm.kind`), rather than leaving the operator to infer it.
 *
 * ## What it deliberately does not do
 *
 * It does not restart the adb server. `adb kill-server` is forbidden outside
 * the Toolchain Manager's own swap flow (CLAUDE.md, spec §10.4), because
 * port 5037 is shared with Android Studio and every other adb consumer on
 * the machine, and the one audited restart drains sessions and jobs first.
 * **Reconnect offline** here is `host:reconnect-offline`: it re-opens stuck
 * transports without disturbing that port's owner, which is what an operator
 * reaching for "restart adb" almost always actually wants. The real restart
 * stays on Settings → Toolchain, with its drain.
 *
 * It also does not admit, forget or rename anything. Every act here is on an
 * adb TRANSPORT; a device row's lifecycle stays on the Devices page, where
 * it has the confirmations and the session handling it needs.
 */
export default function AdbPage() {
  const [devices, setDevices] = useState<AdbRawDevice[] | null>(null)
  const [forwards, setForwards] = useState<AdbRawForward[]>([])
  const [serverVersion, setServerVersion] = useState<string | null>(null)
  const [shellAllowed, setShellAllowed] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [host, setHost] = useState('')
  const [port, setPort] = useState(String(DEFAULT_ADB_PORT))
  const [probe, setProbe] = useState<string | null>(null)

  const [shell, setShell] = useState<Shell | null>(null)
  const [forwardDraft, setForwardDraft] = useState<{ serial: string; local: string; remote: string } | null>(null)

  const { run, isPending } = useAction()
  /** Set while a poll is in flight, so the ticker never stacks requests on a slow adb server. */
  const polling = useRef(false)

  const reload = useCallback(async () => {
    if (polling.current) return
    polling.current = true
    try {
      const next = await listAdb()
      setDevices(next.devices)
      setForwards(next.forwards)
      setServerVersion(next.serverVersion)
      setShellAllowed(next.shellAllowed)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      polling.current = false
    }
  }, [])

  useEffect(() => {
    void reload()
    const t = setInterval(() => void reload(), POLL_MS)
    return () => clearInterval(t)
  }, [reload])

  const parsedPort = Number(port)
  const portOk = Number.isInteger(parsedPort) && parsedPort > 0 && parsedPort <= 65535
  const canDial = host.trim().length > 0 && portOk

  const connect = () =>
    run('connect', () => adbConnect(host.trim(), parsedPort), {
      failure: 'Could not reach adb',
      onSuccess: (r) => {
        setProbe(r.message)
        if (r.ok) setHost('')
        void reload()
      },
    })

  const checkPort = () =>
    run('probe', () => adbProbe(host.trim(), parsedPort), {
      failure: 'Could not run the probe',
      onSuccess: (r) =>
        setProbe(r.open ? `${host.trim()}:${parsedPort} is open (${r.rttMs}ms) — adb should be able to connect` : `${host.trim()}:${parsedPort} — ${r.error}`),
    })

  const disconnectAll = () =>
    run('disconnect-all', () => adbDisconnect(), { success: 'Every network transport dropped', failure: 'Could not disconnect', onSuccess: () => void reload() })

  const reconnectOffline = () =>
    run('reconnect', () => adbReconnectOffline(), {
      success: 'adb was asked to re-open its offline transports',
      failure: 'Could not ask adb to reconnect',
      onSuccess: () => void reload(),
    })

  const disconnectOne = (d: AdbRawDevice) =>
    run(`dc-${d.serial}`, () => adbDisconnect(d.serial), {
      success: `${adbRowLabel(d)} disconnected`,
      failure: 'Could not disconnect it',
      onSuccess: () => void reload(),
    })

  const switchToTcpip = (d: AdbRawDevice) =>
    run(`tcpip-${d.serial}`, () => adbTcpip(d.serial, DEFAULT_ADB_PORT), {
      failure: 'Could not switch it to TCP',
      onSuccess: (r) => {
        // The address adbd is now reachable at, pre-filled into the dial box
        // rather than announced in a toast that scrolls away — connecting is
        // always the next thing after a cutover, and retyping an IP read off
        // a screen is how a digit gets lost.
        if (r.suggestedEndpoint) {
          const [h, p] = r.suggestedEndpoint.split(':')
          setHost(h ?? '')
          setPort(p ?? String(DEFAULT_ADB_PORT))
        }
        setProbe(r.suggestedEndpoint ? `${r.message} — dial ${r.suggestedEndpoint} to attach it` : r.message)
        void reload()
      },
    })

  const runShell = () => {
    if (!shell || shell.command.trim().length === 0) return
    const { serial, command } = shell
    return run(`shell-${serial}`, () => adbShell(serial, command), {
      failure: 'The command did not run',
      onSuccess: (r) =>
        setShell((s) =>
          s === null || s.serial !== serial
            ? s
            : { ...s, output: r.stdout + (r.stderr ? (r.stdout ? '\n' : '') + r.stderr : ''), code: r.code, durationMs: r.durationMs },
        ),
    })
  }

  const addForward = () => {
    if (!forwardDraft) return
    const { serial, local, remote } = forwardDraft
    return run('add-forward', () => adbAddForward(serial, local.trim(), remote.trim()), {
      success: 'Forward added',
      failure: 'adb refused the forward',
      onSuccess: () => {
        setForwardDraft(null)
        void reload()
      },
    })
  }

  const removeForward = (f: AdbRawForward) =>
    run(`kf-${f.serial}-${f.local}`, () => adbKillForward(f.serial, f.local), {
      success: 'Forward removed',
      failure: 'Could not remove the forward',
      onSuccess: () => void reload(),
    })

  const counts = useMemo(() => {
    const list = devices ?? []
    return {
      total: list.length,
      ready: list.filter((d) => d.state === 'device').length,
      stuck: list.filter((d) => d.state !== 'device').length,
      unknown: list.filter((d) => d.farm.kind === 'unknown').length,
    }
  }, [devices])

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader
        title="ADB"
        description="What the adb server on this machine actually holds — including phones the farm has never admitted."
        actions={
          <Button variant="outline" size="sm" onClick={() => void reload()}>
            <ArrowsClockwiseIcon className="size-4" aria-hidden />
            Refresh
          </Button>
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="space-y-4 px-5 py-4">
          <p className="text-[12px] text-faint">
            {/* Before the first reply there is no answer yet, which is not
                the same as a server that did not answer — saying "not
                answering" while the request is still in flight is the kind
                of false alarm that sends an operator to restart adb. */}
            {devices === null && error === null
              ? 'Reading adb…'
              : serverVersion === null
                ? 'adb server: not answering'
                : `adb server protocol ${serverVersion}`}
            {devices !== null && ` · ${counts.total} transport${counts.total === 1 ? '' : 's'}`}
            {counts.stuck > 0 && ` · ${counts.stuck} not ready`}
            {counts.unknown > 0 && ` · ${counts.unknown} the farm has never seen`}
          </p>

          {error !== null && <p className="rounded-md border bg-panel-2/40 px-3 py-2 text-[12.5px] text-danger">{error}</p>}

          {/* Dial a network device. Probe answers "is the port open" without
              adb's own minute-long worst case on an unroutable address. */}
          <section className="rounded-lg border bg-panel p-3.5">
            <h2 className="mb-2 text-[13px] font-semibold text-text">Connect over the network</h2>
            <div className="flex flex-wrap items-center gap-2">
              <Input
                value={host}
                onChange={(e) => setHost(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && canDial) void connect()
                }}
                placeholder="192.168.1.42"
                aria-label="Host or IP address"
                className="h-8 w-56"
              />
              <span className="text-[13px] text-faint">:</span>
              <Input
                value={port}
                onChange={(e) => setPort(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && canDial) void connect()
                }}
                aria-label="Port"
                className={cn('h-8 w-24', !portOk && port !== '' && 'border-danger')}
              />
              <Button size="sm" disabled={!canDial || isPending('connect')} onClick={() => void connect()}>
                {isPending('connect') ? 'Connecting…' : 'Connect'}
              </Button>
              <Button variant="outline" size="sm" disabled={!canDial || isPending('probe')} onClick={() => void checkPort()}>
                {isPending('probe') ? 'Checking…' : 'Check port'}
              </Button>
              <div className="ml-auto flex items-center gap-2">
                <Button variant="outline" size="sm" disabled={isPending('reconnect')} onClick={() => void reconnectOffline()}>
                  Reconnect offline
                </Button>
                <Button variant="outline" size="sm" disabled={isPending('disconnect-all')} onClick={() => void disconnectAll()}>
                  Disconnect all
                </Button>
              </div>
            </div>
            {probe !== null && <p className="mt-2 text-[12px] text-dim">{probe}</p>}
            <p className="mt-2 text-[11.5px] text-faint">
              <b className="font-medium text-dim">Reconnect offline</b> re-opens transports adb has stuck at <span className="readout">offline</span>. It is not a
              restart — the adb server keeps running, and nothing else using port 5037 is disturbed. The full restart, with its drain, is on Settings →
              Toolchain.
            </p>
          </section>

          <section className="rounded-lg border bg-panel">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[26%]">Serial</TableHead>
                  <TableHead>adb state</TableHead>
                  <TableHead>Transport</TableHead>
                  <TableHead>Model</TableHead>
                  <TableHead>In the farm</TableHead>
                  <TableHead className="text-right">Queue</TableHead>
                  <TableHead className="w-[1%]" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {devices === null ? (
                  <TableRow>
                    {/* A failed read leaves `devices` null for ever, so this
                        cell must not keep promising a read that already
                        came back — the banner above says what went wrong. */}
                    <TableCell colSpan={7} className="py-6 text-center text-[12.5px] text-faint">
                      {error === null ? 'Reading adb…' : 'adb could not be read — see above.'}
                    </TableCell>
                  </TableRow>
                ) : devices.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={7} className="py-8 text-center text-[12.5px] text-dim">
                      adb holds no transports. Plug a phone in over USB, or dial one above.
                    </TableCell>
                  </TableRow>
                ) : (
                  devices.map((d) => (
                    <TableRow key={d.serial}>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <StatusDot state={adbStateDot(d.state)} title={describeAdbState(d.state)} />
                          <span className="readout truncate text-[12px]">{d.serial}</span>
                          <button
                            type="button"
                            onClick={() => void navigator.clipboard?.writeText(d.serial)}
                            aria-label={`Copy ${d.serial}`}
                            title="Copy the serial"
                            className="rounded p-1 text-faint hover:bg-muted hover:text-text"
                          >
                            <CopyIcon className="size-3.5" aria-hidden />
                          </button>
                        </div>
                      </TableCell>
                      <TableCell className="text-[12px]" title={describeAdbState(d.state)}>
                        {d.state}
                      </TableCell>
                      <TableCell className="readout text-[11.5px] text-dim">
                        {d.endpoint ? `tcp ${d.endpoint.host}:${d.endpoint.port}` : d.usb ? `usb ${d.usb}` : '—'}
                        {d.transportId !== null && <span className="ml-1.5 text-faint">#{d.transportId}</span>}
                      </TableCell>
                      <TableCell className="text-[12px] text-dim">{d.model ?? d.product ?? '—'}</TableCell>
                      <TableCell>
                        <FarmCell device={d} />
                      </TableCell>
                      <TableCell className="text-right text-[12px] tabular-nums text-dim">{d.pending === 0 ? '—' : d.pending}</TableCell>
                      <TableCell>
                        <div className="flex items-center justify-end gap-1">
                          {shellAllowed && (
                            <button
                              type="button"
                              onClick={() => setShell({ serial: d.serial, command: '', output: null, code: null, durationMs: null })}
                              aria-label={`Run a command on ${d.serial}`}
                              title="Run one adb shell command"
                              className="rounded p-1 text-faint hover:bg-muted hover:text-text"
                            >
                              <TerminalIcon className="size-3.5" aria-hidden />
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => setForwardDraft({ serial: d.serial, local: 'tcp:', remote: 'tcp:' })}
                            aria-label={`Forward a port on ${d.serial}`}
                            title="Add a port forward"
                            className="rounded p-1 text-faint hover:bg-muted hover:text-text"
                          >
                            <ArrowsClockwiseIcon className="size-3.5 rotate-90" aria-hidden />
                          </button>
                          {d.endpoint === null ? (
                            <Button
                              variant="ghost"
                              size="sm"
                              disabled={d.state !== 'device' || isPending(`tcpip-${d.serial}`)}
                              title={d.state === 'device' ? 'Restart adbd in TCP mode on 5555' : 'The device must be ready before it can switch to TCP'}
                              onClick={() => void switchToTcpip(d)}
                            >
                              {isPending(`tcpip-${d.serial}`) ? 'Switching…' : 'tcpip'}
                            </Button>
                          ) : (
                            <Button variant="ghost" size="sm" disabled={isPending(`dc-${d.serial}`)} onClick={() => void disconnectOne(d)}>
                              Disconnect
                            </Button>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </section>

          <section className="rounded-lg border bg-panel p-3.5">
            <h2 className="mb-2 flex items-center gap-2 text-[13px] font-semibold text-text">
              <PlugsIcon className="size-4 text-faint" aria-hidden />
              Port forwards
            </h2>
            {forwards.length === 0 ? (
              <p className="text-[12px] text-faint">
                No forward is active. Enkaku's own scrcpy and guest-agent forwards are not listed here — they are opened and closed per session.
              </p>
            ) : (
              <ul className="divide-y">
                {forwards.map((f) => (
                  <li key={`${f.serial}-${f.local}`} className="flex items-center gap-3 py-1.5 text-[12px]">
                    <span className="readout w-[26%] truncate text-dim">{f.serial}</span>
                    <span className="readout">{f.local}</span>
                    <span className="text-faint">→</span>
                    <span className="readout">{f.remote}</span>
                    <button
                      type="button"
                      onClick={() => void removeForward(f)}
                      disabled={isPending(`kf-${f.serial}-${f.local}`)}
                      aria-label={`Remove the forward ${f.local}`}
                      className="ml-auto rounded p-1 text-faint hover:bg-muted hover:text-danger disabled:opacity-50"
                    >
                      <TrashIcon className="size-3.5" aria-hidden />
                    </button>
                  </li>
                ))}
              </ul>
            )}

            {forwardDraft !== null && (
              <div className="mt-3 flex flex-wrap items-center gap-2 border-t pt-3">
                <span className="readout text-[12px] text-dim">{forwardDraft.serial}</span>
                <Input
                  value={forwardDraft.local}
                  onChange={(e) => setForwardDraft({ ...forwardDraft, local: e.target.value })}
                  aria-label="Local port spec"
                  placeholder="tcp:9000"
                  className="h-8 w-36"
                />
                <span className="text-[13px] text-faint">→</span>
                <Input
                  value={forwardDraft.remote}
                  onChange={(e) => setForwardDraft({ ...forwardDraft, remote: e.target.value })}
                  aria-label="Remote port spec"
                  placeholder="tcp:9000 or localabstract:name"
                  className="h-8 w-56"
                />
                <Button size="sm" disabled={isPending('add-forward')} onClick={() => void addForward()}>
                  Add
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setForwardDraft(null)}>
                  Cancel
                </Button>
              </div>
            )}
          </section>

          {shell !== null && (
            <ShellPanel
              shell={shell}
              busy={isPending(`shell-${shell.serial}`)}
              onChange={(command) => setShell({ ...shell, command })}
              onRun={() => void runShell()}
              onClose={() => setShell(null)}
            />
          )}
        </div>
      </div>
    </div>
  )
}

/** What the farm knows about this serial, as one chip plus a name. */
function FarmCell({ device }: { device: AdbRawDevice }) {
  const { kind, name, number } = device.farm
  const tone =
    kind === 'enrolled'
      ? 'border-ok/35 bg-ok/10 text-ok'
      : kind === 'discovered'
        ? 'border-warn/35 bg-warn/10 text-warn'
        : kind === 'blocked'
          ? 'border-danger/35 bg-danger/10 text-danger'
          : 'border-line text-faint'
  const title =
    kind === 'enrolled'
      ? 'A device row exists for this serial'
      : kind === 'discovered'
        ? 'Probed and waiting in the discovery tray — nobody has admitted it'
        : kind === 'blocked'
          ? 'Explicitly refused; the reconciler will not admit it'
          : 'The farm has never seen this serial. Normal while a phone is unauthorized — it cannot be probed until the RSA prompt is accepted.'

  return (
    <div className="flex min-w-0 items-center gap-2">
      <span className={cn('inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[11px]', tone)} title={title}>
        {kind}
      </span>
      {name !== null && (
        <span className="truncate text-[12px] text-dim">
          {number !== null && <span className="text-faint">#{number} </span>}
          {name}
        </span>
      )}
    </div>
  )
}

/**
 * One command, one answer. Deliberately not a terminal: there is no session
 * here to keep — the device this is most needed on is the one with no device
 * row, so `cd` and a shell history would be a promise this cannot keep. The
 * real terminal, with its activity marker, is in Device Control.
 */
function ShellPanel({
  shell,
  busy,
  onChange,
  onRun,
  onClose,
}: {
  shell: Shell
  busy: boolean
  onChange: (command: string) => void
  onRun: () => void
  onClose: () => void
}) {
  return (
    <section className="rounded-lg border bg-panel p-3.5">
      <div className="mb-2 flex items-center gap-2">
        <TerminalIcon className="size-4 text-faint" aria-hidden />
        <h2 className="text-[13px] font-semibold text-text">
          adb shell on <span className="readout font-normal text-dim">{shell.serial}</span>
        </h2>
        <Button variant="ghost" size="sm" className="ml-auto" onClick={onClose}>
          Close
        </Button>
      </div>
      <div className="flex items-center gap-2">
        <Input
          autoFocus
          value={shell.command}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !busy) onRun()
          }}
          placeholder="getprop ro.product.model"
          aria-label="Command to run"
          className="readout h-8 flex-1"
        />
        <Button size="sm" disabled={busy || shell.command.trim().length === 0} onClick={onRun}>
          {busy ? 'Running…' : 'Run'}
        </Button>
      </div>
      {shell.output !== null && (
        <>
          <p className="mt-2 text-[11.5px] text-faint">
            exit {shell.code ?? '?'} · {shell.durationMs}ms
          </p>
          <pre className="readout mt-1 max-h-64 overflow-auto whitespace-pre-wrap rounded-md border bg-panel-2/40 p-2.5 text-[11.5px] leading-relaxed">
            {shell.output.length === 0 ? '(no output)' : shell.output}
          </pre>
        </>
      )}
      <p className="mt-2 text-[11.5px] text-faint">
        Runs against the adb serial, not a farm device — so it works on a phone with no device row. It is gated by the same{' '}
        <span className="readout">privacy.adbCommand</span> switch as every other adb command, and every run is audited.
      </p>
    </section>
  )
}
