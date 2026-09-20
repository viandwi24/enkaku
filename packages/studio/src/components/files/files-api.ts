import { z } from 'zod'
import {
  ArtifactBulkDeleteResponseSchema,
  ArtifactInfoSchema,
  ArtifactReferencesResponseSchema,
  ArtifactsPageResponseSchema,
  type ArtifactBulkDeleteInput,
  type ArtifactBulkDeleteResponse,
  type ArtifactInfo,
  type ArtifactReference,
} from '@enkaku/protocol'
import { api, coreBase } from '@enkaku/ui'

/**
 * The client half of `/api/artifacts` for the Files screen (plan 800 wave 5).
 *
 * Only the OWNERLESS rows — `?kind=upload`, meaning `runId` and `deviceId` are
 * both null — are listed here. A run's screenshots and a device's logs are
 * artifacts too, and they belong on the job that produced them, not in a
 * library an operator manages: they are swept on a different policy and
 * deleting one by hand would tear a hole in a run's own evidence.
 */

const UpdateResponseSchema = z.object({ artifact: ArtifactInfoSchema })
const DeleteResponseSchema = z.object({ ok: z.literal(true), id: z.string() })

export type FileItem = ArtifactInfo

/**
 * The core's page size for this walk. `parsePageQuery` clamps at 200 silently
 * (plan 30 acceptance #3), so asking for more would not be an error — it would
 * just be a lie about how many round trips this takes.
 */
const PAGE_LIMIT = 200

/**
 * A hard stop on the walk below: 50 pages, so 10 000 uploads. Not a number the
 * farm is expected to reach — it is there so that a bug in the cursor (a server
 * that keeps handing back the same `nextCursor`) costs one truncated list and
 * not an infinite loop hammering the core that is driving every phone.
 */
const MAX_PAGES = 50

/**
 * Every upload, oldest cursor to last, newest first when it comes back.
 *
 * **This walks the pages on purpose.** `GET /api/artifacts` is keyset-paginated
 * with a default limit of 50, so a single call returns the FIFTY OLDEST
 * uploads — and this screen then sorted them newest-first and called the result
 * the library. On a farm with more than fifty files that is silently wrong in
 * the worst direction: the clip you uploaded a minute ago is the one that is
 * missing, the count reads "50 of 50", and nothing anywhere says a page was
 * dropped.
 *
 * The walk is what makes searching, sorting and paging honest, because all
 * three happen over the whole library rather than over whichever window the
 * core handed back. The core cannot do that half of the work: its keyset is
 * `createdAt, id`, so it can page a timeline and nothing else — a page ordered
 * by name or by size is not a query it can answer. Whoever sorts must therefore
 * hold every row, and these rows are small metadata (no bytes, no thumbnails —
 * plan 800 wave 4 stores neither), which is what makes holding them affordable.
 */
export async function listUploads(): Promise<FileItem[]> {
  const out: FileItem[] = []
  let cursor: string | null = null
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const query = `/api/artifacts?kind=upload&limit=${PAGE_LIMIT}${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`
    const body: { items: FileItem[]; nextCursor: string | null } = await api(query, ArtifactsPageResponseSchema)
    out.push(...body.items)
    if (body.nextCursor === null) break
    cursor = body.nextCursor
  }
  // Newest first. The endpoint is a timeline (oldest first, deliberately — see
  // its own comment), which is right for a run's artifacts and wrong for a
  // library, where what you just uploaded is what you are looking for. This is
  // only the ARRIVAL order: the screen re-sorts by whatever the operator
  // picked, and does it over this whole array.
  return out.sort((a, b) => b.createdAt - a.createdAt)
}

export function renameUpload(id: string, label: string): Promise<{ artifact: FileItem }> {
  return api(`/api/artifacts/${encodeURIComponent(id)}`, UpdateResponseSchema, { method: 'PATCH', json: { label } })
}

export function setUploadPinned(id: string, pinned: boolean): Promise<{ artifact: FileItem }> {
  return api(`/api/artifacts/${encodeURIComponent(id)}`, UpdateResponseSchema, { method: 'PATCH', json: { pinned } })
}

export function deleteUpload(id: string): Promise<{ ok: true; id: string }> {
  return api(`/api/artifacts/${encodeURIComponent(id)}`, DeleteResponseSchema, { method: 'DELETE' })
}

/**
 * Every upload something still names — a queued job, plugin data, a schedule
 * (`GET /api/artifacts/references`). Keyed by artifact id; an id that is absent
 * has no reference the farm can see.
 */
export async function listUploadReferences(): Promise<Record<string, ArtifactReference[]>> {
  const { references } = await api('/api/artifacts/references', ArtifactReferencesResponseSchema)
  return references
}

/** `POST /api/artifacts/delete` — a preview (`preview: true`) or the real thing; the server re-checks every rule either way. */
export function bulkDeleteUploads(body: ArtifactBulkDeleteInput): Promise<ArtifactBulkDeleteResponse> {
  return api('/api/artifacts/delete', ArtifactBulkDeleteResponseSchema, { method: 'POST', json: body })
}

/** One reference in words, for a tile's "Used by" line and a dialog's list. */
export function describeReference(ref: ArtifactReference): string {
  switch (ref.kind) {
    case 'job':
      return `${ref.status === 'running' ? 'running' : 'queued'} job ${ref.name ?? ref.jobId}`
    case 'batch':
      return `active batch (${ref.status})`
    case 'schedule':
      return `schedule "${ref.name}"`
    case 'workflow':
      return `workflow "${ref.name}"`
    case 'preset':
      return `preset "${ref.name}" of ${ref.ownerName}`
    case 'plugin-data':
      return `${ref.namespace} data (${ref.key})`
  }
}

