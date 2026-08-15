'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import {
  BatchResponseSchema,
  clampSchema,
  JobCreateResponseSchema,
  ScriptResponseSchema,
  summarizeClamp,
  type BatchInfo,
  type BatchOrder,
  type ClusterInfo,
  type DeviceInfo,
  type JobInfo,
  type RuntimeEnvelope,
  type WorkflowDoc,
} from '@enkaku/protocol'
import { DevicePicker } from '@/components/DevicePicker'
import { ParamSetPicker } from '@/components/ParamSetPicker'
import { RuntimeOverrideSection } from '@/components/schema-form/RuntimeOverrideSection'
import { SchemaForm } from '@/components/schema-form/SchemaForm'
import type { JsonSchemaNode } from '@/components/schema-form/types'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { api, issuesFromError, useAction } from '@/lib/actions'
import { estimateWorkflowDuration, fetchAllPages, type WorkflowDurationEstimate } from '@/lib/api'
import { relativeTime } from '@/lib/format'

export interface ScriptRow {
  id: string
  name: string
  version: string
  paramsSchema: JsonSchemaNode | null
  enabled: boolean
  createdBy?: string | null
  source?: string | null
  createdAt: number | null
  /**
   * Plan 98 §3.1, §4.4, §5 step 98.4 — the script's own declared execution
   * envelope. Optional/`null` for every fixture and every row published
   * before this plan (`GET /api/scripts/:id`'s own `ScriptRowSchema.runtime`
   * doc comment). Read by the Script-detail Runtime card (step 98.8) to
   * compute `resolveRuntime`'s origin labels — never by the list page, which
   * never fetches it (`ScriptListItemSchema` omits it server-side already).
   */
  runtime?: RuntimeEnvelope | null
  /**
   * Plan 82 §4.6, step 13 — set by a caller that merges in dev-slot entries
   * (`GET /api/plugins/dev`) alongside the ordinary published list: the
   * owning plugin's id (derived from `name.split('/')[0]` for an ordinary
   * plugin member when the caller does not set it explicitly), and whether
   * this entry is an unpublished dev build. Both undefined for a plain
   * `/api/scripts` row — the common case, and the only one before this
   * plan.
   */
  pluginName?: string | null
  isDev?: boolean
  /**
   * Plan 99 §3.1, §4.11, step 99.10 — `'script'` | `'workflow'`, straight off
   * `scripts.kind`. Optional (not "always present") because several fixtures
   * predate this field — a dev-slot row (`device/page.tsx`'s `devRows`),
   * every existing test fixture in this file, and any other caller not yet
   * updated to pass it through — and every one of those is an ordinary
   * script, never a workflow, so `?? 'script'` is the correct default
   * everywhere this field is read, not merely a safe one.
   *
   * This is one of only FOUR places in the repo allowed to compare
   * `kind === 'workflow'` (plan 99 §3.1's containment claim, amended to name
   * this file explicitly) — the run dialog's own Workflow | Script filter.
   */
  kind?: 'script' | 'workflow'
}

type Target = 'single' | 'cluster' | 'devices'
type Kind = 'script' | 'workflow'

/** `ms` rounded to the nearest whole minute, then to "N min" or "H h M m" — the format the consequence sentence's "up to about" duration estimate uses (plan 99 §3.11, §4.11). Never below 1 min for a positive `ms`, so a short node timeout does not print "0 min". */
function formatMsRough(ms: number): string {
  const totalMin = Math.max(1, Math.round(ms / 60_000))
  if (totalMin < 60) return `${totalMin} min`
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  return m === 0 ? `${h} h` : `${h} h ${m} m`
}

/**
 * Plan 94 §3.6, §4.10, §9 Q4, step 94.10. The Repeat section's own draft —
 * count, the per-repetition interval range and the fleet stagger, all in
 * whole SECONDS in the UI (the wire's `pacing` block on `POST /api/batches`
 * wants milliseconds; §4.9's own shape: `count`, `intervalMs: [min,max]`,
 * `deviceIntervalMs`). Kept as one object so every place that needs "the
 * numbers the pacer will actually use" — the consequence sentence, the
 * finish-time estimate, the continuous-duty warning, and the POST body
 * itself — reads the SAME four fields rather than four independent
 * re-derivations (the "must come from the same numbers the pacer actually
 * uses" instruction this step was given).
 */
interface RepeatDraft {
  count: number
  intervalMinSec: number
  intervalMaxSec: number
  deviceIntervalSec: number
}

const REPEAT_DEFAULT: RepeatDraft = { count: 1, intervalMinSec: 0, intervalMaxSec: 0, deviceIntervalSec: 0 }

/** True the moment any field departs from "one repetition, no delay, no
 *  stagger" — exactly the condition `POST /api/batches`'s own `pacing`
 *  block being absent/present controls (§4.9: "Absent means today's
 *  behaviour exactly"). */
function isPacingDraft(r: RepeatDraft): boolean {
  return r.count > 1 || r.intervalMinSec > 0 || r.intervalMaxSec > 0 || r.deviceIntervalSec > 0
}

/** A whole-second duration, compactly — `45 s`, `5 min`, `1.5 min`. Never
 *  rounds to a value that would misstate a short gap as "0 min". */
function formatSec(sec: number): string {
  if (sec < 60) return `${sec} s`
  const min = sec / 60
  return `${Number.isInteger(min) ? min : Math.round(min * 10) / 10} min`
}

/** `3–8 min` for a real range, `5 min` when the operator left it a fixed
 *  value (min === max) — never `5–5 min`, which reads like a typo. When both
 *  bounds share one unit (both under a minute, or both a minute or more),
 *  the unit is stated once at the end (`3–8 min`) rather than twice
 *  (`3 min–8 min`) — the same "say it once" rule `formatSec` itself already
 *  follows for a single value. */
