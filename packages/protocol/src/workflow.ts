import { z } from 'zod'
import { EXPR_LIMITS } from '@enkaku/expr'
import { ScriptRefSchema } from './script-ref'
import { WorkflowParamNameSchema, WorkflowParamSchema, type WorkflowParam } from './workflow-params'

/**
 * Written limits on a workflow document (plan 99 §4.10) — the same
 * discipline `SCHEMA_LIMITS` (`params/limits.ts`) applies to an
 * author-controlled params schema, applied here because a workflow document
 * is the same kind of untrusted, browser-authored, database-stored input.
 * `maxDocBytes`, `maxNodeOutputBytes`, `maxRunSummaryBytes` are enforced
 * outside this module (the publish route and the executor, plan 99 §5 steps
 * 99.6/99.7) — they live here because this is the one file every consumer of
 * a workflow limit already imports.
 */
export const WORKFLOW_LIMITS = {
  maxNodes: 50,
  /** `SCHEMA_LIMITS.maxFields` is 200; a FORM of 40 is already a lot. */
  maxParams: 40,
  /** 2x `SCHEMA_LIMITS.maxSchemaBytes` — a doc holds a schema plus nodes. */
  maxDocBytes: 128 * 1024,
  maxPredicateDepth: 3,
  maxPredicateLeaves: 20,
  /** Matches `shell.maxOutputBytes`'s 262_144 (`settings.ts`). */
  maxNodeOutputBytes: 256 * 1024,
  /** `{ run: 'summary' }`, across all nodes. */
  maxRunSummaryBytes: 512 * 1024,
  /** Keys named in an unresolved-binding message (plan 99 §3.6). */
  maxSawKeys: 20,
  /** A `switch` with more than this many cases is a table, and a table is a script (plan 303 §4.1). */
  maxSwitchCases: 10,
  /** The largest a single `delay` node may declare (plan 303 §3.4, §4.1). Longer waits are a schedule, not a workflow. */
  maxDelayMs: 5 * 60_000,
} as const

/**
 * A node's own id within one document — unique per document (checked below
 * by `WorkflowDocSchema`'s own `superRefine`, since uniqueness across an
 * array is not expressible as a per-element regex). The same
 * lowercase-digits-hyphens id grammar this repo already uses for an agent
 * slug (`agent.ts`'s `AgentSlugSchema`) and a plugin id
 * (`packages/sdk/src/plugin.ts`'s `ID_SHAPE`) — one more instance, not a new
 * one, and short enough to read in the editor's branch rail (plan 99 §3.9).
 */
export const WorkflowNodeIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'lowercase letters, numbers, and hyphens only, starting with a letter or number')
export type WorkflowNodeId = z.infer<typeof WorkflowNodeIdSchema>

/**
 * A value expression's `path` (plan 99 §3.6) — a dotted path of identifier
 * segments and non-negative integer indices ONLY. No `[0]`, no `*`, no
 * filters, no functions, no arithmetic, no string interpolation: this is a
 * LOOKUP, never an expression (§3.7's "no expression language" doctrine
 * applied one level down). Validated once, here, at publish AND at run time
 * by the SAME regex — never against author-supplied input in the sense §3.8
 * R2 forbids, because a path is never compiled or evaluated as code, only
 * split on `.` and walked (`workflow-resolve.ts`'s `resolveValue`).
 */
export const WorkflowPathSchema = z
  .string()
  .max(200)
  .regex(
    /^[A-Za-z_][A-Za-z0-9_]*(?:\.(?:[A-Za-z_][A-Za-z0-9_]*|\d+))*$/,
    'a dotted path of identifier segments and non-negative integer indices only — no [ ], no *, no functions (plan 99 §3.6)',
  )

