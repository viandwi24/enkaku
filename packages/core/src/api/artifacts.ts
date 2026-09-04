import { mkdirSync } from 'node:fs'
import { join, normalize } from 'node:path'
import { Hono } from 'hono'
import { and, asc, eq, isNull, type SQL } from 'drizzle-orm'
import { ArtifactsPageResponseSchema, type ArtifactInfo, type ShellMode } from '@enkaku/protocol'
import type { AuthEnv } from '../auth/middleware'
import { canUseFiles } from '../auth/acl'
import type { AuditLogger } from '../auth/audit'
import type { Db } from '../db'
import { artifacts, type ArtifactRow } from '../db/schema'
import { EnkakuError } from '../util/errors'
import { decodeCursor, encodeCursor, keysetWhere, parsePageQuery } from './pagination'
import { typedJson } from './typed-json'

const CONTENT_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  json: 'application/json',
  log: 'text/plain; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  mp4: 'video/mp4',
  apk: 'application/vnd.android.package-archive',
}

/**
 * A hard ceiling on the upload itself (plan 39 §3.5, §4.4 — "a multipart
 * upload, subject to the same auth"), independent of `transfer.maxPushBytes`:
 * that farm setting caps what may later be PUSHED or INSTALLED from an
 * artifact already in the store; this is a blunt safety net against an
 * oversized request body regardless of what the upload is destined for.
 */
export const MAX_UPLOAD_BYTES = 1024 * 1024 * 1024

/**
 * The ceiling `Bun.serve` itself is given (`daemon.ts`), and the reason this
 * constant exists at all.
 *
 * Bun's own default `maxRequestBodySize` is **128 MB**, and it is enforced in
 * the transport, before `fetch` runs — so Hono never sees the request, the
 * route above never evaluates, and the client gets a **413 with an empty
 * body**. The cap declared one line up was therefore dead for anything over
 * 128 MB: it read as a 1 GB limit and behaved as a 128 MB one.
 *
 * Found on the owner's farm, 2026-08-26: installing a ~210 MB APK
 * (`com.google.android.googlequicksearchbox`, arm64-v8a) failed with a bare
 * red row in DevTools — "No data found for resource with given identifier",
 * because there was no response body to find. The status was read as 403 and
 * cost a debugging session; it was 413 all along, from a limit nothing in this
 * repo had chosen.
 *
 * Set deliberately ABOVE {@link MAX_UPLOAD_BYTES} rather than equal to it: the
 * transport cap is a blunt backstop, and the route's own check is the one that
 * produces a message an operator can read. Whenever both could fire, the
 * legible one must win.
 */
export const MAX_REQUEST_BODY_BYTES = MAX_UPLOAD_BYTES + 16 * 1024 * 1024

const slug = (label: string): string =>
  label
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80) || 'upload'

