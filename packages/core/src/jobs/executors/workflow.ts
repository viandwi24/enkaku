import { and, eq } from 'drizzle-orm'
import {
  evaluatePredicate,
  resolveValue,
  validateAgainstSchema,
  WORKFLOW_LIMITS,
  type GateOutcome,
  type ResolveScope,
  type RunSummaryEntry,
  type WorkflowDoc,
  type WorkflowNode,
} from '@enkaku/protocol'
import type { Db } from '../../db'
import { workflowSteps, type JobRow, type JobRunRow } from '../../db/schema'
import { parseWorkflowDoc } from '../../workflows/store'
import type { ScriptEntry, ScriptRegistry } from '../../scripts/registry'
import { EnkakuError } from '../../util/errors'
import type { Logger } from '../../util/logger'
import type { ExecutorContext, JobExecutor } from '../executor'
import type { RunStore } from '../runs/store'
import type { RunWatcher } from '../runs/watcher'

/**
 * Plan 99 §3.11, rewritten by plan 211 — the workflow's OWN clock, separate
 * from a step's own script timeout and from `maxSteps` (a count, not a
 * duration, checked below). This is the coarse backstop: "how long may one
 * device be held by one pipeline."
 */
export const DEFAULT_WORKFLOW_MAX_TOTAL_MS = 21_600_000 // 6h

export interface WorkflowSettings {
  maxTotalMs: number
}

