'use client'

import { useEffect, useMemo, useState } from 'react'
import {
  clampSchema,
  reconcileParams,
  summarizeClamp,
  ListAgentsResponseSchema,
  ScriptListItemSchema,
  ScheduleResponseSchema,
  ValidateResponseSchema,
} from '@enkaku/protocol'
import type {
  Agent,
  BatchOrder,
  CatchUp,
  DeviceInfo,
  GroupInfo,
  OnApprovalRequired,
  OnOverlap,
  ScheduleInfo,
  ScheduleThreadMode,
} from '@enkaku/protocol'
import {
  api,
  issuesFromError,
  useAction,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Combobox,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  Tabs,
  TabsList,
  TabsTrigger,
  Textarea,
} from '@enkaku/ui'
import { ParamSetPicker } from '@/components/ParamSetPicker'
import { SchemaForm } from '@/components/schema-form/SchemaForm'
import type { JsonSchemaNode } from '@/components/schema-form/types'
import { fetchAllPages, fetchDevices } from '@/lib/api'
import { GroupOrDevicesField, type GroupOrDevicesValue } from './GroupOrDevicesField'

export type ScheduleRow = ScheduleInfo

interface ScriptOption {
  id: string
  name: string
  paramsSchema: JsonSchemaNode | null
}

type WorkKind = 'script' | 'agent'

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

const ONOVERLAP_NOTE: Record<OnOverlap, string> = {
  skip: 'If the previous run is still going, this one is skipped.',
  queue: 'If the previous run is still going, this one still starts and waits its turn.',
  'cancel-previous': 'If the previous run is still going, its queued devices are cancelled and this one starts.',
}

const CATCHUP_NOTE: Record<CatchUp, string> = {
  skip: 'If the core was off when this was due, nothing runs — the misses are recorded.',
  once: 'If the core was off when this was due, it runs once on startup, whatever was missed.',
}

function defaultTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

/**
 * Create and edit a schedule (plan 217 §3.6, §4.7) — carries over the
 * fields of the dialog plan 216 deleted with no replacement, minus the
 * version-pin block (a script name always resolves to its plugin's one
 * active version now, MVP 03 §2.2 rule 4) and with
 * `GroupOrDevicesField`/`groupId` replacing the old device picker and its
 * pre-rename group-id field.
 */
