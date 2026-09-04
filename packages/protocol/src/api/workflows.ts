import { z } from 'zod'
import { WorkflowDocSchema } from '../workflow'

export const WorkflowInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  doc: WorkflowDocSchema,
  createdBy: z.string().nullable(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
})
export type WorkflowInfo = z.infer<typeof WorkflowInfoSchema>

/** `GET /api/workflows`: every workflow, sorted by name; small enough to carry the documents. */
export const WorkflowsListResponseSchema = z.object({ items: z.array(WorkflowInfoSchema), total: z.number().int() })
/** `GET /api/workflows/:name`, `POST /api/workflows`, `PUT /api/workflows/:name`. */
export const WorkflowResponseSchema = z.object({ workflow: WorkflowInfoSchema })
/** `DELETE /api/workflows/:name`. */
export const WorkflowDeleteResponseSchema = z.object({ ok: z.literal(true) })
