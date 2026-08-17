import { and, asc, eq } from 'drizzle-orm'
import type { JobRunner, SessionManager } from '@enkaku/session'
import {
  evaluatePredicate,
  resolveValue,
  validateAgainstSchema,
  WORKFLOW_LIMITS,
  WorkflowDocSchema,
  type GateOutcome,
  type JobNodeStatus,
  type ResolveScope,
  type RunSummaryEntry,
  type WorkflowDoc,
  type WorkflowNode,
} from '@enkaku/protocol'
import type { Db } from '../../db'
import { jobNodes, jobResumes, scripts, type JobRow } from '../../db/schema'
import type { JobNodeTracker } from '../../runner/artifact-store'
import type { ScriptEntry, ScriptRegistry } from '../../scripts/registry'
import { EnkakuError } from '../../util/errors'
import type { Logger } from '../../util/logger'
import type { ExecutorContext, JobExecutor } from '../executor'

/**
 * Plan 99 §3.11 — the workflow's OWN clock, separate from a node's own
 * `ScriptDefinition.timeout` (clamped by `job.maxTimeoutMs`, entirely inside
 * `@enkaku/session`'s `JobRunner`, unchanged by this file) and from
 * `maxSteps` (a count, not a duration, checked below). This is the coarse
 * backstop: "how long may one device be held by one pipeline."
 *
 * `workflow.maxTotalMs` IS a real, Studio-editable farm setting
 * (`packages/protocol/src/settings.ts`, registered on the Jobs tab —
 * `packages/studio/src/components/settings/farmSections.ts` — plan 99 §5
 * items 1-2). **This file's own runtime check, below, reads the LIVE
 * setting**: `daemon.ts`'s `createWorkflowExecutor({...})` call passes
 * `settings: () => settingsStore.get().workflow`, not a captured literal —
 * guarded by `workflow-settings-wiring.test.ts` (this directory), which
 * fails by name if a future edit regresses it back to
 * `DEFAULT_WORKFLOW_MAX_TOTAL_MS`. `checkWorkflow`'s own publish-time
 * arithmetic (`packages/protocol/src/workflow-check.ts`,
 * `E_WORKFLOW_BUDGET_IMPOSSIBLE`, §4.3 check 7) is ALSO now live:
 * `daemon.ts`'s `createWorkflowRoutes({...})` call passes the identical
 * `settings: () => settingsStore.get().workflow` accessor, guarded by
 * `daemon-wiring.test.ts`'s own workflow-routes describe block
 * (docs/settings-audit.md #3, `docs/plans/96-m61-hotfixes.md`). Until that
 * fix landed, this file's own comment (and `settings.ts`'s) described the
 * gap BACKWARDS — claiming the runtime executor was still hardcoded and the
 * publish-time check was already live, the exact opposite of the truth at
 * the time (the runtime clock was live; the publish route was the one still
 * falling back to the schema default via `api/workflows.ts`'s `budgetFor`).
 * `DEFAULT_WORKFLOW_MAX_TOTAL_MS` stays exported: several `*.test.ts` files
 * in this directory build a `WorkflowExecutorDeps` directly and use it as
 * their own literal default, independent of the live wiring above.
 */
export const DEFAULT_WORKFLOW_MAX_TOTAL_MS = 21_600_000 // 6h — plan 99 §4.10's own default; matches settings.ts's `workflow.maxTotalMs` default exactly

export interface WorkflowSettings {
  maxTotalMs: number
}

/** `job.status`'s `node` block (plan 99 §4.9, `packages/protocol/src/messages/job.ts`). */
export interface JobNodeProgress {
  id: string
  seq: number
  total: number
  kind: 'script' | 'gate'
  script: string | null
  status: JobNodeStatus
}

