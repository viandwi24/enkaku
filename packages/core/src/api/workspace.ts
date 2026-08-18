import { Hono, type Context } from 'hono'
import { z } from 'zod'
import { WorkspaceFileMetaSchema, type ShellMode } from '@enkaku/protocol'
import type { AuthEnv } from '../auth/middleware'
import { canUseFiles } from '../auth/acl'
import type { AuditLogger } from '../auth/audit'
import { EnkakuError } from '../util/errors'
import type { WorkspaceStore } from '../workspace/store'
import { typedJson } from './typed-json'

/**
 * A hard ceiling on the upload itself (plan 115 §4.3), mirroring
 * `packages/core/src/api/artifacts.ts`'s own `MAX_UPLOAD_BYTES` — independent
 * of `workspace.maxFileBytes` (a farm setting with no upper bound of its
 * own, §3.5), this is a blunt safety net against an oversized request body
 * checked before the store's own quota (which names the setting, §3.5) gets
 * a chance to run.
 */
const MAX_UPLOAD_BYTES = 1024 * 1024 * 1024

const UploadResponseSchema = z.object({ file: WorkspaceFileMetaSchema })

/**
 * `POST /api/workspace/file` (plan 115 §4.3) — a multipart upload, the way a
 * BROWSER gets bytes into the workspace. `fs.write` (the capability) stays
 * exactly as it is: that is how a SCRIPT writes text or base64 through the
 * capability door (plan 64 §4.2). This route mirrors `POST /api/artifacts`'s
 * shape instead of inventing a second one — a multipart body, a
 * declared-length guard, the same auth (`device.files`, widened by
 * `shell.mode`), and an audit row — and writes through the SAME
 * `WorkspaceStore.write` the capability uses, so quotas, CAS, and whichever
 * content driver a write routes to (plan 115 §3.4) all apply exactly as they
 * do for a script. Nothing here touches `node:fs` or picks a driver — that
 * decision belongs to the store alone (§3.1).
 *
 * `GET /api/workspace/file?path=…` (plan 116 §4.2) is `POST`'s sibling: the
 * way a BROWSER gets bytes back OUT, streamable and seekable (`Range`), for
 * a presenter to show. It is deliberately NOT built on
 * `packages/core/src/api/artifacts.ts`'s `GET /:id/content` — that route
 * sets `content-type` and nothing else (plan 116 P4), and Studio being
 * served from the core's own origin (00-overview §3) makes serving
 * operator-uploaded bytes that way a stored-XSS vector (plan 116 P5). This
 * route adds `nosniff`, an inline/attachment allow-list, and a sandboxed CSP
 * on every response it returns, success or error (plan 116 §3.5).
 *
 * `HEAD /api/workspace/file?path=…` (plan 116 §4.2, step 116.6, finding P7)
 * is `GET`'s metadata-only sibling: same auth, same path validation, the
 * SAME §3.5 safety headers (never a second, drifted copy of the
 * inline/attachment allow-list — that list is a security control, P5), and
 * no body. It exists so the Studio workspace page can learn a file's
 * `contentType`/size — and, via `ETag`/`X-Enkaku-*`, enough of its
 * `WorkspaceFileMeta` to keep working (attribution, the CAS `hash` a save or
 * delete needs) — WITHOUT calling `fs.read`, which base64-encodes binary and
 * would otherwise pull an entire 200 MB video through the capability API as
 * one JSON string just to find out it is a video (P7).
 *
 * It is branched INSIDE the `app.get('/file', ...)` handler below rather
 * than registered as its own `app.on('HEAD', ...)` route — the plan's own
 * note ("Hono will not answer HEAD from a GET handler by itself under this
 * adapter — register it explicitly and verify, do not assume") turned out to
 * have the mechanism backwards once actually checked against this Hono
 * version (`hono-base.js`'s `#dispatch`): `HEAD` is intercepted
 * UNCONDITIONALLY, before the router is even consulted, and re-dispatched as
 * `GET` with the body of whatever `GET` returns discarded afterward —
 * `if (method === "HEAD") return new Response(null, await this.#dispatch(request, ..., "GET"))`.
 * A separate `app.on('HEAD', '/file', ...)` route is therefore not merely
 * unnecessary, it is DEAD CODE: no request for any path ever reaches it,
 * because `#dispatch` never performs a `HEAD` router match at all. Verified
 * directly (a throwaway script under two registration shapes) before writing
 * this comment, not assumed either way. `c.req.method` inside the `GET`
 * handler still correctly reports `'HEAD'` for the original request, which
 * is what the branch below reads.
 */
