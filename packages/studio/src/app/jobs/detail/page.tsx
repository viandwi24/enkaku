'use client'

import { Suspense, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { ArrowLeft, ChevronDown, ChevronRight, Download, Hourglass, RotateCcw } from 'lucide-react'
import { z } from 'zod'
import {
  JobAssistsResponseSchema,
  JobCancelResponseSchema,
  JobCreateResponseSchema,
  JobLogsResponseSchema,
  JobResponseSchema,
  RESULT_LIMITS,
  resolveRuntime,
  RuntimeEnvelopeSchema,
  SettingsResponseSchema,
  WorkflowDocSchema,
  type ArtifactInfo,
  type DeviceEvent,
  type GateOutcome,
  type JobInfo,
  type JobNodeStatus,
  type JobSettings,
  type JsonSchemaNode as ProtocolJsonSchemaNode,
  type LeaseHolder,
  type ParamIssue,
  type Predicate,
  type ResultStatus,
  type RuntimeEnvelope,
  type ValueExpr,
  type WorkflowDoc,
  type WorkflowNode,
} from '@enkaku/protocol'
import { JobStatusBadge } from '@/components/StatusBadge'
import { HolderBadge } from '@/components/HolderBadge'
import { EntityTabs } from '@/components/layout/EntityTabs'
import { PageHeader } from '@/components/layout/PageHeader'
import { ResultView } from '@/components/result-view/ResultView'
import type { JsonSchemaNode } from '@/components/schema-form/types'
import { EmptyState, ErrorState, LoadingRows } from '@/components/states'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { api, useAction } from '@/lib/actions'
import { deviceRefLabel, fetchAllPages, fetchDeviceRefs, JobNodesEnvelopeSchema, type DeviceRef, type JobNodeInfo } from '@/lib/api'
import { duration, fileSize, relativeTime } from '@/lib/format'
import { formatResult, isRunnerLog, outcomeLine, producedArtifacts, type JobWithPhase } from '@/lib/jobs'
import { descendantsOf } from '@/lib/job-lineage'
import { useNow } from '@/lib/useNow'
import { coreBase, ws } from '@/lib/ws'
import { cn } from '@/lib/utils'

interface LogLine {
  ts: number
  level: string
  source: string
  msg: string
}

/** `reset` (plan 35 §3.5) is the pre-job device reset — it always runs before `prepare`. */
const PHASES = ['reset', 'prepare', 'run', 'finish'] as const

/**
 * `GET /api/scripts/:id` returns a full `ScriptRowSchema`, but this screen
 * only reads `.script.source`, `.script.workflow` (plan 99 §3.5, §3.7, §4.9,
 * step 99.10 — the parsed `WorkflowDoc`, present only for a `kind:
 * 'workflow'` row) and — plan 98 §3.9 item 4, §5 step 98.8 — `.script.runtime`
 * (the script's own declared envelope, needed to compute the SAME resolved
 * memory ceiling the runner armed this job's first attempt with, F5's own
 * defect closed by step 98.4): a narrower ad-hoc schema, as plan 72's brief
 * for this file allows, rather than importing the wider `ScriptResponseSchema`
 * for three fields. Fetched once per job, off the SAME `job.scriptId` the
 * source fetch below already uses — no second round trip.
 */
const ScriptSourceResponseSchema = z.object({
  script: z.object({
    source: z.string().nullable().optional(),
    workflow: WorkflowDocSchema.nullable().optional(),
    runtime: RuntimeEnvelopeSchema.nullable().optional(),
  }),
})

/**
 * `job_nodes.verdict` (plan 99 §3.7, §4.4, §4.9) — a gate's `PredicateTrace`,
 * typed `unknown` on the wire (`JobNodeInfoSchema.output.verdict`) because
 * `@enkaku/protocol` never declares a Zod schema for it (`workflow-resolve.ts`
 * exports the TYPE only, produced by `evaluatePredicate`, never parsed from
 * external input on that side). Parsed HERE, defensively, rather than
 * `as`-cast — the repo rule for anything crossing the wire (`CLAUDE.md`).
 * Recursive to match `all`/`any`/`not` nesting; a leaf has no `children`.
 */
const PredicateTraceSchema: z.ZodType<{
  op: string
  left?: unknown
  right?: unknown
  leftUnresolved?: string
  rightUnresolved?: string
  value: boolean
  children?: unknown[]
}> = z.lazy(() =>
  z.object({
    op: z.string(),
    left: z.unknown().optional(),
    right: z.unknown().optional(),
    leftUnresolved: z.string().optional(),
    rightUnresolved: z.string().optional(),
    value: z.boolean(),
    children: z.array(PredicateTraceSchema).optional(),
  }),
)
type PredicateTraceLike = z.infer<typeof PredicateTraceSchema>

/** `job.status`'s live `node` block (plan 99 §4.9) — present only once a `kind: 'workflow'` job has pushed at least one live update, kept local (not added to `JobWithPhase`, `lib/jobs.ts`, outside this step's file list) since only this page reads it. */
interface JobNodeLive {
  id: string
  seq: number
  total: number
  kind: 'script' | 'gate'
  script: string | null
  status: JobNodeStatus
}
/**
 * Plan 97 §4.6, step 97.5 — `JobDetailSchema` does not carry these five
 * fields yet: 97.5 (the read paths — `rowToJobDetail`, `GET /api/jobs/:id`)
 * is a SEPARATE, not-yet-landed step of the same plan, owned by a different
 * worker and outside `packages/protocol/**`'s reach for this one (97.6's own
 * brief). Declared locally, all optional, so this file compiles and degrades
 * exactly like today (`resultSchema` reads `undefined`, the `<pre>` fallback
 * below fires) against the CURRENT wire shape, and starts rendering through
 * `ResultView` with no further edit here the moment 97.5 adds the matching
 * keys to `JobDetailSchema` — the field names below are copied verbatim from
 * §4.6's own draft.
 */
type JobWithResultInfo = {
  resultStatus?: ResultStatus | null
  resultBytes?: number | null
  resultIssues?: ParamIssue[] | null
  resultSchema?: ProtocolJsonSchemaNode | null
}
type JobWithNode = JobWithPhase & JobWithResultInfo & { node?: JobNodeLive | null }

/** A human word for a value expression's SOURCE (plan 99 §3.6) — what the gate verdict sentence's "scroll1.videos" half comes from. Never evaluates anything; purely descriptive. */
function describeValueExpr(expr: ValueExpr): string {
  if ('const' in expr) return JSON.stringify(expr.const)
  if ('param' in expr) return `param "${expr.param}"`
  if ('run' in expr) return 'the run summary'
  return expr.path ? `${expr.from}.${expr.path}` : expr.from
}

/** A short, readable rendering of a resolved value (plan 99 §3.7's own example: `videos (12)`). */
function formatValueShort(value: unknown): string {
  if (value === undefined) return '—'
  if (typeof value === 'string') return value.length > 40 ? `${value.slice(0, 40)}…` : value
  try {
    const s = JSON.stringify(value)
    return s.length > 40 ? `${s.slice(0, 40)}…` : s
  } catch {
    return String(value)
  }
}

const OP_WORDS: Record<string, string> = {
  eq: '==',
  ne: '!=',
  lt: '<',
  lte: '<=',
  gt: '>',
  gte: '>=',
  contains: 'contains',
  notContains: 'does not contain',
  startsWith: 'starts with',
  endsWith: 'ends with',
  exists: 'exists',
  notExists: 'does not exist',
  isEmpty: 'is empty',
  notEmpty: 'is not empty',
  length: 'has length',
}

const UNARY_OPS = new Set(['exists', 'notExists', 'isEmpty', 'notEmpty'])

/** One operand of a leaf comparison, rendered as "source (value)" — bare `value` for a `{const}` operand, matching plan 99 §3.7's own example (`scroll1.videos (12) >= 10`, not `10 (10)`). */
function describeOperand(expr: ValueExpr, resolvedValue: unknown, unresolved: string | undefined): string {
  if (unresolved) return `${describeValueExpr(expr)} (unresolved — ${unresolved})`
  if ('const' in expr) return formatValueShort(resolvedValue)
  return `${describeValueExpr(expr)} (${formatValueShort(resolvedValue)})`
}

/** Walks `pred` and `trace` TOGETHER (same shape, by construction — `evaluatePredicate` builds one trace node per predicate node) to render the condition half of the gate verdict sentence. */
function describeCondition(pred: Predicate, trace: PredicateTraceLike): string {
  if ('left' in pred) {
    const left = describeOperand(pred.left, trace.left, trace.leftUnresolved)
    const opWord = OP_WORDS[pred.op] ?? pred.op
    if (UNARY_OPS.has(pred.op)) return `${left} ${opWord}`
    const right = pred.right ? describeOperand(pred.right, trace.right, trace.rightUnresolved) : ''
    return `${left} ${opWord} ${right}`.trim()
  }
  const children = trace.children ?? []
  if ('all' in pred) return `all of (${pred.all.map((p, i) => describeCondition(p, children[i] as PredicateTraceLike)).join('; ')})`
  if ('any' in pred) return `any of (${pred.any.map((p, i) => describeCondition(p, children[i] as PredicateTraceLike)).join('; ')})`
  if ('not' in pred) return `not (${describeCondition(pred.not, children[0] as PredicateTraceLike)})`
  return trace.value ? 'true' : 'false'
}

/** The branch a `GateOutcome` names, in words — the arrow-half of the verdict sentence (plan 99 §3.7). */
function describeOutcome(go: GateOutcome): string {
  if (go.go === 'goto') return `go to "${go.node}"`
  if (go.go === 'stop') return 'stop — the workflow ends here, successfully'
  if (go.go === 'fail') return 'fail — the workflow ends here, failed'
  return 'continue'
}

/**
 * The gate verdict sentence itself (plan 99 §3.7's own example: `enough-videos
 * — scroll1.videos (12) >= 10 → continue`) — built from BOTH the document's
 * `when`/`then`/`else` (so the arrow can name the actual branch, not just
 * true/false) and the row's own persisted `verdict` (`job_nodes.verdict`,
 * the ONLY record of what was actually compared — the document alone cannot
 * say what the values WERE). Degrades to a condition-only sentence, with no
 * arrow, when the document is unavailable (a deleted script row, or a fetch
 * that has not settled yet) — real data either way, never a placeholder.
 */
function gateVerdictSentence(row: JobNodeInfo, docNode: WorkflowNode | null): string | null {
  if (row.kind !== 'gate') return null
  const parsed = PredicateTraceSchema.safeParse(row.output.verdict)
  if (!parsed.success) return docNode ? null : 'verdict not recorded'
  const trace = parsed.data
  if (!docNode || docNode.kind !== 'gate') {
    // No document to read `when`/`then`/`else` from — render what the trace alone can say.
    return `${row.nodeId} — condition ${trace.value ? 'true' : 'false'}`
  }
  const condition = describeCondition(docNode.when, trace)
  const outcome = describeOutcome(trace.value ? docNode.then : docNode.else)
  return `${row.nodeId} — ${condition} → ${outcome}`
}

/** `workflowDoc.nodes[]` keyed by document node id — `null` when the document is unavailable, or the id is not (or no longer) in it. */
function docNodeById(doc: WorkflowDoc | null, nodeId: string): WorkflowNode | null {
  return doc?.nodes.find((n) => n.id === nodeId) ?? null
}

/**
 * `skipped` and `skipped-on-resume` are DIFFERENT facts (plan 99 §3.5's own
 * brief): one node was never reached because a gate branched away; the
 * other was deliberately not re-run because a resume started later in the
 * pipeline. Rendered with different labels AND different tones — `skipped`
 * muted/neutral, `skipped-on-resume` the accent tone (a deliberate,
 * unremarkable choice, never the warning/danger tones a real problem gets).
 */
const NODE_STATUS_LABEL: Record<JobNodeStatus, string> = {
  running: 'running',
  success: 'succeeded',
  failed: 'failed',
  cancelled: 'cancelled',
  skipped: 'skipped',
  'skipped-on-resume': 'carried over',
}

const NODE_STATUS_TONE: Record<JobNodeStatus, string> = {
  running: 'text-led-active border-led-active/35 bg-led-active/10',
  success: 'text-led-ok border-led-ok/35 bg-led-ok/10',
  failed: 'text-led-danger border-led-danger/40 bg-led-danger/10',
  cancelled: 'text-led-warn border-led-warn/35 bg-led-warn/10',
  skipped: 'text-fg-subtle border-line bg-transparent',
  'skipped-on-resume': 'text-accent border-accent/35 bg-accent/10',
}

function NodeStatusChip({ status }: { status: JobNodeStatus }) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10.5px] font-medium leading-none whitespace-nowrap',
        NODE_STATUS_TONE[status],
      )}
    >
      <span className="size-1.5 rounded-full bg-current" aria-hidden />
      {NODE_STATUS_LABEL[status]}
    </span>
  )
}

