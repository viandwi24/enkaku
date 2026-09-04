import { z } from 'zod'
import {
  PredicateSchema,
  ScriptRefSchema,
  WORKFLOW_LIMITS,
  WorkflowDocSchema,
  WorkflowNameSchema,
  WorkflowNodeIdSchema,
  WorkflowParamNameSchema,
  WorkflowParamSchema,
  ValueExprSchema,
  type WorkflowDoc,
  type WorkflowNode,
} from '@enkaku/protocol'
import { EnkakuError } from '../util/errors'

/**
 * The ONE place a v1 document becomes a v2 document (plan 301 §4.4). Pure: no
 * database, no clock, no import from Studio. Called by `WorkflowStore` on
 * read (`packages/core/src/workflows/store.ts`) and by the workflow executor
 * when it meets a v1 `jobs.workflow_doc` — both through this file's
 * `upgradeWorkflowDoc`, never directly.
 *
 * A v2 document (`doc.schema === 2`) passed in is returned unchanged (after a
 * real `WorkflowDocSchema.parse`, never trusted un-parsed) — this module is
 * the single entry point every reader uses, whichever version the stored row
 * actually holds.
 */

// ---------------------------------------------------------------------------
// The v1 shape, frozen here — a COPY, never imported from `@enkaku/protocol`
// (plan 301 §4.4 rule 1). Protocol ships one current shape; the historical
// one lives with its migration, so a future reader of `workflow.ts` is never
// tempted to reach for a schema that no longer describes what is stored.
// ---------------------------------------------------------------------------

const V1GateOutcomeSchema = z.union([
  z.object({ go: z.enum(['continue', 'stop', 'fail']) }).strict(),
  z.object({ go: z.literal('goto'), node: WorkflowNodeIdSchema }).strict(),
])
type V1GateOutcome = z.infer<typeof V1GateOutcomeSchema>

const V1WorkflowNodeSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('script'),
      id: WorkflowNodeIdSchema,
      title: z.string().max(80).default(''),
      script: ScriptRefSchema,
      params: z.record(WorkflowParamNameSchema, ValueExprSchema).default({}),
      reset: z.enum(['farm', 'none']).optional(),
      retries: z.number().int().min(0).max(10).optional(),
      onFailure: V1GateOutcomeSchema.default({ go: 'fail' }),
      next: WorkflowNodeIdSchema.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('gate'),
      id: WorkflowNodeIdSchema,
      title: z.string().max(80).default(''),
      when: PredicateSchema,
      then: V1GateOutcomeSchema.default({ go: 'continue' }),
      else: V1GateOutcomeSchema.default({ go: 'stop' }),
      message: z.string().max(200).default(''),
    })
    .strict(),
])
type V1WorkflowNode = z.infer<typeof V1WorkflowNodeSchema>

const WorkflowDocV1Schema = z
  .object({
    schema: z.literal(1),
    name: WorkflowNameSchema,
    title: z.string().max(80).default(''),
    description: z.string().max(300).default(''),
    params: z.array(WorkflowParamSchema).max(WORKFLOW_LIMITS.maxParams).default([]),
    nodes: z.array(V1WorkflowNodeSchema).min(1).max(WORKFLOW_LIMITS.maxNodes),
    maxSteps: z.number().int().min(1).max(500).default(50),
    onFail: z
      .object({ script: ScriptRefSchema, params: z.record(WorkflowParamNameSchema, ValueExprSchema).default({}) })
      .strict()
      .optional(),
  })
  .strict()

// ---------------------------------------------------------------------------
// Rank-and-row layout (rule 6) — the SAME algorithm and constants
// `packages/studio/src/components/workflow/compute-layout.ts` uses, ported
// here because a core module never imports from `packages/studio` (that is
// not a workspace dependency): a node's rank is the longest forward-edge
// distance from index 0 (backward edges excluded from rank propagation, so
// this terminates on a cyclic graph too); row, within one rank, is array
// order. Matches `compute-layout.ts`'s constants so a document opens looking
// the way it looked the day before.
// ---------------------------------------------------------------------------

const COLUMN_WIDTH_PX = 240
const ROW_HEIGHT_PX = 130

interface RankEdge {
  from: string
  to: string
}

