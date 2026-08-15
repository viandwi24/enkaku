import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { compareSemver, RecordingDocSchema, RecordingStepSchema, type RecordingDoc } from '@enkaku/protocol'
import type { AuditLogger } from '../auth/audit'
import type { AuthEnv } from '../auth/middleware'
import { requirePermission } from '../auth/middleware'
import type { Db } from '../db'
import { scripts } from '../db/schema'
import { buildScriptFromWorkspace } from '../scripts/build'
import { publishScript } from '../scripts/service'
import { EnkakuError } from '../util/errors'
import type { WorkspaceStore } from '../workspace/store'
import { emitDetachedScript, emitRecordingEntry, paramsJsonSchemaFor } from '../recording/compile'
import type { RecordingService } from '../recording/service'

/**
 * `GET /`, `GET /:slug`, `POST /` (an addition beyond §4.9's own six-route
 * table — flagged below), `PATCH /:slug`, `DELETE /:slug`, `POST
 * /:slug/publish`, `POST /:slug/detach` (plan 94 §4.9, §5 step 94.5) —
 * mounted at `/api/recordings` in `server/http.ts`.
 *
 * A recording's identity IS its workspace path (§3.1): every route here is a
 * plain read/write/delete against `/recordings/<slug>.recording.json`, never
 * a second table. Publishing goes through the SAME `buildScriptFromWorkspace`
 * + `publishScript` pair `script.publish`'s `{ path }` input form already
 * uses (`capability/script.ts`) — this file constructs the compiled entry
 * (`emitRecordingEntry`) and hands its PATH to that exact function, never a
 * bundle assembled by hand, so F11's "no new bundling" holds literally.
 * `publishScript`'s `kind` is left at its default (`'script'`) — a recording
 * publishes as an ORDINARY script row, indistinguishable from a hand-written
 * one (acceptance criterion 2): nothing here ever writes `kind: 'recording'`,
 * because no such kind exists, deliberately.
 *
 * **One addition beyond §4.9's own six-row table, flagged here and in this
 * step's report rather than silently added: `POST /` (create).** The table
 * lists GET (list), GET (one), PATCH, DELETE, POST publish, POST detach —
 * six routes — but has no route that turns a just-finished, in-memory
 * `RecordingDoc` (`RecordingService.lastFinished(deviceId)`, step 94.3's own
 * addition beyond ITS interface sketch) into the first
 * `/recordings/<slug>.recording.json` file on disk. Without one, an operator
 * can review nothing: `GET`/`PATCH`/`DELETE`/publish/detach all operate on a
 * file that has to already exist. `POST /` pulls the finished document for a
 * device, applies the operator's chosen name/version (validated through the
 * SAME `RecordingDocSchema` regex every other name in this document already
 * is), and writes it — nothing else in this file, or in `useRecording`'s own
 * client state, has the missing piece any other way.
 */

const RECORDING_PREFIX = '/recordings/'
const RECORDING_SUFFIX = '.recording.json'
const DETACHED_SUFFIX = '.detached'

function docPath(slug: string): string {
  return `${RECORDING_PREFIX}${slug}${RECORDING_SUFFIX}`
}
function compiledPath(slug: string): string {
  return `${RECORDING_PREFIX}${slug}.ts`
}
function detachedMarkerPath(slug: string): string {
  return `${RECORDING_PREFIX}${slug}${DETACHED_SUFFIX}`
}
function detachedScriptPath(slug: string): string {
  return `/scripts/${slug}.ts`
}

function actorId(c: { get(k: 'user'): { id: string } | undefined }): string | null {
  return c.get('user')?.id ?? null
}

/** Create-or-overwrite with the CAS discipline `WorkspaceStore.write` requires — reads the current hash first (when the file exists) so every save here is a plain upsert from the route's own point of view. */
function upsertFile(workspace: WorkspaceStore, path: string, content: Uint8Array, contentType: string, actor: string | null): void {
  let ifMatch: string | undefined
  try {
    ifMatch = workspace.read(path).hash
  } catch {
    ifMatch = undefined
  }
  workspace.write(path, { content, contentType, actor, ...(ifMatch !== undefined ? { ifMatch } : {}) })
}