/**
 * A workflow's own `name`. Duplicates the NAME half of `ScriptRefSchema`'s
 * grammar (`script-ref.ts:15-17`, one monolithic regex with no factored-out
 * name-only export) deliberately — the same precedent plan 94 §4.1 already
 * set for a recording's name, for the same reason: validated against the
 * grammar a script name ALREADY uses, hardcoded again rather than invented
 * anew, because splitting `ScriptRefSchema` into reusable halves touches a
 * file this plan does not own.
 *
 * A `/` is legal at the SCHEMA level, exactly as it is for a script's name —
 * a workflow is not a plugin member, so plan 99 §4.1 refuses a `/` in a
 * workflow name at the EDITOR, where the mistake can be named in a way a
 * publish-time 400 cannot, rather than in this schema.
 */
export const WorkflowNameSchema = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)?$/,
    'lowercase letters, digits, and . _ - (one optional /-separated segment) — the same grammar a script name uses',
  )

/**
 * A value a node parameter or a gate operand can take (plan 99 §3.6, plan 300
 * D4). Five forms, closed:
 *
 * - `{ const }` — a literal.
 * - `{ param }` — a WORKFLOW parameter (`workflow-params.ts`).
 * - `{ from, path? }` — an EARLIER node's output, whole or one path into it.
 *   `optional`/`default` let a binding degrade to a stand-in value instead of
 *   failing the node when the path does not resolve (plan 99 §3.6's
 *   "unchecked" branch, resolved at run time by `workflow-resolve.ts`).
 * - `{ run: 'summary' }` — the run summary: one entry per completed node.
 * - `{ expr }` — a pure, bounded expression parsed and evaluated by
 *   `@enkaku/expr` (plan 300 D4, plan 302). Plan 99 §3.6's F27 stance — a
 *   binding must never compute — is reversed by plan 300 D4, on the grounds
 *   that `@enkaku/expr` is a closed, pure, prototype-free AST interpreter,
 *   never `eval`/`new Function`/a library that emits JavaScript — see plan
 *   300 §3 D4 for the evidence and the boundary. The other four forms are
 *   unchanged.
 */
export type ValueExpr =
  | { const: unknown }
  | { param: string }
  | { from: string; path?: string; optional: boolean; default?: unknown }
  | { run: 'summary' }
  | { expr: string }

export const ValueExprSchema: z.ZodType<ValueExpr> = z.union([
  z.object({ const: z.unknown() }).strict(),
  z.object({ param: WorkflowParamNameSchema }).strict(),
  z
    .object({
      from: WorkflowNodeIdSchema,
      path: WorkflowPathSchema.optional(),
      optional: z.boolean().default(false),
      default: z.unknown().optional(),
    })
    .strict(),
  z.object({ run: z.literal('summary') }).strict(),
  z.object({ expr: z.string().min(1).max(EXPR_LIMITS.maxSourceBytes) }).strict(),
])

/**
 * Closed. No regular expressions, ever (plan 95 §3.8 R2, plan 99 §3.7) — an
 * author who needs a pattern match writes a script node that returns a
 * verdict (§3.7's "escape hatch is a script" doctrine), never a `pattern`
 * evaluated here.
 */
export const GATE_OPS = [
  'eq',
  'ne',
  'lt',
  'lte',
  'gt',
  'gte',
  'contains',
  'notContains',
  'startsWith',
  'endsWith',
  'exists',
  'notExists',
  'isEmpty',
  'notEmpty',
  'length',
] as const
export type GateOp = (typeof GATE_OPS)[number]

/** A closed predicate over values already in scope (plan 99 §3.7). */
export type Predicate =
  | { left: ValueExpr; op: GateOp; right?: ValueExpr }
  | { all: Predicate[] }
  | { any: Predicate[] }
  | { not: Predicate }

const PredicateShapeSchema: z.ZodType<Predicate> = z.lazy(() =>
  z.union([
    z.object({ left: ValueExprSchema, op: z.enum(GATE_OPS), right: ValueExprSchema.optional() }).strict(),
    z.object({ all: z.array(PredicateShapeSchema).min(1).max(WORKFLOW_LIMITS.maxPredicateLeaves) }).strict(),
    z.object({ any: z.array(PredicateShapeSchema).min(1).max(WORKFLOW_LIMITS.maxPredicateLeaves) }).strict(),
    z.object({ not: PredicateShapeSchema }).strict(),
  ]),
)