function rankAndRow(ids: readonly string[], edges: readonly RankEdge[]): Map<string, { x: number; y: number }> {
  const positions = new Map<string, { x: number; y: number }>()
  if (ids.length === 0) return positions

  const indexOf = new Map(ids.map((id, i) => [id, i]))
  const forwardEdges = edges.filter((e) => (indexOf.get(e.to) ?? 0) > (indexOf.get(e.from) ?? 0))

  const rank = new Map<string, number>()
  rank.set(ids[0]!, 0)
  for (let pass = 0; pass < ids.length; pass++) {
    let changed = false
    for (const e of forwardEdges) {
      const fromRank = rank.get(e.from)
      if (fromRank === undefined) continue
      const candidate = fromRank + 1
      if ((rank.get(e.to) ?? -1) < candidate) {
        rank.set(e.to, candidate)
        changed = true
      }
    }
    if (!changed) break
  }
  for (const id of ids) {
    if (!rank.has(id)) rank.set(id, indexOf.get(id)!)
  }

  const byRank = new Map<number, string[]>()
  for (const id of ids) {
    const r = rank.get(id)!
    const list = byRank.get(r)
    if (list) list.push(id)
    else byRank.set(r, [id])
  }

  for (const [r, rowIds] of byRank) {
    rowIds.forEach((id, row) => {
      positions.set(id, { x: r * COLUMN_WIDTH_PX, y: row * ROW_HEIGHT_PX })
    })
  }
  return positions
}

// ---------------------------------------------------------------------------
// Rules 2-6 (plan 301 §4.4).
// ---------------------------------------------------------------------------

/** A fresh id for the prepended `start` node — `start`, or `start-2`, `start-3`... on collision with a real v1 node id (rule 2). */
function freshStartId(existing: ReadonlySet<string>): string {
  if (!existing.has('start')) return 'start'
  for (let i = 2; i < 10_000; i++) {
    const candidate = `start-${i}`
    if (!existing.has(candidate)) return candidate
  }
  throw new EnkakuError('E_WORKFLOW_UPGRADE_FAILED', 'could not find a free id for the prepended start node')
}

/** The array-order successor of `id`, or `undefined` past the end (v1's implicit fallthrough, plan 300 D1's own "materialise it once, at read time" rule). */
function arrayNextId(nodes: readonly V1WorkflowNode[], index: number): string | undefined {
  return nodes[index + 1]?.id
}

interface FinishPlan {
  succeedId: string | null
  failId: string | null
}

/** Interprets one v1 `GateOutcome`, given the finish-node ids this document will end up with (allocated lazily — rule 4: "at most two finish nodes are created per document, and only when referenced"). */
function outcomeToEdge(outcome: V1GateOutcome, index: number, nodes: readonly V1WorkflowNode[], finish: FinishPlan): string | undefined {
  switch (outcome.go) {
    case 'goto':
      return outcome.node
    case 'continue': {
      const next = arrayNextId(nodes, index)
      return next ?? (finish.succeedId ?? undefined)
    }
    case 'stop':
      return finish.succeedId ?? undefined
    case 'fail':
      return finish.failId ?? undefined
  }
}

/**
 * The pure v1 → v2 conversion, rules 2-6. Called only once `raw` has already
 * been proven to satisfy `WorkflowDocV1Schema` by `upgradeWorkflowDoc`.
 */
