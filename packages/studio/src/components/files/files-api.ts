import { z } from 'zod'
import { ArtifactInfoSchema, type ArtifactInfo } from '@enkaku/protocol'
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

const ListResponseSchema = z.object({ artifacts: z.array(ArtifactInfoSchema) })
const UpdateResponseSchema = z.object({ artifact: ArtifactInfoSchema })
const DeleteResponseSchema = z.object({ ok: z.literal(true), id: z.string() })

export type FileItem = ArtifactInfo

export async function listUploads(): Promise<FileItem[]> {
  const { artifacts } = await api('/api/artifacts?kind=upload', ListResponseSchema)
  // Newest first. The endpoint is a timeline (oldest first, deliberately — see
  // its own comment), which is right for a run's artifacts and wrong for a
  // library, where what you just uploaded is what you are looking for.
  return [...artifacts].sort((a, b) => b.createdAt - a.createdAt)
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

/** Where the bytes are. Used by `<img>`/`<video>` directly — the browser is the decoder, which is why no thumbnail is stored (plan 800 wave 4). */
export function uploadContentUrl(id: string): string {
  return `${coreBase()}/api/artifacts/${encodeURIComponent(id)}/content`
}

/**
 * Multipart, the same shape `ArtifactPicker` already posts. Not routed through
 * `api()` because that helper JSON-encodes a body, and an upload must stream
 * the `File` itself rather than a base64 copy of it.
 */
export async function uploadFile(file: File): Promise<FileItem> {
  const form = new FormData()
  form.set('file', file)
  form.set('label', file.name)
  const res = await fetch(`${coreBase()}/api/artifacts`, { method: 'POST', body: form, credentials: 'include' })
  const body = (await res.json().catch(() => null)) as { artifact?: unknown; error?: { message?: string } } | null
  if (!res.ok || !body?.artifact) {
    /*
     * 413 can arrive with NO body: `Bun.serve`'s own `maxRequestBodySize` is
     * enforced in the transport, so the core's route never runs and never gets
     * to say anything. `ArtifactPicker` learned this from a field report where
     * the empty response was read as a 403 and sent a whole investigation at
     * permissions instead of at size — so the message names the real size here
     * too, rather than leaving an operator to guess what "too large" means.
     */
    if (res.status === 413 && !body?.error?.message) {
      const mb = Math.round(file.size / (1024 * 1024))
      throw new Error(`The server rejected this upload as too large (${mb} MB). It was refused before reaching the app, so there is no server message to show.`)
    }
    throw new Error(body?.error?.message ?? `Upload failed (HTTP ${res.status})`)
  }
  return ArtifactInfoSchema.parse(body.artifact)
}

/** The three families the filter offers. Derived from what the probe actually stored, never from the filename. */
export type FileFilter = 'all' | 'image' | 'video' | 'other'

export function familyOf(item: FileItem): Exclude<FileFilter, 'all'> {
  if (item.kind === 'screenshot' || item.mimeType?.startsWith('image/')) return 'image'
  if (item.kind === 'video' || item.mimeType?.startsWith('video/')) return 'video'
  return 'other'
}

/** `1:23`, or null when the probe could not read a duration — never `0:00`, which reads as an empty video. */
export function formatDuration(ms: number | null): string | null {
  if (ms === null || ms <= 0) return null
  const total = Math.round(ms / 1000)
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}
