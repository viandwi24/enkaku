'use client'

import { useEffect, useState } from 'react'
import type { BatchOrder, CatchUp, ClusterInfo, DeviceInfo, OnOverlap, ScheduleInfo } from '@enkaku/protocol'
import { DevicePicker } from '@/components/DevicePicker'
import { SchemaForm } from '@/components/schema-form/SchemaForm'
import type { JsonSchemaNode } from '@/components/schema-form/types'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { api, useAction } from '@/lib/actions'
import { fetchAllPages } from '@/lib/api'

export interface ScheduleRow extends ScheduleInfo {}

interface ScriptOption {
  id: string
  name: string
  version: string
  paramsSchema: JsonSchemaNode | null
  enabled: boolean
}

interface ValidatePreview {
  valid: boolean
  nextFires: number[]
  error?: string
}

const ONOVERLAP_NOTE: Record<OnOverlap, string> = {
  skip: 'If the previous run is still going, this one is skipped.',
  queue: 'If the previous run is still going, this one still starts and waits its turn.',
  'cancel-previous': 'If the previous run is still going, its queued devices are cancelled and this one starts.',
}

const CATCHUP_NOTE: Record<CatchUp, string> = {
  skip: 'If the core was off when this was due, nothing runs — the misses are recorded.',
  once: 'If the core was off when this was due, it runs once on startup, whatever was missed.',
}

type Target = 'cluster' | 'devices'

function defaultTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

/**
 * Create and edit a schedule (plan 21 §4.6). The cron editor always shows a
 * live preview of its next fires in the chosen timezone before saving — a
 * cron field with no preview is a trap — and every policy choice states its
 * consequence in one plain sentence rather than a bare label.
 */
