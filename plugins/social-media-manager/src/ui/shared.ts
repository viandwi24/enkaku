import { api } from '@enkaku/ui'
import { z } from 'zod'
import { POST_RUN, STOP_PREFIX, resumeWarmupRow, stopKey, stopMarkerOf, stopPostRow, stoppedRunOf, stopWarmupRow, type StopMarker } from '../session-control'
import { retryFailedSteps, withRunSummary } from '../warmup-rows'

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

/**
 * A session, as the browser sees it — LOOSE, and for the reason
 * `WarmupStepSchema` spells out: this file mirrors schemas the service owns,
 * and the browser WRITES these rows.
 *
 * It was strict and already two fields behind — `target` (which phones the
 * session covers) and `lastRunAt` (the dedupe stamp a schedule reads). So a
 * Stop would have written the session back without either: the next run would
 * have reached a fleet nobody chose, and a scheduled warm-up would have lost
 * its guard against starting eighty times over. Unfired, and only because
 * nobody had pressed Stop on a targeted session yet.
 */
export const GroupSchema = z.looseObject({
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
  /**
   * Which KIND of session this is (plan 900 D4). Defaulted to `post`, which is
   * what every session stored before warm-up existed is — and the reason it is
   * defaulted rather than required is that a row failing to parse is SKIPPED by
   * every reader here, so a required discriminator would have emptied this list
   * on upgrade with nothing on screen saying why.
   */
  kind: z.enum(['post', 'warmup']).default('post'),
  /** Stopped by the operator (0.57.0): the router sends nothing for it until it is started again. */
  stopped: z.boolean().default(false),
  /** A warm-up session's settings; `null` on a post session. */
  warmup: z
    /*
      Loose (0.64.0): the page writes a group row back whole (Start clears `stopped`), and a plain
      object here dropped every setting it did not name — `sequenceMode`, `like.commentChance`,
      and now `maxParallel` — so a Start quietly reset them to the service's defaults.
    */
    .looseObject({
      keywords: z.array(z.string()).default([]),
      amount: z.number().default(1),
      gapSec: z.tuple([z.number(), z.number()]).default([8, 20]),
      startJitterSec: z.number().default(120),
      slot: z.number().default(0),
      phases: z.number().default(1),
      like: z.looseObject({ chance: z.number().default(0.1), keywordBoost: z.number().default(3) }).default({ chance: 0.1, keywordBoost: 3 }),
      styleWeights: z.record(z.string(), z.number()).default({}),
      /** How many phones of a run warm up at once (0.64.0). */
      maxParallel: z.number().default(8),
      startGapSec: z.tuple([z.number(), z.number()]).default([20, 60]),
    })
    .nullable()
    .default(null),
  progress: GroupProgressSchema.nullable().default(null),
  summary: z.string().nullable().default(null),
})
export type Group = z.infer<typeof GroupSchema>

/** A warm-up session is one an operator reaches from the Warm-up menu, never from Social posts. */
export function isWarmupGroup(group: Group): boolean {
  return group.kind === 'warmup'
}

/**
 * The browser's view of a step — LOOSE on purpose.
 *
 * This file mirrors schemas the service owns, and since 0.59.0 the browser
 * WRITES these rows too (Stop, Start again, Retry). A strict mirror drops
 * every field it does not model, so those writes silently destroyed `params`
 * and `sequence`: the next dispatch of a retried activity was refused by the
 * farm with `query: required`, the step stayed pending, and the phone's whole
 * warm-up stalled behind it with nothing on screen to say why (owner's farm,
 * 2026-09-21).
 *
 * `looseObject` is the structural answer rather than "add the two missing
 * fields". A mirror that has to be kept in step by hand will fall out of step
 * again the first time the service gains a field, and it will fail the same
 * silent way. Unknown keys now survive the round trip untouched, which is what
 * a mirror should do.
 */
export const WarmupStepSchema = z.looseObject({
  activityId: z.string(),
  title: z.string(),
  script: z.string(),
  atSec: z.number(),
  notBeforeAt: z.number(),
  state: z.enum(['pending', 'queued', 'success', 'failed', 'skipped']).default('pending'),
  jobId: z.string().nullable().default(null),
  error: z.string().nullable().default(null),
  startedAt: z.number().nullable().default(null),
  settledAt: z.number().nullable().default(null),
})
export type WarmupStep = z.infer<typeof WarmupStepSchema>

