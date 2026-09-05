import { z } from 'zod'
import { JobInfoSchema } from '../messages/job'
import { WorkflowNodeIdSchema } from '../workflow'

/** One pinned node, without its data (plan 304 §4.3) — the data can be up to 256 KB, so the list never carries it. */
export const WorkflowPinListItemSchema = z.object({
  nodeId: WorkflowNodeIdSchema,
  updatedAt: z.number().int(),
  bytes: z.number().int(),
})
export type WorkflowPinListItem = z.infer<typeof WorkflowPinListItemSchema>

/** `GET /api/workflows/:name/pins`. */
export const WorkflowPinsListResponseSchema = z.object({ pins: z.array(WorkflowPinListItemSchema) })
/** `GET /api/workflows/:name/pins/:nodeId`. */
export const WorkflowPinDataResponseSchema = z.object({ data: z.unknown() })
/** `PUT /api/workflows/:name/pins/:nodeId` — `{ data }` pins the given value, `{ from: 'last-run' }` pins the node's most recently recorded output. */
export const WorkflowPinSetRequestSchema = z.union([z.object({ data: z.unknown() }).strict(), z.object({ from: z.literal('last-run') }).strict()])
export type WorkflowPinSetRequest = z.infer<typeof WorkflowPinSetRequestSchema>

/**
 * `POST /api/workflows/:name/run-node` (plan 300 P9, plan 304 §3.2, §4.3) —
 * runs ONE node alone, without running the workflow. `input` names where the
 * node's `$input` (the value its predecessor would have produced) comes
 * from; omitted defaults to the last real run's own recorded value for this
 * node's predecessor.
 */
export const WorkflowRunNodeRequestSchema = z.object({
  nodeId: WorkflowNodeIdSchema,
  deviceId: z.string().min(1),
  input: z
    .union([
      z.object({ from: z.literal('last-run') }).strict(),
      z.object({ from: z.literal('pin') }).strict(),
      z.object({ from: z.literal('literal'), value: z.unknown() }).strict(),
    ])
    .optional(),
})
export type WorkflowRunNodeRequest = z.infer<typeof WorkflowRunNodeRequestSchema>

/** The new node-test RUN — a job like any other (plan 304 §6: it appears in the Jobs list, never a hidden execution). */
export const WorkflowRunNodeResponseSchema = z.object({ job: JobInfoSchema, runId: z.string() })
export type WorkflowRunNodeResponse = z.infer<typeof WorkflowRunNodeResponseSchema>

/**
 * `POST /api/workflows/simulate` (plan 309 §4.3) — runs the WHOLE document,
 * with no device contact at all: `doc` is the editor's own unsaved document
 * (§4.4), never a stored name, since simulating the graph in front of the
 * author — including a node not yet saved — is the whole point.
 */
export const WorkflowSimulateRequestSchema = z.object({
  doc: z.unknown(),
  params: z.record(z.string(), z.unknown()).default({}),
  /** Author-written mocks, keyed by node id, merged over stored pins (plan 309 §4.1). */
  mocks: z.record(z.string(), z.unknown()).optional(),
})
export type WorkflowSimulateRequest = z.infer<typeof WorkflowSimulateRequestSchema>

/**
 * A simulated run is stored (plan 309 §3.4) so the canvas replays it through
 * the SAME overlay a real run uses — this response names it, nothing more.
 * `jobId` is included alongside `runId` (a small, deliberate widening of the
 * plan's own `{ runId }` sketch) because that overlay's own data source
 * (`useRunState`, `GET /api/workflow-jobs/:jobId/runs/:runId/steps`) is
 * keyed on BOTH — the same shape `run-node`'s response already carries.
 */
export const WorkflowSimulateResponseSchema = z.object({ jobId: z.string(), runId: z.string() })
export type WorkflowSimulateResponse = z.infer<typeof WorkflowSimulateResponseSchema>