function convertV1(v1: z.infer<typeof WorkflowDocV1Schema>): WorkflowDoc {
  const existingIds = new Set(v1.nodes.map((n) => n.id))
  const startId = freshStartId(existingIds)

  // Rule 4 — allocate at most one `finish` node per terminal status, and
  // only when something actually references it. A script node's OWN `next`
  // (rule 3) never needs one — absent at the last index just stays dangling,
  // exactly as v1's implicit fallthrough already implied at the end of the
  // array. Only a GATE outcome of `stop` (always) or `continue` past the
  // last index needs the shared succeed-finish (rule 4's own wording).
  function gateNeedsSucceed(outcome: V1GateOutcome, index: number): boolean {
    if (outcome.go === 'stop') return true
    if (outcome.go === 'continue') return arrayNextId(v1.nodes, index) === undefined
    return false
  }
  const needsSucceed = v1.nodes.some((n, i) => n.kind === 'gate' && (gateNeedsSucceed(n.then, i) || gateNeedsSucceed(n.else, i)))
  const needsFail = v1.nodes.some((n) => (n.kind === 'script' && n.onFailure.go === 'fail') || (n.kind === 'gate' && (n.then.go === 'fail' || n.else.go === 'fail')))

  function freshFinishId(seed: string, taken: ReadonlySet<string>): string {
    if (!taken.has(seed)) return seed
    for (let i = 2; i < 10_000; i++) {
      const candidate = `${seed}-${i}`
      if (!taken.has(candidate)) return candidate
    }
    throw new EnkakuError('E_WORKFLOW_UPGRADE_FAILED', `could not find a free id for the "${seed}" finish node`)
  }
  const takenIds = new Set([...existingIds, startId])
  const realSucceedId = needsSucceed ? freshFinishId('finish-succeed', takenIds) : null
  if (realSucceedId) takenIds.add(realSucceedId)
  const realFailId = needsFail ? freshFinishId('finish-failed', takenIds) : null
  if (realFailId) takenIds.add(realFailId)

  const finish: FinishPlan = { succeedId: realSucceedId, failId: realFailId }

  const convertedNodes: WorkflowNode[] = []

  convertedNodes.push({ id: startId, title: '', ui: { x: 0, y: 0 }, kind: 'start', next: v1.nodes[0]?.id })

  v1.nodes.forEach((node, i) => {
    if (node.kind === 'script') {
      // Rule 3 — materialise the implicit fallthrough once; absent at the
      // last index stays dangling (never routed to a finish node).
      const next = node.next ?? arrayNextId(v1.nodes, i)
      const onFailure = outcomeToEdge(node.onFailure, i, v1.nodes, finish)
      convertedNodes.push({
        id: node.id,
        title: node.title,
        ui: { x: 0, y: 0 },
        kind: 'script',
        script: node.script,
        params: node.params,
        reset: node.reset,
        retries: node.retries,
        next,
        onFailure,
      })
    } else {
      const then = outcomeToEdge(node.then, i, v1.nodes, finish)
      const els = outcomeToEdge(node.else, i, v1.nodes, finish)
      convertedNodes.push({
        id: node.id,
        title: node.title,
        ui: { x: 0, y: 0 },
        kind: 'gate',
        when: node.when,
        then,
        else: els,
      })
    }
  })

  if (finish.succeedId) convertedNodes.push({ id: finish.succeedId, title: '', ui: { x: 0, y: 0 }, kind: 'finish', status: 'succeed', message: '' })
  if (finish.failId) {
    // Rule 4 — the FIRST gate `{ go: 'fail' }`'s own `message` becomes the
    // shared fail-finish's message (a v1 document rarely declares more than
    // one, and the executor only ever showed one message per run anyway).
    const withMessage = v1.nodes.find((n) => n.kind === 'gate' && (n.then.go === 'fail' || n.else.go === 'fail')) as Extract<V1WorkflowNode, { kind: 'gate' }> | undefined
    convertedNodes.push({ id: finish.failId, title: '', ui: { x: 0, y: 0 }, kind: 'finish', status: 'fail', message: withMessage?.message ?? '' })
  }

  // Rule 6 — rank-and-row over the newly-explicit edges.
  const rankEdges: RankEdge[] = []
  for (const n of convertedNodes) {
    if (n.kind === 'start' && n.next) rankEdges.push({ from: n.id, to: n.next })
    if (n.kind === 'script') {
      if (n.next) rankEdges.push({ from: n.id, to: n.next })
      if (n.onFailure) rankEdges.push({ from: n.id, to: n.onFailure })
    }
    if (n.kind === 'gate') {
      if (n.then) rankEdges.push({ from: n.id, to: n.then })
      if (n.else) rankEdges.push({ from: n.id, to: n.else })
    }
  }
  const positions = rankAndRow(
    convertedNodes.map((n) => n.id),
    rankEdges,
  )
  const positioned = convertedNodes.map((n) => ({ ...n, ui: positions.get(n.id) ?? n.ui }))

  const v2 = {
    schema: 2 as const,
    name: v1.name,
    title: v1.title,
    description: v1.description,
    params: v1.params,
    entry: startId,
    nodes: positioned,
    maxSteps: v1.maxSteps,
    onFail: v1.onFail,
  }

  return WorkflowDocSchema.parse(v2)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Upgrades `raw` to a v2 `WorkflowDoc` — the ONE entry point every reader of
 * a stored workflow document goes through (plan 301 §4.4, §4.5). A document
 * already at `schema: 2` is parsed and returned unchanged (rule 7). Throws
 * `E_WORKFLOW_SCHEMA_UNKNOWN` for a `schema` outside `{1, 2}`, and
 * `E_WORKFLOW_UPGRADE_FAILED` for a `schema: 1` document that does not
 * satisfy the frozen v1 shape — both plan 301 §4.6's own codes.
 */
export function upgradeWorkflowDoc(raw: unknown): WorkflowDoc {
  const schema = isPlainObject(raw) ? raw.schema : undefined
  if (schema === 2) {
    const parsed = WorkflowDocSchema.safeParse(raw)
    if (!parsed.success) throw new EnkakuError('E_WORKFLOW_UPGRADE_FAILED', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '))
    return parsed.data
  }
  if (schema === 1) {
    const parsed = WorkflowDocV1Schema.safeParse(raw)
    if (!parsed.success) throw new EnkakuError('E_WORKFLOW_UPGRADE_FAILED', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '))
    return convertV1(parsed.data)
  }
  throw new EnkakuError('E_WORKFLOW_SCHEMA_UNKNOWN', `workflow document declares schema ${JSON.stringify(schema)}, expected 1 or 2`)
}