/** The same, and loose for the same reason — see `WarmupStepSchema`. */
export const WarmupRowSchema = z.looseObject({
  version: z.literal(1),
  groupId: z.string(),
  /** Which run of the session this row belongs to; a row written before runs existed reads as the first. */
  runId: z.string().default('r-first'),
  /** This run is stopped — the router sends nothing for it. Per run, because stopping a definition is meaningless. */
  stopped: z.boolean().default(false),
  deviceId: z.string(),
  deviceName: z.string().nullable().default(null),
  phase: z.number().default(0),
  platform: z.string().nullable(),
  styleId: z.string().nullable().default(null),
  styleTitle: z.string().nullable().default(null),
  note: z.string().nullable().default(null),
  steps: z.array(WarmupStepSchema),
  state: z.enum(['pending', 'running', 'done', 'partial', 'failed', 'skipped']).default('pending'),
  summary: z.string().nullable().default(null),
})
export type WarmupRow = z.infer<typeof WarmupRowSchema>

/**
 * Every phone's row in one warm-up session, ordered by phase and then by the
 * phone's own name — so a fleet of eighty reads as a list somebody can scan
 * rather than in whatever order the store happened to answer.
 */
export async function listWarmupRows(groupId: string): Promise<WarmupRow[]> {
  const rows = await readAll(`warmup:${groupId}:`)
  const runs: WarmupRow[] = []
  for (const row of rows) {
    const parsed = WarmupRowSchema.safeParse(row.value)
    if (parsed.success) runs.push(parsed.data)
  }
  return runs.sort((a, b) => a.phase - b.phase || (a.deviceName ?? a.deviceId).localeCompare(b.deviceName ?? b.deviceId))
}

/**
 * Start an existing warm-up again — a new RUN, through the member that plans
 * it.
 *
 * A member and not a browser write, unlike Stop: planning reads the fleet and
 * writes a row per phone per phase, and — the reason that settles it — a
 * SCHEDULE has to be able to do this, and a schedule can only run a script.
 */
export async function runWarmupAgain(groupId: string, hostDeviceId: string): Promise<void> {
  await runMember('smm/run-warmup@latest', { groupId, dedupeMinutes: 0, startNow: false }, hostDeviceId)
}

/** A response whose body this caller has no use for. */
const Ignored = z.unknown()

/**
 * Write one entry into this plugin's own KV, as the operator.
 *
 * `PUT /api/plugins/smm/data/entry` needs `plugin.data` and forces the
 * namespace to the path's — there is no request shape that reaches another
 * plugin's rows. Remove has always written this way; stopping now does too.
 */
async function writeEntry(key: string, value: unknown): Promise<void> {
  await api(`${CORE}/api/plugins/smm/data/entry`, Ignored, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ scope: 'global', key, value }),
  })
}

async function deleteEntry(key: string): Promise<void> {
  await api(`${CORE}/api/plugins/smm/data/entry?scope=global&key=${encodeURIComponent(key)}`, Ignored, { method: 'DELETE' })
}

/**
 * A stopped warm-up RUN, recorded in one key of its own (0.62.0).
 *
 * Stopping a run used to mean writing `stopped: true` onto every one of its rows, one request at a
 * time, and the router reading those flags. That is not a stop, it is two hundred and nineteen of
 * them, and any one failing left the rest unwritten: on the owner's production farm (2026-09-21) a
 * Stop pressed at 11:41 wrote the first 90 rows in key order and got no further — phase 0 stopped
 * for every phone, phase 1 for 17 of 73, phase 2 for none — so thirty-nine connected phones sat idle
 * while the page offered "Start", and phases 1 and 2 were set to go out on their own later behind a
 * session everyone had watched being stopped.
 *
 * This key is the stop. It is written FIRST, in one request, and the router honours it for every
 * row of the run; the per-row loop after it only pulls back jobs already out and tidies the rows.
 * It lives in a key of its own, never on the group row, because the router rewrites the group row
 * every tick (its summary) by read-modify-write, and a flag written between that read and that write
 * would be silently undone.
 */
/** Every stopped run on the farm, as `groupId:runId`. */
export async function listStopMarkers(): Promise<Set<string>> {
  return new Set((await listStopMarkerInfo()).keys())
}

