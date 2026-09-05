'use client'

import { useEffect, useState } from 'react'
import { DeviceDetailResponseSchema, SettingsResponseSchema, compileWorkflowParams, isHighConsequence } from '@enkaku/protocol'
import type { ActionResponse, ActionVerb, DeviceSettingsPatch, ScriptListItem } from '@enkaku/protocol'
import {
  Button,
  Checkbox,
  Input,
  Label,
  Combobox,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  api,
} from '@enkaku/ui'
import { jobHref } from '@/components/jobs/job-view'
import { ArtifactPicker, uploadArtifactSource, type ArtifactSource } from '@/components/ArtifactPicker'
import { PresetRow } from '@/components/presets/PresetRow'
import { ScriptTrigger } from '@/components/scripts/ScriptPalette'
import { SchemaForm } from '@/components/schema-form/SchemaForm'
import { narrowSchema } from '@/components/schema-form/narrowSchema'
import { deviceSections } from '@/components/settings/deviceSections'
import { SectionNav } from '@/components/settings/SectionNav'
import type { JsonSchemaNode } from '@/components/schema-form/types'
import { fetchAllPages, listWorkflows, type WorkflowInfo } from '@/lib/api'
import { groupResults } from '@/lib/actions'
import type { TargetState } from '@/components/target/useTarget'

/**
 * The verb dialog registry (§4.6): the twelve of the design handoff's
 * generic action set, in the handoff's own order, then the three of the
 * overflow.
 */
export interface VerbDialogSpec<P> {
  verb: ActionVerb
  /** The dialog title. `n` is the resolved target count. */
  title: (n: number) => string
  submitLabel: (n: number) => string
  destructive?: boolean
  /**
   * Runs on click, with no dialog at all (CEO, 2026-09-05).
   *
   * A modal exists to collect something. A verb that takes no input and asks
   * no question puts a box on screen whose only content is a sentence and a
   * button that repeats the menu item just clicked — two clicks for one act.
   * The target is already chosen: the menu was opened from a selection.
   *
   * Never set on a `destructive` verb. Forgetting a device or removing its
   * agent is exactly where the second click earns its place.
   */
  immediate?: boolean
  /** Plugins may declare 1 (MVP 07 §2.1). No MVP verb does. */
  maxTargets?: number
  /** The initial draft. */
  initial: P
  /** The fields under the divider, or null for a verb with no parameters. */
  Fields: React.ComponentType<{ value: P; onChange: (next: P) => void; target: TargetState }> | null
  /** Rendered in the form container when `Fields` is null: one sentence saying what will happen. */
  note?: string
  /**
   * A wider dialog for a verb whose form is genuinely two-dimensional. Every
   * dialog is 520px, which suits a form that is one column of fields; the
   * Settings form is a section nav BESIDE a column of fields, and at 520px
   * the nav took a third of the width and left the fields in a gutter — the
   * ratio the owner reported as looking off (2026-09-05). Opt-in, so the
   * fifteen one-column dialogs keep the width they were designed at.
   */
  wide?: boolean
  /** Blocks submit while false. */
  canSubmit: (value: P) => boolean
  /** The plan-207 request params. May upload an artifact first, which is why it is async. */
  toParams: (value: P) => Promise<Record<string, unknown>>
  onDone?: (res: ActionResponse, grouped: ReturnType<typeof groupResults>) => void
}

const n = (count: number) => `${count} device${count === 1 ? '' : 's'}`

// ---------------------------------------------------------------------------
// 1. Reconnect
// ---------------------------------------------------------------------------
const reconnect: VerbDialogSpec<Record<string, never>> = {
  verb: 'reconnect',
  immediate: true,
  title: (c) => `Reconnect ${n(c)}`,
  submitLabel: (c) => `Reconnect ${n(c)}`,
  initial: {},
  Fields: null,
  note: 'Re-attaches each device over its remembered address. An offline device is retried, not skipped.',
  canSubmit: () => true,
  toParams: async () => ({}),
}

// ---------------------------------------------------------------------------
// 2. Disconnect
// ---------------------------------------------------------------------------
const disconnect: VerbDialogSpec<Record<string, never>> = {
  verb: 'disconnect',
  immediate: true,
  title: (c) => `Disconnect ${n(c)}`,
  submitLabel: (c) => `Disconnect ${n(c)}`,
  initial: {},
  Fields: null,
  note: 'A device with a running job warns before it disconnects; continuing acknowledges the job may fail.',
  canSubmit: () => true,
  toParams: async () => ({}),
}