/** Where the bytes are. Used by `<img>`/`<video>` directly — the browser is the decoder, which is why no thumbnail is stored (plan 800 wave 4). */
export function uploadContentUrl(id: string): string {
  return `${coreBase()}/api/artifacts/${encodeURIComponent(id)}/content`
}

/**
 * Multipart, the same shape `ArtifactPicker` already posts. Not routed through
 * `api()` because that helper JSON-encodes a body, and an upload must stream
 * the `File` itself rather than a base64 copy of it.
 *
 * `XMLHttpRequest`, not `fetch`, for ONE reason: it is the only browser API
 * that reports UPLOAD progress. `fetch` has no equivalent — request streaming
 * is still not available where this has to run — and the cap here is a
 * gigabyte, so a large video would otherwise sit with no feedback at all for
 * minutes and read as a frozen page.
 */
export function uploadFile(file: File, onProgress?: (fraction: number) => void): Promise<FileItem> {
  const form = new FormData()
  form.set('file', file)
  form.set('label', file.name)

  return new Promise<FileItem>((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', `${coreBase()}/api/artifacts`)
    // The session cookie on a cross-origin call — a plugin or Studio dev on
    // :3001 reaches the core on another port, exactly as `api()` does.
    xhr.withCredentials = true

    xhr.upload.addEventListener('progress', (e) => {
      // `lengthComputable` is false for a body of unknown size; reporting a
      // fraction from a zero total would animate a bar that means nothing.
      if (e.lengthComputable && e.total > 0) onProgress?.(e.loaded / e.total)
    })

    xhr.addEventListener('error', () => reject(new Error('The upload failed before the server answered — check the connection to the farm.')))
    xhr.addEventListener('abort', () => reject(new Error('The upload was cancelled.')))
    xhr.addEventListener('load', () => {
      type UploadBody = { artifact?: unknown; error?: { message?: string } }
      let body: UploadBody | null = null
      try {
        body = JSON.parse(xhr.responseText) as UploadBody
      } catch {
        // A body that is not JSON at all — see the 413 case below, which is
        // exactly when that happens.
        body = null
      }
      if (xhr.status >= 200 && xhr.status < 300 && body?.artifact) {
        resolve(ArtifactInfoSchema.parse(body.artifact))
        return
      }
      /*
       * 413 can arrive with NO body: `Bun.serve`'s own `maxRequestBodySize` is
       * enforced in the transport, so the core's route never runs and never
       * gets to say anything. `ArtifactPicker` learned this from a field report
       * where the empty response was read as a 403 and sent a whole
       * investigation at permissions instead of at size — so the message names
       * the real size here too.
       */
      if (xhr.status === 413 && !body?.error?.message) {
        const mb = Math.round(file.size / (1024 * 1024))
        reject(new Error(`The server rejected this upload as too large (${mb} MB). It was refused before reaching the app, so there is no server message to show.`))
        return
      }
      reject(new Error(body?.error?.message ?? `Upload failed (HTTP ${xhr.status})`))
    })

    xhr.send(form)
  })
}

/** The three families the filter offers, plus All. The family itself is `artifactFamilyOf` in `@enkaku/protocol`, so the bulk delete's filter mode selects exactly what the tab shows. */
export type FileFilter = 'all' | 'image' | 'video' | 'other'

/**
 * `1:23`, or `1:02:03` past an hour, or null when the probe could not read a
 * duration — never `0:00`, which reads as an empty video.
 *
 * The hour branch exists because a screen recording pulled off a device is
 * routinely longer than an hour, and `73:20` for it is not a duration anyone
 * reads correctly at a glance.
 */
export function formatDuration(ms: number | null): string | null {
  if (ms === null || ms <= 0) return null
  const total = Math.round(ms / 1000)
  const seconds = String(total % 60).padStart(2, '0')
  const minutes = Math.floor(total / 60) % 60
  const hours = Math.floor(total / 3600)
  if (hours === 0) return `${minutes}:${seconds}`
  return `${hours}:${String(minutes).padStart(2, '0')}:${seconds}`
}

/**
 * `MP4`, `PNG`, or null. Read from the stored `path` (what the upload actually
 * landed as) and only then from the operator's label, because a label is
 * renameable free text and the extension in it may be a leftover from a name
 * the file no longer has.
 *
 * Capped at five characters so a label containing a dot and a sentence cannot
 * become a column-wide "extension" in the details table.
 */
export function fileExtOf(item: Pick<FileItem, 'path' | 'label'>): string | null {
  for (const source of [item.path, item.label]) {
    if (!source) continue
    const base = source.slice(source.lastIndexOf('/') + 1)
    const dot = base.lastIndexOf('.')
    if (dot <= 0 || dot === base.length - 1) continue
    const ext = base.slice(dot + 1)
    if (ext.length > 5 || !/^[A-Za-z0-9]+$/.test(ext)) continue
    return ext.toUpperCase()
  }
  return null
}

/**
 * The same bytes as `uploadContentUrl`, asked for as a download.
 *
 * `?download=1` is read by the core (`GET /api/artifacts/:id/content`), which
 * answers it with `Content-Disposition: attachment` and the file's own label as
 * the filename. The anchor's `download` attribute is not enough on its own:
 * it is ignored cross-origin, which is exactly the case in Studio dev on
 * :3001, where without the header a click would navigate the tab to the video
 * instead of saving it.
 */
export function uploadDownloadUrl(id: string): string {
  return `${uploadContentUrl(id)}?download=1`
}