/**
 * The same, with what each marker says (0.63.0): who stopped the run, and — for a pause the router
 * made on its own because every phone with work left was offline — why. A post session's marker is
 * `groupId:post` (`POST_RUN`).
 */
export async function listStopMarkerInfo(): Promise<Map<string, StopMarker>> {
  const out = new Map<string, StopMarker>()
  for (const entry of await readAll(STOP_PREFIX)) {
    const run = stoppedRunOf(entry.key)
    if (run !== null) out.set(run, stopMarkerOf(entry.value))
  }
  return out
}

/** Pure: a post session's own marker, from markers already in hand. */
export function postStopMarker(markers: ReadonlyMap<string, StopMarker>, groupId: string): StopMarker | null {
  return markers.get(`${groupId}:${POST_RUN}`) ?? null
}

/**
 * One offset per PHONE for a Start, inside the session's start jitter (0.63.0).
 *
 * The same phone gets the same offset for every row of the run, so its phases keep their order and
 * their gaps; different phones get different ones, so a run started again after a pause does not have
 * every phone due in the same tick. Exported so the rule can be read, not tested: `random` is passed
 * in for that reason.
 */
export function startOffsets(deviceIds: readonly string[], jitterSec: number, random: () => number = Math.random): Map<string, number> {
  const out = new Map<string, number>()
  for (const id of deviceIds) if (!out.has(id)) out.set(id, Math.floor(random() * (Math.max(0, jitterSec) + 1)))
  return out
}

/**
 * Stop a session, or start it again — from the BROWSER, with no job at all.
 *
 * ## Why this is not a member
 *
 * It was one, for exactly as long as it took the owner to ask the obvious
 * question: *"masa mau stop atau start harus jalanin jobs terpisah dulu, ini
 * buat apa?"* A member runs on a device, so stopping a runaway session needed
 * a phone to be online — the one condition you cannot count on at the moment
 * you most want to stop everything, and the one thing stopping has no use for.
 *
 * Every door this needs is already open to the operator in the browser: the
 * plugin's own KV (`PUT /api/plugins/smm/data/entry`, which Remove has always
 * used) and the farm's own `POST /api/jobs/:id/cancel`. Nothing here needs the
 * plugin's permissions, which is why `job.cancel` is NOT in them — cancelling
 * happens as the operator, on jobs this session's own rows name.
 *
 * `add-warmup` stays a member, and the difference is worth stating because the
 * question applies to it too: a SCHEDULE can only run a script. A warm-up that
 * fires every night has to be one. Stopping is never scheduled.
 *
 * ## What it does, in order
 *
 * The flag first, so a half-done stop leaves a session that sends nothing
 * rather than one that cancelled its work and carried on. Then the rows, each
 * pulled back by `session-control.ts`, and each cancelled job named by those
 * rows. Failures to cancel are counted, not thrown: a job that finished a
 * second ago refuses, and the row is owed again either way.
 */