export function ScheduleDialog({
  schedule,
  onClose,
  onSaved,
}: {
  schedule: ScheduleRow | 'new' | null
  onClose: () => void
  onSaved: () => void
}) {
  const [name, setName] = useState('')
  const [enabled, setEnabled] = useState(true)
  const [cron, setCron] = useState('0 * * * *')
  const [timezone, setTimezone] = useState(defaultTimezone())
  const [workKind, setWorkKind] = useState<WorkKind>('script')
  const [agents, setAgents] = useState<Agent[]>([])
  const [agentId, setAgentId] = useState('')
  const [prompt, setPrompt] = useState('')
  const [threadMode, setThreadMode] = useState<ScheduleThreadMode>('new')
  const [onApprovalRequired, setOnApprovalRequired] = useState<OnApprovalRequired>('deny')
  const [scripts, setScripts] = useState<ScriptOption[]>([])
  const [scriptName, setScriptName] = useState('')
  const [params, setParams] = useState<unknown>(undefined)
  const [target, setTarget] = useState<GroupOrDevicesValue>({ mode: 'group', groupId: null, deviceIds: [] })
  const [devices, setDevices] = useState<DeviceInfo[]>([])
  const [groups, setGroups] = useState<GroupInfo[]>([])
  const [concurrency, setConcurrency] = useState(0)
  const [order, setOrder] = useState<BatchOrder>('as-listed')
  const [onOverlap, setOnOverlap] = useState<OnOverlap>('skip')
  const [queueTimeoutSec, setQueueTimeoutSec] = useState('')
  const [catchUp, setCatchUp] = useState<CatchUp>('skip')
  const [jitterSec, setJitterSec] = useState(0)
  const [priority, setPriority] = useState(0)
  const [repeatCount, setRepeatCount] = useState(1)
  const [intervalMinSec, setIntervalMinSec] = useState(0)
  const [intervalMaxSec, setIntervalMaxSec] = useState(0)
  const [deviceIntervalSec, setDeviceIntervalSec] = useState(0)
  const [preview, setPreview] = useState<{ valid: boolean; nextFires: number[]; error?: string } | null>(null)
  const [serverIssues, setServerIssues] = useState<Record<string, string> | undefined>(undefined)
  const [formCanSubmit, setFormCanSubmit] = useState(true)
  const { run, isPending } = useAction()

  const isNew = schedule === 'new'
  const open = schedule !== null

  useEffect(() => {
    if (!open) return
    void fetchAllPages('/api/scripts', undefined, ScriptListItemSchema)
      .then((rows) => setScripts(rows.map((r) => ({ id: r.id, name: r.name, paramsSchema: r.paramsSchema as JsonSchemaNode | null }))))
      .catch(() => setScripts([]))
    void fetchAllPages<GroupInfo>('/api/groups')
      .then(setGroups)
      .catch(() => setGroups([]))
    void fetchDevices()
      .then(setDevices)
      .catch(() => setDevices([]))
    void api('/api/agents', ListAgentsResponseSchema)
      .then((res) => setAgents(res.agents.filter((a) => a.enabled)))
      .catch(() => setAgents([]))
  }, [open])

  useEffect(() => {
    setServerIssues(undefined)
    setFormCanSubmit(true)
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
      setParams(undefined)
      setTarget({ mode: 'group', groupId: null, deviceIds: [] })
      setConcurrency(0)
      setOrder('as-listed')
      setOnOverlap('skip')
      setQueueTimeoutSec('')
      setCatchUp('skip')
      setJitterSec(0)
      setPriority(0)
      setRepeatCount(1)
      setIntervalMinSec(0)
      setIntervalMaxSec(0)
      setDeviceIntervalSec(0)
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
        setParams(undefined)
      } else {
        // No version to parse out any more (§3.6 item 2): `scriptRef` is
        // always `<name>@latest`, so the picked NAME is everything before `@`.
        setScriptName(schedule.target.ref.split('@')[0] ?? '')
        setParams(schedule.params)
      }
      setTarget(
        schedule.groupId
          ? { mode: 'group', groupId: schedule.groupId, deviceIds: [] }
          : { mode: 'devices', groupId: null, deviceIds: schedule.deviceIds },
      )
      setConcurrency(schedule.concurrency)
      setOrder(schedule.order)
      setOnOverlap(schedule.onOverlap)
      setQueueTimeoutSec(schedule.queueTimeoutSec != null ? String(schedule.queueTimeoutSec) : '')
      setCatchUp(schedule.catchUp)
      setJitterSec(schedule.jitterSec)
      setPriority(schedule.priority)
      setRepeatCount(schedule.repeatCount ?? 1)
      setIntervalMinSec(Math.round((schedule.intervalMinMs ?? 0) / 1000))
      setIntervalMaxSec(Math.round((schedule.intervalMaxMs ?? 0) / 1000))
      setDeviceIntervalSec(Math.round((schedule.deviceIntervalMs ?? 0) / 1000))
    }
  }, [schedule])

  useEffect(() => {
    if (!open || !cron.trim() || !timezone.trim()) return
    const timer = setTimeout(() => {
      void api('/api/schedules/validate', ValidateResponseSchema, { method: 'POST', json: { cron, timezone } })
        .then(setPreview)
        .catch(() => setPreview({ valid: false, nextFires: [], error: 'could not reach the core' }))
    }, 300)
    return () => clearTimeout(timer)
  }, [open, cron, timezone])

  const scriptOption = scripts.find((s) => s.name === scriptName) ?? null
  const { schema: clampedSchema, clamped } = useMemo(() => clampSchema(scriptOption?.paramsSchema ?? null), [scriptOption])
  const reconciliation = useMemo(() => reconcileParams(clampedSchema, params), [clampedSchema, params])
  const blockingReconcileErrors = Object.fromEntries(
    reconciliation.findings.filter((f) => f.kind === 'invalid' || f.kind === 'missing').map((f) => [f.path, f.detail]),
  )
  const hasFillableDefaults = reconciliation.findings.some((f) => f.kind === 'reset')

  if (!open) return null

  const targetCount = target.mode === 'group' ? (groups.find((g) => g.id === target.groupId)?.usableCount ?? 0) : target.deviceIds.length
  const canSubmit =
    name.trim().length > 0 &&
    (preview?.valid ?? false) &&
    (target.mode === 'group' ? !!target.groupId : target.deviceIds.length > 0) &&
    (workKind === 'agent' ? !!agentId && prompt.trim().length > 0 : !!scriptName) &&
    intervalMinSec <= intervalMaxSec

  // Always `@latest` — a schedule can no longer pin a specific plugin
  // version, matching MVP 03 §2.2's removal of script-level versioning.
  const scriptRef = `${scriptName}@latest`
  const workTarget =
    workKind === 'agent' ? { kind: 'agent' as const, agentId, prompt } : { kind: 'script' as const, ref: scriptRef, params: params ?? {} }

  const body = () => ({
    name,
    enabled,
    cron,
    timezone,
    workTarget,
    target: target.mode === 'group' ? { groupId: target.groupId } : { deviceIds: target.deviceIds },
    concurrency,
    order,
    onOverlap,
    queueTimeoutSec: queueTimeoutSec.trim() === '' ? null : Number.parseInt(queueTimeoutSec, 10),
    catchUp,
    jitterSec,
    priority,
    repeatCount,
    intervalMinMs: intervalMinSec * 1000,
    intervalMaxMs: intervalMaxSec * 1000,
    deviceIntervalMs: deviceIntervalSec * 1000,
    threadMode,
    onApprovalRequired,
  })

  const save = () => {
    setServerIssues(undefined)
    return run(
      'save',
      async () => {
        try {
          return await (schedule === 'new'
            ? api('/api/schedules', ScheduleResponseSchema, { method: 'POST', json: body() })
            : api(`/api/schedules/${schedule.id}`, ScheduleResponseSchema, { method: 'PATCH', json: body() }))
        } catch (err) {
          setServerIssues(issuesFromError(err))
          throw err
        }
      },
      {
        success: isNew ? 'Schedule created' : 'Schedule saved',
        failure: 'Could not save the schedule',
        onSuccess: () => {
          onSaved()
          onClose()
        },
      },
    )
  }

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{schedule === 'new' ? 'New schedule' : `Edit ${schedule.name}`}</DialogTitle>
          <DialogDescription>Runs a script or an agent against a group or device list on a cron expression.</DialogDescription>
        </DialogHeader>

        <div className="max-h-[70vh] space-y-4 overflow-y-auto pr-1">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5 sm:col-span-2">
              <Label className="text-row font-normal">Name</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Nightly smoke run" className="h-8 text-body" />
            </div>

            <div className="space-y-1.5">
              <Label className="text-row font-normal">Cron expression</Label>
              <Input mono value={cron} onChange={(e) => setCron(e.target.value)} placeholder="0 2 * * *" className="h-8 text-body" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-row font-normal">Timezone (IANA)</Label>
              <Input mono value={timezone} onChange={(e) => setTimezone(e.target.value)} placeholder="Asia/Jakarta" className="h-8 text-body" />
            </div>

            <div className="rounded-card border border-line bg-panel-2 p-2.5 text-meta sm:col-span-2">
              {preview === null ? (
                <span className="text-dim">Checking…</span>
              ) : !preview.valid ? (
                <span className="text-danger">{preview.error ?? 'invalid cron expression'}</span>
              ) : (
                <>
                  <p className="mb-1 font-medium text-text">Next fires</p>
                  <ul className="space-y-0.5 font-mono text-dim">
                    {preview.nextFires.slice(0, 5).map((t) => (
                      <li key={t}>{new Date(t * 1000).toLocaleString(undefined, { timeZone: timezone })}</li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          </div>

          {/* Plan 68 §3.1, §4.5 — the target-kind toggle: one scheduling
              model (cron, overlap, jitter, priority, expiry) covers either a
              script or an agent. */}
          <div className="space-y-1.5">
            <Label className="text-row font-normal">Runs</Label>
            <Tabs
              value={workKind}
              onValueChange={(v) => {
                setWorkKind(v as WorkKind)
                setServerIssues(undefined)
                setFormCanSubmit(true)
              }}
            >
              <TabsList className="grid w-full grid-cols-2">
                <TabsTrigger value="script">A script</TabsTrigger>
                <TabsTrigger value="agent">An agent</TabsTrigger>
              </TabsList>
            </Tabs>
          </div>

          {workKind === 'script' && (
            <>
              <div className="space-y-1.5">
                <Label className="text-row font-normal">Script</Label>
                {/* Searchable for the same reason the Run script dialog is: a
                    farm's plugins publish dozens of scripts. */}
                <Combobox
                  ariaLabel="Script"
                  value={scriptName}
                  onValueChange={(v) => {
                    setScriptName(v)
                    setParams(undefined)
                    setServerIssues(undefined)
                    setFormCanSubmit(true)
                  }}
                  options={scripts.map((s) => ({ value: s.name, label: s.name, keywords: [s.name.split('/')[0] ?? ''] }))}
                  placeholder="Pick a script"
                  searchPlaceholder="Filter scripts…"
                  emptyText="No script matches."
                  triggerClassName="h-8 w-full text-body"
                />
              </div>

              {scriptOption?.paramsSchema ? (
                <>
                  <ParamSetPicker
                    scriptName={scriptName}
                    schema={clampedSchema}
                    value={params}
                    onApply={(next) => {
                      setParams(next)
                      setServerIssues(undefined)
                    }}
                  />
                  {clamped.length > 0 && (
                    <p className="rounded-input border border-warn/30 bg-warn-soft px-2.5 py-2 text-meta text-warn">{summarizeClamp(clamped)}</p>
                  )}
                  {reconciliation.findings.length > 0 && (
                    <div className="space-y-1.5 rounded-input border border-warn/30 bg-warn-soft px-2.5 py-2 text-meta">
                      <div className="flex items-center justify-between gap-2">
                        <p className="font-medium text-warn">
                          {reconciliation.blocking
                            ? "Some stored parameters no longer match this script's schema"
                            : 'This script changed how some stored parameters are read'}
                        </p>
                        {hasFillableDefaults && (
                          <Button type="button" size="sm" variant="secondary" className="h-6 shrink-0 text-label" onClick={() => setParams(reconciliation.value)}>
                            Fill from the defaults
                          </Button>
                        )}
                      </div>
                      <ul className="space-y-0.5 text-dim">
                        {reconciliation.findings.map((f) => (
                          <li key={f.path} className={f.kind === 'invalid' || f.kind === 'missing' ? 'text-danger' : undefined}>
                            <span className="font-mono">{f.path}</span> — {f.detail}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  <SchemaForm
                    key={scriptOption.id}
                    schema={clampedSchema as JsonSchemaNode}
                    value={params}
                    onChange={setParams}
                    serverErrors={{ ...blockingReconcileErrors, ...serverIssues }}
                    onCanSubmitChange={setFormCanSubmit}
                  />
                </>
              ) : scriptOption ? (
                <p className="text-meta text-dim">This script takes no parameters.</p>
              ) : null}
            </>
          )}

          {workKind === 'agent' && (
            <div className="space-y-3">
              {agents.length === 0 ? (
                <p className="rounded-input border border-warn/30 bg-warn-soft px-2.5 py-2 text-meta text-warn">
                  No enabled agent exists yet — create one from the Agents page.
                </p>
              ) : (
                <div className="space-y-1.5">
                  <Label className="text-row font-normal">Agent</Label>
                  <Select value={agentId} onValueChange={setAgentId}>
                    <SelectTrigger className="h-8 w-full text-body">
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
                <Label className="text-row font-normal">Prompt</Label>
                <Textarea
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  placeholder="Check the checkout flow on every device in this target and report anything broken."
                  className="min-h-20 text-body"
                />
                <p className="text-label text-dim">Posted as the firing's message, every time this schedule fires.</p>
              </div>

              <div className="space-y-1.5">
                <Label className="text-body font-normal">Thread</Label>
                <Select value={threadMode} onValueChange={(v) => setThreadMode(v as ScheduleThreadMode)}>
                  <SelectTrigger className="h-8 w-full text-body">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="new">A new thread every firing</SelectItem>
                    <SelectItem value="continue">One continuing thread</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-label text-dim">{THREAD_MODE_NOTE[threadMode]}</p>
              </div>

              <div className="space-y-1.5">
                <Label className="text-body font-normal">If a destructive tool call needs approval</Label>
                <Select value={onApprovalRequired} onValueChange={(v) => setOnApprovalRequired(v as OnApprovalRequired)}>
                  <SelectTrigger className="h-8 w-full text-body">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="deny">Deny it at once</SelectItem>
                    <SelectItem value="pause">Pause and wait for a human</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-label text-dim">{APPROVAL_NOTE[onApprovalRequired]}</p>
              </div>
            </div>
          )}

          <div className="space-y-1.5">
            <Label className="text-row font-normal">Target</Label>
            <GroupOrDevicesField value={target} onChange={setTarget} devices={devices} groups={groups} />
            {targetCount > 0 && (
              <p className="text-meta text-dim">
                {targetCount} device{targetCount === 1 ? '' : 's'} match right now.
              </p>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3 rounded-card border border-line bg-panel-2 p-3">
            <div className="space-y-1.5">
              <Label className="text-body font-normal">Concurrency</Label>
              <Select value={String(concurrency)} onValueChange={(v) => setConcurrency(Number.parseInt(v, 10))}>
                <SelectTrigger className="h-8 w-full text-body">
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
              <Label className="text-body font-normal">Order</Label>
              <Select value={order} onValueChange={(v) => setOrder(v as BatchOrder)}>
                <SelectTrigger className="h-8 w-full text-body">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="as-listed">As listed</SelectItem>
                  <SelectItem value="random">Random</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-3 rounded-card border border-line bg-panel-2 p-3">
            <p className="text-label text-faint uppercase">policy</p>

            <div className="space-y-1.5">
              <Label className="text-body font-normal">If the previous run is still going</Label>
              <Select value={onOverlap} onValueChange={(v) => setOnOverlap(v as OnOverlap)}>
                <SelectTrigger className="h-8 w-full text-body">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="skip">Skip this run</SelectItem>
                  <SelectItem value="queue">Queue behind it</SelectItem>
                  <SelectItem value="cancel-previous">Cancel its queued devices and start</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-label text-dim">{ONOVERLAP_NOTE[onOverlap]}</p>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-body font-normal">Queue timeout (seconds)</Label>
                <Input
                  type="number"
                  min={1}
                  value={queueTimeoutSec}
                  onChange={(e) => setQueueTimeoutSec(e.target.value)}
                  placeholder="Wait forever"
                  mono
                  className="h-8 text-body"
                />
                <p className="text-label text-dim">
                  A job that has not started by then becomes <span className="font-mono">expired</span> instead of waiting forever.
                </p>
              </div>
              <div className="space-y-1.5">
                <Label className="text-body font-normal">Jitter (seconds)</Label>
                <Input
                  type="number"
                  min={0}
                  value={jitterSec}
                  onChange={(e) => setJitterSec(Number.parseInt(e.target.value, 10) || 0)}
                  mono
                  className="h-8 text-body"
                />
                <p className="text-label text-dim">
                  Spreads the dispatch by up to this many seconds, so many schedules do not all hit the farm at once. This shifts the WHOLE
                  firing's own start time, once — it is not the interval between a repeating run's own repetitions (below), which is a
                  different knob entirely.
                </p>
              </div>
            </div>

            <div className="space-y-2.5 rounded-card border border-line bg-panel-2 p-3">
              <div>
                <p className="text-body font-medium">Repeat</p>
                <p className="mt-0.5 text-label text-dim">
                  How many times EACH firing repeats, and how long to wait between whole repetitions — a different knob from Jitter above
                  (which only shifts when the firing itself starts, once) and from the pause between actions inside one run (which lives on
                  the device itself). Leaving this at 1 repetition behaves exactly as before.
                </p>
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="schedule-repeat-count" className="text-body font-normal">
                    Repetitions
                  </Label>
                  <Input
                    id="schedule-repeat-count"
                    type="number"
                    min={1}
                    max={1000}
                    value={repeatCount}
                    onChange={(e) => setRepeatCount(Math.max(1, Number.parseInt(e.target.value, 10) || 1))}
                    mono
                    className="h-8 text-body"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-body font-normal">Interval (s, min–max)</Label>
                  <div className="flex items-center gap-1.5">
                    <Input
                      type="number"
                      min={0}
                      aria-label="Repeat interval minimum (seconds)"
                      value={intervalMinSec}
                      onChange={(e) => setIntervalMinSec(Math.max(0, Number.parseInt(e.target.value, 10) || 0))}
                      mono
                      className="h-8 text-body"
                    />
                    <span className="text-faint">–</span>
                    <Input
                      type="number"
                      min={0}
                      aria-label="Repeat interval maximum (seconds)"
                      value={intervalMaxSec}
                      onChange={(e) => setIntervalMaxSec(Math.max(0, Number.parseInt(e.target.value, 10) || 0))}
                      mono
                      className="h-8 text-body"
                    />
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="schedule-repeat-stagger" className="text-body font-normal">
                    Stagger across devices (s)
                  </Label>
                  <Input
                    id="schedule-repeat-stagger"
                    type="number"
                    min={0}
                    value={deviceIntervalSec}
                    onChange={(e) => setDeviceIntervalSec(Math.max(0, Number.parseInt(e.target.value, 10) || 0))}
                    mono
                    className="h-8 text-body"
                  />
                </div>
              </div>
              {intervalMinSec > intervalMaxSec && <p className="text-meta text-danger">The interval's minimum is greater than its maximum.</p>}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-body font-normal">If fires were missed while stopped</Label>
                <Select value={catchUp} onValueChange={(v) => setCatchUp(v as CatchUp)}>
                  <SelectTrigger className="h-8 w-full text-body">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="skip">Skip — record only</SelectItem>
                    <SelectItem value="once">Run once, now</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-body font-normal">Priority</Label>
                <Select value={String(priority)} onValueChange={(v) => setPriority(Number.parseInt(v, 10))}>
                  <SelectTrigger className="h-8 w-full text-body">
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
            <p className="text-label text-dim">{CATCHUP_NOTE[catchUp]}</p>
          </div>

          {!isNew && (
            <div className="flex items-center justify-between gap-4 rounded-card border border-line bg-panel p-3">
              <div>
                <p className="text-row font-medium text-text">Enabled</p>
                <p className="text-meta text-dim">A disabled schedule keeps its history but never fires.</p>
              </div>
              <Switch checked={enabled} onCheckedChange={setEnabled} aria-label="Enable this schedule" />
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-line pt-3">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void save()} disabled={!canSubmit || !formCanSubmit || isPending('save')}>
            {isPending('save') ? 'Saving…' : isNew ? 'Create schedule' : 'Save changes'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
