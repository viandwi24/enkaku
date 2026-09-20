import { mkdirSync, rmSync } from 'node:fs'
import { join, normalize } from 'node:path'
import { Hono } from 'hono'
import { and, asc, eq, inArray, isNull, type SQL } from 'drizzle-orm'
import {
  ArtifactBulkDeleteInputSchema,
  ArtifactBulkDeleteResponseSchema,
  ArtifactDeleteResponseSchema,
  ArtifactReferencesResponseSchema,
  ArtifactResponseSchema,
  ArtifactUpdateInputSchema,
  ArtifactsPageResponseSchema,
  artifactFamilyOf,
  type ArtifactBulkDeleteItem,
  type ArtifactInfo,
  type ShellMode,
} from '@enkaku/protocol'
import type { AuthEnv } from '../auth/middleware'
import { canUseFiles } from '../auth/acl'
import type { AuditLogger } from '../auth/audit'
import type { Db } from '../db'
import { artifacts, type ArtifactRow } from '../db/schema'
import { artifactRowToInfo, findArtifactReferences } from '../artifacts/references'
import { artifactKindFor, probeMedia } from '../media/probe'
import { EnkakuError } from '../util/errors'
import { decodeCursor, encodeCursor, keysetWhere, parsePageQuery } from './pagination'
import { typedJson } from './typed-json'

/**
 * The FALLBACK content type, by extension, for a row whose `mimeType` the probe
 * could not read — `/:id/content` prefers the probed value, which is read from
 * the bytes and is right for a file whose name says nothing.
 *
 * The media entries past the original eight are the ones a browser has to be
 * told about before it will play or show a file: a `<video>` or `<img>` handed
 * `application/octet-stream` does not sniff, it just fails.
 */
const CONTENT_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  json: 'application/json',
  log: 'text/plain; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  mov: 'video/quicktime',
  '3gp': 'video/3gpp',
  avi: 'video/x-msvideo',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  pdf: 'application/pdf',
  zip: 'application/zip',
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
 * The most bytes one ranged response to `GET /:id/content` will carry.
 *
 * A range is read into memory before it is sent (see that route for why it
 * cannot be streamed as a file slice), so this is the ceiling on what one
 * request can allocate on a machine that is also driving every phone in the
 * farm. Eight megabytes is a few seconds of a screen recording — large enough
 * that a player is not making a request per frame, small enough that ten
 * viewers scrubbing at once is not a problem.
 *
 * `ENKAKU_*`-overridable? No: nothing about it differs between farms, and a
 * client that wants more bytes simply asks for the next range.
 */
