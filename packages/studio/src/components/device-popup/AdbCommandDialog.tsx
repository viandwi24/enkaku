'use client'

import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import {
  CommandRunActionResponseSchema,
  CommandRunCreateResponseSchema,
  SettingsResponseSchema,
  isHighConsequence,
  type ClusterInfo,
  type CommandMember,
  type CommandOutput,
  type CommandTarget,
  type DeviceInfo,
  type ServerMessage,
} from '@enkaku/protocol'
import { ConfirmFanout } from '@/components/command/ConfirmFanout'
import { RunReport, type RunReportRun } from '@/components/command/RunReport'
import { EmptyState } from '@/components/states'
import { TargetPicker } from '@/components/target/TargetPicker'
import { useTargetSelection, type Target } from '@/components/target/useTargetSelection'
import { AdbEndpointCard } from '@/components/terminal/AdbEndpointCard'
import { TerminalPane } from '@/components/terminal/TerminalPane'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { api, useAction } from '@/lib/actions'
import { coreBase, ws } from '@/lib/ws'

const TARGET_ALLOW: Target[] = ['single', 'cluster', 'devices']

interface ActiveRun {
  run: RunReportRun
  members: CommandMember[]
  outputs: CommandOutput[]
}

interface ConfirmState {
  cmd: string
  targetCount: number
  hc: ReturnType<typeof isHighConsequence>
  onConfirm: () => void
}

/**
 * The device popup's "Adb command" row — plan 103 §9 Q4, answered
 * 2026-08-16. The owner, twice: *"fitur terminal keknya jadi satu aja
 * dengan adb command ga sih? terus bentuknya modal juga dan bisa deteksi
 * device juga, jadi bisa running banyak devices"*, then, seeing it still a
 * side-panel tab: *"terminal kenapa masih ada tab nya? ... ketika di tekan
 * muncul popup modal tersendiri ... seperti install apk mendukung opsi
 * specific device, multiple device atau cluster ... tapi outputnya harus
 * bisa dilihat langsung juga?"* This is that modal — it replaces the
 * `SidePanel`'s old Terminal TAB entirely (`SidePanel.tsx`'s own doc
 * comment records the removal).
 *
 * **Two shapes behind one `TargetPicker` (plan 104), not two features
 * wearing one name.** §9 Q4 itself named the tension: an interactive
 * session on one device and a fan-out command across a target set are
 * genuinely different, and the resolution is which surface answers which —
 * not picking a winner between them.
 *
 * - **`single`** renders `TerminalPane` UNCHANGED — the same interactive,
 *   multi-command session with a live transcript, arrow-up history, and its
 *   own high-consequence confirm (plan 26 §4.5, plan 93 §3.5). This is also
 *   the answer to "do not silently drop the interactive session" (the
 *   owner's own instruction on this pass): it has not moved or lost
 *   anything, it is simply this modal's single-device shape instead of a
 *   side-panel tab reached by a separate click.
 * - **`cluster`/`devices`** renders the fleet console's OWN pieces —
 *   `RunReport`, `ConfirmFanout` — talking to the SAME `POST
 *   /api/command-runs` / `command.*` WS events `/console` already uses
 *   (plan 93). Nothing here reinvents per-device output; it reuses the one
 *   house style multi-device reports already have (`docs/design.md`'s
 *   "Multi-device reports — outcome first, grouped by reason").
 *
 * `TerminalPane`'s own `canType` only ever reflects THIS popup's lease on
 * the FOCUSED device (`canUseLive`, `DevicePopup.tsx`'s `iHoldControl &&
 * !busy`) — switching `single` mode to a different device in the picker
 * still shows its transcript live (everyone watching a device sees it,
 * plan 26 §3.8) but the input box stays honestly disabled, since this
 * popup holds no lease on a device it never claimed.
 *
 * **`single` mode also carries `AdbEndpointCard` (plan 103 §5, closing step
 * 103.11's audit row 8, 2026-08-17)** — the lease-scoped `adb connect`
 * endpoint, above `TerminalPane`, gated on the SAME `shell.endpointEnabled`
 * farm switch the device page's own Terminal tab reads. This is where the
 * card belongs now: it was always "beside the Terminal tab" (its own file
 * header), and the Terminal tab's device-aware successor is this modal's
 * `single` mode, not a side-panel tab any more (§9 Q4 above).
 */
