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

/** The largest page the farm's list endpoints hand out (`api/pagination.ts`, `MAX_LIMIT`). */
const PAGE_LIMIT = 200
/** A guard against a cursor that never ends — 100 pages of 200 is far beyond any farm this plugin serves. */
const MAX_PAGES = 100

/**
 * Every item of a paged farm list, following `nextCursor` to the end.
 *
 * `/api/devices` and `/api/artifacts` answer 50 rows by default and at most 200
 * per request. Reading only the first page capped the phone picker at 50 on a
 * farm with more phones (and the video list at 50 on a folder of 73), with
 * nothing on screen saying anything was missing.
 */
async function readAllPages<T extends z.ZodType>(path: string, item: T): Promise<z.infer<T>[]> {
  const PageSchema = z.object({ items: z.array(item), nextCursor: z.string().nullable().default(null) })
  const out: z.infer<T>[] = []
  let cursor: string | null = null
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = new URL(path, 'http://farm.local')
    url.searchParams.set('limit', String(PAGE_LIMIT))
    if (cursor !== null) url.searchParams.set('cursor', cursor)
    const res = await api(`${CORE}${url.pathname}${url.search}`, PageSchema)
    out.push(...res.items)
    cursor = res.nextCursor
    if (cursor === null) break
  }
  return out
}

/**
 * The uploads, newest first.
 *
 * Filtered to things that plausibly ARE videos: the farm stores apks and
 * probes in the same place, and a list that offers an apk as a video to post
 * is offering a mistake. `mimeType` is trusted when present and the file
 * extension is the fallback, because older uploads carry no type at all.
 */
export async function listVideos(): Promise<Artifact[]> {
  const items: Artifact[] = await readAllPages('/api/artifacts?kind=upload', ArtifactSchema)
  return items.filter((a) => isVideo(a)).sort((x, y) => y.createdAt - x.createdAt)
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

export async function listDevices(): Promise<Device[]> {
  return readAllPages('/api/devices', DeviceSchema)
}

/** `#7 Galaxy A15`, or the bare label — the same shape the rest of Studio names a phone by. */
export function deviceName(d: Device): string {
  const label = d.label?.trim() || d.id.slice(0, 8)
  return d.number === null ? label : `#${d.number} ${label}`
}

export const PLATFORMS = [
  { id: 'tiktok', title: 'TikTok', postable: true },
  { id: 'youtube', title: 'YouTube', postable: true },
  // Postable since 0.13.0 on the service side (`platforms.ts` routes it to `instagram/post-video`); this flag was left behind until 0.17.0.
  { id: 'instagram', title: 'Instagram', postable: true },
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
  /** Platform cells an operator turned off (0.45.0). Defaulted: a session counted before skips existed had none. */
  skipped: z.number().default(0),
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
  /**
   * The session's hashtags: `fixed` go on every video; `lines` are candidate sets (`#trading #gold`), and with
   * `randomLine` each video was given one of them at creation (its `hashtagLine`). Older rows carry none.
   */
  hashtags: z
    .object({ fixed: z.array(z.string()).default([]), lines: z.array(z.string()).default([]), randomLine: z.boolean().default(false) })
    .default({ fixed: [], lines: [], randomLine: false }),
  /**
   * The skip rules this session was CREATED with (0.45.0, the service's `excludes.ts`) — by device
   * group, by label, or by naming a phone. Read only to say what the session asked for: the skips
   * themselves live on the rows, where they can be undone one at a time.
   */
  excludes: z
    .object({
      devices: z.record(z.string(), z.array(z.string())).default({}),
      labels: z.array(z.object({ label: z.string(), platforms: z.array(z.string()) })).default([]),
      groups: z.array(z.object({ group: z.string(), platforms: z.array(z.string()) })).default([]),
    })
    .default({ devices: {}, labels: [], groups: [] }),
  progress: GroupProgressSchema.nullable().default(null),
  summary: z.string().nullable().default(null),
})
export type Group = z.infer<typeof GroupSchema>

/** Does this session carry any skip rule at all? What decides whether the page says anything about them. */
export function hasSkipRules(group: Group): boolean {
  return group.excludes.labels.length > 0 || group.excludes.groups.length > 0 || Object.keys(group.excludes.devices).length > 0
}

/** One hand mark on an attempt — `posts.ts` `AttemptResolutionSchema`, read loosely. */
const AttemptMarkSchema = z.object({
  action: z.string().nullable().default(null),
  from: z.string().nullable().default(null),
  to: z.string(),
  at: z.number(),
  byJobId: z.string().nullable().default(null),
  note: z.string().nullable().default(null),
  reason: z.string().nullable().default(null),
})

