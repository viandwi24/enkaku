import { Hono } from 'hono'
import { z } from 'zod'
import { and, desc, eq, ne } from 'drizzle-orm'
import {
  checkDeclaredSchema,
  checkWorkflow,
  compileWorkflowParams,
  WorkflowDocSchema,
  WorkflowResponseSchema,
  WorkflowsListResponseSchema,
  WorkflowDeleteResponseSchema,
  WorkflowPinsListResponseSchema,
  WorkflowPinDataResponseSchema,
  WorkflowPinSetRequestSchema,
  WorkflowRunNodeRequestSchema,
  WorkflowRunNodeResponseSchema,
  WorkflowLastRunResponseSchema,
  WORKFLOW_STEP_STATUSES,
  type ResolvedNodeScript,
  type ScriptRef,
  type WorkflowBudget,
  type WorkflowDoc,
  type WorkflowFinding,
  type WorkflowLastRunNode,
  type WorkflowLastRunNodeData,
  type WorkflowNode,
} from '@enkaku/protocol'
import type { AuditLogger } from '../auth/audit'
import type { AuthEnv } from '../auth/middleware'
import { requirePermission } from '../auth/middleware'
import type { Db } from '../db'
import { jobRuns, jobs, workflowSteps, type WorkflowStepRow } from '../db/schema'
import { rowToJobInfo } from '../queue/job-store'
import type { ScriptRegistry } from '../scripts/registry'
import type { WorkflowStore } from '../workflows/store'
import { upgradeWorkflowDoc } from '../workflows/upgrade'
import type { PinStore } from '../workflows/pins'
import type { RunStore } from '../jobs/runs/store'
import { EnkakuError } from '../util/errors'
import { typedJson } from './typed-json'
import { WORKFLOW_MAX_TOTAL_MS } from '../config/constants'

/**
 * `GET/POST/PUT/DELETE /api/workflows`, `POST /validate` (plan 210 §4.3,
 * §4.4) — a workflow is its own table now, no version, edited in place.
 * `resolveDocRefs`/`checkWorkflow` are unchanged apart from dropping `kind`
 * (a workflow node's reference always resolves to a plugin member; nesting a
 * workflow inside another cannot be expressed any more).
 */

const DocBody = z.object({ doc: z.unknown() })

const ERROR_STATUS: Record<string, number> = {
  workflow_not_found: 404,
  workflow_name_exists: 409,
  workflow_corrupt: 500,
  script_not_found: 404,
  script_version_not_found: 404,
  script_ref_unresolved: 400,
  script_disabled: 400,
  script_is_dev: 400,
  E_BAD_REQUEST: 400,
  E_WORKFLOW_INVALID: 400,
  E_PARAMS_SCHEMA_INVALID: 400,
  E_WORKFLOW_SCHEMA_UNKNOWN: 400,
  E_WORKFLOW_UPGRADE_FAILED: 400,
  E_NODE_UNKNOWN: 400,
  E_NODE_NO_INPUT: 400,
  E_PIN_TOO_LARGE: 400,
  E_PIN_NOT_PINNABLE: 400,
  pin_not_found: 404,
  workflow_never_run: 404,
}

function parseErrorFindings(issues: readonly { path: readonly PropertyKey[]; message: string }[]): WorkflowFinding[] {
  return issues.map((i) => ({ path: i.path.map(String).join('.'), code: 'E_WORKFLOW_INVALID' as const, message: i.message, severity: 'error' as const }))
}

/**
 * Resolves every node's (and `onFail`'s) script reference through the SAME
 * `ScriptRegistry.resolve()` every other resolution path uses (F17) — never
 * a second lookup, and never `allowDev` (a published workflow must not
 * depend on someone's ephemeral dev build, plan 82 §3.5). Collects EVERY
 * resolution failure rather than aborting on the first, each reported as an
 * `E_WORKFLOW_SCRIPT_UNRESOLVED` finding so an author sees every broken
 * reference in one round trip, not one 404 at a time.
 */
