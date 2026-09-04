'use client'

import { useEffect, useMemo, useState } from 'react'
import {
  clampSchema,
  compareSemver,
  ListAgentsResponseSchema,
  parseScriptRef,
  reconcileParams,
  ScheduleResponseSchema,
  ScriptListItemSchema,
  summarizeClamp,
  ValidateResponseSchema,
} from '@enkaku/protocol'
import type { Agent, BatchOrder, CatchUp, GroupInfo, DeviceInfo, OnApprovalRequired, OnOverlap, ScheduleInfo, ScheduleThreadMode } from '@enkaku/protocol'
import { DevicePicker } from '@/components/DevicePicker'
import { ParamSetPicker } from '@/components/ParamSetPicker'
import { SchemaForm } from '@/components/schema-form/SchemaForm'
import type { JsonSchemaNode } from '@/components/schema-form/types'
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
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
  api,
  issuesFromError,
  useAction,
} from '@enkaku/ui'
import { fetchAllPages } from '@/lib/api'
import { toScriptRow } from '@/lib/script-row'

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
 * Plan 210 (MVP 03 §2.2 rule 1) — one row per script name (the member of
 * whichever plugin version is active), so "resolve `name@latest`" is just
 * finding that row.
 */
function resolveLatest(scripts: ScriptOption[], name: string): ScriptOption | null {
  return scripts.find((s) => s.name === name) ?? null
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

type Target = 'group' | 'devices'
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
  const [target, setTarget] = useState<Target>('group')
  const [groups, setGroups] = useState<GroupInfo[]>([])
  const [groupId, setGroupId] = useState('')
  const [deviceIds, setDeviceIds] = useState<string[]>([])
  const [concurrency, setConcurrency] = useState(0)
  const [order, setOrder] = useState<BatchOrder>('as-listed')
  const [onOverlap, setOnOverlap] = useState<OnOverlap>('skip')
  const [queueTimeoutSec, setQueueTimeoutSec] = useState<string>('')
  const [catchUp, setCatchUp] = useState<CatchUp>('skip')
  const [jitterSec, setJitterSec] = useState(0)
  const [priority, setPriority] = useState(0)
  // Plan 94 §3.6, §4.10, step 94.10 — the Repeat section (94.9's own
  // schedule-level pacing fields, passed through unconditionally by
  // `runner.ts`'s `fireOnce`, exactly like `concurrency`/`order`/`priority`
  // already were). `1`/`0`/`0`/`0` reproduces today's behaviour exactly.
  const [repeatCount, setRepeatCount] = useState(1)
  const [intervalMinSec, setIntervalMinSec] = useState(0)
  const [intervalMaxSec, setIntervalMaxSec] = useState(0)
  const [deviceIntervalSec, setDeviceIntervalSec] = useState(0)
  const [preview, setPreview] = useState<ValidatePreview | null>(null)
  // Plan 95 §3.7, §4.3, §5 step 95.6 (fixes F12, F14) — the same wiring
  // `RunScriptDialog` uses: `serverErrors` maps onto `SchemaForm`,
  // `formCanSubmit` is ANDed into the Save button below.
  const [serverIssues, setServerIssues] = useState<Record<string, string> | undefined>(undefined)
  const [formCanSubmit, setFormCanSubmit] = useState(true)
  const { run, isPending } = useAction()

  const isNew = schedule === 'new'
  const open = schedule !== null

  useEffect(() => {
    if (!open) return
    // `ScriptListItemSchema` (plan 95 §5 step 95.5, fixes F8) — see
    // `device/page.tsx`'s identical fix for the full reasoning.
    void fetchAllPages('/api/scripts', undefined, ScriptListItemSchema)
      .then((items) => setScripts(items.map(toScriptRow)))
      .catch(() => setScripts([]))
    void fetchAllPages<GroupInfo>('/api/groups')
      .then(setGroups)
      .catch(() => setGroups([]))
    void api('/api/agents', ListAgentsResponseSchema)
      .then((res) => setAgents(res.agents.filter((a) => a.enabled)))
      .catch(() => setAgents([]))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  useEffect(() => {
    setServerIssues(undefined)
    // A no-params script, or an agent target, never mounts `SchemaForm`,
    // which would otherwise leave a PREVIOUS pick's `false` stuck (F14).
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
      setUseLatest(true)
      setPinnedVersion('')
      setParams(undefined)
      setTarget('group')
      setGroupId('')
      setDeviceIds([])
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
      setTarget(schedule.groupId ? 'group' : 'devices')
      setGroupId(schedule.groupId ?? '')
      setDeviceIds(schedule.deviceIds)
      setConcurrency(schedule.concurrency)
      setOrder(schedule.order)
      setOnOverlap(schedule.onOverlap)
      setQueueTimeoutSec(schedule.queueTimeoutSec != null ? String(schedule.queueTimeoutSec) : '')
      setCatchUp(schedule.catchUp)
      setJitterSec(schedule.jitterSec)
      setPriority(schedule.priority)
      // `?? ` defaults (plan 94 §4.9's own additive/`.default()` fields) —
      // a schedule fetched through an older fixture or a not-yet-refreshed
      // cache predating step 94.9 has none of these keys at all; defaulting
      // to "unpaced" is the same fallback the wire itself uses.
      setRepeatCount(schedule.repeatCount ?? 1)
      setIntervalMinSec(Math.round((schedule.intervalMinMs ?? 0) / 1000))
      setIntervalMaxSec(Math.round((schedule.intervalMaxMs ?? 0) / 1000))
      setDeviceIntervalSec(Math.round((schedule.deviceIntervalMs ?? 0) / 1000))
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

  // The names available to pick from, one entry each (plan 62 §4.6) — the
  // version choice is a second, separate control below. Computed BEFORE the
  // `!open` early return below, on purpose: `clampedSchema` is a hook and
  // must be called on every render, so `effectiveVersion` (what it clamps)
  // has to be available before any conditional return, not after.
  const scriptNames = [...new Set(scripts.map((s) => s.name))].sort((a, b) => a.localeCompare(b))
  const versionsForName = scripts.filter((s) => s.name === scriptName).sort((a, b) => compareSemver(b.version, a.version))
  const resolved = scriptName ? resolveLatest(scripts, scriptName) : null
  // The version whose params schema actually drives the form below: the
  // live resolution when floating on @latest, the exact pinned row otherwise.
  const effectiveVersion = useLatest ? resolved : (versionsForName.find((v) => v.version === pinnedVersion) ?? null)

  // Plan 95 §3.8, §5 step 95.5 — "reject at publish, clamp at render", the
  // same defence `RunScriptDialog` carries. `clampSchema` is total,
  // so `effectiveVersion` being null (no script picked yet, or an agent
  // target) just clamps an empty schema to an empty schema.
  const { schema: clampedSchema, clamped } = useMemo(
    () => clampSchema(effectiveVersion?.paramsSchema ?? null),
    [effectiveVersion?.paramsSchema],
  )

  // Plan 95 §4.4, §5 step 95.7 — the schedule-evolution rule, run live in the
  // editor: `params` may have been saved against an EARLIER version of this
  // script's schema (loaded verbatim by the effect above, never silently
  // reshaped). Recomputed whenever the schema or the value changes, never
  // stored — same "read fresh, never cached" rule `paramsCompatible` follows
  // server-side (`GET /api/schedules`).
  const reconciliation = useMemo(() => reconcileParams(clampedSchema, params), [clampedSchema, params])
  const blockingReconcileErrors = Object.fromEntries(
    reconciliation.findings.filter((f) => f.kind === 'invalid' || f.kind === 'missing').map((f) => [f.path, f.detail]),
  )
  const hasFillableDefaults = reconciliation.findings.some((f) => f.kind === 'reset')

  if (!open) return null

  const targetCount = target === 'group' ? (groups.find((c) => c.id === groupId)?.usableCount ?? 0) : deviceIds.length
  const canSubmit =
    name.trim().length > 0 &&
    (preview?.valid ?? false) &&
    (target === 'group' ? !!groupId : deviceIds.length > 0) &&
    (workKind === 'agent' ? !!agentId && prompt.trim().length > 0 : !!scriptName && (useLatest || !!pinnedVersion)) &&
    // Plan 94 §4.9, step 94.10 — mirrors the core's own `assertPacingValid`
    // client-side, the same defence `RunScriptDialog`'s Repeat section has.
    intervalMinSec <= intervalMaxSec

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
    target: target === 'group' ? { groupId } : { deviceIds },
    concurrency,
    order,
    onOverlap,
    queueTimeoutSec: queueTimeoutSec.trim() === '' ? null : Number.parseInt(queueTimeoutSec, 10),
    catchUp,
    jitterSec,
    priority,
    // Plan 94 §3.6, §4.9, §4.10, step 94.9/94.10 — the schedule's own repeat
    // pacing, passed through to `createBatch` on every future firing
    // exactly like `concurrency`/`order`/`priority` (F34). Seconds in the
    // UI, milliseconds on the wire — the same unit split `RunScriptDialog`'s
    // own Repeat section already made.
    repeatCount,
    intervalMinMs: intervalMinSec * 1000,
    intervalMaxMs: intervalMaxSec * 1000,
    deviceIntervalMs: deviceIntervalSec * 1000,
    // Plan 68 §3.2, §3.5 — meaningful only for an agent target; harmless to
    // include (and defaulted server-side) for a script one.
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
          // `invalid_job_params` (plan 95 §3.7, §4.3, fixes F12) — same
          // wiring as `RunScriptDialog`: attach the field-level issues to
          // the form; `run()`'s own catch still shows the toast.
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
          <DialogDescription>Runs a script against a group or device list on a cron expression, triggering a batch.</DialogDescription>
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
            <Tabs
              value={workKind}
              onValueChange={(v) => {
                setWorkKind(v as WorkKind)
                // Switching to "An agent" unmounts `SchemaForm` entirely,
                // which would otherwise leave a script pick's `false` stuck.
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
              <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
                <div className="space-y-1.5">
                  <Label className="text-[13px] font-normal">Script</Label>
                  <Select
                    value={scriptName}
                    onValueChange={(v) => {
                      setScriptName(v)
                      setPinnedVersion('')
                      setParams(undefined)
                      setServerIssues(undefined)
                      setFormCanSubmit(true)
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
                    <Select value={pinnedVersion} onValueChange={(v) => { setPinnedVersion(v); setParams(undefined); setServerIssues(undefined); setFormCanSubmit(true) }}>
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
                <>
                  {/* Plan 95 §4.7, §4.8, §5 step 95.8 — the same picker
                      `RunScriptDialog` has. Applying a preset here stores
                      its RECONCILED value into `params` below, exactly like
                      typing it in by hand — never a reference to the set:
                      "a preset edited later must not silently change what a
                      schedule runs" (the same reference-vs-resolution split
                      plan 62 §3.3 draws between `schedules.scriptRef` and
                      `jobs.scriptId`, applied here to a preset instead of a
                      script version). */}
                  <ParamSetPicker
                    scriptName={scriptName}
                    schema={clampedSchema}
                    value={params}
                    onApply={(next) => {
                      setParams(next)
                      setServerIssues(undefined)
                    }}
                  />
                  {/* Plan 95 §3.8, §5 step 95.5 — same clamp-and-say-so
                      backstop as `RunScriptDialog`, for a schema stored
                      before `checkDeclaredSchema` existed. */}
                  {clamped.length > 0 && (
                    <p className="rounded border border-led-warn/30 bg-led-warn/5 px-2.5 py-2 text-[12px] text-led-warn">
                      {summarizeClamp(clamped)}
                    </p>
                  )}
                  {/* Plan 95 §4.4, §5 step 95.7 — an attended caller does not
                      stop (§4.4): the findings are shown and the fields they
                      block are highlighted below (via `serverErrors`), but
                      saving is never refused outright here the way an
                      unattended firing is. "Fill from the new version's
                      defaults" only ever touches the NON-blocking findings
                      (`reset`) — a `missing`/`invalid` field has no default
                      to fill from, which is exactly why it blocks; those
                      stay for the operator to answer by hand. */}
                  {reconciliation.findings.length > 0 && (
                    <div className="space-y-1.5 rounded border border-led-warn/30 bg-led-warn/5 px-2.5 py-2 text-[12px]">
                      <div className="flex items-center justify-between gap-2">
                        <p className="font-medium text-led-warn">
                          {reconciliation.blocking
                            ? "Some stored parameters no longer match this version's schema"
                            : "This version changed how some stored parameters are read"}
                        </p>
                        {hasFillableDefaults && (
                          <Button
                            type="button"
                            size="sm"
                            variant="secondary"
                            className="h-6 shrink-0 text-[11px]"
                            onClick={() => setParams(reconciliation.value)}
                          >
                            Fill from the new version&apos;s defaults
                          </Button>
                        )}
                      </div>
                      <ul className="space-y-0.5 text-fg-muted">
                        {reconciliation.findings.map((f) => (
                          <li key={f.path} className={f.kind === 'invalid' || f.kind === 'missing' ? 'text-led-danger' : undefined}>
                            <span className="readout">{f.path}</span> — {f.detail}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  <SchemaForm
                    key={effectiveVersion.id}
                    schema={clampedSchema as JsonSchemaNode}
                    value={params}
                    onChange={setParams}
                    serverErrors={{ ...blockingReconcileErrors, ...serverIssues }}
                    onCanSubmitChange={setFormCanSubmit}
                  />
                </>
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
                <TabsTrigger value="group">Group</TabsTrigger>
                <TabsTrigger value="devices">Explicit devices</TabsTrigger>
              </TabsList>
            </Tabs>
            {target === 'group' ? (
              groups.length === 0 ? (
                <p className="rounded border border-led-warn/30 bg-led-warn/5 px-2.5 py-2 text-[12px] text-led-warn">
                  No group is saved yet — create one from the Groups page, or pick "Explicit devices".
                </p>
              ) : (
                <Select value={groupId} onValueChange={setGroupId}>
                  <SelectTrigger className="h-8 w-full text-[12.5px]">
                    <SelectValue placeholder="Pick a group" />
                  </SelectTrigger>
                  <SelectContent>
                    {groups.map((c) => (
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
                <p className="text-[11px] leading-relaxed text-fg-muted">
                  Spreads the dispatch by up to this many seconds, so many schedules do not all hit the farm at once.
                  {/* Plan 94 §4.10, step 94.10 — the two-knob distinction this
                      dialog is required to draw: this jitter shifts WHEN the
                      whole firing starts, once, before anything runs. It is
                      not the same knob as a repeating run's own interval
                      below, which shifts the gap between each repetition
                      inside that one firing. */}{' '}
                  This shifts the WHOLE firing's own start time, once — it is not the interval between a repeating
                  run's own repetitions (below), which is a different knob entirely.
                </p>
              </div>
            </div>

            {/* Plan 94 §3.6, §4.10, §9 Q4, step 94.10 — the same Repeat
                section `RunScriptDialog` has, for the batch each firing
                creates. Now functional: step 94.9 landed the schedule-level
                `repeatCount`/`intervalMinMs`/`intervalMaxMs`/
                `deviceIntervalMs` columns and `runner.ts`'s `fireOnce`
                passes them into `createBatch` unconditionally, exactly like
                `concurrency`/`order`/`priority` already were (F34) — so
                these fields now take real effect on every future firing. */}
            <div className="space-y-2.5 rounded-lg border bg-surface-2/40 p-3">
              <div>
                <p className="text-[12.5px] font-medium">Repeat</p>
                <p className="mt-0.5 text-[11px] leading-relaxed text-fg-muted">
                  How many times EACH firing repeats, and how long to wait between whole repetitions — a different
                  knob from Jitter above (which only shifts when the firing itself starts, once) and from the pause
                  between actions inside one run (which lives on the device itself, Device → Settings → Human-like
                  touch). Leaving this at 1 repetition behaves exactly as before.
                </p>
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="schedule-repeat-count" className="text-[12.5px] font-normal">
                    Repetitions
                  </Label>
                  <Input
                    id="schedule-repeat-count"
                    type="number"
                    min={1}
                    max={1000}
                    value={repeatCount}
                    onChange={(e) => setRepeatCount(Math.max(1, Number.parseInt(e.target.value, 10) || 1))}
                    className="readout h-8 text-[12.5px]"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-[12.5px] font-normal">Interval (s, min–max)</Label>
                  <div className="flex items-center gap-1.5">
                    <Input
                      type="number"
                      min={0}
                      aria-label="Repeat interval minimum (seconds)"
                      value={intervalMinSec}
                      onChange={(e) => setIntervalMinSec(Math.max(0, Number.parseInt(e.target.value, 10) || 0))}
                      className="readout h-8 text-[12.5px]"
                    />
                    <span className="text-fg-subtle">–</span>
                    <Input
                      type="number"
                      min={0}
                      aria-label="Repeat interval maximum (seconds)"
                      value={intervalMaxSec}
                      onChange={(e) => setIntervalMaxSec(Math.max(0, Number.parseInt(e.target.value, 10) || 0))}
                      className="readout h-8 text-[12.5px]"
                    />
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="schedule-repeat-stagger" className="text-[12.5px] font-normal">
                    Stagger across devices (s)
                  </Label>
                  <Input
                    id="schedule-repeat-stagger"
                    type="number"
                    min={0}
                    value={deviceIntervalSec}
                    onChange={(e) => setDeviceIntervalSec(Math.max(0, Number.parseInt(e.target.value, 10) || 0))}
                    className="readout h-8 text-[12.5px]"
                  />
                </div>
              </div>
              {intervalMinSec > intervalMaxSec && (
                <p className="text-[11.5px] text-led-danger">The interval's minimum is greater than its maximum.</p>
              )}
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
          <Button onClick={() => void save()} disabled={!canSubmit || !formCanSubmit || isPending('save')}>
            {isPending('save') ? 'Saving…' : isNew ? 'Create schedule' : 'Save changes'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
