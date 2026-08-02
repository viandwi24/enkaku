'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import type { BatchOrder, ClusterInfo, DeviceInfo } from '@enkaku/protocol'
import { DevicePicker } from '@/components/DevicePicker'
import { SchemaForm } from '@/components/schema-form/SchemaForm'
import type { JsonSchemaNode } from '@/components/schema-form/types'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { api, useAction } from '@/lib/actions'
import { fetchAllPages } from '@/lib/api'

export interface ScriptRow {
  id: string
  name: string
  version: string
  paramsSchema: JsonSchemaNode | null
  enabled: boolean
  createdBy?: string | null
  source?: string | null
  createdAt: number | null
}

type Target = 'single' | 'cluster' | 'devices'

/** "5 devices, one at a time, in random order — about 5× one run." (plan 20 §4.8). */
function ConsequenceNote({ count, concurrency, order }: { count: number; concurrency: number; order: BatchOrder }) {
  if (count === 0) return null
  const shape =
    concurrency === 0
      ? 'all at once'
      : concurrency === 1
        ? `one device at a time, in ${order === 'random' ? 'random' : 'the listed'} order`
        : `${concurrency} devices at a time, in ${order === 'random' ? 'random' : 'the listed'} order`
  const roughly = concurrency === 0 ? '' : ` — about ${Math.ceil(count / Math.max(concurrency, 1))}× one run`
  return (
    <p className="text-[11.5px] text-fg-muted">
      {count} device{count === 1 ? '' : 's'}, {shape}
      {roughly}.
    </p>
  )
}

/**
 * Running a script: pick a target — a single device, a saved cluster, or an
 * ad-hoc multi-device list — fill in the parameters, run (plan 20 §4.8).
 *
 * A single device still creates one plain job (`POST /api/jobs`), unchanged
 * from plan 19. A cluster or a multi-device pick creates a batch instead
 * (`POST /api/batches`) — one job per device, with the chosen concurrency
 * and order.
 */
