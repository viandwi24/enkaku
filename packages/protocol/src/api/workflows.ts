import { z } from 'zod'
import { WorkflowDocSchema } from '../workflow'

export const WorkflowInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  doc: WorkflowDocSchema,
  createdBy: z.string().nullable(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
  /**
   * Plan 315 — the plugin that ships this workflow, or `null` for one an
   * operator wrote. A plugin's workflow is registered when that plugin's
   * version is activated and is READ-ONLY: `PUT`/`DELETE` refuse it with
   * `E_WORKFLOW_MANAGED`, and the way to change one is to duplicate it into a
   * workflow of your own. Its name always carries the plugin's prefix
   * (`smm/warmup-rotation`), which an operator's workflow can never have.
   *
   * `.default(null)` so a core that predates plan 315 still parses.
   */
  pluginName: z.string().nullable().default(null),
})
export type WorkflowInfo = z.infer<typeof WorkflowInfoSchema>

/** `GET /api/workflows`: every workflow, sorted by name; small enough to carry the documents. */
export const WorkflowsListResponseSchema = z.object({ items: z.array(WorkflowInfoSchema), total: z.number().int() })
/** `GET /api/workflows/:name`, `POST /api/workflows`, `PUT /api/workflows/:name`. */
export const WorkflowResponseSchema = z.object({ workflow: WorkflowInfoSchema })
/** `DELETE /api/workflows/:name`. */
export const WorkflowDeleteResponseSchema = z.object({ ok: z.literal(true) })