/** Per-job artifacts: list, download, and (plan 39 §4.4) upload. */
export function createArtifactRoutes(deps: {
  db: Db
  dataDir: string
  /** Upload is gated by `device.files` (widened by `shell.mode`, same switch install/push/pull use) plus an audit record — undefined disables the route (mirrors `adbEndpoint`/`transfer` optionality elsewhere). */
  upload?: {
    audit: AuditLogger
    shellSettings: () => { mode: ShellMode }
  }
}): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>()

  const rowToItem = (r: ArtifactRow): ArtifactInfo => ({
    id: r.id,
    runId: r.runId,
    deviceId: r.deviceId,
    kind: r.kind as ArtifactInfo['kind'],
    label: r.label,
    path: r.path,
    sizeBytes: r.sizeBytes,
    createdAt: r.createdAt ? Math.floor(r.createdAt.getTime() / 1000) : 0,
  })

  app.get('/', (c) => {
    const runId = c.req.query('runId')
    const deviceId = c.req.query('deviceId')
    const kind = c.req.query('kind')
    // Plan 93 §3.13, §4.4, §4.7, step 93.10, closing F14 — an UPLOADED
    // artifact has runId AND deviceId both null (the "exactly one of" rule
    // just above is for a RUN or DEVICE artifact; an upload is neither), so
    // it can never be reached by `?runId=`/`?deviceId=` and needed its own
    // query mode: `?kind=upload` lists exactly the ownerless rows, the
    // prerequisite for an artifact picker to ever browse a previously
    // uploaded file again.
    const where: SQL | undefined =
      kind === 'upload' ? and(isNull(artifacts.runId), isNull(artifacts.deviceId)) : undefined
    if (!where && !runId && !deviceId) {
      throw new EnkakuError('E_BAD_REQUEST', 'either ?runId=, ?deviceId=, or ?kind=upload is required')
    }
    // The owner column (plan 24 §4.6 — exactly one of runId/deviceId is set
    // on any row, so this is never ambiguous) — only reached when `where`
    // above was not already built from `?kind=upload`.
    const ownerColumn = runId ? artifacts.runId : artifacts.deviceId
    const ownerValue = runId ?? deviceId
    if (!where && !ownerValue) throw new EnkakuError('E_BAD_REQUEST', 'either ?runId= or ?deviceId= is required')
    const baseWhere = where ?? eq(ownerColumn, ownerValue as string)
    const { cursor: cursorParam, limit } = parsePageQuery(c)
    const cursor = decodeCursor(cursorParam)
    // Kept ascending (oldest first) — an artifact list reads as a timeline,
    // and pagination changes only how a list is windowed, not its existing
    // sort direction (plan 30 §2 non-goals).
    const keyset = keysetWhere(
      cursor ? { value: new Date(cursor.sortValue * 1000), id: cursor.id } : null,
      artifacts.createdAt,
      artifacts.id,
      'asc',
    )
    const pageWhere = keyset ? and(baseWhere, keyset) : baseWhere
    const page = deps.db
      .select()
      .from(artifacts)
      .where(pageWhere)
      .orderBy(asc(artifacts.createdAt), asc(artifacts.id))
      .limit(limit + 1)
      .all()
    const hasMore = page.length > limit
    const rows = hasMore ? page.slice(0, limit) : page
    const last = rows[rows.length - 1]
    const nextCursor =
      hasMore && last ? encodeCursor(Math.floor((last.createdAt ?? new Date(0)).getTime() / 1000), last.id) : null
    const total = deps.db.select().from(artifacts).where(baseWhere).all().length

    const items = rows.map(rowToItem)
    return typedJson(c, ArtifactsPageResponseSchema, { items, nextCursor, total, artifacts: items })
  })

  /**
   * `POST /api/artifacts` — a multipart upload, the ONLY way a file enters
   * the artifact store from outside a job (plan 39 §3.5, §4.4). This is
   * deliberately separate from install/push/pull: those three accept an
   * artifact id ONLY, never a URL or path (§3.5's SSRF-shaped hole); getting
   * a file INTO the store in the first place is this one auditable step,
   * gated the same way (`device.files`, widened by `shell.mode`) and
   * size-capped independent of any single device's `transfer.maxPushBytes`.
   */
  app.post('/', async (c) => {
    if (!deps.upload) throw new EnkakuError('E_BAD_REQUEST', 'artifact upload is not enabled')
    const user = c.get('user')
    if (!user || !canUseFiles(user.role, deps.upload.shellSettings().mode)) {
      throw new EnkakuError('auth.forbidden', 'you do not have permission to upload artifacts')
    }
    const declaredLength = Number(c.req.header('content-length') ?? '0')
    if (Number.isFinite(declaredLength) && declaredLength > MAX_UPLOAD_BYTES) {
      throw new EnkakuError('E_TRANSFER_TOO_LARGE', `the upload exceeds the ${MAX_UPLOAD_BYTES}-byte limit`)
    }
    const body = await c.req.parseBody().catch(() => null)
    const file = body?.file
    if (!file || !(file instanceof File)) {
      throw new EnkakuError('E_BAD_REQUEST', 'a multipart "file" field is required')
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      throw new EnkakuError('E_TRANSFER_TOO_LARGE', `the upload exceeds the ${MAX_UPLOAD_BYTES}-byte limit`)
    }
    const labelField = body?.label
    const label = typeof labelField === 'string' && labelField.trim().length > 0 ? labelField.trim() : file.name || 'upload'
    const ext = file.name.includes('.') ? (file.name.split('.').pop() as string) : 'bin'

    const relDir = join('artifacts', 'uploads')
    const dir = join(deps.dataDir, relDir)
    mkdirSync(dir, { recursive: true })
    const filename = `${Date.now()}-${slug(label)}.${ext}`
    const relPath = join(relDir, filename)
    const bytes = new Uint8Array(await file.arrayBuffer())
    await Bun.write(join(dir, filename), bytes)

    const info: ArtifactInfo = {
      id: crypto.randomUUID(),
      runId: null,
      deviceId: null,
      kind: 'file',
      label,
      path: relPath,
      sizeBytes: bytes.length,
      createdAt: Math.floor(Date.now() / 1000),
    }
    deps.db
      .insert(artifacts)
      .values({
        id: info.id,
        runId: null,
        deviceId: null,
        kind: info.kind,
        label: info.label,
        path: info.path,
        sizeBytes: info.sizeBytes,
        createdAt: new Date(),
      })
      .run()

    deps.upload.audit.record({ userId: user.id, action: 'artifact.upload', target: info.id, meta: { label, sizeBytes: bytes.length, ext } })

    return c.json({ artifact: info }, 201)
  })

  app.get('/:id/content', async (c) => {
    const row = deps.db.select().from(artifacts).where(eq(artifacts.id, c.req.param('id'))).get()
    if (!row) throw new EnkakuError('artifact_not_found', 'no such artifact')
    // The DB path is relative to app-data; reject traversal.
    const rel = normalize(row.path)
    if (rel.startsWith('..')) throw new EnkakuError('E_BAD_REQUEST', 'invalid artifact path')
    const abs = join(deps.dataDir, rel)
    const file = Bun.file(abs)
    if (!(await file.exists())) throw new EnkakuError('artifact_not_found', 'the artifact file is no longer on disk')
    const ext = rel.split('.').pop() ?? ''
    return new Response(file, {
      headers: { 'content-type': CONTENT_TYPES[ext] ?? 'application/octet-stream' },
    })
  })

  const ERROR_STATUS: Record<string, number> = {
    artifact_not_found: 404,
    'auth.forbidden': 403,
    E_TRANSFER_TOO_LARGE: 413,
  }

  app.onError((err, c) => {
    if (err instanceof EnkakuError) {
      return c.json(err.toJSON(), (ERROR_STATUS[err.code] ?? 400) as 400)
    }
    throw err
  })

  return app
}