export async function setSessionStopped(
  group: Group,
  action: 'stop' | 'start' | 'pause',
  runId?: string,
): Promise<{ cancelled: number; couldNotCancel: number; pulled: number; failed: number }> {
  const stop = action === 'stop'
  const now = Math.floor(Date.now() / 1000)

  /*
    PAUSE (0.64.0): the marker and nothing else. The router lets nothing new out of the run's queue
    and sends nothing more, and every activity already on a phone is left to finish — nothing is
    cancelled and no row is touched. Stop is the one that pulls work back.
  */
  if (action === 'pause' && group.kind === 'warmup') {
    const rows = (await readAll(`warmup:${group.id}:`))
      .map((row) => WarmupRowSchema.safeParse(row.value))
      .filter((parsed) => parsed.success)
      .map((parsed) => parsed.data as WarmupRow)
    const target = runId ?? newestRunId(rows)
    if (target !== null) await writeEntry(stopKey(group.id, target), { version: 1, at: now, by: 'operator', reason: '' } satisfies StopMarker)
    return { cancelled: 0, couldNotCancel: 0, pulled: 0, failed: 0 }
  }

  let cancelled = 0
  let couldNotCancel = 0
  let pulled = 0

  const cancelJobs = async (jobIds: readonly string[]): Promise<void> => {
    for (const jobId of jobIds) {
      try {
        await api(`${CORE}/api/jobs/${encodeURIComponent(jobId)}/cancel`, Ignored, { method: 'POST' })
        cancelled += 1
      } catch {
        couldNotCancel += 1
      }
    }
  }

  if (group.kind === 'warmup') {
    /*
      Stopping is a thing you do to a RUN (0.59.0). A session is a definition,
      and stopping a definition is meaningless — what an operator wants stopped
      is tonight's pass, while last night's history stays exactly as it was.
      `runId` names which; the session list passes the newest, which is what
      somebody pressing Stop there means.
    */
    const rows = await readAll(`warmup:${group.id}:`)
    const parsed = rows.map((row) => ({ key: row.key, parsed: WarmupRowSchema.safeParse(row.value) })).filter((entry) => entry.parsed.success)
    const target = runId ?? newestRunId(parsed.map((entry) => entry.parsed.data as WarmupRow))
    if (target === null) return { cancelled, couldNotCancel, pulled, failed: 0 }

    /*
      STOP: the marker first. One request, and from the router's next tick no row of this run goes
      out, whatever happens to the loop below. See `stopKey`.
    */
    if (stop) await writeEntry(stopKey(group.id, target), { version: 1, at: now, by: 'operator', reason: '' } satisfies StopMarker)
    const offsets = stop
      ? new Map<string, number>()
      : startOffsets(
          parsed.map((entry) => entry.parsed.data as WarmupRow).filter((row) => row.runId === target).map((row) => row.deviceId),
          group.warmup?.startJitterSec ?? 120,
        )

    /*
      Then every row, and a row that cannot be written does not stop the others. This loop used to
      `await` each write with nothing around it, so the first failure abandoned every row after it.
      A failure is counted and reported instead; the stop itself no longer depends on this loop.
    */
    let failed = 0
    for (const entry of parsed) {
      const row = entry.parsed.data as WarmupRow
      if (row.runId !== target) continue
      try {
        const next = stop ? stopWarmupRow(row, now) : { row: resumeWarmupRow(row, now, offsets.get(row.deviceId) ?? 0), cancel: [] as string[], pulled: 0 }
        pulled += next.pulled
        await cancelJobs(next.cancel)
        /* The flag is still written onto the row: the page reads it, and a farm on an older router honours it. */
        await writeEntry(entry.key, { ...withRunSummary(next.row), stopped: stop })
      } catch {
        failed += 1
      }
    }

    /*
      START: the marker comes off LAST, and only when every row was re-timed. A row that could not
      be written would otherwise go out on its old schedule the moment the marker lifted; leaving the
      marker on keeps the whole run stopped, which is the safe way to fail, and pressing Start again
      finishes the job.

      The session's own legacy flag is cleared on a start, never set on a stop. It is the older
      whole-session switch, and leaving it on after somebody started a run would make the run sit
      there sending nothing with no control on screen that explains why.
    */
    if (!stop && failed === 0) {
      await deleteEntry(stopKey(group.id, target))
      if (group.stopped) await writeEntry(`group:${group.id}`, { ...group, stopped: false })
    }
    return { cancelled, couldNotCancel, pulled, failed }
  }

  /*
    A post session has no runs: the session IS the execution. Its stop is the marker
    `stop:<groupId>:post` (0.63.0), for the same two reasons a warm-up's is — one request, and a key
    the router's per-tick rewrite of the group row cannot undo — and it is the same marker the router
    writes when it pauses the session itself. The group's own flag is still written, for a farm whose
    router is older than the marker.
  */
  if (stop) {
    await writeEntry(stopKey(group.id, POST_RUN), { version: 1, at: now, by: 'operator', reason: '' } satisfies StopMarker)
    await writeEntry(`group:${group.id}`, { ...group, stopped: true })
    for (const row of await readAll('post:')) {
      const parsed = PostSchema.safeParse(row.value)
      if (!parsed.success || parsed.data.groupId !== group.id) continue
      const next = stopPostRow(parsed.data, now)
      if (next.row === parsed.data) continue
      pulled += next.pulled
      await cancelJobs(next.cancel)
      await writeEntry(row.key, next.row)
    }
    return { cancelled, couldNotCancel, pulled, failed: 0 }
  }

  /*
    START. Nothing is pulled back — the rows keep the turns `start-group` stamped. What IS reset is
    each waiting platform's `waitingSince`: the clock both the 45-minute give-up and the automatic
    pause read. A session paused because its phones were offline would otherwise come back already
    "offline for an hour" and fail every row on the first tick. Then the flags come off, marker last,
    and only when every row was written — the warm-up's rule, for the warm-up's reason.
  */
  let failed = 0
  for (const row of await readAll('post:')) {
    const parsed = PostSchema.safeParse(row.value)
    if (!parsed.success || parsed.data.groupId !== group.id) continue
    let changed = false
    const dispatch = { ...parsed.data.dispatch }
    for (const [platform, state] of Object.entries(dispatch)) {
      if (state?.state !== 'pending' || state.waitingSince == null) continue
      dispatch[platform] = { ...state, waitingSince: null }
      changed = true
    }
    if (!changed) continue
    try {
      await writeEntry(row.key, { ...parsed.data, dispatch })
    } catch {
      failed += 1
    }
  }
  if (failed === 0) {
    if (group.stopped) await writeEntry(`group:${group.id}`, { ...group, stopped: false })
    await deleteEntry(stopKey(group.id, POST_RUN))
  }
  return { cancelled, couldNotCancel, pulled, failed }
}

