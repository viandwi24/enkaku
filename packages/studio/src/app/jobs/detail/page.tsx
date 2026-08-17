'use client'

import { Suspense, useEffect, useMemo, useRef, useState } from 'react'
// `useRef` stays imported for `jobRef` below (the ws handler's own
// terminal-status refresh needs the LATEST `job`, not a stale closure).
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { ArrowLeft, Hourglass, RotateCcw } from 'lucide-react'
import { z } from 'zod'
import {
  JobAssistsResponseSchema,
  JobCancelResponseSchema,
  JobCreateResponseSchema,
  JobNodesResponseSchema,
  JobResponseSchema,
  resolveRuntime,
  SettingsResponseSchema,
  type ArtifactInfo,
  type DeviceEvent,
  type GateOutcome,
  type JobInfo,
  type JobNodeStatus,
  type JobSettings,
  type LeaseHolder,
  type Predicate,
  type ValueExpr,
  type WorkflowDoc,
  type WorkflowNode,
} from '@enkaku/protocol'
import { JobStatusBadge } from '@/components/StatusBadge'
import { HolderBadge } from '@/components/HolderBadge'
import { EntityTabs } from '@/components/layout/EntityTabs'
import { PageHeader } from '@/components/layout/PageHeader'
import { JobArtifactsPanel } from '@/components/jobs/JobArtifactsPanel'
import { JobFailureDetail } from '@/components/jobs/JobFailureDetail'
import { JobLogsPanel } from '@/components/jobs/JobLogsPanel'
import { JobResultSection } from '@/components/jobs/JobResultSection'
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
  Button,
  EmptyState,
  ErrorState,
  LoadingRows,
  api,
  cn,
  duration,
  fileSize,
  relativeTime,
  useAction,
} from '@enkaku/ui'
import { deviceRefLabel, fetchAllPages, type JobNodeInfo } from '@/lib/api'
import { descendantsOf } from '@/lib/job-lineage'
import type { JobWithPhase } from '@/lib/jobs'
import { useJobDetail, type JobWithNode } from '@/lib/use-job-detail'
import { useNow } from '@/lib/useNow'
import { coreBase, ws } from '@/lib/ws'

