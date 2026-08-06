'use client'

import { useEffect, useState } from 'react'
import { compareSemver, isPrereleaseVersion, ListAgentsResponseSchema, parseScriptRef, ScheduleResponseSchema, ValidateResponseSchema } from '@enkaku/protocol'
import type { Agent, BatchOrder, CatchUp, ClusterInfo, DeviceInfo, OnApprovalRequired, OnOverlap, ScheduleInfo, ScheduleThreadMode } from '@enkaku/protocol'
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
import { Textarea } from '@/components/ui/textarea'
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

/**
 * What `name@latest` resolves to RIGHT NOW, computed from the already-fetched
 * script list — the exact same rule `resolve.ts` applies server-side (plan 62
 * §3.2): highest semver among ENABLED, NON-PRERELEASE versions. Computed
 * client-side rather than round-tripping on every keystroke, since the full
 * version list is already in hand.
 */
function resolveLatest(scripts: ScriptOption[], name: string): ScriptOption | null {
  const candidates = scripts.filter((s) => s.name === name && s.enabled && !isPrereleaseVersion(s.version))
  if (candidates.length === 0) return null
  return [...candidates].sort((a, b) => compareSemver(b.version, a.version))[0] ?? null
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

/** Plan 68 §3.2 — a fresh thread per firing, or one long-lived thread. */
const THREAD_MODE_NOTE: Record<ScheduleThreadMode, string> = {
  new: 'Each firing gets its own thread: independently readable, and a bad run cannot poison tomorrow.',
  continue: 'One thread across every firing — the agent remembers what it saw last time. Grows over time.',
}

/** Plan 68 §3.5 — the interesting choice at 3 a.m., stated in plain words. */
const APPROVAL_NOTE: Record<OnApprovalRequired, string> = {
  deny: 'A destructive tool call is refused at once and the run continues — it can report that it was blocked. Nobody is paged to decide.',
  pause: 'A destructive tool call waits for a human to approve, exactly like a chat run — and expires unanswered like any other approval.',
}

type Target = 'cluster' | 'devices'
/** Plan 68 §3.1 — the work this schedule triggers. */
type WorkKind = 'script' | 'agent'

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
  // Plan 68 §3.1 — the work this schedule triggers, and the agent-only fields.
  const [workKind, setWorkKind] = useState<WorkKind>('script')
  const [agents, setAgents] = useState<Agent[]>([])
  const [agentId, setAgentId] = useState('')
  const [prompt, setPrompt] = useState('')
  const [threadMode, setThreadMode] = useState<ScheduleThreadMode>('new')
  const [onApprovalRequired, setOnApprovalRequired] = useState<OnApprovalRequired>('deny')
  const [scripts, setScripts] = useState<ScriptOption[]>([])
  const [scriptName, setScriptName] = useState('')
  // `@latest` by default (plan 62 §3.3) — a NEW schedule floats unless the
  // operator deliberately pins it; an EXISTING one keeps whatever it was
  // saved as (set in the load effect below).
  const [useLatest, setUseLatest] = useState(true)
  const [pinnedVersion, setPinnedVersion] = useState('')
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
    void api('/api/agents', ListAgentsResponseSchema)
      .then((res) => setAgents(res.agents.filter((a) => a.enabled)))
      .catch(() => setAgents([]))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  useEffect(() => {
    if (schedule === 'new') {
      setName('')
      setEnabled(true)
      setCron('0 * * * *')
      setTimezone(defaultTimezone())
      setWorkKind('script')
      setAgentId('')
      setPrompt('')
      setThreadMode('new')
      setOnApprovalRequired('deny')
      setScriptName('')
      setUseLatest(true)
      setPinnedVersion('')
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
      setWorkKind(schedule.target.kind)
      if (schedule.target.kind === 'agent') {
        setAgentId(schedule.target.agentId)
        setPrompt(schedule.target.prompt)
        setThreadMode(schedule.threadMode)
        setOnApprovalRequired(schedule.onApprovalRequired)
        setScriptName('')
        setUseLatest(true)
        setPinnedVersion('')
        setParams(undefined)
      } else {
        const ref = parseScriptRef(schedule.target.ref)
        setScriptName(ref.name)
        setUseLatest(ref.version === 'latest')
        setPinnedVersion(ref.version === 'latest' ? '' : ref.version)
        setParams(schedule.params)
      }
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
      void api('/api/schedules/validate', ValidateResponseSchema, { method: 'POST', json: { cron, timezone } })
        .then(setPreview)
        .catch(() => setPreview({ valid: false, nextFires: [], error: 'could not reach the core' }))
    }, 300)
    return () => clearTimeout(timer)
  }, [open, cron, timezone])

  if (!open) return null

  // The names available to pick from, one entry each (plan 62 §4.6) — the
  // version choice is a second, separate control below.
  const scriptNames = [...new Set(scripts.map((s) => s.name))].sort((a, b) => a.localeCompare(b))
  const versionsForName = scripts.filter((s) => s.name === scriptName).sort((a, b) => compareSemver(b.version, a.version))
  const resolved = scriptName ? resolveLatest(scripts, scriptName) : null
  // The version whose params schema actually drives the form below: the
  // live resolution when floating on @latest, the exact pinned row otherwise.
  const effectiveVersion = useLatest ? resolved : (versionsForName.find((v) => v.version === pinnedVersion) ?? null)

  const targetCount = target === 'cluster' ? (clusters.find((c) => c.id === clusterId)?.usableCount ?? 0) : deviceIds.length
  const canSubmit =
    name.trim().length > 0 &&
    (preview?.valid ?? false) &&
    (target === 'cluster' ? !!clusterId : deviceIds.length > 0) &&
    (workKind === 'agent' ? !!agentId && prompt.trim().length > 0 : !!scriptName && (useLatest || !!pinnedVersion))

  const scriptRef = `${scriptName}@${useLatest ? 'latest' : pinnedVersion}`

  // Plan 68 §3.1 — the work this schedule triggers, sent explicitly (not
  // just the legacy `scriptRef`) so a PATCH that switches kind actually
  // switches it: `api/schedules.ts`'s PATCH handler only removes/creates the
  // `scheduleAgentTargets` companion row when `workTarget` itself is present
  // in the body.
  const workTarget = workKind === 'agent' ? { kind: 'agent' as const, agentId, prompt } : { kind: 'script' as const, ref: scriptRef, params: params ?? {} }

  const body = () => ({
    name,
    enabled,
    cron,
    timezone,
    workTarget,
    target: target === 'cluster' ? { clusterId } : { deviceIds },
    concurrency,
    order,
    onOverlap,
    queueTimeoutSec: queueTimeoutSec.trim() === '' ? null : Number.parseInt(queueTimeoutSec, 10),
    catchUp,
    jitterSec,
    priority,
    // Plan 68 §3.2, §3.5 — meaningful only for an agent target; harmless to
    // include (and defaulted server-side) for a script one.
    threadMode,
    onApprovalRequired,
  })

  const save = () =>
    run(
      'save',
      () =>
        schedule === 'new'
          ? api('/api/schedules', ScheduleResponseSchema, { method: 'POST', json: body() })
          : api(`/api/schedules/${schedule.id}`, ScheduleResponseSchema, { method: 'PATCH', json: body() }),
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

          {/* Plan 68 §3.1, §4.5 — the target-kind toggle: one scheduling model
              (cron, overlap, jitter, priority, expiry) covers either a
              script or an agent. */}
          <div className="space-y-1.5">
            <Label className="text-[13px] font-normal">Runs</Label>
            <Tabs value={workKind} onValueChange={(v) => setWorkKind(v as WorkKind)}>
              <TabsList className="grid w-full grid-cols-2">
                <TabsTrigger value="script">A script</TabsTrigger>
                <TabsTrigger value="agent">An agent</TabsTrigger>
              </TabsList>
            </Tabs>
          </div>

          {workKind === 'script' && (
            <>
              <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
                <div className="space-y-1.5">
                  <Label className="text-[13px] font-normal">Script</Label>
                  <Select
                    value={scriptName}
                    onValueChange={(v) => {
                      setScriptName(v)
                      setPinnedVersion('')
                      setParams(undefined)
                    }}
                  >
                    <SelectTrigger className="h-8 w-full text-[12.5px]">
                      <SelectValue placeholder="Pick a script" />
                    </SelectTrigger>
                    <SelectContent>
                      {scriptNames.map((n) => (
                        <SelectItem key={n} value={n}>
                          {n}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {/* Only when there is a choice — a single-version script has
                    nothing to pin against, so pinning is pointless to offer. */}
                {!useLatest && versionsForName.length > 0 && (
                  <div className="space-y-1.5">
                    <Label className="text-[13px] font-normal">Version</Label>
                    <Select value={pinnedVersion} onValueChange={(v) => { setPinnedVersion(v); setParams(undefined) }}>
                      <SelectTrigger className="readout h-8 min-w-28 text-[12.5px]">
                        <SelectValue placeholder="Pick a version" />
                      </SelectTrigger>
                      <SelectContent>
                        {versionsForName.map((v) => (
                          <SelectItem key={v.id} value={v.version} className="readout">
                            {v.version}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}
              </div>

              {/* Plan 62 §3.2, §4.6 — the toggle IS the design: `@latest` picks up
                  a new publish on every future firing; pinning freezes it at one
                  exact version. The consequence is stated in plain text right
                  here, before saving, not discovered at the next 3 a.m. run. */}
              <div className="flex items-center justify-between gap-4 rounded-lg border bg-surface-2/40 p-3">
                <div className="min-w-0">
                  <p className="text-[13px] font-medium">Float on the latest version</p>
                  <p className="mt-0.5 text-[11.5px] leading-relaxed text-fg-muted">
                    {useLatest
                      ? 'Every firing re-checks for the newest published, non-prerelease version — a new publish takes effect with no edit here.'
                      : 'Pinned to one exact version. It keeps running that version even after a newer one is published, until you change this.'}
                  </p>
                </div>
                <Switch checked={useLatest} onCheckedChange={(v) => { setUseLatest(v); if (v) setPinnedVersion('') }} aria-label="Float on the latest version" />
              </div>

              {scriptName && useLatest && (
                <p className="readout text-[12px] text-fg-muted">
                  {resolved ? (
                    <>→ resolves to <span className="text-fg">{resolved.version}</span> today</>
                  ) : (
                    <span className="text-led-warn">→ no enabled, non-prerelease version to resolve to right now</span>
                  )}
                </p>
              )}

              {effectiveVersion?.paramsSchema ? (
                <SchemaForm key={effectiveVersion.id} schema={effectiveVersion.paramsSchema} value={params} onChange={setParams} />
              ) : effectiveVersion ? (
                <p className="text-[12px] text-fg-muted">This script takes no parameters.</p>
              ) : null}
            </>
          )}

          {workKind === 'agent' && (
            <div className="space-y-3">
              {agents.length === 0 ? (
                <p className="rounded border border-led-warn/30 bg-led-warn/5 px-2.5 py-2 text-[12px] text-led-warn">
                  No enabled agent exists yet — create one from the Agents page.
                </p>
              ) : (
                <div className="space-y-1.5">
                  <Label className="text-[13px] font-normal">Agent</Label>
                  <Select value={agentId} onValueChange={setAgentId}>
                    <SelectTrigger className="h-8 w-full text-[12.5px]">
                      <SelectValue placeholder="Pick an agent" />
                    </SelectTrigger>
                    <SelectContent>
                      {agents.map((a) => (
                        <SelectItem key={a.id} value={a.id}>
                          {a.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}

              <div className="space-y-1.5">
                <Label className="text-[13px] font-normal">Prompt</Label>
                <Textarea
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  placeholder="Check the checkout flow on every device in this target and report anything broken."
                  className="min-h-20 text-[12.5px]"
                />
                <p className="text-[11px] leading-relaxed text-fg-muted">Posted as the firing's message, every time this schedule fires.</p>
              </div>

              <div className="space-y-1.5">
                <Label className="text-[12.5px] font-normal">Thread</Label>
                <Select value={threadMode} onValueChange={(v) => setThreadMode(v as ScheduleThreadMode)}>
                  <SelectTrigger className="h-8 w-full text-[12.5px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="new">A new thread every firing</SelectItem>
                    <SelectItem value="continue">One continuing thread</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-[11px] leading-relaxed text-fg-muted">{THREAD_MODE_NOTE[threadMode]}</p>
              </div>

              <div className="space-y-1.5">
                <Label className="text-[12.5px] font-normal">If a destructive tool call needs approval</Label>
                <Select value={onApprovalRequired} onValueChange={(v) => setOnApprovalRequired(v as OnApprovalRequired)}>
                  <SelectTrigger className="h-8 w-full text-[12.5px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="deny">Deny it at once</SelectItem>
                    <SelectItem value="pause">Pause and wait for a human</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-[11px] leading-relaxed text-fg-muted">{APPROVAL_NOTE[onApprovalRequired]}</p>
              </div>
            </div>
          )}

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
