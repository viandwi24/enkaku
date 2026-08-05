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

/** Numeric semver compare, newest first. `10.0.0` must beat `9.0.0`, which a string sort gets wrong. */
function byVersionDesc(a: ScriptRow, b: ScriptRow): number {
  const pa = a.version.split('.').map((n) => Number.parseInt(n, 10) || 0)
  const pb = b.version.split('.').map((n) => Number.parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pb[i] ?? 0) - (pa[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

/**
 * One entry per script NAME, newest version first inside each.
 *
 * Every publish creates its own row, so a script iterated on during a debugging
 * session has a dozen of them. Listing those as a dozen choices is not a picker,
 * it is a changelog — and it buries the eleven other scripts the operator might
 * actually want. Name first, version second, newest preselected.
 */
function groupByName(scripts: ScriptRow[]): Array<{ name: string; versions: ScriptRow[] }> {
  const byName = new Map<string, ScriptRow[]>()
  for (const s of scripts) byName.set(s.name, [...(byName.get(s.name) ?? []), s])
  return [...byName.entries()]
    .map(([name, versions]) => ({ name, versions: versions.sort(byVersionDesc) }))
    .sort((a, b) => a.name.localeCompare(b.name))
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
  scripts,
  devices,
  initialDevice,
  initialCluster,
  lockedDevice,
  onLaunched,
  onClose,
}: {
  /** The script, when the surrounding screen already decided it (the Scripts pages). */
  script: ScriptRow | null
  /**
   * The choices, when it did NOT — the device page, where the device is the
   * given and the script is the question. Exactly the inverse of `lockedDevice`
   * below, and the case this dialog was missing: the device page used to pass
   * `scripts[0]` and run whatever happened to sort first.
   */
  scripts?: ScriptRow[]
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
  // When `scripts` is supplied the dialog owns the choice; otherwise `script`
  // decides and these stay unused.
  const groups = groupByName(scripts ?? [])
  const [pickedName, setPickedName] = useState<string>('')
  const [pickedId, setPickedId] = useState<string>('')
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

  // Preselect the newest version of the first script. A picker that opens on
  // nothing makes the operator do work the screen could have done.
  useEffect(() => {
    if (!scripts || scripts.length === 0 || pickedId) return
    const first = groupByName(scripts)[0]
    if (!first?.versions[0]) return
    setPickedName(first.name)
    setPickedId(first.versions[0].id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scripts])

  useEffect(() => {
    if (!script && !scripts) return
    void fetchAllPages<ClusterInfo>('/api/clusters')
      .then(setClusters)
      .catch(() => setClusters([]))
  }, [script])

  useEffect(() => {
    if (!script && !scripts) return
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
  }, [script, scripts, initialDevice, initialCluster, devices.length])

  // Resolved synchronously so the rest of the render never has to ask whether
  // a script exists: the explicit pick, else the newest of the first script.
  // The preselect effect above only persists what this already shows, which
  // keeps the first paint and the state in agreement.
  const chosen = script ?? (scripts ?? []).find((s) => s.id === pickedId) ?? groups[0]?.versions[0] ?? null

  if (!chosen) {
    // Not "no script yet" — no scripts at all. Say which, and how to fix it.
    if (!scripts) return null
    return (
      <Dialog open onOpenChange={(v) => !v && onClose()}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Run a script</DialogTitle>
            <DialogDescription>Nothing is published to this farm yet.</DialogDescription>
          </DialogHeader>
          <p className="text-[12.5px] leading-relaxed text-fg-muted">
            Publish one with <span className="readout">enkaku publish &lt;script.ts&gt;</span>, then run it from here.
          </p>
        </DialogContent>
      </Dialog>
    )
  }

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
              json: { scriptId: chosen.id, deviceId, params: params ?? {} },
            })
          : api<{ batch: { id: string } }>('/api/batches', {
              method: 'POST',
              json: {
                scriptId: chosen.id,
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
            Run {chosen.name}
            <span className="readout ml-1.5 text-[12px] font-normal text-fg-muted">@{chosen.version}</span>
          </DialogTitle>
          <DialogDescription>A single device joins its queue directly; a cluster or list creates a batch.</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {scripts && (
            <div className="grid gap-2.5 sm:grid-cols-[1fr_auto]">
              <div className="space-y-1.5">
                <Label className="text-[13px] font-normal">Script</Label>
                <Select
                  value={pickedName}
                  onValueChange={(name) => {
                    setPickedName(name)
                    // Always land on the newest version of whatever was picked.
                    const g = groups.find((x) => x.name === name)
                    setPickedId(g?.versions[0]?.id ?? '')
                    // Cleared HERE, not in an effect. Every version carries its
                    // own params schema and its own defaults, and `SchemaForm`
                    // seeds defaults from a `[schema]` effect — a child effect,
                    // which React runs BEFORE the parent's. Resetting in a
                    // parent effect would therefore wipe the defaults it had
                    // just filled in, and the form would open blank.
                    setParams(undefined)
                  }}
                >
                  <SelectTrigger className="h-9">
                    <SelectValue placeholder="Pick a script" />
                  </SelectTrigger>
                  <SelectContent>
                    {groups.map((g) => (
                      <SelectItem key={g.name} value={g.name}>
                        {g.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Only when there is a choice to make. A version select showing
                  one option is a control that cannot be used. */}
              {(groups.find((g) => g.name === pickedName)?.versions.length ?? 0) > 1 && (
                <div className="space-y-1.5">
                  <Label className="text-[13px] font-normal">Version</Label>
                  <Select
                    value={pickedId}
                    onValueChange={(id) => {
                      setPickedId(id)
                      // Same reason as above: a different version is a different
                      // schema with different defaults.
                      setParams(undefined)
                    }}
                  >
                    <SelectTrigger className="readout h-9 min-w-28">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {(groups.find((g) => g.name === pickedName)?.versions ?? []).map((v, i) => (
                        <SelectItem key={v.id} value={v.id} className="readout">
                          {v.version}
                          {i === 0 ? ' · latest' : ''}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
            </div>
          )}

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

          {chosen.paramsSchema ? (
            <SchemaForm
              // Keyed on the exact version: a remount guarantees the previous
              // version's answers cannot leak into the next one's fields, even
              // if two versions happen to share a field name.
              key={chosen.id}
              schema={chosen.paramsSchema}
              value={params}
              onChange={setParams}
            />
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
