import { z } from 'zod'
import { RecordingDocSchema, RecordingStepSchema, type RecordingDoc, type RecordingStep } from '@enkaku/protocol'
import { api } from '@/lib/actions'

/**
 * The client half of `/api/recordings/*` (plan 94 §4.9, §5 step 94.5). The
 * response shapes here are DUPLICATED from `packages/core/src/api/
 * recordings.ts` rather than shared through `@enkaku/protocol` — that
 * package's `recording.ts`/`api/` directories were outside this step's
 * ownership (this step's brief: "if you need a file outside your list, STOP
 * and report"), and this file's own header comment names it explicitly. The
 * same reasoning `packages/protocol/src/recording.ts` itself gives for its
 * own duplicated `RECORDING_NAME_RE` (rather than importing `script-ref.ts`'s
 * combined grammar): a small, stable shape is cheaper to keep in sync by
 * hand than to reach across an ownership boundary for.
 */

export const RecordingListItemSchema = z.object({
  slug: z.string(),
  name: z.string(),
  description: z.string(),
  stepCount: z.number().int().nonnegative(),
  recordedAt: z.number().int(),
  detached: z.boolean(),
  publishedVersion: z.string().nullable(),
  corrupt: z.boolean(),
})
export type RecordingListItem = z.infer<typeof RecordingListItemSchema>

export const RecordingListResponseSchema = z.object({ items: z.array(RecordingListItemSchema) })

export const RecordingDetailResponseSchema = z.object({
  slug: z.string(),
  doc: RecordingDocSchema,
  hash: z.string(),
  detached: z.boolean(),
  publishedVersion: z.string().nullable(),
  generatedSource: z.string().nullable(),
})
export type RecordingDetail = z.infer<typeof RecordingDetailResponseSchema>

const CreateResponseSchema = z.object({ slug: z.string(), doc: RecordingDocSchema, hash: z.string() })
const PatchResponseSchema = z.object({ slug: z.string(), doc: RecordingDocSchema, hash: z.string() })
const DeleteResponseSchema = z.object({ ok: z.boolean() })
const PublishResponseSchema = z.object({ script: z.object({ id: z.string(), name: z.string(), version: z.string() }) })
const DetachResponseSchema = z.object({ slug: z.string(), scriptPath: z.string() })

/** The fields `PATCH /api/recordings/:slug` accepts — a strict SUBSET of `RecordingDoc` (never `name`/`schema`/`recordedAt`/`recordedOn`, all immutable through this route, `recordings.ts`'s own `PatchBody`). */
export interface RecordingPatchableFields {
  version?: string
  description?: string
  speed?: number
  maxGapMs?: number
  cleanup?: 'force-stop' | 'none'
  packages?: string[]
  steps?: RecordingStep[]
}

export const slugPath = (slug: string): string => `/api/recordings/${encodeURIComponent(slug)}`

export function listRecordings() {
  return api('/api/recordings', RecordingListResponseSchema)
}

export function getRecording(slug: string) {
  return api(slugPath(slug), RecordingDetailResponseSchema)
}

export function createRecording(input: { deviceId: string; name: string; version: string; description?: string }) {
  return api('/api/recordings', CreateResponseSchema, { json: input })
}

export function patchRecording(slug: string, ifMatch: string, doc: RecordingPatchableFields) {
  return api(slugPath(slug), PatchResponseSchema, { method: 'PATCH', json: { ifMatch, doc } })
}

export function deleteRecording(slug: string) {
  return api(slugPath(slug), DeleteResponseSchema, { method: 'DELETE' })
}

export function publishRecording(slug: string, version?: string) {
  return api(`${slugPath(slug)}/publish`, PublishResponseSchema, { json: version ? { version } : {} })
}

export function detachRecording(slug: string) {
  return api(`${slugPath(slug)}/detach`, DetachResponseSchema, { json: {} })
}

/** Re-exported so a caller only ever imports steps/docs through this one module. */
export { RecordingStepSchema, RecordingDocSchema }
export type { RecordingDoc, RecordingStep }