/** `reset` (plan 35 §3.5) is the pre-job device reset — it always runs before `prepare`. */
const PHASES = ['reset', 'prepare', 'run', 'finish'] as const

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

  // The four surfaces plan 103 step 103.11's audit named (result, params,
  // logs, artifacts) — plus script source and device ref — now live in ONE
  // hook shared with the device popup's own in-place Jobs tab
  // (`components/device-popup/JobDetailPanel.tsx`), so neither renders a
  // thinner copy of the other's fetch/merge logic (`lib/use-job-detail.ts`'s
  // own file header has the full reasoning, including the log-merge
  // algorithm's own history).
  const { job, deviceRef, source, workflowDoc, scriptRuntime, artifacts, produced, images, files, crashTraceArtifact, logs, logsTruncated, logsPhase, error, load } =
    useJobDetail(jobId)
  // Lineage (plan 81 §4.5) — `chainNodes` is every OTHER member of this
  // job's trigger chain (`GET /api/jobs?rootJobId=...` excludes the root's
  // own row by design); `rootInfo` is that root's own detail, fetched
  // separately and only when this job is not itself the root. Both start
  // empty/null so a job with no lineage — the common case — renders with
  // nothing extra rather than a loading flicker. Page-only: not one of the
  // four surfaces the popup's Jobs tab reuses (`use-job-detail.ts`'s own
  // file header names exactly what stayed here and why).
  const [chainNodes, setChainNodes] = useState<JobInfo[]>([])
  const [rootInfo, setRootInfo] = useState<JobInfo | null>(null)
  // Plan 91 §3.5, §4.9 — every non-job input action recorded against this
  // job's device while it ran. Page-only, same reasoning as `chainNodes`.
  const [assists, setAssists] = useState<DeviceEvent[]>([])
  // Plan 98 §3.9 item 4, §5 step 98.8 — the Summary tab's "Peak memory" row
  // gains a "/ N limit" half. `farmJobSettings` is fetched once,
  // independently — a job page has no other reason to load farm settings,
  // so this is its own small round trip rather than piggy-backing on an
  // unrelated fetch. Page-only: the popup's Jobs tab has no memory-limit row.
  const [farmJobSettings, setFarmJobSettings] = useState<JobSettings | null>(null)
  // Waiting for the device to go quiet before claiming it (plan 71 §3.7), OR
  // (plan 94 §3.7, §4.9, F25, step 94.10) waiting on the PACER for its next
  // repetition's drawn delay to elapse — visible, not silent: a wait nobody
  // can see is indistinguishable from a hang. `null` means "not currently
  // waiting" (never started, or already claimed/expired past the cap).
  const [waiting, setWaiting] = useState<{ heldBy: LeaseHolder | null; remainingSec: number; reason: 'quiet' | 'paced' } | null>(
    null,
  )
  // The node timeline (plan 99 §3.5, §4.9, step 99.10) — `[]`/`false` for
  // every non-workflow job, the same "empty, not missing" convention
  // `assists` above already uses. `workflowDoc` (from the hook) is the
  // parsed pipeline, read for the gate verdict sentence's `when`/`then`/
  // `else` and the resume dialog's "what will be skipped" preview.
  const [nodes, setNodes] = useState<JobNodeInfo[]>([])
  const [nodesFinalized, setNodesFinalized] = useState(false)
  // "Resume from here" (plan 99 §3.5, §4.9) — the node the operator picked,
  // or null when the dialog is closed. A node id rather than a boolean:
  // several rows can each offer their own "Resume from here" button.
  const [resumeFrom, setResumeFrom] = useState<string | null>(null)
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

  // Split out so the live `job.status` handler below can refresh JUST the
  // timeline on every node transition, without re-fetching the whole job
  // (plan 99 §4.11: "watching the node counter advance live").
  const refreshNodes = () => {
    if (!jobId) return
    void api(`/api/jobs/${jobId}/nodes`, JobNodesResponseSchema)
      .then((r) => {
        setNodes(r.items)
        setNodesFinalized(r.finalized)
      })
      .catch(() => undefined)
  }

  // `loadExtras` needs the CURRENT job (for `rootJobId`/`depth`) at the
  // moment it is called, including from the long-lived ws listener below —
  // a plain closure over `job` there would see whatever `job` was at the
  // time that effect last ran (`[jobId]`, not `[job]`), not the freshest
  // value. `jobRef` avoids re-subscribing the listener on every `job` update
  // just to keep it fresh.
  const jobRef = useRef(job)
  jobRef.current = job

  function loadExtras(): void {
    const j = jobRef.current
    if (!jobId || !j) return
    const effectiveRootId = j.rootJobId ?? j.jobId
    void fetchAllPages<JobInfo>('/api/jobs', { rootJobId: effectiveRootId })
      .then(setChainNodes)
      .catch(() => setChainNodes([]))
    if (j.depth > 0) {
      void api(`/api/jobs/${effectiveRootId}`, JobResponseSchema)
        .then((r) => setRootInfo(r.job))
        .catch(() => setRootInfo(null))
    } else {
      setRootInfo(null)
    }
    // Plan 91 §3.5, §4.9 — who touched this job's device while it ran, and
    // when. Failing quietly to an empty list (an old core without this
    // route, or a job with none) rather than surfacing a fetch error for
    // what is a supplementary panel, not the job itself.
    void api(`/api/jobs/${jobId}/assists`, JobAssistsResponseSchema)
      .then((r) => setAssists(r.items))
      .catch(() => setAssists([]))
  }

  // The node timeline and the lineage/assists panels each need the job to
  // exist first (`rootJobId`/`depth` for the latter) — both re-run once
  // `job` first resolves for THIS jobId (not on every in-place `job.status`
  // update, which would over-fetch on every progress tick).
  useEffect(() => {
    if (!job) return
    refreshNodes()
    loadExtras()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.jobId])

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

  // The page-only half of the live `job.status`/`job.waiting` broadcasts —
  // the hook's OWN `ws.on` (inside `useJobDetail`) already merges `job`
  // itself and reloads on a terminal status; this second, independent
  // listener is what re-reads the node timeline on every node transition and
  // re-reads lineage/assists once a job actually finishes, matching what the
  // single combined handler on this page used to do before the extraction.
  useEffect(() => {
    if (!jobId) return
    const off = ws.on((m) => {
      if (m.type === 'job.status' && m.payload.jobId === jobId) {
        if (m.payload.node) refreshNodes()
        if (['success', 'failed', 'cancelled', 'expired'].includes(m.payload.status)) {
          refreshNodes()
          loadExtras()
        }
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

  // "Why it failed" (plan 60 §3.4) is rendered in one place at a time —
  // inside `JobResultSection`'s own outcome card when the Summary tab is
  // open, or standalone above the other tabs — so a failure is never more
  // than a glance away and never printed twice. `JobFailureDetail`
  // (`components/jobs/`) is the ONE definition both places use.
  const isFailed = job.status === 'failed' && Boolean(job.error)

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
      {tab !== 'summary' && isFailed && (
        <div className="mx-5 mt-4">
          <JobFailureDetail job={job} crashTraceArtifact={crashTraceArtifact} />
        </div>
      )}

      {tab === 'summary' && (
        <div className="grid gap-4 px-5 py-4 xl:grid-cols-[1fr_20rem]">
          <div className="space-y-4">
            {/* What happened, and what the script reported (plan 60 §3.3, §3.4) —
                the two things the person who ran it came here for. Reused,
                not re-derived, by the device popup's own Jobs tab
                (`JobResultSection`, `components/jobs/`). */}
            <JobResultSection job={job} finished={finished} crashTraceArtifact={crashTraceArtifact} />

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

      {/* Reused, not re-derived, by the device popup's own Jobs tab (`JobLogsPanel`, `components/jobs/`). */}
      {tab === 'logs' && (
        <div className="px-5 py-4">
          <JobLogsPanel logs={logs} truncated={logsTruncated} phase={logsPhase} />
        </div>
      )}

      {/* Reused, not re-derived, by the device popup's own Jobs tab (`JobArtifactsPanel`, `components/jobs/`). */}
      {tab === 'artifacts' && (
        <div className="px-5 py-4">
          <JobArtifactsPanel images={images} files={files} />
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

export default function JobDetailPage() {
  return (
    <Suspense fallback={<div className="px-5 py-4"><LoadingRows rows={3} /></div>}>
      <JobDetail />
    </Suspense>
  )
}
