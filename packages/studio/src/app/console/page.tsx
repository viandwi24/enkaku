'use client'

import { Suspense, useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { toast } from 'sonner'
import {
  CommandRunActionResponseSchema,
  CommandRunCreateResponseSchema,
  SettingsResponseSchema,
  isHighConsequence,
  type ClusterInfo,
  type CommandCounts,
  type CommandMember,
  type CommandOutput,
  type CommandRunStatus,
  type CommandTarget,
  type DeviceInfo,
  type ServerMessage,
} from '@enkaku/protocol'
import { PageHeader } from '@/components/layout/PageHeader'
import { EmptyState, LoadingRows } from '@/components/states'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { api, useAction } from '@/lib/actions'
import { fetchAllPages, fetchDevices } from '@/lib/api'
import { coreBase, ws } from '@/lib/ws'
import { CommandHistory } from '@/components/command/CommandHistory'
import { ConfirmFanout } from '@/components/command/ConfirmFanout'
import { RunReport, type RunReportRun } from '@/components/command/RunReport'
import { SavedCommands } from '@/components/command/SavedCommands'
import { TargetPicker } from '@/components/command/TargetPicker'
import { computeTargetPreview } from '@/components/command/target-preview'

/**
 * `/console` — the fleet command console (plan 93 §3.16, §4.8, step 93.7).
 * "Send an adb command to one device or all" — the request the whole plan
 * answers. `POST /api/command-runs` is the ONLY way to start a run,
 * including for N = 1 from here (§3.17); the interactive terminal on a
 * device's own page is untouched and stays exactly where it is.
 *
 * Four properties this step's own brief names, each visible below:
 * 1. A run's result is per-device, always — `RunReport` shows every device
 *    behind every count; this page never renders a bare number.
 * 2. The acknowledgement is a SCALE confirmation, never a safety net —
 *    `submitGuarded` opens `ConfirmFanout` only above the threshold or for
 *    a high-consequence command targeting more than one device; a single
 *    device never sees it.
 * 3. Staged rollout holds no lease while it waits — `RunReport`'s own
 *    `awaiting-continue` banner says so.
 * 4. Output is subscriber-scoped — this page sends `command.subscribe`
 *    only for the run it is actively showing, and unsubscribes on
 *    unmount/replacement. There is no "watch everything" mode.
 */

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

function toReportRun(run: {
  id: string
  cmd: string
  status: CommandRunStatus
  stage: number
  stageFirstN: number
  counts: CommandCounts
  startedAt: number
  finishedAt: number | null
}): RunReportRun {
  return {
    id: run.id,
    cmd: run.cmd,
    status: run.status,
    stage: run.stage,
    stageFirstN: run.stageFirstN,
    counts: run.counts,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
  }
}

function ConsolePageInner() {
  const params = useSearchParams()
  const { run: runAction, isPending } = useAction()

  const [devices, setDevices] = useState<DeviceInfo[]>([])
  const [clusters, setClusters] = useState<ClusterInfo[]>([])
  const [loaded, setLoaded] = useState(false)
  const [shellMode, setShellMode] = useState<'off' | 'admin' | 'operator' | 'all'>('admin')
  const [fanoutEnabled, setFanoutEnabled] = useState(true)
  const [fanoutConfirmThreshold, setFanoutConfirmThreshold] = useState(5)
  const [fanoutMaxDevices, setFanoutMaxDevices] = useState(0)

  const [cmd, setCmd] = useState('')
  const [target, setTarget] = useState<CommandTarget | null>(null)
  const [staged, setStaged] = useState(false)
  const [stageFirstN, setStageFirstN] = useState(1)
  const [concurrency, setConcurrency] = useState(0)
  const [confirm, setConfirm] = useState<ConfirmState | null>(null)
  const [activeRun, setActiveRun] = useState<ActiveRun | null>(null)
  const [historyReloadKey, setHistoryReloadKey] = useState(0)

  const mySessionId = ws.getSessionId()

  useEffect(() => {
    Promise.all([fetchDevices(), fetchAllPages<ClusterInfo>('/api/clusters')])
      .then(([d, c]) => {
        setDevices(d)
        setClusters(c)
      })
      .catch(() => {
        // The page still renders — an empty target picker rather than a crash.
      })
      .finally(() => setLoaded(true))

    api('/api/settings', SettingsResponseSchema)
      .then((b) => {
        setShellMode(b.settings.shell.mode)
        setFanoutEnabled(b.settings.shell.fanoutEnabled)
        setFanoutConfirmThreshold(b.settings.shell.fanoutConfirmThreshold)
        setFanoutMaxDevices(b.settings.shell.fanoutMaxDevices)
      })
      .catch(() => undefined)
  }, [])

  // Prefill from `TerminalPane`'s "Run on more devices…" action (§3.16):
  // `/console?cmd=…&deviceId=…`. Read once — a later query-string change
  // (e.g. the browser back button) does not fight with what the operator has
  // since typed. `?deviceIds=` (comma-separated, plan 93 §3.16, §4.8, F15,
  // step 93.11) is the fleet page's own "Run command…" toolbar action
  // (`app/page.tsx`) prefilling the WHOLE current selection — additive
  // beside the single-`deviceId` form `TerminalPane` already uses, never a
  // replacement for it.
  useEffect(() => {
    const qCmd = params.get('cmd')
    const qDeviceId = params.get('deviceId')
    const qDeviceIds = params.get('deviceIds')
    if (qCmd) setCmd(qCmd)
    if (qDeviceIds) {
      const ids = qDeviceIds.split(',').filter(Boolean)
      if (ids.length > 0) setTarget({ deviceIds: ids })
    } else if (qDeviceId) {
      setTarget({ deviceIds: [qDeviceId] })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Subscriber-scoped output (§3.17, property 4): subscribe only to the run
  // currently shown, unsubscribe on unmount or when a new run replaces it —
  // never a "watch everything" mode.
  useEffect(() => {
    if (!activeRun) return
    const runId = activeRun.run.id
    const subscribe = () => ws.send({ type: 'command.subscribe', payload: { runId } })
    subscribe()
    const offReconnect = ws.onReconnected(subscribe)

    const off = ws.on((msg: ServerMessage) => {
      // `ws.on` only ever delivers `ServerMessage`s — `command.subscribe`/
      // `command.unsubscribe` are client→server and never arrive here, so
      // this is just "is it one of the five server events this run cares
      // about" (`command.started/progress/output/stage/finished`).
      if (!msg.type.startsWith('command.')) return
      const payload = msg.payload as { runId: string }
      if (payload.runId !== runId) return
      setActiveRun((prev) => {
        if (!prev || prev.run.id !== runId) return prev
        if (msg.type === 'command.started') {
          return { ...prev, members: msg.payload.members, run: { ...prev.run, counts: msg.payload.counts, stage: prev.run.stage } }
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
    if (!target) return
    const sessionId = ws.getSessionId()
    if (!sessionId) {
      toast.error('Not connected to the core yet — try again in a moment.')
      return
    }
    const hc = isHighConsequence(cmd)
    const result = await runAction(
      'start',
      () =>
        api('/api/command-runs', CommandRunCreateResponseSchema, {
          json: {
            cmd: cmd.trim(),
            target,
            clientId: sessionId,
            ...(staged && stageFirstN > 0 ? { stageFirstN } : {}),
            ...(concurrency > 0 ? { concurrency } : {}),
            ...(hc.hit && acknowledged ? { acknowledge: { highConsequence: true } } : {}),
          },
        }),
      { failure: 'Could not start the command' },
    )
    if (!result) return
    setActiveRun({ run: toReportRun(result.run), members: result.members, outputs: [] })
    setHistoryReloadKey((k) => k + 1)
  }

  function handleRunClick(): void {
    if (!target || !cmd.trim()) return
    const preview = computeTargetPreview(devices, target, mySessionId)
    submitGuarded(cmd.trim(), preview.willAttempt.length, (acknowledged) => void startRun(acknowledged))
  }

  async function doRetry(only: 'failed' | 'skipped', acknowledged: boolean): Promise<void> {
    if (!activeRun) return
    const sessionId = ws.getSessionId()
    if (!sessionId) return
    const hc = isHighConsequence(activeRun.run.cmd)
    const result = await runAction(
      `retry-${only}`,
      () =>
        api(`/api/command-runs/${activeRun.run.id}/rerun?only=${only}`, CommandRunCreateResponseSchema, {
          json: { clientId: sessionId, ...(hc.hit && acknowledged ? { acknowledge: { highConsequence: true } } : {}) },
        }),
      { failure: `Could not retry the ${only} devices` },
    )
    if (!result) return
    setActiveRun({ run: toReportRun(result.run), members: result.members, outputs: [] })
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

  async function fetchFullOutput(deviceId: string, stream: 'stdout' | 'stderr'): Promise<string> {
    if (!activeRun) return ''
    const res = await fetch(`${coreBase()}/api/command-runs/${activeRun.run.id}/members/${encodeURIComponent(deviceId)}/output?stream=${stream}`)
    if (!res.ok) return ''
    return res.text()
  }

  function deviceLabel(deviceId: string): string {
    return devices.find((d) => d.id === deviceId)?.label ?? deviceId
  }

  const gated = shellMode === 'off' || !fanoutEnabled

  return (
    <>
      <PageHeader title="Console" description="Run a command on one device or the whole farm." />

      {!loaded ? (
        <div className="px-5 py-4">
          <LoadingRows rows={4} />
        </div>
      ) : gated ? (
        <div className="px-5 py-4">
          <EmptyState
            title="The command console is turned off for this farm"
            description={
              shellMode === 'off'
                ? 'Device shell access is turned off (Settings → Device terminal and command console).'
                : 'Fleet commands are turned off for this farm — a single device still has its own Terminal tab.'
            }
          />
        </div>
      ) : (
        <div className="grid gap-4 px-5 py-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
          <div className="space-y-4">
            <div className="space-y-3 rounded-lg border bg-surface p-3.5">
              <TargetPicker devices={devices} clusters={clusters} target={target} onChange={setTarget} mySessionId={mySessionId} />

              <div className="space-y-1.5">
                <Label htmlFor="console-cmd" className="text-[11.5px] text-fg-muted">
                  Command
                </Label>
                <Input
                  id="console-cmd"
                  value={cmd}
                  onChange={(e) => setCmd(e.target.value)}
                  placeholder="getprop ro.build.version.release"
                  className="readout h-8 text-[12.5px]"
                />
              </div>

              <div className="flex flex-wrap items-center gap-4">
                <div className="flex items-center gap-2">
                  <Switch checked={staged} onCheckedChange={setStaged} id="console-staged" />
                  <Label htmlFor="console-staged" className="text-[11.5px] text-fg-muted">
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
              </div>

              <Button onClick={handleRunClick} disabled={!target || !cmd.trim() || isPending('start')}>
                {isPending('start') ? 'Starting…' : 'Run'}
              </Button>
            </div>

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
                busy={isPending('cancel') ? 'cancel' : isPending('continue') ? 'continue' : isPending('retry-failed') ? 'retry-failed' : isPending('retry-skipped') ? 'retry-skipped' : null}
              />
            )}
          </div>

          <aside className="space-y-4">
            <div className="space-y-2 rounded-lg border bg-surface p-3">
              <p className="rack-label text-fg">Saved commands</p>
              <SavedCommands
                currentCmd={cmd}
                currentTarget={target}
                onUse={(useCmd, defaultTarget) => {
                  setCmd(useCmd)
                  if (defaultTarget) setTarget(defaultTarget)
                }}
              />
            </div>

            <div className="space-y-2 rounded-lg border bg-surface p-3">
              <p className="rack-label text-fg">History</p>
              <CommandHistory
                devices={devices}
                clusters={clusters}
                reloadKey={historyReloadKey}
                onRunAgain={(again, againTarget) => {
                  setCmd(again)
                  setTarget(againTarget)
                }}
                onRunAgainOn={(again) => {
                  setCmd(again)
                  setTarget(null)
                }}
              />
            </div>
          </aside>
        </div>
      )}

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

export default function ConsolePage() {
  return (
    <Suspense
      fallback={
        <div className="px-5 py-4">
          <LoadingRows rows={4} />
        </div>
      }
    >
      <ConsolePageInner />
    </Suspense>
  )
}