export interface WorkflowExecutorDeps {
  db: Db
  registry: ScriptRegistry
  runner: JobRunner
  sessions: SessionManager
  /**
   * DEVIATION from §4.7's literal `artifacts: (jobId: string) => ArtifactSink`:
   * there is no seam on `JobSpec`/`JobRunnerDeps` (both `@enkaku/session`,
   * out of this step's file list) that lets one `runner.execute()` call
   * carry its OWN artifact sink — the runner already owns exactly one
   * `artifacts` factory, built once in `daemon.ts` and shared by every job,
   * workflow node or not (`deps.artifacts(job.id)`, called once per
   * `execute()`, confirmed at `job-runner.ts:756`). `nodeTracker` is the
   * real seam: the SAME factory `daemon.ts` hands `createJobRunner` reads
   * `nodeTracker.current(jobId)` at save time
   * (`runner/artifact-store.ts`'s `createArtifactStore`), and this
   * executor's whole job is to call `begin`/`end` around each node's
   * `runner.execute()` call so that accessor has something honest to read.
   * See `runner/artifact-store.ts`'s own doc comment for the full mechanism,
   * including how `job_nodes.attempts` piggybacks on the same window.
   */
  nodeTracker: JobNodeTracker
  /** Read fresh on every check (§3.11) — never captured at daemon start, the same convention every other farm-wide knob in this codebase follows. */
  settings: () => WorkflowSettings
  log: Logger
  /** → WS `job.status`'s `node` block (§4.9). Called on every node transition; never for the bulk "mark unreached nodes skipped" pass at the very end, since the job is settling anyway. */
  onNode: (jobId: string, node: JobNodeProgress) => void
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Mirrors `executors/script.ts`'s own helper — `ScriptEntry.paramsSchema` crosses the DB boundary as `unknown`. */
function asSchemaNode(value: unknown): Record<string, unknown> | undefined {
  return isPlainObject(value) ? value : undefined
}

const toSec = (d: Date): number => Math.floor(d.getTime() / 1000)

/** A reserved node id for the `onFail` cleanup's own `job_nodes` row. `WorkflowNodeIdSchema` forbids `_` in every author-chosen id, so this can never collide with a real one. */
const ON_FAIL_NODE_ID = '_on_fail'

type ScriptNode = Extract<WorkflowNode, { kind: 'script' }>

/** What one script node's resolve → bind → validate → run attempt produced. Never throws — every failure mode becomes a value the interpreter's own `onFailure` policy decides about. */
type NodeRunOutcome =
  | { ok: true; value: unknown; scriptRef: { id: string; name: string; version: string }; attempts: number; peakRssBytes?: number }
  | { ok: false; code: string; message: string; scriptRef?: { id: string; name: string; version: string }; attempts: number; peakRssBytes?: number }

/**
 * Caps a node's output to `WORKFLOW_LIMITS.maxNodeOutputBytes` before it is
 * stored (plan 99 §4.10) — an oversized `job_nodes.output` would make one
 * greedy script poison the whole job's readability (and, since `{ run:
 * 'summary' }` folds every node's output into one array, everyone reading
 * it downstream). `outputTruncated` names the cap and the size that was
 * dropped rather than leaving a silent `null`.
 */
function capOutput(value: unknown): { output: unknown; truncated: string | null } {
  let json: string
  try {
    json = JSON.stringify(value ?? null)
  } catch {
    return { output: null, truncated: 'the node\'s return value could not be serialised to JSON — dropped' }
  }
  const bytes = new TextEncoder().encode(json).length
  if (bytes <= WORKFLOW_LIMITS.maxNodeOutputBytes) return { output: value ?? null, truncated: null }
  return { output: null, truncated: `output was ${bytes} bytes, over the ${WORKFLOW_LIMITS.maxNodeOutputBytes}-byte cap (WORKFLOW_LIMITS.maxNodeOutputBytes) — dropped` }
}

/**
 * The workflow executor (plan 99 §3.1, §3.2, §4.7) — the ONE place §3.1's
 * whole decision cashes out: a `kind: 'workflow'` job runs as ONE job under
 * ONE lease (F1–F6, inherited for free by never releasing it between
 * nodes), holding ONE device session for its whole duration (F11, H1 — the
 * `sessions.acquire`/`release` pair below brackets the entire interpreter
 * loop, so every node's OWN inner acquire/release inside `JobRunner` is
 * just a refcount bump), while every NODE runs as an ordinary script child
 * through the SAME `JobRunner.execute()` every standalone job uses (§3.4) —
 * no second runtime, no second child protocol, no second retry loop
 * (`JobRunner` already retries a node up to its own `retries`/override
 * internally; this file calls `execute()` exactly ONCE per node execution
 * and reads back whatever FINAL outcome the runner already decided).
 */
export function createWorkflowExecutor(deps: WorkflowExecutorDeps): JobExecutor {
  function loadWorkflowEntry(scriptId: string): ScriptEntry {
    const entry = deps.registry.get(scriptId)
    if (!entry) throw new EnkakuError('unknown_script', `no such workflow: ${scriptId}`)
    return entry
  }

  return {
    validateParams(params, scriptId) {
      const entry = loadWorkflowEntry(scriptId)
      const result = validateAgainstSchema(asSchemaNode(entry.paramsSchema), params)
      if (!result.ok) {
        throw new EnkakuError(
          'invalid_job_params',
          result.issues.map((i) => `${i.path}: ${i.message}`).join('; '),
          undefined,
          result.issues,
        )
      }
      return params ?? {}
    },

    async run(job: JobRow, ctx: ExecutorContext): Promise<unknown> {
      const entry = loadWorkflowEntry(job.scriptId)
      if (!entry.enabled) throw new EnkakuError('script_disabled', `the workflow ${entry.name} is disabled`)
      if (entry.bundle.kind !== 'db') throw new EnkakuError('E_WORKFLOW_INVALID', `workflow ${entry.name} has no persisted document`)

      // Never trust a stored blob (00-overview §4.2) — parsed through the
      // SAME Zod schema the publish route validated it with, not an `as`-cast.
      const row = deps.db.select({ bundle: scripts.bundle }).from(scripts).where(eq(scripts.id, entry.bundle.scriptId)).get()
      if (!row) throw new EnkakuError('unknown_script', `no such workflow: ${job.scriptId}`)
      let doc: WorkflowDoc
      try {
        doc = WorkflowDocSchema.parse(JSON.parse(row.bundle))
      } catch (err) {
        throw new EnkakuError('E_WORKFLOW_INVALID', `stored workflow document failed validation: ${err instanceof Error ? err.message : String(err)}`)
      }

      // A cancel from the core aborts whichever node is CURRENTLY running —
      // `JobRunner`'s `active` map is keyed by `job.id`, the SAME id every
      // node execution shares, so this one listener (registered once, for
      // the whole workflow) always reaches the right child (§3.2, §4.7).
      ctx.signal.addEventListener('abort', () => deps.runner.abort(job.id, 'cancelled'))
      ctx.onCrash?.((e) => deps.runner.abort(job.id, 'crashed', `${e.package} crashed: ${e.exception}`))

      // ONE acquire for the whole pipeline (F11, H1) — every node's own
      // inner acquire/release inside `JobRunner` becomes a refcount bump.
      const noopFrame = () => {}
      await deps.sessions.acquire(job.deviceId, noopFrame)

      const params: Record<string, unknown> = isPlainObject(job.params) ? job.params : {}

      // Plan 99 §3.5 — a resumed job's interpreter starts at the node the
      // operator chose (never `doc.nodes[0]`), so it does not re-warm a
      // feed or re-post something that already succeeded. `job_resumes` has
      // at most one row per (new) job id — `POST /:id/resume` (step 99.8,
      // `api/jobs.ts`) is the only writer.
      const resumeInfo = deps.db.select().from(jobResumes).where(eq(jobResumes.jobId, job.id)).get()

      const firstNode = doc.nodes[0]
      // WorkflowDocSchema's own `.min(1)` already makes this unreachable —
      // a runtime guard beats an `as`-cast on the same already-validated fact.
      if (!firstNode) throw new EnkakuError('E_WORKFLOW_INVALID', `workflow ${entry.name} has no nodes`)
      let cursor: string | null = resumeInfo?.resumedFromNode ?? firstNode.id

      const outputs = new Map<string, unknown>()
      const summary: RunSummaryEntry[] = []
      const nodesById = new Map(doc.nodes.map((n) => [n.id, n]))
      const runCounts = new Map<string, number>()
      let peakRssBytes: number | undefined

      // Consumed by the FIRST `job_nodes` row THIS job writes — whether
      // that is a 'skipped-on-resume' row below, or (when the resume point
      // IS `doc.nodes[0]`, so nothing is skipped) the resumed node's own
      // 'running' row in the main loop. §3.5: "records resumedFromJobId and
      // resumedFromNode on the new job's first job_nodes row."
      let pendingResumeLineage: { resumedFromJobId: string; resumedFromNode: string } | null = resumeInfo
        ? { resumedFromJobId: resumeInfo.resumedFromJobId, resumedFromNode: resumeInfo.resumedFromNode }
        : null

      // How many `job_nodes` rows were written below, before the
      // interpreter loop's own `step`-based numbering starts at 0 again —
      // offsets `seq` so a resumed job's timeline reads as one continuous
      // sequence instead of restarting. Deliberately NOT folded into `step`
      // itself: `step === 0` must still mean "the very first execution IN
      // THIS JOB" for the `reset: 'farm'` decision at `runScriptNode`'s call
      // site below (already documented there) — a resumed job's own first
      // execution gets a farm reset exactly like any other new job's does,
      // because nobody can vouch for the device's state in between (§3.5).
      let seqOffset = 0
      const resumeSkippedIds = new Set<string>()

      if (resumeInfo) {
        // Carry the original job's completed outputs into scope (§3.6) —
        // later `seq` overwrites earlier, the same rule `ResolveScope.outputs`
        // already documents for a normal (non-resumed) run.
        const priorRows = deps.db
          .select()
          .from(jobNodes)
          .where(and(eq(jobNodes.jobId, resumeInfo.resumedFromJobId), eq(jobNodes.status, 'success')))
          .orderBy(asc(jobNodes.seq))
          .all()
        for (const r of priorRows) outputs.set(r.nodeId, r.output)
        const priorByNodeId = new Map(priorRows.map((r) => [r.nodeId, r]))

        // Every node BEFORE the resume point, in doc order, is recorded as
        // replayed rather than re-executed (H4 — a workflow's history is
        // never a blank gap) — mirrors the 'skipped' bulk-write the
        // `finally` block below already does for the nodes the cursor never
        // reaches.
        const resumeIdx = doc.nodes.findIndex((n) => n.id === resumeInfo.resumedFromNode)
        const beforeResume = resumeIdx > 0 ? doc.nodes.slice(0, resumeIdx) : []
        for (const n of beforeResume) {
          resumeSkippedIds.add(n.id)
          const prior = priorByNodeId.get(n.id)
          const lineage = pendingResumeLineage
          pendingResumeLineage = null
          deps.db
            .insert(jobNodes)
            .values({
              id: crypto.randomUUID(),
              jobId: job.id,
              seq: seqOffset,
              nodeId: n.id,
              kind: n.kind,
              scriptId: prior?.scriptId ?? null,
              scriptName: prior?.scriptName ?? null,
              scriptVersion: prior?.scriptVersion ?? null,
              status: 'skipped-on-resume',
              attempts: 0,
              startedAt: null,
              finishedAt: null,
              output: prior?.output ?? null,
              outputTruncated: prior?.outputTruncated ?? null,
              verdict: null,
              error: null,
              errorCode: null,
              resumedFromJobId: lineage?.resumedFromJobId ?? null,
              resumedFromNode: lineage?.resumedFromNode ?? null,
            })
            .run()
          seqOffset += 1
        }
      }

      const nextInArray = (id: string): string | null => {
        const idx = doc.nodes.findIndex((n) => n.id === id)
        return idx >= 0 && idx + 1 < doc.nodes.length ? (doc.nodes[idx + 1] as WorkflowNode).id : null
      }

      /** `undefined` outcome means "workflow keeps running, at this node next"; a defined one means "the workflow is done, here." */
      function followOutcome(outcome: GateOutcome, fromNodeId: string): { done: false; nodeId: string } | { done: true; ok: boolean } {
        if (outcome.go === 'goto') return { done: false, nodeId: outcome.node }
        if (outcome.go === 'continue') {
          const next = nextInArray(fromNodeId)
          return next ? { done: false, nodeId: next } : { done: true, ok: true }
        }
        if (outcome.go === 'stop') return { done: true, ok: true }
        return { done: true, ok: false } // 'fail'
      }

      function followSuccess(node: ScriptNode): { done: false; nodeId: string } | { done: true; ok: true } {
        const next = node.next ?? nextInArray(node.id)
        return next ? { done: false, nodeId: next } : { done: true, ok: true }
      }

      /** Resolve → validate → spawn, for ONE script node. Never throws — every failure becomes an `ok: false` outcome the caller's `onFailure` policy decides about. Retries are entirely `JobRunner`'s own (§3.4) — this calls `execute()` exactly once. */
      async function runScriptNode(node: ScriptNode, step: number): Promise<NodeRunOutcome> {
        let entry: ScriptEntry
        try {
          entry = deps.registry.resolve(node.script)
        } catch (err) {
          return {
            ok: false,
            code: err instanceof EnkakuError ? err.code : 'E_WORKFLOW_SCRIPT_UNRESOLVED',
            message: err instanceof Error ? err.message : String(err),
            attempts: 0,
          }
        }
        const scriptRef = { id: entry.id, name: entry.name, version: entry.version }

        const scope: ResolveScope = { params, outputs, summary }
        const resolvedParams: Record<string, unknown> = {}
        for (const [key, expr] of Object.entries(node.params)) {
          const outcome = resolveValue(expr, scope)
          if (!outcome.ok) {
            const seen = outcome.sawKeys ? ` — available: ${outcome.sawKeys.join(', ')}` : ''
            return {
              ok: false,
              code: 'E_WORKFLOW_BINDING_UNRESOLVED',
              message: `node "${node.id}" parameter "${key}": ${outcome.detail}${seen}`,
              scriptRef,
              attempts: 0,
            }
          }
          resolvedParams[key] = outcome.value
        }

        const check = validateAgainstSchema(asSchemaNode(entry.paramsSchema), resolvedParams)
        if (!check.ok) {
          return {
            ok: false,
            code: 'invalid_job_params',
            message: `node "${node.id}": ${check.issues.map((i) => `${i.path}: ${i.message}`).join('; ')}`,
            scriptRef,
            attempts: 0,
          }
        }

        deps.nodeTracker.begin(job.id, node.id)
        try {
          const bundlePath = await deps.registry.bundlePath(entry)
          const result = await deps.runner.execute({
            id: job.id,
            deviceId: job.deviceId,
            bundlePath,
            params: resolvedParams,
            ...(entry.exportId ? { scriptExportId: entry.exportId } : {}),
            // §3.3, §4.8 — 'farm' only for the very first execution IN THIS
            // JOB (not "array index 0": a resumed job's first executed node,
            // 99.8, is not `doc.nodes[0]` either, and this is the same test).
            reset: node.reset ?? (step === 0 ? 'farm' : 'none'),
            nodeId: node.id, // closes F20 — jobs-client.ts's trigger key
            ...(node.retries !== undefined ? { retries: node.retries } : {}),
          })
          const attempts = deps.nodeTracker.attempts(job.id) || 1
          if (!result.ok) {
            const err = result.error ?? { code: 'SCRIPT_FAILED', message: 'the script failed', phase: 'run' }
            return {
              ok: false,
              code: err.code,
              message: err.message,
              scriptRef,
              attempts,
              ...(result.peakRssBytes !== undefined ? { peakRssBytes: result.peakRssBytes } : {}),
            }
          }
          return {
            ok: true,
            value: result.value ?? null,
            scriptRef,
            attempts,
            ...(result.peakRssBytes !== undefined ? { peakRssBytes: result.peakRssBytes } : {}),
          }
        } finally {
          deps.nodeTracker.end(job.id)
        }
      }

      const startedAt = Date.now()
      let step = 0
      let finalStatus: 'success' | 'failed' = 'success'
      let finalErrorCode: string | undefined
      let finalErrorMessage: string | undefined
      let cancelled = false

      try {
        while (cursor) {
          ctx.signal.throwIfAborted()

          const maxTotalMs = deps.settings().maxTotalMs
          const elapsedMs = Date.now() - startedAt
          if (elapsedMs > maxTotalMs) {
            finalStatus = 'failed'
            finalErrorCode = 'E_WORKFLOW_BUDGET_EXCEEDED'
            finalErrorMessage = `the workflow's ${maxTotalMs}ms total budget (workflow.maxTotalMs) was exceeded while node "${cursor}" was in flight (${elapsedMs}ms elapsed)`
            cursor = null
            break
          }
          if (step >= doc.maxSteps) {
            const counts = [...runCounts.entries()].map(([id, n]) => `${id}×${n}`).join(', ')
            finalStatus = 'failed'
            finalErrorCode = 'E_WORKFLOW_STEP_BUDGET'
            finalErrorMessage = `the workflow's step budget (maxSteps: ${doc.maxSteps}) was exceeded on node "${cursor}" — executions so far: ${counts}`
            cursor = null
            break
          }

          const node = nodesById.get(cursor)
          if (!node) {
            // checkWorkflow (step 99.6) refuses every dangling goto/next at
            // publish — reachable only if a document somehow bypassed it.
            finalStatus = 'failed'
            finalErrorCode = 'E_WORKFLOW_INVALID'
            finalErrorMessage = `node "${cursor}" does not exist in this workflow's document`
            cursor = null
            break
          }

          const seq = step + seqOffset
          runCounts.set(node.id, (runCounts.get(node.id) ?? 0) + 1)
          const rowId = crypto.randomUUID()
          const rowStartedAt = new Date()
          // Consumes `pendingResumeLineage` exactly once — on whichever row
          // is the first this job ever writes (see the comment where it is
          // declared, above).
          const lineage = pendingResumeLineage
          pendingResumeLineage = null
          deps.db
            .insert(jobNodes)
            .values({
              id: rowId,
              jobId: job.id,
              seq,
              nodeId: node.id,
              kind: node.kind,
              scriptId: null,
              scriptName: null,
              scriptVersion: null,
              status: 'running',
              attempts: 0,
              startedAt: rowStartedAt,
              finishedAt: null,
              output: null,
              outputTruncated: null,
              verdict: null,
              error: null,
              errorCode: null,
              resumedFromJobId: lineage?.resumedFromJobId ?? null,
              resumedFromNode: lineage?.resumedFromNode ?? null,
            })
            .run()
          deps.onNode(job.id, {
            id: node.id,
            seq,
            total: doc.nodes.length,
            kind: node.kind,
            script: node.kind === 'script' ? node.script : null,
            status: 'running',
          })

          if (node.kind === 'gate') {
            const scope: ResolveScope = { params, outputs, summary }
            const { value, trace } = evaluatePredicate(node.when, scope)
            const chosen = value ? node.then : node.else
            const finishedAt = new Date()
            deps.db.update(jobNodes).set({ status: 'success', finishedAt, verdict: trace }).where(eq(jobNodes.id, rowId)).run()
            deps.onNode(job.id, { id: node.id, seq, total: doc.nodes.length, kind: 'gate', script: null, status: 'success' })
            summary.push({
              nodeId: node.id,
              script: null,
              status: 'success',
              startedAt: toSec(rowStartedAt),
              finishedAt: toSec(finishedAt),
              durationMs: finishedAt.getTime() - rowStartedAt.getTime(),
              output: { value, branch: chosen.go },
            })

            const next = followOutcome(chosen, node.id)
            step += 1
            if (next.done) {
              cursor = null
              if (!next.ok) {
                finalStatus = 'failed'
                finalErrorCode = 'E_WORKFLOW_GATE_FAILED'
                finalErrorMessage = node.message || `gate "${node.id}" chose to end the workflow failed`
              }
            } else {
              cursor = next.nodeId
            }
            continue
          }

          // A script node.
          const result = await runScriptNode(node, step)
          const finishedAt = new Date()
          if (result.peakRssBytes !== undefined && (peakRssBytes === undefined || result.peakRssBytes > peakRssBytes)) {
            peakRssBytes = result.peakRssBytes
          }

          if (result.ok) {
            outputs.set(node.id, result.value)
            const { output, truncated } = capOutput(result.value)
            deps.db
              .update(jobNodes)
              .set({
                status: 'success',
                finishedAt,
                attempts: result.attempts,
                scriptId: result.scriptRef.id,
                scriptName: result.scriptRef.name,
                scriptVersion: result.scriptRef.version,
                output,
                outputTruncated: truncated,
              })
              .where(eq(jobNodes.id, rowId))
              .run()
            const scriptLabel = `${result.scriptRef.name}@${result.scriptRef.version}`
            deps.onNode(job.id, { id: node.id, seq, total: doc.nodes.length, kind: 'script', script: scriptLabel, status: 'success' })
            summary.push({
              nodeId: node.id,
              script: scriptLabel,
              status: 'success',
              startedAt: toSec(rowStartedAt),
              finishedAt: toSec(finishedAt),
              durationMs: finishedAt.getTime() - rowStartedAt.getTime(),
              output: result.value ?? null,
            })

            const next = followSuccess(node)
            step += 1
            if (next.done) cursor = null
            else cursor = next.nodeId
            continue
          }

          // A script node failed — persist first, THEN decide the branch (§4.7: "every transition is persisted before it is taken").
          deps.db
            .update(jobNodes)
            .set({
              status: 'failed',
              finishedAt,
              attempts: result.attempts,
              error: result.message,
              errorCode: result.code,
              ...(result.scriptRef ? { scriptId: result.scriptRef.id, scriptName: result.scriptRef.name, scriptVersion: result.scriptRef.version } : {}),
            })
            .where(eq(jobNodes.id, rowId))
            .run()
          const failedScriptLabel = result.scriptRef ? `${result.scriptRef.name}@${result.scriptRef.version}` : node.script
          deps.onNode(job.id, { id: node.id, seq, total: doc.nodes.length, kind: 'script', script: failedScriptLabel, status: 'failed' })
          summary.push({
            nodeId: node.id,
            script: failedScriptLabel,
            status: 'failed',
            startedAt: toSec(rowStartedAt),
            finishedAt: toSec(finishedAt),
            durationMs: finishedAt.getTime() - rowStartedAt.getTime(),
            output: null,
          })
          step += 1

          // A cancel is never "continuable" — it ends the workflow right
          // here regardless of `node.onFailure`, matching how a cancel
          // already behaves for a standalone job (criterion 16).
          if (result.code === 'CANCELLED' || result.code === 'job_cancelled') {
            cancelled = true
            finalStatus = 'failed'
            finalErrorCode = 'job_cancelled'
            finalErrorMessage = result.message
            cursor = null
            continue
          }

          const next = followOutcome(node.onFailure, node.id)
          if (next.done) {
            cursor = null
            if (!next.ok) {
              finalStatus = 'failed'
              finalErrorCode = result.code
              finalErrorMessage = `node "${node.id}" failed: ${result.message}`
            }
            // `next.ok` (onFailure: 'stop') → the workflow ends SUCCESSFULLY despite this node's failure.
          } else {
            cursor = next.nodeId
          }
        }
      } catch (err) {
        finalStatus = 'failed'
        cancelled = ctx.signal.aborted && !(err instanceof EnkakuError)
        finalErrorCode = cancelled ? 'job_cancelled' : err instanceof EnkakuError ? err.code : 'E_WORKFLOW_INTERNAL'
        finalErrorMessage = err instanceof Error ? err.message : String(err)
      } finally {
        // Every node the cursor never reached is written down too (H4) —
        // a workflow's history is never a blank gap, including the nodes it
        // decided not to run.
        let skipSeq = step + seqOffset
        for (const n of doc.nodes) {
          if (runCounts.has(n.id) || resumeSkippedIds.has(n.id)) continue
          deps.db
            .insert(jobNodes)
            .values({
              id: crypto.randomUUID(),
              jobId: job.id,
              seq: skipSeq,
              nodeId: n.id,
              kind: n.kind,
              scriptId: null,
              scriptName: null,
              scriptVersion: null,
              status: 'skipped',
              attempts: 0,
              startedAt: null,
              finishedAt: null,
              output: null,
              outputTruncated: null,
              verdict: null,
              error: null,
              errorCode: null,
              resumedFromJobId: null,
              resumedFromNode: null,
            })
            .run()
          skipSeq += 1
        }

        // The workflow's own cleanup (§3.2, §4.1) — best-effort, exactly
        // once, only on a genuine failure (never on a cancel: the operator
        // already asked for the pipeline to stop right where it is).
        if (finalStatus === 'failed' && !cancelled && doc.onFail) {
          try {
            const cleanupScope: ResolveScope = { params, outputs, summary }
            const cleanupEntry = deps.registry.resolve(doc.onFail.script)
            const resolvedParams: Record<string, unknown> = {}
            let bindingOk = true
            for (const [key, expr] of Object.entries(doc.onFail.params)) {
              const outcome = resolveValue(expr, cleanupScope)
              if (!outcome.ok) {
                bindingOk = false
                deps.log.warn(`workflow ${job.scriptId}: onFail cleanup parameter "${key}" did not resolve (${outcome.detail}) — cleanup skipped`)
                break
              }
              resolvedParams[key] = outcome.value
            }
            if (bindingOk) {
              const check = validateAgainstSchema(asSchemaNode(cleanupEntry.paramsSchema), resolvedParams)
              if (!check.ok) {
                deps.log.warn(`workflow ${job.scriptId}: onFail cleanup params failed validation — cleanup skipped`)
              } else {
                const cleanupRowId = crypto.randomUUID()
                const cleanupStarted = new Date()
                deps.db
                  .insert(jobNodes)
                  .values({
                    id: cleanupRowId,
                    jobId: job.id,
                    seq: skipSeq,
                    nodeId: ON_FAIL_NODE_ID,
                    kind: 'script',
                    scriptId: cleanupEntry.id,
                    scriptName: cleanupEntry.name,
                    scriptVersion: cleanupEntry.version,
                    status: 'running',
                    attempts: 0,
                    startedAt: cleanupStarted,
                    finishedAt: null,
                    output: null,
                    outputTruncated: null,
                    verdict: null,
                    error: null,
                    errorCode: null,
                    resumedFromJobId: null,
                    resumedFromNode: null,
                  })
                  .run()
                deps.nodeTracker.begin(job.id, ON_FAIL_NODE_ID)
                try {
                  const bundlePath = await deps.registry.bundlePath(cleanupEntry)
                  const result = await deps.runner.execute({
                    id: job.id,
                    deviceId: job.deviceId,
                    bundlePath,
                    params: resolvedParams,
                    ...(cleanupEntry.exportId ? { scriptExportId: cleanupEntry.exportId } : {}),
                    reset: 'none', // the cleanup needs the state the failure left, exactly like a `finish-only` attempt (F14)
                    nodeId: ON_FAIL_NODE_ID,
                  })
                  const cleanupFinished = new Date()
                  const cleanupAttempts = deps.nodeTracker.attempts(job.id) || 1
                  if (result.peakRssBytes !== undefined && (peakRssBytes === undefined || result.peakRssBytes > peakRssBytes)) {
                    peakRssBytes = result.peakRssBytes
                  }
                  deps.db
                    .update(jobNodes)
                    .set({
                      status: result.ok ? 'success' : 'failed',
                      finishedAt: cleanupFinished,
                      attempts: cleanupAttempts,
                      ...(result.ok
                        ? {}
                        : { error: result.error?.message ?? 'onFail cleanup failed', errorCode: result.error?.code ?? 'CLEANUP_FAILED' }),
                    })
                    .where(eq(jobNodes.id, cleanupRowId))
                    .run()
                } finally {
                  deps.nodeTracker.end(job.id)
                }
              }
            }
          } catch (err) {
            deps.log.warn(`workflow ${job.scriptId}: onFail cleanup threw, tolerated: ${err instanceof Error ? err.message : String(err)}`)
          }
        }

        // ONLY place the session is released (§4.7) — no early return above ever skips this.
        deps.sessions.release(job.deviceId, noopFrame)
      }

      if (peakRssBytes !== undefined) ctx.onPeakRss?.(peakRssBytes)

      if (finalStatus === 'failed') {
        throw new EnkakuError(finalErrorCode ?? 'E_WORKFLOW_FAILED', finalErrorMessage ?? 'the workflow failed')
      }
      return summary
    },
  }
}