function resolveDocRefs(registry: ScriptRegistry, doc: WorkflowDoc): { resolved: Map<ScriptRef, ResolvedNodeScript>; findings: WorkflowFinding[] } {
  const pathsByRef = new Map<string, string[]>()
  const addRef = (ref: string, path: string) => {
    const list = pathsByRef.get(ref)
    if (list) list.push(path)
    else pathsByRef.set(ref, [path])
  }
  doc.nodes.forEach((node, i) => {
    if (node.kind === 'script') addRef(node.script, `nodes[${i}].script`)
  })
  if (doc.onFail) addRef(doc.onFail.script, 'onFail.script')

  const resolved = new Map<ScriptRef, ResolvedNodeScript>()
  const findings: WorkflowFinding[] = []
  for (const [ref, paths] of pathsByRef) {
    try {
      const entry = registry.resolve(ref as ScriptRef)
      resolved.set(ref as ScriptRef, {
        name: entry.name,
        version: entry.version,
        paramsSchema: (entry.paramsSchema as ResolvedNodeScript['paramsSchema']) ?? null,
        // Plan 97 (§0.2 assumption A1) has not landed — no script anywhere
        // declares an output schema yet, so this is always null today.
        outputSchema: null,
        timeoutMs: entry.runtime?.timeoutMs ?? null,
      })
    } catch (err) {
      const message = err instanceof EnkakuError ? err.message : String(err)
      for (const path of paths) findings.push({ path, code: 'E_WORKFLOW_SCRIPT_UNRESOLVED', message, severity: 'error' })
    }
  }
  return { resolved, findings }
}

function errorFindingsMessage(findings: readonly WorkflowFinding[]): string {
  return findings.map((f) => (f.path ? `${f.path}: ${f.message}` : f.message)).join('; ')
}

/**
 * `deps.settings` is OPTIONAL: `daemon.ts`'s real `createWorkflowRoutes({...})`
 * call passes `settings: () => settingsStore.get().workflow`. The fallback
 * below stays for every other caller so `budgetFor` resolves to
 * `workflow.maxTotalMs`'s own SCHEMA default rather than skipping check 7
 * outright.
 */
function budgetFor(deps: { settings?: () => WorkflowBudget }): WorkflowBudget {
  return deps.settings ? deps.settings() : { maxTotalMs: WORKFLOW_MAX_TOTAL_MS }
}

/**
 * Accepts a v1 OR v2 document body (plan 301 §4.5) and returns an
 * already-upgraded v2 `WorkflowDoc`, or the findings to answer with. Every
 * caller in this file that reads a raw request body goes through this — a
 * `POST`/`PUT` may still arrive holding a v1 document (an API client that
 * predates plan 301); it is upgraded here, once, before `checkWorkflow` ever
 * sees it. This tolerance exists for API clients; plan 307 §10 removes it
 * once no v1 remains on the owner's farm.
 *
 * A `schema: 2` body is parsed DIRECTLY against `WorkflowDocSchema` (never
 * routed through `upgradeWorkflowDoc`, which would collapse every per-field
 * Zod issue into one `E_WORKFLOW_UPGRADE_FAILED` message) so a malformed v2
 * document still gets the same per-field `E_WORKFLOW_INVALID` findings it
 * always has. A `schema: 1` body goes through `upgradeWorkflowDoc`, whose own
 * failure IS reported as one `E_WORKFLOW_UPGRADE_FAILED` finding — a v1
 * document is legacy input, not something an author is actively editing
 * field-by-field. Anything else is `E_WORKFLOW_SCHEMA_UNKNOWN`.
 */
function parseOrUpgradeDoc(rawDoc: unknown): { ok: true; doc: WorkflowDoc } | { ok: false; findings: WorkflowFinding[] } {
  const schema = rawDoc !== null && typeof rawDoc === 'object' && !Array.isArray(rawDoc) ? (rawDoc as Record<string, unknown>).schema : undefined
  if (schema === 2) {
    const parsed = WorkflowDocSchema.safeParse(rawDoc)
    if (!parsed.success) return { ok: false, findings: parseErrorFindings(parsed.error.issues) }
    return { ok: true, doc: parsed.data }
  }
  try {
    return { ok: true, doc: upgradeWorkflowDoc(rawDoc) }
  } catch (err) {
    if (err instanceof EnkakuError && (err.code === 'E_WORKFLOW_SCHEMA_UNKNOWN' || err.code === 'E_WORKFLOW_UPGRADE_FAILED')) {
      return { ok: false, findings: [{ path: '', code: err.code, message: err.message, severity: 'error' }] }
    }
    throw err
  }
}