/**
 * The node timeline (plan 99 §3.5, §3.7, §4.9, §4.11, step 99.10) — one row
 * per `job_nodes` EXECUTION (a loop re-runs a document node, and each pass
 * is its own row here, matching the API's own contract). This is the
 * surface the step's own verifiable result names: reading which node
 * failed and why, without opening the log — each row carries its own
 * status, duration, attempts, gate verdict sentence, and artifacts.
 */
function NodeTimeline({
  nodes,
  workflowDoc,
  finalized,
  artifacts,
  now,
  onResumeClick,
}: {
  nodes: JobNodeInfo[]
  workflowDoc: WorkflowDoc | null
  finalized: boolean
  artifacts: ArtifactInfo[]
  now: number
  onResumeClick: (nodeId: string) => void
}) {
  // `artifacts.nodeId` names the DOCUMENT node, not the specific execution
  // (its own doc comment in `@enkaku/protocol`) — ambiguous only for a
  // looped node, where every pass shares one id. Attributed to that node
  // id's LAST execution here (the most likely "what did this just produce"
  // reading) rather than repeated on every earlier pass.
  const lastSeqForNodeId = new Map<string, number>()
  for (const n of nodes) lastSeqForNodeId.set(n.nodeId, n.seq)
  const artifactsByNodeId = new Map<string, ArtifactInfo[]>()
  for (const a of artifacts) {
    if (!a.nodeId) continue
    artifactsByNodeId.set(a.nodeId, [...(artifactsByNodeId.get(a.nodeId) ?? []), a])
  }

  return (
    <div className="rounded-lg border bg-surface p-4">
      <h2 className="rack-label mb-3">pipeline</h2>
      <ol className="space-y-2">
        {nodes.map((row) => {
          const docNode = docNodeById(workflowDoc, row.nodeId)
          const verdict = gateVerdictSentence(row, docNode)
          const rowArtifacts = row.seq === lastSeqForNodeId.get(row.nodeId) ? (artifactsByNodeId.get(row.nodeId) ?? []) : []
          // `job_node_not_found` refuses only an already-succeeded or
          // never-attempted node (`job-service.ts`'s `resume()`) — but the
          // one status this button must never appear for regardless is
          // `skipped` (a node the cursor never reached at all is not a
          // point ANYTHING can resume from), matching that guard exactly.
          const canResume = finalized && row.status !== 'skipped'
          const elapsed = row.duration.startedAt ? duration(row.duration.startedAt, row.duration.finishedAt, now) : '—'
          return (
            <li key={`${row.nodeId}-${row.seq}`} className="rounded-md border bg-bg p-2.5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="readout text-[11px] text-fg-subtle">#{row.seq + 1}</span>
                <span className="text-[12.5px] font-medium">{row.nodeId}</span>
                <NodeStatusChip status={row.status} />
                {row.kind === 'gate' ? (
                  <span className="readout text-[10.5px] text-fg-subtle">gate</span>
                ) : row.scriptName ? (
                  <span className="readout text-[11px] text-fg-muted">
                    {row.scriptName}@{row.scriptVersion ?? '?'}
                  </span>
                ) : null}
                <span className="readout ml-auto text-[11px] text-fg-subtle">{elapsed}</span>
              </div>

              {row.kind === 'script' && row.attempts.current > 0 && (
                <p className="readout mt-1 text-[10.5px] text-fg-subtle">
                  {row.attempts.current} attempt{row.attempts.current === 1 ? '' : 's'}
                  {row.attempts.total ? ` of ${row.attempts.total}` : ''}
                </p>
              )}

              {/* The gate verdict sentence (plan 99 §3.7's own example:
                  "scroll1.videos (12) >= 10 → continue") — a rendered
                  sentence, not raw JSON. */}
              {verdict && <p className="readout mt-1.5 text-[12px] text-fg-muted">{verdict}</p>}

              {row.status === 'failed' && row.attempts.lastError && (
                <p className="mt-1.5 text-[12px] text-led-danger">{row.attempts.lastError.message}</p>
              )}

              {row.status === 'skipped-on-resume' && (
                <p className="mt-1.5 text-[11.5px] text-fg-subtle">
                  Carried over from an earlier run — not re-executed this time.
                  {row.resumedFromJobId && (
                    <>
                      {' '}
                      <Link href={`/jobs/detail?id=${row.resumedFromJobId}`} className="hover:underline">
                        See the original job
                      </Link>
                      .
                    </>
                  )}
                </p>
              )}
              {row.status === 'skipped' && (
                <p className="mt-1.5 text-[11.5px] text-fg-subtle">Never reached — a gate branched around it.</p>
              )}

              {rowArtifacts.length > 0 && (
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {rowArtifacts.map((a) => (
                    <a
                      key={a.id}
                      href={`${coreBase()}/api/artifacts/${a.id}/content`}
                      target="_blank"
                      rel="noreferrer"
                      className="readout rounded border px-1.5 py-0.5 text-[10.5px] text-fg-muted hover:border-accent hover:text-accent"
                    >
                      {a.label ?? a.kind}
                    </a>
                  ))}
                </div>
              )}

              {canResume && (
                <div className="mt-2 border-t pt-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 text-[11.5px]"
                    onClick={() => onResumeClick(row.nodeId)}
                  >
                    <RotateCcw className="size-3" aria-hidden />
                    Resume from here
                  </Button>
                </div>
              )}
            </li>
          )
        })}
      </ol>
    </div>
  )
}