/**
 * Which warm-up sessions have a STOPPED newest run, for the list's Stop
 * button.
 *
 * One read of every warm-up row, rather than one per session: a farm with
 * forty sessions would otherwise make forty prefix scans to draw one list.
 */
/**
 * When the router last completed a pass, or `null` if it never has.
 *
 * The screens show this because a router that stops is otherwise invisible:
 * every session reads healthy, every phone is idle, and nothing happens. See
 * `ROUTER_HEARTBEAT_KEY` in the service.
 */
export async function routerHeartbeat(): Promise<number | null> {
  try {
    for (const row of await readAll('state:router-last-tick')) {
      if (typeof row.value === 'number') return row.value
    }
    return null
  } catch {
    return null
  }
}

export async function listAllWarmupRows(): Promise<WarmupRow[]> {
  const out: WarmupRow[] = []
  for (const row of await readAll('warmup:')) {
    const parsed = WarmupRowSchema.safeParse(row.value)
    if (parsed.success) out.push(parsed.data)
  }
  return out
}

/** Pure: which sessions have a stopped newest run, from rows already in hand. */
export function stoppedNewestFrom(rows: readonly WarmupRow[], markers: ReadonlySet<string> = new Set()): Set<string> {
  const byGroup = new Map<string, WarmupRow[]>()
  for (const row of rows) {
    const list = byGroup.get(row.groupId)
    if (list) list.push(row)
    else byGroup.set(row.groupId, [row])
  }

  const out = new Set<string>()
  for (const [groupId, own] of byGroup) {
    const newest = newestRunId(own)
    if (newest === null) continue
    if (markers.has(`${groupId}:${newest}`) || own.some((row) => row.runId === newest && row.stopped)) out.add(groupId)
  }
  return out
}

/** The run an operator means when they press a control that names no run: the one that started last. */
export function newestRunId(rows: readonly WarmupRow[]): string | null {
  let best: { runId: string; at: number } | null = null
  for (const row of rows) {
    const at = Math.min(...row.steps.map((step) => step.notBeforeAt), Number.POSITIVE_INFINITY)
    const seen = Number.isFinite(at) ? at : 0
    if (best === null || seen > best.at || (seen === best.at && row.runId > best.runId)) best = { runId: row.runId, at: seen }
  }
  return best?.runId ?? null
}

/**
 * Re-queue everything in one run that failed or never ran.
 *
 * Per RUN and not per session, for the reason the stop flag moved: last
 * night's failures are history, and a Retry that swept them up with tonight's
 * would re-run a phone's whole week.
 */