function formatSecRange(minSec: number, maxSec: number): string {
  if (minSec === maxSec) return formatSec(minSec)
  const sameUnit = (minSec < 60) === (maxSec < 60)
  if (!sameUnit) return `${formatSec(minSec)}–${formatSec(maxSec)}`
  const [minText, unit] = formatSec(minSec).split(' ')
  const [maxText] = formatSec(maxSec).split(' ')
  return unit ? `${minText}–${maxText} ${unit}` : `${minText}–${maxText}`
}

/**
 * §9 Q4 (decided 2026-08-12): "warn on estimated continuous duty... not on
 * raw count". Both numbers below are the plan's own PROVISIONAL figures —
 * not a farm setting (the brief is explicit: do not invent one here) — and
 * are named as provisional everywhere they reach the screen.
 *
 * The worst case, not the average: a [min,max] interval means SOME drawn
 * gaps could land at `min` even when the operator's midpoint looks restful,
 * so the warning checks whether `min` itself clears the "meaningful rest"
 * floor — the same reasoning a safety check owes over an optimistic one.
 */
const REPEAT_GAP_FLOOR_SEC = 60
const REPEAT_DUTY_WARNING_SEC = 30 * 60

/** The worst-case per-device continuous-duty span this draft could produce:
 *  every one of `count - 1` gaps landing at the drawn minimum, summed —
 *  `0` when the minimum interval already clears the rest floor, since then
 *  no stretch of the run is ever "continuous" by this rule. */
function worstCaseDutySec(r: RepeatDraft): number {
  if (r.intervalMinSec >= REPEAT_GAP_FLOOR_SEC) return 0
  return Math.max(0, r.count - 1) * r.intervalMinSec
}

/**
 * The finish-time estimate — built from the exact same four numbers the
 * pacer itself draws from (§3.8, §4.8's `BatchPacer`), never a separate
 * guess: the AVERAGE of the drawn interval times the repetitions-minus-one
 * gaps on one device, plus the stagger span across the fleet
 * (`(deviceCount - 1) * deviceIntervalSec`, §3.8's "applied once, at a
 * device's first repetition"). This ignores each repetition's own run time,
 * which this dialog has no way to know for a plain script (only a workflow
 * declares node timeouts) — stated as "assuming each run itself is quick"
 * wherever this number is shown, the same honesty §3.8 gives the stagger
 * itself ("a floor, not a promise" — this estimate can only be exceeded by
 * a real run, never beaten).
 */
function estimateFinishSec(r: RepeatDraft, deviceCount: number): number {
  const avgIntervalSec = (r.intervalMinSec + r.intervalMaxSec) / 2
  const perDeviceSpanSec = Math.max(0, r.count - 1) * avgIntervalSec
  const staggerSpanSec = Math.max(0, deviceCount - 1) * r.deviceIntervalSec
  return staggerSpanSec + perDeviceSpanSec
}

/**
 * The per-device half of the consequence sentence's duration estimate (plan
 * 99 §4.11): *"4 nodes, up to about 42 min per device"*. "up to", never
 * "about" alone — the number is an upper bound (the sum of the nodes' own
 * declared timeouts), and presenting an upper bound as a plain estimate
 * would be a lie (§3.11). When NOTHING resolved (`totalMs <= 0`), says so
 * rather than printing "up to about 0 min".
 */
function perDeviceEstimateText(est: WorkflowDurationEstimate): string {
  const nodeWord = `${est.nodeCount} node${est.nodeCount === 1 ? '' : 's'}`
  if (est.totalMs <= 0) return `${nodeWord} — no node declares a timeout, so no duration estimate is possible`
  const suffix = est.unknownNodes.length > 0 ? ' (some node timeouts are undeclared and not counted)' : ''
  return `${nodeWord}, up to about ${formatMsRough(est.totalMs)} per device${suffix}`
}

/**
 * "5 devices, one at a time, in random order — about 5× one run." (plan 20
 * §4.8) — or, for a workflow (plan 99 §4.11), the duration estimate takes
 * over the multiplier: *"4 nodes, up to about 42 min per device — 5 devices,
 * one at a time — up to about 3 h 30 m."* `workflowEstimate` is only ever
 * passed for a `kind: 'workflow'` `chosen` (§4.11's containment: this is the
 * same sanctioned filter file, not a second reader).
 */
/**
 * Plan 94 §4.10 — "extends the existing consequence sentence rather than
 * adding a second one". When `repeat` carries a real pacing draft, the base
 * sentence gains one more clause, ending in the finish-time estimate:
 * *"5 devices, one at a time, in random order × 20 repeats, 3–8 min apart,
 * started 30 s apart — about 2 h 10 m, finishing around 16:45."*
 */
function repeatClause(repeat: RepeatDraft, deviceCount: number): string {
  if (!isPacingDraft(repeat)) return ''
  const parts = [`× ${repeat.count} repeat${repeat.count === 1 ? '' : 's'}`]
  if (repeat.count > 1) parts.push(`${formatSecRange(repeat.intervalMinSec, repeat.intervalMaxSec)} apart`)
  if (deviceCount > 1 && repeat.deviceIntervalSec > 0) parts.push(`started ${formatSec(repeat.deviceIntervalSec)} apart`)
  const totalSec = estimateFinishSec(repeat, deviceCount)
  const finishAt = new Date(Date.now() + totalSec * 1000)
  const finishClock = finishAt.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  return `${parts.join(', ')} — about ${formatMsRough(totalSec * 1000)}, finishing around ${finishClock}`
}