/** The greatest nesting depth in `pred` — a leaf counts as depth 1. Total: `all`/`any` are non-empty by the time this runs (Zod's own `.min(1)` already refused an empty one), so `Math.max` never sees an empty spread. */
function predicateDepth(pred: Predicate): number {
  if ('all' in pred) return 1 + Math.max(0, ...pred.all.map(predicateDepth))
  if ('any' in pred) return 1 + Math.max(0, ...pred.any.map(predicateDepth))
  if ('not' in pred) return 1 + predicateDepth(pred.not)
  return 1
}

/**
 * A closed predicate, expressed as data (plan 99 §3.7). Depth ≤
 * `WORKFLOW_LIMITS.maxPredicateDepth` and ≤ `maxPredicateLeaves` leaves per
 * `all`/`any` are the bound that keeps a gate "a decision, not a program" —
 * enforced here with a named message (`predicateDepth`, above) rather than
 * left to Zod's own union-mismatch wording, because an author fixing a
 * four-level predicate needs to be told it is too deep, not just that it
 * "did not match any variant".
 */
export const PredicateSchema: z.ZodType<Predicate> = PredicateShapeSchema.superRefine((pred, ctx) => {
  const depth = predicateDepth(pred)
  if (depth > WORKFLOW_LIMITS.maxPredicateDepth) {
    ctx.addIssue({
      code: 'custom',
      message: `predicate is nested ${depth} levels deep, over the ${WORKFLOW_LIMITS.maxPredicateDepth}-level limit (plan 99 §3.7)`,
    })
  }
})

/**
 * Canvas position (plan 300 D2, plan 301 §4.1) — integers, bounded, so a
 * document cannot carry a 1e308 that breaks the viewport maths.
 */
export const WorkflowPointSchema = z
  .object({
    x: z.number().int().min(-100_000).max(100_000),
    y: z.number().int().min(-100_000).max(100_000),
  })
  .strict()
export type WorkflowPoint = z.infer<typeof WorkflowPointSchema>

/** Fields every node has, whatever its kind (plan 301 §4.1). */
const nodeBase = {
  id: WorkflowNodeIdSchema,
  title: z.string().max(80).default(''),
  ui: WorkflowPointSchema,
}

/**
 * One node in a workflow document (plan 99 §4.1, rewritten by plan 301 §4.1
 * for doc v2). Every edge is written down as a node id (plan 300 D1) — array
 * order (`nodes[]`) carries no control meaning any more. `kind: 'start'` and
 * `kind: 'finish'` are new (plan 301 §3.2, §3.4): a run begins at the ONE
 * `start` node named by `doc.entry` and ends at a `finish` node (or a
 * dangling edge, which behaves as one — see `WorkflowDocSchema`'s own doc
 * comment). `kind: 'script'` runs an ordinary published script as a child,
 * through the SAME `JobRunner` every standalone job uses (§3.4) — nothing
 * about a node's `timeout`/`retries`/`finish()` is reimplemented. `kind:
 * 'gate'` evaluates a predicate in-process, spawning no child and making no
 * device call (§3.7). `kind: 'switch'` and `kind: 'delay'` are new (plan 303
 * §3.2, §4.1): `switch` is the owner's "conditions C -> 1 / 2 / 3" as one
 * node — an ordered list of predicate-plus-target cases, first match wins,
 * `default` otherwise — and `delay` is a bounded, cancellable wait, core-
 * owned because its budget contribution (`maxMs`) must be known statically.
 * Six kinds total, and the list is closed (plan 300 D8): a plugin may never
 * define a seventh.
 */