export function AdbCommandDialog({
  deviceId,
  devices,
  selectedIds = [],
  clusters = [],
  canUseLive,
  open,
  onOpenChange,
}: {
  /** The popup's own focused device — `single` mode's default, and the only device `canType` can ever be true for. */
  deviceId: string
  /** The Wall's whole pool — `TargetPicker`'s `devices`/`cluster` modes need it, same as `ActionsList`'s other multi-device rows. */
  devices: DeviceInfo[]
  /** The Wall's own live selection, unioned with `deviceId` before becoming the picker's pre-fill (plan 104 §3.2). */
  selectedIds?: readonly string[]
  clusters?: ClusterInfo[]
  /** `iHoldControl && !busy` on the focused device — gates `TerminalPane`'s input box in `single` mode. */
  canUseLive: boolean
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { run: runAction, isPending } = useAction()
  const [shellMode, setShellMode] = useState<'off' | 'admin' | 'operator' | 'all'>('admin')
  const [fanoutEnabled, setFanoutEnabled] = useState(true)
  const [fanoutConfirmThreshold, setFanoutConfirmThreshold] = useState(5)
  const [fanoutMaxDevices, setFanoutMaxDevices] = useState(0)
  // Plan 103 §5, closing step 103.11's audit row 8 — the SAME farm switch
  // `app/device/page.tsx`'s own Terminal tab reads for `AdbEndpointCard`
  // below.
  const [endpointEnabled, setEndpointEnabled] = useState(false)
  const [settingsLoaded, setSettingsLoaded] = useState(false)

  const [cmd, setCmd] = useState('')
  const [staged, setStaged] = useState(false)
  const [stageFirstN, setStageFirstN] = useState(1)
  const [confirm, setConfirm] = useState<ConfirmState | null>(null)
  const [activeRun, setActiveRun] = useState<ActiveRun | null>(null)

  const targetSelection = useTargetSelection({ usableCount: devices.length, clusters })
  const { target, deviceId: singleDeviceId, deviceIds, clusterId, hasTarget, fleetConfirmed, resolvedCount } = targetSelection

  const mySessionId = ws.getSessionId()

  // Re-default and clear any run every time the dialog OPENS — the same
  // shape `InstallBatchDialog` uses (plan 104 §3.2): nothing else selected
  // on the Wall behind this popup lands `single` on the focused device; N
  // devices selected arrive pre-filled, still fully editable.
  //
  // Plan 103 §5 step 103.10 — dedupe BEFORE checking length, not after.
  // The old `selectedIds.length > 0 ? [...new Set(...)] : undefined` checked
  // the RAW selection's length first, so a caller whose own selection is
  // JUST this device (`selectedIds: [deviceId]` — exactly what a right-click
  // on a not-yet-selected tile produces, plan 101 §5 step 101.5's own rule)
  // still took the `devices`-mode branch with a redundant one-device
  // pre-fill, instead of `single` — the wrong default for what is, in
  // substance, "nothing else selected". `ActionsList.tsx`'s own
  // `candidateIds` fixes the identical shape for its Wake/Sleep/Forget rows;
  // this is the same fix for this dialog's own default.
  useEffect(() => {
    if (!open) return
    setCmd('')
    setStaged(false)
    setActiveRun(null)
    setConfirm(null)
    const candidateIds = [...new Set([deviceId, ...selectedIds])]
    const initialSelectedIds = candidateIds.length > 1 ? candidateIds : undefined
    targetSelection.reset({ devices, allow: TARGET_ALLOW, initialDeviceId: deviceId, initialSelectedIds })
    void api('/api/settings', SettingsResponseSchema)
      .then((b) => {
        setShellMode(b.settings.shell.mode)
        setFanoutEnabled(b.settings.shell.fanoutEnabled)
        setFanoutConfirmThreshold(b.settings.shell.fanoutConfirmThreshold)
        setFanoutMaxDevices(b.settings.shell.fanoutMaxDevices)
        setEndpointEnabled(b.settings.shell.endpointEnabled)
      })
      .catch(() => undefined)
      .finally(() => setSettingsLoaded(true))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  function handleOpenChange(o: boolean): void {
    onOpenChange(o)
    if (!o) {
      setActiveRun(null)
      setConfirm(null)
    }
  }

  // Subscriber-scoped output (plan 93 §3.17) — the identical shape
  // `/console` uses, scoped to whatever run this modal currently shows;
  // unsubscribes on close (via `handleOpenChange` clearing `activeRun`,
  // which Radix then unmounts) or when a new run replaces this one.
  useEffect(() => {
    if (!activeRun) return
    const runId = activeRun.run.id
    const subscribe = () => ws.send({ type: 'command.subscribe', payload: { runId } })
    subscribe()
    const offReconnect = ws.onReconnected(subscribe)

    const off = ws.on((msg: ServerMessage) => {
      if (!msg.type.startsWith('command.')) return
      const payload = msg.payload as { runId: string }
      if (payload.runId !== runId) return
      setActiveRun((prev) => {
        if (!prev || prev.run.id !== runId) return prev
        if (msg.type === 'command.started') {
          return { ...prev, members: msg.payload.members, run: { ...prev.run, counts: msg.payload.counts } }
        }
        if (msg.type === 'command.progress') {
          const byId = new Map(prev.members.map((m) => [m.deviceId, m]))
          for (const m of msg.payload.changed) byId.set(m.deviceId, m)
          return { ...prev, members: [...byId.values()], run: { ...prev.run, counts: msg.payload.counts } }
        }
        if (msg.type === 'command.output') {
          const rest = prev.outputs.filter((o) => o.hash !== msg.payload.output.hash)
          return { ...prev, outputs: [...rest, msg.payload.output] }
        }
        if (msg.type === 'command.stage') {
          return { ...prev, run: { ...prev.run, stage: msg.payload.stage, status: msg.payload.awaitingContinue ? 'awaiting-continue' : 'running' } }
        }
        if (msg.type === 'command.finished') {
          return {
            ...prev,
            run: { ...prev.run, status: msg.payload.status, counts: msg.payload.counts, finishedAt: prev.run.startedAt + Math.round(msg.payload.durationMs / 1000) },
          }
        }
        return prev
      })
    })

    return () => {
      off()
      offReconnect()
      ws.send({ type: 'command.unsubscribe', payload: { runId } })
    }
  }, [activeRun?.run.id])

  function submitGuarded(cmdText: string, targetCount: number, doSend: (acknowledged: boolean) => void): void {
    if (targetCount === 0) {
      toast.error('No devices to target', { description: 'Nothing in the current target is eligible to receive this command.' })
      return
    }
    if (fanoutMaxDevices > 0 && targetCount > fanoutMaxDevices) {
      toast.error('Too many devices', { description: `This farm limits a fleet command to ${fanoutMaxDevices} devices at once.` })
      return
    }
    const hc = isHighConsequence(cmdText)
    const needsAck = hc.hit && targetCount > 1
    const needsTyped = targetCount > fanoutConfirmThreshold
    if (needsAck || needsTyped) {
      setConfirm({
        cmd: cmdText,
        targetCount,
        hc,
        onConfirm: () => {
          doSend(true)
          setConfirm(null)
        },
      })
    } else {
      doSend(false)
    }
  }

  async function startRun(acknowledged: boolean): Promise<void> {
    const commandTarget: CommandTarget | null = target === 'cluster' ? (clusterId ? { clusterId } : null) : deviceIds.length > 0 ? { deviceIds } : null
    if (!commandTarget || !mySessionId) return
    const hc = isHighConsequence(cmd)
    const result = await runAction(
      'start',
      () =>
        api('/api/command-runs', CommandRunCreateResponseSchema, {
          json: {
            cmd: cmd.trim(),
            target: commandTarget,
            clientId: mySessionId,
            ...(staged && stageFirstN > 0 ? { stageFirstN } : {}),
            ...(hc.hit && acknowledged ? { acknowledge: { highConsequence: true } } : {}),
          },
        }),
      { failure: 'Could not start the command' },
    )
    if (!result) return
    setActiveRun({ run: result.run, members: result.members, outputs: [] })
  }

  function handleRunClick(): void {
    if (!hasTarget || !cmd.trim()) return
    submitGuarded(cmd.trim(), resolvedCount, (acknowledged) => void startRun(acknowledged))
  }

  async function doRetry(only: 'failed' | 'skipped', acknowledged: boolean): Promise<void> {
    if (!activeRun || !mySessionId) return
    const hc = isHighConsequence(activeRun.run.cmd)
    const result = await runAction(
      `retry-${only}`,
      () =>
        api(`/api/command-runs/${activeRun.run.id}/rerun?only=${only}`, CommandRunCreateResponseSchema, {
          json: { clientId: mySessionId, ...(hc.hit && acknowledged ? { acknowledge: { highConsequence: true } } : {}) },
        }),
      { failure: `Could not retry the ${only} devices` },
    )
    if (!result) return
    setActiveRun({ run: result.run, members: result.members, outputs: [] })
  }

  function handleRetry(only: 'failed' | 'skipped'): void {
    if (!activeRun) return
    const count = only === 'failed' ? activeRun.run.counts.failed : activeRun.run.counts.skipped
    submitGuarded(activeRun.run.cmd, count, (acknowledged) => void doRetry(only, acknowledged))
  }

  async function cancelRun(): Promise<void> {
    if (!activeRun) return
    await runAction('cancel', () => api(`/api/command-runs/${activeRun.run.id}/cancel`, CommandRunActionResponseSchema, { method: 'POST' }), {
      failure: 'Could not stop the run',
    })
  }

  async function continueRun(): Promise<void> {
    if (!activeRun) return
    await runAction('continue', () => api(`/api/command-runs/${activeRun.run.id}/continue`, CommandRunActionResponseSchema, { method: 'POST' }), {
      failure: 'Could not continue the run',
    })
  }

  async function fetchFullOutput(devId: string, stream: 'stdout' | 'stderr'): Promise<string> {
    if (!activeRun) return ''
    const res = await fetch(`${coreBase()}/api/command-runs/${activeRun.run.id}/members/${encodeURIComponent(devId)}/output?stream=${stream}`)
    if (!res.ok) return ''
    return res.text()
  }

  function deviceLabel(devId: string): string {
    return devices.find((d) => d.id === devId)?.label ?? devId
  }

  const shellOff = shellMode === 'off'
  const fanoutOff = !fanoutEnabled

  return (
    <>
      {/* Plan 103 §3.2 — non-modal (`overlay={false}` + `modal={false}`), so
          the live screen beside this modal stays visible and interactive
          while a command runs — the strongest case for it, since watching
          the phone react is the whole point (§9 Q4's own resolution). */}
      <Dialog open={open} onOpenChange={handleOpenChange} modal={false}>
        <DialogContent overlay={false} className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Adb command</DialogTitle>
            <DialogDescription>
              Run a shell command on this device, several, or a cluster — output is visible live, the same as the fleet
              command console.
            </DialogDescription>
          </DialogHeader>

          {!settingsLoaded ? (
            <p className="text-[11.5px] text-fg-subtle">Loading…</p>
          ) : shellOff ? (
            <EmptyState
              title="Device shell access is turned off"
              description="Turn it on from Settings → Device terminal and command console."
            />
          ) : (
            <div className="space-y-3">
              <TargetPicker selection={targetSelection} devices={devices} clusters={clusters} allow={TARGET_ALLOW} singleLabel="Device" devicesLabel="Devices" />

              {target === 'single' ? (
                singleDeviceId ? (
                  <div className="space-y-3">
                    {/* Row 8 (audit) — the lease-scoped `adb connect`
                        endpoint, gated on the farm's `shell.endpointEnabled`
                        exactly like the device page's own Terminal tab.
                        `canOpen` mirrors `TerminalPane`'s own `canType`
                        below — a picked device this popup never claimed a
                        lease on stays honestly closed, same reasoning. */}
                    {endpointEnabled && (
                      <AdbEndpointCard deviceId={singleDeviceId} clientId={ws.getSessionId()} canOpen={singleDeviceId === deviceId && canUseLive} />
                    )}
                    <div className="max-h-[26rem] overflow-y-auto rounded-lg border">
                      <TerminalPane
                        deviceId={singleDeviceId}
                        canType={singleDeviceId === deviceId && canUseLive}
                        onRunAsStream={() =>
                          toast.info('Open Jobs → Monitor from the Actions list to watch this as a live stream.', {
                            description: 'Reachable from this device’s own popup now — no need to leave for the full device page.',
                          })
                        }
                      />
                    </div>
                  </div>
                ) : (
                  <EmptyState title="No device to target" description="Pick a device above." />
                )
              ) : fanoutOff ? (
                <EmptyState
                  title="Fleet commands are turned off for this farm"
                  description="Switch to Single device — a single device's own terminal still works."
                />
              ) : (
                <div className="space-y-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="popup-adb-cmd" className="text-[11.5px] text-fg-muted">
                      Command
                    </Label>
                    <Input
                      id="popup-adb-cmd"
                      value={cmd}
                      onChange={(e) => setCmd(e.target.value)}
                      placeholder="getprop ro.build.version.release"
                      className="readout h-8 text-[12.5px]"
                    />
                  </div>

                  <div className="flex items-center gap-2">
                    <Switch checked={staged} onCheckedChange={setStaged} id="popup-adb-staged" />
                    <Label htmlFor="popup-adb-staged" className="text-[11.5px] text-fg-muted">
                      Run on the first N first
                    </Label>
                    {staged && (
                      <Input
                        type="number"
                        min={1}
                        value={stageFirstN}
                        onChange={(e) => setStageFirstN(Math.max(1, Number(e.target.value)))}
                        className="h-7 w-16 text-[12px]"
                        aria-label="Stage 1 device count"
                      />
                    )}
                  </div>

                  <Button size="sm" onClick={handleRunClick} disabled={!hasTarget || !cmd.trim() || !fleetConfirmed || isPending('start')}>
                    {isPending('start') ? 'Starting…' : 'Run'}
                  </Button>

                  {activeRun && (
                    <RunReport
                      run={activeRun.run}
                      members={activeRun.members}
                      outputs={activeRun.outputs}
                      deviceLabel={deviceLabel}
                      onCancel={() => void cancelRun()}
                      onContinue={() => void continueRun()}
                      onRetryFailed={() => handleRetry('failed')}
                      onRetrySkipped={() => handleRetry('skipped')}
                      fetchFullOutput={fetchFullOutput}
                      busy={
                        isPending('cancel')
                          ? 'cancel'
                          : isPending('continue')
                            ? 'continue'
                            : isPending('retry-failed')
                              ? 'retry-failed'
                              : isPending('retry-skipped')
                                ? 'retry-skipped'
                                : null
                      }
                    />
                  )}
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* A scale confirmation (plan 93 §3.14), not a security control — the
          one dialog in this modal that stays Radix-modal (`ConfirmFanout`
          is shared unchanged with `/console`, which has no live screen to
          preserve). Rare: only above the confirm threshold, or a
          high-consequence command aimed at more than one device. */}
      {confirm && (
        <ConfirmFanout
          open
          onOpenChange={(o) => !o && setConfirm(null)}
          cmd={confirm.cmd}
          targetCount={confirm.targetCount}
          threshold={fanoutConfirmThreshold}
          highConsequence={confirm.hc}
          onConfirm={confirm.onConfirm}
        />
      )}
    </>
  )
}