// ---------------------------------------------------------------------------
// 3. Install apk
// ---------------------------------------------------------------------------
interface InstallValue {
  source: ArtifactSource | null
  reinstall: boolean
  grantPermissions: boolean
  allowDowngrade: boolean
}
function InstallFields({ value, onChange }: { value: InstallValue; onChange: (v: InstallValue) => void }) {
  return (
    <div className="space-y-3">
      <ArtifactPicker accept=".apk" value={value.source} onChange={(source) => onChange({ ...value, source })} />
      <label className="flex items-center gap-2 text-row text-text">
        <Checkbox checked={value.reinstall} onCheckedChange={(v) => onChange({ ...value, reinstall: v === true })} />
        Reinstall, keeping data
      </label>
      <label className="flex items-center gap-2 text-row text-text">
        <Checkbox checked={value.grantPermissions} onCheckedChange={(v) => onChange({ ...value, grantPermissions: v === true })} />
        Allow every permission the app requests
      </label>
      <label className="flex items-center gap-2 text-row text-text">
        <Checkbox checked={value.allowDowngrade} onCheckedChange={(v) => onChange({ ...value, allowDowngrade: v === true })} />
        Allow a downgrade
      </label>
    </div>
  )
}
const install: VerbDialogSpec<InstallValue> = {
  verb: 'install',
  title: (c) => `Install apk on ${n(c)}`,
  submitLabel: (c) => `Install on ${n(c)}`,
  initial: { source: null, reinstall: false, grantPermissions: false, allowDowngrade: false },
  Fields: InstallFields,
  canSubmit: (v) => v.source !== null,
  toParams: async (v) => {
    if (!v.source) throw new Error('choose a file first')
    const artifactId = await uploadArtifactSource(v.source)
    return { artifactId, reinstall: v.reinstall, grantPermissions: v.grantPermissions, allowDowngrade: v.allowDowngrade }
  },
}

// ---------------------------------------------------------------------------
// 4. Adb command
// ---------------------------------------------------------------------------
interface AdbValue {
  cmd: string
}
function AdbFields({ value, onChange }: { value: AdbValue; onChange: (v: AdbValue) => void }) {
  const check = isHighConsequence(value.cmd)
  return (
    <div className="space-y-1.5">
      <Label htmlFor="adb-cmd">Command</Label>
      <Input id="adb-cmd" mono value={value.cmd} maxLength={4096} onChange={(e) => onChange({ cmd: e.target.value })} placeholder="shell dumpsys battery" />
      {check.hit && <p className="text-meta text-warn">This command matches a high-consequence pattern ({check.pattern}). It runs anyway if you continue.</p>}
    </div>
  )
}
const adb: VerbDialogSpec<AdbValue> = {
  verb: 'adb',
  title: (c) => `Run an adb command on ${n(c)}`,
  submitLabel: (c) => `Run on ${n(c)}`,
  initial: { cmd: '' },
  Fields: AdbFields,
  canSubmit: (v) => v.cmd.trim().length > 0,
  toParams: async (v) => ({ cmd: v.cmd.trim() }),
}