function ConsequenceNote({
  count,
  concurrency,
  order,
  workflowEstimate,
  repeat,
}: {
  count: number
  concurrency: number
  order: BatchOrder
  workflowEstimate?: WorkflowDurationEstimate | null
  /** Plan 94 §4.10 — the Repeat section's draft, or omitted/default for a
   *  plain (unpaced) run, which reproduces today's sentence exactly. */
  repeat?: RepeatDraft
}) {
  if (count === 0) return null
  const shape =
    concurrency === 0
      ? 'all at once'
      : concurrency === 1
        ? `one device at a time, in ${order === 'random' ? 'random' : 'the listed'} order`
        : `${concurrency} devices at a time, in ${order === 'random' ? 'random' : 'the listed'} order`
  const repeatText = repeat ? repeatClause(repeat, count) : ''
  const repeatSuffix = repeatText ? ` ${repeatText}` : ''
  if (workflowEstimate) {
    if (workflowEstimate.totalMs <= 0) {
      return (
        <p className="text-[11.5px] text-fg-muted">
          {perDeviceEstimateText(workflowEstimate)} — {count} device{count === 1 ? '' : 's'}, {shape}
          {repeatSuffix}.
        </p>
      )
    }
    // Concurrency 0 ("all at once") is already bounded by the per-device
    // figure — every device runs in parallel, so a multiplied total would
    // overstate the wall-clock cost, matching the plain (non-workflow)
    // branch below, which likewise omits its own "about Nx" note at
    // concurrency 0.
    const totalNote =
      concurrency === 0
        ? ''
        : ` — up to about ${formatMsRough(workflowEstimate.totalMs * Math.ceil(count / Math.max(concurrency, 1)))}`
    return (
      <p className="text-[11.5px] text-fg-muted">
        {perDeviceEstimateText(workflowEstimate)} — {count} device{count === 1 ? '' : 's'}, {shape}
        {totalNote}
        {repeatSuffix}.
      </p>
    )
  }
  const roughly = repeatText ? '' : concurrency === 0 ? '' : ` — about ${Math.ceil(count / Math.max(concurrency, 1))}× one run`
  return (
    <p className="text-[11.5px] text-fg-muted">
      {count} device{count === 1 ? '' : 's'}, {shape}
      {roughly}
      {repeatSuffix}.
    </p>
  )
}

/**
 * Plan 94 §4.10, §3.6, step 94.10 — the Repeat section. This is the
 * COMPREHENSION TEST's own surface: an operator who has never read plan 94
 * must be able to tell "pause between actions" and "interval between
 * repeats" apart from this section alone. The section's own opening line
 * says so explicitly, naming where the OTHER knob lives (a device's own
 * settings, not this dialog) rather than leaving the distinction implied by
 * two fields sitting near each other.
 */
