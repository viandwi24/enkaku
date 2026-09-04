import { z } from 'zod'
import { WorkflowNodeIdSchema } from '../workflow'

/**
 * `GET /api/workflows/:name/last-run` (plan 306 §4.5, §3.1) — the node panel's
 * data panes are a READ of the last real run's own `workflow_steps` rows, not
 * a new capture mechanism; this is the shape of that read.
 *
 * A step's `input`/`output` is dropped, not truncated, once it is over
 * `WORKFLOW_LIMITS.maxNodeOutputBytes` (`jobs/executors/workflow.ts`'s
 * `capOutput`/`capInput`) — recorded as `null` with a log warning, because
 * `workflow_steps` has an `output_truncated` marker column but no matching
 * column for `input`. So a pane cannot show one "empty" state for three
 * different facts: the node did not run in the last run at all, the node ran
 * and genuinely returned nothing, or the value was dropped for being over the
 * cap. `WorkflowLastRunNodeDataSchema` names the three states explicitly so
 * the Studio panel (plan 306 §3.1) never conflates them.
 */
export const WorkflowLastRunNodeDataSchema = z.discriminatedUnion('state', [
  /** This node has no recorded step in the last real run at all. */
  z.object({ state: z.literal('none') }).strict(),
  /** The node ran and this pane's recorded value was `null`/`undefined`. */
  z.object({ state: z.literal('empty') }).strict(),
  /** The value was over the cap and was never recorded — not truncated, dropped. */
  z.object({ state: z.literal('dropped') }).strict(),
  /** The node ran and this pane holds a real value. */
  z.object({ state: z.literal('value'), value: z.unknown() }).strict(),
])
export type WorkflowLastRunNodeData = z.infer<typeof WorkflowLastRunNodeDataSchema>

export const WORKFLOW_STEP_STATUSES = ['running', 'success', 'failed', 'skipped', 'carried-over', 'cancelled'] as const

export const WorkflowLastRunNodeSchema = z.object({
  nodeId: WorkflowNodeIdSchema,
  /** `null` when the node has no recorded step in the last real run (never logged, e.g. `start`/`finish`, or simply not reached). */
  status: z.enum(WORKFLOW_STEP_STATUSES).nullable(),
  /** Authoring-state pin (plan 300 P10) — independent of whether the node ran in the last real run at all. */
  pinned: z.boolean(),
  /** The edge the step left by (`'next' | 'onFailure' | 'then' | 'else' | 'case:<i>' | 'default'`), or `null`. */
  takenEdge: z.string().nullable(),
  /** `workflow_steps.seq` — `@enkaku/expr`'s `deriveRandom(seed, seq)` needs it for a local `$random` preview that matches what the server produced (plan 306 §4.4). `null` when the node has no recorded step. */
  seq: z.number().int().nullable(),
  input: WorkflowLastRunNodeDataSchema,
  output: WorkflowLastRunNodeDataSchema,
})
export type WorkflowLastRunNode = z.infer<typeof WorkflowLastRunNodeSchema>

/**
 * `GET /api/workflows/:name/last-run` — 404 (`workflow_never_run`) when the
 * workflow has never run for real (a `node-test` run alone does not count).
 * `params`/`seed` are the run's own — everything `usePreview.ts` (plan 306
 * §4.4) needs to build the SAME `ExprScope` shape the server built
 * (`workflow-resolve.ts`'s `buildExprScope`), locally, with no round trip.
 */
export const WorkflowLastRunResponseSchema = z.object({
  runId: z.string(),
  /** Unix seconds — the run's own `startedAt`, falling back to `createdAt` for a run that never started. */
  at: z.number().int(),
  /** The workflow parameters this run was started with — `$params` in the preview scope. */
  params: z.unknown(),
  /** The run's own `$random` seed (`deriveRandom`'s first argument). */
  seed: z.number().int(),
  nodes: z.record(z.string(), WorkflowLastRunNodeSchema),
})
export type WorkflowLastRunResponse = z.infer<typeof WorkflowLastRunResponseSchema>