// ---------------------------------------------------------------------------
// 5. Run script
// ---------------------------------------------------------------------------
interface RunScriptValue {
  scriptId: string | null
  params: unknown
  concurrency: number
  order: 'as-listed' | 'random'
  formOk: boolean
}
function RunScriptFields({ value, onChange }: { value: RunScriptValue; onChange: (v: RunScriptValue) => void }) {
  const [scripts, setScripts] = useState<ScriptListItem[] | null>(null)
  useEffect(() => {
    let cancelled = false
    void fetchAllPages<ScriptListItem>('/api/scripts')
      .then((rows) => {
        if (!cancelled) setScripts(rows)
      })
      .catch(() => {
        if (!cancelled) setScripts([])
      })
    return () => {
      cancelled = true
    }
  }, [])

  const selected = scripts?.find((s) => s.id === value.scriptId) ?? null

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label>Script</Label>
        {/*
          The script palette (plan 310 §3.1, §4.3), not a `Combobox` over a
          flat list: a farm's plugins publish dozens of scripts (23 on the
          owner's own farm the day this changed), and the owner's own
          research called the flat dropdown bad UX. Page one browses by
          plugin; typing on page one also searches scripts across every
          plugin (plan 310 G2).
        */}
        <ScriptTrigger scripts={scripts} selected={selected} onPick={(s) => onChange({ ...value, scriptId: s.id, params: undefined })} />
      </div>
      {selected?.paramsSchema && (
        // The preset row (plan 311 G1) sits ABOVE the parameter form, never
        // below it and never in a tab (plan 311 §3.2) — keyed on the
        // script's own NAME (`selected.name`), not `selected.id`, so a
        // preset survives every publish (plan 311 §3.1, G6).
        <PresetRow
          kind="script"
          ownerName={selected.name}
          schema={selected.paramsSchema as JsonSchemaNode}
          value={value.params}
          onApply={(params) => onChange({ ...value, params })}
        />
      )}
      {selected?.paramsSchema && (
        <SchemaForm
          schema={selected.paramsSchema as JsonSchemaNode}
          value={value.params}
          onChange={(params) => onChange({ ...value, params })}
          onCanSubmitChange={(ok) => onChange({ ...value, formOk: ok })}
        />
      )}
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="run-script-concurrency">Concurrency</Label>
          <Select value={String(value.concurrency)} onValueChange={(v) => onChange({ ...value, concurrency: Number(v) })}>
            <SelectTrigger id="run-script-concurrency" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {[0, 1, 2, 4, 8].map((c) => (
                <SelectItem key={c} value={String(c)}>
                  {c === 0 ? 'Unlimited' : c}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="run-script-order">Order</Label>
          <Select value={value.order} onValueChange={(v) => onChange({ ...value, order: v as RunScriptValue['order'] })}>
            <SelectTrigger id="run-script-order" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="as-listed">As listed</SelectItem>
              <SelectItem value="random">Random</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
    </div>
  )
}
const runScript: VerbDialogSpec<RunScriptValue> = {
  verb: 'run-script',
  title: (c) => `Run a script on ${n(c)}`,
  submitLabel: (c) => `Run on ${n(c)}`,
  initial: { scriptId: null, params: undefined, concurrency: 0, order: 'as-listed', formOk: true },
  Fields: RunScriptFields,
  canSubmit: (v) => Boolean(v.scriptId) && v.formOk,
  toParams: async (v) => ({ scriptId: v.scriptId, params: v.params, concurrency: v.concurrency, order: v.order }),
  onDone: (res) => {
    if (res.results.length === 1 && res.results[0]?.jobId) {
      window.location.assign(jobHref(res.results[0].jobId))
    }
  },
}

// ---------------------------------------------------------------------------
// 5b. Run workflow (plan 217 §3.5, §4.11 — additive to plan 216's registry:
// the handoff's Workflows card requires a Run link and no other plan builds
// one; `ActionDialog.tsx`, `useTarget` and `DevicePicker` are reused
// unchanged, generic over `spec.verb`.)
// ---------------------------------------------------------------------------
interface RunWorkflowValue {
  workflowName: string
  params: unknown
}
function RunWorkflowFields({ value, onChange }: { value: RunWorkflowValue; onChange: (v: RunWorkflowValue) => void }) {
  const [workflows, setWorkflows] = useState<WorkflowInfo[]>([])
  useEffect(() => {
    void listWorkflows().then(setWorkflows)
  }, [])
  const doc = workflows.find((w) => w.name === value.workflowName)?.doc ?? null
  const schema = doc ? compileWorkflowParams(doc.params) : null
  return (
    <div className="space-y-3">
      {/* Skipped when `value.workflowName` already came from `prefill` (the
          Workflows card's Run link always supplies it), mirroring
          `run-script`'s own "skip the Select when the caller locked it"
          rule. Rendered only as a fallback for a future entry point that
          opens this dialog with no workflow chosen. */}
      {!value.workflowName && (
        <div className="space-y-1.5">
          <Label htmlFor="run-workflow-select">Workflow</Label>
          <Combobox
            ariaLabel="Workflow"
            value={value.workflowName}
            onValueChange={(name) => onChange({ workflowName: name, params: undefined })}
            options={workflows.map((w) => ({ value: w.name, label: w.name }))}
            placeholder="Choose a workflow"
            searchPlaceholder="Filter workflows…"
            emptyText="No workflow matches."
            triggerClassName="w-full"
          />
        </div>
      )}
      {schema ? (
        <>
          {/* The preset row (plan 311 G1, §4.3) — between the workflow
              trigger and its params form, keyed on the workflow's own NAME. */}
          <PresetRow
            kind="workflow"
            ownerName={value.workflowName}
            schema={schema as JsonSchemaNode}
            value={value.params}
            onApply={(params) => onChange({ ...value, params })}
          />
          <SchemaForm schema={schema as JsonSchemaNode} value={value.params} onChange={(params) => onChange({ ...value, params })} />
        </>
      ) : (
        <p className="text-body text-dim">This workflow takes no parameters.</p>
      )}
    </div>
  )
}
const runWorkflow: VerbDialogSpec<RunWorkflowValue> = {
  verb: 'run-workflow',
  title: (c) => `Run a workflow on ${n(c)}`,
  submitLabel: (c) => `Run on ${n(c)}`,
  initial: { workflowName: '', params: undefined },
  Fields: RunWorkflowFields,
  canSubmit: (v) => Boolean(v.workflowName),
  toParams: async (v) => ({ workflowName: v.workflowName, params: v.params }),
  onDone: (res) => {
    if (res.results.length === 1 && res.results[0]?.jobId) {
      window.location.assign(`/jobs/detail?id=${res.results[0].jobId}`)
    }
  },
}

// ---------------------------------------------------------------------------
// 6. Screenshot
// ---------------------------------------------------------------------------
const screenshot: VerbDialogSpec<Record<string, never>> = {
  verb: 'screenshot',
  title: (c) => `Capture ${n(c)} screenshot${c === 1 ? '' : 's'}`,
  submitLabel: (c) => `Capture ${n(c)} screenshot${c === 1 ? '' : 's'}`,
  initial: {},
  Fields: null,
  canSubmit: () => true,
  toParams: async () => ({}),
}

// ---------------------------------------------------------------------------
// 7. Sleep
// ---------------------------------------------------------------------------
const sleep: VerbDialogSpec<Record<string, never>> = {
  verb: 'sleep',
  immediate: true,
  title: (c) => `Sleep ${n(c)}`,
  submitLabel: (c) => `Sleep ${n(c)}`,
  initial: {},
  Fields: null,
  note: 'The session stays up; the screen goes dark and the tile shows it asleep.',
  canSubmit: () => true,
  toParams: async () => ({}),
}

// ---------------------------------------------------------------------------
// 7b. Wake
// ---------------------------------------------------------------------------
/**
 * Sleep's twin, and it had none: `wake` has been an action verb since plan
 * 207 with a working implementation behind it, and no menu row or dialog in
 * Studio — so a device an operator put to sleep could only be woken by
 * touching it (owner, 2026-09-05). On a farm phone in a sealed box that is
 * not a workaround, it is a dead end.
 */
const wake: VerbDialogSpec<Record<string, never>> = {
  verb: 'wake',
  immediate: true,
  title: (c) => `Wake ${n(c)}`,
  submitLabel: (c) => `Wake ${n(c)}`,
  initial: {},
  Fields: null,
  note: 'Lights the screen and holds it on. Refused for a device that is offline or quarantined — there is nothing to wake.',
  canSubmit: () => true,
  toParams: async () => ({}),
}

// ---------------------------------------------------------------------------
// 8. Move group
// ---------------------------------------------------------------------------
interface SetGroupValue {
  groupId: string | null
}
function SetGroupFields({ value, onChange, target }: { value: SetGroupValue; onChange: (v: SetGroupValue) => void; target: TargetState }) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor="move-group-select">Group</Label>
      <Select value={value.groupId ?? '__none__'} onValueChange={(v) => onChange({ groupId: v === '__none__' ? null : v })}>
        <SelectTrigger id="move-group-select" className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="__none__">No group</SelectItem>
          {target.groups.map((g) => (
            <SelectItem key={g.id} value={g.id}>
              {g.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}
const setGroup: VerbDialogSpec<SetGroupValue> = {
  verb: 'set-group',
  title: (c) => `Move ${n(c)}`,
  submitLabel: (c) => `Move ${n(c)}`,
  initial: { groupId: null },
  Fields: SetGroupFields,
  canSubmit: () => true,
  toParams: async (v) => ({ groupId: v.groupId }),
}

// ---------------------------------------------------------------------------
// 9. Upload file
// ---------------------------------------------------------------------------
interface PushValue {
  source: ArtifactSource | null
  remotePath: string
  mediaScan: 'auto' | 'always' | 'never'
}
function PushFields({ value, onChange }: { value: PushValue; onChange: (v: PushValue) => void }) {
  return (
    <div className="space-y-3">
      <ArtifactPicker value={value.source} onChange={(source) => onChange({ ...value, source })} />
      <div className="space-y-1.5">
        <Label htmlFor="push-remote-path">Remote path</Label>
        <Input id="push-remote-path" mono value={value.remotePath} onChange={(e) => onChange({ ...value, remotePath: e.target.value })} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="push-media-scan">Media scan</Label>
        <Select value={value.mediaScan} onValueChange={(v) => onChange({ ...value, mediaScan: v as PushValue['mediaScan'] })}>
          <SelectTrigger id="push-media-scan" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="auto">Auto</SelectItem>
            <SelectItem value="always">Always</SelectItem>
            <SelectItem value="never">Never</SelectItem>
          </SelectContent>
        </Select>
      </div>
    </div>
  )
}
const push: VerbDialogSpec<PushValue> = {
  verb: 'push',
  title: (c) => `Upload a file to ${n(c)}`,
  submitLabel: (c) => `Upload to ${n(c)}`,
  initial: { source: null, remotePath: '/sdcard/Download/', mediaScan: 'auto' },
  Fields: PushFields,
  canSubmit: (v) => v.source !== null && v.remotePath.trim().length > 0,
  toParams: async (v) => {
    if (!v.source) throw new Error('choose a file first')
    const artifactId = await uploadArtifactSource(v.source)
    return { artifactId, remotePath: v.remotePath.trim(), mediaScan: v.mediaScan }
  },
}

// ---------------------------------------------------------------------------
// 9b. Download file
// ---------------------------------------------------------------------------
interface PullValue {
  remotePath: string
}
function PullFields({ value, onChange }: { value: PullValue; onChange: (v: PullValue) => void }) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor="pull-remote-path">Path on the device</Label>
      <Input
        id="pull-remote-path"
        mono
        value={value.remotePath}
        onChange={(e) => onChange({ remotePath: e.target.value })}
        placeholder="/sdcard/Download/report.csv"
      />
      <p className="text-meta text-faint">
        Lands in this device&apos;s artifacts, one file per device — not in your browser&apos;s downloads. Run it across
        twenty phones and you get twenty artifacts, each named for the phone it came off.
      </p>
    </div>
  )
}
const pull: VerbDialogSpec<PullValue> = {
  verb: 'pull',
  title: (c) => `Download a file from ${n(c)}`,
  submitLabel: (c) => `Download from ${n(c)}`,
  initial: { remotePath: '/sdcard/Download/' },
  Fields: PullFields,
  canSubmit: (v) => v.remotePath.trim().length > 0,
  toParams: async (v) => ({ remotePath: v.remotePath.trim() }),
}

// ---------------------------------------------------------------------------
// 10. Clear cache
// ---------------------------------------------------------------------------
interface ClearCacheValue {
  pkg: string
}
function ClearCacheFields({ value, onChange }: { value: ClearCacheValue; onChange: (v: ClearCacheValue) => void }) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor="clear-cache-package">Package</Label>
      <Input id="clear-cache-package" mono value={value.pkg} maxLength={256} onChange={(e) => onChange({ pkg: e.target.value })} placeholder="com.example.app" />
    </div>
  )
}
const clearCache: VerbDialogSpec<ClearCacheValue> = {
  verb: 'clear-cache',
  title: (c) => `Clear cache on ${n(c)}`,
  submitLabel: (c) => `Clear cache on ${n(c)}`,
  initial: { pkg: '' },
  Fields: ClearCacheFields,
  canSubmit: (v) => v.pkg.trim().length > 0,
  toParams: async (v) => ({ package: v.pkg.trim() }),
}

// ---------------------------------------------------------------------------
// 11. Settings
// ---------------------------------------------------------------------------
interface SettingsValue {
  schema: JsonSchemaNode | null
  seed: Record<string, unknown>
  draft: Record<string, unknown>
  formOk: boolean
  /** Multi-target only: the device the on-screen reference values came from, for the sentence under the form. */
  referenceLabel?: string
  /** The open section of the left-hand nav. Undefined means the first one. */
  section?: string
}

/**
 * Annotate a device-settings schema with one device's CURRENT values, as
 * per-field hints.
 *
 * Bulk settings sends a DIFF — only the fields you actually touched — so the
 * form is seeded empty when more than one device is targeted, and that is
 * what keeps "what I touched is what changed" true. But an empty form gives
 * an operator no idea what they are changing FROM (CEO, 2026-09-04).
 *
 * Seeding the form from one device would answer that and introduce a worse
 * problem: the form would present ONE phone's values as the selection's, and
 * on a farm that is not uniform an operator would read `transport: adb-usb`
 * and believe it of twenty devices. So the values ride in as hints instead —
 * visible, attributed to the device they came from, and never mistaken for
 * the field's value, because the field is still visibly empty.
 *
 * Reuses `x-enkaku.hint` (plan 212 §4.2, threaded to the controls by plan
 * 219 §4.9) rather than adding a rendering path.
 */
function withValueHints(node: JsonSchemaNode, values: unknown): JsonSchemaNode {
  if (!node || typeof node !== 'object') return node
  const props = (node as { properties?: Record<string, JsonSchemaNode> }).properties
  if (!props || typeof values !== 'object' || values === null) return node
  const next: Record<string, JsonSchemaNode> = {}
  for (const [key, child] of Object.entries(props)) {
    const value = (values as Record<string, unknown>)[key]
    if (value !== undefined && child && typeof child === 'object' && (child as { properties?: unknown }).properties) {
      next[key] = withValueHints(child, value)
      continue
    }
    if (value === undefined || typeof value === 'object') {
      next[key] = child
      continue
    }
    const meta = ((child as Record<string, unknown>)['x-enkaku'] ?? {}) as Record<string, unknown>
    next[key] = { ...child, 'x-enkaku': { ...meta, hint: `currently ${String(value)}` } } as JsonSchemaNode
  }
  return { ...node, properties: next } as JsonSchemaNode
}
function diffPatch(seed: Record<string, unknown>, draft: Record<string, unknown>): DeviceSettingsPatch {
  const patch: Record<string, unknown> = {}
  for (const key of Object.keys(draft)) {
    const seedBlock = (seed[key] ?? {}) as Record<string, unknown>
    const draftBlock = (draft[key] ?? {}) as Record<string, unknown>
    if (typeof draftBlock !== 'object' || draftBlock === null) continue
    const blockPatch: Record<string, unknown> = {}
    for (const field of Object.keys(draftBlock)) {
      if (JSON.stringify(draftBlock[field]) !== JSON.stringify(seedBlock[field])) blockPatch[field] = draftBlock[field]
    }
    if (Object.keys(blockPatch).length > 0) patch[key] = blockPatch
  }
  return patch as DeviceSettingsPatch
}
function SettingsFields({ value, onChange, target }: { value: SettingsValue; onChange: (v: SettingsValue) => void; target: TargetState }) {
  /**
   * Seed only once the picker has actually resolved its target.
   *
   * `target.resolvedIds` filters the chosen ids against the device list the
   * picker fetches, so it is EMPTY for the first render or two. This effect
   * used to run once on mount and decide "one device or many" from that empty
   * list — so a single-device dialog took the multi path, showed schema
   * defaults instead of the phone's own values, and reported "1 setting will
   * be written" before anyone had touched a field (owner, 2026-09-05). The
   * device's stored `input: scrcpy-sdk` rendered as the default
   * `scrcpy-uhid`, which is the kind of wrong that gets APPLIED.
   *
   * `value.schema` still makes it one-shot; the guard just delays the shot
   * until there is something to aim at.
   */
  const resolvedKey = target.resolvedIds.join(',')
  useEffect(() => {
    if (value.schema) return
    if (target.devices.length === 0) return
    let cancelled = false
    // One device: this IS that device's settings screen — seed the form and
    // edit in place. Many: read the FIRST resolved device anyway, not to seed
    // but to show its values as hints (see `withValueHints`).
    const single = target.resolvedIds.length === 1
    const referenceId = target.resolvedIds[0] ?? null
    void Promise.all([
      api('/api/settings', SettingsResponseSchema),
      referenceId ? api(`/api/devices/${referenceId}`, DeviceDetailResponseSchema) : Promise.resolve(null),
    ])
      .then(([settingsRes, deviceRes]) => {
        if (cancelled) return
        const bare = settingsRes.deviceSchema as JsonSchemaNode
        const current = (deviceRes?.device.settings ?? null) as Record<string, unknown> | null
        if (single) {
          const seed = (current ? structuredClone(current) : {}) as Record<string, unknown>
          onChange({ schema: bare, seed, draft: structuredClone(seed), formOk: true })
          return
        }
        onChange({
          schema: current ? withValueHints(bare, current) : bare,
          seed: {},
          draft: {},
          formOk: true,
          ...(deviceRes ? { referenceLabel: deviceRes.device.label } : {}),
        })
      })
      .catch(() => {
        if (!cancelled) onChange({ ...value, schema: {} })
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolvedKey, target.devices.length])

  if (!value.schema) return <p className="text-body text-faint">Loading…</p>

  const patch = diffPatch(value.seed, value.draft)
  const keyCount = Object.keys(patch).length

  /*
   * The same left-hand section nav the Settings page and the Agents Settings
   * tab use (CEO, 2026-09-04). `deviceSections()` derives it from the device
   * schema and was written for exactly this — and had no caller at all: it
   * was built for the old device page's settings tab, which plan 215
   * replaced with this dialog, and the dialog never picked it up. Same
   * orphaning as `AgentAlertChip`.
   *
   * Only the active section's fields are rendered, through `narrowSchema`,
   * so `draft` and the diff still span the WHOLE schema — switching sections
   * never discards what you typed in another one.
   */
  const sections = deviceSections(value.schema)
  const activeId = value.section ?? sections[0]?.id ?? ''
  const active = sections.find((x) => x.id === activeId) ?? sections[0]
  const scoped = active ? narrowSchema(value.schema, active.keys) : value.schema

  return (
    <div className="space-y-3">
      <div className="grid gap-4 sm:grid-cols-[180px_1fr]">
        <SectionNav
          navOnly
          sections={sections.map((x) => ({ id: x.id, title: x.title, render: () => null }))}
          active={activeId}
          onChange={(id) => onChange({ ...value, section: id })}
        />
        <SchemaForm
          schema={scoped}
          value={value.draft}
          onChange={(draft) => onChange({ ...value, draft: draft as Record<string, unknown> })}
          onCanSubmitChange={(ok) => onChange({ ...value, formOk: ok })}
        />
      </div>
      <p className="text-meta text-faint">
        {keyCount} setting{keyCount === 1 ? '' : 's'} will be written to {n(target.count)}. Nothing else changes.
        {value.referenceLabel ? ` The "currently" values below each field are ${value.referenceLabel}'s, not the whole selection's.` : ''}
      </p>
    </div>
  )
}
const settings: VerbDialogSpec<SettingsValue> = {
  verb: 'settings',
  wide: true,
  title: (c) => `Apply settings to ${n(c)}`,
  submitLabel: (c) => `Apply to ${n(c)}`,
  initial: { schema: null, seed: {}, draft: {}, formOk: true },
  Fields: SettingsFields,
  canSubmit: (v) => v.formOk && Object.keys(diffPatch(v.seed, v.draft)).length > 0,
  toParams: async (v) => ({ settings: diffPatch(v.seed, v.draft) }),
}

// ---------------------------------------------------------------------------
// 12. Forget
// ---------------------------------------------------------------------------
interface ForgetValue {
  deleteHistory: boolean
}
function ForgetFields({ value, onChange }: { value: ForgetValue; onChange: (v: ForgetValue) => void }) {
  return (
    <div className="space-y-2">
      <p className="text-body text-dim">Their history stays unless you tick the box. A phone that reconnects appears in Discovered again.</p>
      <label className="flex items-center gap-2 text-row text-text">
        <Checkbox checked={value.deleteHistory} onCheckedChange={(v) => onChange({ deleteHistory: v === true })} />
        Also delete history
      </label>
    </div>
  )
}
const forget: VerbDialogSpec<ForgetValue> = {
  verb: 'forget',
  title: (c) => `Forget ${n(c)}`,
  submitLabel: (c) => `Forget ${n(c)}`,
  destructive: true,
  initial: { deleteHistory: false },
  Fields: ForgetFields,
  canSubmit: () => true,
  toParams: async (v) => ({ deleteHistory: v.deleteHistory }),
}

// ---------------------------------------------------------------------------
// 13. Prepare (overflow)
// ---------------------------------------------------------------------------
interface PrepareValue {
  forceRecheck: boolean
}
function PrepareFields({ value, onChange }: { value: PrepareValue; onChange: (v: PrepareValue) => void }) {
  return (
    <label className="flex items-center gap-2 text-row text-text">
      <Checkbox checked={value.forceRecheck} onCheckedChange={(v) => onChange({ forceRecheck: v === true })} />
      Re-check components that already passed
    </label>
  )
}
const prepare: VerbDialogSpec<PrepareValue> = {
  verb: 'prepare',
  title: (c) => `Prepare ${n(c)}`,
  submitLabel: (c) => `Prepare ${n(c)}`,
  initial: { forceRecheck: false },
  Fields: PrepareFields,
  canSubmit: () => true,
  toParams: async (v) => ({ forceRecheck: v.forceRecheck }),
}

// ---------------------------------------------------------------------------
// 13b. Guest agent, by hand (CEO, 2026-09-04)
// ---------------------------------------------------------------------------
/**
 * Both are confirmations, not forms: neither takes a parameter, and both
 * write to a phone for minutes. The sentences say what the operator is
 * actually buying, because the automatic path already covers the ordinary
 * case and someone reaching here is reaching past it.
 */
const installAgent: VerbDialogSpec<Record<string, never>> = {
  verb: 'install-agent',
  immediate: true,
  title: (c) => `Install the guest agent on ${n(c)}`,
  submitLabel: (c) => `Install on ${n(c)}`,
  initial: {},
  Fields: () => (
    <p className="text-body text-dim">
      Reinstalls the agent even when one is already there, then verifies it. An outdated agent is normally replaced without
      being asked — reach for this when that did not happen: an install that reported success and did not stick, or a locally
      built APK, which carries no version the core can check.
    </p>
  ),
  canSubmit: () => true,
  toParams: async () => ({}),
}
const uninstallAgent: VerbDialogSpec<Record<string, never>> = {
  verb: 'uninstall-agent',
  title: (c) => `Uninstall the guest agent from ${n(c)}`,
  submitLabel: (c) => `Uninstall from ${n(c)}`,
  destructive: true,
  initial: {},
  Fields: () => (
    <p className="text-body text-dim">
      Removes the agent and everything it holds on the phone, including its accessibility grant. Scripts fall back to the
      slower inspector, and network routing through the agent stops. If this farm provisions agents automatically, the next
      pass reinstalls it — turn provisioning off in Settings to keep it gone.
    </p>
  ),
  canSubmit: () => true,
  toParams: async () => ({}),
}

// ---------------------------------------------------------------------------
// 14. Label (overflow)
// ---------------------------------------------------------------------------
const setLabel: VerbDialogSpec<Record<string, never>> = {
  verb: 'set-label',
  title: (c) => `Label ${n(c)}`,
  submitLabel: (c) => `Label ${n(c)}`,
  initial: {},
  Fields: null,
  note: "Writes the device number onto each phone's own screen, using the farm labelling mode.",
  canSubmit: () => true,
  toParams: async () => ({}),
}

// ---------------------------------------------------------------------------
// 15. Network (overflow)
// ---------------------------------------------------------------------------
interface SetNetworkValue {
  op: 'enable' | 'disable' | 'retry' | 'clear'
}
function SetNetworkFields({ value, onChange }: { value: SetNetworkValue; onChange: (v: SetNetworkValue) => void }) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor="set-network-op">Change</Label>
      <Select value={value.op} onValueChange={(v) => onChange({ op: v as SetNetworkValue['op'] })}>
        <SelectTrigger id="set-network-op" className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="enable">Enable</SelectItem>
          <SelectItem value="disable">Disable</SelectItem>
          <SelectItem value="retry">Retry</SelectItem>
          <SelectItem value="clear">Clear</SelectItem>
        </SelectContent>
      </Select>
    </div>
  )
}
const setNetwork: VerbDialogSpec<SetNetworkValue> = {
  verb: 'set-network',
  title: (c) => `Apply a network change to ${n(c)}`,
  submitLabel: (c) => `Apply to ${n(c)}`,
  initial: { op: 'enable' },
  Fields: SetNetworkFields,
  canSubmit: () => true,
  toParams: async (v) => ({ op: v.op }),
}

/**
 * The fifteen verb keys, named explicitly rather than derived with
 * `keyof typeof VERB_DIALOGS`: the registry below is typed
 * `Record<ActionDialogVerb, VerbDialogSpec<any>>` (not `<never>`) because
 * each entry's `initial` field is real data (covariant) while
 * `canSubmit`/`toParams`/`Fields` take `P` as a parameter (contravariant) —
 * no single non-`any` type satisfies both directions at once for a
 * heterogeneous map like this one, and `any` is what already lets
 * `runAction`'s own `params as never` cast (in `ActionDialog.tsx`) stay the
 * ONLY cast this file needs. Deriving the key union from `typeof` on an
 * object whose values are all widened to `any` would just as sily produce
 * `string`, which is why the union is written out instead.
 */
export type ActionDialogVerb =
  | 'reconnect'
  | 'disconnect'
  | 'install'
  | 'adb'
  | 'run-script'
  | 'run-workflow'
  | 'screenshot'
  | 'sleep'
  | 'wake'
  | 'set-group'
  | 'push'
  | 'pull'
  | 'clear-cache'
  | 'settings'
  | 'forget'
  | 'prepare'
  | 'set-label'
  | 'set-network'
  | 'install-agent'
  | 'uninstall-agent'

export const VERB_DIALOGS: Record<ActionDialogVerb, VerbDialogSpec<any>> = {
  reconnect,
  disconnect,
  install,
  adb,
  'run-script': runScript,
  'run-workflow': runWorkflow,
  screenshot,
  sleep,
  wake,
  'set-group': setGroup,
  push,
  pull,
  'clear-cache': clearCache,
  settings,
  forget,
  prepare,
  'set-label': setLabel,
  'install-agent': installAgent,
  'uninstall-agent': uninstallAgent,
  'set-network': setNetwork,
}