/**
 * The resume confirmation (plan 99 §3.5, §4.9) — names every node that will
 * NOT run again before the operator confirms, and is careful never to word
 * this as restarting the original job: resume creates a NEW job, and the
 * original is left exactly as it ran.
 */
function ResumeDialog({
  jobId,
  nodeId,
  nodes,
  workflowDoc,
  onClose,
  onResumed,
}: {
  jobId: string
  nodeId: string
  nodes: JobNodeInfo[]
  workflowDoc: WorkflowDoc | null
  onClose: () => void
  onResumed: (newJobId: string) => void
}) {
  const { run, isPending } = useAction()

  // Every doc node BEFORE the resume point, in DOCUMENT order — these are
  // the ones `POST /:id/resume` will write `skipped-on-resume` for (plan 99
  // §3.5). Falls back to this job's own seq-ordered node ids before the
  // resume point when the document itself is unavailable (a deleted script
  // row, or a fetch still in flight) — real data either way, never a
  // placeholder.
  const skippedIds = useMemo(() => {
    if (workflowDoc) {
      const idx = workflowDoc.nodes.findIndex((n) => n.id === nodeId)
      return idx > 0 ? workflowDoc.nodes.slice(0, idx).map((n) => n.id) : []
    }
    const targetSeq = [...nodes].reverse().find((n) => n.nodeId === nodeId)?.seq ?? 0
    const seen = new Set<string>()
    const ids: string[] = []
    for (const n of nodes) {
      if (n.seq >= targetSeq) break
      if (!seen.has(n.nodeId)) {
        seen.add(n.nodeId)
        ids.push(n.nodeId)
      }
    }
    return ids
  }, [workflowDoc, nodes, nodeId])

  const lastRowFor = (id: string) => [...nodes].reverse().find((n) => n.nodeId === id) ?? null

  return (
    <AlertDialog open onOpenChange={(v) => !v && onClose()}>
      <AlertDialogContent size="sm">
        <AlertDialogHeader>
          <AlertDialogTitle>
            Resume from <span className="readout">{nodeId}</span>?
          </AlertDialogTitle>
          <AlertDialogDescription>
            This creates a NEW job that continues from <span className="readout">{nodeId}</span> — the original job
            is untouched and stays in its history exactly as it ran.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {skippedIds.length > 0 && (
          <div className="rounded-md border border-led-warn/35 bg-led-warn/5 p-2.5">
            <p className="rack-label mb-1.5 text-led-warn">
              {skippedIds.length} node{skippedIds.length === 1 ? '' : 's'} will not run again
            </p>
            <ul className="space-y-1">
              {skippedIds.map((id) => {
                const row = lastRowFor(id)
                return (
                  <li key={id} className="text-[12px] text-fg-muted">
                    <span className="readout font-medium">{id}</span>
                    {row
                      ? ` — ${NODE_STATUS_LABEL[row.status]}${row.scriptName ? ` (${row.scriptName}@${row.scriptVersion ?? '?'})` : ''}`
                      : ' — never ran'}
                  </li>
                )
              })}
            </ul>
          </div>
        )}
        <p className="text-[12px] text-fg-muted">
          This device may not be in the state they left it in — nothing that happened on it since is accounted for.
        </p>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={isPending('resume')}
            onClick={() =>
              void run(
                'resume',
                () =>
                  api(`/api/jobs/${jobId}/resume`, JobCreateResponseSchema, {
                    method: 'POST',
                    json: { fromNode: nodeId },
                  }),
                {
                  success: 'Resumed as a new job',
                  failure: 'Could not resume the job',
                  onSuccess: (b) => onResumed(b.job.jobId),
                },
              )
            }
          >
            {isPending('resume') ? 'Resuming…' : 'Resume'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

/** Absolute time, because "5h ago" is useless when comparing two runs. */
function absolute(epochSeconds: number | null): string {
  if (!epochSeconds) return '—'
  return new Date(epochSeconds * 1000).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

function JobDetail() {
  const params = useSearchParams()
  const jobId = params.get('id')
  const tab = params.get('tab') ?? 'summary'

  const [job, setJob] = useState<JobWithNode | null>(null)
  // The device a job ran on may have been forgotten since (plan 47 §3.4) —
  // resolved once the job itself loads, live or deleted either way.
  const [deviceRef, setDeviceRef] = useState<DeviceRef | undefined>(undefined)
  const [liveLogs, setLiveLogs] = useState<LogLine[]>([])
  const [savedLogs, setSavedLogs] = useState<LogLine[] | null>(null)
  // What the job logged BEFORE this page subscribed (`GET /api/jobs/:id/logs`).
  // The third source, and the one that makes a mid-run page useful at all.
  //
  // `null` until the fetch settles, NOT `[]`: the panel's loading state has to
  // distinguish "not asked yet" from "asked, and this job has logged nothing".
  // With `[]` it could not, and a running job sat on "Loading…" forever —
  // `savedLogs` stays null until the job ends, so nothing ever cleared it.
  const [backfillLogs, setBackfillLogs] = useState<LogLine[] | null>(null)
  const [logsTruncated, setLogsTruncated] = useState(false)
  const [artifacts, setArtifacts] = useState<ArtifactInfo[]>([])
  // Lineage (plan 81 §4.5) — `chainNodes` is every OTHER member of this
  // job's trigger chain (`GET /api/jobs?rootJobId=...` excludes the root's
  // own row by design); `rootInfo` is that root's own detail, fetched
  // separately and only when this job is not itself the root. Both start
  // empty/null so a job with no lineage — the common case — renders with
  // nothing extra rather than a loading flicker.
  const [chainNodes, setChainNodes] = useState<JobInfo[]>([])
  const [rootInfo, setRootInfo] = useState<JobInfo | null>(null)
  // Plan 91 §3.5, §4.9 — every non-job input action recorded against this
  // job's device while it ran. Fetched unconditionally, the same "cheap and
  // always fetched" reasoning `chainNodes` above already uses: an
  // un-assisted job (the common case) just gets back an empty array and the
  // "Assisted by" card below stays hidden.
  const [assists, setAssists] = useState<DeviceEvent[]>([])
  const [source, setSource] = useState<string | null | undefined>(undefined)
  // Plan 98 §3.9 item 4, §5 step 98.8 — the Summary tab's "Peak memory" row
  // gains a "/ N limit" half. `scriptRuntime` comes off the SAME `GET
  // /api/scripts/:id` call `source`/`workflowDoc` already make (see
  // `ScriptSourceResponseSchema`'s own doc comment); `farmJobSettings` is
  // fetched once, independently — a job page has no other reason to load
  // farm settings, so this is its own small round trip rather than piggy-
  // backing on an unrelated fetch.
  const [scriptRuntime, setScriptRuntime] = useState<RuntimeEnvelope | null>(null)
  const [farmJobSettings, setFarmJobSettings] = useState<JobSettings | null>(null)
  const [followLog, setFollowLog] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // The crash trace disclosure (plan 37 §4.5) — collapsed by default, fetched lazily on first open.
  const [traceOpen, setTraceOpen] = useState(false)
  const [traceText, setTraceText] = useState<string | null>(null)
  // Waiting for the device to go quiet before claiming it (plan 71 §3.7), OR
  // (plan 94 §3.7, §4.9, F25, step 94.10) waiting on the PACER for its next
  // repetition's drawn delay to elapse — visible, not silent: a wait nobody
  // can see is indistinguishable from a hang. `null` means "not currently
  // waiting" (never started, or already claimed/expired past the cap).
  // `reason` was on the wire since step 94.6 and dropped here until now —
  // named explicitly in this plan's own brief as the gap this step closes.
  const [waiting, setWaiting] = useState<{ heldBy: LeaseHolder | null; remainingSec: number; reason: 'quiet' | 'paced' } | null>(
    null,
  )
  // The node timeline (plan 99 §3.5, §4.9, step 99.10) — `[]`/`false` for
  // every non-workflow job, the same "empty, not missing" convention
  // `assists` above already uses. `workflowDoc` is the parsed pipeline
  // (fetched off the SAME `GET /api/scripts/:id` call `source` already
  // makes), read for the gate verdict sentence's `when`/`then`/`else` and
  // the resume dialog's "what will be skipped" preview — `null` for a
  // non-workflow job, or while it has not resolved yet.
  const [nodes, setNodes] = useState<JobNodeInfo[]>([])
  const [nodesFinalized, setNodesFinalized] = useState(false)
  const [workflowDoc, setWorkflowDoc] = useState<WorkflowDoc | null>(null)
  // "Resume from here" (plan 99 §3.5, §4.9) — the node the operator picked,
  // or null when the dialog is closed. A node id rather than a boolean:
  // several rows can each offer their own "Resume from here" button.
  const [resumeFrom, setResumeFrom] = useState<string | null>(null)
  const logRef = useRef<HTMLPreElement>(null)
  const { run, isPending } = useAction()
  const router = useRouter()
  // Run time and total-time tick without a refresh while a job is running.
  const now = useNow()
  // Plan 98 §3.9 item 4, §5 step 98.8 — "Peak memory 812 MB / 512 MB limit."
  // `override` is always `null` here: `JobInfo` (`packages/protocol/src/
  // messages/job.ts`) carries no `runtimeOverride` field yet (that file is a
  // contested one this step does not touch — see step 98.7's own status
  // paragraph), so this shows the script/farm-resolved ceiling only, never a
  // per-job override's own number. `null` (not "0") when no limit is
  // configured anywhere, matching `resolveRuntime`'s own convention.
  const resolvedMemoryLimit = useMemo(
    () => (farmJobSettings ? resolveRuntime({ farm: farmJobSettings, script: scriptRuntime, override: null }).resolved.maxRssBytes : null),
    [farmJobSettings, scriptRuntime],
  )

  // Split out of `load()` so the live `job.status` handler below can refresh
  // JUST the timeline on every node transition, without re-fetching the
  // whole job (plan 99 §4.11: "watching the node counter advance live").
  const refreshNodes = () => {
    if (!jobId) return
    void api(`/api/jobs/${jobId}/nodes`, JobNodesEnvelopeSchema)
      .then((r) => {
        setNodes(r.items)
        setNodesFinalized(r.finalized)
      })
      .catch(() => undefined)
  }

  const load = () => {
    if (!jobId) return
    setError(null)
    void api(`/api/jobs/${jobId}`, JobResponseSchema)
      .then((b) => {
        setJob(b.job)
        // The script row is version-specific, so its source (and, for a
        // workflow, its document) is exactly what ran.
        void api(`/api/scripts/${b.job.scriptId}`, ScriptSourceResponseSchema)
          .then((s) => {
            setSource(s.script.source ?? null)
            setWorkflowDoc(s.script.workflow ?? null)
            setScriptRuntime(s.script.runtime ?? null)
          })
          .catch(() => {
            setSource(null)
            setWorkflowDoc(null)
            setScriptRuntime(null)
          })
        void fetchDeviceRefs([b.job.deviceId])
          .then((refs) => setDeviceRef(refs[b.job.deviceId]))
          .catch(() => undefined)
        // Every other member of this job's trigger chain (plan 81 §4.5) —
        // cheap and always fetched: most jobs are not triggered, so this
        // simply returns an empty page, and the lineage panel below stays
        // hidden. `effectiveRootId` is this job's own id when it IS the
        // root (`rootJobId` is null on the origin's own row by design).
        const effectiveRootId = b.job.rootJobId ?? b.job.jobId
        void fetchAllPages<JobInfo>('/api/jobs', { rootJobId: effectiveRootId })
          .then(setChainNodes)
          .catch(() => setChainNodes([]))
        // The root's OWN detail is only fetched when this job is not it —
        // the root's row never appears in the `rootJobId` list above.
        if (b.job.depth > 0) {
          void api(`/api/jobs/${effectiveRootId}`, JobResponseSchema)
            .then((r) => setRootInfo(r.job))
            .catch(() => setRootInfo(null))
        } else {
          setRootInfo(null)
        }
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
    // Plan 91 §3.5, §4.9 — who touched this job's device while it ran, and
    // when. Failing quietly to an empty list (an old core without this
    // route, or a job with none) rather than surfacing a fetch error for
    // what is a supplementary panel, not the job itself.
    void api(`/api/jobs/${jobId}/assists`, JobAssistsResponseSchema)
      .then((r) => setAssists(r.items))
      .catch(() => setAssists([]))
    // A job's artifacts are usually a handful, but a script producing many
    // screenshots is not unbounded here — this walks every page rather than
    // trusting the endpoint's default limit (plan 30 §4.2).
    void fetchAllPages<ArtifactInfo>('/api/artifacts', { jobId })
      .then(setArtifacts)
      .catch(() => undefined)
    // What the job has ALREADY logged. `/ws` has no snapshot replay, so
    // without this a page opened mid-run showed nothing that had happened
    // before it subscribed — and the `job.log` artifact does not exist until
    // the job ends, so the whole story appeared at once on completion. This is
    // the fetch half of fetch-then-subscribe; the `job.log` handler below is
    // the other. A finished job answers with an empty list and the artifact
    // takes over.
    void api(`/api/jobs/${jobId}/logs`, JobLogsResponseSchema)
      .then((r) => {
        setBackfillLogs(r.lines)
        setLogsTruncated(r.truncated)
      })
      .catch(() => setBackfillLogs([]))  // settled, just empty
    // The node timeline (plan 99 §3.5, §4.9) — `[]`/`finalized: false` for
    // every non-workflow job (`GET /api/jobs/:id/nodes` never 404s for that
    // reason, matching `/assists`/`/logs` above), so the timeline card below
    // simply stays hidden rather than erroring.
    refreshNodes()
  }

  useEffect(load, [jobId])

  // Plan 98 §3.9 item 4, §5 step 98.8 — fetched once, independent of `jobId`:
  // this page has no other reason to load farm settings, and the "/ N limit"
  // half of the Peak memory row is informational (§3.8's own "read live
  // settings through a getter" property is a RUNNER guarantee, not something
  // this read-only screen re-proves) rather than something that must react
  // to a live settings change mid-view.
  useEffect(() => {
    void api('/api/settings', SettingsResponseSchema)
      .then((b) => setFarmJobSettings(b.settings.job))
      .catch(() => undefined)
  }, [])

  useEffect(() => {
    if (!jobId) return
    const off = ws.on((m) => {
      if (m.type === 'job.log' && m.payload.jobId === jobId) {
        setLiveLogs((p) => [...p.slice(-2000), m.payload])
      } else if (m.type === 'job.artifact' && m.payload.jobId === jobId) {
        setArtifacts((p) => [...p.filter((a) => a.id !== m.payload.artifact.id), m.payload.artifact])
      } else if (m.type === 'job.status' && m.payload.jobId === jobId) {
        setJob((p) => ({ ...(p ?? {}), ...m.payload }) as JobWithNode)
        // A workflow job's `node` block advances once per node execution
        // (plan 99 §4.9) — re-reading the timeline here is what makes
        // "watching the node counter advance live" (§4.11's verifiable
        // result) true instead of only updating on the FINAL settle below.
        if (m.payload.node) refreshNodes()
        if (['success', 'failed', 'cancelled', 'expired'].includes(m.payload.status)) load()
      } else if (m.type === 'job.waiting' && m.payload.jobId === jobId) {
        setWaiting(
          m.payload.waiting
            ? { heldBy: m.payload.heldBy, remainingSec: m.payload.remainingSec, reason: m.payload.reason }
            : null,
        )
      }
    })
    return off
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId])

  // A finished job's log lives in its job.log artifact. Without loading it, an
  // old job showed an empty panel even though every line had been kept.
  // Matched by label, not merely by kind: a crash trace (plan 37) is a `log`
  // artifact too, and picking that one would render a stack trace as the job's
  // log.
  const logArtifact = artifacts.find(isRunnerLog)
  useEffect(() => {
    if (!logArtifact || savedLogs !== null) return
    void fetch(`${coreBase()}/api/artifacts/${logArtifact.id}/content`)
      .then((r) => (r.ok ? r.text() : ''))
      .then((text) =>
        setSavedLogs(
          text
            .split('\n')
            .filter(Boolean)
            .flatMap((line) => {
              try {
                return [JSON.parse(line) as LogLine]
              } catch {
                return []
              }
            }),
        ),
      )
      .catch(() => setSavedLogs([]))
  }, [logArtifact, savedLogs])

  /**
   * The two sources are MERGED, not chosen between.
   *
   * This used to be `liveLogs.length > 0 ? liveLogs : savedLogs`, which lost lines in both
   * directions and was reported as exactly that — "kadang ada log terlewat, kadang tidak realtime".
   * `liveLogs` only ever holds what arrived over the WS *since this page subscribed*, so opening a
   * job mid-run and then receiving a single new line discarded every earlier line at once; and
   * before that first line arrived the panel showed the saved file, which lags. Neither source is
   * complete on its own: the WS has no replay (`/ws` deliberately does not snapshot) and the
   * artifact is written progressively.
   *
   * Deduped on `ts|level|msg` because a log line carries no id, and ordered by timestamp so the
   * seams between the three are invisible.
   *
   * There are THREE sources, not two. `backfillLogs` (`GET /api/jobs/:id/logs`)
   * is what a RUNNING job logged before this page subscribed — the case the
   * other two cannot cover, and the one that was reported as "sometimes no
   * logs, or you wait for it to finish and they all appear at once". The
   * comment here used to claim the artifact "is written progressively"; it is
   * not — `job-runner.ts` accumulates lines in memory and writes the file once,
   * in its `finally`. That mistaken belief is why the gap survived a first fix.
   */
  const logs = useMemo(() => {
    const byKey = new Map<string, LogLine>()
    for (const line of [...(savedLogs ?? []), ...(backfillLogs ?? []), ...liveLogs]) {
      byKey.set(`${line.ts}|${line.level}|${line.msg}`, line)
    }
    return [...byKey.values()].sort((a, b) => a.ts - b.ts)
  }, [savedLogs, backfillLogs, liveLogs])

  useEffect(() => {
    if (followLog) logRef.current?.scrollTo({ top: logRef.current.scrollHeight })
  }, [logs, followLog])

  /**
   * What the RUN produced (plan 60 §3.5). The runner's own `job` log is
   * filtered out here and here only: the API still returns it, because the
   * Logs tab above downloads that exact artefact to render a finished job's
   * log. Listing it as a script output as well is what made every job look
   * like it had saved a file nobody asked for.
   */
  const produced = useMemo(() => producedArtifacts(artifacts), [artifacts])
  const images = useMemo(() => produced.filter((a) => a.kind === 'screenshot'), [produced])
  const files = useMemo(() => produced.filter((a) => a.kind !== 'screenshot'), [produced])
  // `crash-<pkg>`/`anr-<pkg>` is the exact label `saveCrashTrace` in daemon.ts
  // gives the artifact when a job lease was held (plan 37 §3.6) — found
  // among the job's own artifacts, no separate device_events query needed.
  const crashTraceArtifact = useMemo(
    () => artifacts.find((a) => a.kind === 'log' && (a.label?.startsWith('crash-') || a.label?.startsWith('anr-'))),
    [artifacts],
  )

  useEffect(() => {
    if (!traceOpen || !crashTraceArtifact || traceText !== null) return
    void fetch(`${coreBase()}/api/artifacts/${crashTraceArtifact.id}/content`)
      .then((r) => (r.ok ? r.text() : 'Could not load the trace.'))
      .then(setTraceText)
      .catch(() => setTraceText('Could not load the trace.'))
  }, [traceOpen, crashTraceArtifact, traceText])

  if (!jobId) return <div className="px-5 py-4"><ErrorState message="The address is missing an id parameter." /></div>
  if (error) return <div className="px-5 py-4"><ErrorState message={error} onRetry={load} /></div>
  if (!job) return <div className="px-5 py-4"><LoadingRows rows={3} /></div>

  const cancellable = job.status === 'queued' || job.status === 'running'
  const scriptName = job.scriptName ? `${job.scriptName}@${job.scriptVersion ?? '?'}` : job.scriptId
  // How long it waited for a free device, separate from how long it ran.
  const waited = job.startedAt ? job.startedAt - job.createdAt : null
  const finished = ['success', 'failed', 'cancelled', 'expired'].includes(job.status)

  // Lineage (plan 81 §4.5) — what triggered this job, the root of the
  // chain, how deep it sits, and the jobs it triggered. A job with no
  // lineage at all (`depth 0`, no trigger, no children — most jobs) shows
  // none of this: `hasLineage` gates the whole panel rather than rendering
  // a card of nulls for the common case.
  const effectiveRootId = job.rootJobId ?? job.jobId
  const rootDisplay: JobInfo | JobWithPhase | null = job.depth > 0 ? rootInfo : job
  const parentDisplay: JobInfo | JobWithPhase | null = job.triggeredByJobId
    ? job.depth === 1
      ? rootDisplay
      : (chainNodes.find((n) => n.jobId === job.triggeredByJobId) ?? null)
    : null
  const triggeredJobs = chainNodes.filter((n) => n.triggeredByJobId === job.jobId)
  // Only QUEUED descendants — a cancel-with-descendants call only ever
  // touches those (`JobStore.cancelQueuedDescendants`); a running or
  // finished descendant is left alone regardless.
  const queuedDescendants = descendantsOf(chainNodes, job.jobId).filter((n) => n.status === 'queued')
  const hasLineage = job.triggeredByJobId !== null || job.depth > 0 || triggeredJobs.length > 0

  /**
   * Why it failed, with the failing line shown rather than described (plan 60
   * §3.4). One definition, rendered in one place at a time: inside the
   * Summary outcome card when that tab is open, above the tabs otherwise —
   * so a failure is never more than a glance away and never printed twice.
   */
  const failureDetail =
    job.status === 'failed' && job.error ? (
      <div className="rounded-lg border border-led-danger/40 bg-led-danger/5 p-3.5">
        <div className="flex flex-wrap items-center gap-2">
          <p className="rack-label text-led-danger">
            failure reason{job.errorPhase ? ` — during ${job.errorPhase}` : ''}
          </p>
          {/* Plan 36 §4.4 — infra vs script vs load, so "this suite is flaky" becomes an answerable question. */}
          {job.failureClass && (
            <span
              className={cn(
                'rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide',
                job.failureClass === 'infra' && 'border-led-warn/40 bg-led-warn/10 text-led-warn',
                job.failureClass === 'load' && 'border-line bg-transparent text-fg-muted',
                job.failureClass === 'script' && 'border-led-danger/40 bg-led-danger/10 text-led-danger',
              )}
            >
              {job.failureClass}
            </span>
          )}
        </div>
        <p className="mt-1 break-words text-[13px]">{job.error}</p>
        {crashTraceArtifact && (
          <div className="mt-2.5 border-t border-led-danger/20 pt-2.5">
            <button
              type="button"
              onClick={() => setTraceOpen((v) => !v)}
              className="inline-flex items-center gap-1 text-[12px] font-medium text-led-danger hover:underline"
            >
              {traceOpen ? <ChevronDown className="size-3.5" aria-hidden /> : <ChevronRight className="size-3.5" aria-hidden />}
              {traceOpen ? 'Hide crash trace' : 'Show crash trace'}
            </button>
            {traceOpen && (
              <pre className="readout mt-2 max-h-80 overflow-auto whitespace-pre-wrap rounded-md border border-led-danger/20 bg-surface p-2.5 text-[11px] leading-relaxed">
                {traceText ?? 'Loading…'}
              </pre>
            )}
          </div>
        )}
      </div>
    ) : null

  return (
    <>
      <PageHeader
        title={scriptName}
        description={`Job ${job.jobId.slice(0, 8)}`}
        meta={
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <JobStatusBadge status={job.status} />
            {/* The live node counter (plan 99 §4.9, §4.11) — "node 2/4",
                pushed by `job.status`'s own `node` block while a workflow
                job runs. `seq` is 0-based execution order (`+1` for a
                1-based display) and can legitimately exceed `total` on a
                looping node — shown as-is rather than clamped, since that IS
                the honest count of a workflow that has looped past its own
                node total. */}
            {job.node && (
              <span className="readout rounded-full border px-2 py-0.5 text-[11px] text-fg-muted">
                node {job.node.seq + 1}/{job.node.total}
                {job.node.script ? ` · ${job.node.script}` : job.node.kind === 'gate' ? ' · gate' : ''}
              </span>
            )}
            {/* The verdict, answerable without scrolling: how long it ran, and
                the three moments that matter as one line. This used to be a
                `timing` card two-thirds of the way down the content column,
                behind the result — so "did it work, and how long did it take"
                needed a scroll on every failed job. */}
            {job.startedAt && (
              <span className="readout text-[12px] text-fg-muted">
                ran {duration(job.startedAt, job.finishedAt, now)}
              </span>
            )}
            <span className="readout text-[11.5px] text-fg-subtle">
              {relativeTime(job.createdAt, now)} queued
              {job.startedAt ? ` → ${relativeTime(job.startedAt, now)} started` : ''}
              {job.finishedAt ? ` → ${relativeTime(job.finishedAt, now)} finished` : ''}
            </span>
          </div>
        }
        actions={
          <>
            <Button asChild variant="ghost" size="sm">
              <Link href="/jobs">
                <ArrowLeft className="size-4" aria-hidden />
                All jobs
              </Link>
            </Button>
            {cancellable &&
              // Cancelling a job with queued descendants must say so before
              // it acts (plan 81 §4.4) — a plain cancel never touches them.
              (queuedDescendants.length > 0 ? (
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button variant="outline" size="sm" disabled={isPending('cancel')}>
                      {isPending('cancel') ? 'Cancelling…' : 'Cancel job'}
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent size="sm">
                    <AlertDialogHeader>
                      <AlertDialogTitle>Cancel this job and its queued descendants?</AlertDialogTitle>
                      <AlertDialogDescription>
                        This job triggered a chain — {queuedDescendants.length} job{queuedDescendants.length === 1 ? '' : 's'}{' '}
                        still queued because of it will be cancelled along with this one. Anything already running or
                        finished is left alone.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Keep them queued</AlertDialogCancel>
                      <AlertDialogAction
                        onClick={() =>
                          void run(
                            'cancel',
                            () =>
                              api(`/api/jobs/${jobId}/cancel?cancelDescendants=1`, JobCancelResponseSchema, {
                                method: 'POST',
                              }),
                            {
                              success: `Job cancelled — ${queuedDescendants.length} descendant${queuedDescendants.length === 1 ? '' : 's'} too`,
                              failure: 'Could not cancel the job',
                            },
                          )
                        }
                      >
                        Cancel {queuedDescendants.length + 1} jobs
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={isPending('cancel')}
                  onClick={() =>
                    void run('cancel', () => api(`/api/jobs/${jobId}/cancel`, JobCancelResponseSchema, { method: 'POST' }), {
                      success: 'Job cancelled',
                      failure: 'Could not cancel the job',
                    })
                  }
                >
                  Cancel job
                </Button>
              ))}
          </>
        }
      />

      <EntityTabs
        active={tab}
        tabs={[
          { key: 'summary', label: 'Summary' },
          { key: 'logs', label: 'Logs', count: logs.length || null },
          { key: 'artifacts', label: 'Artifacts', count: produced.length || null },
          { key: 'script', label: 'Script' },
        ]}
        hrefFor={(k) => `/jobs/detail?id=${jobId}${k === 'summary' ? '' : `&tab=${k}`}`}
      />

      {/* The quiet-period wait (plan 71 §3.7) OR a paced repetition's own
          drawn delay (plan 94 §3.7, §4.9, F25, step 94.10) — shown on every
          tab, since "queued" alone looks identical to a job that is simply
          next in line. This is what makes the difference legible instead of
          looking stuck — F25's own complaint was a farm sitting idle with
          no explanation. */}
      {waiting && job.status === 'queued' && (
        <div className="mx-5 mt-4 flex flex-wrap items-center gap-2 rounded-lg border border-led-warn/35 bg-led-warn/5 px-3.5 py-2.5 text-[12.5px]">
          <Hourglass className="size-3.5 shrink-0 text-led-warn" aria-hidden />
          <span>{waiting.reason === 'paced' ? 'Waiting for the next repetition' : 'Waiting for the device to be free'}</span>
          {waiting.heldBy && <HolderBadge holder={waiting.heldBy} />}
          <span className="readout text-fg-subtle">
            — {waiting.reason === 'paced' ? 'starting' : 'proceeding'} in {waiting.remainingSec}s
            {waiting.remainingSec === 0 ? ' (any moment now)' : ' at the latest'}
          </span>
        </div>
      )}

      {/* On every tab but Summary, where it has a card of its own. */}
      {tab !== 'summary' && failureDetail && <div className="mx-5 mt-4">{failureDetail}</div>}

      {tab === 'summary' && (
        <div className="grid gap-4 px-5 py-4 xl:grid-cols-[1fr_20rem]">
          <div className="space-y-4">
            {/* What happened, and what the script reported (plan 60 §3.3, §3.4) —
                the two things the person who ran it came here for. */}
            <div className="rounded-lg border bg-surface p-4">
              <h2 className="rack-label mb-3">outcome</h2>
              <p
                className={cn(
                  'text-[13.5px]',
                  job.status === 'success' && 'text-led-ok',
                  job.status === 'failed' && 'text-led-danger',
                  job.status === 'expired' && 'text-led-warn',
                )}
              >
                {outcomeLine(job)}
              </p>
              {failureDetail && <div className="mt-3">{failureDetail}</div>}

              <div className="mt-4 border-t pt-3">
                <h3 className="rack-label mb-2">returned</h3>
                {!finished ? (
                  <p className="text-[12.5px] text-fg-subtle">A script reports its result when it finishes.</p>
                ) : job.resultStatus === 'oversize' ? (
                  /* §3.4 — the value never crossed IPC at all; `job.result`
                     is NULL by construction (§3.3's own table), so this is
                     the whole story for this job, not a banner above a
                     (missing) value. */
                  <div className="rounded-lg border border-led-warn/40 bg-led-warn/5 p-3">
                    <p className="rack-label text-led-warn">result too large to store</p>
                    <p className="mt-1 text-[12.5px] leading-relaxed">
                      This run returned{' '}
                      {typeof job.resultBytes === 'number' ? fileSize(job.resultBytes) : 'more than the limit'}. The
                      farm's limit for a stored result is {fileSize(RESULT_LIMITS.defaultMaxResultBytes)}, so nothing
                      was kept. Save large output as an artifact with{' '}
                      <span className="readout">ctx.artifact.file('report', data)</span> and return a small summary
                      that points at it.
                    </p>
                  </div>
                ) : job.result === null || job.result === undefined ? (
                  <p className="text-[12.5px] text-fg-subtle">
                    This script returned nothing. A script that should report something — an exit IP, a version,
                    whether an element was there — returns it from <span className="readout">run()</span>.
                  </p>
                ) : job.resultSchema ? (
                  /* A typed result reads as values, not as JSON (§3.6, §4.8).
                     `resultStatus` distinguishes THREE different messages an
                     operator needs told apart — never blurred into one
                     "something went wrong" banner (§4.8's own three
                     banners): `invalid` (the value broke its own promise),
                     `partial` (evidence salvaged from a failed run, never
                     validated — §3.5), `valid`/`undeclared` show no banner
                     at all. */
                  <>
                    {job.resultStatus === 'invalid' && (
                      <div className="mb-2.5 rounded-lg border border-led-warn/40 bg-led-warn/5 p-3">
                        <p className="rack-label text-led-warn">result doesn't match its own schema</p>
                        <p className="mt-1 text-[12.5px] leading-relaxed">
                          {job.resultIssues && job.resultIssues.length > 0
                            ? job.resultIssues.map((issue) => issue.path || '(the whole value)').join(', ')
                            : 'The returned value did not satisfy the schema this script declared.'}
                        </p>
                      </div>
                    )}
                    {job.resultStatus === 'partial' && (
                      <div className="mb-2.5 rounded-lg border bg-surface p-3">
                        <p className="text-[12.5px] text-fg-muted">
                          this run failed — these are the values it had reached
                        </p>
                      </div>
                    )}
                    <ResultView schema={job.resultSchema as JsonSchemaNode} value={job.result} />
                  </>
                ) : (
                  <pre className="readout max-h-80 overflow-auto whitespace-pre-wrap rounded-md border bg-bg p-2.5 text-[11.5px] leading-relaxed">
                    {formatResult(job.result)}
                  </pre>
                )}
              </div>

              {/* Inputs are reference material, so they sit BELOW the result and
                  start closed (audit finding 2). Above it, they pushed the thing
                  the run produced further down the page — and the params are
                  read second, when the result raises a question about them. */}
              <details className="mt-4 border-t pt-3">
                <summary className="rack-label cursor-pointer list-none select-none marker:content-none">
                  started with{job.params === null || job.params === undefined ? ' — nothing' : ''}
                </summary>
                {job.params === null || job.params === undefined ? (
                  <p className="mt-2 text-[12.5px] text-fg-subtle">
                    This script declares no parameters, or it was run with its defaults.
                  </p>
                ) : (
                  <pre className="readout mt-2 max-h-80 overflow-auto whitespace-pre-wrap rounded-md border bg-bg p-2.5 text-[11.5px] leading-relaxed">
                    {formatResult(job.params)}
                  </pre>
                )}
              </details>
            </div>

            {/* The node timeline (plan 99 §3.5, §3.7, §4.9, §4.11) — hidden
                entirely for an ordinary (non-workflow) job, the same
                "nothing extra for the common case" rule the lineage and
                Assisted-by cards below already follow. This is the surface
                this step's own verifiable result names: which node failed
                and why, without opening the log. */}
            {nodes.length > 0 && (
              <NodeTimeline
                nodes={nodes}
                workflowDoc={workflowDoc}
                finalized={nodesFinalized}
                artifacts={artifacts}
                now={now}
                onResumeClick={setResumeFrom}
              />
            )}
          </div>

          {/* Reference, not content (audit finding 2). Phases and timing were
              in the left column ahead of the logs; nobody reads either until
              the verdict is understood, and they pushed the result — the thing
              the run existed to produce — below the fold. This column has the
              width for them and now earns it. */}
          <aside className="space-y-4">
              <div className="rounded-lg border bg-surface p-3.5">
                <h2 className="rack-label mb-3">phases</h2>
                <div className="flex flex-wrap items-center gap-2">
                  {PHASES.map((f, i) => {
                    const active = job.phase === f && job.status === 'running'
                    const done =
                      job.status !== 'queued' && (PHASES.indexOf(job.phase ?? 'prepare') > i || job.status === 'success')
                    return (
                      <div key={f} className="flex items-center gap-2">
                        <span
                          className={cn(
                            'rounded-full border px-2.5 py-1 text-[11.5px]',
                            active
                              ? 'border-led-active/40 bg-led-active/10 text-led-active'
                              : done
                                ? 'border-led-ok/35 text-led-ok'
                                : 'text-fg-subtle',
                          )}
                        >
                          {f}
                        </span>
                        {i < PHASES.length - 1 && <span className="text-fg-subtle">→</span>}
                      </div>
                    )
                  })}
                </div>
              </div>

              <div className="rounded-lg border bg-surface p-3.5">
                <h2 className="rack-label mb-3">timing</h2>
                <dl className="space-y-2.5">
                  <Row label="Queued" value={absolute(job.createdAt)} note={relativeTime(job.createdAt, now)} />
                  <Row
                    label="Started"
                    value={absolute(job.startedAt)}
                    note={waited !== null ? `waited ${duration(job.createdAt, job.startedAt, now)} for a device` : undefined}
                  />
                  <Row label="Finished" value={absolute(job.finishedAt)} />
                  <Row
                    label="Run time"
                    value={job.startedAt ? duration(job.startedAt, job.finishedAt, now) : '—'}
                    note={job.status === 'running' ? 'still running' : undefined}
                  />
                  <Row label="Total, queue to finish" value={duration(job.createdAt, job.finishedAt, now)} />
                  {/* Plan 98 §3.9 item 4, §4.4, H1 — always present once a
                      script has actually run a child process, whether or not
                      any memory limit is configured anywhere: you cannot
                      choose a limit without first having seen a number. Null
                      for a job that never spawned a child (an acquire
                      failure, a built-in executor) or predates this column.
                      The "/ N limit" half (§3.9 item 4's own example, "Peak
                      memory 812 MB / 512 MB limit") appears only once the
                      script's own declaration and the farm's settings have
                      both loaded, and only when a limit actually resolves —
                      never "/ no limit", which would just be noise on every
                      job that has none configured. */}
                  <Row
                    label="Peak memory"
                    value={
                      resolvedMemoryLimit !== null && job.peakRssBytes !== null
                        ? `${fileSize(job.peakRssBytes)} / ${fileSize(resolvedMemoryLimit)} limit`
                        : fileSize(job.peakRssBytes)
                    }
                    note={job.peakRssBytes === null ? 'not measured for this job' : undefined}
                  />
                </dl>
              </div>

            <div className="rounded-lg border bg-surface p-3.5">
              <h2 className="rack-label mb-2.5">identity</h2>
              <dl className="space-y-1.5">
                {[
                  ['job id', job.jobId],
                  ['script', scriptName],
                  ['device', deviceRefLabel(deviceRef, job.deviceId)],
                  ['priority', String(job.priority)],
                ].map(([k, v]) => (
                  <div key={k} className="flex items-baseline justify-between gap-3">
                    <dt className="text-[12px] text-fg-muted">{k}</dt>
                    <dd className="readout min-w-0 truncate text-[12px]" title={v}>{v}</dd>
                  </div>
                ))}
              </dl>
              {/* A forgotten device (plan 47 §3.4) has no page to open — the
                  link is dropped rather than pointing at a 404. */}
              {!deviceRef?.deleted && (
                <Button asChild variant="ghost" size="sm" className="mt-2 h-7 w-full text-[12px]">
                  <Link href={`/device?id=${encodeURIComponent(job.deviceId)}`}>Open device</Link>
                </Button>
              )}

              {/* A chain is a tree, not four raw ids (plan 81 §4.5): every
                  link below names the job by script and status, never a bare
                  uuid. Hidden entirely for the common case — a job nothing
                  triggered and that triggered nothing itself. */}
              {hasLineage && (
                <div className="mt-3 border-t pt-3">
                  <h3 className="rack-label mb-2">lineage</h3>
                  <dl className="space-y-1.5">
                    {job.triggeredByJobId && (
                      <div className="flex items-baseline justify-between gap-3">
                        <dt className="text-[12px] text-fg-muted">triggered by</dt>
                        <dd className="min-w-0">
                          <Link
                            href={`/jobs/detail?id=${job.triggeredByJobId}`}
                            className="flex items-center gap-1.5 truncate hover:underline"
                          >
                            <span className="readout truncate text-[12px]">
                              {parentDisplay?.scriptName ?? job.triggeredByJobId.slice(0, 8)}
                            </span>
                            {parentDisplay && <JobStatusBadge status={parentDisplay.status} />}
                          </Link>
                        </dd>
                      </div>
                    )}
                    {job.depth > 0 && (
                      <>
                        <div className="flex items-baseline justify-between gap-3">
                          <dt className="text-[12px] text-fg-muted">root of chain</dt>
                          <dd className="min-w-0">
                            <Link
                              href={`/jobs/detail?id=${effectiveRootId}`}
                              className="flex items-center gap-1.5 truncate hover:underline"
                            >
                              <span className="readout truncate text-[12px]">
                                {rootDisplay?.scriptName ?? effectiveRootId.slice(0, 8)}
                              </span>
                              {rootDisplay && <JobStatusBadge status={rootDisplay.status} />}
                            </Link>
                          </dd>
                        </div>
                        <div className="flex items-baseline justify-between gap-3">
                          <dt className="text-[12px] text-fg-muted">depth</dt>
                          <dd className="readout text-[12px]">{job.depth}</dd>
                        </div>
                      </>
                    )}
                    {(job.depth > 0 || triggeredJobs.length > 0) && (
                      <div className="flex items-baseline justify-between gap-3">
                        <dt className="text-[12px] text-fg-muted">chain size</dt>
                        <dd className="readout text-[12px]">
                          {chainNodes.length + 1} job{chainNodes.length + 1 === 1 ? '' : 's'}
                        </dd>
                      </div>
                    )}
                  </dl>
                  {triggeredJobs.length > 0 && (
                    <div className="mt-2.5 border-t pt-2">
                      <p className="rack-label mb-1.5">
                        triggered {triggeredJobs.length} job{triggeredJobs.length === 1 ? '' : 's'}
                      </p>
                      <ul className="space-y-0.5">
                        {triggeredJobs.map((c) => (
                          <li key={c.jobId}>
                            <Link
                              href={`/jobs/detail?id=${c.jobId}`}
                              className="flex items-center justify-between gap-2 rounded px-1 py-1 text-[12px] hover:bg-surface-2"
                            >
                              <span className="min-w-0 truncate">{c.scriptName ?? c.jobId.slice(0, 8)}</span>
                              <JobStatusBadge status={c.status} />
                            </Link>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Plan 91 §1, §3.5 — "a job that mysteriously succeeded because
                someone tapped a modal is a lie in the history." Hidden
                entirely for the common, un-assisted case, matching the
                `hasLineage` card above and `docs/design.md`'s "no disabled
                placeholders" rule. */}
            {assists.length > 0 && (
              <div className="rounded-lg border border-led-warn/35 bg-led-warn/5 p-3.5">
                <h2 className="rack-label mb-2.5 text-led-warn">
                  assisted by {assists.length} action{assists.length === 1 ? '' : 's'}
                </h2>
                <ul className="space-y-1.5">
                  {assists.map((e) => (
                    <li key={e.id} className="flex items-baseline justify-between gap-3 text-[12px]">
                      <span className="min-w-0 truncate text-fg-muted">
                        {e.kind.replace('input.', '')} — {e.actor ?? 'an unauthenticated client'}
                      </span>
                      <span className="readout shrink-0 text-fg-subtle">{relativeTime(e.at, now)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </aside>
        </div>
      )}

      {tab === 'logs' && (
        <div className="px-5 py-4">
          <div className="overflow-hidden rounded-lg border bg-surface">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b px-3 py-2">
              <h2 className="rack-label">
                {liveLogs.length > 0 || (backfillLogs?.length ?? 0) > 0 ? 'live' : backfillLogs === null && savedLogs === null ? 'loading' : 'saved to job.log'}
              </h2>
              {/* A long-running job's oldest retained lines are dropped rather
                  than growing without bound. Saying so beats quietly starting
                  the story in the middle. */}
              {logsTruncated && (
                <span className="text-[11px] text-fg-subtle">earlier lines dropped — the full log is kept as an artifact</span>
              )}
              <label className="flex items-center gap-2 text-[11.5px] text-fg-muted">
                Follow latest
                <Switch checked={followLog} onCheckedChange={setFollowLog} aria-label="Follow latest lines" />
              </label>
            </div>
            <pre
              ref={logRef}
              className="readout max-h-[32rem] overflow-auto whitespace-pre-wrap p-3 text-[11.5px] leading-relaxed"
            >
              {/* Loading means "nothing has answered yet" — not "there is no
                  saved artifact". A RUNNING job never has one, so keying on
                  `savedLogs` alone left the panel on "Loading…" until a new
                  line happened to arrive, which is exactly the bug this
                  backfill existed to fix. */}
              {backfillLogs === null && savedLogs === null && liveLogs.length === 0
                ? 'Loading…'
                : logs.length === 0
                  ? 'This job produced no log lines.'
                  : logs
                      .map(
                        (l) =>
                          `${new Date(l.ts).toLocaleTimeString()}  ${l.level.padEnd(5)} ${l.source.padEnd(6)} ${l.msg}`,
                      )
                      .join('\n')}
            </pre>
          </div>
          <p className="mt-2 text-[11.5px] text-fg-subtle">
            Logs stream live while a job runs and are kept afterwards as the <span className="readout">job.log</span>{' '}
            artifact, so this panel works for old jobs too.
          </p>
        </div>
      )}

      {tab === 'artifacts' && (
        <div className="px-5 py-4">
          {produced.length === 0 ? (
            <EmptyState
              title="No artifacts"
              description="Screenshots and files a script saves with ctx.artifact appear here. The run's own log is on the Logs tab."
            />
          ) : (
            <div className="space-y-4">
              {images.length > 0 && (
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-6">
                  {images.map((a) => (
                    <a
                      key={a.id}
                      href={`${coreBase()}/api/artifacts/${a.id}/content`}
                      target="_blank"
                      rel="noreferrer"
                      className="group overflow-hidden rounded border hover:border-accent"
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={`${coreBase()}/api/artifacts/${a.id}/content`}
                        alt={a.label ?? 'screenshot'}
                        className="aspect-[9/16] w-full object-cover"
                      />
                      <span className="block truncate px-1.5 py-1 text-[10.5px] text-fg-muted">{a.label}</span>
                    </a>
                  ))}
                </div>
              )}
              {files.length > 0 && (
                <div className="divide-y overflow-hidden rounded-lg border">
                  {files.map((a) => (
                    <a
                      key={a.id}
                      href={`${coreBase()}/api/artifacts/${a.id}/content`}
                      target="_blank"
                      rel="noreferrer"
                      className="flex items-center gap-2 px-3 py-2 text-[12.5px] hover:bg-surface-2"
                    >
                      <Download className="size-3.5 shrink-0 text-fg-subtle" aria-hidden />
                      <span className="min-w-0 flex-1 truncate">{fileName(a)}</span>
                      <span className="readout shrink-0 text-[11px] text-fg-subtle">{fileSize(a.sizeBytes)}</span>
                    </a>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {tab === 'script' && (
        <div className="px-5 py-4">
          {source === undefined ? (
            <LoadingRows rows={4} />
          ) : source === null ? (
            <EmptyState
              title="No source stored for this script"
              description={
                <>
                  Only the bundle was kept when this version was published. Publishing again with a newer CLI stores the
                  entry source alongside it, and it will show up here.
                </>
              }
            />
          ) : (
            <>
              <p className="mb-2 text-[12px] text-fg-muted">
                The exact source of <span className="readout">{scriptName}</span> — jobs record a specific script
                version, so this is what ran, not whatever is published now.
              </p>
              <pre className="readout max-h-[36rem] overflow-auto whitespace-pre rounded-lg border bg-surface p-3 text-[11.5px] leading-relaxed">
                {source}
              </pre>
            </>
          )}
        </div>
      )}

      {/* Rendered regardless of active tab — "Resume from here" lives on the
          Summary tab's node timeline, but the confirmation itself should not
          vanish if a click happens to straddle a tab switch. */}
      {resumeFrom && (
        <ResumeDialog
          jobId={jobId}
          nodeId={resumeFrom}
          nodes={nodes}
          workflowDoc={workflowDoc}
          onClose={() => setResumeFrom(null)}
          onResumed={(newJobId) => {
            setResumeFrom(null)
            router.push(`/jobs/detail?id=${newJobId}`)
          }}
        />
      )}
    </>
  )
}

function Row({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-3">
      <dt className="text-[12.5px] text-fg-muted">{label}</dt>
      <dd className="readout text-[12.5px]">{value}</dd>
      {note && <span className="w-full text-right text-[11px] text-fg-subtle">{note}</span>}
    </div>
  )
}

/**
 * The name the file actually downloads as, rather than its internal label —
 * "job.log" says what is inside, "job" does not.
 */
function fileName(a: ArtifactInfo): string {
  const base = a.path.split('/').pop() ?? ''
  const stripped = base.replace(/^\d+-/, '')
  return stripped || a.label || a.kind
}

export default function JobDetailPage() {
  return (
    <Suspense fallback={<div className="px-5 py-4"><LoadingRows rows={3} /></div>}>
      <JobDetail />
    </Suspense>
  )
}