export const AttemptSchema = z.object({
  jobId: z.string(),
  deviceId: z.string(),
  deviceName: z.string().nullable().default(null),
  state: z.string(),
  error: z.string().nullable().default(null),
  /** Unix seconds the job was enqueued. Defaulted: rows written before 0.12.0 carry none. */
  at: z.number().nullable().default(null),
  /** Unix seconds the job reached an outcome; `null` while it is queued or running, and on older rows. */
  settledAt: z.number().nullable().default(null),
  /** Unix seconds its phone actually started the job (0.26.0); `null` while it waits behind another job, and on older rows. */
  startedAt: z.number().nullable().default(null),
  /** 1 = the first send on this platform, 2 = the first retry, … Older rows are all first sends. */
  round: z.number().default(1),
  /**
   * Every hand mark on this attempt, oldest first (`smm/resolve-attempt`): which action, what it was (`null` for a
   * manual attempt), what it became, when, the job that wrote it, the note, and the error or reason it replaced. One
   * object before 0.23.0, read as a list of one; empty when nobody marked it.
   */
  resolution: z
    .union([AttemptMarkSchema, z.array(AttemptMarkSchema)])
    .nullable()
    .default(null)
    .transform((value) => (value === null ? [] : Array.isArray(value) ? value : [value])),
  /** `true` on an attempt no phone of the farm ran — an operator posted it by hand and marked it (0.23.0). */
  manual: z.boolean().default(false),
})

/** The job id a manual attempt carries (`posts.ts` `MANUAL_JOB_PREFIX`): there is no run behind it to link to. */
export const MANUAL_JOB_PREFIX = 'manual:'