function readDocWithHash(workspace: WorkspaceStore, slug: string): { doc: RecordingDoc; hash: string } {
  let file: ReturnType<WorkspaceStore['read']>
  try {
    file = workspace.read(docPath(slug))
  } catch {
    throw new EnkakuError('E_RECORDING_NOT_FOUND', `no such recording: ${slug}`)
  }
  const parsed = RecordingDocSchema.safeParse(JSON.parse(new TextDecoder().decode(file.content)))
  if (!parsed.success) {
    throw new EnkakuError('E_RECORDING_INVALID', `"${slug}" on disk does not parse as a recording: ${z.prettifyError(parsed.error)}`)
  }
  return { doc: parsed.data, hash: file.hash }
}

function readDoc(workspace: WorkspaceStore, slug: string): RecordingDoc {
  return readDocWithHash(workspace, slug).doc
}

function writeDoc(workspace: WorkspaceStore, slug: string, doc: RecordingDoc, actor: string | null): string {
  let ifMatch: string | undefined
  try {
    ifMatch = workspace.read(docPath(slug)).hash
  } catch {
    ifMatch = undefined
  }
  const meta = workspace.write(docPath(slug), {
    content: new TextEncoder().encode(JSON.stringify(doc, null, 2)),
    contentType: 'application/json',
    actor,
    ...(ifMatch !== undefined ? { ifMatch } : {}),
  })
  return meta.hash
}

function isDetached(workspace: WorkspaceStore, slug: string): boolean {
  try {
    workspace.read(detachedMarkerPath(slug))
    return true
  } catch {
    return false
  }
}

/** The latest version this recording's NAME has ever published as, or `null` — read straight off `scripts`, never a second source of truth. */
function latestPublishedVersion(db: Db, name: string): string | null {
  const rows = db.select({ version: scripts.version }).from(scripts).where(eq(scripts.name, name)).all()
  if (rows.length === 0) return null
  return [...rows].sort((a, b) => compareSemver(b.version, a.version))[0]?.version ?? null
}

const RecordingListItemSchema = z.object({
  slug: z.string(),
  name: z.string(),
  description: z.string(),
  stepCount: z.number().int().nonnegative(),
  recordedAt: z.number().int(),
  detached: z.boolean(),
  publishedVersion: z.string().nullable(),
  corrupt: z.boolean(),
})
export const RecordingListResponseSchema = z.object({ items: z.array(RecordingListItemSchema) })

const RecordingDetailResponseSchema = z.object({
  slug: z.string(),
  doc: RecordingDocSchema,
  /** The document file's current content hash — pass back as `PATCH`'s `ifMatch` (the same CAS discipline `fs.write` already uses). */
  hash: z.string(),
  detached: z.boolean(),
  publishedVersion: z.string().nullable(),
  /** Preview of what publishing right now would write — computed on the fly, never persisted by GET (plan 94 §4.7: compile is a PUBLISH-time write, so a review-only GET never touches the workspace). Empty when the recording is already detached — nothing here will ever compile again. */
  generatedSource: z.string().nullable(),
})

export const RecordingCreateResponseSchema = z.object({ slug: z.string(), doc: RecordingDocSchema, hash: z.string() })
export const RecordingPatchResponseSchema = z.object({ slug: z.string(), doc: RecordingDocSchema, hash: z.string() })

const CreateBody = z.object({
  deviceId: z.string().min(1),
  name: z.string().min(1).max(200),
  version: z.string().regex(/^\d+\.\d+\.\d+(?:[-+].+)?$/),
  description: z.string().optional(),
})

const PatchBody = z.object({
  ifMatch: z.string(),
  doc: z
    .object({
      version: z.string().regex(/^\d+\.\d+\.\d+(?:[-+].+)?$/).optional(),
      description: z.string().optional(),
      speed: z.number().min(0.1).max(10).optional(),
      maxGapMs: z.number().int().min(0).optional(),
      cleanup: z.enum(['force-stop', 'none']).optional(),
      packages: z.array(z.string()).optional(),
      steps: z.array(RecordingStepSchema).max(2_000).optional(),
    })
    .strict(),
})

const PublishBody = z.object({ version: z.string().regex(/^\d+\.\d+\.\d+(?:[-+].+)?$/).optional() })

const ERROR_STATUS: Record<string, number> = {
  E_RECORDING_NOT_FOUND: 404,
  E_RECORDING_INVALID: 400,
  E_RECORDING_DETACHED: 409,
  E_NO_RECORDING_DOCUMENT: 404,
  E_BAD_REQUEST: 400,
  E_NOT_SUPPORTED: 501,
  E_NOT_FOUND: 404,
  E_BAD_PATH: 400,
  E_EXISTS: 409,
  E_STALE: 409,
  E_QUOTA: 413,
  script_version_exists: 409,
}