export function ScheduleEditorDialog({
  schedule,
  devices,
  onClose,
  onSaved,
}: {
  schedule: ScheduleRow | 'new' | null
  devices: DeviceInfo[]
  onClose: () => void
  onSaved: () => void
}) {
  const [name, setName] = useState('')
  const [enabled, setEnabled] = useState(true)
  const [cron, setCron] = useState('0 * * * *')
  const [timezone, setTimezone] = useState(defaultTimezone())
  const [scripts, setScripts] = useState<ScriptOption[]>([])
  const [scriptId, setScriptId] = useState('')
  const [params, setParams] = useState<unknown>(undefined)
  const [target, setTarget] = useState<Target>('cluster')
  const [clusters, setClusters] = useState<ClusterInfo[]>([])
  const [clusterId, setClusterId] = useState('')
  const [deviceIds, setDeviceIds] = useState<string[]>([])
  const [concurrency, setConcurrency] = useState(0)
  const [order, setOrder] = useState<BatchOrder>('as-listed')
  const [onOverlap, setOnOverlap] = useState<OnOverlap>('skip')
  const [queueTimeoutSec, setQueueTimeoutSec] = useState<string>('')
  const [catchUp, setCatchUp] = useState<CatchUp>('skip')
  const [jitterSec, setJitterSec] = useState(0)
  const [priority, setPriority] = useState(0)
  const [preview, setPreview] = useState<ValidatePreview | null>(null)
  const { run, isPending } = useAction()

  const isNew = schedule === 'new'
  const open = schedule !== null

  useEffect(() => {
    if (!open) return
    void fetchAllPages<ScriptOption>('/api/scripts')
      .then((scripts) => setScripts(scripts.filter((s) => s.enabled)))
      .catch(() => setScripts([]))
    void fetchAllPages<ClusterInfo>('/api/clusters')
      .then(setClusters)
      .catch(() => setClusters([]))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  useEffect(() => {
    if (schedule === 'new') {
      setName('')
      setEnabled(true)
      setCron('0 * * * *')
      setTimezone(defaultTimezone())
      setScriptId('')
      setParams(undefined)
      setTarget('cluster')
      setClusterId('')
      setDeviceIds([])
      setConcurrency(0)
      setOrder('as-listed')
      setOnOverlap('skip')
      setQueueTimeoutSec('')
      setCatchUp('skip')
      setJitterSec(0)
      setPriority(0)
    } else if (schedule) {
      setName(schedule.name)
      setEnabled(schedule.enabled)
      setCron(schedule.cron)
      setTimezone(schedule.timezone)
      setScriptId(schedule.scriptId)
      setParams(schedule.params)
      setTarget(schedule.clusterId ? 'cluster' : 'devices')
      setClusterId(schedule.clusterId ?? '')
      setDeviceIds(schedule.deviceIds)
      setConcurrency(schedule.concurrency)
      setOrder(schedule.order)
      setOnOverlap(schedule.onOverlap)
      setQueueTimeoutSec(schedule.queueTimeoutSec != null ? String(schedule.queueTimeoutSec) : '')
      setCatchUp(schedule.catchUp)
      setJitterSec(schedule.jitterSec)
      setPriority(schedule.priority)
    }
  }, [schedule])

  // Live preview — paste a cron expression, see the next five fire times in
  // the chosen timezone, before saving (plan 21 §4.4).
  useEffect(() => {
    if (!open || !cron.trim() || !timezone.trim()) return
    const timer = setTimeout(() => {
      void api<ValidatePreview>('/api/schedules/validate', { method: 'POST', json: { cron, timezone } })
        .then(setPreview)
        .catch(() => setPreview({ valid: false, nextFires: [], error: 'could not reach the core' }))
    }, 300)
    return () => clearTimeout(timer)
  }, [open, cron, timezone])

  if (!open) return null

  const script = scripts.find((s) => s.id === scriptId) ?? null
  const targetCount = target === 'cluster' ? (clusters.find((c) => c.id === clusterId)?.usableCount ?? 0) : deviceIds.length
  const canSubmit =
    name.trim().length > 0 &&
    !!scriptId &&
    (preview?.valid ?? false) &&
    (target === 'cluster' ? !!clusterId : deviceIds.length > 0)

  const body = () => ({
    name,
    enabled,
    cron,
    timezone,
    scriptId,
    params: params ?? {},
    target: target === 'cluster' ? { clusterId } : { deviceIds },
    concurrency,
    order,
    onOverlap,
    queueTimeoutSec: queueTimeoutSec.trim() === '' ? null : Number.parseInt(queueTimeoutSec, 10),
    catchUp,
    jitterSec,
    priority,
  })

  const save = () =>
    run(
      'save',
      () =>
        schedule === 'new'
          ? api<{ schedule: ScheduleInfo }>('/api/schedules', { method: 'POST', json: body() })
          : api<{ schedule: ScheduleInfo }>(`/api/schedules/${schedule.id}`, { method: 'PATCH', json: body() }),
      {
        success: isNew ? 'Schedule created' : 'Schedule saved',
        failure: 'Could not save the schedule',
        onSuccess: () => {
          onSaved()
          onClose()
        },
      },
    )

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{schedule === 'new' ? 'New schedule' : `Edit ${schedule.name}`}</DialogTitle>
          <DialogDescription>Runs a script against a cluster or device list on a cron expression, triggering a batch.</DialogDescription>
        </DialogHeader>

        <div className="max-h-[70vh] space-y-4 overflow-y-auto pr-1">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5 sm:col-span-2">
              <Label className="text-[13px] font-normal">Name</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Nightly smoke run" className="h-8 text-[12.5px]" />
            </div>

            <div className="space-y-1.5">
              <Label className="text-[13px] font-normal">Cron expression</Label>
              <Input value={cron} onChange={(e) => setCron(e.target.value)} placeholder="0 2 * * *" className="readout h-8 text-[12.5px]" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-[13px] font-normal">Timezone (IANA)</Label>
              <Input value={timezone} onChange={(e) => setTimezone(e.target.value)} placeholder="Asia/Jakarta" className="readout h-8 text-[12.5px]" />
            </div>

            <div className="rounded-lg border bg-surface-2/50 p-2.5 text-[12px] sm:col-span-2">
              {preview === null ? (
                <span className="text-fg-muted">Checking…</span>
              ) : !preview.valid ? (
                <span className="text-led-danger">{preview.error ?? 'invalid cron expression'}</span>
              ) : (
                <>
                  <p className="mb-1 font-medium text-fg">Next fires</p>
                  <ul className="readout space-y-0.5 text-fg-muted">
                    {preview.nextFires.slice(0, 5).map((t) => (
                      <li key={t}>{new Date(t * 1000).toLocaleString(undefined, { timeZone: timezone })}</li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          </div>

          <div className="space-y-1.5">
            <Label className="text-[13px] font-normal">Script</Label>
            <Select value={scriptId} onValueChange={(v) => { setScriptId(v); setParams(undefined) }}>
              <SelectTrigger className="h-8 w-full text-[12.5px]">
                <SelectValue placeholder="Pick a script" />
              </SelectTrigger>
              <SelectContent>
                {scripts.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.name} <span className="readout text-fg-subtle">@{s.version}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {script?.paramsSchema ? (
            <SchemaForm schema={script.paramsSchema} value={params} onChange={setParams} />
          ) : script ? (
            <p className="text-[12px] text-fg-muted">This script takes no parameters.</p>
          ) : null}

          <div className="space-y-1.5">
            <Label className="text-[13px] font-normal">Target</Label>
            <Tabs value={target} onValueChange={(v) => setTarget(v as Target)}>
              <TabsList className="grid w-full grid-cols-2">
                <TabsTrigger value="cluster">Cluster</TabsTrigger>
                <TabsTrigger value="devices">Explicit devices</TabsTrigger>
              </TabsList>
            </Tabs>
            {target === 'cluster' ? (
              clusters.length === 0 ? (
                <p className="rounded border border-led-warn/30 bg-led-warn/5 px-2.5 py-2 text-[12px] text-led-warn">
                  No cluster is saved yet — create one from the Clusters page, or pick "Explicit devices".
                </p>
              ) : (
                <Select value={clusterId} onValueChange={setClusterId}>
                  <SelectTrigger className="h-8 w-full text-[12.5px]">
                    <SelectValue placeholder="Pick a cluster" />
                  </SelectTrigger>
                  <SelectContent>
                    {clusters.map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.name} <span className="readout text-fg-subtle">· {c.usableCount} now</span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )
            ) : (
              <DevicePicker devices={devices} value={deviceIds} onChange={setDeviceIds} multiple />
            )}
          </div>

          <div className="grid grid-cols-2 gap-3 rounded-lg border bg-surface-2/40 p-3">
            <div className="space-y-1.5">
              <Label className="text-[12.5px] font-normal">Concurrency</Label>
              <Select value={String(concurrency)} onValueChange={(v) => setConcurrency(Number.parseInt(v, 10))}>
                <SelectTrigger className="h-8 w-full text-[12.5px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="0">All at once</SelectItem>
                  <SelectItem value="1">One at a time</SelectItem>
                  <SelectItem value="2">2 at a time</SelectItem>
                  <SelectItem value="3">3 at a time</SelectItem>
                  <SelectItem value="5">5 at a time</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-[12.5px] font-normal">Order</Label>
              <Select value={order} onValueChange={(v) => setOrder(v as BatchOrder)}>
                <SelectTrigger className="h-8 w-full text-[12.5px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="as-listed">As listed</SelectItem>
                  <SelectItem value="random">Random</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="col-span-2">
              {targetCount > 0 && (
                <p className="text-[11.5px] text-fg-muted">
                  {targetCount} device{targetCount === 1 ? '' : 's'} match right now.
                </p>
              )}
            </div>
          </div>

          <div className="space-y-3 rounded-lg border bg-surface-2/40 p-3">
            <p className="rack-label">policy</p>

            <div className="space-y-1.5">
              <Label className="text-[12.5px] font-normal">If the previous run is still going</Label>
              <Select value={onOverlap} onValueChange={(v) => setOnOverlap(v as OnOverlap)}>
                <SelectTrigger className="h-8 w-full text-[12.5px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="skip">Skip this run</SelectItem>
                  <SelectItem value="queue">Queue behind it</SelectItem>
                  <SelectItem value="cancel-previous">Cancel its queued devices and start</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-[11px] leading-relaxed text-fg-muted">{ONOVERLAP_NOTE[onOverlap]}</p>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-[12.5px] font-normal">Queue timeout (seconds)</Label>
                <Input
                  type="number"
                  min={1}
                  value={queueTimeoutSec}
                  onChange={(e) => setQueueTimeoutSec(e.target.value)}
                  placeholder="Wait forever"
                  className="readout h-8 text-[12.5px]"
                />
                <p className="text-[11px] leading-relaxed text-fg-muted">
                  A job that has not started by then becomes <span className="readout">expired</span> instead of waiting forever.
                </p>
              </div>
              <div className="space-y-1.5">
                <Label className="text-[12.5px] font-normal">Jitter (seconds)</Label>
                <Input
                  type="number"
                  min={0}
                  value={jitterSec}
                  onChange={(e) => setJitterSec(Number.parseInt(e.target.value, 10) || 0)}
                  className="readout h-8 text-[12.5px]"
                />
                <p className="text-[11px] leading-relaxed text-fg-muted">Spreads the dispatch by up to this many seconds, so many schedules do not all hit the farm at once.</p>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-[12.5px] font-normal">If fires were missed while stopped</Label>
                <Select value={catchUp} onValueChange={(v) => setCatchUp(v as CatchUp)}>
                  <SelectTrigger className="h-8 w-full text-[12.5px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="skip">Skip — record only</SelectItem>
                    <SelectItem value="once">Run once, now</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-[12.5px] font-normal">Priority</Label>
                <Select value={String(priority)} onValueChange={(v) => setPriority(Number.parseInt(v, 10))}>
                  <SelectTrigger className="h-8 w-full text-[12.5px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="-10">Low</SelectItem>
                    <SelectItem value="0">Normal</SelectItem>
                    <SelectItem value="10">High</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <p className="text-[11px] leading-relaxed text-fg-muted">{CATCHUP_NOTE[catchUp]}</p>
          </div>

          {!isNew && (
            <div className="flex items-center justify-between gap-4 rounded-lg border bg-surface p-3">
              <div>
                <p className="text-[13px] font-medium">Enabled</p>
                <p className="text-[11.5px] text-fg-muted">A disabled schedule keeps its history but never fires.</p>
              </div>
              <Switch checked={enabled} onCheckedChange={setEnabled} aria-label="Enable this schedule" />
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t pt-3">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void save()} disabled={!canSubmit || isPending('save')}>
            {isPending('save') ? 'Saving…' : isNew ? 'Create schedule' : 'Save changes'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