export const PostSchema = z.object({
  version: z.literal(1),
  videoArtifactId: z.string(),
  /** May be empty: a video with no speech has no caption until someone writes one (the router holds a row with neither caption nor hashtags). */
  caption: z.string().max(2200),
  /** The video's OWN hashtags, each `#tag` — AI-written or typed. Older rows carry none. */
  hashtags: z.array(z.string()).default([]),
  /** Which of the session's hashtag lines this video was given, when the session picks one at random. */
  hashtagLine: z.number().nullable().default(null),
  /** A text per platform, posted there instead of the caption and hashtags (0.27.0). Older rows carry none. */
  platformCaptions: z
    .object({ tiktok: z.string().optional(), instagram: z.string().optional(), youtube: z.string().optional() })
    .catch({})
    .default({}),
  platforms: z.array(z.string()),
  groupId: z.string().nullable().default(null),
  notBeforeAt: z.number().nullable().default(null),
  /**
   * The ONE phone this video goes out from in a one-per-phone session, for every platform and
   * every retry. `null` in an every-phone session, when no phone was left to bind, and on rows
   * written before the binding existed.
   */
  assignedDeviceId: z.string().nullable().default(null),
  /** The phones chosen for this video, or empty for "any phone carrying the platform label". */
  deviceIds: z.array(z.string()).default([]),
  /** Phones per platform this row may go to. `1` is a one-per-phone row — the only kind whose phone can be edited. */
  maxDevices: z.number().nullable().default(null),
  createdAt: z.number(),
  dispatch: z.record(
    z.string(),
    z.object({
      state: z.string(),
      /** When this platform was last dispatched. */
      at: z.number().nullable().default(null),
      deviceCount: z.number().default(0),
      /** The CURRENT attempts — what `state` is computed from. */
      attempts: z.array(AttemptSchema).default([]),
      /** Earlier attempts a retry replaced, oldest first. Never the current state; older rows have none. */
      history: z.array(AttemptSchema).default([]),
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

// ---------------------------------------------------------------------------
// The accounts each phone is signed in to (0.37.0)
// ---------------------------------------------------------------------------

/** One account an app holds. TikTok keeps several in one install, in the order its switcher lists them. */
export const AccountSchema = z.object({
  username: z.string(),
  displayName: z.string().nullable().default(null),
  /** The platform's own id for the account, when the app shows one. Handles are renamed; this is not. */
  accountId: z.string().nullable().default(null),
  /** Its position in the app's own account list, from 0. */
  slot: z.number(),
  /** `true` on the ONE the app was standing in when the read finished. */
  current: z.boolean(),
})
export type Account = z.infer<typeof AccountSchema>

/**
 * What `smm/sync-accounts` stores: one row per phone and platform, under
 * `account:<platform>:<deviceId>`.
 *
 * `evidence` is how sure the row is that the account marked `current` really is
 * the one signed in: `confirmed` was read from the app itself, `moved` means the
 * account changed while the read was under way, `assumed` is the switcher's own
 * first entry with nothing confirming it, and `none` established nothing. The
 * screen says which — a handle shown as fact when the phone only guessed is how
 * a video ends up on somebody else's account.
 */
export const AccountRowSchema = z.object({
  version: z.literal(1),
  platform: z.enum(['tiktok', 'youtube', 'instagram']),
  deviceId: z.string(),
  deviceName: z.string().nullable().default(null),
  accounts: z.array(AccountSchema).default([]),
  /** Unix seconds the read finished. */
  readAt: z.number(),
  evidence: z.enum(['confirmed', 'moved', 'assumed', 'none']).default('none'),
  error: z.string().nullable().default(null),
})
export type AccountRow = z.infer<typeof AccountRowSchema>

export const ACCOUNT_PREFIX = 'account:'

/** The key a row is stored under — `account:tiktok:<deviceId>`. Also this screen's React key for it. */
export function accountRowKeyOf(row: AccountRow): string {
  return `${ACCOUNT_PREFIX}${row.platform}:${row.deviceId}`
}

/** Every stored account row. A row this build cannot parse is skipped, never shown half-read. */
export async function listAccountRows(): Promise<AccountRow[]> {
  const rows = await readAll(ACCOUNT_PREFIX)
  const out: AccountRow[] = []
  for (const row of rows) {
    const parsed = AccountRowSchema.safeParse(row.value)
    if (parsed.success) out.push(parsed.data)
  }
  return out
}

const RunScriptResult = z.object({
  results: z.array(z.object({ deviceId: z.string(), status: z.string(), jobId: z.string().nullable().default(null), message: z.string().nullable().default(null) })),
})

const JobStateSchema = z.object({
  job: z.object({
    jobId: z.string(),
    status: z.enum(['queued', 'running', 'success', 'failed', 'cancelled', 'expired']),
    error: z.string().nullable().default(null),
    runId: z.string().nullable().default(null),
  }),
})

const RunResultSchema = z.object({ run: z.object({ result: z.unknown().nullable().default(null) }) })

/** How long a bookkeeping member may take before the screen stops waiting. They write KV rows; forty of them is seconds. */
const MEMBER_TIMEOUT_MS = 120_000
const MEMBER_POLL_MS = 500
/** How many other online phones a refused bookkeeping job is offered to before the page gives up. */
const MEMBER_HOST_FALLBACKS = 3

/**
 * Run one of this plugin's own members, and WAIT for what it did.
 *
 * `deviceId` is the phone the BOOKKEEPING job runs on, not where anything is
 * posted: `add-group`, `start-group` and `retry-group` only write rows. The
 * screen picks an online phone itself rather than asking the operator, because
 * "which phone should the paperwork run on" is not a question the operator has
 * an answer to — it was the most confusing thing about the old dialogs.
 *
 * ## Why it waits instead of returning at "accepted"
 *
 * `run-script` answers as soon as the job is ENQUEUED, so a member that then
 * refuses — forty videos and seven caption lines, a group id that no longer
 * exists — would leave the screen saying "session created" with nothing
 * created. Waiting for the job's own terminal status is what lets the refusal
 * reach the operator in the words the member wrote it in.
 *
 * With a schema, the member's own result is read off its run, so a caller that
 * needs the new group's id has it as fact rather than by searching for a row
 * that looks like the one it just asked for.
 */
export async function runMember<S extends z.ZodType>(
  scriptRef: string,
  params: Record<string, unknown>,
  hostDeviceId: string,
  resultSchema?: S,
): Promise<z.infer<S> | null> {
  const enqueue = async (deviceId: string) => {
    const res = await api(`${CORE}/api/actions/run-script`, RunScriptResult, {
      method: 'POST',
      // `json`, not `body`: the helper serialises and sets the content type. A
      // plain `body` object is spread straight into `fetch` and arrives as
      // "[object Object]" with no content type, which every member run refuses.
      json: { target: { deviceIds: [deviceId] }, scriptRef, params },
    })
    return res.results[0]
  }
  /*
    Another phone when the one picked is refused (0.29.1). The page picks its host from the device list it loaded when it
    opened; on the owner's production farm (2026-09-15) that phone had gone offline by the time Create was pressed — the
    fleet was reconnecting after a core upgrade — and "The farm did not run smm/add-group@latest: offline" stopped the
    session while dozens of phones were online. A refusal enqueues nothing, so trying another phone can never write twice.
  */
  let first = await enqueue(hostDeviceId)
  const tried = new Set([hostDeviceId])
  if (!first || first.jobId === null) {
    const online = (await listDevices().catch(() => [] as Device[])).filter((d) => d.status === 'online' && !tried.has(d.id))
    for (const next of online.slice(0, MEMBER_HOST_FALLBACKS)) {
      tried.add(next.id)
      const answer = await enqueue(next.id)
      if (answer && answer.jobId !== null) {
        first = answer
        break
      }
    }
  }
  if (!first || first.jobId === null) {
    throw new Error(
      `The farm did not run ${scriptRef}: ${first?.message ?? first?.status ?? 'no phone answered'} (tried ${tried.size} phone${tried.size === 1 ? '' : 's'}). Nothing was written.`,
    )
  }

  const deadline = Date.now() + MEMBER_TIMEOUT_MS
  for (;;) {
    const state = await api(`${CORE}/api/jobs/${encodeURIComponent(first.jobId)}`, JobStateSchema)
    const job = state.job
    if (job.status === 'success') {
      if (!resultSchema || job.runId === null) return null
      const run = await api(`${CORE}/api/jobs/${encodeURIComponent(job.jobId)}/runs/${encodeURIComponent(job.runId)}`, RunResultSchema)
      const parsed = resultSchema.safeParse(run.run.result)
      // A result this screen cannot read is not a failure of the RUN — the
      // rows are written either way — so the caller is told "done, but I
      // cannot tell you what it said" rather than "it failed".
      return parsed.success ? parsed.data : null
    }
    if (job.status !== 'queued' && job.status !== 'running') {
      throw new Error(job.error ?? `The job ${job.status === 'failed' ? 'failed' : `was ${job.status}`} without saying why.`)
    }
    if (Date.now() > deadline) {
      throw new Error('The farm is still working on it. Nothing is lost — press Refresh in a moment to see whether it landed.')
    }
    await new Promise((resolve) => setTimeout(resolve, MEMBER_POLL_MS))
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
  return uploadArtifact(file, onProgress)
}

/** The same multipart upload for any file — the auto-caption pipeline stores its speech WAV through it. */
export function uploadArtifact(file: File, onProgress: (fraction: number) => void = () => {}): Promise<string> {
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

// ---------------------------------------------------------------------------
// Hashtags — the service's own normalisation, repeated so a preview matches what is posted
// ---------------------------------------------------------------------------

/** The limit the upload flows enforce on the whole posted text. */
export const POST_TEXT_MAX = 2200

/** `trading`, `#Gold,` → `#trading`, `#Gold`: no spaces, one `#`, duplicates (ignoring case) dropped. */
export function normaliseHashtags(tokens: readonly string[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of tokens) {
    const bare = raw.trim().replace(/^#+/, '').replace(/[\s,;#]+/g, '')
    if (bare === '') continue
    const key = bare.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(`#${bare}`)
  }
  return out
}

/** Hashtags typed as free text — spaces, commas or new lines between them, `#` optional. */
export function parseHashtags(text: string): string[] {
  return normaliseHashtags(text.split(/[\s,;]+/))
}

export function hashtagText(tags: readonly string[]): string {
  return tags.join(' ')
}

/** The session line this video was given, as tags — empty when the session picks none or the index is stale. */
export function lineTagsOf(group: Group | null, post: Post): string[] {
  if (group === null || post.hashtagLine === null) return []
  const line = group.hashtags.lines[post.hashtagLine]
  return line === undefined ? [] : parseHashtags(line)
}

/** Every hashtag a video posts with: the session's fixed ones, its picked line, then its own — deduplicated. */
export function composedHashtags(fixed: readonly string[], line: readonly string[], own: readonly string[]): string[] {
  return normaliseHashtags([...fixed, ...line, ...own])
}

/**
 * What is actually typed into the platform: the caption, a blank line, the hashtags. Past the limit, hashtags are
 * dropped from the END — the caption is the operator's words and is never the thing cut.
 */
export function postedText(caption: string, tags: readonly string[]): string {
  const body = caption.trim()
  const kept = [...tags]
  const join = (): string => (kept.length === 0 ? body : body === '' ? kept.join(' ') : `${body}\n\n${kept.join(' ')}`)
  let text = join()
  while (text.length > POST_TEXT_MAX && kept.length > 0) {
    kept.pop()
    text = join()
  }
  return text
}