export async function retryWarmupRun(groupId: string, runId: string): Promise<number> {
  const now = Math.floor(Date.now() / 1000)
  let requeued = 0
  const rows = (await readAll(`warmup:${groupId}:`))
    .map((row) => ({ key: row.key, parsed: WarmupRowSchema.safeParse(row.value) }))
    .filter((entry) => entry.parsed.success && (entry.parsed.data as WarmupRow).runId === runId)
    .map((entry) => ({ key: entry.key, row: entry.parsed.data as WarmupRow }))
  /*
    A retried row goes to the BACK of its run's queue (0.64.0): it is let out again in turn, under the
    run's cap, like any other waiting phone — never all at once the moment Retry is pressed.
  */
  let seq = Math.max(-1, ...rows.map((entry) => (typeof entry.row.queueSeq === 'number' ? entry.row.queueSeq : -1)))
  for (const { key, row } of rows) {
    const again = retryFailedSteps(row, now)
    if (again === null) continue
    requeued += again.steps.filter((step) => step.state === 'pending').length - row.steps.filter((step) => step.state === 'pending').length
    seq += 1
    /* Recomputed here, not left to the router: it only writes a row it CHANGES, so a stale `failed` would sit on screen until the activity was dispatched. */
    await writeEntry(key, { ...withRunSummary(again), stopped: false, queueSeq: seq, admittedAt: null })
  }
  return requeued
}

/**
 * Delete one run of a session — its rows and nothing else.
 *
 * The session survives, and so do its other runs. Deleting the SESSION is a
 * different button with a different warning, and conflating them would make
 * "remove this night" able to throw away a month.
 */
export async function deleteWarmupRun(groupId: string, runId: string): Promise<number> {
  let removed = 0
  for (const row of await readAll(`warmup:${groupId}:`)) {
    const parsed = WarmupRowSchema.safeParse(row.value)
    if (!parsed.success || parsed.data.runId !== runId) continue
    await api(`${CORE}/api/plugins/smm/data/entry?scope=global&key=${encodeURIComponent(row.key)}`, Ignored, { method: 'DELETE' })
    removed += 1
  }
  // A deleted run's stop marker would otherwise outlive it, naming a run nothing can show any more.
  await deleteEntry(stopKey(groupId, runId)).catch(() => {})
  return removed
}

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