/**
 * Validates a document through the same pipeline `POST`/`PUT` use, up to
 * (but not including) the write: version upgrade, ref resolution,
 * `checkWorkflow`, and the declared-params-schema gate. Returns either the
 * ready-to-write doc plus its compiled paramsSchema, or the JSON error body
 * to answer with.
 */
function validateForWrite(
  registry: ScriptRegistry,
  settingsDeps: { settings?: () => WorkflowBudget },
  rawDoc: unknown,
): { ok: true; doc: WorkflowDoc; paramsSchema: unknown } | { ok: false; status: 400; body: unknown } {
  const parsedDoc = parseOrUpgradeDoc(rawDoc)
  if (!parsedDoc.ok) {
    return { ok: false, status: 400, body: { error: { code: parsedDoc.findings[0]?.code ?? 'E_WORKFLOW_INVALID', message: errorFindingsMessage(parsedDoc.findings), findings: parsedDoc.findings } } }
  }
  const doc = parsedDoc.doc
  const { resolved, findings: refFindings } = resolveDocRefs(registry, doc)
  const checkFindings = checkWorkflow(doc, resolved, budgetFor(settingsDeps))
  const allFindings = [...refFindings, ...checkFindings]
  const blocking = allFindings.filter((f) => f.severity === 'error')
  if (blocking.length > 0) {
    return { ok: false, status: 400, body: { error: { code: 'E_WORKFLOW_INVALID', message: errorFindingsMessage(blocking), findings: allFindings } } }
  }
  const paramsSchema = compileWorkflowParams(doc.params)
  const schemaFindings = checkDeclaredSchema(paramsSchema).filter((f) => f.limit !== 'group')
  if (schemaFindings.length > 0) {
    return {
      ok: false,
      status: 400,
      body: {
        error: {
          code: 'E_PARAMS_SCHEMA_INVALID',
          message: schemaFindings.map((f) => (f.path ? `${f.path}: ${f.message}` : f.message)).join('; '),
          issues: schemaFindings.map((f) => ({ path: f.path, message: f.message })),
        },
      },
    }
  }
  return { ok: true, doc, paramsSchema }
}

/**
 * The node whose edge points AT `nodeId` — the one candidate for "the
 * predecessor's output" (plan 304 §3.2's option 2, and the value a `run-node`
 * request seeds `$input` from). `null` when `nodeId` is the document's own
 * `entry` successor with no other node pointing at it, or when nothing does.
 */
function findPredecessorId(doc: WorkflowDoc, nodeId: string): string | null {
  for (const n of doc.nodes) {
    switch (n.kind) {
      case 'start':
      case 'delay':
        if (n.next === nodeId) return n.id
        break
      case 'script':
        if (n.next === nodeId || n.onFailure === nodeId) return n.id
        break
      case 'gate':
        if (n.then === nodeId || n.else === nodeId) return n.id
        break
      case 'switch':
        if (n.default === nodeId || n.cases.some((c) => c.to === nodeId)) return n.id
        break
      case 'finish':
        break
    }
  }
  return null
}

/** A copy of `node` with every outbound edge removed — the one-node document `run-node` builds ends at this node, whatever it decides. */
function stripSuccessors(node: WorkflowNode): WorkflowNode {
  switch (node.kind) {
    case 'script':
      return { ...node, next: undefined, onFailure: undefined }
    case 'gate':
      return { ...node, then: undefined, else: undefined }
    case 'switch':
      return { ...node, cases: node.cases.map((c) => ({ ...c, to: undefined })), default: undefined }
    case 'delay':
      return { ...node, next: undefined }
    default:
      return node
  }
}

/**
 * The most recently recorded `$input` for `nodeId` (plan 304 §3.2 option 1)
 * — `workflow_steps.input` from the latest REAL run (never a `node-test`
 * run, so running a node alone twice in a row does not bootstrap off its own
 * synthetic predecessor). `undefined` when the node has never run.
 */