export function createWorkspaceFileRoutes(deps: {
  workspace: WorkspaceStore
  /** Undefined disables the route, mirroring `artifacts.ts`'s `upload` optionality. */
  upload?: {
    audit: AuditLogger
    shellSettings: () => { mode: ShellMode }
  }
}): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>()

  app.post('/file', async (c) => {
    if (!deps.upload) throw new EnkakuError('E_BAD_REQUEST', 'workspace upload is not enabled')
    const user = c.get('user')
    if (!user || !canUseFiles(user.role, deps.upload.shellSettings().mode)) {
      throw new EnkakuError('auth.forbidden', 'you do not have permission to upload workspace files')
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
    const pathField = body?.path
    const path = typeof pathField === 'string' ? pathField.trim() : ''
    if (!path) throw new EnkakuError('E_BAD_REQUEST', 'a "path" field is required')

    const content = new Uint8Array(await file.arrayBuffer())
    const contentType = file.type || 'application/octet-stream'
    const actor = `user:${user.id}`
    // No `ifMatch`: an upload always CREATES. Overwriting an existing path
    // through this route refuses with the store's own `E_EXISTS`, the same
    // as `fs.write` without one — there is no CAS token in a browser's file
    // picker to pass back, and the workspace page's own upload control does
    // not offer to replace a file in place (plan 115 §4.4).
    const meta = deps.workspace.write(path, { content, contentType, actor })

    deps.upload.audit.record({
      userId: user.id,
      action: 'workspace.upload',
      target: meta.path,
      meta: { sizeBytes: meta.size, contentType: meta.contentType },
    })

    return typedJson(c, UploadResponseSchema, { file: meta }, 201)
  })

  const FileQuerySchema = z.object({ path: z.string().min(1) })

  /**
   * Same gate for every reader of workspace bytes over HTTP (`GET` and
   * `HEAD` alike, §4.2): `deps.upload` undefined disables the whole surface,
   * not just `POST`. Shared rather than repeated so the two routes cannot
   * drift on who may read.
   */
  const requireReadAuth = (c: Context<AuthEnv>): void => {
    if (!deps.upload) throw new EnkakuError('E_BAD_REQUEST', 'workspace file access is not enabled')
    const user = c.get('user')
    if (!user || !canUseFiles(user.role, deps.upload.shellSettings().mode)) {
      throw new EnkakuError('auth.forbidden', 'you do not have permission to read workspace files')
    }
  }

  /**
   * §3.5's headers, built ONCE and shared by `GET` and `HEAD` (plan 116 step
   * 116.6) so the inline-vs-attachment allow-list — a security control, P5 —
   * can never quietly diverge between the two routes that both decide it.
   */
  const buildFileHeaders = (file: { contentType: string; path: string }): Headers => {
    const headers = new Headers()
    // §3.5, unconditional — applies to this response whatever its final
    // status turns out to be, success or error (plan 116 criterion 6).
    headers.set('X-Content-Type-Options', 'nosniff')
    headers.set('Content-Security-Policy', 'sandbox')
    headers.set('Content-Type', file.contentType)
    if (!isInlineable(file.contentType)) {
      // Outside the allow-list — including a mislabelled `text/html` or
      // `image/svg+xml` that DID match a prefix below but is excluded from
      // it by name (see `isInlineable`'s own comment) — served as a
      // download rather than a page (§3.5, P5).
      headers.set('Content-Disposition', `attachment; filename="${safeFilename(file.path)}"`)
    }
    return headers
  }

  app.get('/file', (c) => {
    const parsed = FileQuerySchema.safeParse(c.req.query())
    if (!parsed.success) throw new EnkakuError('E_BAD_REQUEST', 'a "path" query parameter is required')
    requireReadAuth(c)

    // Through the STORE only (plan 116 §4.2) — never a content driver and
    // never `node:fs` here, so an `inline` row and an `fs` row (and, later,
    // an `s3` one) are served identically. This reads the whole file into
    // memory; the store has no partial-read API, so `Range` is answered by
    // slicing the bytes it already returned, not by seeking on disk. A
    // `HEAD` request (see the branch just below) still pays this in-process
    // read — the store has no metadata-only (`stat`) method — but never puts
    // the bytes on the wire, which is the transfer P7 is actually about.
    // Fixing the store's read API to avoid the in-process load too is real
    // and is plan 115's storage seam, out of scope here (this plan's own
    // constraints).
    const file = deps.workspace.read(parsed.data.path)
    const size = file.content.byteLength

    const headers = buildFileHeaders(file)

    // `HEAD` (step 116.6, P7): answer the WHOLE file's metadata headers with
    // no body and no `Range` handling — a presenter has not been chosen yet
    // at the point the page calls this, so there is nothing yet to seek
    // within. `WorkspaceFileMeta` (§4.1's `PresenterProps.meta`) carries more
    // than `Content-Type`/`Content-Length`: `hash` is the CAS token the text
    // presenter's save and the page's own delete both send back as `ifMatch`
    // (§3.7), and `createdBy`/`updatedBy`/`createdAt`/`updatedAt` drive the
    // attribution line every presenter shows. Losing any of those would turn
    // "click a video" into a save that fails with a stale-token error the
    // operator cannot explain, or an attribution line that silently goes
    // blank. `ETag` is the idiomatic HTTP carrier for `hash` (quoted per RFC
    // 7232, stripped back to the bare hex string by the client); the other
    // four have no standard-header equivalent that means the same thing, so
    // they ride as `X-Enkaku-*` — the same prefix `daemon.ts`'s
    // `x-enkaku-dev-owner` already established for this codebase's own
    // headers. Cross-origin (Studio dev on :3001 against the core on
    // :7700), none of these five are readable from `response.headers.get(...)`
    // unless `server/http.ts`'s CORS middleware also EXPOSES them — see that
    // file's own comment beside `exposeHeaders`.
    if (c.req.method === 'HEAD') {
      headers.set('Accept-Ranges', 'bytes')
      headers.set('Content-Length', String(size))
      headers.set('ETag', `"${file.hash}"`)
      headers.set('X-Enkaku-Created-At', String(file.createdAt))
      headers.set('X-Enkaku-Updated-At', String(file.updatedAt))
      // Omitted rather than sent empty when null — the client reads a
      // MISSING header as "nobody", exactly like `WorkspaceFileMetaSchema`'s
      // own `.nullable()` on these two fields.
      if (file.createdBy) headers.set('X-Enkaku-Created-By', file.createdBy)
      if (file.updatedBy) headers.set('X-Enkaku-Updated-By', file.updatedBy)
      return new Response(null, { status: 200, headers })
    }

    const range = parseRange(c.req.header('range'), size)
    if (range === 'unsatisfiable') {
      headers.set('Content-Range', `bytes */${size}`)
      return new Response(null, { status: 416, headers })
    }
    if (range) {
      const { start, end } = range
      // The end of an HTTP byte-range is INCLUSIVE (RFC 7233) — `end` is the
      // index of the LAST byte served, so the exclusive-end slice needs
      // `end + 1`, and the served length is `end - start + 1`, not `end - start`.
      const body = file.content.subarray(start, end + 1)
      headers.set('Content-Range', `bytes ${start}-${end}/${size}`)
      headers.set('Content-Length', String(body.byteLength))
      return new Response(body, { status: 206, headers })
    }

    // A full, non-range response — `Accept-Ranges` is what tells a `<video>`
    // it MAY seek at all; a 206 already proves it by answering one.
    headers.set('Accept-Ranges', 'bytes')
    headers.set('Content-Length', String(size))
    return new Response(file.content, { status: 200, headers })
  })

  const ERROR_STATUS: Record<string, number> = {
    'auth.forbidden': 403,
    E_BAD_REQUEST: 400,
    E_BAD_PATH: 400,
    E_TRANSFER_TOO_LARGE: 413,
    E_QUOTA: 413,
    E_STALE: 409,
    E_EXISTS: 409,
    E_NOT_FOUND: 404,
    E_OUT_OF_SCOPE: 403,
  }

  app.onError((err, c) => {
    if (err instanceof EnkakuError) {
      const res = c.json(err.toJSON(), (ERROR_STATUS[err.code] ?? 400) as 400)
      // §3.5's headers apply to EVERY response this app returns, including
      // an error — a 404 for a missing path is still a response Studio
      // could theoretically render inline if it forgot to check `ok` first.
      res.headers.set('X-Content-Type-Options', 'nosniff')
      res.headers.set('Content-Security-Policy', 'sandbox')
      return res
    }
    throw err
  })

  return app
}

