import { and, eq } from 'drizzle-orm'
import { deriveRandom } from '@enkaku/expr'
import {
  evaluatePredicate,
  resolveValue,
  setPath,
  validateAgainstSchema,
  WORKFLOW_LIMITS,
  type ResolveScope,
  type RunSummaryEntry,
  type WorkflowDoc,
  type WorkflowNode,
} from '@enkaku/protocol'
import type { Db } from '../../db'
import { workflowSteps, type JobRow, type JobRunRow } from '../../db/schema'
import { parseWorkflowDoc } from '../../workflows/store'
import type { PinStore } from '../../workflows/pins'
import type { ScriptEntry, ScriptRegistry } from '../../scripts/registry'
import { EnkakuError } from '../../util/errors'
import type { Logger } from '../../util/logger'
import type { ExecutorContext, JobExecutor } from '../executor'
import type { RunStore } from '../runs/store'
import type { RunWatcher } from '../runs/watcher'

/**
 * Triggers allowed to see a pin (plan 304 §3.3): `manual`/`rerun` (an
 * author debugging in Studio) and `node-test` (plan 304 §4.6's "run one
 * node" — its whole point is to skip the device). `schedule` and `batch`
 * are a farm's own production paths and never appear here — production
 * ignores pins by NOT LOOKING, not by a flag that could be inverted.
 */
const PIN_AWARE_TRIGGERS = new Set(['manual', 'rerun', 'node-test'])

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
  /** Plan 304 §3.3, §4.5 — read only on `PIN_AWARE_TRIGGERS`. */
  pins: PinStore
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

/**
 * A `delay` node's own wait (plan 303 §3.4, §303.3) — cancellable, so a
 * workflow abort during the wait ends the run promptly rather than after
 * `waitMs` elapses. Rejects with the SIGNAL's own abort reason, never an
 * `EnkakuError`, matching `ctx.signal.throwIfAborted()`'s convention
 * elsewhere in this file — that is what lets the outer `catch`'s existing
 * `cancelled = ctx.signal.aborted && !(err instanceof EnkakuError)` keep
 * classifying an aborted delay as a cancellation, not a workflow failure,
 * with no separate branch needed.
 */
function cancellableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error('workflow aborted'))
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal.reason ?? new Error('workflow aborted'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

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

/** The edge a PINNED node takes (plan 304 §3.3, §4.2) — a pinned node is never executed, so no predicate or case is ever evaluated; it leaves by its FIRST declared successor, matching what an author sees on the canvas as the node's "main" edge. */
function defaultEdgeFor(node: WorkflowNode): string {
  switch (node.kind) {
    case 'gate':
      return node.then !== undefined ? 'then' : 'else'
    case 'switch': {
      const idx = node.cases.findIndex((c) => c.to !== undefined)
      return idx === -1 ? 'default' : `case:${idx}`
    }
    case 'script':
    case 'delay':
    case 'set':
      return 'next'
    default:
      return 'next'
  }
}

/** The node id `edge` (as `defaultEdgeFor` or a normal evaluated branch names it) points at — `null` when it dangles. */
function edgeTarget(node: WorkflowNode, edge: string): string | null {
  switch (node.kind) {
    case 'gate':
      return (edge === 'then' ? node.then : node.else) ?? null
    case 'switch': {
      if (edge === 'default') return node.default ?? null
      const idx = Number(edge.slice('case:'.length))
      return node.cases[idx]?.to ?? null
    }
    case 'script':
    case 'delay':
    case 'set':
      return node.next ?? null
    default:
      return null
  }
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

      // `__nodeTest` (plan 304 §4.6) is a reserved key `POST
      // /:name/run-node` (`api/workflows.ts`) uses to hand this run its
      // seeded predecessor — stripped out here so it can never reach a
      // `{ param }` binding as an ordinary workflow parameter.
      const rawParams = isPlainObject(job.params) ? job.params : {}
      const nodeTestSeed = isPlainObject(rawParams.__nodeTest) ? (rawParams.__nodeTest as { predecessorId?: unknown; value?: unknown }) : null
      const params: Record<string, unknown> = Object.fromEntries(Object.entries(rawParams).filter(([k]) => k !== '__nodeTest'))
      const outputs = new Map<string, unknown>()
      const summary: RunSummaryEntry[] = []
      const nodesById = new Map(doc.nodes.map((n) => [n.id, n]))
      const runCounts = new Map<string, number>()

      // Plan 304 §3.2, §4.6 — `run-node` seeds the target's own predecessor
      // (found by the route from the REAL published document) so `$input`
      // and a direct `{ from: predecessorId }` binding both resolve exactly
      // as they would in the real workflow. In-memory only: no
      // `workflow_steps` row for a node this run never actually reached.
      if (ctx.run.trigger === 'node-test' && nodeTestSeed && typeof nodeTestSeed.predecessorId === 'string') {
        outputs.set(nodeTestSeed.predecessorId, nodeTestSeed.value)
        const seedAt = new Date()
        summary.push({
          nodeId: nodeTestSeed.predecessorId,
          script: null,
          status: 'success',
          startedAt: toSec(seedAt),
          finishedAt: toSec(seedAt),
          durationMs: 0,
          output: nodeTestSeed.value,
        })
      }

      // Plan 304 §3.3 — pins are read from exactly ONE place, guarded by the
      // trigger. A `schedule`/`batch` run never reaches `deps.pins.readPins`
      // at all: production ignores pins by not looking, not by a flag.
      const pinsAllowed = PIN_AWARE_TRIGGERS.has(ctx.run.trigger)
      const activePins: ReadonlyMap<string, unknown> = pinsAllowed && job.workflowName ? deps.pins.readPins(job.workflowName) : new Map()

      /** `$input` for the step about to run — the previous step's own output, or `null` for the first (plan 304 §3.1, §4.7). */
      const currentInputValue = (): unknown => (summary.length > 0 ? (summary[summary.length - 1]?.output ?? null) : null)

      /** Caps a value to `WORKFLOW_LIMITS.maxNodeOutputBytes`, dropping it to `null` over the limit (same rule `capOutput` applies to `output`; `workflow_steps.input` has no truncation-marker column of its own, so an oversized input is logged and dropped rather than half-recorded). */
      const capInput = (value: unknown): unknown => {
        const { output, truncated } = capOutput(value)
        if (truncated) deps.log.warn(`workflow ${job.id}: a step's $input was ${truncated} — dropped, not truncated (no marker column for input)`)
        return output
      }

      let seqOffset = 0
      const carriedOverIds = new Set<string>()

      let cursor: string | null = doc.entry

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
              input: s.input,
              takenEdge: s.takenEdge,
              pinned: s.pinned,
              verdict: s.verdict,
              error: null,
              errorCode: null,
            })
            .run()
          seqOffset += 1
        }
        const resumeStepRow = priorSteps.find((s) => s.seq === resumedFromStep)
        cursor = resumeStepRow?.stepId ?? doc.entry
      }

      /** Enqueue one step job, await its run, and translate the settled run into an outcome. Never throws. */
      async function runScriptStep(
        node: ScriptNode,
        stepSeq: number,
        rowSeq: number,
        stepStartedAt: Date,
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

        // `now` is the STEP's own start time (plan 302 §3.3) — built once
        // here and reused by every `{ expr }` binding this step resolves
        // (`resolveValue`'s own scope cache, keyed on THIS object's
        // identity). `randomSeed` is `deriveRandom(seed, seq)` (plan 304
        // §3.4) — the RUN's own seed, folded with this step's own workflow
        // step sequence number, so a replay or a resume evaluates the exact
        // same value.
        const scope: ResolveScope = { params, outputs, summary, now: stepStartedAt.getTime(), randomSeed: deriveRandom(ctx.run.seed, rowSeq) }
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

          // `start` runs nothing and costs no step (plan 301 §3.4) — pass
          // straight through to its successor, or end the run SUCCEEDED at a
          // dangling edge (an empty document, in practice), never logged as
          // a workflow_steps row.
          if (node.kind === 'start') {
            cursor = node.next ?? null
            continue
          }

          // `finish` is a sink and costs no step either (plan 301 §3.2,
          // §4.2) — it carries the terminal status/message directly, with
          // no child process and nothing to log as a workflow_steps row.
          if (node.kind === 'finish') {
            cursor = null
            if (node.status === 'fail') {
              finalStatus = 'failed'
              finalErrorCode = 'E_WORKFLOW_FINISH_FAILED'
              finalErrorMessage = node.message || `workflow ended at finish node "${node.id}" — failed`
            }
            continue
          }

          const seq = step + seqOffset
          runCounts.set(node.id, (runCounts.get(node.id) ?? 0) + 1)
          const rowId = crypto.randomUUID()
          const rowStartedAt = new Date()
          const inputValue = capInput(currentInputValue())
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
              input: inputValue,
              takenEdge: null,
              pinned: false,
              verdict: null,
              error: null,
              errorCode: null,
            })
            .run()

          // Plan 304 §3.3, §4.2 — a pinned node is never executed: its pin
          // is substituted, and the walk moves on exactly as it would have
          // on a real output. Checked ONCE, ahead of every kind's own
          // dispatch below, so no kind can accidentally reach a device while
          // pinned.
          if (pinsAllowed && activePins.has(node.id)) {
            const pinnedOutput = activePins.get(node.id) ?? null
            const takenEdge = defaultEdgeFor(node)
            const finishedAt = new Date()
            deps.db
              .update(workflowSteps)
              .set({ status: 'success', finishedAt, output: pinnedOutput, pinned: true, takenEdge })
              .where(eq(workflowSteps.id, rowId))
              .run()
            outputs.set(node.id, pinnedOutput)
            summary.push({
              nodeId: node.id,
              script: node.kind === 'script' ? `${node.script} (pinned)` : null,
              status: 'success',
              startedAt: toSec(rowStartedAt),
              finishedAt: toSec(finishedAt),
              durationMs: finishedAt.getTime() - rowStartedAt.getTime(),
              output: pinnedOutput,
            })
            step += 1
            cursor = edgeTarget(node, takenEdge)
            continue
          }

          if (node.kind === 'gate') {
            const scope: ResolveScope = { params, outputs, summary, now: rowStartedAt.getTime(), randomSeed: deriveRandom(ctx.run.seed, seq) }
            const { value, trace } = evaluatePredicate(node.when, scope)
            const chosen = value ? node.then : node.else
            const takenEdge = value ? 'then' : 'else'
            const finishedAt = new Date()
            deps.db.update(workflowSteps).set({ status: 'success', finishedAt, verdict: trace, output: { value, branch: chosen ?? null }, takenEdge }).where(eq(workflowSteps.id, rowId)).run()
            summary.push({
              nodeId: node.id,
              script: null,
              status: 'success',
              startedAt: toSec(rowStartedAt),
              finishedAt: toSec(finishedAt),
              durationMs: finishedAt.getTime() - rowStartedAt.getTime(),
              output: { value, branch: chosen ?? null },
            })

            step += 1
            // Both `then` and `else` end the run SUCCEEDED when dangling
            // (plan 301 §3.2) — a gate has no `fail`-shaped outcome any more;
            // ending a run failed is a `finish` node's own job.
            cursor = chosen ?? null
            continue
          }

          if (node.kind === 'switch') {
            const scope: ResolveScope = { params, outputs, summary, now: rowStartedAt.getTime(), randomSeed: deriveRandom(ctx.run.seed, seq) }
            let chosen: string | undefined
            let firedIndex: number | null = null
            if (node.mode === 'weighted') {
              // Plan 312 §3.6, §4.3 — normalise the declared weights and
              // draw from `$random` (the SAME per-step
              // `deriveRandom(seed, seq)` a gate already uses), so the
              // branch taken is reproducible for a given run and different
              // between runs (G8): twenty devices each get their own
              // branch, and a replay of any one of them takes the branch it
              // actually took.
              const weights = node.cases.map((c) => c.weight ?? 0)
              const total = weights.reduce((a, b) => a + b, 0)
              let remaining = (scope.randomSeed ?? 0) * total
              for (let ci = 0; ci < node.cases.length; ci++) {
                remaining -= weights[ci] ?? 0
                if (remaining <= 0) {
                  chosen = node.cases[ci]?.to
                  firedIndex = ci
                  break
                }
              }
              if (firedIndex === null) {
                // Floating-point edge case only (the draw landed exactly on the total, or every weight was 0) — the last case.
                firedIndex = node.cases.length - 1
                chosen = node.cases[firedIndex]?.to
              }
            } else {
              // Plan 303 §3.3: cases evaluated in ARRAY order, first match
              // wins; `default` fires when none do. Reuses
              // `evaluatePredicate` unchanged — a case's `when` is the exact
              // same `Predicate` a gate already evaluates.
              for (let ci = 0; ci < node.cases.length; ci++) {
                const c = node.cases[ci]
                if (!c || c.when === undefined) continue
                const { value } = evaluatePredicate(c.when, scope)
                if (value) {
                  chosen = c.to
                  firedIndex = ci
                  break
                }
              }
              if (firedIndex === null) chosen = node.default
            }
            const finishedAt = new Date()
            const output = { case: firedIndex, branch: chosen ?? null }
            const takenEdge = firedIndex === null ? 'default' : `case:${firedIndex}`
            deps.db.update(workflowSteps).set({ status: 'success', finishedAt, output, takenEdge }).where(eq(workflowSteps.id, rowId)).run()
            summary.push({
              nodeId: node.id,
              script: null,
              status: 'success',
              startedAt: toSec(rowStartedAt),
              finishedAt: toSec(finishedAt),
              durationMs: finishedAt.getTime() - rowStartedAt.getTime(),
              output,
            })

            step += 1
            // Every case target and `default` end the run SUCCEEDED when
            // dangling (plan 301 §3.2), same as a gate's `then`/`else`.
            cursor = chosen ?? null
            continue
          }

          if (node.kind === 'delay') {
            // Plan 303 §3.4: `ms` may be ANY ValueExpr (including `{ expr }`),
            // resolved here; the executor clamps the resolved value to the
            // document's own declared `maxMs` — a budget `checkWorkflow`
            // could not have computed statically from an unbounded `ms` is
            // not a budget. A non-numeric or unresolved `ms` degrades to `0`
            // rather than failing the step: a delay is advisory timing, not
            // a binding whose absence should fail a run.
            const scope: ResolveScope = { params, outputs, summary, now: rowStartedAt.getTime(), randomSeed: deriveRandom(ctx.run.seed, seq) }
            const msOutcome = resolveValue(node.ms, scope)
            const rawMs = msOutcome.ok && typeof msOutcome.value === 'number' && Number.isFinite(msOutcome.value) ? msOutcome.value : 0
            const waitMs = Math.max(0, Math.min(rawMs, node.maxMs))
            await cancellableDelay(waitMs, ctx.signal)
            const finishedAt = new Date()
            const output = { ms: waitMs }
            deps.db.update(workflowSteps).set({ status: 'success', finishedAt, output, takenEdge: 'next' }).where(eq(workflowSteps.id, rowId)).run()
            summary.push({
              nodeId: node.id,
              script: null,
              status: 'success',
              startedAt: toSec(rowStartedAt),
              finishedAt: toSec(finishedAt),
              durationMs: finishedAt.getTime() - rowStartedAt.getTime(),
              output,
            })

            step += 1
            // Absent = dangling; reaching it ends the run SUCCEEDED (plan 301 §3.2).
            cursor = node.next ?? null
            continue
          }

          if (node.kind === 'set') {
            // Plan 312 §3.3, §4.3 — pure, in-process, no device, no child
            // job; the checker already treats this node as costing zero
            // time in the budget walk. `keepOnlySet` drops the input;
            // otherwise the input (when it is an object — anything else has
            // no fields to carry through) seeds the base that each
            // assignment writes into, in array order, so a LATER assignment
            // may overwrite an EARLIER one's path.
            const scope: ResolveScope = { params, outputs, summary, now: rowStartedAt.getTime(), randomSeed: deriveRandom(ctx.run.seed, seq) }
            const inputForBase = currentInputValue()
            let base: Record<string, unknown> = !node.keepOnlySet && isPlainObject(inputForBase) ? { ...inputForBase } : {}
            let setError: string | null = null
            for (const a of node.assignments) {
              const nameOutcome = resolveValue(a.name, scope)
              if (!nameOutcome.ok) {
                setError = `an assignment's name: ${nameOutcome.detail}`
                break
              }
              if (typeof nameOutcome.value !== 'string' || nameOutcome.value.length === 0) {
                setError = `an assignment's name resolved to ${typeof nameOutcome.value === 'string' ? 'an empty string' : typeof nameOutcome.value}, not a non-empty string`
                break
              }
              const valueOutcome = resolveValue(a.value, scope)
              if (!valueOutcome.ok) {
                setError = `assignment "${nameOutcome.value}": ${valueOutcome.detail}`
                break
              }
              try {
                base = setPath(base, nameOutcome.value, valueOutcome.value)
              } catch (err) {
                setError = err instanceof Error ? err.message : String(err)
                break
              }
            }

            const finishedAt = new Date()
            if (setError !== null) {
              deps.db
                .update(workflowSteps)
                .set({ status: 'failed', finishedAt, error: setError, errorCode: 'E_WORKFLOW_SET_FAILED', takenEdge: null })
                .where(eq(workflowSteps.id, rowId))
                .run()
              summary.push({
                nodeId: node.id,
                script: null,
                status: 'failed',
                startedAt: toSec(rowStartedAt),
                finishedAt: toSec(finishedAt),
                durationMs: finishedAt.getTime() - rowStartedAt.getTime(),
                output: null,
              })
              step += 1
              cursor = null
              finalStatus = 'failed'
              finalErrorCode = 'E_WORKFLOW_SET_FAILED'
              finalErrorMessage = `step "${node.id}" failed: ${setError}`
              continue
            }

            const { output, truncated } = capOutput(base)
            outputs.set(node.id, output)
            deps.db.update(workflowSteps).set({ status: 'success', finishedAt, output, outputTruncated: truncated, takenEdge: 'next' }).where(eq(workflowSteps.id, rowId)).run()
            summary.push({
              nodeId: node.id,
              script: null,
              status: 'success',
              startedAt: toSec(rowStartedAt),
              finishedAt: toSec(finishedAt),
              durationMs: finishedAt.getTime() - rowStartedAt.getTime(),
              output,
            })

            step += 1
            // Absent = dangling; reaching it ends the run SUCCEEDED (plan 301 §3.2).
            cursor = node.next ?? null
            continue
          }

          // A script step.
          const outcome = await runScriptStep(node, step, seq, rowStartedAt)
          if (outcome.run) currentChildRunId = outcome.run.id
          const finishedAt = new Date()

          if (outcome.ok) {
            outputs.set(node.id, outcome.run.result)
            const { output, truncated } = capOutput(outcome.run.result)
            deps.db
              .update(workflowSteps)
              .set({ status: 'success', finishedAt, jobId: outcome.run.jobId, jobRunId: outcome.run.id, output, outputTruncated: truncated, takenEdge: 'next' })
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

            step += 1
            // Absent = dangling; reaching it ends the run SUCCEEDED (plan 301 §3.2).
            cursor = node.next ?? null
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
              takenEdge: outcome.run?.status === 'cancelled' || outcome.code === 'job_cancelled' ? null : 'onFailure',
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

          // Absent = dangling; reaching it ends the run FAILED (plan 301 §3.2).
          if (node.onFailure === undefined) {
            cursor = null
            finalStatus = 'failed'
            finalErrorCode = outcome.code
            finalErrorMessage = `step "${node.id}" failed: ${outcome.message}`
          } else {
            cursor = node.onFailure
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
        // `start`/`finish` are never logged at all (plan 301 §3.2, §3.4) —
        // they cost no step whether the cursor reaches them or not.
        let skipSeq = step + seqOffset
        for (const n of doc.nodes) {
          if (n.kind === 'start' || n.kind === 'finish') continue
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
            const cleanupScope: ResolveScope = { params, outputs, summary, now: Date.now(), randomSeed: deriveRandom(ctx.run.seed, skipSeq) }
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
