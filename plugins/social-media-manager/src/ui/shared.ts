import { api } from '@enkaku/ui'
import { z } from 'zod'

/**
 * The one screen's shared vocabulary: what it reads from the farm, and how.
 *
 * ## Why this screen exists at all
 *
 * The owner's words, after using the declared tables: *"saya minta menunya
 * sama aja jadi satu dong jangan dibedakan ada menu view page khusus untuk
 * item post, untuk sesi dll jadi bingung user"*. Three screens — posts,
 * sessions, platforms — for one job (put a folder of videos on a wall of
 * phones) is three places to learn and two to get lost in.
 *
 * So the flow is one page, in the order the work actually happens: upload the
 * videos, say where they go and how fast, name the batch, start it, watch it.
 * Everything below serves that page.
 *
 * ## Every call here is the farm's own API
 *
 * No new endpoint was added for this screen. Uploads go to the same
 * `/api/artifacts` the Files screen posts to; the session is created by the
 * same `smm/add-group` member the router already knows; the fleet comes from
 * `/api/devices`. A screen that invented its own back door would be a second
 * path into the same state, and the first thing to disagree with the router.
 */

export const CORE = ''

/** A video the operator has uploaded, as the Files screen sees it. */
export const ArtifactSchema = z.object({
  id: z.string(),
  label: z.string().nullable().default(null),
  sizeBytes: z.number().nullable().default(null),
  mimeType: z.string().nullable().default(null),
  createdAt: z.number(),
})
export type Artifact = z.infer<typeof ArtifactSchema>

const ArtifactListSchema = z.object({ items: z.array(ArtifactSchema) })

/**
 * The uploads, newest first.
 *
 * Filtered to things that plausibly ARE videos: the farm stores apks and
 * probes in the same place, and a list that offers an apk as a video to post
 * is offering a mistake. `mimeType` is trusted when present and the file
 * extension is the fallback, because older uploads carry no type at all.
 */
export async function listVideos(): Promise<Artifact[]> {
  const res = await api(`${CORE}/api/artifacts?kind=upload`, ArtifactListSchema)
  return res.items
    .filter((a) => isVideo(a))
    .sort((x, y) => y.createdAt - x.createdAt)
}

const VIDEO_EXTENSIONS = ['.mp4', '.mov', '.m4v', '.webm', '.mkv', '.3gp']

export function isVideo(a: Artifact): boolean {
  if (a.mimeType?.startsWith('video/')) return true
  const name = (a.label ?? '').toLowerCase()
  return VIDEO_EXTENSIONS.some((ext) => name.endsWith(ext))
}

/** A phone, as much of it as this screen needs to choose and to name. */
export const DeviceSchema = z.object({
  id: z.string(),
  label: z.string().nullable().default(null),
  number: z.number().nullable().default(null),
  status: z.string(),
  labels: z.array(z.object({ id: z.string(), name: z.string() })).default([]),
  group: z.object({ id: z.string(), name: z.string() }).nullable().default(null),
})
export type Device = z.infer<typeof DeviceSchema>

const DeviceListSchema = z.object({ items: z.array(DeviceSchema) })

export async function listDevices(): Promise<Device[]> {
  const res = await api(`${CORE}/api/devices`, DeviceListSchema)
  return res.items
}

/** `#7 Galaxy A15`, or the bare label — the same shape the rest of Studio names a phone by. */
export function deviceName(d: Device): string {
  const label = d.label?.trim() || d.id.slice(0, 8)
  return d.number === null ? label : `#${d.number} ${label}`
}

export const PLATFORMS = [
  { id: 'tiktok', title: 'TikTok', postable: true },
  { id: 'youtube', title: 'YouTube', postable: true },
  { id: 'instagram', title: 'Instagram', postable: false },
] as const
export type PlatformId = (typeof PLATFORMS)[number]['id']

/** The device label a platform routes on — the same string `platforms.ts` uses on the service side. */
export function platformLabel(id: PlatformId): string {
  return id
}

export const GroupProgressSchema = z.object({
  total: z.number(),
  waiting: z.number(),
  running: z.number(),
  posted: z.number(),
  failed: z.number(),
  attention: z.number(),
})

export const GroupSchema = z.object({
  version: z.literal(1),
  id: z.string(),
  title: z.string(),
  createdAt: z.number(),
  platforms: z.array(z.string()),
  assignment: z.enum(['one-per-phone', 'every-phone']),
  pacing: z.object({
    order: z.enum(['as-listed', 'random']),
    concurrency: z.number(),
    gapSec: z.tuple([z.number(), z.number()]),
  }),
  videoArtifactIds: z.array(z.string()),
  progress: GroupProgressSchema.nullable().default(null),
  summary: z.string().nullable().default(null),
})
export type Group = z.infer<typeof GroupSchema>

export const AttemptSchema = z.object({
  jobId: z.string(),
  deviceId: z.string(),
  deviceName: z.string().nullable().default(null),
  state: z.string(),
  error: z.string().nullable().default(null),
})

export const PostSchema = z.object({
  version: z.literal(1),
  videoArtifactId: z.string(),
  caption: z.string(),
  platforms: z.array(z.string()),
  groupId: z.string().nullable().default(null),
  notBeforeAt: z.number().nullable().default(null),
  createdAt: z.number(),
  dispatch: z.record(
    z.string(),
    z.object({
      state: z.string(),
      attempts: z.array(AttemptSchema).default([]),
      note: z.string().nullable().default(null),
      summary: z.string().nullable().default(null),
    }),
  ),
})
export type Post = z.infer<typeof PostSchema>

