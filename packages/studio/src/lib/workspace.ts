import { z } from 'zod'
import {
  PluginStatusSchema,
  VerifyReportSchema,
  WorkspaceFileContentSchema,
  WorkspaceFileMetaSchema,
  WorkspaceListOutputSchema,
  type WorkspaceFileContent,
  type WorkspaceFileMeta,
  type WorkspaceListEntry,
} from '@enkaku/protocol'
import { api, coreBase, BadResponseError } from '@enkaku/ui'

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

/** `GET /api/workspace/file?path=…` (plan 116 §4.2) — the byte source every presenter's `src`
 * points at, and the URL `headWorkspaceFile` below issues its `HEAD` against. */
export function workspaceFileUrl(path: string): string {
  return `${coreBase()}/api/workspace/file?path=${encodeURIComponent(path)}`
}

/** Strips the RFC 7232 quoting (and a possible weak-validator `W/` prefix) an `ETag` carries,
 * back to the bare hex hash `fs.write`'s `ifMatch` expects. */
function unquoteETag(etag: string | null): string | null {
  if (!etag) return null
  return etag.replace(/^W\//, '').replace(/^"|"$/g, '')
}

/**
 * `HEAD /api/workspace/file?path=…` (plan 116 §4.2, step 116.6, finding P7) —
 * learns a file's `WorkspaceFileMeta` from RESPONSE HEADERS alone, never its
 * bytes. This is what lets the workspace page's `loadFile` resolve a
 * presenter (and check `maxBytes`) BEFORE deciding whether to fetch content
 * at all: opening a 200 MB video used to call `readWorkspaceFile` (`fs.read`)
 * unconditionally, which base64-encodes the WHOLE file through the
 * capability API purely to learn its `contentType` and size (P7).
 *
 * `hash` rides as `ETag` — the idiomatic HTTP carrier (plan 116's own
 * reasoning on this) — because it is the CAS token a later save or delete
 * sends back as `ifMatch` (§3.7); losing it here would turn opening a file
 * into a save that fails with a stale-token error the operator cannot
 * explain. The remaining `WorkspaceFileMeta` fields have no standard-header
 * equivalent and ride as `X-Enkaku-*`, mirroring exactly what
 * `packages/core/src/api/workspace.ts`'s `GET /file` HEAD branch sets — a
 * mismatch between the two would silently reconstruct a wrong `meta`, so
 * this function and that branch must be read together when either changes.
 */
export async function headWorkspaceFile(path: string): Promise<WorkspaceFileMeta> {
  const res = await fetch(workspaceFileUrl(path), { method: 'HEAD', credentials: 'include' })
  if (!res.ok) {
    throw Object.assign(new Error(`Could not read "${path}" (HTTP ${res.status})`), {
      code: res.status === 404 ? 'E_NOT_FOUND' : 'unknown',
    })
  }
  const candidate = {
    path,
    contentType: res.headers.get('content-type') ?? 'application/octet-stream',
    size: Number(res.headers.get('content-length') ?? '0'),
    hash: unquoteETag(res.headers.get('etag')) ?? '',
    createdBy: res.headers.get('x-enkaku-created-by'),
    updatedBy: res.headers.get('x-enkaku-updated-by'),
    createdAt: Number(res.headers.get('x-enkaku-created-at') ?? '0'),
    updatedAt: Number(res.headers.get('x-enkaku-updated-at') ?? '0'),
  }
  const parsed = WorkspaceFileMetaSchema.safeParse(candidate)
  if (!parsed.success) {
    throw new BadResponseError(`/api/workspace/file?path=${encodeURIComponent(path)}`, z.prettifyError(parsed.error))
  }
  return parsed.data
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

const WorkspaceUploadResponseSchema = z.object({ file: WorkspaceFileMetaSchema })
const ErrorEnvelopeSchema = z.object({ error: z.object({ message: z.string() }) })

/**
 * A raw multipart upload (plan 115 §4.3) — the same reason `api()` is
 * JSON-only that `FilesPanel.tsx`'s own `uploadArtifact` documents: a
 * browser sets its own multipart boundary, never a fixed content-type, so
 * this cannot go through `invokeCap` above. Posts to `POST
 * /api/workspace/file`, which writes through the SAME `WorkspaceStore` `fs.write`
 * uses, so quotas/CAS/the driver a write lands on all apply exactly as they
 * would for a script (plan 115 §3.4). A refusal's message is surfaced
 * verbatim — a quota refusal names the setting to raise (§3.5), and that
 * detail is the whole point of not collapsing it into a generic string.
 */
export async function uploadWorkspaceFile(path: string, file: File): Promise<WorkspaceFileMeta> {
  const form = new FormData()
  form.set('path', path)
  form.set('file', file)
  const res = await fetch(`${coreBase()}/api/workspace/file`, { method: 'POST', body: form })
  const raw: unknown = await res.json().catch(() => null)
  if (!res.ok) {
    const parsedError = ErrorEnvelopeSchema.safeParse(raw)
    throw new Error(parsedError.success ? parsedError.data.error.message : `Upload failed (HTTP ${res.status})`)
  }
  const parsed = WorkspaceUploadResponseSchema.safeParse(raw)
  if (!parsed.success) throw new BadResponseError('/api/workspace/file', z.prettifyError(parsed.error))
  return parsed.data.file
}

/** `plugin.stage`'s own name/version shapes (plan 210 §4.8), copied here for the same reason a form field hint always has: naming which half is wrong before a round trip to the server does. */
export const PLUGIN_NAME_SHAPE = /^[a-z0-9][a-z0-9-]*$/
export const SCRIPT_VERSION_SHAPE = /^\d+\.\d+\.\d+(?:[-+].+)?$/

export interface PublishName {
  plugin: string
}

/** Anything a file name can hold, reduced to the characters a plugin id allows. */
function slug(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/**
 * The plugin id to offer for a workspace file, so the common case is one
 * click (plan 210 §4.9): a script exists only as a member of a plugin now, so
 * there is no second (member) half to suggest — just the plugin the file's
 * own name or folder implies. Always a suggestion: the operator can
 * overwrite it.
 */
export function defaultPublishName(path: string): PublishName {
  const segments = path.split('/').filter(Boolean)
  const file = segments.pop() ?? ''
  const stem = slug(file.replace(/\.[^.]+$/, ''))
  const dir = segments[segments.length - 1]
  const plugin = dir && dir !== 'scripts' ? slug(dir) : stem
  return { plugin }
}

const StageFromPathResultSchema = z.object({
  id: z.string(),
  name: z.string(),
  version: z.string(),
  status: PluginStatusSchema,
  verify: VerifyReportSchema.optional(),
})
export type StageFromPathResult = z.infer<typeof StageFromPathResultSchema>

/**
 * `plugin.stage`'s `{ path }` input form (plan 210 §4.8) — the core bundles
 * the workspace source itself and stages (then verifies, unless asked not
 * to) the resulting plugin package. Activation is a separate, deliberate
 * step (the Plugins page).
 */
export function stagePluginFromWorkspace(path: string, name: string, version: string): Promise<StageFromPathResult> {
  return invokeCap('plugin.stage', { path, name, version }, StageFromPathResultSchema)
}
