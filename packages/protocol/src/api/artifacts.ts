import { z } from 'zod'
import { ArtifactInfoSchema } from '../messages/job'
import { pageSchema } from './pagination'

/**
 * `PATCH /api/artifacts/:id` (plan 800 wave 5) — the two things an operator
 * changes about a file they uploaded, and nothing else.
 *
 * `label` is what the file is CALLED, not where it lives: renaming never moves
 * the bytes, because `path` is how every stored reference resolves and a
 * rename that broke a workflow's saved artifact id would be a rename nobody
 * could undo.
 *
 * Both optional, and a body naming neither is refused rather than treated as a
 * no-op success — a caller that sent nothing meant something.
 */
export const ArtifactUpdateInputSchema = z
  .object({
    label: z.string().min(1).max(200).optional(),
    pinned: z.boolean().optional(),
  })
  .refine((b) => b.label !== undefined || b.pinned !== undefined, 'name at least one of label or pinned')
export type ArtifactUpdateInput = z.infer<typeof ArtifactUpdateInputSchema>

export const ArtifactResponseSchema = z.object({ artifact: ArtifactInfoSchema })
export const ArtifactDeleteResponseSchema = z.object({ ok: z.literal(true), id: z.string() })

/**
 * `GET /api/artifacts` (plan 24 §4.6, widened by plan 93 §3.13, §4.4, §4.7,
 * step 93.10's `?kind=upload` — closing F14: an upload has BOTH `jobId` and
 * `deviceId` null, so it was unreachable through the existing `?jobId=` /
 * `?deviceId=` query modes). One envelope for all three query modes:
 * `items` is the current key, `artifacts` is kept alongside it, unchanged,
 * for whatever already reads the pre-plan-72 name (plan 72 §3.2's additive
 * rule for an existing response shape).
 */
export const ArtifactsPageResponseSchema = pageSchema(ArtifactInfoSchema).extend({
  artifacts: z.array(ArtifactInfoSchema),
})