export interface WorkflowOrchestratorDeps {
  db: Db
  runs: RunStore
  watcher: RunWatcher
  registry: ScriptRegistry
  /** Enqueue one step job and its first run, then kick the scheduler (`services/job-service.ts`'s `enqueueStep`). */
  enqueueStep: (input: {
    parentWorkflowJobId: string
    stepSeq: number
    scriptId: string
    deviceId: string
    params: Record<string, unknown>
    scriptName: string
    scriptVersion: string
    priority: number
  }) => { job: JobRow; run: JobRunRow }
  /** Cancels a step's run when the workflow run is cancelled (`JobService.cancel`). */
  cancelRun: (runId: string) => void
  /** Read fresh on every check (`workflow.maxTotalMs`). */
  settings: () => WorkflowSettings
  log: Logger
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function asSchemaNode(value: unknown): Record<string, unknown> | undefined {
  return isPlainObject(value) ? value : undefined
}

const toSec = (d: Date): number => Math.floor(d.getTime() / 1000)

/** A reserved step id for the `onFail` cleanup's own row. `WorkflowNodeIdSchema` forbids `_` in every author-chosen id, so this can never collide with a real one. */
const ON_FAIL_STEP_ID = '_on_fail'

type ScriptNode = Extract<WorkflowNode, { kind: 'script' }>

function capOutput(value: unknown): { output: unknown; truncated: string | null } {
  let json: string
  try {
    json = JSON.stringify(value ?? null)
  } catch {
    return { output: null, truncated: "the step's return value could not be serialised to JSON — dropped" }
  }
  const bytes = new TextEncoder().encode(json).length
  if (bytes <= WORKFLOW_LIMITS.maxNodeOutputBytes) return { output: value ?? null, truncated: null }
  return { output: null, truncated: `output was ${bytes} bytes, over the ${WORKFLOW_LIMITS.maxNodeOutputBytes}-byte cap (WORKFLOW_LIMITS.maxNodeOutputBytes) — dropped` }
}

/**
 * The workflow orchestrator (MVP 05 §1.2, plan 211 §4.5) — a `kind: 'workflow'`
 * job's own executor. It spawns NO child process of its own: each script
 * step is enqueued as an ordinary script job (`enqueueStep`), the orchestrator
 * awaits that job's own run through `RunWatcher.waitForTerminal`, and records
 * the step in `workflow_steps` pointing at the child's `(jobId, runId)`. It
 * holds the device only through its own `workflow-job:<runId>` activity
 * (started by the scheduler on claim) — never through `sessions.acquire`.
 */
export function createWorkflowOrchestrator(deps: WorkflowOrchestratorDeps): JobExecutor {
  return {
    validateParams(params) {
      // A workflow job's params are validated against the DOCUMENT's own
      // declared params at creation time (`services/job-service.ts`'s
      // `enqueueWorkflow`, plan 211 §4.8) — this executor's `validateParams`
      // is never reached for a workflow job (no scriptId to look up against),
      // so it is the identity function.
      return params ?? {}
    },

    async run(job: JobRow, ctx: ExecutorContext): Promise<unknown> {
      const doc = parseWorkflowDoc(job.workflowDoc)
      if (!doc) throw new EnkakuError('E_WORKFLOW_INVALID', `workflow job ${job.id} carries no valid workflow document`)

      const params: Record<string, unknown> = isPlainObject(job.params) ? job.params : {}
      const outputs = new Map<string, unknown>()
      const summary: RunSummaryEntry[] = []
      const nodesById = new Map(doc.nodes.map((n) => [n.id, n]))
      const runCounts = new Map<string, number>()

      let seqOffset = 0
      const carriedOverIds = new Set<string>()

      const firstNode = doc.nodes[0]
      if (!firstNode) throw new EnkakuError('E_WORKFLOW_INVALID', `workflow ${job.id} has no nodes`)
      let cursor: string | null = firstNode.id

      // ---- resume (plan 211 §4.5 item 2) ----
      if (ctx.run.trigger === 'resume' && ctx.run.resumedFromRunId) {
        const priorRunId = ctx.run.resumedFromRunId
        const resumedFromStep = ctx.run.resumedFromStep ?? 0
        const priorSteps = deps.db.select().from(workflowSteps).where(eq(workflowSteps.runId, priorRunId)).orderBy(workflowSteps.seq).all()
        for (const s of priorSteps) {
          if (s.seq >= resumedFromStep) break
          if (s.status !== 'success' && s.status !== 'carried-over') continue
          outputs.set(s.stepId, s.output)
          carriedOverIds.add(s.stepId)
          deps.db
            .insert(workflowSteps)
            .values({
              id: crypto.randomUUID(),
              runId: ctx.runId,
              seq: seqOffset,
              stepId: s.stepId,
              kind: s.kind,
              jobId: s.jobId,
              jobRunId: s.jobRunId,
              status: 'carried-over',
              startedAt: s.startedAt,
              finishedAt: s.finishedAt,
              output: s.output,
              outputTruncated: s.outputTruncated,
              verdict: s.verdict,
              error: null,
              errorCode: null,
            })
            .run()
          seqOffset += 1
        }
        const resumeStepRow = priorSteps.find((s) => s.seq === resumedFromStep)
        cursor = resumeStepRow?.stepId ?? firstNode.id
      }

      const nextInArray = (id: string): string | null => {
        const idx = doc.nodes.findIndex((n) => n.id === id)
        return idx >= 0 && idx + 1 < doc.nodes.length ? (doc.nodes[idx + 1] as WorkflowNode).id : null
      }

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

      /** Enqueue one step job, await its run, and translate the settled run into an outcome. Never throws. */
      async function runScriptStep(
        node: ScriptNode,
        stepSeq: number,
      ): Promise<{ ok: true; run: JobRunRow; scriptRef: { id: string; name: string; version: string } } | { ok: false; code: string; message: string; run?: JobRunRow; scriptRef?: { id: string; name: string; version: string } }> {
        let entry: ScriptEntry
        try {
          entry = deps.registry.resolve(node.script)
        } catch (err) {
          return {
            ok: false,
            code: err instanceof EnkakuError ? err.code : 'E_WORKFLOW_SCRIPT_UNRESOLVED',
            message: err instanceof Error ? err.message : String(err),
          }
        }
        const scriptRef = { id: entry.id, name: entry.name, version: entry.version }

        const scope: ResolveScope = { params, outputs, summary }
        const resolvedParams: Record<string, unknown> = {}
        for (const [key, expr] of Object.entries(node.params)) {
          const outcome = resolveValue(expr, scope)
          if (!outcome.ok) {
            const seen = outcome.sawKeys ? ` — available: ${outcome.sawKeys.join(', ')}` : ''
            return { ok: false, code: 'E_WORKFLOW_BINDING_UNRESOLVED', message: `step "${node.id}" parameter "${key}": ${outcome.detail}${seen}`, scriptRef }
          }
          resolvedParams[key] = outcome.value
        }

        const check = validateAgainstSchema(asSchemaNode(entry.paramsSchema), resolvedParams)
        if (!check.ok) {
          return { ok: false, code: 'invalid_job_params', message: `step "${node.id}": ${check.issues.map((i) => `${i.path}: ${i.message}`).join('; ')}`, scriptRef }
        }

        const { job: stepJob, run: stepRun } = deps.enqueueStep({
          parentWorkflowJobId: job.id,
          stepSeq,
          scriptId: entry.id,
          deviceId: job.deviceId,
          params: resolvedParams,
          scriptName: entry.name,
          scriptVersion: entry.version,
          priority: 0,
        })

        const settled = await deps.watcher.waitForTerminal(stepRun.id, ctx.signal)
        void stepJob
        if (settled.status !== 'success') {
          const err = settled.error ?? 'the step failed'
          return { ok: false, code: settled.failureClass ?? 'SCRIPT_FAILED', message: err, run: settled, scriptRef }
        }
        return { ok: true, run: settled, scriptRef }
      }

      const startedAt = Date.now()
      let step = 0
      let finalStatus: 'success' | 'failed' = 'success'
      let finalErrorCode: string | undefined
      let finalErrorMessage: string | undefined
      let cancelled = false
      let currentChildRunId: string | null = null

      const onAbort = () => {
        if (currentChildRunId) deps.cancelRun(currentChildRunId)
      }
      ctx.signal.addEventListener('abort', onAbort)

      try {
        while (cursor) {
          ctx.signal.throwIfAborted()

          const maxTotalMs = deps.settings().maxTotalMs
          const elapsedMs = Date.now() - startedAt
          if (elapsedMs > maxTotalMs) {
            finalStatus = 'failed'
            finalErrorCode = 'E_WORKFLOW_BUDGET_EXCEEDED'
            finalErrorMessage = `the workflow's ${maxTotalMs}ms total budget (workflow.maxTotalMs) was exceeded while step "${cursor}" was in flight (${elapsedMs}ms elapsed)`
            cursor = null
            break
          }
          if (step >= doc.maxSteps) {
            const counts = [...runCounts.entries()].map(([id, n]) => `${id}×${n}`).join(', ')
            finalStatus = 'failed'
            finalErrorCode = 'E_WORKFLOW_STEP_BUDGET'
            finalErrorMessage = `the workflow's step budget (maxSteps: ${doc.maxSteps}) was exceeded on step "${cursor}" — executions so far: ${counts}`
            cursor = null
            break
          }

          const node = nodesById.get(cursor)
          if (!node) {
            finalStatus = 'failed'
            finalErrorCode = 'E_WORKFLOW_INVALID'
            finalErrorMessage = `step "${cursor}" does not exist in this workflow's document`
            cursor = null
            break
          }

          const seq = step + seqOffset
          runCounts.set(node.id, (runCounts.get(node.id) ?? 0) + 1)
          const rowId = crypto.randomUUID()
          const rowStartedAt = new Date()
          deps.db
            .insert(workflowSteps)
            .values({
              id: rowId,
              runId: ctx.runId,
              seq,
              stepId: node.id,
              kind: node.kind,
              jobId: null,
              jobRunId: null,
              status: 'running',
              startedAt: rowStartedAt,
              finishedAt: null,
              output: null,
              outputTruncated: null,
              verdict: null,
              error: null,
              errorCode: null,
            })
            .run()

          if (node.kind === 'gate') {
            const scope: ResolveScope = { params, outputs, summary }
            const { value, trace } = evaluatePredicate(node.when, scope)
            const chosen = value ? node.then : node.else
            const finishedAt = new Date()
            deps.db.update(workflowSteps).set({ status: 'success', finishedAt, verdict: trace, output: { value, branch: chosen.go } }).where(eq(workflowSteps.id, rowId)).run()
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

          // A script step.
          const outcome = await runScriptStep(node, step)
          if (outcome.run) currentChildRunId = outcome.run.id
          const finishedAt = new Date()

          if (outcome.ok) {
            outputs.set(node.id, outcome.run.result)
            const { output, truncated } = capOutput(outcome.run.result)
            deps.db
              .update(workflowSteps)
              .set({ status: 'success', finishedAt, jobId: outcome.run.jobId, jobRunId: outcome.run.id, output, outputTruncated: truncated })
              .where(eq(workflowSteps.id, rowId))
              .run()
            const scriptLabel = `${outcome.scriptRef.name}@${outcome.scriptRef.version}`
            summary.push({
              nodeId: node.id,
              script: scriptLabel,
              status: 'success',
              startedAt: toSec(rowStartedAt),
              finishedAt: toSec(finishedAt),
              durationMs: finishedAt.getTime() - rowStartedAt.getTime(),
              output: outcome.run.result ?? null,
            })
            currentChildRunId = null

            const next = followSuccess(node)
            step += 1
            if (next.done) cursor = null
            else cursor = next.nodeId
            continue
          }

          // A script step failed — persist first, THEN decide the branch.
          deps.db
            .update(workflowSteps)
            .set({
              status: outcome.run?.status === 'cancelled' ? 'cancelled' : 'failed',
              finishedAt,
              error: outcome.message,
              errorCode: outcome.code,
              ...(outcome.run ? { jobId: outcome.run.jobId, jobRunId: outcome.run.id } : {}),
            })
            .where(eq(workflowSteps.id, rowId))
            .run()
          currentChildRunId = null
          const failedScriptLabel = outcome.scriptRef ? `${outcome.scriptRef.name}@${outcome.scriptRef.version}` : node.script
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

          if (outcome.run?.status === 'cancelled' || outcome.code === 'job_cancelled') {
            cancelled = true
            finalStatus = 'failed'
            finalErrorCode = 'job_cancelled'
            finalErrorMessage = outcome.message
            cursor = null
            continue
          }

          const next = followOutcome(node.onFailure, node.id)
          if (next.done) {
            cursor = null
            if (!next.ok) {
              finalStatus = 'failed'
              finalErrorCode = outcome.code
              finalErrorMessage = `step "${node.id}" failed: ${outcome.message}`
            }
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
        ctx.signal.removeEventListener('abort', onAbort)

        // Every step the cursor never reached is written down too (H4).
        let skipSeq = step + seqOffset
        for (const n of doc.nodes) {
          if (runCounts.has(n.id) || carriedOverIds.has(n.id)) continue
          deps.db
            .insert(workflowSteps)
            .values({
              id: crypto.randomUUID(),
              runId: ctx.runId,
              seq: skipSeq,
              stepId: n.id,
              kind: n.kind,
              jobId: null,
              jobRunId: null,
              status: 'skipped',
              startedAt: null,
              finishedAt: null,
              output: null,
              outputTruncated: null,
              verdict: null,
              error: null,
              errorCode: null,
            })
            .run()
          skipSeq += 1
        }

        // The workflow's own cleanup — best-effort, exactly once, only on a
        // genuine failure (never on a cancel).
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
                deps.log.warn(`workflow ${job.id}: onFail cleanup parameter "${key}" did not resolve (${outcome.detail}) — cleanup skipped`)
                break
              }
              resolvedParams[key] = outcome.value
            }
            if (bindingOk) {
              const check = validateAgainstSchema(asSchemaNode(cleanupEntry.paramsSchema), resolvedParams)
              if (!check.ok) {
                deps.log.warn(`workflow ${job.id}: onFail cleanup params failed validation — cleanup skipped`)
              } else {
                const { run: cleanupRun } = deps.enqueueStep({
                  parentWorkflowJobId: job.id,
                  stepSeq: skipSeq,
                  scriptId: cleanupEntry.id,
                  deviceId: job.deviceId,
                  params: resolvedParams,
                  scriptName: cleanupEntry.name,
                  scriptVersion: cleanupEntry.version,
                  priority: 0,
                })
                deps.db
                  .insert(workflowSteps)
                  .values({
                    id: crypto.randomUUID(),
                    runId: ctx.runId,
                    seq: skipSeq,
                    stepId: ON_FAIL_STEP_ID,
                    kind: 'script',
                    jobId: cleanupRun.jobId,
                    jobRunId: cleanupRun.id,
                    status: 'running',
                    startedAt: new Date(),
                    finishedAt: null,
                    output: null,
                    outputTruncated: null,
                    verdict: null,
                    error: null,
                    errorCode: null,
                  })
                  .run()
                const settledCleanup = await deps.watcher.waitForTerminal(cleanupRun.id, new AbortController().signal)
                deps.db
                  .update(workflowSteps)
                  .set({
                    status: settledCleanup.status === 'success' ? 'success' : 'failed',
                    finishedAt: new Date(),
                    ...(settledCleanup.status === 'success' ? {} : { error: settledCleanup.error ?? 'onFail cleanup failed', errorCode: settledCleanup.failureClass ?? 'CLEANUP_FAILED' }),
                  })
                  .where(and(eq(workflowSteps.runId, ctx.runId), eq(workflowSteps.stepId, ON_FAIL_STEP_ID)))
                  .run()
              }
            }
          } catch (err) {
            deps.log.warn(`workflow ${job.id}: onFail cleanup threw, tolerated: ${err instanceof Error ? err.message : String(err)}`)
          }
        }
      }

      if (finalStatus === 'failed') {
        throw new EnkakuError(finalErrorCode ?? 'E_WORKFLOW_FAILED', finalErrorMessage ?? 'the workflow failed')
      }
      return summary
    },
  }
}