export function createRecordingRoutes(deps: { db: Db; workspace: WorkspaceStore; recording?: RecordingService; audit?: AuditLogger }): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>()
  const { db, workspace } = deps

  app.get('/', requirePermission('script.view'), (c) => {
    const entries = workspace.list(RECORDING_PREFIX)
    const items: z.infer<typeof RecordingListItemSchema>[] = []
    for (const entry of entries) {
      if (entry.kind !== 'file' || !entry.path.endsWith(RECORDING_SUFFIX)) continue
      const slug = entry.path.slice(RECORDING_PREFIX.length, -RECORDING_SUFFIX.length)
      try {
        const doc = readDoc(workspace, slug)
        items.push({
          slug,
          name: doc.name,
          description: doc.description,
          stepCount: doc.steps.length,
          recordedAt: doc.recordedAt,
          detached: isDetached(workspace, slug),
          publishedVersion: latestPublishedVersion(db, doc.name),
          corrupt: false,
        })
      } catch {
        items.push({ slug, name: slug, description: '', stepCount: 0, recordedAt: 0, detached: false, publishedVersion: null, corrupt: true })
      }
    }
    items.sort((a, b) => b.recordedAt - a.recordedAt)
    return c.json({ items } satisfies z.infer<typeof RecordingListResponseSchema>)
  })

  app.get('/:slug', requirePermission('script.view'), (c) => {
    const slug = c.req.param('slug')
    const { doc, hash } = readDocWithHash(workspace, slug)
    const detached = isDetached(workspace, slug)
    return c.json({
      slug,
      doc,
      hash,
      detached,
      publishedVersion: latestPublishedVersion(db, doc.name),
      generatedSource: detached ? null : emitRecordingEntry(doc),
    } satisfies z.infer<typeof RecordingDetailResponseSchema>)
  })

  // Addition beyond §4.9's six-row table — see this file's own header comment.
  app.post('/', requirePermission('script.publish'), async (c) => {
    if (!deps.recording) throw new EnkakuError('E_NOT_SUPPORTED', 'recording is not available on this host')
    const body = CreateBody.safeParse(await c.req.json().catch(() => null))
    if (!body.success) throw new EnkakuError('E_BAD_REQUEST', body.error.issues.map((i) => i.message).join('; '))
    const built = deps.recording.lastFinished(body.data.deviceId)
    if (!built) throw new EnkakuError('E_NO_RECORDING_DOCUMENT', `no finished recording is waiting to be saved for device ${body.data.deviceId}`)
    const candidate = { ...built, name: body.data.name, version: body.data.version, description: body.data.description ?? built.description }
    const parsed = RecordingDocSchema.safeParse(candidate)
    if (!parsed.success) throw new EnkakuError('E_RECORDING_INVALID', z.prettifyError(parsed.error))
    const slug = parsed.data.name
    const hash = writeDoc(workspace, slug, parsed.data, actorId(c))
    return c.json({ slug, doc: parsed.data, hash }, 201)
  })

  app.patch('/:slug', requirePermission('script.publish'), async (c) => {
    const slug = c.req.param('slug')
    if (isDetached(workspace, slug)) throw new EnkakuError('E_RECORDING_DETACHED', `"${slug}" was detached — edit /scripts/${slug}.ts directly`)
    const body = PatchBody.safeParse(await c.req.json().catch(() => null))
    if (!body.success) throw new EnkakuError('E_BAD_REQUEST', body.error.issues.map((i) => i.message).join('; '))
    let current: ReturnType<WorkspaceStore['read']>
    try {
      current = workspace.read(docPath(slug))
    } catch {
      throw new EnkakuError('E_RECORDING_NOT_FOUND', `no such recording: ${slug}`)
    }
    if (body.data.ifMatch !== current.hash) {
      throw new EnkakuError('E_STALE', `"${slug}" changed since you read it (expected hash "${body.data.ifMatch}", current hash "${current.hash}")`)
    }
    const existingParsed = RecordingDocSchema.safeParse(JSON.parse(new TextDecoder().decode(current.content)))
    if (!existingParsed.success) {
      throw new EnkakuError('E_RECORDING_INVALID', `"${slug}" on disk does not parse as a recording: ${z.prettifyError(existingParsed.error)}`)
    }
    const existing = existingParsed.data
    const merged = { ...existing, ...body.data.doc, name: existing.name, schema: existing.schema, recordedAt: existing.recordedAt, recordedOn: existing.recordedOn }
    const parsed = RecordingDocSchema.safeParse(merged)
    if (!parsed.success) throw new EnkakuError('E_RECORDING_INVALID', z.prettifyError(parsed.error))
    const hash = writeDoc(workspace, slug, parsed.data, actorId(c))
    return c.json({ slug, doc: parsed.data, hash })
  })

  app.delete('/:slug', requirePermission('script.publish'), (c) => {
    const slug = c.req.param('slug')
    readDoc(workspace, slug) // 404s honestly before attempting any delete
    workspace.delete(docPath(slug))
    for (const path of [compiledPath(slug), detachedMarkerPath(slug)]) {
      try {
        workspace.delete(path)
      } catch {
        // Absent is fine — the compiled entry / detached marker are both optional.
      }
    }
    deps.audit?.record({ userId: actorId(c), action: 'script.delete', target: slug, meta: { kind: 'recording' } })
    return c.json({ ok: true })
  })

  app.post('/:slug/publish', requirePermission('script.publish'), async (c) => {
    const slug = c.req.param('slug')
    if (isDetached(workspace, slug)) {
      throw new EnkakuError('E_RECORDING_DETACHED', `"${slug}" was detached and no longer compiles — publish /scripts/${slug}.ts as an ordinary script instead`)
    }
    const doc = readDoc(workspace, slug)
    const body = PublishBody.safeParse(await c.req.json().catch(() => ({})))
    if (!body.success) throw new EnkakuError('E_BAD_REQUEST', body.error.issues.map((i) => i.message).join('; '))
    const toPublish = body.data.version ? { ...doc, version: body.data.version } : doc
    const parsed = RecordingDocSchema.safeParse(toPublish)
    if (!parsed.success) throw new EnkakuError('E_RECORDING_INVALID', z.prettifyError(parsed.error))
    // Persist the (possibly bumped) version back onto the stored document —
    // §3.1's diagram: "compile → regenerated every time" — so a follow-up
    // GET reflects exactly what was just published.
    if (parsed.data.version !== doc.version) writeDoc(workspace, slug, parsed.data, actorId(c))

    const entrySource = emitRecordingEntry(parsed.data)
    upsertFile(workspace, compiledPath(slug), new TextEncoder().encode(entrySource), 'text/typescript', actorId(c))

    // F11: the SAME server-side bundler `script.publish`'s `{ path }` form uses — never a bundle assembled by hand.
    const { bundle, source } = await buildScriptFromWorkspace(workspace, compiledPath(slug))
    const script = publishScript(db, {
      name: parsed.data.name,
      version: parsed.data.version,
      bundle,
      source,
      paramsSchema: paramsJsonSchemaFor(parsed.data),
      // `kind` deliberately omitted — defaults to `'script'` (`publishScript`'s own doc comment), the
      // same row shape a hand-written script publishes as (acceptance criterion 2).
    })
    deps.audit?.record({ userId: actorId(c), action: 'script.publish', target: script.id, meta: { name: script.name, version: script.version, source: 'recording', slug } })
    return c.json({ script }, 201)
  })

  app.post('/:slug/detach', requirePermission('script.publish'), (c) => {
    const slug = c.req.param('slug')
    if (isDetached(workspace, slug)) throw new EnkakuError('E_RECORDING_DETACHED', `"${slug}" was already detached`)
    const doc = readDoc(workspace, slug)
    const detachedSource = emitDetachedScript(doc)
    const targetPath = detachedScriptPath(slug)
    // A pre-existing hand-authored file at the SAME path is never silently
    // overwritten — detach only ever creates, never clobbers.
    let targetExists = true
    try {
      workspace.read(targetPath)
    } catch {
      targetExists = false
    }
    if (targetExists) throw new EnkakuError('E_EXISTS', `"${targetPath}" already exists — remove or rename it before detaching "${slug}"`)
    workspace.write(targetPath, { content: new TextEncoder().encode(detachedSource), contentType: 'text/typescript', actor: actorId(c) })
    try {
      workspace.delete(compiledPath(slug))
    } catch {
      // Never compiled yet — nothing to delete.
    }
    upsertFile(
      workspace,
      detachedMarkerPath(slug),
      new TextEncoder().encode(JSON.stringify({ detachedAt: Math.floor(Date.now() / 1000), scriptPath: targetPath }, null, 2)),
      'application/json',
      actorId(c),
    )
    return c.json({ slug, scriptPath: targetPath })
  })

  app.onError((err, c) => {
    if (err instanceof EnkakuError) return c.json(err.toJSON(), (ERROR_STATUS[err.code] ?? 500) as 400)
    throw err
  })

  return app
}