const MAX_RANGE_BYTES = 8 * 1024 * 1024

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

  const rowToItem = artifactRowToInfo

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

    /*
     * What the file IS, from its own bytes (plan 800 wave 4). Until this, every
     * upload landed as `kind: 'file'` with no media type — so an MP4 an
     * operator uploaded was indistinguishable from a `.bin`, and nothing could
     * offer "videos only" or draw a grid.
     *
     * Never throws and never fails the upload: the bytes are already stored and
     * the file is perfectly usable as an opaque one, so a probe that cannot
     * read a container degrades to nulls rather than rejecting the file.
     */
    const probe = probeMedia(bytes)

    const info: ArtifactInfo = {
      id: crypto.randomUUID(),
      runId: null,
      deviceId: null,
      kind: artifactKindFor(probe),
      label,
      path: relPath,
      sizeBytes: bytes.length,
      createdAt: Math.floor(Date.now() / 1000),
      // Not auto-pinned: `storage.uploads` already defaults to keeping uploads
      // forever, so pinning every one would leave that setting with nothing to
      // act on. The pin is the operator's own override of whatever they set.
      pinned: false,
      mimeType: probe.mimeType,
      width: probe.width,
      height: probe.height,
      durationMs: probe.durationMs,
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
        pinned: info.pinned,
        mimeType: info.mimeType,
        width: info.width,
        height: info.height,
        durationMs: info.durationMs,
      })
      .run()

    deps.upload.audit.record({
      userId: user.id,
      action: 'artifact.upload',
      target: info.id,
      meta: { label, sizeBytes: bytes.length, ext, mimeType: info.mimeType, kind: info.kind },
    })

    return c.json({ artifact: info }, 201)
  })

  /**
   * The same gate the upload uses (`device.files`, widened by `shell.mode`),
   * spelled once — an operator who may not put a file into the store must not
   * be able to rename or delete one out of it either.
   */
  function requireFiles(c: { get: (k: 'user') => { id: string; role: Parameters<typeof canUseFiles>[0] } | undefined }): { id: string } {
    if (!deps.upload) throw new EnkakuError('E_BAD_REQUEST', 'artifact management is not enabled')
    const user = c.get('user')
    if (!user || !canUseFiles(user.role, deps.upload.shellSettings().mode)) {
      throw new EnkakuError('auth.forbidden', 'you do not have permission to manage artifacts')
    }
    return user
  }

  /**
   * Remove one upload's bytes. Returns the error when the file could not be
   * unlinked (a file already gone is not an error — `force: true`). A path
   * that escapes the data directory is never touched.
   */
  function unlinkUpload(row: ArtifactRow): string | null {
    const rel = normalize(row.path)
    if (rel.startsWith('..')) return null
    try {
      rmSync(join(deps.dataDir, rel), { force: true })
      return null
    } catch (err) {
      return String(err)
    }
  }

  const isUpload = (row: ArtifactRow): boolean => row.runId === null && row.deviceId === null

  /**
   * `GET /api/artifacts/references` — every upload something still names
   * (owner request 2026-09-16), so the Files screen can say "used by" on a tile
   * and warn before a single delete. Gated like delete: the answer names plugin
   * KV keys and job ids, which is management information.
   */
  app.get('/references', (c) => {
    requireFiles(c)
    const ids = deps.db
      .select({ id: artifacts.id })
      .from(artifacts)
      .where(and(isNull(artifacts.runId), isNull(artifacts.deviceId)))
      .all()
      .map((r) => r.id)
    const refs = findArtifactReferences(deps.db, ids)
    return typedJson(c, ArtifactReferencesResponseSchema, { references: Object.fromEntries(refs) })
  })

  /**
   * `POST /api/artifacts/delete` — bulk removal of UPLOADS (owner request
   * 2026-09-16: the Social Media Manager and the post scripts upload a video
   * per post, and old videos pile up with no way to clear them but one click
   * per file).
   *
   * Every rule the single DELETE applies, applied per file, and reported per
   * file rather than failing the whole request on the first refusal:
   * - uploads only — a run's or a device's artifact is that run's evidence and
   *   leaves only through retention (`not-upload`);
   * - a pinned file is never deleted (`pinned`);
   * - a file named by work happening now — a queued/running job, an active
   *   batch — is never deleted, `force` or not (`in-use`);
   * - a file named only by a record that may use it later — plugin data, an
   *   enabled schedule, a saved workflow or preset — is skipped unless `force`
   *   (`referenced`).
   *
   * The reference scan and the deletes run in one synchronous stretch after
   * the body is parsed, so nothing can enqueue a job between the check and the
   * unlink. A preview and the confirm that follows it are two requests, which
   * is why the confirm re-checks everything instead of trusting the preview.
   */
  app.post('/delete', async (c) => {
    const user = requireFiles(c)
    const parsed = ArtifactBulkDeleteInputSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) {
      throw new EnkakuError('E_BAD_REQUEST', parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '))
    }
    const { ids, filter, preview, force } = parsed.data

    const items: ArtifactBulkDeleteItem[] = []
    let candidates: ArtifactRow[]
    if (ids !== undefined) {
      const unique = [...new Set(ids)]
      const found = new Map<string, ArtifactRow>()
      for (let i = 0; i < unique.length; i += 500) {
        for (const row of deps.db.select().from(artifacts).where(inArray(artifacts.id, unique.slice(i, i + 500))).all()) found.set(row.id, row)
      }
      candidates = []
      for (const id of unique) {
        const row = found.get(id)
        if (!row) {
          items.push({ id, label: null, sizeBytes: null, outcome: 'skipped', reason: 'not-found', message: 'no such file', references: [] })
        } else if (!isUpload(row)) {
          items.push({
            id,
            label: row.label,
            sizeBytes: row.sizeBytes,
            outcome: 'skipped',
            reason: 'not-upload',
            message: 'belongs to a run or a device, and leaves only with it through retention',
            references: [],
          })
        } else {
          candidates.push(row)
        }
      }
    } else {
      const nowSec = Math.floor(Date.now() / 1000)
      const q = filter?.query?.trim().toLowerCase() ?? ''
      candidates = deps.db
        .select()
        .from(artifacts)
        .where(and(isNull(artifacts.runId), isNull(artifacts.deviceId)))
        .orderBy(asc(artifacts.createdAt), asc(artifacts.id))
        .all()
        .filter((row) => {
          const info = rowToItem(row)
          if (filter?.family !== undefined && artifactFamilyOf(info) !== filter.family) return false
          if (filter?.olderThanSec !== undefined && info.createdAt > nowSec - filter.olderThanSec) return false
          if (q.length > 0 && !(info.label ?? info.id).toLowerCase().includes(q)) return false
          return true
        })
    }

    const refs = findArtifactReferences(
      deps.db,
      candidates.map((r) => r.id),
    )
    const toDelete: string[] = []
    let bytesFreed = 0
    for (const row of candidates) {
      const references = refs.get(row.id) ?? []
      const base = { id: row.id, label: row.label, sizeBytes: row.sizeBytes, references }
      if (row.pinned) {
        items.push({ ...base, outcome: 'skipped', reason: 'pinned', message: 'pinned — unpin it first' })
        continue
      }
      const blocking = references.filter((r) => r.blocking)
      if (blocking.length > 0) {
        items.push({ ...base, outcome: 'skipped', reason: 'in-use', message: `used by ${blocking.length === 1 ? 'a job or batch that is still running or queued' : `${blocking.length} jobs or batches still running or queued`}` })
        continue
      }
      if (references.length > 0 && !force) {
        items.push({ ...base, outcome: 'skipped', reason: 'referenced', message: 'still referenced by plugin data, a schedule, a workflow or a preset' })
        continue
      }
      if (preview) {
        items.push({ ...base, outcome: 'would-delete', reason: null, message: null })
        bytesFreed += row.sizeBytes ?? 0
        continue
      }
      const fileError = unlinkUpload(row)
      if (fileError !== null) {
        // The row is KEPT: its bytes are still on disk, and a file with no row
        // is invisible and leaks disk forever. Visible, and retryable.
        deps.upload?.audit.record({ userId: user.id, action: 'artifact.delete.file-failed', target: row.id, meta: { error: fileError, bulk: true } })
        items.push({ ...base, outcome: 'failed', reason: 'file-error', message: fileError })
        continue
      }
      toDelete.push(row.id)
      bytesFreed += row.sizeBytes ?? 0
      items.push({ ...base, outcome: 'deleted', reason: null, message: null })
      deps.upload?.audit.record({
        userId: user.id,
        action: 'artifact.delete',
        target: row.id,
        meta: { label: row.label, sizeBytes: row.sizeBytes, bulk: true, ...(references.length > 0 ? { forcedReferences: references.length } : {}) },
      })
    }
    for (let i = 0; i < toDelete.length; i += 500) {
      deps.db.delete(artifacts).where(inArray(artifacts.id, toDelete.slice(i, i + 500))).run()
    }

    const deleted = items.filter((i) => i.outcome === 'deleted' || i.outcome === 'would-delete').length
    const skipped = items.filter((i) => i.outcome === 'skipped').length
    const failed = items.filter((i) => i.outcome === 'failed').length
    if (!preview) {
      deps.upload?.audit.record({
        userId: user.id,
        action: 'artifact.delete.bulk',
        meta: { mode: ids !== undefined ? 'ids' : 'filter', ...(filter ? { filter } : {}), force, matched: items.length, deleted, bytesFreed, skipped, failed },
      })
    }
    return typedJson(c, ArtifactBulkDeleteResponseSchema, { preview, matched: items.length, deleted, bytesFreed, skipped, failed, items })
  })

  /**
   * `PATCH /api/artifacts/:id` — rename, or pin against retention (plan 800
   * wave 5).
   *
   * A rename changes `label` ONLY, never `path`. The stored path is how every
   * reference resolves — a workflow's saved artifact id, a queue entry, a
   * pinned batch — so moving the bytes to match a new name would break saved
   * references for a cosmetic change, and there would be no way back.
   */
  app.patch('/:id', async (c) => {
    const user = requireFiles(c)
    const parsed = ArtifactUpdateInputSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) {
      throw new EnkakuError('E_BAD_REQUEST', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '))
    }
    const row = deps.db.select().from(artifacts).where(eq(artifacts.id, c.req.param('id'))).get()
    if (!row) throw new EnkakuError('artifact_not_found', 'no such artifact')

    const patch: Partial<ArtifactRow> = {}
    if (parsed.data.label !== undefined) patch.label = parsed.data.label.trim()
    if (parsed.data.pinned !== undefined) patch.pinned = parsed.data.pinned
    deps.db.update(artifacts).set(patch).where(eq(artifacts.id, row.id)).run()

    deps.upload?.audit.record({ userId: user.id, action: 'artifact.update', target: row.id, meta: { ...parsed.data } })
    const updated = deps.db.select().from(artifacts).where(eq(artifacts.id, row.id)).get()
    return typedJson(c, ArtifactResponseSchema, { artifact: rowToItem(updated ?? row) })
  })

  /**
   * `DELETE /api/artifacts/:id` — the row AND the bytes.
   *
   * A PINNED artifact is refused. The pin means "never delete this
   * automatically" (plan 800 D3), and an operator who set it should have to
   * clear it before a single click can undo that intent — the retention sweep
   * honours the pin, and a manual delete that ignored it would make the pin a
   * half-truth.
   *
   * The file is unlinked BEFORE the row: a row with no file is a visible,
   * recoverable inconsistency (the content route says so), while a file with no
   * row is invisible and leaks disk forever.
   */
  app.delete('/:id', async (c) => {
    const user = requireFiles(c)
    const row = deps.db.select().from(artifacts).where(eq(artifacts.id, c.req.param('id'))).get()
    if (!row) throw new EnkakuError('artifact_not_found', 'no such artifact')
    /*
     * UPLOADS ONLY — `runId` and `deviceId` both null, the same rule
     * `?kind=upload` uses.
     *
     * A run's screenshots and a device's logs are artifacts too, and they are
     * that run's evidence: a timeline, a failure shot, the thing someone opens
     * to find out what happened. Deleting one by id would tear a hole in it
     * silently, and the run would still claim to have produced it. Run output
     * leaves only with its run, through the retention sweep, which is the one
     * path that removes the row and the trace together.
     *
     * PATCH deliberately does NOT carry this restriction: pinning protects a
     * run artifact from the sweep and renaming is cosmetic. Only destruction
     * is confined.
     */
    if (row.runId !== null || row.deviceId !== null) {
      throw new EnkakuError(
        'E_ARTIFACT_NOT_DELETABLE',
        'this artifact belongs to a run or a device — it is that run\'s own evidence, and leaves only with it through retention',
      )
    }
    if (row.pinned) {
      throw new EnkakuError('E_ARTIFACT_PINNED', 'this artifact is pinned — unpin it first if you really mean to delete it')
    }
    // Work happening now that names this file — a queued/running job, an
    // active batch — would fail the moment the bytes are gone. Refused here as
    // in the bulk route; a non-blocking reference (plugin data, a schedule) is
    // the client's to warn about, because only the operator knows whether that
    // record will ever be acted on again.
    const blocking = (findArtifactReferences(deps.db, [row.id]).get(row.id) ?? []).filter((r) => r.blocking)
    if (blocking.length > 0) {
      throw new EnkakuError('E_ARTIFACT_IN_USE', 'a queued or running job (or an active batch) still uses this file — wait for it to finish, or cancel it first')
    }

    const rel = normalize(row.path)
    if (!rel.startsWith('..')) {
      try {
        rmSync(join(deps.dataDir, rel), { force: true })
      } catch (err) {
        // The row is still removed: a file already gone, or one this process
        // cannot unlink, must not leave an entry pointing at nothing forever.
        deps.upload?.audit.record({ userId: user.id, action: 'artifact.delete.file-failed', target: row.id, meta: { error: String(err) } })
      }
    }
    deps.db.delete(artifacts).where(eq(artifacts.id, row.id)).run()
    deps.upload?.audit.record({ userId: user.id, action: 'artifact.delete', target: row.id, meta: { label: row.label, sizeBytes: row.sizeBytes } })
    return typedJson(c, ArtifactDeleteResponseSchema, { ok: true, id: row.id })
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
    /*
     * The PROBE's answer first, the extension map second.
     *
     * `media/probe.ts` reads the container out of the bytes at upload and
     * stores it on the row — `video/webm`, `video/quicktime`, `video/3gpp`,
     * `video/x-matroska` among them — and none of those is in the extension
     * map below, which knows eight. So a WebM recording was uploaded, probed
     * correctly, listed on the Files screen as a video, and then served as
     * `application/octet-stream`: a `<video>` element refuses that outright,
     * and the file read as broken rather than as an unsupported type.
     */
    const contentType = row.mimeType ?? CONTENT_TYPES[ext] ?? 'application/octet-stream'
    const size = file.size

    const headers: Record<string, string> = {
      'content-type': contentType,
      // Announced unconditionally: a player asks for a range only when the
      // first response said it could (below is the half that serves one).
      'accept-ranges': 'bytes',
    }
    /*
     * `?download=1` — the Files screen's Download action. Without a
     * disposition the browser plays an mp4 in the tab instead of saving it,
     * and the anchor's own `download` attribute cannot help across the origin
     * split Studio dev runs under. `filename*` (RFC 5987) rather than
     * `filename=` so a label with a space or a non-ASCII character survives;
     * control characters and quotes are stripped because they are what turns
     * this header into a second header.
     */
    if (c.req.query('download') !== undefined) {
      const name = (row.label ?? rel.split('/').pop() ?? row.id).replace(/[\u0000-\u001f"\\]/g, '').slice(0, 200)
      headers['content-disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(name)}`
    }

    /*
     * Range requests, so a video can be SEEKED (owner, 2026-09-20).
     *
     * Bun serves a `BunFile` body whole; it does not read `Range` for us. A
     * 200 with the entire body is a legal answer to a range request, and it
     * is why scrubbing a long upload in the Files player used to stall — the
     * browser cannot jump to minute nine of a 600 MB clip without asking for
     * the bytes at minute nine, so it re-fetched from zero every time the
     * scrubber moved.
     *
     * **The bytes are MATERIALISED, and that is not an oversight.** Handing
     * `file.slice(start, end + 1)` back as the body is the obvious version and
     * it is silently wrong here: a sliced `BunFile` keeps its end bound in a
     * bare `Bun.serve`, but once the response passes through middleware that
     * rebuilds it — this app's `cors()`, among others — the bound is lost and
     * Bun streams from `start` to EOF, chunked, with the `content-length` we
     * set dropped. Measured on this route: `Range: bytes=10-19` against a
     * 709 425-byte upload answered `206`, `Content-Range: bytes 10-19/709425`
     * and 709 415 bytes of body. A player reading that gets the right header
     * and the wrong data, which is worse than no range support at all.
     *
     * `MAX_RANGE_BYTES` is what keeps materialising affordable: a browser
     * asking `bytes=0-` for a 1 GB upload is asking for the whole file, and
     * answering it in one allocation on the laptop that is also driving the
     * farm is not something this route may do. Serving FEWER bytes than were
     * asked for is explicitly allowed — the response says exactly which bytes
     * it carries, and the player comes back for the next chunk.
     *
     * Only the single-range form (`bytes=start-end`) is answered. A
     * multi-range request would need a multipart/byteranges body, nothing
     * here asks for one, and the correct response to a range we will not
     * serve is the whole file (200) — never a wrong slice.
     */
    const range = c.req.header('range')
    const match = range === undefined ? null : /^bytes=(\d*)-(\d*)$/.exec(range.trim())
    if (match && size > 0) {
      const [, rawStart = '', rawEnd = ''] = match
      let start: number
      let end: number
      if (rawStart === '') {
        // `bytes=-500` — the LAST 500 bytes, not the first. An mp4 whose
        // `moov` atom sits at the end is exactly what asks for this, and
        // reading it as `0-500` hands a player the wrong end of the file.
        if (rawEnd === '') return new Response(file, { headers })
        const suffix = Number.parseInt(rawEnd, 10)
        start = Math.max(0, size - suffix)
        end = size - 1
      } else {
        start = Number.parseInt(rawStart, 10)
        end = rawEnd === '' ? size - 1 : Math.min(Number.parseInt(rawEnd, 10), size - 1)
      }
      // Unsatisfiable: 416 with the real size, which is how a player learns
      // what it may ask for instead of retrying the same bad range.
      if (!Number.isFinite(start) || !Number.isFinite(end) || start >= size || end < start) {
        return new Response(null, { status: 416, headers: { ...headers, 'content-range': `bytes */${size}` } })
      }
      // Capped AFTER the range is validated, so the cap narrows what is sent
      // and never turns an unsatisfiable range into a satisfiable one.
      end = Math.min(end, start + MAX_RANGE_BYTES - 1)
      const body = await file.slice(start, end + 1).bytes()
      return new Response(body, {
        status: 206,
        headers: { ...headers, 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': String(body.length) },
      })
    }

    return new Response(file, { headers })
  })

  const ERROR_STATUS: Record<string, number> = {
    artifact_not_found: 404,
    'auth.forbidden': 403,
    E_TRANSFER_TOO_LARGE: 413,
    E_ARTIFACT_PINNED: 409,
    E_ARTIFACT_NOT_DELETABLE: 409,
    E_ARTIFACT_IN_USE: 409,
  }

  app.onError((err, c) => {
    if (err instanceof EnkakuError) {
      return c.json(err.toJSON(), (ERROR_STATUS[err.code] ?? 400) as 400)
    }
    throw err
  })

  return app
}
