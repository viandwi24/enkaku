import { z } from 'zod'
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
 * A value a node parameter or a gate operand can take (plan 99 §3.6). Four
 * forms, closed:
 *
 * - `{ const }` — a literal.
 * - `{ param }` — a WORKFLOW parameter (`workflow-params.ts`).
 * - `{ from, path? }` — an EARLIER node's output, whole or one path into it.
 *   `optional`/`default` let a binding degrade to a stand-in value instead of
 *   failing the node when the path does not resolve (plan 99 §3.6's
 *   "unchecked" branch, resolved at run time by `workflow-resolve.ts`).
 * - `{ run: 'summary' }` — the run summary: one entry per completed node.
 *
 * Never a fifth form that COMPUTES — see `workflow.ts`'s module doc and plan
 * 99 §3.6: the moment a binding can compute, it is an expression language,
 * and this plan refuses to build one (F27, the same refusal plan 95 §3.8 R2
 * already made for an author-supplied regular expression).
 */
export type ValueExpr =
  | { const: unknown }
  | { param: string }
  | { from: string; path?: string; optional: boolean; default?: unknown }
  | { run: 'summary' }

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

/** Where the cursor goes next (plan 99 §3.7). `stop` ends the workflow SUCCESSFULLY, here. `fail` ends it FAILED. `goto` may jump forward or backward. */
export const GateOutcomeSchema = z.union([
  z.object({ go: z.enum(['continue', 'stop', 'fail']) }).strict(),
  z.object({ go: z.literal('goto'), node: WorkflowNodeIdSchema }).strict(),
])
export type GateOutcome = z.infer<typeof GateOutcomeSchema>

/**
 * One node in a workflow document (plan 99 §4.1). `kind: 'script'` runs an
 * ordinary published script as a child, through the SAME `JobRunner` every
 * standalone job uses (§3.4) — nothing about a node's `timeout`/`retries`/
 * `finish()` is reimplemented. `kind: 'gate'` evaluates a predicate
 * in-process, spawning no child and making no device call (§3.7).
 */
export const WorkflowNodeSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('script'),
      id: WorkflowNodeIdSchema,
      title: z.string().max(80).default(''),
      /** `name@version` or `name@latest` — the EXISTING reference grammar (F17), no second resolution path. */
      script: ScriptRefSchema,
      params: z.record(WorkflowParamNameSchema, ValueExprSchema).default({}),
      /** Plan 99 §3.3. Defaults to `'farm'` for the FIRST node, `'none'` for every later one — the executor's job (§4.7), not this schema's, since it depends on position in the array. */
      reset: z.enum(['farm', 'none']).optional(),
      /** Overrides the node script's own `ScriptDefinition.retries`. */
      retries: z.number().int().min(0).max(10).optional(),
      onFailure: GateOutcomeSchema.default({ go: 'fail' }),
      /** Explicit successor; absent = the next node in the array (plan 99 §3.9). */
      next: WorkflowNodeIdSchema.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('gate'),
      id: WorkflowNodeIdSchema,
      title: z.string().max(80).default(''),
      when: PredicateSchema,
      then: GateOutcomeSchema.default({ go: 'continue' }),
      else: GateOutcomeSchema.default({ go: 'stop' }),
      /** Shown on the job row when this gate ends the workflow. */
      message: z.string().max(200).default(''),
    })
    .strict(),
])
export type WorkflowNode = z.infer<typeof WorkflowNodeSchema>

const WorkflowDocShapeSchema = z
  .object({
    schema: z.literal(1),
    name: WorkflowNameSchema,
    title: z.string().max(80).default(''),
    description: z.string().max(300).default(''),
    params: z.array(WorkflowParamSchema).max(WORKFLOW_LIMITS.maxParams).default([]),
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
 * The validated workflow document (plan 99 §3.1, §4.1; no version as of plan
 * 210, MVP 03 §2.2 rule 4) — this is what `workflows.doc` and `jobs.workflow_doc`
 * hold: a farm-owned pipeline, edited in place, with no version of its own. A
 * job snapshots this document at enqueue time so editing a workflow never
 * changes a queued or running job. Only what a per-node regex cannot express
 * is checked here: node id uniqueness. Everything requiring a lookup against
 * OTHER scripts (a dangling `goto`, a binding that reads a node that cannot
 * have run yet, a `{ param }` naming an undeclared workflow parameter) is
 * `checkWorkflow`'s job (`workflow-check.ts`, plan 99 §4.3, step 99.6) — a
 * separate, pure function that needs resolved script metadata this schema
 * does not have.
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
})
export type WorkflowDoc = z.infer<typeof WorkflowDocSchema>