export function RunScriptDialog({
  script,
  devices,
  initialDevice,
  initialCluster,
  lockedDevice,
  onLaunched,
  onClose,
}: {
  script: ScriptRow | null
  devices: DeviceInfo[]
  initialDevice?: string | null
  initialCluster?: string | null
  /**
   * The device is already decided by the surrounding screen, so the dialog
   * drops its whole target section: no tabs, no picker, nothing to get wrong.
   * Asking "which device?" on a device's own page is a question the screen has
   * already answered.
   */
  lockedDevice?: DeviceInfo | null
  /**
   * Where to go once the run starts. Omitted, the dialog navigates to the new
   * job or batch — right for the Scripts screen, wrong for the device page,
   * which would throw the operator out of the device they are working on.
   */
  onLaunched?: (result: { jobId?: string; batchId?: string }) => void
  onClose: () => void
}) {
  const [target, setTarget] = useState<Target>('single')
  const locked = lockedDevice ?? null
  const [deviceId, setDeviceId] = useState('')
  const [deviceIds, setDeviceIds] = useState<string[]>([])
  const [clusterId, setClusterId] = useState('')
  const [clusters, setClusters] = useState<ClusterInfo[]>([])
  const [concurrency, setConcurrency] = useState(0)
  const [order, setOrder] = useState<BatchOrder>('as-listed')
  const [params, setParams] = useState<unknown>(undefined)
  const { run, isPending } = useAction()
  const router = useRouter()

  // Offline and quarantined devices cannot accept a job — never default to a
  // choice the server is certain to reject. They still appear in the picker,
  // disabled, with the reason (plan 19 §3.2) — never silently removed.
  const usable = devices.filter((d) => d.status !== 'offline' && d.status !== 'quarantined')

  useEffect(() => {
    if (!script) return
    void fetchAllPages<ClusterInfo>('/api/clusters')
      .then(setClusters)
      .catch(() => setClusters([]))
  }, [script])

  useEffect(() => {
    if (!script) return
    setParams(undefined)
    setDeviceIds([])
    setConcurrency(0)
    setOrder('as-listed')
    if (initialCluster) {
      setTarget('cluster')
      setClusterId(initialCluster)
    } else {
      setTarget('single')
      setDeviceId(initialDevice && usable.some((d) => d.id === initialDevice) ? initialDevice : (usable[0]?.id ?? ''))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [script, initialDevice, initialCluster, devices.length])

  if (!script) return null

  const targetCount = target === 'cluster' ? (clusters.find((c) => c.id === clusterId)?.usableCount ?? 0) : deviceIds.length
  const canSubmit =
    target === 'single' ? !!deviceId : target === 'cluster' ? !!clusterId && targetCount > 0 : deviceIds.length > 0

  const runScript = () =>
    run<{ job: { jobId: string } } | { batch: { id: string } }>(
      'run',
      () =>
        target === 'single'
          ? api<{ job: { jobId: string } }>('/api/jobs', {
              method: 'POST',
              json: { scriptId: script.id, deviceId, params: params ?? {} },
            })
          : api<{ batch: { id: string } }>('/api/batches', {
              method: 'POST',
              json: {
                scriptId: script.id,
                params: params ?? {},
                target: target === 'cluster' ? { clusterId } : { deviceIds },
                concurrency,
                order,
              },
            }),
      {
        success: target === 'single' ? 'Job created' : 'Batch created',
        failure: target === 'single' ? 'Could not create the job' : 'Could not create the batch',
        onSuccess: (b) => {
          onClose()
          const result = 'job' in b ? { jobId: b.job.jobId } : { batchId: b.batch.id }
          if (onLaunched) {
            onLaunched(result)
            return
          }
          if (result.jobId) router.push(`/jobs/detail?id=${result.jobId}`)
          else router.push(`/batches/detail?id=${result.batchId}`)
        },
      },
    )

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            Run {script.name}
            <span className="readout ml-1.5 text-[12px] font-normal text-fg-muted">@{script.version}</span>
          </DialogTitle>
          <DialogDescription>A single device joins its queue directly; a cluster or list creates a batch.</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {locked ? (
            <div className="rounded-lg border bg-surface-2 px-3 py-2">
              <p className="rack-label mb-0.5">running on</p>
              <p className="text-[13px]">
                {locked.label}
                <span className="readout ml-2 text-[11.5px] text-fg-subtle">{locked.stableId}</span>
              </p>
            </div>
          ) : (
            <Tabs value={target} onValueChange={(v) => setTarget(v as Target)}>
              <TabsList className="grid w-full grid-cols-3">
                <TabsTrigger value="single">Single device</TabsTrigger>
                <TabsTrigger value="cluster">Cluster</TabsTrigger>
                <TabsTrigger value="devices">Multiple devices</TabsTrigger>
              </TabsList>
            </Tabs>
          )}

          {!locked && target === 'single' &&
            (devices.length === 0 ? (
              <p className="rounded border border-led-warn/30 bg-led-warn/5 px-2.5 py-2 text-[12px] text-led-warn">
                No device is enrolled yet. Connect one first.
              </p>
            ) : (
              <div className="space-y-1.5">
                <Label className="text-[13px] font-normal">Device</Label>
                <DevicePicker devices={devices} value={deviceId} onChange={setDeviceId} multiple={false} />
              </div>
            ))}

          {target === 'cluster' && (
            <div className="space-y-1.5">
              <Label className="text-[13px] font-normal">Cluster</Label>
              {clusters.length === 0 ? (
                <p className="rounded border border-led-warn/30 bg-led-warn/5 px-2.5 py-2 text-[12px] text-led-warn">
                  No cluster is saved yet — create one from the Clusters page, or pick "Multiple devices" instead.
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
              )}
            </div>
          )}

          {target === 'devices' && (
            <div className="space-y-1.5">
              <Label className="text-[13px] font-normal">Devices</Label>
              <DevicePicker devices={devices} value={deviceIds} onChange={setDeviceIds} multiple />
            </div>
          )}

          {(target === 'cluster' || target === 'devices') && (
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
                <ConsequenceNote count={targetCount} concurrency={concurrency} order={order} />
              </div>
            </div>
          )}

          {script.paramsSchema ? (
            <SchemaForm schema={script.paramsSchema} value={params} onChange={setParams} />
          ) : (
            <p className="text-[12px] text-fg-muted">This script takes no parameters.</p>
          )}

          <div className="flex justify-end gap-2 border-t pt-3">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={() => void runScript()} disabled={!canSubmit || isPending('run')}>
              {isPending('run') ? 'Creating…' : target === 'single' ? 'Run' : 'Run batch'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