const KvListSchema = z.object({
  items: z.array(z.object({ key: z.string(), value: z.unknown() })),
  nextCursor: z.string().nullable().default(null),
})

/** Every stored row under a prefix, paged to the end. The farm's own plugin-data API. */
async function readAll(prefix: string): Promise<{ key: string; value: unknown }[]> {
  const out: { key: string; value: unknown }[] = []
  let cursor: string | null = null
  do {
    const q = new URLSearchParams({ scope: 'global', prefix, limit: '500' })
    if (cursor !== null) q.set('cursor', cursor)
    const page = await api(`${CORE}/api/plugins/smm/data?${q.toString()}`, KvListSchema)
    out.push(...page.items)
    cursor = page.nextCursor
  } while (cursor !== null)
  return out
}

/** The sessions, newest first. A row this build cannot parse is skipped, never shown half-read. */
export async function listGroups(): Promise<Group[]> {
  const rows = await readAll('group:')
  const groups: Group[] = []
  for (const row of rows) {
    const parsed = GroupSchema.safeParse(row.value)
    if (parsed.success) groups.push(parsed.data)
  }
  return groups.sort((a, b) => b.createdAt - a.createdAt)
}

export async function listPosts(): Promise<Post[]> {
  const rows = await readAll('post:')
  const posts: Post[] = []
  for (const row of rows) {
    const parsed = PostSchema.safeParse(row.value)
    if (parsed.success) posts.push(parsed.data)
  }
  return posts
}

const RunScriptResult = z.object({
  results: z.array(z.object({ deviceId: z.string(), status: z.string(), jobId: z.string().optional(), detail: z.unknown().optional() })),
})

/**
 * Run one of this plugin's own members.
 *
 * `deviceId` is the phone the BOOKKEEPING job runs on, not where anything is
 * posted: `add-group`, `start-group` and `retry-group` only write rows. The
 * screen picks an online phone itself rather than asking the operator, because
 * "which phone should the paperwork run on" is not a question the operator has
 * an answer to — it was the most confusing thing about the old dialogs.
 */
export async function runMember(scriptRef: string, params: Record<string, unknown>, hostDeviceId: string): Promise<void> {
  const res = await api(`${CORE}/api/actions/run-script`, RunScriptResult, {
    method: 'POST',
    body: { target: { deviceIds: [hostDeviceId] }, scriptRef, params },
  })
  const first = res.results[0]
  if (!first || (first.status !== 'done' && first.status !== 'accepted')) {
    throw new Error(`the farm refused to run ${scriptRef}: ${first ? first.status : 'no device answered'}`)
  }
}

/** A phone that can carry the bookkeeping job. Online is the only requirement. */
export function pickHost(devices: readonly Device[]): Device | null {
  return devices.find((d) => d.status === 'online') ?? null
}

/**
 * Upload one file, reporting progress.
 *
 * XHR rather than `fetch` for the one reason Studio's own Files screen uses
 * it: `fetch` cannot report upload progress, and forty videos with no progress
 * is a screen an operator cannot tell from a hung one.
 */
export function uploadVideo(file: File, onProgress: (fraction: number) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const form = new FormData()
    form.append('file', file)
    const xhr = new XMLHttpRequest()
    xhr.open('POST', `${CORE}/api/artifacts`)
    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total)
    })
    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const body = JSON.parse(xhr.responseText) as { artifact?: { id?: string }; id?: string }
          const id = body.artifact?.id ?? body.id
          if (typeof id === 'string') return resolve(id)
          return reject(new Error('the farm accepted the file but did not say what it stored'))
        } catch {
          return reject(new Error('the farm accepted the file but its answer could not be read'))
        }
      }
      let message = `upload failed (${xhr.status})`
      try {
        const body = JSON.parse(xhr.responseText) as { error?: { message?: string } }
        if (body.error?.message) message = body.error.message
      } catch {
        /* keep the status line */
      }
      reject(new Error(message))
    })
    xhr.addEventListener('error', () => reject(new Error('the upload could not reach the farm')))
    xhr.send(form)
  })
}

/** `Upload video sosmed Senin 14 Sep 2026` — the title a session gets unless the operator types their own. */
export function defaultSessionTitle(now: Date = new Date()): string {
  const days = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu']
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des']
  return `Upload video sosmed ${days[now.getDay()]} ${now.getDate()} ${months[now.getMonth()]} ${now.getFullYear()}`
}

/**
 * A caption from the file's own name: `senin-promo_01.mp4` → `senin promo 01`.
 *
 * The default, because forty videos named for their phone or their day already
 * carry the operator's meaning, and typing forty captions to say the same
 * thing is work nobody would do. Overridable per batch — the field is right
 * there — and never silently empty: a name that reduces to nothing keeps the
 * original.
 */
export function captionFromName(label: string | null): string {
  const base = (label ?? '').replace(/\.[^.]+$/, '')
  const words = base.replace(/[_\-.]+/g, ' ').replace(/\s+/g, ' ').trim()
  return words === '' ? (label ?? 'video') : words
}
