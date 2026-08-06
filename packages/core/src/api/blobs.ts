import { Hono } from 'hono'
import type { AgentBlobInfo } from '@enkaku/protocol'
import { UploadBlobResponseSchema } from '@enkaku/protocol'
import type { AuthEnv } from '../auth/middleware'
import { requirePermission } from '../auth/middleware'
import type { AuditLogger } from '../auth/audit'
import type { BlobStore } from '../agent/blob/store'
import { IMAGE_MEDIA_TYPES, sniffImageMediaType } from '../agent/blob/store'
import { EnkakuError } from '../util/errors'
import { typedJson } from './typed-json'

/**
 * The blob API (plan 70 §4.6): `POST /api/v1/blobs` uploads an image (raw
 * body, `Content-Type: image/*`, or a multipart `file` field — either
 * works); `GET /api/v1/blobs/:id` serves it back by its content address.
 * This is the ONLY way a screenshot or attachment ever reaches Studio's
 * `<img>` tags or a person's composer — `/ws` never carries base64 (§3.4,
 * criterion 7).
 *
 * Upload is `agent.run` (talking to an agent — an attachment is part of a
 * message), read is `agent.view`, the same split `api/threads.ts` already
 * draws for posting vs. reading (`auth/acl.ts`).
 */
export function createBlobRoutes(deps: { blobs: BlobStore; audit: AuditLogger; maxUploadBytes: () => number }): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>()

  app.post('/', requirePermission('agent.run'), async (c) => {
    const user = c.get('user')
    const maxBytes = deps.maxUploadBytes()

    const declaredLength = Number(c.req.header('content-length') ?? '0')
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      throw new EnkakuError('E_IMAGE_TOO_LARGE', `the upload is ${declaredLength} bytes, over the ${maxBytes}-byte limit`)
    }

    const contentType = c.req.header('content-type') ?? ''
    let bytes: Uint8Array
    if (contentType.startsWith('multipart/form-data')) {
      const body = await c.req.parseBody().catch(() => null)
      const file = body?.file
      if (!file || !(file instanceof File)) throw new EnkakuError('E_BAD_REQUEST', 'a multipart "file" field is required')
      bytes = new Uint8Array(await file.arrayBuffer())
    } else {
      bytes = new Uint8Array(await c.req.arrayBuffer())
    }

    if (bytes.byteLength === 0) throw new EnkakuError('E_BAD_REQUEST', 'the upload is empty')
    // Refused by NAME, never silently truncated (plan 70 §1) — checked before storing.
    if (bytes.byteLength > maxBytes) {
      throw new EnkakuError('E_IMAGE_TOO_LARGE', `the upload is ${bytes.byteLength} bytes, over the ${maxBytes}-byte limit`)
    }

    // Accepted type decided by SNIFFING MAGIC BYTES (plan 70 §3.5) — never the declared
    // `Content-Type` or a filename, which are only ever an assertion from the client.
    const mediaType = sniffImageMediaType(bytes)
    if (!mediaType) {
      throw new EnkakuError('E_UNSUPPORTED_MEDIA_TYPE', 'the upload is not a recognised image (png, jpeg, webp, or gif) by its magic bytes')
    }

    const stored = deps.blobs.put(bytes, mediaType)
    deps.audit.record({ userId: user?.id ?? null, action: 'agent.blob.upload', target: stored.id, meta: { mediaType, bytes: stored.bytes } })

    const info: AgentBlobInfo = {
      blobId: stored.id,
      mediaType,
      bytes: stored.bytes,
      ...(stored.width !== null ? { width: stored.width } : {}),
      ...(stored.height !== null ? { height: stored.height } : {}),
    }
    return typedJson(c, UploadBlobResponseSchema, info, 201)
  })

  app.get('/:id', requirePermission('agent.view'), (c) => {
    const stored = deps.blobs.get(c.req.param('id'))
    if (!stored) throw new EnkakuError('blob_not_found', `no such blob: ${c.req.param('id')}`)

    // A hash-named resource can never change, so this is a genuinely immutable, long-lived cache
    // (plan 70 §3.4) — a browser only ever fetches each distinct blob id once.
    const headers: Record<string, string> = {
      'content-type': stored.mediaType,
      'cache-control': 'public, max-age=31536000, immutable',
      'x-content-type-options': 'nosniff',
    }
    // Defensive — every row this store can produce today is already one of the four allowed image
    // types (both writers, this route and the loop, sniff before ever calling `put`), but a served
    // resource outside that allowlist is never rendered inline regardless of how it got here.
    if (!IMAGE_MEDIA_TYPES.includes(stored.mediaType as (typeof IMAGE_MEDIA_TYPES)[number])) {
      headers['content-disposition'] = 'attachment'
    }
    return new Response(new Uint8Array(stored.data), { headers })
  })

  const ERROR_STATUS: Record<string, number> = {
    blob_not_found: 404,
    E_IMAGE_TOO_LARGE: 413,
    E_UNSUPPORTED_MEDIA_TYPE: 415,
    E_BAD_REQUEST: 400,
  }

  app.onError((err, c) => {
    if (err instanceof EnkakuError) {
      return c.json(err.toJSON(), (ERROR_STATUS[err.code] ?? 400) as 400)
    }
    throw err
  })

  return app
}
