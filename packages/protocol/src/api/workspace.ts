import { z } from 'zod'

/**
 * The `fs.*` capability outputs (plan 64 §4.2, §4.5), reached through the
 * one capability door (`POST /api/v1/cap/:id`) rather than a bespoke
 * workspace API — `packages/studio/src/lib/workspace.ts` is the only
 * consumer today.
 */
export const WorkspaceListEntrySchema = z.object({
  path: z.string(),
  kind: z.enum(['file', 'dir']),
  size: z.number().nullable(),
  hash: z.string().nullable(),
  updatedAt: z.number().nullable(),
})
export type WorkspaceListEntry = z.infer<typeof WorkspaceListEntrySchema>
export const WorkspaceListOutputSchema = z.object({ entries: z.array(WorkspaceListEntrySchema) })

export const WorkspaceFileMetaSchema = z.object({
  path: z.string(),
  contentType: z.string(),
  size: z.number(),
  hash: z.string(),
  createdBy: z.string().nullable(),
  updatedBy: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
})
export type WorkspaceFileMeta = z.infer<typeof WorkspaceFileMetaSchema>

export const WorkspaceFileContentSchema = WorkspaceFileMetaSchema.extend({ content: z.string() })
export type WorkspaceFileContent = z.infer<typeof WorkspaceFileContentSchema>

export const PublishFromPathResultSchema = z.object({
  id: z.string(),
  name: z.string(),
  version: z.string(),
})
export type PublishFromPathResult = z.infer<typeof PublishFromPathResultSchema>
