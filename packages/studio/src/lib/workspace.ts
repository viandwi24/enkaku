import { z } from 'zod'
import {
  PublishFromPathResultSchema,
  WorkspaceFileContentSchema,
  WorkspaceFileMetaSchema,
  WorkspaceListOutputSchema,
  type PublishFromPathResult,
  type WorkspaceFileContent,
  type WorkspaceFileMeta,
  type WorkspaceListEntry,
} from '@enkaku/protocol'
import { api, BadResponseError } from './actions'

/**
 * Thin client for the `fs.*` capabilities (plan 64 §4.2, §4.5) — Studio's
 * `/workspace` page talks to the SAME `POST /api/v1/cap/:id` door every
 * other capability caller (REST, MCP, an agent) goes through. There is no
 * second, Studio-only workspace API.
 *
 * `WorkspaceListEntry`/`WorkspaceFileMeta`/`WorkspaceFileContent` now live in
 * `@enkaku/protocol` (plan 72 §4.1) as the Zod schemas each `invokeCap` call
 * parses against — re-exported here so existing imports of these TYPE names
 * from this module keep working.
 */
export type { WorkspaceFileContent, WorkspaceFileMeta, WorkspaceListEntry } from '@enkaku/protocol'

/**
 * `output`'s shape varies per capability, so the envelope itself is parsed
 * with `output: z.unknown()` and the caller's OWN schema parses that value
 * afterward — Zod 4's object-type mapping does not resolve a generic member
 * type parameter cleanly (`{output: S}` for a generic `S` loses `.output`'s
 * inferred type entirely), so building `z.object({ok, output: outputSchema})`
 * generically and inferring off IT does not typecheck. Splitting the parse
 * in two sidesteps that without weakening validation: both steps still run.
 */
async function invokeCap<S extends z.ZodType>(id: string, input: unknown, outputSchema: S): Promise<z.infer<S>> {
  const path = `/api/v1/cap/${id}`
  const raw = await api(path, z.object({ ok: z.literal(true), output: z.unknown() }), { json: input })
  const parsed = outputSchema.safeParse(raw.output)
  if (!parsed.success) throw new BadResponseError(path, z.prettifyError(parsed.error))
  return parsed.data
}

export function listWorkspace(prefix: string): Promise<WorkspaceListEntry[]> {
  return invokeCap('fs.list', { prefix }, WorkspaceListOutputSchema).then((r) => r.entries)
}

export function readWorkspaceFile(path: string): Promise<WorkspaceFileContent> {
  return invokeCap('fs.read', { path }, WorkspaceFileContentSchema)
}

export function writeWorkspaceFile(
  path: string,
  content: string,
  opts?: { contentType?: string; ifMatch?: string | null },
): Promise<WorkspaceFileMeta> {
  return invokeCap('fs.write', { path, content, ...opts }, WorkspaceFileMetaSchema)
}

export function deleteWorkspaceFile(path: string, ifMatch?: string): Promise<void> {
  return invokeCap('fs.delete', { path, ...(ifMatch ? { ifMatch } : {}) }, z.unknown()).then(() => undefined)
}

export function moveWorkspaceFile(from: string, to: string, ifMatch: string): Promise<WorkspaceFileMeta> {
  return invokeCap('fs.move', { from, to, ifMatch }, WorkspaceFileMetaSchema)
}

/** `script.publish`'s `{ path }` input form (plan 64 §3.5, §4.4, §4.7) — the core bundles the workspace source itself. */
export function publishScriptFromWorkspace(path: string, name: string, version: string): Promise<PublishFromPathResult> {
  return invokeCap('script.publish', { path, name, version }, PublishFromPathResultSchema)
}