function lastRecordedInput(db: Db, workflowName: string, nodeId: string): { ok: true; value: unknown } | { ok: false } {
  const row = db
    .select({ input: workflowSteps.input })
    .from(workflowSteps)
    .innerJoin(jobRuns, eq(jobRuns.id, workflowSteps.runId))
    .innerJoin(jobs, eq(jobs.id, jobRuns.jobId))
    .where(and(eq(jobs.workflowName, workflowName), eq(workflowSteps.stepId, nodeId), ne(jobRuns.trigger, 'node-test')))
    .orderBy(desc(workflowSteps.startedAt))
    .limit(1)
    .get()
  return row ? { ok: true, value: row.input } : { ok: false }
}

/**
 * The OUTPUT pane's state for one node's last-run step (plan 306 §3.1, §9
 * Q5's neighbour, the discrepancy recorded in the handoff report): `none`
 * when the node has no recorded step at all, `dropped` when
 * `output_truncated` is set (the value was over the cap and was NEVER
 * recorded — dropped, not truncated), `empty` when the node ran and the
 * recorded value is `null`/`undefined`, `value` otherwise.
 */
function outputData(step: WorkflowStepRow | undefined): WorkflowLastRunNodeData {
  if (!step) return { state: 'none' }
  if (step.outputTruncated) return { state: 'dropped' }
  if (step.output === null || step.output === undefined) return { state: 'empty' }
  return { state: 'value', value: step.output }
}

/**
 * The INPUT pane's state for one node's last-run step. `workflow_steps.input`
 * has NO truncation-marker column of its own (`jobs/executors/workflow.ts`'s
 * `capInput`: "no marker column for input") — so a dropped input reads
 * identically to a genuinely empty one by looking at the row alone. Since a
 * single-cursor run's `$input` for a node is exactly its predecessor's own
 * output (plan 306 §9 Q2), the predecessor's OWN `output_truncated` — which
 * DOES exist — is what tells the two apart.
 */
function inputData(step: WorkflowStepRow | undefined, predecessorStep: WorkflowStepRow | undefined): WorkflowLastRunNodeData {
  if (!step) return { state: 'none' }
  if (predecessorStep?.outputTruncated) return { state: 'dropped' }
  if (step.input === null || step.input === undefined) return { state: 'empty' }
  return { state: 'value', value: step.input }
}

