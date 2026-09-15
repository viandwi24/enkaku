import { z } from 'zod'
import { ArtifactInfoSchema, type ArtifactInfo } from '../messages/job'
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

/**
 * The three families the Files screen filters by, derived from what the
 * upload probe stored — never from a filename. Lives here, not in Studio,
 * because `POST /api/artifacts/delete`'s filter mode must select exactly the
 * files the operator is looking at when they press Clean up.
 */
export const ArtifactFamilySchema = z.enum(['image', 'video', 'other'])
export type ArtifactFamily = z.infer<typeof ArtifactFamilySchema>

export function artifactFamilyOf(item: Pick<ArtifactInfo, 'kind' | 'mimeType'>): ArtifactFamily {
  if (item.kind === 'screenshot' || item.mimeType?.startsWith('image/')) return 'image'
  if (item.kind === 'video' || item.mimeType?.startsWith('video/')) return 'video'
  return 'other'
}

/**
 * Something that still names an artifact by id (owner request 2026-09-16:
 * cleaning the Files page must not silently break the work that uses them).
 *
 * `blocking` is the whole policy in one bit, spelled on the wire so a plugin
 * or a screen never has to re-derive it:
 * - `true` — work that is happening NOW: a queued or running job, or a batch
 *   that may still start members. Deleting the file fails that work within
 *   seconds, so no delete ever removes it, `force` or not.
 * - `false` — a record that will use the file LATER, or may: a plugin's stored
 *   data (a Social Media Manager post row, for one), an enabled schedule, a
 *   saved workflow or parameter preset. The core cannot tell whether that
 *   record is still going to be acted on, so a bulk delete skips it by default
 *   and deletes it only when the operator explicitly passes `force`.
 */
export const ArtifactReferenceSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('job'),
    blocking: z.literal(true),
    jobId: z.string(),
    /** The job's own name (script or workflow), for a readable hint. */
    name: z.string().nullable(),
    status: z.enum(['queued', 'running']),
  }),
  z.object({
    kind: z.literal('batch'),
    blocking: z.literal(true),
    batchId: z.string(),
    status: z.string(),
  }),
  z.object({
    kind: z.literal('schedule'),
    blocking: z.literal(false),
    scheduleId: z.string(),
    name: z.string(),
  }),
  z.object({
    kind: z.literal('workflow'),
    blocking: z.literal(false),
    workflowId: z.string(),
    name: z.string(),
  }),
  z.object({
    kind: z.literal('preset'),
    blocking: z.literal(false),
    presetId: z.string(),
    /** The script or workflow the preset belongs to. */
    ownerName: z.string(),
    name: z.string(),
  }),
  z.object({
    kind: z.literal('plugin-data'),
    blocking: z.literal(false),
    /** The KV namespace — a plugin id, or a standalone script's own name. */
    namespace: z.string(),
    key: z.string(),
    scope: z.enum(['global', 'device']),
  }),
])
export type ArtifactReference = z.infer<typeof ArtifactReferenceSchema>

/**
 * `GET /api/artifacts/references` — every UPLOAD that something still names,
 * keyed by artifact id. An id absent from the map has no reference the core
 * can see. What it cannot see is stated once, on {@link ArtifactBulkDeleteResponseSchema}.
 */
export const ArtifactReferencesResponseSchema = z.object({
  references: z.record(z.string(), z.array(ArtifactReferenceSchema)),
})

/**
 * `POST /api/artifacts/delete` — bulk removal of UPLOADS (owner request
 * 2026-09-16). Exactly one selection mode:
 *
 * - `ids` — the files the operator ticked.
 * - `filter` — every upload matching it, resolved on the server at request
 *   time: `family` (the Files screen's tabs), `olderThanSec` (created at least
 *   that many seconds ago), `query` (the same case-insensitive name substring
 *   the search box applies). An empty filter means every upload.
 *
 * `preview: true` deletes nothing and answers with exactly what the same body
 * would do without it — the confirmation dialog's count and size come from
 * here, so the numbers the operator confirms are the server's, not a guess.
 *
 * `force: true` also deletes files held only by NON-blocking references
 * (plugin data, schedules, saved workflows and presets). It never overrides a
 * blocking reference, a pin, or the uploads-only rule.
 */
export const ArtifactBulkDeleteInputSchema = z
  .object({
    ids: z.array(z.string().min(1)).min(1).max(5000).optional(),
    filter: z
      .object({
        family: ArtifactFamilySchema.optional(),
        olderThanSec: z.number().int().nonnegative().optional(),
        query: z.string().max(200).optional(),
      })
      .strict()
      .optional(),
    preview: z.boolean().default(false),
    force: z.boolean().default(false),
  })
  .strict()
  .refine((b) => (b.ids !== undefined ? 1 : 0) + (b.filter !== undefined ? 1 : 0) === 1, 'exactly one of ids or filter is required')
export type ArtifactBulkDeleteInput = z.input<typeof ArtifactBulkDeleteInputSchema>

/**
 * One file's outcome. `deleted` in a real run, `would-delete` in a preview.
 * `skipped` names why in `reason`; `failed` means the delete was attempted and
 * the bytes could not be removed — the row is KEPT in that case, so the file
 * stays visible and can be retried instead of leaking disk with no row.
 */
export const ArtifactBulkDeleteItemSchema = z.object({
  id: z.string(),
  label: z.string().nullable(),
  sizeBytes: z.number().nullable(),
  outcome: z.enum(['deleted', 'would-delete', 'skipped', 'failed']),
  reason: z.enum(['pinned', 'in-use', 'referenced', 'not-upload', 'not-found', 'file-error']).nullable(),
  message: z.string().nullable(),
  references: z.array(ArtifactReferenceSchema),
})
export type ArtifactBulkDeleteItem = z.infer<typeof ArtifactBulkDeleteItemSchema>

/**
 * The summary plus every file's own row.
 *
 * **What the reference check cannot see**, said here so no reader assumes
 * otherwise: a plugin that keeps an artifact id anywhere but the farm's KV
 * store (its own files, memory, an external service); a SECRET KV value, which
 * is encrypted at rest and cannot be searched; and an id kept in a transformed
 * form. A preview and its confirm are two requests, so the confirm re-checks
 * everything rather than trusting the preview's answer.
 */
export const ArtifactBulkDeleteResponseSchema = z.object({
  preview: z.boolean(),
  /** Files the selection matched, whatever their outcome. */
  matched: z.number().int().nonnegative(),
  /** `deleted` in a real run, `would-delete` in a preview. */
  deleted: z.number().int().nonnegative(),
  bytesFreed: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  items: z.array(ArtifactBulkDeleteItemSchema),
})
export type ArtifactBulkDeleteResponse = z.infer<typeof ArtifactBulkDeleteResponseSchema>

/**
 * `artifact.get` — the farm capability a plugin (or an agent, or a script)
 * uses to ask whether a stored artifact still exists before it dispatches
 * work that pushes it. A missing artifact is an ANSWER (`exists: false`), not
 * an error, so a service can check a list of posts without a try/catch per id.
 */
export const ArtifactGetInputSchema = z.object({ artifactId: z.string().min(1) })
export const ArtifactGetOutputSchema = z.object({
  exists: z.boolean(),
  artifact: ArtifactInfoSchema.nullable(),
})
export type ArtifactGetOutput = z.infer<typeof ArtifactGetOutputSchema>