export const WORKFLOW_NODE_KINDS = ['start', 'script', 'gate', 'switch', 'delay', 'finish'] as const
export const WorkflowNodeSchema = z.discriminatedUnion('kind', [
  z
    .object({
      ...nodeBase,
      kind: z.literal('start'),
      /** Absent = dangling; reaching it ends the run succeeded (plan 301 §3.2). */
      next: WorkflowNodeIdSchema.optional(),
    })
    .strict(),

  z
    .object({
      ...nodeBase,
      kind: z.literal('script'),
      /** `name@version` or `name@latest` — the EXISTING reference grammar (F17), no second resolution path. */
      script: ScriptRefSchema,
      params: z.record(WorkflowParamNameSchema, ValueExprSchema).default({}),
      /** Plan 99 §3.3. Defaults to `'farm'` for the FIRST node, `'none'` for every later one — the executor's job (§4.7), not this schema's, since it depends on position in the array. */
      reset: z.enum(['farm', 'none']).optional(),
      /** Overrides the node script's own `ScriptDefinition.retries`. */
      retries: z.number().int().min(0).max(10).optional(),
      /** Absent = dangling; reaching it ends the run succeeded (plan 301 §3.2). */
      next: WorkflowNodeIdSchema.optional(),
      /** Absent = dangling; reaching it ends the run failed (plan 301 §3.2). */
      onFailure: WorkflowNodeIdSchema.optional(),
    })
    .strict(),

  z
    .object({
      ...nodeBase,
      kind: z.literal('gate'),
      when: PredicateSchema,
      then: WorkflowNodeIdSchema.optional(),
      else: WorkflowNodeIdSchema.optional(),
    })
    .strict(),

  /**
   * `switch` (plan 303 §3.3, §4.1) — the owner's "conditions C -> 1 / 2 / 3"
   * as ONE node, not a chain of gates. A case is a predicate PLUS a target,
   * never an expression returning an output index (plan 300 R7's n8n
   * comparison, refused deliberately): an index breaks silently when cases
   * are reordered on the canvas and the fired branch is not visible on the
   * edge. Cases are evaluated in array order, first match wins; `default`
   * fires when none do. It reuses `PredicateSchema` unchanged, so the
   * existing depth/leaf limits and predicate editor both already apply.
   */
  z
    .object({
      ...nodeBase,
      kind: z.literal('switch'),
      cases: z
        .array(
          z
            .object({
              when: PredicateSchema,
              /** Absent = dangling; reaching it ends the run SUCCEEDED (plan 301 §3.2), same as every other dangling edge. */
              to: WorkflowNodeIdSchema.optional(),
              label: z.string().max(40).default(''),
            })
            .strict(),
        )
        .min(1)
        .max(WORKFLOW_LIMITS.maxSwitchCases),
      default: WorkflowNodeIdSchema.optional(),
    })
    .strict(),

  /**
   * `delay` (plan 303 §3.4, §4.1) — a wait, costing a step, touching no
   * device. Core-owned rather than a script because its bound must be known
   * STATICALLY for `checkWorkflow`'s budget walk (§4.7 item 7): `ms` may be
   * ANY `ValueExpr` (including `{ expr }`, resolved at run time), but
   * `maxMs` is the document's own declared ceiling, is what the checker
   * sums into the budget, and is what the executor clamps the resolved
   * value to — a budget that cannot be computed statically is not a budget.
   */
  z
    .object({
      ...nodeBase,
      kind: z.literal('delay'),
      ms: ValueExprSchema,
      maxMs: z.number().int().min(0).max(WORKFLOW_LIMITS.maxDelayMs),
      next: WorkflowNodeIdSchema.optional(),
    })
    .strict(),

  z
    .object({
      ...nodeBase,
      kind: z.literal('finish'),
      status: z.enum(['succeed', 'fail']).default('succeed'),
      /** Shown on the job row when this node ends the run — the message `gate.message` used to carry (plan 301 §3.2). */
      message: z.string().max(200).default(''),
    })
    .strict(),
])
export type WorkflowNode = z.infer<typeof WorkflowNodeSchema>