export function createWorkflowRoutes(deps: {
  db: Db
  registry: ScriptRegistry
  store: WorkflowStore
  runs: RunStore
  pins: PinStore
  scheduler: { kick: () => void }
  audit?: AuditLogger
  settings?: () => WorkflowBudget
}): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>()
  const { registry, store } = deps
  const actorId = (c: { get(k: 'user'): { id: string } | undefined }): string | null => c.get('user')?.id ?? null

  app.post('/validate', requirePermission('script.view'), async (c) => {
    const body = DocBody.safeParse(await c.req.json().catch(() => null))
    if (!body.success) return c.json({ error: { code: 'E_BAD_REQUEST', message: body.error.issues.map((i) => i.message).join('; ') } }, 400)

    const parsedDoc = parseOrUpgradeDoc(body.data.doc)
    if (!parsedDoc.ok) {
      return c.json(parsedDoc.findings)
    }
    const doc = parsedDoc.doc
    const { resolved, findings: refFindings } = resolveDocRefs(registry, doc)
    const findings: WorkflowFinding[] = [...refFindings, ...checkWorkflow(doc, resolved, budgetFor(deps))]
    return c.json(findings)
  })

  app.get('/', requirePermission('script.view'), (c) => {
    const items = store.list()
    return typedJson(c, WorkflowsListResponseSchema, { items, total: items.length })
  })

  app.get('/:name', requirePermission('script.view'), (c) => {
    const workflow = store.get(c.req.param('name'))
    if (!workflow) throw new EnkakuError('workflow_not_found', `no workflow named "${c.req.param('name')}"`)
    return typedJson(c, WorkflowResponseSchema, { workflow })
  })

  app.post('/', requirePermission('script.publish'), async (c) => {
    const body = DocBody.safeParse(await c.req.json().catch(() => null))
    if (!body.success) return c.json({ error: { code: 'E_BAD_REQUEST', message: body.error.issues.map((i) => i.message).join('; ') } }, 400)
    const validated = validateForWrite(registry, deps, body.data.doc)
    if (!validated.ok) return c.json(validated.body, validated.status)
    const workflow = store.create({ doc: validated.doc, createdBy: actorId(c) })
    deps.audit?.record({ userId: actorId(c), action: 'workflow.create', target: workflow.id, meta: { name: workflow.name } })
    return typedJson(c, WorkflowResponseSchema, { workflow }, 201)
  })

  app.put('/:name', requirePermission('script.publish'), async (c) => {
    const name = c.req.param('name')
    const body = DocBody.safeParse(await c.req.json().catch(() => null))
    if (!body.success) return c.json({ error: { code: 'E_BAD_REQUEST', message: body.error.issues.map((i) => i.message).join('; ') } }, 400)
    const rawDoc = body.data.doc
    if (rawDoc && typeof rawDoc === 'object' && 'name' in rawDoc && (rawDoc as { name?: unknown }).name !== name) {
      return c.json(
        { error: { code: 'E_BAD_REQUEST', message: `the document names "${String((rawDoc as { name?: unknown }).name)}" but the route names "${name}"; rename by deleting and creating` } },
        400,
      )
    }
    const validated = validateForWrite(registry, deps, rawDoc)
    if (!validated.ok) return c.json(validated.body, validated.status)
    const workflow = store.update(name, { doc: validated.doc })
    deps.audit?.record({ userId: actorId(c), action: 'workflow.update', target: workflow.id, meta: { name: workflow.name } })
    return typedJson(c, WorkflowResponseSchema, { workflow })
  })

  app.delete('/:name', requirePermission('script.publish'), (c) => {
    const name = c.req.param('name')
    const workflow = store.get(name)
    if (!workflow) throw new EnkakuError('workflow_not_found', `no workflow named "${name}"`)
    store.remove(name)
    deps.pins.removeAll(name)
    deps.audit?.record({ userId: actorId(c), action: 'workflow.delete', target: workflow.id, meta: { name } })
    return typedJson(c, WorkflowDeleteResponseSchema, { ok: true })
  })

  // ---- Pins (plan 300 P10, plan 304 §3.3, §4.3) ----

  app.get('/:name/pins', requirePermission('script.view'), (c) => {
    const name = c.req.param('name')
    if (!store.get(name)) throw new EnkakuError('workflow_not_found', `no workflow named "${name}"`)
    return typedJson(c, WorkflowPinsListResponseSchema, { pins: deps.pins.list(name) })
  })

  app.get('/:name/pins/:nodeId', requirePermission('script.view'), (c) => {
    const name = c.req.param('name')
    if (!store.get(name)) throw new EnkakuError('workflow_not_found', `no workflow named "${name}"`)
    const pin = deps.pins.get(name, c.req.param('nodeId'))
    if (!pin) throw new EnkakuError('pin_not_found', `no pin on node "${c.req.param('nodeId')}"`)
    return typedJson(c, WorkflowPinDataResponseSchema, { data: pin.data })
  })

  app.put('/:name/pins/:nodeId', requirePermission('script.publish'), async (c) => {
    const name = c.req.param('name')
    const nodeId = c.req.param('nodeId')
    const workflow = store.get(name)
    if (!workflow) throw new EnkakuError('workflow_not_found', `no workflow named "${name}"`)
    const body = WorkflowPinSetRequestSchema.safeParse(await c.req.json().catch(() => null))
    if (!body.success) throw new EnkakuError('E_BAD_REQUEST', body.error.issues.map((i) => i.message).join('; '))
    // Plan 300 R6, applied: only a node with ONE main output may be pinned. A
    // pinned node is never executed, so a pinned `gate` or `switch` would
    // never evaluate its predicate and the run would leave by a branch nobody
    // chose — a pin that lies about control flow, which is exactly what plan
    // 304 §3.3 exists to prevent. `start` and `finish` produce no output at
    // all. That leaves `script` and `delay`, both of which have a single
    // unconditional successor.
    const target = workflow.doc.nodes.find((n) => n.id === nodeId)
    if (!target) throw new EnkakuError('E_NODE_UNKNOWN', `"${nodeId}" is not a node of workflow "${name}"`)
    if (target.kind !== 'script' && target.kind !== 'delay') {
      throw new EnkakuError(
        'E_PIN_NOT_PINNABLE',
        `a ${target.kind} node cannot be pinned: only a node with a single main output may be (plan 300 R6). Pinning it would skip the decision that chooses its successor.`,
      )
    }
    let data: unknown
    if ('data' in body.data) {
      data = body.data.data
    } else {
      // `{ from: 'last-run' }` pins the last recorded OUTPUT of nodeId
      // itself, not its predecessor's input — the same value the canvas
      // already shows for that node's last run.
      const row = deps.db
        .select({ output: workflowSteps.output })
        .from(workflowSteps)
        .innerJoin(jobRuns, eq(jobRuns.id, workflowSteps.runId))
        .innerJoin(jobs, eq(jobs.id, jobRuns.jobId))
        .where(and(eq(jobs.workflowName, name), eq(workflowSteps.stepId, nodeId), ne(jobRuns.trigger, 'node-test')))
        .orderBy(desc(workflowSteps.startedAt))
        .limit(1)
        .get()
      if (!row) throw new EnkakuError('E_NODE_NO_INPUT', `node "${nodeId}" has no recorded run to pin from`)
      data = row.output
    }
    deps.pins.set(name, nodeId, data, actorId(c))
    deps.audit?.record({ userId: actorId(c), action: 'workflow.pin.set', target: workflow.id, meta: { name, nodeId } })
    return c.body(null, 204)
  })

  app.delete('/:name/pins/:nodeId', requirePermission('script.publish'), (c) => {
    const name = c.req.param('name')
    const nodeId = c.req.param('nodeId')
    const workflow = store.get(name)
    if (!workflow) throw new EnkakuError('workflow_not_found', `no workflow named "${name}"`)
    deps.pins.remove(name, nodeId)
    deps.audit?.record({ userId: actorId(c), action: 'workflow.pin.remove', target: workflow.id, meta: { name, nodeId } })
    return c.body(null, 204)
  })

  // ---- Run one node (plan 300 P9, plan 304 §3.2, §4.3, §4.6) ----

  app.post('/:name/run-node', requirePermission('job.run'), async (c) => {
    const name = c.req.param('name')
    const workflow = store.get(name)
    if (!workflow) throw new EnkakuError('workflow_not_found', `no workflow named "${name}"`)
    const body = WorkflowRunNodeRequestSchema.safeParse(await c.req.json().catch(() => null))
    if (!body.success) throw new EnkakuError('E_BAD_REQUEST', body.error.issues.map((i) => i.message).join('; '))
    const { nodeId, deviceId, input } = body.data

    const targetNode = workflow.doc.nodes.find((n) => n.id === nodeId)
    if (!targetNode || targetNode.kind === 'start' || targetNode.kind === 'finish') {
      throw new EnkakuError('E_NODE_UNKNOWN', `"${nodeId}" is not a runnable node of workflow "${name}"`)
    }

    const predecessorId = findPredecessorId(workflow.doc, nodeId)
    const source = input?.from ?? 'last-run'
    let inputValue: unknown
    if (source === 'literal') {
      inputValue = input && 'value' in input ? input.value : undefined
    } else if (source === 'pin') {
      const pin = predecessorId ? deps.pins.get(name, predecessorId) : null
      if (!pin) {
        throw new EnkakuError(
          'E_NODE_NO_INPUT',
          `node "${nodeId}" has no pinned predecessor to run from — pin its predecessor, supply literal input, or run the workflow once first`,
        )
      }
      inputValue = pin.data
    } else {
      const last = lastRecordedInput(deps.db, name, nodeId)
      if (!last.ok) {
        throw new EnkakuError(
          'E_NODE_NO_INPUT',
          `node "${nodeId}" has never run — supply { input: { from: 'literal', value } } or { from: 'pin' } against its predecessor`,
        )
      }
      inputValue = last.value
    }

    const startNode: WorkflowNode = { kind: 'start', id: 'run-node-start', title: '', ui: { x: 0, y: 0 }, next: nodeId }
    const syntheticDoc = WorkflowDocSchema.parse({
      schema: 2,
      name,
      title: workflow.doc.title,
      description: '',
      params: [],
      entry: 'run-node-start',
      nodes: [startNode, stripSuccessors(targetNode)],
      maxSteps: 2,
    })

    const job = deps.runs.createJob({
      kind: 'workflow',
      workflowName: name,
      workflowDoc: syntheticDoc,
      deviceId,
      // The seed for the executor's own node-test seeding (plan 304 §4.6) —
      // never a real workflow parameter; stripped from `$params` before an
      // `{ expr }`/`{ param }` binding can see it (`jobs/executors/workflow.ts`).
      params: predecessorId ? { __nodeTest: { predecessorId, value: inputValue } } : {},
      scriptName: name,
      scriptVersion: null,
    })
    const run = deps.runs.addRun(job.id, { trigger: 'node-test' })
    deps.scheduler.kick()
    return typedJson(c, WorkflowRunNodeResponseSchema, { job: rowToJobInfo(job, run), runId: run.id }, 202)
  })

  // ---- Last run (plan 300 P6, plan 306 §3.1, §4.5) ----

  app.get('/:name/last-run', requirePermission('script.view'), (c) => {
    const name = c.req.param('name')
    const workflow = store.get(name)
    if (!workflow) throw new EnkakuError('workflow_not_found', `no workflow named "${name}"`)

    // The latest REAL run (never `node-test` — running one node alone must
    // never overwrite the data an author sees for every other node, plan 304
    // §4.6). Multiple `jobs` rows can share this `workflowName` (each Run
    // creates its own job), so this joins across all of them rather than
    // assuming one job owns every run.
    const latestRun = deps.db
      .select({ jobId: jobRuns.jobId, runId: jobRuns.id, startedAt: jobRuns.startedAt, createdAt: jobRuns.createdAt, seed: jobRuns.seed, params: jobs.params })
      .from(jobRuns)
      .innerJoin(jobs, eq(jobs.id, jobRuns.jobId))
      .where(and(eq(jobs.workflowName, name), ne(jobRuns.trigger, 'node-test')))
      .orderBy(desc(jobRuns.createdAt))
      .limit(1)
      .get()
    if (!latestRun) throw new EnkakuError('workflow_never_run', `workflow "${name}" has never run`)

    const steps = deps.db.select().from(workflowSteps).where(eq(workflowSteps.runId, latestRun.runId)).all()
    // A loop can revisit the same node id more than once in one run
    // (`workflow_steps.seq`'s own doc comment) — the LATEST step for a node
    // id is the one a data pane should show.
    const byStepId = new Map<string, WorkflowStepRow>()
    for (const s of steps) {
      const existing = byStepId.get(s.stepId)
      if (!existing || s.seq > existing.seq) byStepId.set(s.stepId, s)
    }

    const pinnedIds = new Set(deps.pins.list(name).map((p) => p.nodeId))

    const nodes: Record<string, WorkflowLastRunNode> = {}
    for (const node of workflow.doc.nodes) {
      const step = byStepId.get(node.id)
      const predecessorId = findPredecessorId(workflow.doc, node.id)
      const predecessorStep = predecessorId ? byStepId.get(predecessorId) : undefined
      nodes[node.id] = {
        nodeId: node.id,
        status: step && (WORKFLOW_STEP_STATUSES as readonly string[]).includes(step.status) ? (step.status as WorkflowLastRunNode['status']) : null,
        pinned: pinnedIds.has(node.id),
        takenEdge: step?.takenEdge ?? null,
        seq: step?.seq ?? null,
        input: inputData(step, predecessorStep),
        output: outputData(step),
      }
    }

    const at = latestRun.startedAt ?? latestRun.createdAt
    return typedJson(c, WorkflowLastRunResponseSchema, {
      jobId: latestRun.jobId,
      runId: latestRun.runId,
      at: Math.floor(at.getTime() / 1000),
      params: latestRun.params ?? {},
      seed: latestRun.seed,
      nodes,
    })
  })

  app.onError((err, c) => {
    if (err instanceof EnkakuError) return c.json(err.toJSON(), (ERROR_STATUS[err.code] ?? 500) as 400)
    throw err
  })

  return app
}