/**
 * Types that CAN carry executable script or markup and must never be served
 * inline even though they match a prefix below (P5, §3.5): `text/html` and
 * `application/xhtml+xml` are pages, not text; `image/svg+xml` is a document
 * that can carry `<script>`, not an image format in the sense that matters
 * here. This is the one exclusion a reviewer will question, so it is written
 * down rather than left to be rediscovered.
 */
const DOCUMENT_CONTENT_TYPES = new Set(['text/html', 'application/xhtml+xml', 'image/svg+xml'])

/** The inline allow-list (§3.5): `text/*`, `image/*`, `video/*`, `audio/*`, and
 * `application/json` — MINUS the document types above. Everything else, allow-listed
 * prefix or not, is a download. */
function isInlineable(contentType: string): boolean {
  const base = (contentType.split(';')[0] ?? '').trim().toLowerCase()
  if (DOCUMENT_CONTENT_TYPES.has(base)) return false
  return (
    base.startsWith('text/') ||
    base.startsWith('image/') ||
    base.startsWith('video/') ||
    base.startsWith('audio/') ||
    base === 'application/json'
  )
}

/** A `Content-Disposition` filename safe against header injection (no CR/LF/quote) — the
 * path's own last segment, never the raw query value. */
function safeFilename(path: string): string {
  const base = path.split('/').pop() || 'download'
  return base.replace(/[\r\n"]/g, '_')
}

type ByteRange = { start: number; end: number }

/**
 * Parses a single `Range: bytes=...` request header against a resource of
 * `size` bytes (plan 116 §3.4/§4.2). Returns `null` when the header is
 * absent, uses a unit other than `bytes`, or names more than one range —
 * all cases where ignoring it and serving the full 200 is correct HTTP
 * behaviour, not a bug. Returns `'unsatisfiable'` when the range names bytes
 * the resource does not have (RFC 7233 §4.4): the caller answers 416 with a
 * `Content-Range` of `bytes *` followed directly by a slash and the size
 * (spelled out in words here, not literally, because that punctuation pair
 * would close this very comment block).
 */
function parseRange(header: string | undefined, size: number): ByteRange | 'unsatisfiable' | null {
  if (!header) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match) return null
  // The two capture groups always matched something (even `''`, via `\d*`)
  // once `match` itself is non-null — `noUncheckedIndexedAccess` still types
  // array access as possibly-`undefined`, so the `?? ''` is for the type
  // checker, not a real runtime case.
  const startStr = match[1] ?? ''
  const endStr = match[2] ?? ''
  if (startStr === '' && endStr === '') return null

  if (size === 0) return 'unsatisfiable'

  if (startStr === '') {
    // A SUFFIX range ("bytes=-500") — the last N bytes. A suffix longer than
    // the file just means "the whole file" (RFC 7233 §2.1), not unsatisfiable.
    const suffixLength = Number(endStr)
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) return 'unsatisfiable'
    return { start: Math.max(0, size - suffixLength), end: size - 1 }
  }

  const start = Number(startStr)
  if (!Number.isFinite(start) || start >= size) return 'unsatisfiable'
  // An OPEN-ENDED range ("bytes=1024-") runs to the last byte. The end of an
  // HTTP range is INCLUSIVE, so that last byte is `size - 1`, never `size`.
  const end = endStr === '' ? size - 1 : Math.min(Number(endStr), size - 1)
  if (!Number.isFinite(end) || end < start) return 'unsatisfiable'
  return { start, end }
}