function RepeatSection({
  repeat,
  onChange,
  showStagger,
  intervalInverted,
  showDutyWarning,
  dutyWarningSec,
}: {
  repeat: RepeatDraft
  onChange: (next: RepeatDraft) => void
  /** Off for a single-device run — a stagger across one device has nothing
   *  to stagger against. */
  showStagger: boolean
  intervalInverted: boolean
  showDutyWarning: boolean
  dutyWarningSec: number
}) {
  return (
    <div className="space-y-2.5 rounded-lg border bg-surface-2/40 p-3">
      <div>
        <p className="text-[12.5px] font-medium">Repeat</p>
        <p className="mt-0.5 text-[11px] leading-relaxed text-fg-muted">
          How many times this run repeats, and how long to wait between whole repetitions — separate from the pause
          BETWEEN ACTIONS inside one run, which lives on the device itself (Device → Settings → Human-like touch).
          Leaving this at 1 repeat behaves exactly as before.
        </p>
      </div>
      <div className={`grid gap-3 ${showStagger ? 'grid-cols-3' : 'grid-cols-2'}`}>
        <div className="space-y-1.5">
          <Label htmlFor="repeat-count" className="text-[12.5px] font-normal">
            Repetitions
          </Label>
          <Input
            id="repeat-count"
            type="number"
            min={1}
            max={1000}
            value={repeat.count}
            onChange={(e) => onChange({ ...repeat, count: Math.max(1, Number.parseInt(e.target.value, 10) || 1) })}
            className="readout h-8 text-[12.5px]"
          />
        </div>
        <div className="space-y-1.5">
          <Label className="text-[12.5px] font-normal">Interval (s, min–max)</Label>
          <div className="flex items-center gap-1.5">
            <Input
              type="number"
              min={0}
              aria-label="Interval minimum (seconds)"
              value={repeat.intervalMinSec}
              onChange={(e) => onChange({ ...repeat, intervalMinSec: Math.max(0, Number.parseInt(e.target.value, 10) || 0) })}
              className="readout h-8 text-[12.5px]"
            />
            <span className="text-fg-subtle">–</span>
            <Input
              type="number"
              min={0}
              aria-label="Interval maximum (seconds)"
              value={repeat.intervalMaxSec}
              onChange={(e) => onChange({ ...repeat, intervalMaxSec: Math.max(0, Number.parseInt(e.target.value, 10) || 0) })}
              className="readout h-8 text-[12.5px]"
            />
          </div>
        </div>
        {showStagger && (
          <div className="space-y-1.5">
            <Label htmlFor="repeat-stagger" className="text-[12.5px] font-normal">
              Stagger across devices (s)
            </Label>
            <Input
              id="repeat-stagger"
              type="number"
              min={0}
              value={repeat.deviceIntervalSec}
              onChange={(e) => onChange({ ...repeat, deviceIntervalSec: Math.max(0, Number.parseInt(e.target.value, 10) || 0) })}
              className="readout h-8 text-[12.5px]"
            />
          </div>
        )}
      </div>
      {intervalInverted && (
        <p className="text-[11.5px] text-led-danger">The interval's minimum is greater than its maximum.</p>
      )}
      {/* §9 Q4 — non-blocking, and named as an estimate against a provisional
          threshold, never a hard rule this dialog enforces. */}
      {showDutyWarning && (
        <p className="rounded border border-led-warn/30 bg-led-warn/5 px-2.5 py-2 text-[11.5px] leading-relaxed text-led-warn">
          At the shortest interval this could draw, a device would run for about {formatMsRough(dutyWarningSec * 1000)} with
          no meaningful gap — worth a second look for battery and heat (this threshold is a provisional starting point,
          not a hard limit).
        </p>
      )}
    </div>
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
interface NameGroup {
  name: string
  versions: ScriptRow[]
  /** The owning plugin's id — explicit on a `versions[0].pluginName`, else derived from a `<plugin>/<script>` name (plan 82 §4.2's own naming rule); null for a standalone script. */
  pluginName: string | null
  /** True when EVERY version in this group is a dev entry — a group never mixes a published and a dev row under the same exact name/version, so "any" and "every" agree here. */
  isDev: boolean
}

function groupByName(scripts: ScriptRow[]): NameGroup[] {
  const byName = new Map<string, ScriptRow[]>()
  for (const s of scripts) byName.set(s.name, [...(byName.get(s.name) ?? []), s])
  return [...byName.entries()]
    .map(([name, versions]) => {
      const sorted = versions.sort(byVersionDesc)
      const first = sorted[0]
      const pluginName = first?.pluginName ?? (name.includes('/') ? (name.split('/')[0] ?? null) : null)
      return { name, versions: sorted, pluginName, isDev: sorted.every((v) => v.isDev) }
    })
    .sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Plan 82 §4.6, step 13 — "RunScriptDialog groups scripts by plugin and
 * marks dev entries." `groupByName`'s own output is already sorted by full
 * name, which means every group sharing one plugin (`tiktok/login`,
 * `tiktok/warmup`) is already CONSECUTIVE (they share the literal
 * `tiktok/` prefix) — so this only needs to bucket adjacent same-plugin
 * runs under one heading, the same "consecutive run" trick
 * `SectionNav.tsx`'s grouping already uses. A standalone script (no
 * plugin) gets no heading, rendered exactly as it always was.
 */
function groupByPlugin(groups: NameGroup[]): Array<{ pluginName: string | null; items: NameGroup[] }> {
  const runs: Array<{ pluginName: string | null; items: NameGroup[] }> = []
  for (const g of groups) {
    const last = runs[runs.length - 1]
    if (last && last.pluginName === g.pluginName) last.items.push(g)
    else runs.push({ pluginName: g.pluginName, items: [g] })
  }
  return runs
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
  // The Workflow | Script segmented filter (plan 99 §4.11, step 99.10) — the
  // sanctioned `kind === 'workflow'` comparison this file is one of only
  // four places allowed to make (§3.1's containment claim). Default
  // `'script'`: unchanged behaviour for every caller until an operator
  // deliberately switches, since that was the only kind this dialog could
  // run before this plan.
  const [kindFilter, setKindFilter] = useState<Kind>('script')
  // When `scripts` is supplied the dialog owns the choice; otherwise `script`
  // decides and these stay unused. Filtered by `kindFilter` BEFORE grouping,
  // so a stale `pickedId` from the other kind can never resolve `chosen`
  // below (a script published before `kind` existed reads `undefined`, which
  // is a `'script'`, never a `'workflow'` — no back-published row is ever
  // secretly a pipeline).
  const filteredScripts = (scripts ?? []).filter((s) => (s.kind ?? 'script') === kindFilter)
  const groups = groupByName(filteredScripts)
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
  // Plan 94 §3.6, §4.10, step 94.10 — the Repeat section (F33's own dialog,
  // extended). Available for every target, including a single device: §3.6
  // "the run dialog creates a batch the moment count > 1 or more than one
  // device is targeted" — a single device with a real repeat draft is ALSO
  // the moment a plain `POST /api/jobs` stops being enough.
  const [repeat, setRepeat] = useState<RepeatDraft>(REPEAT_DEFAULT)
  // Plan 94 §4.10, §9 Q4 — required only for a run that targets the WHOLE
  // farm's currently-usable devices, never for an ordinary multi-device
  // pick (the brief's own "not every run" instruction). Reset whenever the
  // target composition changes so a stale confirmation can never survive a
  // target switch.
  const [fleetConfirm, setFleetConfirm] = useState('')
  const [params, setParams] = useState<unknown>(undefined)
  // Plan 98 §3.9 item 2, §5 step 98.8 — the collapsed Runtime section's own
  // value, kept separate from `params`: params belong to the script author,
  // the envelope belongs to the core (§3.9's own reasoning for never
  // merging the two schemas). Reset on every script/version/kind switch,
  // exactly like `params` right above — a timeout override typed for one
  // script must never silently ride along onto a different one.
  const [runtimeOverride, setRuntimeOverride] = useState<unknown>(undefined)
  // Plan 95 §3.7, §4.3, §5 step 95.6 (fixes F12, F14) — `serverErrors` maps
  // straight onto `SchemaForm`; `formCanSubmit` is the callback's mirror,
  // ANDed into the Run button below so a form the server just rejected (or
  // one the client already knows is invalid) cannot be resubmitted as-is.
  const [serverIssues, setServerIssues] = useState<Record<string, string> | undefined>(undefined)
  const [formCanSubmit, setFormCanSubmit] = useState(true)
  const { run, isPending } = useAction()
  const router = useRouter()

  // Two different questions, deliberately not one set:
  //
  //   `usable`   — can this device be GIVEN a job at all? Only `quarantined`
  //                cannot: `createJobStore.enqueue` rejects that one status
  //                and nothing else, and `claimNext` holds every other job
  //                until its device reaches `idle` on its own. An offline
  //                phone therefore takes a job perfectly well; it just runs
  //                it later. This is the honest denominator for the
  //                fleet-wide warning below — targeting ten phones of which
  //                six are asleep is still targeting ten phones.
  //
  //   `readyNow` — could this device start IMMEDIATELY? Used only to pick
  //                the dialog's default, because opening on a phone that
  //                cannot start for hours is a worse default than opening on
  //                one that starts at once, even though both are legal picks.
  //
  // Quarantined devices still appear in the picker, disabled, with the reason
  // (plan 19 §3.2) — never silently removed.
  const usable = devices.filter((d) => d.status !== 'quarantined')
  const readyNow = usable.filter((d) => d.status !== 'offline')

  // Preselect the newest version of the first script IN THE CURRENT FILTER.
  // A picker that opens on nothing makes the operator do work the screen
  // could have done.
  useEffect(() => {
    if (!scripts || filteredScripts.length === 0 || pickedId) return
    const first = groupByName(filteredScripts)[0]
    if (!first?.versions[0]) return
    setPickedName(first.name)
    setPickedId(first.versions[0].id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scripts])

  // Switching Workflow | Script always re-picks — unlike the mount-only
  // effect above, this one is NOT guarded by `pickedId`: a script picked
  // under the old filter is never a legal pick under the new one (a
  // `<Select>` bound to a name the current `groups` no longer lists would
  // otherwise show a blank placeholder while `chosen` quietly fell back to
  // `groups[0]` below — a picker that looks empty while a run is actually
  // armed on something else). Resets params too, the same reason a script or
  // version change already does: a workflow's compiled params schema and a
  // plain script's are never the same shape.
  useEffect(() => {
    if (!scripts) return
    const first = groups[0]
    setPickedName(first?.name ?? '')
    setPickedId(first?.versions[0]?.id ?? '')
    setParams(undefined)
    setRuntimeOverride(undefined)
    setServerIssues(undefined)
    setFormCanSubmit(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kindFilter])

  // A typed fleet-wide confirmation (below) belongs to ONE specific
  // selection — switching target, cluster or device list must not leave a
  // stale confirmation valid for whatever the operator picks next.
  useEffect(() => {
    setFleetConfirm('')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, clusterId, deviceIds.length])

  useEffect(() => {
    if (!script && !scripts) return
    void fetchAllPages<ClusterInfo>('/api/clusters')
      .then(setClusters)
      .catch(() => setClusters([]))
  }, [script])

  useEffect(() => {
    if (!script && !scripts) return
    setParams(undefined)
    setRuntimeOverride(undefined)
    setServerIssues(undefined)
    // A script with no `paramsSchema` never mounts `SchemaForm`, which would
    // otherwise leave a PREVIOUS script's `false` stuck forever (F14).
    setFormCanSubmit(true)
    setDeviceIds([])
    setConcurrency(0)
    setOrder('as-listed')
    setRepeat(REPEAT_DEFAULT)
    setFleetConfirm('')
    if (initialCluster) {
      setTarget('cluster')
      setClusterId(initialCluster)
    } else {
      setTarget('single')
      // An explicitly-arrived-at device wins even when it is offline — the
      // operator opened this dialog FROM that phone's page, so silently
      // swapping their choice for a different one would be the surprise.
      // Only the fallback prefers a device that can start immediately
      // (`readyNow`), dropping to `usable` when every device is offline, so
      // an all-asleep farm still opens on a real pick instead of a blank.
      setDeviceId(
        initialDevice && usable.some((d) => d.id === initialDevice)
          ? initialDevice
          : (readyNow[0]?.id ?? usable[0]?.id ?? ''),
      )
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [script, scripts, initialDevice, initialCluster, devices.length])

  // Resolved synchronously so the rest of the render never has to ask whether
  // a script exists: the explicit pick, else the newest of the first script
  // IN THE CURRENT FILTER (`filteredScripts`, not the raw `scripts` prop) —
  // a stale `pickedId` belonging to the other kind must never resolve here.
  // The preselect effects above only persist what this already shows, which
  // keeps the first paint and the state in agreement.
  const chosen = script ?? filteredScripts.find((s) => s.id === pickedId) ?? groups[0]?.versions[0] ?? null

  // Plan 95 §3.8, §5 step 95.5 — "reject at publish, clamp at render": a
  // schema already sitting in the database from before `checkDeclaredSchema`
  // existed must still render a usable form, never a hang or a mangled
  // page. Called unconditionally (before the `!chosen` early return below)
  // because it is a hook — `clampSchema` is total, so `chosen` being
  // momentarily null just clamps an empty schema to an empty schema.
  const { schema: clampedSchema, clamped } = useMemo(
    () => clampSchema(chosen?.paramsSchema ?? null),
    [chosen?.paramsSchema],
  )

  // The workflow duration estimate (plan 99 §3.11, §4.11) — fetched only for
  // a `kind: 'workflow'` `chosen`, since a plain script has no pipeline to
  // sum. `GET /api/scripts/:id` is the SAME route every other detail read in
  // this codebase uses; its `workflow` field is the parsed `WorkflowDoc`
  // (`packages/protocol/src/api/scripts.ts`'s own doc comment: "present only
  // on GET /:id for a kind: 'workflow' row"). `resolveScriptId` reuses the
  // scripts list this dialog ALREADY loaded (`scripts` prop, unfiltered by
  // kind — a node's own script is always `kind: 'script'`, never a nested
  // workflow, which `E_WORKFLOW_NESTED` already refuses at publish) rather
  // than a second network round trip per node ref.
  const [workflowDoc, setWorkflowDoc] = useState<WorkflowDoc | null>(null)
  const [durationEstimate, setDurationEstimate] = useState<WorkflowDurationEstimate | null>(null)
  useEffect(() => {
    setWorkflowDoc(null)
    setDurationEstimate(null)
    if (!chosen || (chosen.kind ?? 'script') !== 'workflow') return
    let cancelled = false
    void api(`/api/scripts/${chosen.id}`, ScriptResponseSchema)
      .then((b) => {
        if (cancelled) return
        const doc = b.script.workflow ?? null
        setWorkflowDoc(doc)
        if (!doc) return
        const resolveScriptId = (ref: string): string | null => {
          const at = ref.lastIndexOf('@')
          if (at < 0) return null
          const name = ref.slice(0, at)
          const version = ref.slice(at + 1)
          const candidates = (scripts ?? []).filter((s) => s.name === name)
          if (version === 'latest') return [...candidates].sort(byVersionDesc)[0]?.id ?? null
          return candidates.find((s) => s.version === version)?.id ?? null
        }
        void estimateWorkflowDuration(doc, resolveScriptId).then((est) => {
          if (!cancelled) setDurationEstimate(est)
        })
      })
      .catch(() => {
        if (!cancelled) setWorkflowDoc(null)
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chosen?.id, chosen?.kind])

  if (!chosen) {
    // Not "no script yet" — nothing in the CURRENT filter, or nothing at all.
    if (!scripts) return null
    const nothingPublished = scripts.length === 0
    return (
      <Dialog open onOpenChange={(v) => !v && onClose()}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Run a script</DialogTitle>
            <DialogDescription>
              {nothingPublished
                ? 'Nothing is published to this farm yet.'
                : kindFilter === 'workflow'
                  ? 'No workflow is published to this farm yet.'
                  : 'No script is published to this farm yet.'}
            </DialogDescription>
          </DialogHeader>
          {/* Shown even here so switching back to whichever kind DOES have
              something published needs no reopen (plan 99 §4.11: "Choosing
              Workflow with none published shows the empty state and a link
              straight to the editor"). Hidden only when NOTHING at all is
              published — there is nothing to filter between yet. */}
          {!nothingPublished && (
            <Tabs value={kindFilter} onValueChange={(v) => setKindFilter(v as Kind)}>
              <TabsList className="grid w-full grid-cols-2">
                <TabsTrigger value="workflow">Workflow</TabsTrigger>
                <TabsTrigger value="script">Script</TabsTrigger>
              </TabsList>
            </Tabs>
          )}
          <p className="text-[12.5px] leading-relaxed text-fg-muted">
            {kindFilter === 'workflow' ? (
              <>Build one in the workflow editor, then run it from here.</>
            ) : (
              <>
                Publish one with <span className="readout">enkaku publish &lt;script.ts&gt;</span>, then run it from
                here.
              </>
            )}
          </p>
          {kindFilter === 'workflow' && (
            <Button asChild variant="outline" size="sm">
              <Link href="/workflows/editor">Open the workflow editor</Link>
            </Button>
          )}
        </DialogContent>
      </Dialog>
    )
  }

  const targetCount = target === 'cluster' ? (clusters.find((c) => c.id === clusterId)?.usableCount ?? 0) : deviceIds.length
  // Plan 94 §3.6 — a single device is still "one device", but a real repeat
  // draft on it is ALSO a batch (`count > 1` is the trigger, independent of
  // device count). `effectiveDeviceCount` feeds the stagger/finish-time math
  // below with the right denominator either way.
  const effectiveDeviceCount = target === 'single' ? 1 : targetCount
  const pacingActive = isPacingDraft(repeat)
  const intervalInverted = repeat.intervalMinSec > repeat.intervalMaxSec
  // Plan 94 §9 Q4 — "fleet-wide", not "more than one device": every
  // currently-usable device in the farm, matched by count. `usable.length`
  // is already computed above from the SAME status filter the picker itself
  // disables against, so this cannot flag a target the picker would have
  // refused anyway.
  const fleetWide = (target === 'cluster' || target === 'devices') && targetCount > 0 && usable.length > 0 && targetCount >= usable.length
  const fleetConfirmed = !fleetWide || fleetConfirm.trim() === String(targetCount)
  const canSubmit =
    (target === 'single' ? !!deviceId : target === 'cluster' ? !!clusterId && targetCount > 0 : deviceIds.length > 0) &&
    !(pacingActive && intervalInverted) &&
    fleetConfirmed

  // `undefined` (not `{}`) for "the operator touched nothing" — matching
  // `params`'s own `?? {}` convention right below, and keeping an empty
  // Runtime section indistinguishable from one that was never opened.
  const runtimeOverrideBody =
    typeof runtimeOverride === 'object' && runtimeOverride !== null && Object.keys(runtimeOverride).length > 0
      ? runtimeOverride
      : undefined

  // Plan 94 §4.9's exact `pacing` shape (`count`, `intervalMs: [min,max]`,
  // `deviceIntervalMs`) — omitted entirely (not sent as zeros) when the
  // draft is unpaced, so an unpaced run's POST body is byte-identical to
  // before this plan (criterion 16's own Studio-side half).
  const pacingBody = pacingActive
    ? {
        count: repeat.count,
        intervalMs: [repeat.intervalMinSec * 1000, repeat.intervalMaxSec * 1000],
        deviceIntervalMs: repeat.deviceIntervalSec * 1000,
      }
    : undefined

  // Plan 94 §3.6 — "the run dialog creates a batch the moment count > 1 or
  // more than one device is targeted". A single device with no repeat draft
  // keeps the plain `POST /api/jobs` path untouched.
  const useBatch = target !== 'single' || pacingActive

  const runScript = () => {
    setServerIssues(undefined)
    return run<{ job: JobInfo } | { batch: BatchInfo }>(
      'run',
      async () => {
        try {
          return await (!useBatch
            ? api('/api/jobs', JobCreateResponseSchema, {
                method: 'POST',
                // `runtimeOverride` (plan 98 §5 step 98.8) — composed and
                // client-validated here already; the CORE does not accept
                // this field on `POST /api/jobs` yet (`EnqueueBody` in
                // `packages/core/src/api/jobs.ts` has no `runtimeOverride`
                // key), so a Zod object with no `.strict()` silently strips
                // it server-side today. Sent anyway, forward-compatibly:
                // the day that route is extended, no further Studio change
                // is needed. See this plan's own status line for the full
                // accounting of that gap.
                json: { scriptId: chosen.id, deviceId, params: params ?? {}, runtimeOverride: runtimeOverrideBody },
              })
            : api('/api/batches', BatchResponseSchema, {
                method: 'POST',
                json: {
                  scriptId: chosen.id,
                  params: params ?? {},
                  // A single device with a repeat draft has no cluster/list
                  // target of its own — it becomes a one-device batch
                  // (§3.6), which `target: { deviceIds: [...] }` already
                  // expresses with no new wire shape.
                  target: target === 'cluster' ? { clusterId } : { deviceIds: target === 'single' ? [deviceId] : deviceIds },
                  concurrency,
                  order,
                  runtimeOverride: runtimeOverrideBody,
                  pacing: pacingBody,
                },
              }))
        } catch (err) {
          // `invalid_job_params` (plan 95 §3.7, §4.3, fixes F12) — attach the
          // field-level issues to the form; `run()`'s own catch still shows
          // the toast below, so the failure is never silent even before the
          // operator scrolls to the flagged field.
          setServerIssues(issuesFromError(err))
          throw err
        }
      },
      {
        success: !useBatch ? 'Job created' : 'Batch created',
        failure: !useBatch ? 'Could not create the job' : 'Could not create the batch',
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
  }

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            Run {chosen.name}
            <span className="readout ml-1.5 text-[12px] font-normal text-fg-muted">@{chosen.version}</span>
          </DialogTitle>
          <DialogDescription>
            A single device joins its queue directly; a cluster, a device list, or any run set to repeat creates a batch.
          </DialogDescription>
          {/* Provenance (plan 95 §3.8 R6, §5 step 95.5, criterion 18) — "the
              operator can see who published the thing they are about to
              run." `createdBy`/`createdAt` are already on `ScriptRow` from
              `GET /api/scripts`'s list projection; no extra fetch. */}
          <p className="readout text-[11px] text-fg-subtle">
            published by {chosen.createdBy ?? 'an unknown publisher'}
            {chosen.createdAt !== null ? ` · ${relativeTime(chosen.createdAt)}` : ''}
          </p>
        </DialogHeader>

        <div className="space-y-4">
          {/* Workflow | Script (plan 99 §4.11, step 99.10) — a segmented
              filter over the ONE list this dialog already loaded, matching
              F31's "the run dialog is a filter away from supporting
              workflows if they are `scripts` rows" (§3.1). Only shown when
              the dialog owns the choice (`scripts` supplied) — a single
              known `script` (the Scripts pages) has nothing to filter. */}
          {scripts && (
            <Tabs value={kindFilter} onValueChange={(v) => setKindFilter(v as Kind)}>
              <TabsList className="grid w-full grid-cols-2">
                <TabsTrigger value="workflow">Workflow</TabsTrigger>
                <TabsTrigger value="script">Script</TabsTrigger>
              </TabsList>
            </Tabs>
          )}

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
                    setRuntimeOverride(undefined)
                    setServerIssues(undefined)
                    setFormCanSubmit(true)
                  }}
                >
                  <SelectTrigger className="h-9">
                    <SelectValue placeholder="Pick a script" />
                  </SelectTrigger>
                  <SelectContent>
                    {groupByPlugin(groups).map((run, i) =>
                      run.pluginName ? (
                        <SelectGroup key={`${run.pluginName}-${i}`}>
                          <SelectLabel>{run.pluginName}</SelectLabel>
                          {run.items.map((g) => (
                            <SelectItem key={g.name} value={g.name}>
                              {g.name}
                              {g.isDev && (
                                <span className="readout ml-1.5 rounded bg-led-warn/15 px-1 text-[10px] text-led-warn">DEV</span>
                              )}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      ) : (
                        run.items.map((g) => (
                          <SelectItem key={g.name} value={g.name}>
                            {g.name}
                          </SelectItem>
                        ))
                      ),
                    )}
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
                      setRuntimeOverride(undefined)
                      setServerIssues(undefined)
                      setFormCanSubmit(true)
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

          {/* The duration estimate (plan 99 §3.11, §4.11) — only for a
              workflow, and honest about the three states: still resolving,
              nothing declared, or a real "up to about" figure. Placed here
              (right under the picker) so it applies to a SINGLE device too —
              `ConsequenceNote` below only renders for the cluster/devices
              target, and a single-device run deserves the same estimate. */}
          {(chosen.kind ?? 'script') === 'workflow' && (
            <div className="rounded-lg border bg-surface-2/40 px-3 py-2">
              <p className="text-[11.5px] text-fg-muted">
                {durationEstimate
                  ? `${perDeviceEstimateText(durationEstimate)}.`
                  : workflowDoc
                    ? `${workflowDoc.nodes.length} node${workflowDoc.nodes.length === 1 ? '' : 's'} — estimating duration…`
                    : 'Loading the pipeline…'}
              </p>
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

          {/* Plan 94 §3.6 — a single device can repeat too; it just has no
              fleet to stagger across, so `showStagger` is off. */}
          {!locked && target === 'single' && devices.length > 0 && (
            <RepeatSection
              repeat={repeat}
              onChange={setRepeat}
              showStagger={false}
              intervalInverted={intervalInverted}
              showDutyWarning={worstCaseDutySec(repeat) > REPEAT_DUTY_WARNING_SEC}
              dutyWarningSec={worstCaseDutySec(repeat)}
            />
          )}
          {!locked && target === 'single' && pacingActive && (
            <p className="text-[11.5px] text-fg-muted">
              1 device {repeatClause(repeat, effectiveDeviceCount)} — this creates a batch of {repeat.count} jobs, the
              same as any other repeating run.
            </p>
          )}

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
                <ConsequenceNote
                  count={targetCount}
                  concurrency={concurrency}
                  order={order}
                  workflowEstimate={(chosen.kind ?? 'script') === 'workflow' ? durationEstimate : null}
                  repeat={repeat}
                />
              </div>
            </div>
          )}

          {(target === 'cluster' || target === 'devices') && (
            <RepeatSection
              repeat={repeat}
              onChange={setRepeat}
              showStagger={targetCount > 1}
              intervalInverted={intervalInverted}
              showDutyWarning={worstCaseDutySec(repeat) > REPEAT_DUTY_WARNING_SEC}
              dutyWarningSec={worstCaseDutySec(repeat)}
            />
          )}

          {/* Plan 94 §9 Q4 — fleet-wide friction, not per-run friction: only
              when the pick covers every currently-usable device, and it is a
              plain click-through otherwise (the brief's own "not every
              run"). */}
          {fleetWide && (
            <div className="space-y-1.5 rounded-lg border border-led-warn/30 bg-led-warn/5 p-3">
              <p className="text-[12.5px] font-medium text-led-warn">This targets every usable device on the farm</p>
              <p className="text-[11.5px] leading-relaxed text-fg-muted">
                Type <span className="readout">{targetCount}</span> to confirm running on all {targetCount} device
                {targetCount === 1 ? '' : 's'}.
              </p>
              <Input
                value={fleetConfirm}
                onChange={(e) => setFleetConfirm(e.target.value)}
                placeholder={String(targetCount)}
                className="readout h-8 w-24 text-[12.5px]"
                aria-label="Type the device count to confirm"
              />
            </div>
          )}

          {chosen.paramsSchema ? (
            <>
              {/* Plan 95 §3.8, §5 step 95.5 — "silently rendering a mangled
                  form is worse than saying so": one line at the top naming
                  what was clamped, only when something actually was. Every
                  script published through `checkDeclaredSchema` (§4.9) never
                  reaches here — this is the backstop for a schema stored
                  before that check existed. */}
              {clamped.length > 0 && (
                <p className="rounded border border-led-warn/30 bg-led-warn/5 px-2.5 py-2 text-[12px] text-led-warn">
                  {summarizeClamp(clamped)}
                </p>
              )}
              {/* Plan 95 §4.7, §4.8, §5 step 95.8 — a preset is a convenience
                  for FILLING this form: applying one runs `reconcileParams`
                  and reports the outcome in one line, then behaves exactly
                  as if the operator had typed the result in by hand. Keyed
                  on `chosen.name` (not `chosen.id`) — presets belong to the
                  script NAME and outlive any one version. */}
              <ParamSetPicker
                scriptName={chosen.name}
                schema={clampedSchema}
                value={params}
                onApply={(next) => {
                  setParams(next)
                  setServerIssues(undefined)
                }}
              />
              <SchemaForm
                // Keyed on the exact version: a remount guarantees the previous
                // version's answers cannot leak into the next one's fields, even
                // if two versions happen to share a field name.
                key={chosen.id}
                // `clampedSchema`, not `chosen.paramsSchema` directly (plan 95
                // §3.8) — the reconciliation between `@enkaku/protocol`'s
                // `JsonSchemaNode` (a plain index signature) and this
                // package's own, more specific one is the SAME cast
                // `packages/core/src/scripts/routes.ts`'s detail route
                // comment documents for the identical two-parallel-type
                // situation; not a bypass of validation.
                schema={clampedSchema as JsonSchemaNode}
                value={params}
                onChange={setParams}
                serverErrors={serverIssues}
                onCanSubmitChange={setFormCanSubmit}
              />
            </>
          ) : (
            <p className="text-[12px] text-fg-muted">
              This {(chosen.kind ?? 'script') === 'workflow' ? 'workflow' : 'script'} takes no parameters.
            </p>
          )}

          {/* Plan 98 §3.9 item 2, §5 step 98.8 — the collapsed Runtime
              section: a per-job override, separate from the params form
              above (params belong to the script author, the envelope
              belongs to the core — never merged into one schema). */}
          <RuntimeOverrideSection value={runtimeOverride} onChange={setRuntimeOverride} />

          <div className="flex justify-end gap-2 border-t pt-3">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={() => void runScript()} disabled={!canSubmit || !formCanSubmit || isPending('run')}>
              {isPending('run') ? 'Creating…' : !useBatch ? 'Run' : 'Run batch'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