/** Loose: it rides inside `PostSchema`, which the browser writes. */
export const AttemptSchema = z.looseObject({
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

/** Loose, like the rest of the mirrors this file keeps — see `WarmupStepSchema`. The Posts Stop writes these rows back. */
export const PostSchema = z.looseObject({
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
    /*
      Loose, like the row itself (0.63.0). This was a plain object, so every write the page made from a
      parsed row — Stop's pull-back among them — silently dropped whatever the router keeps here that
      this schema did not name, `waitingSince` included.
    */
    z.looseObject({
      state: z.string(),
      /** When the router first found this platform unable to go. Start clears it (`setSessionStopped`). */
      waitingSince: z.number().nullable().optional(),
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
/**
 * A session as the page lists it: the stored row, plus the marker a POST session is stopped by
 * (0.63.0). `stopped` is folded in from that marker, so every control that already reads
 * `group.stopped` sees a session the router paused on its own the same way it sees one an operator
 * stopped; `pause` carries who and why, for the one line that says so.
 */
export type ListedGroup = Group & { pause: StopMarker | null }

/** The router's own pause on a listed session, or `null` — for a component typed with the plain `Group`. */
export function autoPauseOf(group: Group): StopMarker | null {
  const pause = (group as Partial<ListedGroup>).pause ?? null
  return pause !== null && pause.by === 'auto' ? pause : null
}

export async function listGroups(): Promise<ListedGroup[]> {
  const [rows, markers] = await Promise.all([readAll('group:'), listStopMarkerInfo().catch(() => new Map<string, StopMarker>())])
  const groups: ListedGroup[] = []
  for (const row of rows) {
    const parsed = GroupSchema.safeParse(row.value)
    if (!parsed.success) continue
    const pause = parsed.data.kind === 'warmup' ? null : postStopMarker(markers, parsed.data.id)
    groups.push({ ...parsed.data, stopped: parsed.data.stopped || pause !== null, pause })
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

/* ── The recap (0.60.0) ────────────────────────────────────────────────── */

export const RECAP_PREFIX = 'recap:'

/**
 * The browser's mirror of a recap row.
 *
 * `looseObject`, like every other mirror on this page, and here the reason is
 * not hypothetical: a recap row carries a `history` array per video that this
 * screen only reads. The Retry button on the warm-up tab once destroyed
 * `params` and `sequence` on every row it touched because its mirror was
 * strict, and `Forget` below writes nothing — but the next control that does
 * would inherit the same trap.
 */
export const RecapVideoSchema = z.looseObject({
  key: z.string(),
  title: z.string().default(''),
  views: z.number().default(0),
  viewsText: z.string().default(''),
  approx: z.boolean().default(false),
  rank: z.number().nullable().default(null),
  lastRank: z.number().nullable().default(null),
  firstSeenAt: z.number().default(0),
  lastSeenAt: z.number().default(0),
  history: z.array(z.looseObject({ at: z.number(), views: z.number() })).default([]),
})
export type RecapVideo = z.infer<typeof RecapVideoSchema>

export const RecapRowSchema = z.looseObject({
  platform: z.enum(['tiktok', 'youtube', 'instagram']),
  deviceId: z.string(),
  deviceName: z.string().default(''),
  account: z.string().default(''),
  readAt: z.number().default(0),
  syncedAt: z.number().default(0),
  state: z.enum(['never', 'reading', 'ok', 'failed']).default('never'),
  note: z.string().default(''),
  jobId: z.string().default(''),
  videos: z.array(RecapVideoSchema).default([]),
  truncated: z.boolean().default(false),
  window: z.number().default(0),
  asked: z.number().default(6),
  complete: z.boolean().default(false),
})
export type RecapRow = z.infer<typeof RecapRowSchema>

/** The key a recap row is stored under, and this screen's React key for it. */
export function recapRowKeyOf(row: Pick<RecapRow, 'platform' | 'deviceId'>): string {
  return `${RECAP_PREFIX}${row.platform}:${row.deviceId}`
}

/** Every stored recap row. A row this build cannot parse is skipped, never shown half-read. */
export async function listRecapRows(): Promise<RecapRow[]> {
  const out: RecapRow[] = []
  for (const entry of await readAll(RECAP_PREFIX)) {
    const parsed = RecapRowSchema.safeParse(entry.value)
    if (parsed.success) out.push(parsed.data)
  }
  return out
}

/**
 * Forget one account's recap — from the BROWSER, with no job.
 *
 * The escape hatch for the one thing the merge cannot fix by itself. If an
 * account is signed out and a different one signed in on the same phone, every
 * stored video belongs to somebody else and no amount of re-reading will say
 * so; the merge will only keep reporting that it cannot line the readings up.
 * Forgetting starts that account's history again from the next read.
 *
 * In the browser for the reason `setSessionStopped` is: it needs no phone, and
 * making the operator find an online phone to delete a row they are looking at
 * is the thing the owner objected to by name.
 */
export async function forgetRecap(row: Pick<RecapRow, 'platform' | 'deviceId'>): Promise<void> {
  const key = recapRowKeyOf(row)
  await api(`${CORE}/api/plugins/smm/data/entry?scope=global&key=${encodeURIComponent(key)}`, Ignored, { method: 'DELETE' })
}

/** Views added by one video since the reading before the last. `null` when there is no earlier reading. */
export function videoDelta(video: RecapVideo): number | null {
  if (video.history.length < 2) return null
  const last = video.history[video.history.length - 1]
  const before = video.history[video.history.length - 2]
  if (!last || !before) return null
  return last.views - before.views
}

/** The same, for a whole row. `null` when not one video has two readings yet. */
export function rowDelta(row: RecapRow): number | null {
  let total = 0
  let any = false
  for (const video of row.videos) {
    const delta = videoDelta(video)
    if (delta === null) continue
    total += delta
    any = true
  }
  return any ? total : null
}

/** A row's views, added up — including videos that have left the window. */
export function rowViews(row: RecapRow): number {
  return row.videos.reduce((sum, video) => sum + video.views, 0)
}

/**
 * Is this run stopped only in PART — some rows flagged, some not, and no marker saying the whole run
 * is? That is exactly what a Stop cut short by an older build left behind, and the page has to say so:
 * the session reads as stopped while the unflagged rows are still on their way out.
 */
export function partlyStopped(rows: readonly WarmupRow[], markers: ReadonlySet<string>): boolean {
  if (rows.length === 0) return false
  const first = rows[0] as WarmupRow
  if (markers.has(`${first.groupId}:${first.runId}`)) return false
  const flagged = rows.filter((row) => row.stopped).length
  return flagged > 0 && flagged < rows.length
}

/** Re-exported so the page's parts import the stop key from the one place it is defined. */
export { STOP_PREFIX, stopKey }