const WorkflowDocShapeSchema = z
  .object({
    schema: z.literal(2),
    name: WorkflowNameSchema,
    title: z.string().max(80).default(''),
    description: z.string().max(300).default(''),
    params: z.array(WorkflowParamSchema).max(WORKFLOW_LIMITS.maxParams).default([]),
    /** The one `start` node. Never `nodes[0]` (plan 301 §3.4) — reordering the array never moves the start. */
    entry: WorkflowNodeIdSchema,
    nodes: z.array(WorkflowNodeSchema).min(1).max(WORKFLOW_LIMITS.maxNodes),
    /** Node EXECUTIONS, not nodes (plan 99 §3.9) — a loop can make the step count exceed the node count. */
    maxSteps: z.number().int().min(1).max(500).default(50),
    /** Always run when the workflow ends FAILED. Stateless and idempotent, like `finish()` (§3.2, §4.1). */
    onFail: z
      .object({ script: ScriptRefSchema, params: z.record(WorkflowParamNameSchema, ValueExprSchema).default({}) })
      .strict()
      .optional(),
  })
  .strict()

/**
 * The validated workflow document — doc v2 (plan 99 §3.1, §4.1; no version
 * field of its own as of plan 210, MVP 03 §2.2 rule 4; rewritten to an
 * explicit-edge graph by plan 301 §4.1, D1/D2). This is what `workflows.doc`
 * and `jobs.workflow_doc` hold: a farm-owned pipeline, edited in place, with
 * no version of its own. A job snapshots this document at enqueue time so
 * editing a workflow never changes a queued or running job.
 *
 * Every edge is a node id (`next`/`onFailure`/`then`/`else`), never an array
 * position: `nodes[]` is storage order and nothing more. A run begins at
 * `doc.entry` (the one `start` node) and ends at a `finish` node, or at a
 * dangling edge — an edge field left absent — which behaves as one (plan 301
 * §3.2): reaching the end of a `next` ends the run succeeded, reaching the
 * end of an `onFailure` ends it failed.
 *
 * Only what a per-node regex or a local invariant cannot express is checked
 * here: node id uniqueness, and that `entry` names a real `start` node.
 * Everything requiring a lookup against OTHER nodes or scripts (a dangling
 * edge, reachability, a binding that reads a node that cannot have run yet, a
 * `{ param }` naming an undeclared workflow parameter) is `checkWorkflow`'s
 * job (`workflow-check.ts`, plan 99 §4.3 / plan 301 §4.2) — a separate, pure
 * function that needs resolved script metadata this schema does not have.
 */
export const WorkflowDocSchema = WorkflowDocShapeSchema.superRefine((doc, ctx) => {
  const firstSeenAt = new Map<string, number>()
  doc.nodes.forEach((node, index) => {
    const firstIndex = firstSeenAt.get(node.id)
    if (firstIndex === undefined) {
      firstSeenAt.set(node.id, index)
      return
    }
    ctx.addIssue({
      code: 'custom',
      message: `duplicate node id "${node.id}" — node ids must be unique in one document (first used by nodes[${firstIndex}])`,
      path: ['nodes', index, 'id'],
    })
  })

  const entryIndex = doc.nodes.findIndex((n) => n.id === doc.entry)
  if (entryIndex === -1) {
    ctx.addIssue({ code: 'custom', message: `entry "${doc.entry}" is not a node in this document`, path: ['entry'] })
  } else if (doc.nodes[entryIndex]?.kind !== 'start') {
    ctx.addIssue({ code: 'custom', message: `entry "${doc.entry}" must name a "start" node`, path: ['entry'] })
  }

  const startNodes = doc.nodes.filter((n) => n.kind === 'start')
  if (startNodes.length !== 1) {
    ctx.addIssue({ code: 'custom', message: `a document must have exactly one "start" node (found ${startNodes.length})`, path: ['nodes'] })
  }
})
export type WorkflowDoc = z.infer<typeof WorkflowDocSchema>
