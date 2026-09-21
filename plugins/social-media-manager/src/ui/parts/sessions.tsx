import { useCallback, useEffect, useId, useMemo, useRef, useState, type MouseEvent, type ReactElement } from 'react'
import {
  ArrowsClockwiseIcon,
  Badge,
  Button,
  CaretLeftIcon,
  CaretRightIcon,
  Card,
  Combobox,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  FilmStripIcon,
  Input,
  LoadingRows,
  PencilSimpleIcon,
  PauseIcon,
  SquareIcon,
  PlayIcon,
  PlusIcon,
  Progress,
  Spinner,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
  TrashIcon,
  api,
  cn,
  relativeTime,
  useAction,
  z,
  type ComboboxOption,
} from '@enkaku/ui'
import { PLATFORM_CAPTION_LIMITS, checkPlatformCaption, isCaptionPlatform, sharedTextFor } from '../../platform-captions'
import { PLATFORM_IDS, type PlatformId } from '../../platforms'
import { autoCaption } from '../autocaption'
import {
  CORE,
  MANUAL_JOB_PREFIX,
  PLATFORMS,
  POST_TEXT_MAX,
  composedHashtags,
  deviceName,
  hashtagText,
  lineTagsOf,
  listDevices,
  listGroups,
  listPosts,
  listVideos,
  parseHashtags,
  pickHost,
  postedText,
  runMember,
  type Device,
  type Group,
  type Post,
  setSessionStopped,
  autoPauseOf,
} from '../shared'
import { AutoStatus, BulkProgress, ReadinessNote, isWorking, stateOf, useAutoCaptionSetup, useBulkRun, type AutoState } from './autocaption-ui'
import { AccountAlerts } from './account-alerts'

/**
 * The watching half of the screen, in two places: the **Sessions** tab (every
 * upload session, newest first) and a **session's own page** (one table of
 * every video in one of them, one column per platform).
 *
 * ## What these are for
 *
 * The compose tab makes a session out of a folder of videos. This is where an
 * operator stands afterwards — forty videos crossing forty phones over the best
 * part of an hour — and the two questions they have are always the same: **is
 * it out yet**, and **what broke**. Everything here answers one of those two,
 * and anything that answered neither was left out.
 *
 * The split between the two is that same pair of questions: the list answers
 * the first for every batch at a glance, and the page answers the second for
 * one batch in full. Forty videos expanded inside a list is neither.
 *
 * ## Why the session page is a table
 *
 * The owner, from the production farm: *"saya bingung mana yang lagi proses /
 * running, terus progressnya gimana, ini error sebelumnya atau error run
 * sekarang"* — which ones are running now, how far along, and is this error
 * from before or from now. The page used to be one card per video with a red
 * paragraph per platform: no times, no attempt numbers, and forty of them.
 *
 * So a session's page is now three things, each answering one of those:
 *
 * - **A live line** — when this picture was read, whether it is still being
 *   re-read, when the session started and when it was last retried.
 * - **Filter chips** — every video × platform post counted into exactly one of
 *   Running · Waiting · Posted · Failed · Needs a look, so "what is running"
 *   is one click and the counts always add up to All.
 * - **The table** — one row per video in turn order, one cell per platform.
 *   A cell is ALWAYS the current attempt: its state, how long it has run or
 *   when it settled, and which retry it is. Attempts a retry replaced are only
 *   ever hinted at in the cell ("+1 earlier") and listed, dimmed and labelled
 *   "earlier", in the row's expansion — so an old failure can never be read
 *   as the current state.
 *
 * Every row carries its own actions, so nothing needs opening first (owner,
 * 2026-09-14: *"aksi seperti tombol edit dll juga di tabelnya dong jangan harus
 * klik detail dulu"*): the **Phone** cell is a searchable picker that saves the
 * moment a phone is chosen — a farm of a hundred phones is type-to-find, not a
 * scroll — and **Edit** opens the full form (phone, platforms, caption) right
 * under the row. Both are written by the service's own `smm/update-post`
 * member. An edit changes the NEXT attempt only: nothing already posted is
 * touched, and an upload already running carries on as it started. The form
 * warns rather than refuses — a phone another video already has, a row
 * mid-upload — because re-posting from a busy phone can be exactly what the
 * operator means.
 *
 * ## The vocabulary is the service's, not this file's
 *
 * Two words on this screen are worth more than the rest of it put together, and
 * both are the service's own (`posts.ts`):
 *
 * - **`unverified` is not a failure.** It is a phone whose upload job finished
 *   while the platform script could not confirm the post landed. It may well
 *   have landed — so it is never worded as success, never counted as one, and
 *   never handed to Retry, which re-sends. Re-sending a post that DID land is
 *   the same video twice on a real account, and that cannot be taken back.
 * - **`partial` means some phones posted and some did not.** It is its own
 *   state rather than a shade of failed, because the operator's next move
 *   differs: retry the stragglers, not the lot.
 *
 * So nothing here ever rounds a mixed outcome up into a clean one: a session
 * with failures shows the number, on its row, before anything is opened.
 */

/** How often a moving session is re-read. Slow on purpose — a batch moves in minutes, not frames. */
const POLL_MS = 10_000

/**
 * How often relative times are redrawn, independent of the poll. A settled
 * session makes no requests, but "running for 2m" and "Updated 40s ago" still
 * have to advance — a frozen clock reads exactly like a hung screen.
 */
const TICK_MS = 5_000

/** `z.unknown()` — a DELETE whose body nobody reads, said out loud rather than defaulted into. */
const Ignored = z.unknown()

/** What `smm/update-post` answers: the row it edited, which fields actually changed, and what the operator should know about it. */
const UpdatePostResultSchema = z.object({
  videoArtifactId: z.string(),
  changed: z.array(z.string()),
  warnings: z.array(z.string()).default([]),
})

/** Only the fields an edit changed — the member reads a missing field as "leave it as it is". */
interface PostChanges {
  assignedDeviceId?: string
  platforms?: string[]
  caption?: string
  /** The video's OWN hashtags, replacing the ones it had. */
  hashtags?: string[]
  /** A text per platform (0.27.0); an empty text removes that platform's own caption, a platform left out is unchanged. */
  platformCaptions?: Partial<Record<PlatformId, string>>
}

type SaveEdit = (post: Post, changes: PostChanges, name: string, onDone: (warnings: string[]) => void) => void

/** The caption limit the member enforces, repeated so the form can say so before Save rather than after. */
const CAPTION_MAX = 2200

/** The start of the router's note on a held, unassigned row (`posts.ts` `NO_PHONE_ASSIGNED`). Matched, not paraphrased — the page may not import the service half. */
const NO_PHONE_ASSIGNED = 'No phone is assigned to this video'

type PlatformState = Post['dispatch'][string]
type AttemptRow = PlatformState['attempts'][number]

interface Loaded {
  groups: Group[]
  posts: Post[]
  /** Artifact id → the operator's own name for that video. Missing when the upload has since been deleted. */
  videos: Map<string, string>
  /**
   * The Files list was read (0.34.0). Only then does an id missing from `videos` mean the file is GONE — a failed read
   * must never turn every row into "file deleted".
   */
  videosRead: boolean
  /** Device id → `#7 Galaxy A15`. Missing when the phone has left the farm (or the device list could not be read). */
  devices: Map<string, string>
  /** The fleet itself, in the farm's order — what the edit form's phone picker offers. */
  fleet: Device[]
}

/**
 * One snapshot of everything this panel draws.
 *
 * The reads are deliberately one load: a session's card is a group row and
 * its page is the post rows, and showing a fresh group beside stale posts
 * would let a header's counts disagree with the rows under it for a whole poll
 * interval. The phone names ride in the same load for the same reason — a
 * video's bound phone and the name printed beside it come from one moment.
 *
 * `listVideos` and `listDevices` are allowed to fail on their own — a name is
 * a nicety and the id's first eight characters are the fallback the rest of
 * this file already uses, while the posts are the thing an operator came here
 * for.
 */
async function loadAll(): Promise<Loaded> {
  const [allGroups, posts, videoRead, devices] = await Promise.all([
    listGroups(),
    listPosts(),
    listVideos()
      .then((list) => ({ ok: true, list }))
      .catch(() => ({ ok: false, list: [] as Awaited<ReturnType<typeof listVideos>> })),
    listDevices().catch(() => []),
  ])
  const names = new Map<string, string>()
  for (const video of videoRead.list) {
    // Every upload is in the map, named or not, so "not in the map" can mean "deleted" (0.34.0).
    names.set(video.id, video.label?.trim() || video.id.slice(0, 8))
  }
  const phones = new Map<string, string>()
  for (const device of devices) phones.set(device.id, deviceName(device))
  /*
    POST sessions only (plan 900 D4, D5). A warm-up session lives on its own
    menu entry with its own rows and its own buttons, and a list that mixed the
    two would offer an operator a Retry that re-sends videos on a session that
    has none. `kind` defaults to `post`, so every session made before warm-up
    existed is still here.
  */
  const groups = allGroups.filter((group) => group.kind !== 'warmup')
  return { groups, posts, videos: names, videosRead: videoRead.ok, devices: phones, fleet: devices }
}

/** `g-1757…-4f2a` → `g-175781`: an id an operator can match against a row, never a whole uuid in a sentence. */
function shortId(id: string): string {
  return id.slice(0, 8)
}

/**
 * How far along, as a whole number that never lies in either direction.
 *
 * `Math.floor` plus the 99 clamp is the honesty rule in arithmetic: 399 posted
 * of 400 rounds to 100 %, and a bar reading 100 % beside a session that still
 * has a video out is exactly the kind of "close enough" this screen must not
 * do. Only `posted === total` reads full.
 */
function percent(done: number, total: number): number {
  if (total <= 0) return 0
  if (done >= total) return 100
  return Math.min(99, Math.floor((done / total) * 100))
}

/**
 * The pacing, in the words the operator chose it with — "one per phone ·
 * shuffled · 4 at a time · 30-90s apart".
 *
 * It is one line and it is on every card, because pacing is the setting that
 * explains why nothing appears to be happening: a session of forty with a
 * ninety-second gap has thirty-nine videos legitimately doing nothing at any
 * given moment, and a screen that does not say so looks stuck.
 */
function pacingLine(group: Group): string {
  const parts: string[] = []
  parts.push(group.assignment === 'one-per-phone' ? 'one per phone' : 'every phone')
  parts.push(group.pacing.order === 'random' ? 'shuffled' : 'in the order chosen')
  parts.push(`${group.pacing.concurrency} at a time`)
  const lo = Math.min(group.pacing.gapSec[0], group.pacing.gapSec[1])
  const hi = Math.max(group.pacing.gapSec[0], group.pacing.gapSec[1])
  parts.push(hi === 0 ? 'back to back' : lo === hi ? `${lo}s apart` : `${lo}-${hi}s apart`)
  return parts.join(' · ')
}

/**
 * The stored summary without its own leading title.
 *
 * `groupSummary` composes `"<title>: 12 posted, 3 waiting of 40"` because it is
 * written for a one-column table where the title has nowhere else to be. Here
 * the title is the heading directly above, so the prefix is dropped — the same
 * sentence, said once.
 */
function summaryLine(group: Group): string | null {
  if (group.summary === null) return null
  const prefix = `${group.title}: `
  return group.summary.startsWith(prefix) ? group.summary.slice(prefix.length) : group.summary
}

/** A platform's own title, or its stored id when this build has never heard of it. Never a blank cell. */
function platformTitle(id: string): string {
  return PLATFORMS.find((p) => p.id === id)?.title ?? id
}

/**
 * A length of time, short: `45s`, `12m`, `1h 5m`, `3d`.
 *
 * Negative spans clamp to zero: the farm's clock and this browser's are two
 * clocks, and a job enqueued "two seconds in the future" has simply just
 * started.
 */
function span(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) {
    const h = Math.floor(s / 3600)
    const m = Math.floor((s % 3600) / 60)
    return m === 0 ? `${h}h` : `${h}h ${m}m`
  }
  return `${Math.floor(s / 86400)}d`
}

/**
 * An instant either side of now: `in 3m` or `11m ago`.
 *
 * `relativeTime` only speaks of the past — a future instant reads "just now"
 * there, which for a video whose turn is twenty minutes off is a lie. So the
 * future is said here, and the past is handed to `relativeTime` so it reads
 * the way every other time in the farm reads.
 */
function fromNow(epochSeconds: number, nowMs: number): string {
  const delta = epochSeconds - Math.floor(nowMs / 1000)
  if (delta >= 5) return `in ${span(delta)}`
  return relativeTime(epochSeconds, nowMs)
}

/** A clock that ticks on its own, so relative times advance while the data poll is off. */
function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(timer)
  }, [intervalMs])
  return now
}

/**
 * One platform's state, as the word an operator reads.
 *
 * Every one of these is the service's meaning spelled out (`posts.ts`'s
 * `DISPATCH_STATES`), and two of them are longer than a status word on purpose:
 * `partial` and `unsupported` are the two an operator acts on differently, and
 * neither survives being compressed to one word.
 */
const STATE_WORDS: Record<string, string> = {
  pending: 'Waiting for a phone',
  dispatched: 'Running',
  succeeded: 'Posted',
  partial: 'Some posted, some did not',
  failed: 'Failed',
  unsupported: 'Not supported in this build',
  skipped: 'Skipped',
}

const STATE_TONES: Record<string, string> = {
  pending: 'bg-faint-2',
  dispatched: 'bg-accent',
  succeeded: 'bg-ok',
  partial: 'bg-warn',
  failed: 'bg-danger',
  unsupported: 'bg-faint-2',
  /*
    Neutral, and emphatically not `bg-warn` or `bg-danger` (0.45.0). A skip is
    the one state that is exactly what the operator asked for, and a coloured
    dot is this table's whole vocabulary for "something needs you". Four amber
    dots down a finished session would undo the feature's entire point.
  */
  skipped: 'bg-faint-2',
}

/**
 * One phone's attempt, as a word. The service's own mapping
 * (`posts.ts`'s `ATTEMPT_WORDS`), repeated here rather than imported because
 * this file may not import the service half — and `unverified` keeps its own
 * name in both places for the reason that module gives at length.
 */
const ATTEMPT_WORDS: Record<string, string> = {
  queued: 'running',
  success: 'posted',
  failed: 'failed',
  unverified: 'not confirmed',
}

const ATTEMPT_TONES: Record<string, string> = {
  queued: 'text-accent',
  success: 'text-ok',
  failed: 'text-danger',
  unverified: 'text-warn',
}

/** Why `unverified` is not an error, on the word itself — the one state nobody guesses right. */
const UNVERIFIED_MEANING =
  'The upload finished but the script could not confirm the post appeared. Check the account on the phone, then mark it as posted or failed. It is never re-sent on its own, because if it did land a retry would post the same video twice.'

/** What the member `smm/resolve-attempt` does (`posts.ts` `MARK_ACTIONS`). */
type MarkAction = 'mark-posted' | 'unmark-posted' | 'mark-failed'

/**
 * Force one platform of one video by hand. `attempt` is the attempt being marked, or `null` for a platform with
 * nothing sent — the member then records a manual attempt on the video's own phone.
 */
type MarkPost = (post: Post, platform: string, attempt: AttemptRow | null, action: MarkAction, name: string) => void

/** Re-send one video to the phones where it failed (`smm/retry-failed`). */
type RetryVideo = (post: Post, name: string) => void

/**
 * Turn one platform of one video off, or back on (`smm/skip-platform`, 0.45.0).
 *
 * `skip: true` is only ever offered on a cell that has sent nothing — the member refuses the rest by
 * name, and a button that could only produce a refusal is not a button.
 */
type SkipPlatform = (post: Post, platform: string, skip: boolean, name: string) => void

/** The row-level writes about outcomes, passed down the table together. */
interface OutcomeActions {
  onMark: MarkPost
  onRetry: RetryVideo
  onSkip: SkipPlatform
  /** Whether a mark, a retry or a skip for this video is out right now. */
  busy: (post: Post) => boolean
}

/** Was this attempt set by hand — no farm run behind it, or any mark on it? (`posts.ts` `markedByHand`) */
function markedByHand(attempt: AttemptRow): boolean {
  return attempt.manual || attempt.resolution.length > 0
}

/** The job id a manual (or never-enqueued) attempt carries has no run to open. */
function hasRun(jobId: string): boolean {
  return !jobId.startsWith(MANUAL_JOB_PREFIX) && !jobId.startsWith('unqueued:')
}

/** The phone a "done by hand" mark is recorded against: the video's own, or its single chosen one. */
function ownPhoneOf(post: Post): string | null {
  return post.assignedDeviceId ?? (post.deviceIds.length === 1 ? (post.deviceIds[0] as string) : null)
}

/** What `smm/retry-failed` answers. */
const RetryFailedResultSchema = z.object({
  requeued: z.number(),
  platforms: z.array(z.string()).default([]),
  skipped: z.array(z.string()).default([]),
})

/** Has this video posted on every platform it was sent to? A deleted file no longer matters for such a row (0.34.0). */
function isFullyPosted(post: Post): boolean {
  const states = Object.values(post.dispatch)
  return states.length > 0 && states.every((s) => s.state === 'posted')
}

/** Does any current attempt of this video, on any platform, stand failed? What a row's Retry failed would re-send. */
function hasFailed(post: Post): boolean {
  return Object.values(post.dispatch).some((s) => s.attempts.some((a) => a.state === 'failed'))
}

/**
 * A state word behind a coloured dot — never a colour alone, and never a bare
 * enum. Same shape the proxy pack's own state cell uses, for the same reason:
 * the word carries the meaning and the dot only makes it findable.
 */
function StateWord({ state }: { state: string }): ReactElement {
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <span
        className={cn('size-1.5 shrink-0 rounded-pill', STATE_TONES[state] ?? 'bg-faint-2', state === 'dispatched' && 'animate-pulse')}
        aria-hidden
      />
      <span className="text-[12px]">{STATE_WORDS[state] ?? state}</span>
    </span>
  )
}

/**
 * One reading of the farm, polled while anything is moving.
 *
 * A hook rather than a component's own state because BOTH screens need exactly
 * this — the list of sessions and one session's own page — and two copies of a
 * poll loop is two places for a stale answer to win.
 *
 * `refreshKey` is the compose panel's way of saying *I have just made one*: it
 * changes, this reloads, and the new session is there without anyone pressing
 * anything.
 *
 * `updatedAt` (epoch ms of the last answer that was APPLIED) and `moving`
 * (whether the poll is running at all) are returned so the session page can
 * say both out loud instead of leaving the operator to guess.
 */
function useSessionsData(refreshKey: number): {
  data: Loaded | null
  error: string | null
  loading: boolean
  moving: boolean
  updatedAt: number | null
  reload: () => void
} {
  const [data, setData] = useState<Loaded | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [updatedAt, setUpdatedAt] = useState<number | null>(null)

  /**
   * The two counters that make a stale answer harmless.
   *
   * Three things can ask for a load at once — the ten-second poll, a
   * `refreshKey` bump, an action that just finished — and they answer in
   * whatever order the network feels like. Without this, the poll fired at
   * 00:00 and answered at 00:04 would overwrite the fresher picture an action
   * fetched at 00:03, and the operator would watch a session they had just
   * started go back to "not started" for six seconds.
   *
   * So every load takes a ticket, and a ticket that is not the newest one
   * ANSWERED is dropped on arrival. Older, not merely different: a slow answer
   * is not wrong, it is simply about a moment that has already passed.
   */
  const issued = useRef(0)
  const applied = useRef(0)
  const alive = useRef(true)

  const reload = useCallback((): void => {
    const ticket = (issued.current += 1)
    setLoading(true)
    void loadAll()
      .then((next) => {
        if (!alive.current || ticket <= applied.current) return
        applied.current = ticket
        setData(next)
        setError(null)
        setUpdatedAt(Date.now())
      })
      .catch((e: unknown) => {
        if (!alive.current || ticket <= applied.current) return
        applied.current = ticket
        setError(e instanceof Error ? e.message : String(e))
      })
      .finally(() => {
        // Only the newest request may put the spinner away: an older one
        // finishing last would otherwise clear it while a live load is still
        // out.
        if (alive.current && ticket === issued.current) setLoading(false)
      })
  }, [])

  useEffect(() => {
    alive.current = true
    reload()
    return () => {
      alive.current = false
    }
  }, [reload, refreshKey])

  /**
   * Is anything actually moving?
   *
   * `running` is a job on a phone right now; `waiting` is a row whose turn has
   * not come. Both change on their own, with nobody pressing anything, so both
   * are worth another look. A group whose progress is `null` counts too — the
   * farm has not reported on it yet, and "unknown" is not "settled".
   *
   * Everything else IS settled, and a settled list is not polled: a farm whose
   * last batch went out yesterday makes no requests at all while this screen
   * is open.
   */
  const moving = useMemo(
    () =>
      (data?.groups ?? []).some((g) => g.progress === null || g.progress.running > 0 || g.progress.waiting > 0) ||
      // The rows themselves too (0.26.0): a session's stored progress lags a row-level Retry by a tick,
      // and reading only it stopped the poll with the retried cells frozen at "Running".
      (data?.posts ?? []).some((p) =>
        p.platforms.some((id) => {
          const bucket = bucketOf(p.dispatch[id])
          return bucket === 'running' || (bucket === 'waiting' && p.notBeforeAt !== null)
        }),
      ),
    [data],
  )

  useEffect(() => {
    if (!moving) return
    const timer = setInterval(() => reload(), POLL_MS)
    return () => clearInterval(timer)
  }, [moving, reload])

  return { data, error, loading, moving, updatedAt, reload }
}

/**
 * The videos of one session, in the order they go out.
 *
 * Sorted by `notBeforeAt` — the instant a row's turn comes — and not by
 * creation, because a shuffled session's whole point is that those two orders
 * differ. A row with no turn yet (a session never started) falls back to when
 * it was made, which is the order it was chosen in.
 */
function postsOf(data: Loaded | null, groupId: string): Post[] {
  const list = (data?.posts ?? []).filter((post) => post.groupId === groupId)
  list.sort((a, b) => (a.notBeforeAt ?? a.createdAt) - (b.notBeforeAt ?? b.createdAt))
  return list
}

/**
 * Start, Retry and Remove — the three writes, in one place because both screens
 * offer all three and neither may word them differently.
 */
function useSessionActions(reload: () => void, onRemoved?: (group: Group) => void) {
  const { run, isPending } = useAction()

  /**
   * The phone the BOOKKEEPING runs on — and the refusal when there is none.
   *
   * `start-group` and `retry-group` only write rows; they post nothing. But
   * they are members, and a member runs on a device, so one online phone has to
   * carry the paperwork. When none is online there is nothing to be done and
   * the operator is told exactly that, before anything is written — rather than
   * a button that appears to work and a session that never moves.
   */
  async function hostOrRefuse(): Promise<{ id: string; name: string }> {
    const host = pickHost(await listDevices())
    if (host === null) {
      throw new Error(
        'No phone is online. This writes the schedule through one of the farm’s own phones, so at least one has to be connected — nothing has been changed.',
      )
    }
    return { id: host.id, name: deviceName(host) }
  }

  function startSession(group: Group): void {
    void run(
      `start:${group.id}`,
      async () => {
        const host = await hostOrRefuse()
        await runMember('smm/start-group@latest', { groupId: group.id }, host.id)
        return host
      },
      {
        success: `“${group.title}” started — the first video goes now and the rest are spaced by this session’s own gaps`,
        failure: `Could not start “${group.title}”`,
        onSuccess: () => reload(),
      },
    )
  }

  function retrySession(group: Group): void {
    void run(
      `retry:${group.id}`,
      async () => {
        const host = await hostOrRefuse()
        await runMember('smm/retry-group@latest', { groupId: group.id }, host.id)
        return host
      },
      {
        success: `Re-queued the failed phones in “${group.title}” — nothing that already posted was touched`,
        failure: `Could not retry “${group.title}”`,
        onSuccess: () => reload(),
      },
    )
  }

  /**
   * Stop a session, or start it again (0.57.0).
   *
   * This is what Remove used to be the only way to do, and the difference is
   * the whole point: removing a session stops it by deleting it, which throws
   * away every row that says what the phones did. Stopping keeps all of it and
   * is reversible — the owner asked for exactly that, *"tapi bisa di start
   * lagi juga"*.
   *
   * `setSessionStopped` (in `ui/shared.ts`) cancels what is running and puts it
   * back in the queue, straight from the browser; this only says which way to
   * move and reports what came back.
   */
  function stopSession(group: Group, action: 'stop' | 'start' | 'pause'): void {
    void run(
      `stop:${group.id}`,
      /*
        No `hostOrRefuse` here, and that is the point: stopping needs no phone.
        It was a member until the owner asked why halting a session should
        need a job, and the honest answer was that it should not — least of all
        when the reason to stop is that the phones are misbehaving.
      */
      () => setSessionStopped(group, action),
      {
        success:
          action === 'stop'
            ? `“${group.title}” stopped — anything running was cancelled and put back in the queue`
            : action === 'pause'
              ? `“${group.title}” paused — nothing new goes out; what is posting now finishes`
              : `“${group.title}” playing again — the router sends the rest on its next pass`,
        failure: action === 'stop' ? `Could not stop “${group.title}”` : action === 'pause' ? `Could not pause “${group.title}”` : `Could not start “${group.title}”`,
        onSuccess: () => reload(),
      },
    )
  }

  /**
   * Remove the session row — which is also how a session is STOPPED.
   *
   * The router refuses to dispatch a row whose session no longer exists
   * (`index.ts`, the orphan branch): a batch nobody can see is a batch nobody
   * can stop, so the only safe reading of a missing session is "do not send".
   * Anything already posted stays posted; the video rows keep saying so.
   */
  function removeSession(group: Group): void {
    void run(
      `remove:${group.id}`,
      () =>
        api(`${CORE}/api/plugins/smm/data/entry?scope=global&key=${encodeURIComponent(`group:${group.id}`)}`, Ignored, {
          method: 'DELETE',
        }),
      {
        success: `“${group.title}” removed — anything it had not sent yet is stopped`,
        failure: `Could not remove “${group.title}”`,
        onSuccess: () => {
          reload()
          onRemoved?.(group)
        },
      },
    )
  }

  /**
   * Edit one video — its bound phone, its platforms, its caption — through the
   * service's own `smm/update-post` member, sending only what changed.
   *
   * The member refuses only invalid input (`E_PARAMS_INVALID`: no platform, an
   * empty caption, a phone on a row that is not one-per-phone), with a
   * sentence `runMember` carries out as the job's error for the failure toast.
   * Everything else it accepts, and may answer with `warnings` — a phone that
   * already has another video, an upload still running — which go to `onDone`
   * for the row to keep on screen. Inline rather than a warning toast because
   * `@enkaku/ui` gives a plugin no toast of its own choosing, only
   * `useAction`'s fixed success line.
   */
  const updatePost: SaveEdit = (post, changes, name, onDone) => {
    void run(
      `update:${post.videoArtifactId}`,
      async () => {
        const host = await hostOrRefuse()
        return runMember('smm/update-post@latest', { videoArtifactId: post.videoArtifactId, ...changes }, host.id, UpdatePostResultSchema)
      },
      {
        success: `Saved the changes to “${name}” — they apply to its next attempt`,
        failure: `Could not save the changes to “${name}”`,
        onSuccess: (result) => {
          reload()
          onDone(result?.warnings ?? [])
        },
      },
    )
  }

  const saving = (post: Post): boolean => isPending(`update:${post.videoArtifactId}`)

  /**
   * Force one platform of one video by hand, through `smm/resolve-attempt` (0.21.0; every action since 0.23.0).
   *
   * The job id is sent so the member refuses if the attempt on screen is no longer the attempt
   * stored — a page open for an hour must not flip something that has since moved. The member's
   * own refusal ("this one is posted now — refresh", "still running") reaches the failure toast verbatim.
   */
  const markPost: MarkPost = (post, platform, attempt, action, name) => {
    const where = platformTitle(platform)
    void run(
      `resolve:${post.videoArtifactId}`,
      async () => {
        const host = await hostOrRefuse()
        const target = attempt !== null ? { deviceId: attempt.deviceId, jobId: attempt.jobId } : {}
        await runMember('smm/resolve-attempt@latest', { videoArtifactId: post.videoArtifactId, platform, action, ...target }, host.id)
      },
      {
        success:
          action === 'mark-posted'
            ? `Marked “${name}” as posted on ${where} — it is never sent there again`
            : action === 'unmark-posted'
              ? `Removed the posted mark from “${name}” on ${where} — Retry failed can send it again`
              : `Marked “${name}” on ${where} as failed — Retry failed can send it again`,
        failure: `Could not mark “${name}” on ${where}`,
        onSuccess: () => reload(),
      },
    )
  }

  /**
   * Re-send ONE video to where it failed, through `smm/retry-failed` — the row's own retry, beside
   * the session's. A retry that re-queued nothing is not a success: the member's `skipped` reasons
   * (no phone of its own yet, no caption) are thrown so the operator reads why.
   */
  const retryVideo: RetryVideo = (post, name) => {
    void run(
      `retry-video:${post.videoArtifactId}`,
      async () => {
        const host = await hostOrRefuse()
        const result = await runMember('smm/retry-failed@latest', { videoArtifactId: post.videoArtifactId }, host.id, RetryFailedResultSchema)
        if (result !== null && result.requeued === 0) {
          throw new Error(result.skipped.length > 0 ? `Nothing was re-sent: ${result.skipped.join('; ')}` : 'Nothing was re-sent — no failed attempt was found. Refresh the page.')
        }
        return result
      },
      {
        success: `Re-sent “${name}” to the phone where it failed — nothing that posted was touched`,
        failure: `Could not retry “${name}”`,
        onSuccess: () => reload(),
      },
    )
  }

  /**
   * Turn one platform off for this video, or back on, through `smm/skip-platform` (0.45.0).
   *
   * Nothing is sent by either direction. Enabling returns the cell to Waiting and the router sends
   * it at the video's next turn — within a tick on a session already started, which is what the
   * success line promises. The member refuses a skip on anything that has already been sent, and
   * that refusal reaches the failure toast verbatim rather than being guessed at here.
   */
  const skipPlatform: SkipPlatform = (post, platform, skip, name) => {
    const where = platformTitle(platform)
    void run(
      `skip:${post.videoArtifactId}`,
      async () => {
        const host = await hostOrRefuse()
        await runMember('smm/skip-platform@latest', { videoArtifactId: post.videoArtifactId, platform, skip }, host.id)
      },
      {
        success: skip
          ? `“${name}” skips ${where} — nothing is sent there, and nothing failed`
          : `“${name}” posts to ${where} again — it goes out at this video’s next turn`,
        failure: skip ? `Could not skip ${where} for “${name}”` : `Could not enable ${where} for “${name}”`,
        onSuccess: () => reload(),
      },
    )
  }

  const outcomeBusy = (post: Post): boolean =>
    isPending(`resolve:${post.videoArtifactId}`) || isPending(`retry-video:${post.videoArtifactId}`) || isPending(`skip:${post.videoArtifactId}`)

  const busy = (group: Group): boolean =>
    isPending(`start:${group.id}`) || isPending(`retry:${group.id}`) || isPending(`remove:${group.id}`)

  const outcome: OutcomeActions = { onMark: markPost, onRetry: retryVideo, onSkip: skipPlatform, busy: outcomeBusy }

  /**
   * Change a session's pacing (0.30.0) through `smm/update-group`: "at once" applies from the router's next look, and a
   * new gap spaces the videos whose turn has not come yet again. Nothing already sent is touched.
   */
  function updatePacing(group: Group, edit: PacingChange, onDone: () => void): void {
    void run(
      `pacing:${group.id}`,
      async () => {
        const host = await hostOrRefuse()
        await runMember('smm/update-group@latest', { groupId: group.id, ...edit }, host.id)
        return host
      },
      {
        success: `“${group.title}” now runs ${edit.concurrency} at a time, ${edit.gapMinSec}–${edit.gapMaxSec}s apart — turns still to come were spaced again`,
        failure: `Could not change the pacing of “${group.title}”`,
        onSuccess: () => {
          onDone()
          reload()
        },
      },
    )
  }

  return { startSession, retrySession, stopSession, removeSession, updatePost, updatePacing, saving, busy, outcome }
}

/** One shared empty map, so a render before the first load does not allocate one per card. */
const EMPTY_MAP: ReadonlyMap<string, string> = new Map<string, string>()
const EMPTY_FLEET: readonly Device[] = []
const NO_WARNINGS: readonly string[] = []

/**
 * The last refresh failed and an older picture is still up. Said out loud,
 * quietly, rather than either hiding it or throwing away rows the operator is
 * reading.
 */
function StaleNotice({ error }: { error: string }): ReactElement {
  return (
    <p className="rounded-inner border border-warn/35 px-3 py-2 text-[11.5px] leading-relaxed text-dim">
      The last refresh did not get through, so what is below is from a moment ago. {error}
    </p>
  )
}

/**
 * The front page: every session, newest first, one table row each, and nothing
 * about any one of them that does not fit on that row.
 *
 * What is deliberately NOT here is the videos. A session of forty carries forty
 * names, forty captions, up to eighty platform lines and every phone under
 * them — expanded inline, two open sessions made a page nobody could scan. So a
 * row answers the two questions a list is for, *is it out yet* and *what
 * broke*, and opening it goes to the session's own page for the rest.
 *
 * The Refresh button is the tab row's, one level up (`index.tsx`); this panel
 * reports only whether a refresh is out, so the spinner can sit beside it.
 */
export function SessionsPanel({
  refreshKey,
  onOpen,
  onRefreshingChange,
  onNew,
}: {
  refreshKey: number
  onOpen: (groupId: string) => void
  onRefreshingChange: (refreshing: boolean) => void
  /** Opens the compose flow — the same button the tab row carries, so an empty list is not a dead end. */
  onNew: () => void
}): ReactElement {
  const { data, error, loading, reload } = useSessionsData(refreshKey)
  const { startSession, retrySession, stopSession, removeSession, busy } = useSessionActions(reload)

  const groups = data?.groups ?? []

  // The spinner is for a REFRESH, and only while rows are already on screen —
  // the first load draws skeletons instead. A panel whose rows vanish every ten
  // seconds looks broken while working perfectly.
  const refreshing = loading && data !== null
  useEffect(() => onRefreshingChange(refreshing), [refreshing, onRefreshingChange])
  useEffect(() => () => onRefreshingChange(false), [onRefreshingChange])

  return (
    /**
     * `@container`, not a viewport breakpoint — this panel does not know how
     * wide the box it is in happens to be, and a `lg:` here would be a claim
     * about the window instead.
     */
    <div className="@container flex flex-col gap-3">
      <AccountAlerts refreshKey={refreshKey} />
      {error !== null && data !== null ? <StaleNotice error={error} /> : null}

      {loading && data === null ? (
        <LoadingRows rows={3} />
      ) : error !== null && data === null ? (
        <ErrorState message={error} onRetry={reload} />
      ) : groups.length === 0 ? (
        <EmptyState
          icon={<FilmStripIcon className="size-4" aria-hidden />}
          title="No sessions yet"
          description="Press New session, drop in your videos, choose where they go and how fast — the session appears here, with every video, every phone and every failure in it."
          action={
            <Button size="sm" onClick={onNew}>
              <PlusIcon aria-hidden />
              New session
            </Button>
          }
        />
      ) : (
        <div className="overflow-hidden rounded-inner border border-line">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Session</TableHead>
                <TableHead className="hidden @2xl:table-cell">Platforms</TableHead>
                <TableHead className="w-44">Progress</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="hidden @5xl:table-cell">Pacing</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {groups.map((group) => (
                <SessionRow
                  key={group.id}
                  group={group}
                  onOpen={() => onOpen(group.id)}
                  busy={busy(group)}
                  onStart={() => startSession(group)}
                  onRetry={() => retrySession(group)}
                  onStop={(action) => stopSession(group, action)}
                  onRemove={() => removeSession(group)}
                />
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------------ *
 * The session page's vocabulary: buckets, cells, and the live line.
 * ------------------------------------------------------------------------ */

/**
 * The six things one post (one video on one platform) can be doing, as far as
 * an operator's next move is concerned. Every cell lands in exactly one, so the
 * chips always add up to All.
 */
type Bucket = 'running' | 'waiting' | 'posted' | 'failed' | 'look' | 'skipped'
type Filter = 'all' | Bucket

const BUCKETS: readonly { id: Bucket; word: string; dot: string; pill: string; meaning: string }[] = [
  {
    id: 'running',
    word: 'Running',
    dot: 'bg-accent',
    pill: 'bg-accent-soft text-accent',
    meaning: 'A job for this post is queued or running on a phone right now.',
  },
  {
    id: 'waiting',
    word: 'Waiting',
    dot: 'bg-faint-2',
    pill: 'bg-muted-2 text-dim',
    meaning: 'Not sent yet: its turn has not come, or no suitable phone was free at the last check.',
  },
  { id: 'posted', word: 'Posted', dot: 'bg-ok', pill: 'bg-ok/15 text-ok', meaning: 'Every phone it was sent to posted it.' },
  {
    id: 'failed',
    word: 'Failed',
    dot: 'bg-danger',
    pill: 'bg-danger-soft text-danger',
    meaning: 'Every phone it was sent to failed. "Retry failed" sends it again.',
  },
  {
    id: 'look',
    word: 'Needs a look',
    dot: 'bg-warn',
    pill: 'bg-warn-soft text-warn',
    meaning:
      'Some phones posted and some did not, a post was not confirmed (check the account, then mark it as posted or failed), or the platform is not supported in this build. None of these is retried on its own.',
  },
  {
    id: 'skipped',
    word: 'Skipped',
    dot: 'bg-faint-2',
    pill: 'bg-muted-2 text-dim',
    meaning: 'You turned this platform off for this phone. Nothing is sent, and nothing failed. Enable it and it goes out at the video’s next turn.',
  },
]

function bucketInfo(id: Bucket): (typeof BUCKETS)[number] {
  return BUCKETS.find((b) => b.id === id) ?? BUCKETS[1]!
}

/**
 * Which bucket a cell is in, from its CURRENT state only — history never moves
 * a cell. Order matters and mirrors the service's own `groupProgress`, so the
 * chips and the header's counts agree:
 *
 * - no dispatch entry, or `pending` → Waiting
 * - `skipped` → Skipped, and nothing else: it is neither waiting (nothing is
 *   coming) nor something to look at (it is already what was asked for)
 * - `unsupported` → Needs a look
 * - `dispatched`, or any current attempt still `queued` → Running
 * - `succeeded` → Posted
 * - `failed` → Failed
 * - `partial` (which is also where `unverified` lands) or a state this build
 *   does not know → Needs a look
 */
function bucketOf(state: PlatformState | undefined): Bucket {
  if (!state || state.state === 'pending') return state?.attempts.some((a) => a.state === 'queued') ? 'running' : 'waiting'
  // Before `attempts` is consulted: a skip keeps the history a retry retired, and none of it is
  // what the cell is doing now.
  if (state.state === 'skipped') return 'skipped'
  if (state.state === 'unsupported') return 'look'
  if (state.state === 'dispatched' || state.attempts.some((a) => a.state === 'queued')) return 'running'
  if (state.state === 'succeeded') return 'posted'
  if (state.state === 'failed') return 'failed'
  return 'look'
}

/** Every platform the session's rows have anything to say about: the targeted ones, plus any a row already ran on. */
function platformsOf(group: Group, posts: readonly Post[]): string[] {
  const seen = new Set<string>(group.platforms)
  for (const post of posts) {
    for (const id of post.platforms) seen.add(id)
    for (const id of Object.keys(post.dispatch)) seen.add(id)
  }
  return [...seen]
}

/** Does this video target (or has it run on) this platform at all? A blank cell and a waiting one must not look alike. */
function hasPlatform(post: Post, platform: string): boolean {
  return post.platforms.includes(platform) || post.dispatch[platform] !== undefined
}

/**
 * The round the cell is on: the highest current attempt's, or — when a retry
 * has cleared the attempts and the new send has not gone out yet — one past the
 * highest earlier one. `null` when nothing has been tried at all.
 */
function roundOf(state: PlatformState | undefined): number | null {
  if (!state) return null
  if (state.attempts.length > 0) return Math.max(...state.attempts.map((a) => a.round))
  if (state.history.length > 0) return Math.max(...state.history.map((a) => a.round)) + 1
  return null
}

/** The phone an attempt ran on, named for a human — never blank, never a bare uuid. */
function attemptPhone(attempt: AttemptRow, devices: ReadonlyMap<string, string>): string {
  return devices.get(attempt.deviceId) ?? (attempt.deviceName?.trim() || `device ${shortId(attempt.deviceId)}`)
}

/**
 * When the session started: the earliest `at` of ANY attempt, current or
 * earlier, any round — the first moment a job was actually sent.
 *
 * `notBeforeAt` is only the fallback, for a session that has sent nothing yet:
 * a retry re-stamps it, so as the primary source it would move "started" to
 * the moment of the last retry.
 */
function startedAt(posts: readonly Post[]): number | null {
  let sent: number | null = null
  let turn: number | null = null
  for (const post of posts) {
    if (post.notBeforeAt !== null && (turn === null || post.notBeforeAt < turn)) turn = post.notBeforeAt
    for (const state of Object.values(post.dispatch)) {
      for (const a of [...state.attempts, ...state.history]) {
        if (a.at !== null && (sent === null || a.at < sent)) sent = a.at
      }
    }
  }
  return sent ?? turn
}

/** Latest `at` of any attempt, current or earlier, whose round is a retry (> 1). */
function lastRetryAt(posts: readonly Post[]): number | null {
  let max: number | null = null
  for (const post of posts) {
    for (const state of Object.values(post.dispatch)) {
      for (const a of [...state.attempts, ...state.history]) {
        if (a.round > 1 && a.at !== null && (max === null || a.at > max)) max = a.at
      }
    }
  }
  return max
}

/**
 * One session's own page: the same header the card carries, a live line, the
 * filter chips, and the table.
 *
 * It reads the same single load the list does, so a session opened while its
 * batch is moving keeps updating on the same ten-second poll — and the counts
 * in the header cannot disagree with the rows below them, because both came out
 * of one answer.
 */
export function SessionDetail({ groupId, refreshKey, onBack }: { groupId: string; refreshKey: number; onBack: () => void }): ReactElement {
  const { data, error, loading, moving, updatedAt, reload } = useSessionsData(refreshKey)
  // Removing the session removes the page it is on: there is nothing left to
  // watch, so the operator is put back on the list rather than left looking at
  // a header for a thing that no longer exists.
  const { startSession, retrySession, stopSession, removeSession, updatePost, updatePacing, saving, busy, outcome } = useSessionActions(reload, onBack)
  const now = useNow(TICK_MS)

  const group = (data?.groups ?? []).find((g) => g.id === groupId) ?? null
  const posts = useMemo(() => postsOf(data, groupId), [data, groupId])
  const videos = data?.videos ?? EMPTY_MAP
  const videosRead = data?.videosRead ?? false
  const devices = data?.devices ?? EMPTY_MAP
  // Videos whose file was deleted from Files (0.34.0): the phones cannot fetch them, so they fail when sent.
  const deletedVideos = videosRead ? posts.filter((p) => !videos.has(p.videoArtifactId) && !isFullyPosted(p)).length : 0

  return (
    // No vertical padding of its own — the host pads the view — and the same
    // `gap-3` rhythm as the tabbed page, so moving between the two does not
    // shift anything.
    <div className="@container flex flex-col gap-3">
      <div className="flex items-center gap-2">
        {/* Pulled left by its own padding, so the caret lines up with the card's edge below. */}
        <Button variant="ghost" size="sm" onClick={onBack} className="-ml-2.5">
          <CaretLeftIcon aria-hidden />
          All sessions
        </Button>
        {loading && data !== null ? <Spinner className="size-3.5 text-faint" /> : null}
        <div className="grow" />
        <Button variant="outline" size="sm" onClick={reload}>
          <ArrowsClockwiseIcon aria-hidden />
          Refresh
        </Button>
      </div>

      {error !== null && data !== null ? <StaleNotice error={error} /> : null}

      {loading && data === null ? (
        <LoadingRows rows={3} />
      ) : error !== null && data === null ? (
        <ErrorState message={error} onRetry={reload} />
      ) : group === null ? (
        <EmptyState
          icon={<FilmStripIcon className="size-4" aria-hidden />}
          title="This session is gone"
          description="Nothing on this farm carries that session id any more — it was removed, or the link is from another farm. Anything it had already posted stays posted."
        />
      ) : (
        <>
          <Card className="gap-0 rounded-card px-3.5 py-3">
            <SessionHead
              group={group}
              busy={busy(group)}
              onStart={() => startSession(group)}
              onRetry={() => retrySession(group)}
              onStop={(action) => stopSession(group, action)}
              onRemove={() => removeSession(group)}
              onEditPacing={(edit, done) => updatePacing(group, edit, done)}
            />
          </Card>

          {/* Why this session is not moving, when it is not (0.64.0): paused by the operator, or by the router with its reason. */}
          {group.stopped ? (
            <div className="rounded-card border border-line px-3.5 py-2.5 text-[12px] text-warn">
              {autoPauseOf(group)?.reason || 'Paused — nothing new goes out until you press Play. A video already posting finishes.'}
            </div>
          ) : null}
          <AccountAlerts refreshKey={refreshKey + (updatedAt ?? 0)} />

          <LiveLine moving={moving} updatedAt={updatedAt} posts={posts} now={now} />

          {deletedVideos > 0 ? (
            <div className="rounded-card border border-danger/30 bg-danger-soft px-3.5 py-2.5 text-[12px] text-text-2">
              <strong className="text-danger">
                {deletedVideos} video{deletedVideos === 1 ? '' : 's'} in this session {deletedVideos === 1 ? 'has' : 'have'} been deleted from Files.
              </strong>{' '}
              The phones cannot fetch {deletedVideos === 1 ? 'it' : 'them'}, so sending fails and Retry is blocked on {deletedVideos === 1 ? 'that row' : 'those rows'}. Upload the
              video again and add it to a new session, or remove the session if it is no longer needed.
            </div>
          ) : null}

          {posts.length === 0 ? (
            <p className="text-[11.5px] leading-relaxed text-dim">
              No video rows carry this session’s id. They may have been removed, or this session was made by a build that stored them differently.
            </p>
          ) : (
            <SessionTable
              group={group}
              posts={posts}
              videos={videos}
              videosRead={videosRead}
              devices={devices}
              fleet={data?.fleet ?? EMPTY_FLEET}
              now={now}
              onSave={updatePost}
              saving={saving}
              outcome={outcome}
            />
          )}
        </>
      )}
    </div>
  )
}

/**
 * When this picture is from, and whether it will change on its own.
 *
 * "Checking every 10s" is said only while the poll is actually running — the
 * hook's own `moving` — so the line can never promise a refresh that is not
 * happening.
 */
function LiveLine({ moving, updatedAt, posts, now }: { moving: boolean; updatedAt: number | null; posts: readonly Post[]; now: number }): ReactElement {
  const started = startedAt(posts)
  const retried = lastRetryAt(posts)
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11.5px] text-dim">
      <span className="inline-flex items-center gap-1.5">
        <span className={cn('size-1.5 shrink-0 rounded-pill', moving ? 'animate-pulse bg-accent' : 'bg-faint-2')} aria-hidden />
        {updatedAt !== null ? <span>Updated {relativeTime(Math.floor(updatedAt / 1000), now)}</span> : null}
      </span>
      <span aria-hidden>·</span>
      <span>{moving ? `checking every ${POLL_MS / 1000}s` : 'nothing is moving — not refreshing'}</span>
      {started !== null ? (
        <>
          <span aria-hidden className="text-faint">
            |
          </span>
          <span>Started {fromNow(started, now)}</span>
        </>
      ) : (
        <>
          <span aria-hidden className="text-faint">
            |
          </span>
          <span>Not started yet</span>
        </>
      )}
      {retried !== null ? (
        <>
          <span aria-hidden>·</span>
          <span>last retry {relativeTime(retried, now)}</span>
        </>
      ) : null}
    </div>
  )
}

/**
 * The chips and the table.
 *
 * Counts are over POSTS (video × platform), because that is the unit that runs,
 * posts and fails; the filter then shows every VIDEO with at least one post in
 * the chosen bucket, with the other cells of that row dimmed so the match is
 * findable.
 */
function SessionTable({
  group,
  posts,
  videos,
  videosRead,
  devices,
  fleet,
  now,
  onSave,
  saving,
  outcome,
}: {
  group: Group
  posts: readonly Post[]
  videos: ReadonlyMap<string, string>
  videosRead: boolean
  devices: ReadonlyMap<string, string>
  fleet: readonly Device[]
  now: number
  onSave: SaveEdit
  saving: (post: Post) => boolean
  outcome: OutcomeActions
}): ReactElement {
  const [filter, setFilter] = useState<Filter>('all')
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set())
  /** Rows whose Edit form is open — independent of `open`, so editing never needs the attempts unfolded first. */
  const [editing, setEditing] = useState<ReadonlySet<string>>(() => new Set())

  /**
   * The warnings each video's last save answered with. Held here, above the
   * rows, so they outlive the reload that save triggers and a row being folded
   * away; they go when dismissed, replaced by the next save, or the page is left.
   */
  const [warnings, setWarnings] = useState<ReadonlyMap<string, readonly string[]>>(() => new Map())
  const keepWarnings = useCallback((videoArtifactId: string, list: readonly string[]) => {
    setWarnings((prev) => {
      const next = new Map(prev)
      if (list.length === 0) next.delete(videoArtifactId)
      else next.set(videoArtifactId, list)
      return next
    })
  }, [])

  const platforms = useMemo(() => platformsOf(group, posts), [group, posts])
  const owners = useMemo(() => ownersOf(posts, videos), [posts, videos])

  const counts = useMemo(() => {
    const c: Record<Bucket, number> = { running: 0, waiting: 0, posted: 0, failed: 0, look: 0, skipped: 0 }
    for (const post of posts) {
      for (const platform of platforms) {
        if (hasPlatform(post, platform)) c[bucketOf(post.dispatch[platform])] += 1
      }
    }
    return c
  }, [posts, platforms])
  const total = counts.running + counts.waiting + counts.posted + counts.failed + counts.look + counts.skipped

  const rows = useMemo(() => {
    const numbered = posts.map((post, i) => ({ post, turn: i + 1 }))
    if (filter === 'all') return numbered
    return numbered.filter(({ post }) => platforms.some((p) => hasPlatform(post, p) && bucketOf(post.dispatch[p]) === filter))
  }, [posts, platforms, filter])

  const toggle = useCallback((id: string) => setOpen((prev) => flip(prev, id)), [])
  const toggleEdit = useCallback((id: string) => setEditing((prev) => flip(prev, id)), [])

  // --- auto captions ---------------------------------------------------------
  const setup = useAutoCaptionSetup()
  const bulk = useBulkRun()
  const [autoStates, setAutoStates] = useState<ReadonlyMap<string, AutoState>>(() => new Map())
  const setAuto = useCallback((id: string, state: AutoState | null) => {
    setAutoStates((prev) => {
      const next = new Map(prev)
      if (state === null) next.delete(id)
      else next.set(id, state)
      return next
    })
  }, [])

  /**
   * One row through the pipeline, saved through the same `smm/update-post` path a typed edit takes. It REPLACES what
   * the row has (0.27.0: a row's Regenerate and the session's Regenerate all both come here). No speech leaves the row
   * exactly as it was and says so; hashtags are sent only when the AI gave some, so a video's typed hashtags are not
   * wiped by a style that asks for none. Every platform the video posts to gets its new text, or loses its old one
   * when the writer gave none, so a stale platform caption never outlives the caption it was written beside.
   */
  const runAuto = useCallback(
    async (post: Post, signal: AbortSignal): Promise<void> => {
      const id = post.videoArtifactId
      const name = videos.get(id) ?? shortId(id)
      setAuto(id, { phase: 'extracting' })
      const outcome = await autoCaption({
        videoArtifactId: id,
        name,
        style: setup.style,
        fixedHashtags: composedHashtags(group.hashtags.fixed, lineTagsOf(group, post), []),
        platforms: post.platforms,
        signal,
        onStage: (phase) => setAuto(id, { phase }),
      })
      if (outcome.status === 'done') {
        const platformCaptions: Partial<Record<PlatformId, string>> = {}
        for (const platform of PLATFORM_IDS) if (post.platforms.includes(platform)) platformCaptions[platform] = outcome.platformCaptions[platform] ?? ''
        onSave(
          post,
          { caption: outcome.caption, ...(outcome.hashtags.length > 0 ? { hashtags: outcome.hashtags } : {}), platformCaptions },
          name,
          (list) => keepWarnings(id, list),
        )
      }
      setAuto(id, stateOf(outcome))
    },
    [videos, setup.style, group, setAuto, onSave, keepWarnings],
  )

  /** Every row not already being captioned — what Regenerate all rewrites. */
  const idlePosts = useMemo(() => posts.filter((p) => !isWorking(autoStates.get(p.videoArtifactId))), [posts, autoStates])
  const emptyPosts = useMemo(() => idlePosts.filter((p) => p.caption.trim() === ''), [idlePosts])

  const runMany = useCallback(async (targets: readonly Post[]): Promise<void> => {
    setAutoStates((prev) => {
      const next = new Map(prev)
      for (const post of targets) next.set(post.videoArtifactId, { phase: 'queued' })
      return next
    })
    await bulk.start(targets, runAuto)
    setAutoStates((prev) => {
      const next = new Map(prev)
      for (const [id, state] of next) if (state.phase === 'queued') next.delete(id)
      return next
    })
  }, [bulk.start, runAuto])

  /** Why Auto is off, as a sentence for the button's tooltip — the full reasons sit above the table. */
  const autoBlocked =
    setup.readiness === null
      ? 'Checking whether this farm can transcribe and write captions…'
      : !setup.readiness.ready
        ? setup.readiness.blockers.join(' ')
        : bulk.running
          ? 'An auto caption run is going — wait for it or press Stop.'
          : null
  const signalOf = bulk.signal
  const autoRow = useCallback((post: Post) => void runAuto(post, signalOf()), [runAuto, signalOf])

  const columns = 7 + platforms.length

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h3 className="text-[12px] font-medium text-dim">
          {posts.length} video{posts.length === 1 ? '' : 's'} · {platforms.length} platform{platforms.length === 1 ? '' : 's'}
        </h3>
        <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Filter videos by the state of their posts">
          <FilterChip label="All" count={total} selected={filter === 'all'} onClick={() => setFilter('all')} title="Every post: one video on one platform." />
          {BUCKETS.map((b) => (
            <FilterChip
              key={b.id}
              label={b.word}
              dot={b.dot}
              pulse={b.id === 'running' && counts.running > 0}
              count={counts[b.id]}
              selected={filter === b.id}
              onClick={() => setFilter(filter === b.id ? 'all' : b.id)}
              title={b.meaning}
            />
          ))}
        </div>
        <div className="grow" />
        <BulkProgress bulk={bulk} noun="captioned" />
        {bulk.running ? null : (
          <>
            <Button
              variant="outline"
              size="sm"
              disabled={autoBlocked !== null || emptyPosts.length === 0}
              title={autoBlocked ?? 'Transcribe each video whose caption is empty, then write its caption, hashtags and a caption per platform'}
              onClick={() => void runMany(emptyPosts)}
            >
              Auto caption empty captions ({emptyPosts.length})
            </Button>
            {/* Replaces words someone may have typed by hand, on every video at once — so behind a confirm (0.27.0). */}
            <ConfirmDialog
              trigger={
                <Button
                  variant="outline"
                  size="sm"
                  disabled={autoBlocked !== null || idlePosts.length === 0}
                  title={autoBlocked ?? 'Transcribe every video again and replace its caption, hashtags and per-platform captions'}
                >
                  <ArrowsClockwiseIcon aria-hidden />
                  Regenerate all captions ({idlePosts.length})
                </Button>
              }
              title={`Regenerate the captions of all ${idlePosts.length} video${idlePosts.length === 1 ? '' : 's'}?`}
              confirmLabel="Regenerate all"
              description={
                <>
                  Every video in this session is transcribed again and gets a new caption, new hashtags of its own and a new caption for each of
                  its platforms — <strong>replacing what it has now, including anything typed by hand</strong>. A video with no speech keeps what it
                  has. An upload already running keeps the text it started with; the new text goes out with the next attempt.
                </>
              }
              onConfirm={() => {
                void runMany(idlePosts)
              }}
            />
          </>
        )}
      </div>

      {setup.readiness !== null && !setup.readiness.ready ? <ReadinessNote setup={setup} /> : null}

      {filter !== 'all' ? (
        <p className="text-[11.5px] text-dim">
          Showing {rows.length} of {posts.length} video{posts.length === 1 ? '' : 's'} with a post that is {bucketInfo(filter).word.toLowerCase()} right now.
        </p>
      ) : null}

      {rows.length === 0 ? (
        <EmptyState
          title={`Nothing is ${bucketInfo(filter as Bucket).word.toLowerCase()} right now`}
          description="No post in this session is in that state at the moment. The counts above update as the session moves."
          action={
            <Button variant="outline" size="sm" onClick={() => setFilter('all')}>
              Show all videos
            </Button>
          }
        />
      ) : (
        // `Table` scrolls sideways inside its own container, so a session with
        // many platforms widens this box's scroller, never the page.
        <div className="overflow-hidden rounded-inner border border-line">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-12">#</TableHead>
                <TableHead>Video</TableHead>
                <TableHead>Caption</TableHead>
                <TableHead>Hashtags</TableHead>
                <TableHead className="hidden w-28 @xl:table-cell">Turn</TableHead>
                <TableHead className="w-64">Phone</TableHead>
                {platforms.map((p) => (
                  <TableHead key={p} className="@3xl:w-60">
                    {platformTitle(p)}
                  </TableHead>
                ))}
                <TableHead className="w-36 text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map(({ post, turn }) => (
                <VideoRows
                  key={post.videoArtifactId}
                  post={post}
                  turn={turn}
                  group={group}
                  platforms={platforms}
                  videos={videos}
                  videoDeleted={videosRead && !videos.has(post.videoArtifactId)}
                  devices={devices}
                  now={now}
                  filter={filter}
                  open={open.has(post.videoArtifactId)}
                  onToggle={toggle}
                  editing={editing.has(post.videoArtifactId)}
                  onToggleEdit={toggleEdit}
                  owners={owners}
                  columns={columns}
                  posts={posts}
                  fleet={fleet}
                  onSave={onSave}
                  saving={saving(post)}
                  warnings={warnings.get(post.videoArtifactId) ?? NO_WARNINGS}
                  onWarnings={keepWarnings}
                  auto={autoStates.get(post.videoArtifactId)}
                  autoBlocked={autoBlocked}
                  onAuto={autoRow}
                  outcome={outcome}
                />
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  )
}

/** A copy of `set` with `id` added or removed. */
function flip(set: ReadonlySet<string>, id: string): ReadonlySet<string> {
  const next = new Set(set)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  return next
}

function FilterChip({
  label,
  count,
  selected,
  onClick,
  title,
  dot,
  pulse = false,
}: {
  label: string
  count: number
  selected: boolean
  onClick: () => void
  title: string
  dot?: string
  pulse?: boolean
}): ReactElement {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      title={title}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-pill border px-2.5 py-1 text-[12px] transition-colors outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
        selected ? 'border-accent/40 bg-accent-soft text-accent' : 'border-line bg-panel text-text-2 hover:bg-hover',
        count === 0 && !selected && 'text-faint',
      )}
    >
      {dot ? <span className={cn('size-1.5 shrink-0 rounded-pill', dot, pulse && 'animate-pulse')} aria-hidden /> : null}
      <span>{label}</span>
      <span className="readout tabular-nums">{count}</span>
    </button>
  )
}

/**
 * The phone a video is bound to, as the table's Phone column says it.
 *
 * A one-per-phone session binds each video to ONE phone for every platform and every retry, so this
 * is the phone that posts it. An every-phone session has no binding by design.
 *
 * A one-per-phone row with NO phone is always shown as such, in warn tone, whatever its state: the
 * router never guesses a phone for a row from an older build (whose history is the tangle pairing
 * prevents) and holds it until an operator chooses one with Edit. When the router has written its
 * note — it does so on the row's waiting platforms — the note, with its suggested phone, is the
 * tooltip.
 */
function AssignedPhone({ post, group, devices }: { post: Post; group: Group; devices: ReadonlyMap<string, string> }): ReactElement {
  if (post.assignedDeviceId !== null) {
    const id = post.assignedDeviceId
    // A phone that has left the farm keeps the name its own attempts recorded.
    const recorded = Object.values(post.dispatch)
      .flatMap((s) => [...s.attempts, ...s.history])
      .find((a) => a.deviceId === id && a.deviceName)?.deviceName
    return <span className="text-[12px] text-text-2">{devices.get(id) ?? recorded ?? `device ${shortId(id)}`}</span>
  }
  if (group.assignment === 'every-phone' && post.maxDevices !== 1) return <span className="text-[12px] text-faint">any labelled phone</span>
  const note = unassignedNoteOf(post)
  return (
    <span className="text-[12px] text-warn" title={note ?? 'This video has no phone yet, so it is not sent. Open the row and choose one with Edit.'}>
      no phone — Edit to choose
    </span>
  )
}

/** The router's note on a held, unassigned row, when any of its platforms carries it (it names a suggested phone). */
function unassignedNoteOf(post: Post): string | null {
  for (const state of Object.values(post.dispatch)) if (state.note?.includes(NO_PHONE_ASSIGNED)) return state.note
  return null
}

interface Owner {
  videoArtifactId: string
  name: string
}

/**
 * Device id → the videos of this session that own it: a row's assigned phone,
 * or the phone of its CURRENT attempt that did not fail — the way the service
 * computes ownership. Built once for the table and read per row with
 * `otherOwner`, rather than once per picker.
 */
function ownersOf(posts: readonly Post[], videos: ReadonlyMap<string, string>): Map<string, Owner[]> {
  const map = new Map<string, Owner[]>()
  for (const post of posts) {
    const owner = { videoArtifactId: post.videoArtifactId, name: videos.get(post.videoArtifactId) ?? shortId(post.videoArtifactId) }
    const claimed = new Set<string>()
    if (post.assignedDeviceId !== null) claimed.add(post.assignedDeviceId)
    for (const state of Object.values(post.dispatch)) {
      for (const a of state.attempts) if (a.state !== 'failed') claimed.add(a.deviceId)
    }
    for (const id of claimed) map.set(id, [...(map.get(id) ?? []), owner])
  }
  return map
}

/** The name of a video OTHER than `self` that owns this phone, if any. */
function otherOwner(owners: ReadonlyMap<string, readonly Owner[]>, deviceId: string, self: string): string | undefined {
  return owners.get(deviceId)?.find((o) => o.videoArtifactId !== self)?.name
}

/**
 * The phone picker's rows: the whole fleet, found by typing its number (`7` or
 * `#7`), its name, a label or its group. A phone another video already has
 * stays choosable (the owner's call: warn, never refuse) and says which video
 * on its own row. The row's current phone is kept when it has left the farm,
 * so the picker can still show its own value.
 */
function phoneOptions(
  post: Post,
  fleet: readonly Device[],
  devices: ReadonlyMap<string, string>,
  owners: ReadonlyMap<string, readonly Owner[]>,
): ComboboxOption[] {
  const options: ComboboxOption[] = fleet.map((d) => {
    const owner = otherOwner(owners, d.id, post.videoArtifactId)
    const hint = [d.status !== 'online' ? d.status : null, owner !== undefined ? `already has ${owner}` : null]
      .filter((x): x is string => x !== null)
      .join(' · ')
    const keywords = [d.label ?? '', ...d.labels.map((l) => l.name), d.group?.name ?? '']
    if (d.number !== null) keywords.push(String(d.number), `#${d.number}`)
    return { value: d.id, label: deviceName(d), keywords: keywords.filter((k) => k !== ''), ...(hint !== '' ? { hint } : {}) }
  })
  const current = post.assignedDeviceId
  if (current !== null && !fleet.some((d) => d.id === current)) {
    options.unshift({ value: current, label: devices.get(current) ?? `device ${shortId(current)}`, hint: 'not on this farm any more' })
  }
  return options
}

/**
 * The Phone cell. On a one-per-phone row it IS the editor: choosing a phone
 * saves it, and the service's warnings (a phone another video has, an upload
 * still running) land under the row. An every-phone row has no single phone,
 * so it stays text.
 */
function PhoneCell({
  post,
  group,
  name,
  devices,
  fleet,
  owners,
  saving,
  onSave,
  onWarnings,
}: {
  post: Post
  group: Group
  name: string
  devices: ReadonlyMap<string, string>
  fleet: readonly Device[]
  owners: ReadonlyMap<string, readonly Owner[]>
  saving: boolean
  onSave: SaveEdit
  onWarnings: (videoArtifactId: string, list: readonly string[]) => void
}): ReactElement {
  const options = useMemo(() => phoneOptions(post, fleet, devices, owners), [post, fleet, devices, owners])
  if (post.maxDevices !== 1) return <AssignedPhone post={post} group={group} devices={devices} />
  const unassigned = post.assignedDeviceId === null
  return (
    <div
      data-row-action
      className="flex min-w-0 items-center gap-1.5"
      title={unassigned ? (unassignedNoteOf(post) ?? 'This video has no phone yet, so it is not sent. Choose one here.') : undefined}
    >
      <Combobox
        value={post.assignedDeviceId ?? ''}
        onValueChange={(id) => {
          if (id !== post.assignedDeviceId) onSave(post, { assignedDeviceId: id }, name, (list) => onWarnings(post.videoArtifactId, list))
        }}
        options={options}
        placeholder="No phone — choose one"
        searchPlaceholder="Search by #, name, label or group…"
        emptyText="No phone matches."
        disabled={saving}
        ariaLabel={`Phone for ${name}`}
        className="w-64"
        triggerClassName={cn('h-7 min-w-0 text-[12px]', unassigned && 'border-warn/60')}
      />
      {saving ? <Spinner className="size-3.5 shrink-0 text-faint" /> : null}
    </div>
  )
}

/**
 * A video's caption, edited in place.
 *
 * Read-only it is two lines and a tooltip; clicked, it is a text area with the same limit the member enforces, saved
 * through `smm/update-post` like every other edit — so an empty caption is refused before Save, and the warnings the
 * service answers with land under the row. Ctrl/⌘+Enter saves, Escape puts the caption back as it was.
 */
function CaptionCell({
  post,
  name,
  saving,
  onSave,
  onWarnings,
  hasTags,
  auto,
  autoBlocked,
  onAuto,
}: {
  post: Post
  name: string
  saving: boolean
  onSave: SaveEdit
  onWarnings: (videoArtifactId: string, list: readonly string[]) => void
  /** Whether the video posts with any hashtag — its own or the session's. Only then may its caption be empty. */
  hasTags: boolean
  auto: AutoState | undefined
  /** Why Auto cannot run right now, or `null` when it can. */
  autoBlocked: string | null
  onAuto: (post: Post) => void
}): ReactElement {
  const [draft, setDraft] = useState<string | null>(null)
  const editing = draft !== null
  /** The platforms this video posts its OWN caption to, not this one (0.27.0). */
  const ownOn = PLATFORM_IDS.filter((id) => post.platforms.includes(id) && (post.platformCaptions[id] ?? '') !== '')
  const ownOnWords = ownOn.map(platformTitle).join(', ')
  const problem =
    draft === null
      ? null
      : draft.trim().length === 0 && !hasTags
        ? 'The caption cannot be empty while this video has no hashtags.'
        : draft.length > CAPTION_MAX
          ? `The caption is ${draft.length} characters; the limit is ${CAPTION_MAX}.`
          : null
  const dirty = draft !== null && draft !== post.caption
  const save = (): void => {
    if (draft === null || !dirty || problem !== null || saving) return
    onSave(post, { caption: draft }, name, (list) => {
      onWarnings(post.videoArtifactId, list)
      setDraft(null)
    })
  }

  if (!editing) {
    const working = isWorking(auto)
    return (
      <div className="space-y-0.5">
        <button
          type="button"
          data-row-action
          onClick={() => setDraft(post.caption)}
          title={post.caption ? `${post.caption}\n\nClick to edit` : 'Click to write a caption'}
          className="block w-full min-w-[10rem] max-w-[20rem] rounded-inner px-1 py-0.5 text-left hover:bg-hover focus-visible:outline-2 focus-visible:outline-accent"
        >
          {post.caption ? (
            <span className="line-clamp-2 text-[11.5px] leading-snug text-text-2">{post.caption}</span>
          ) : (
            <span className="text-[11.5px] text-faint">No caption — click to write one</span>
          )}
        </button>
        {ownOn.length > 0 ? (
          <p
            className="max-w-[20rem] px-1 text-[11px] text-faint"
            title={ownOn.map((id) => `${platformTitle(id)}: ${post.platformCaptions[id] ?? ''}`).join('\n\n')}
          >
            Own caption on {ownOnWords}
          </p>
        ) : null}
        <div data-row-action className="flex max-w-[20rem] flex-wrap items-center gap-x-2 gap-y-0.5">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={autoBlocked !== null || working || saving}
            title={
              autoBlocked ??
              (post.caption.trim() === ''
                ? 'Transcribe this video, then write its caption, hashtags and a caption per platform'
                : 'Transcribe this video again and replace its caption, hashtags and per-platform captions')
            }
            onClick={() => onAuto(post)}
          >
            {working ? <Spinner className="size-3" /> : <ArrowsClockwiseIcon aria-hidden className={cn(post.caption.trim() === '' && 'hidden')} />}
            {post.caption.trim() === '' ? 'Auto' : 'Regenerate'}
          </Button>
          <AutoStatus state={auto} noSpeech="No speech found — caption left as it was" />
        </div>
      </div>
    )
  }

  return (
    <div data-row-action className="w-[20rem] max-w-full space-y-1.5">
      <Textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setDraft(null)
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) save()
        }}
        rows={4}
        autoFocus
        disabled={saving}
        aria-label={`Caption for ${name}`}
        className="text-[12px]"
      />
      <div className="flex flex-wrap items-center gap-1.5">
        <Button type="button" size="sm" disabled={!dirty || problem !== null || saving} onClick={save}>
          {saving ? <Spinner className="size-3.5" /> : null}
          Save
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={saving} onClick={() => setDraft(null)}>
          Cancel
        </Button>
        <span className={cn('readout ml-auto text-[11px] tabular-nums', draft.length > CAPTION_MAX ? 'text-danger' : 'text-faint')}>
          {draft.length} / {CAPTION_MAX}
        </span>
      </div>
      {problem !== null ? <p className="text-[11px] text-danger">{problem}</p> : null}
      {ownOn.length > 0 ? <p className="text-[11px] text-dim">{ownOnWords} post{ownOn.length === 1 ? 's' : ''} its own caption, not this one — change it with Edit.</p> : null}
    </div>
  )
}

/**
 * A video's hashtags, edited in place the way its caption is.
 *
 * Read-only it shows the video's OWN hashtags and, dimmed, what the session adds (its fixed hashtags and the line
 * this video was given), so the cell reads as what will be posted. Editing changes only the video's own; the
 * preview underneath is the whole posted text, cut the way the service cuts it.
 */
function HashtagsCell({
  post,
  group,
  name,
  saving,
  onSave,
  onWarnings,
}: {
  post: Post
  group: Group
  name: string
  saving: boolean
  onSave: SaveEdit
  onWarnings: (videoArtifactId: string, list: readonly string[]) => void
}): ReactElement {
  const [draft, setDraft] = useState<string | null>(null)
  const inherited = composedHashtags(group.hashtags.fixed, lineTagsOf(group, post), [])
  const own = post.hashtags

  if (draft === null) {
    const ownKeys = new Set(own.map((t) => t.toLowerCase()))
    const extra = inherited.filter((t) => !ownKeys.has(t.toLowerCase()))
    return (
      <button
        type="button"
        data-row-action
        onClick={() => setDraft(hashtagText(own))}
        title={[own.length > 0 ? `This video: ${hashtagText(own)}` : null, extra.length > 0 ? `From the session: ${hashtagText(extra)}` : null, 'Click to edit']
          .filter((s) => s !== null)
          .join('\n')}
        className="block w-full min-w-[8rem] max-w-[16rem] rounded-inner px-1 py-0.5 text-left hover:bg-hover focus-visible:outline-2 focus-visible:outline-accent"
      >
        {own.length === 0 && extra.length === 0 ? (
          <span className="text-[11.5px] text-faint">No hashtags — click to add</span>
        ) : (
          <span className="line-clamp-3 text-[11.5px] leading-snug wrap-anywhere">
            {own.length > 0 ? <span className="text-text-2">{hashtagText(own)}</span> : null}
            {own.length > 0 && extra.length > 0 ? ' ' : null}
            {extra.length > 0 ? <span className="text-faint">{hashtagText(extra)}</span> : null}
          </span>
        )}
      </button>
    )
  }

  const parsed = parseHashtags(draft)
  const all = composedHashtags(group.hashtags.fixed, lineTagsOf(group, post), parsed)
  const posted = postedText(post.caption, all)
  const dirty = hashtagText(parsed) !== hashtagText(own)
  const problem = post.caption.trim() === '' && all.length === 0 ? 'This video has no caption, so it needs at least one hashtag.' : null
  const save = (): void => {
    if (!dirty || problem !== null || saving) return
    onSave(post, { hashtags: parsed }, name, (list) => {
      onWarnings(post.videoArtifactId, list)
      setDraft(null)
    })
  }

  return (
    <div data-row-action className="w-[16rem] max-w-full space-y-1.5">
      <Input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setDraft(null)
          if (e.key === 'Enter') {
            e.preventDefault()
            save()
          }
        }}
        autoFocus
        disabled={saving}
        placeholder="#tag #another"
        aria-label={`Hashtags for ${name}`}
        className="h-7 text-[12px]"
      />
      {inherited.length > 0 ? <p className="text-[11px] text-faint wrap-anywhere">Also from the session: {hashtagText(inherited)}</p> : null}
      <p className="line-clamp-4 text-[11px] whitespace-pre-line text-dim wrap-anywhere" title={posted}>
        Posts as: {posted === '' ? '—' : posted}
      </p>
      <div className="flex flex-wrap items-center gap-1.5">
        <Button type="button" size="sm" disabled={!dirty || problem !== null || saving} onClick={save}>
          {saving ? <Spinner className="size-3.5" /> : null}
          Save
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={saving} onClick={() => setDraft(null)}>
          Cancel
        </Button>
        <span className="readout ml-auto text-[11px] text-faint tabular-nums">
          {posted.length} / {POST_TEXT_MAX}
        </span>
      </div>
      {problem !== null ? <p className="text-[11px] text-danger">{problem}</p> : null}
    </div>
  )
}

function turnText(post: Post, now: number): string {
  return post.notBeforeAt === null ? 'not started' : fromNow(post.notBeforeAt, now)
}

/**
 * One video: its row and, when opened, the detail row under it.
 *
 * The whole row is the click target; the `#` cell holds a real button so the
 * row can be reached and opened from the keyboard, and it is that button that
 * carries `aria-expanded`. A click that ends a text selection does not toggle,
 * so an error can be selected and copied.
 */
function VideoRows({
  post,
  turn,
  group,
  platforms,
  videos,
  videoDeleted,
  devices,
  now,
  filter,
  open,
  onToggle,
  editing,
  onToggleEdit,
  owners,
  columns,
  posts,
  fleet,
  onSave,
  saving,
  warnings,
  onWarnings,
  auto,
  autoBlocked,
  onAuto,
  outcome,
}: {
  outcome: OutcomeActions
  post: Post
  turn: number
  group: Group
  platforms: readonly string[]
  videos: ReadonlyMap<string, string>
  videoDeleted: boolean
  devices: ReadonlyMap<string, string>
  now: number
  filter: Filter
  open: boolean
  onToggle: (id: string) => void
  editing: boolean
  onToggleEdit: (id: string) => void
  owners: ReadonlyMap<string, readonly Owner[]>
  columns: number
  posts: readonly Post[]
  fleet: readonly Device[]
  onSave: SaveEdit
  saving: boolean
  warnings: readonly string[]
  onWarnings: (videoArtifactId: string, list: readonly string[]) => void
  auto: AutoState | undefined
  autoBlocked: string | null
  onAuto: (post: Post) => void
}): ReactElement {
  const name = videos.get(post.videoArtifactId) ?? shortId(post.videoArtifactId)
  const detailId = `smm-video-${post.videoArtifactId}`
  const tags = composedHashtags(group.hashtags.fixed, lineTagsOf(group, post), post.hashtags)
  const hasTags = tags.length > 0

  function onRowClick(e: MouseEvent<HTMLTableRowElement>): void {
    const target = e.target as HTMLElement
    // The phone picker's list is a portal: its clicks bubble through React to this row without being inside it.
    if (!e.currentTarget.contains(target)) return
    if (target.closest('a, [data-row-action]')) return
    const selection = window.getSelection()
    if (selection && selection.toString().length > 0 && !(e.target as HTMLElement).closest('button')) return
    onToggle(post.videoArtifactId)
  }

  return (
    <>
      <TableRow data-state={open ? 'selected' : undefined} className="cursor-pointer align-top" onClick={onRowClick}>
        <TableCell className="align-top">
          <button
            type="button"
            aria-expanded={open}
            aria-controls={detailId}
            aria-label={`${open ? 'Hide' : 'Show'} every attempt for ${name}`}
            className="inline-flex items-center gap-1 rounded-small px-1 py-0.5 text-[12px] text-dim outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          >
            <CaretRightIcon className={cn('size-3 shrink-0 text-faint transition-transform', open && 'rotate-90')} aria-hidden />
            <span className="readout tabular-nums">{turn}</span>
          </button>
        </TableCell>
        <TableCell className="align-top">
          <div className="max-w-[14rem] truncate text-[12.5px] font-medium text-text @3xl:max-w-[20rem]" title={name}>
            {name}
          </div>
          {videoDeleted ? (
            <Badge variant="destructive" className="mt-1 px-1.5 py-0 text-[10px]" title="This video's file was deleted from Files — the phones cannot fetch it, so sending it fails.">
              File deleted
            </Badge>
          ) : null}
          {/* Narrow boxes hide the Turn column; its fact moves under the name rather than vanish. */}
          <div className="mt-0.5 text-[11px] text-faint @xl:hidden">Turn {turnText(post, now)}</div>
        </TableCell>
        {/* The caption on the row itself, and edited there (owner, 2026-09-14) — two lines at most until clicked. */}
        <TableCell className="align-top">
          <CaptionCell
            post={post}
            name={name}
            saving={saving}
            onSave={onSave}
            onWarnings={onWarnings}
            hasTags={hasTags}
            auto={auto}
            autoBlocked={autoBlocked}
            onAuto={onAuto}
          />
        </TableCell>
        <TableCell className="align-top">
          <HashtagsCell post={post} group={group} name={name} saving={saving} onSave={onSave} onWarnings={onWarnings} />
        </TableCell>
        <TableCell
          className="readout hidden align-top text-[11.5px] whitespace-nowrap text-dim @xl:table-cell"
          title={post.notBeforeAt === null ? undefined : new Date(post.notBeforeAt * 1000).toLocaleString()}
        >
          {turnText(post, now)}
        </TableCell>
        <TableCell className="align-top">
          <PhoneCell
            post={post}
            group={group}
            name={name}
            devices={devices}
            fleet={fleet}
            owners={owners}
            saving={saving}
            onSave={onSave}
            onWarnings={onWarnings}
          />
        </TableCell>
        {platforms.map((p) => (
          <TableCell key={p} className="align-top">
            {hasPlatform(post, p) ? (
              <PlatformCell
                post={post}
                platform={p}
                name={name}
                devices={devices}
                now={now}
                dimmed={filter !== 'all' && bucketOf(post.dispatch[p]) !== filter}
                outcome={outcome}
              />
            ) : (
              <span className="text-[11px] text-faint">not sent here</span>
            )}
          </TableCell>
        ))}
        <TableCell className="align-top">
          <div data-row-action className="flex flex-wrap justify-end gap-1.5">
            {hasFailed(post) ? <RetryVideoButton post={post} name={name} outcome={outcome} deleted={videoDeleted} /> : null}
            <Button
              variant={editing ? 'secondary' : 'outline'}
              size="sm"
              aria-expanded={editing}
              title="Change this video’s phone, platforms or caption for its next attempt"
              onClick={() => onToggleEdit(post.videoArtifactId)}
            >
              <PencilSimpleIcon aria-hidden />
              Edit
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-expanded={open}
              aria-controls={detailId}
              aria-label={`${open ? 'Hide' : 'Show'} every attempt for ${name}`}
              title={open ? 'Hide the attempts' : 'Every attempt, current and earlier, with its full error and run'}
              onClick={() => onToggle(post.videoArtifactId)}
            >
              <CaretRightIcon className={cn('transition-transform', open && 'rotate-90')} aria-hidden />
            </Button>
          </div>
        </TableCell>
      </TableRow>

      {open || editing || warnings.length > 0 ? (
        <TableRow id={detailId} className="bg-muted/50 hover:bg-muted/50">
          <TableCell colSpan={columns} className="space-y-3 px-3 py-3">
            {warnings.length > 0 ? (
              <div className="flex flex-wrap items-start gap-2 rounded-inner border border-warn/35 bg-warn-soft px-3 py-2" role="status">
                <div className="min-w-0 grow space-y-0.5 text-[11.5px] leading-relaxed text-warn">
                  <p className="font-medium">
                    “{name}” saved, with {warnings.length === 1 ? 'a warning' : `${warnings.length} warnings`}:
                  </p>
                  {warnings.map((w, i) => (
                    <p key={i}>{w}</p>
                  ))}
                </div>
                <Button type="button" variant="ghost" size="sm" onClick={() => onWarnings(post.videoArtifactId, [])}>
                  Dismiss
                </Button>
              </div>
            ) : null}
            {editing ? (
              <EditPostForm
                post={post}
                name={name}
                devices={devices}
                fleet={fleet}
                owners={owners}
                hasTags={hasTags}
                tags={tags}
                saving={saving}
                onSave={onSave}
                onSaved={(list) => {
                  onWarnings(post.videoArtifactId, list)
                  onToggleEdit(post.videoArtifactId)
                }}
                onClose={() => onToggleEdit(post.videoArtifactId)}
              />
            ) : null}
            {open ? <VideoDetail post={post} name={name} platforms={platforms} devices={devices} now={now} outcome={outcome} /> : null}
          </TableCell>
        </TableRow>
      ) : null}
    </>
  )
}

/**
 * One platform's CURRENT state for one video, compactly.
 *
 * Three lines at most: the pill (with the retry round and a hint that earlier
 * attempts exist), where and when, and — for a failure or a needs-a-look —
 * one line of why, the full text in `title`. The phone is named only when it is
 * NOT the video's bound phone (a row from before the binding, or an every-phone
 * fan-out), because the Phone column already says it.
 */
function PlatformCell({
  post,
  platform,
  name,
  devices,
  now,
  dimmed,
  outcome,
}: {
  post: Post
  platform: string
  name: string
  devices: ReadonlyMap<string, string>
  now: number
  dimmed: boolean
  outcome: OutcomeActions
}): ReactElement {
  const state = post.dispatch[platform]
  const bucket = bucketOf(state)
  const attempts = state?.attempts ?? []
  /**
   * The current attempts the script could not confirm (0.21.0). While anything is still running they
   * wait — the cell is Running — and once it is not, a single one is resolved right here in the cell.
   */
  const unconfirmed = bucket === 'running' ? [] : attempts.filter((a) => a.state === 'unverified')
  const failedNow = attempts.filter((a) => a.state === 'failed')
  // "Not confirmed" is its own word on the pill when that is all that is wrong: nothing failed, and at
  // least one phone could not be confirmed. "Needs a look" stays for a real mix and for unsupported.
  // "Queued on phone" (0.26.0) while the phone has not started any of this cell's jobs yet: it is busy
  // with another job, and the farm runs one job per phone at a time. "Running" only once it started.
  const inFlight = attempts.filter((a) => a.state === 'queued')
  const queuedOnly = bucket === 'running' && inFlight.length > 0 && inFlight.every((a) => a.startedAt == null)
  const info =
    unconfirmed.length > 0 && failedNow.length === 0
      ? { ...bucketInfo('look'), word: 'Not confirmed', meaning: UNVERIFIED_MEANING }
      : queuedOnly
        ? { ...bucketInfo('running'), word: 'Queued on phone', meaning: 'Sent to its phone, which is finishing another job first. The farm runs one job per phone at a time.' }
        : bucketInfo(bucket)
  const history = state?.history ?? []
  const round = roundOf(state)
  const nowSec = Math.floor(now / 1000)

  // Where: a phone name only when it adds something the Phone column does not say.
  let where: string | null = null
  if (attempts.length > 1) where = `${attempts.length} phones`
  else if (attempts.length === 1 && attempts[0]!.deviceId !== post.assignedDeviceId) where = attemptPhone(attempts[0]!, devices)

  // When.
  let when: string | null = null
  let whenTitle: string | undefined
  if (bucket === 'running') {
    const started = inFlight.map((a) => a.startedAt).filter((s): s is number => typeof s === 'number')
    const sent = inFlight.filter((a) => a.at !== null).map((a) => a.at!)
    const sentAt = sent.length > 0 ? Math.min(...sent) : (state?.at ?? null)
    if (started.length > 0) when = `for ${span(nowSec - Math.min(...started))}`
    else when = sentAt === null ? 'waiting for its phone' : `waiting ${span(nowSec - sentAt)} for its phone`
  } else if (bucket === 'skipped') {
    // Not "sent": nothing was. When it was TURNED OFF is the only time this cell has, and it tells a
    // skip made when the session was created apart from one made an hour into the run.
    when = state?.at ? `skipped ${relativeTime(state.at, now)}` : null
  } else if (bucket === 'waiting') {
    if (post.notBeforeAt === null) when = 'session not started'
    else if (post.notBeforeAt > nowSec + 4) when = `turn ${fromNow(post.notBeforeAt, now)}`
    else {
      when = state?.note ?? 'waiting for a free phone'
      whenTitle = state?.note ?? undefined
    }
  } else {
    const settled = attempts.map((a) => a.settledAt).filter((s): s is number => s !== null)
    if (settled.length > 0) when = relativeTime(Math.max(...settled), now)
    else if (state?.at) when = `sent ${relativeTime(state.at, now)}`
  }

  // Why, for the two buckets that need one — ON the cell, not only in a tooltip (0.21.0): the tester
  // reads the script's own words and decides from them.
  let why: string | null = null
  let whyTitle: string | undefined
  let hint: string | null = null
  const single = unconfirmed.length === 1 ? unconfirmed[0]! : null
  if (bucket === 'skipped') {
    // The skip's own sentence, which names who decided it ("this phone carries the no-youtube
    // label"). Shown on the cell rather than only in a tooltip, for the same reason a failure's is:
    // the operator deciding whether to enable it reads the reason, not the word.
    why = state?.note ?? 'You turned this platform off for this video.'
    whyTitle = why
  } else if (bucket === 'failed') {
    why = failedNow.find((a) => a.error)?.error ?? state?.note ?? 'Failed without an error message — open the row for the run.'
    whyTitle = why
    hint = 'Retry failed on this row sends it again.'
  } else if (bucket === 'look') {
    if (state?.state === 'unsupported') why = 'Not supported in this build'
    else if (single !== null && failedNow.length === 0) {
      why = single.error ?? 'The script could not confirm the post appeared.'
      whyTitle = UNVERIFIED_MEANING
    } else if (unconfirmed.length > 1 && failedNow.length === 0) {
      why = `${unconfirmed.length} phones not confirmed — open the row to check and mark each.`
      whyTitle = UNVERIFIED_MEANING
    } else {
      why = state?.summary ?? state?.note ?? 'Some posted, some did not'
      whyTitle = state?.note ?? why
      if (failedNow.length > 0) hint = 'Retry failed on this row re-sends the failed phones only.'
    }
  }

  const line2 = [where, when].filter((s): s is string => s !== null && s !== '')

  /**
   * The one attempt this cell may be marked on (0.23.0): a lone not-confirmed one (posted or failed), or the
   * platform's only attempt when it is failed (Mark as posted) or posted (Remove posted mark). Several phones, or
   * anything still running, are marked per attempt in the row detail instead.
   */
  const only = attempts.length === 1 ? attempts[0]! : null
  const markable =
    bucket === 'running'
      ? null
      : single !== null && failedNow.length === 0
        ? single
        : only !== null && (only.state === 'failed' || only.state === 'success')
          ? only
          : null

  /**
   * Whether this cell may be turned off or on (0.45.0), and it mirrors `setPlatformSkip` exactly:
   * `skipped` offers Enable, a cell that has sent nothing offers Skip, and everything else offers
   * neither. `unsupported` is included in "sent nothing" for the same reason the member includes it —
   * there is nothing to overwrite — and skipping it replaces an explanation nobody can act on with a
   * decision they made.
   */
  const skippable = bucket === 'skipped' ? 'enable' : attempts.length === 0 && (state === undefined || state.state === 'pending' || state.state === 'unsupported') ? 'skip' : null

  return (
    <div className={cn('min-w-0 space-y-0.5 transition-opacity', dimmed && 'opacity-40')}>
      <div className="flex flex-wrap items-center gap-1">
        <span
          className={cn('inline-flex items-center gap-1.5 rounded-pill px-2 py-[2px] text-[11.5px] font-medium whitespace-nowrap', info.pill)}
          title={info.meaning}
        >
          <span className={cn('size-1.5 shrink-0 rounded-pill', info.dot, bucket === 'running' && 'animate-pulse')} aria-hidden />
          {info.word}
        </span>
        {round !== null && round > 1 ? (
          <span className="rounded-inner bg-muted-2 px-1.5 py-px text-[10.5px] whitespace-nowrap text-text-2" title="This is a retry. The state beside it is this attempt's.">
            attempt {round}
          </span>
        ) : null}
        {history.length > 0 ? (
          <span
            className="text-[10.5px] whitespace-nowrap text-faint"
            title={`${history.length} earlier attempt${history.length === 1 ? ' was' : 's were'} replaced by a retry. The state shown here is the current attempt — open the row to see the earlier ones.`}
          >
            +{history.length} earlier
          </span>
        ) : null}
      </div>
      {line2.length > 0 ? (
        <div className="max-w-[16rem] truncate text-[11px] text-dim" title={whenTitle ?? line2.join(' · ')}>
          {line2.join(' · ')}
        </div>
      ) : null}
      {why !== null ? (
        <div
          className={cn(
            'line-clamp-3 max-w-[16rem] text-[11px] leading-snug wrap-anywhere',
            bucket === 'failed' ? 'text-danger' : bucket === 'skipped' ? 'text-dim' : 'text-warn',
          )}
          title={whyTitle}
        >
          {why}
        </div>
      ) : null}
      {hint !== null ? <div className="max-w-[16rem] text-[10.5px] text-faint">{hint}</div> : null}
      {markable !== null && !dimmed ? (
        <div data-row-action className="pt-0.5">
          <MarkButtons post={post} platform={platform} attempt={markable} name={name} phone={attemptPhone(markable, devices)} outcome={outcome} />
        </div>
      ) : null}
      {skippable !== null && !dimmed ? (
        <div data-row-action className="pt-0.5">
          <SkipButton post={post} platform={platform} name={name} skipped={skippable === 'enable'} outcome={outcome} />
        </div>
      ) : null}
    </div>
  )
}

/**
 * Everything about one video, per platform: the current attempts, then the
 * earlier ones a retry replaced — dimmed, and labelled so they can never be
 * read as what is happening now.
 */
function VideoDetail({
  post,
  name,
  platforms,
  devices,
  now,
  outcome,
}: {
  post: Post
  name: string
  platforms: readonly string[]
  devices: ReadonlyMap<string, string>
  now: number
  outcome: OutcomeActions
}): ReactElement {
  const shown = platforms.filter((p) => hasPlatform(post, p))
  return (
    <div className="space-y-3">
      <p className="max-w-prose text-[11.5px] leading-relaxed whitespace-pre-wrap text-text-2">{post.caption}</p>
      <div className="grid gap-3 @3xl:grid-cols-2">
        {shown.map((platform) => {
          const state = post.dispatch[platform]
          const attempts = state?.attempts ?? []
          const earlier = [...(state?.history ?? [])].reverse()
          // A platform with nothing sent that is waiting or unsupported may be marked posted by hand (0.23.0) — here only,
          // never on the cell, where forty waiting rows would each grow a button.
          const unsent = attempts.length === 0 && (state === undefined || state.state === 'pending' || state.state === 'unsupported')
          const ownPhone = ownPhoneOf(post)
          return (
            <section key={platform} className="min-w-0 space-y-1.5 rounded-inner border border-line bg-panel px-3 py-2">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                <span className="text-[12px] font-medium text-text">{platformTitle(platform)}</span>
                <StateWord state={state?.state ?? 'pending'} />
                {attempts.some(markedByHand) ? <HandBadge /> : null}
              </div>
              {state?.note ? <p className="text-[11px] leading-relaxed text-dim">{state.note}</p> : null}
              {isCaptionPlatform(platform) && (post.platformCaptions[platform] ?? '') !== '' ? (
                <p className="line-clamp-3 text-[11px] leading-relaxed whitespace-pre-wrap text-text-2 wrap-anywhere" title={post.platformCaptions[platform]}>
                  <span className="text-faint">Caption: </span>
                  {post.platformCaptions[platform]}
                </p>
              ) : null}

              <div>
                <p className="text-[10.5px] font-medium tracking-wide text-faint uppercase">
                  {attempts.length > 1 ? `Current attempts (${attempts.length} phones)` : 'Current attempt'}
                </p>
                {attempts.length === 0 ? (
                  <p className="text-[11px] text-dim">
                    Nothing sent yet
                    {post.notBeforeAt === null
                      ? ' — the session has not been started.'
                      : post.notBeforeAt > Math.floor(now / 1000)
                        ? ` — its turn comes ${fromNow(post.notBeforeAt, now)}.`
                        : ' — waiting for a suitable phone to be free.'}
                  </p>
                ) : (
                  <ul className="mt-0.5 space-y-1">
                    {attempts.map((a) => (
                      <AttemptDetail
                        key={`${a.jobId}:${a.deviceId}`}
                        attempt={a}
                        devices={devices}
                        now={now}
                        actions={{ post, platform, name, outcome }}
                      />
                    ))}
                  </ul>
                )}
                {unsent ? (
                  <div className="mt-1">
                    {ownPhone !== null ? (
                      <MarkByHandButton post={post} platform={platform} name={name} phone={devices.get(ownPhone) ?? `device ${shortId(ownPhone)}`} outcome={outcome} />
                    ) : (
                      <p className="text-[11px] text-faint">
                        Posted it by hand? This video has no single phone of its own, so there is no account to record it against here.
                      </p>
                    )}
                  </div>
                ) : null}
              </div>

              {earlier.length > 0 ? (
                <div className="border-t border-line pt-1.5 opacity-70">
                  <p className="text-[10.5px] font-medium tracking-wide text-faint uppercase">Earlier attempts (replaced by a retry)</p>
                  <ul className="mt-0.5 space-y-1">
                    {earlier.map((a) => (
                      <AttemptDetail key={`${a.jobId}:${a.deviceId}:${a.round}`} attempt={a} devices={devices} now={now} earlier />
                    ))}
                  </ul>
                </div>
              ) : null}
            </section>
          )
        })}
      </div>
    </div>
  )
}

/** Same members, any order. */
function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  const set = new Set(a)
  return b.every((x) => set.has(x))
}

/**
 * Edit one video in place — inline, not a modal, so the attempts it is about
 * stay on screen under it.
 *
 * **Phone** is offered only for a one-per-phone row (`maxDevices === 1`). A
 * phone another video of this session owns stays choosable — the owner's call:
 * re-posting from that phone may be exactly what is meant — but carries that
 * video's name, and choosing it puts a warning above Save. Ownership is
 * computed the way the service computes it: another row's `assignedDeviceId`,
 * or the phone of another row's CURRENT attempt that did not fail.
 *
 * A row mid-upload is editable too, with a warning that the running upload
 * carries on as it started.
 *
 * What still blocks Save is only what the member refuses (`E_PARAMS_INVALID`):
 * no platform, an empty or over-long caption, a platform's own caption over
 * that platform's length. Save sends only the fields that differ from the row
 * as loaded; with nothing changed it stays disabled.
 *
 * **Caption per platform** (0.27.0) is one tab per chosen platform: empty posts
 * the shared text (shown under it), anything typed is exactly what that
 * platform posts.
 */
function EditPostForm({
  post,
  name,
  devices,
  fleet,
  owners,
  hasTags,
  tags,
  saving,
  onSave,
  onSaved,
  onClose,
}: {
  post: Post
  name: string
  devices: ReadonlyMap<string, string>
  fleet: readonly Device[]
  owners: ReadonlyMap<string, readonly Owner[]>
  /** Whether the video posts with any hashtag; only then may the caption be empty. */
  hasTags: boolean
  /** Every hashtag the shared text carries — for the preview of what a platform without its own caption posts. */
  tags: readonly string[]
  saving: boolean
  onSave: SaveEdit
  onSaved: (warnings: string[]) => void
  onClose: () => void
}): ReactElement {
  const ids = useId()
  /** The phones this video is uploading on right now — CURRENT attempts only. */
  const uploadingOn = [
    ...new Set(
      Object.values(post.dispatch).flatMap((s) => s.attempts.filter((a) => a.state === 'queued').map((a) => attemptPhone(a, devices))),
    ),
  ]
  const onePerPhone = post.maxDevices === 1
  const [phone, setPhone] = useState<string | null>(post.assignedDeviceId)
  const [chosen, setChosen] = useState<ReadonlySet<string>>(() => new Set(post.platforms))
  const [caption, setCaption] = useState(post.caption)
  // Every platform shows the caption it posts (0.28.0): its own, or the caption fitted to it while the row has none yet.
  const initialOwn = useMemo<Record<PlatformId, string>>(
    () => ({
      tiktok: post.platformCaptions.tiktok ?? sharedTextFor('tiktok', post.caption, tags),
      instagram: post.platformCaptions.instagram ?? sharedTextFor('instagram', post.caption, tags),
      youtube: post.platformCaptions.youtube ?? sharedTextFor('youtube', post.caption, tags),
    }),
    [post, tags],
  )
  const [ownTexts, setOwnTexts] = useState<Record<PlatformId, string>>(initialOwn)
  /** A new caption carries along every platform text that was still just the old caption fitted to that platform. */
  const changeCaption = (value: string): void => {
    setOwnTexts((prev) => {
      const out = { ...prev }
      for (const id of PLATFORM_IDS) if (prev[id].trim() === sharedTextFor(id, caption, tags).trim()) out[id] = sharedTextFor(id, value, tags)
      return out
    })
    setCaption(value)
  }
  const [ownTab, setOwnTab] = useState('')

  const options = useMemo(() => phoneOptions(post, fleet, devices, owners), [post, fleet, devices, owners])

  const postable = PLATFORMS.filter((p) => p.postable)
  const nextPlatforms = [...chosen]
  const ownPlatforms = PLATFORM_IDS.filter((id) => chosen.has(id))
  const activeTab = ownPlatforms.find((id) => id === ownTab) ?? ownPlatforms[0] ?? ''

  const changes: PostChanges = {}
  if (onePerPhone && phone !== null && phone !== post.assignedDeviceId) changes.assignedDeviceId = phone
  if (!sameSet(nextPlatforms, post.platforms)) changes.platforms = nextPlatforms
  if (caption !== post.caption) changes.caption = caption
  const ownChanges: Partial<Record<PlatformId, string>> = {}
  for (const id of PLATFORM_IDS) if (ownTexts[id].trim() !== initialOwn[id].trim()) ownChanges[id] = ownTexts[id]
  if (Object.keys(ownChanges).length > 0) changes.platformCaptions = ownChanges
  const dirty = Object.keys(changes).length > 0
  const ownProblem = PLATFORM_IDS.map((id) => (ownTexts[id].trim() === '' ? null : checkPlatformCaption(id, ownTexts[id]).error)).find((e) => e !== null) ?? null

  const platformProblem = postable.some((p) => chosen.has(p.id)) ? null : 'Choose at least one platform.'
  const captionProblem =
    caption.trim().length === 0 && !hasTags
      ? 'The caption cannot be empty while this video has no hashtags.'
      : caption.length > CAPTION_MAX
        ? `The caption is ${caption.length} characters; the limit is ${CAPTION_MAX}.`
        : null
  const canSave = dirty && platformProblem === null && captionProblem === null && ownProblem === null && !saving

  const phoneOwner = onePerPhone && phone !== null ? otherOwner(owners, phone, post.videoArtifactId) : undefined
  const phoneLabel = options.find((o) => o.value === phone)?.label ?? (phone !== null ? `device ${shortId(phone)}` : '')

  return (
    <form
      className="space-y-3 rounded-inner border border-line bg-panel px-3 py-3"
      aria-label={`Edit ${name}`}
      onSubmit={(e) => {
        e.preventDefault()
        if (canSave) onSave(post, changes, name, onSaved)
      }}
    >
      <p className="text-[12px] font-medium text-text">Edit “{name}”</p>

      {onePerPhone ? (
        <div className="space-y-1">
          <p id={`${ids}-phone`} className="text-[11.5px] font-medium text-text-2">
            Phone
          </p>
          <div className="w-full @md:w-96">
            <Combobox
              value={phone ?? ''}
              onValueChange={setPhone}
              options={options}
              placeholder="No phone assigned yet"
              searchPlaceholder="Search by #, name, label or group…"
              emptyText="No phone matches."
              disabled={saving}
              ariaLabel="Phone"
            />
          </div>
          <p className="text-[11px] leading-relaxed text-dim">
            The one phone that posts this video, on every platform and every retry. Type a number, name, label or group to find it. A phone
            another video in this session already has is marked with that video’s name.
          </p>
        </div>
      ) : null}

      <div className="space-y-1">
        <p id={`${ids}-platforms`} className="text-[11.5px] font-medium text-text-2">
          Platforms
        </p>
        <div className="flex flex-wrap gap-1.5" role="group" aria-labelledby={`${ids}-platforms`}>
          {postable.map((platform) => {
            const on = chosen.has(platform.id)
            return (
              <Button
                key={platform.id}
                type="button"
                size="sm"
                variant={on ? 'default' : 'outline'}
                aria-pressed={on}
                disabled={saving}
                onClick={() =>
                  setChosen((prev) => {
                    const copy = new Set(prev)
                    if (copy.has(platform.id)) copy.delete(platform.id)
                    else copy.add(platform.id)
                    return copy
                  })
                }
              >
                {platform.title}
              </Button>
            )
          })}
        </div>
        {platformProblem !== null ? <p className="text-[11px] text-danger">{platformProblem}</p> : null}
      </div>

      <div className="space-y-1">
        <div className="flex items-baseline gap-2">
          <label htmlFor={`${ids}-caption`} className="text-[11.5px] font-medium text-text-2">
            Caption
          </label>
          <span className={cn('readout text-[11px] tabular-nums', caption.length > CAPTION_MAX ? 'text-danger' : 'text-faint')}>
            {caption.length} / {CAPTION_MAX}
          </span>
        </div>
        <Textarea id={`${ids}-caption`} value={caption} onChange={(e) => changeCaption(e.target.value)} rows={3} disabled={saving} />
        {captionProblem !== null ? <p className="text-[11px] text-danger">{captionProblem}</p> : null}
      </div>

      {ownPlatforms.length > 0 ? (
        <div className="space-y-1">
          <p className="text-[11.5px] font-medium text-text-2">Caption per platform</p>
          <p className="max-w-prose text-[11px] leading-relaxed text-dim">
            Each platform posts its own caption, hashtags included, fitted to that platform’s limits from the caption and hashtags above. Editing
            the caption above updates every platform you have not edited by hand.
          </p>
          <Tabs value={activeTab} onValueChange={setOwnTab}>
            <TabsList>
              {ownPlatforms.map((id) => (
                <TabsTrigger key={id} value={id}>
                  {platformTitle(id)}
                  {ownTexts[id].trim() !== '' ? (
                    <>
                      <span className="ml-1 inline-block size-1.5 rounded-full bg-accent" aria-hidden />
                      <span className="sr-only"> (own caption)</span>
                    </>
                  ) : null}
                </TabsTrigger>
              ))}
            </TabsList>
            {ownPlatforms.map((id) => (
              <TabsContent key={id} value={id}>
                <PlatformCaptionField
                  platform={id}
                  value={ownTexts[id]}
                  shared={sharedTextFor(id, caption, tags)}
                  disabled={saving}
                  onChange={(text) => setOwnTexts((prev) => ({ ...prev, [id]: text }))}
                />
              </TabsContent>
            ))}
          </Tabs>
        </div>
      ) : null}

      <p className="max-w-prose text-[11.5px] leading-relaxed text-dim">
        Changes apply to the next attempt. A platform that already posted stays posted; failed ones go to the new phone when you press Retry failed;
        a newly added platform goes out at this video’s next turn.
      </p>
      {phoneOwner !== undefined ? (
        <p className="max-w-prose text-[11.5px] leading-relaxed text-warn">
          {phoneLabel} already has {phoneOwner}. Saving posts this video from that phone too.
        </p>
      ) : null}
      {uploadingOn.length > 0 ? (
        <p className="max-w-prose text-[11.5px] leading-relaxed text-warn">
          This video is uploading on {uploadingOn.join(', ')} right now. That upload continues as it started; your change applies to the next attempt.
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-1.5">
        <Button type="submit" size="sm" disabled={!canSave}>
          {saving ? <Spinner className="size-3.5" /> : null}
          Save
        </Button>
        <Button type="button" variant="ghost" size="sm" disabled={saving} onClick={onClose}>
          Cancel
        </Button>
        {!dirty ? <span className="text-[11px] text-faint">Nothing changed yet.</span> : null}
      </div>
    </form>
  )
}

/** What the pack does with a platform's text, in one line, from the same limits the service enforces. */
function limitLine(platform: PlatformId): string {
  const limit = PLATFORM_CAPTION_LIMITS[platform]
  if (platform === 'youtube') return `Typed as the Short’s title through adb: at most ${limit.maxLength} characters, one line, no emoji.`
  if (platform === 'instagram') return `Typed through adb: at most ${limit.maxLength} characters and ${limit.maxHashtags} hashtags, no emoji.`
  return `At most ${limit.maxLength} characters and ${limit.maxHashtags} hashtags. Emoji are fine.`
}

/** One platform's own caption in the edit form: the text, its count against that platform's limit, and what the pack will drop. */
function PlatformCaptionField({
  platform,
  value,
  shared,
  disabled,
  onChange,
}: {
  platform: PlatformId
  value: string
  /** The caption and hashtags above, fitted to this platform — what an empty text is saved as. */
  shared: string
  disabled: boolean
  onChange: (text: string) => void
}): ReactElement {
  const ids = useId()
  const limit = PLATFORM_CAPTION_LIMITS[platform]
  const text = value.trim()
  const check = text === '' ? null : checkPlatformCaption(platform, value)
  return (
    <div className="space-y-1 pt-1">
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={`${ids}-own`} className="text-[11.5px] font-medium text-text-2">
          {platformTitle(platform)} {platform === 'youtube' ? 'title' : 'caption'}
        </label>
        <span className={cn('readout text-[11px] tabular-nums', text.length > limit.maxLength ? 'text-danger' : 'text-faint')}>
          {text.length} / {limit.maxLength}
        </span>
        {shared !== '' && text !== shared.trim() ? (
          <Button type="button" variant="ghost" size="sm" className="ml-auto" disabled={disabled} onClick={() => onChange(shared)}>
            Fit from the caption
          </Button>
        ) : null}
      </div>
      <Textarea
        id={`${ids}-own`}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={platform === 'youtube' ? 2 : 3}
        disabled={disabled}
        placeholder="Empty — nothing to post here yet"
      />
      {text === '' && shared !== '' ? (
        <p className="line-clamp-3 text-[11px] whitespace-pre-line text-faint wrap-anywhere" title={shared}>
          Saved as: {shared}
        </p>
      ) : null}
      <p className="text-[11px] text-faint">{limitLine(platform)}</p>
      {check?.error ? <p className="text-[11px] text-danger">{check.error}</p> : null}
      {check?.warnings.map((w) => (
        <p key={w} className="text-[11px] text-warn">
          {w}
        </p>
      ))}
    </div>
  )
}

/** One attempt in full: round, phone, what it did, when it was sent and settled, the whole error, and the run. */
function AttemptDetail({
  attempt,
  devices,
  now,
  earlier = false,
  actions,
}: {
  attempt: AttemptRow
  devices: ReadonlyMap<string, string>
  now: number
  earlier?: boolean
  /** Given for CURRENT attempts only: an earlier one a retry replaced is history, never acted on. */
  actions?: { post: Post; platform: string; name: string; outcome: OutcomeActions }
}): ReactElement {
  const word = ATTEMPT_WORDS[attempt.state] ?? attempt.state
  const nowSec = Math.floor(now / 1000)
  return (
    <li className="text-[11px]">
      <AttemptLine attempt={attempt} devices={devices} now={now} nowSec={nowSec} word={word} earlier={earlier} />
      {attempt.error ? (
        <p className={cn('mt-0.5 max-w-prose leading-relaxed wrap-anywhere', attempt.state === 'unverified' ? 'text-warn' : 'text-danger')}>{attempt.error}</p>
      ) : null}
      {attempt.manual ? <p className="mt-0.5 max-w-prose leading-relaxed text-dim">No phone of the farm uploaded this — it was recorded as posted by hand.</p> : null}
      {attempt.resolution.map((mark, i) => (
        <p key={`${mark.at}:${i}`} className="mt-0.5 max-w-prose leading-relaxed wrap-anywhere text-dim">
          {mark.action === 'unmark-posted' ? 'Posted mark removed' : mark.to === 'posted' ? 'Marked as posted' : 'Marked as failed'} by hand{' '}
          {relativeTime(mark.at, now)}
          {mark.from !== null ? ` (it was ${ATTEMPT_WORDS[mark.from] ?? mark.from})` : ' (nothing had been sent)'}
          {mark.note ? ` — “${mark.note}”` : ''}
          {mark.reason && !(attempt.error ?? '').includes(mark.reason) ? `. Before: ${mark.reason}` : ''}
          {mark.byJobId ? (
            <>
              {' · '}
              <JobLink jobId={mark.byJobId} />
            </>
          ) : null}
        </p>
      ))}
      {actions && !earlier ? (
        <div className="mt-1">
          <MarkButtons
            post={actions.post}
            platform={actions.platform}
            attempt={attempt}
            name={actions.name}
            phone={attemptPhone(attempt, devices)}
            outcome={actions.outcome}
          />
        </div>
      ) : null}
      {actions && !earlier && attempt.state === 'failed' ? (
        <p className="mt-0.5 text-faint">Retry failed on this row sends it to this phone again.</p>
      ) : null}
    </li>
  )
}

/** The small "set by hand" badge: a person decided this state, not the upload script. */
function HandBadge(): ReactElement {
  return (
    <Badge variant="outline" className="px-1.5 py-0 text-[10px]" title="A person set this state by hand — it was not confirmed by the upload script">
      set by hand
    </Badge>
  )
}

/**
 * The hand marks one attempt allows, each behind a confirm that says exactly what follows (0.21.0; every state since
 * 0.23.0). Shared by the table cell and the row detail, so the two can never word the decision differently:
 *
 * - not confirmed → Mark as posted, Mark as failed
 * - failed → Mark as posted
 * - posted → Remove posted mark
 * - running → Mark as posted (the member refuses while its job is still running)
 */
function MarkButtons({
  post,
  platform,
  attempt,
  name,
  phone,
  outcome,
}: {
  post: Post
  platform: string
  attempt: AttemptRow
  name: string
  phone: string
  outcome: OutcomeActions
}): ReactElement | null {
  const busy = outcome.busy(post)
  const title = platformTitle(platform)
  const where = `${title} on ${phone}`
  const markPosted = (
    <ConfirmDialog
      trigger={
        <Button
          variant={attempt.state === 'unverified' ? 'outline' : 'ghost'}
          size="sm"
          disabled={busy}
          title={`The video is on the ${title} account, whatever the farm recorded`}
        >
          Mark as posted
        </Button>
      }
      title={`Mark “${name}” as posted on ${where}?`}
      destructive={false}
      confirmLabel="Mark as posted"
      description={
        <>
          Do this only after seeing the video on the {title} account. It counts as posted, and the farm will <strong>never send this video to{' '}
          {title} again</strong> — Retry failed, on this row or for the session, leaves it alone.
          {attempt.state === 'failed' || attempt.state === 'unverified' ? ' What the farm recorded stays on the record.' : ''}
          {attempt.state === 'queued' ? ' Its upload must have finished first: while it is still running this is refused.' : ''} Remove posted
          mark undoes it.
        </>
      }
      onConfirm={() => outcome.onMark(post, platform, attempt, 'mark-posted', name)}
    />
  )

  if (attempt.state === 'success') {
    return (
      <div className="flex flex-wrap items-center gap-1">
        <ConfirmDialog
          trigger={
            <Button variant="ghost" size="sm" disabled={busy} title={`The video is NOT on the ${title} account — make it retryable`}>
              Remove posted mark
            </Button>
          }
          title={`Remove the posted mark from “${name}” on ${where}?`}
          destructive={false}
          confirmLabel="Remove posted mark"
          description={
            <>
              Do this only after checking the {title} account and NOT finding the video. It counts as failed, and <strong>Retry failed</strong> (on
              this row or for the session) will send it to {phone} again. If the video is actually there, that retry posts it twice.
            </>
          }
          onConfirm={() => outcome.onMark(post, platform, attempt, 'unmark-posted', name)}
        />
      </div>
    )
  }
  if (attempt.state === 'failed' || attempt.state === 'queued') return <div className="flex flex-wrap items-center gap-1">{markPosted}</div>
  if (attempt.state !== 'unverified') return null
  return (
    <div className="flex flex-wrap items-center gap-1">
      {markPosted}
      <ConfirmDialog
        trigger={
          <Button variant="ghost" size="sm" disabled={busy} title={`You checked the ${title} account and the video is not there`}>
            Mark as failed
          </Button>
        }
        title={`Mark “${name}” as failed on ${where}?`}
        destructive={false}
        confirmLabel="Mark as failed"
        description={
          <>
            Do this only after checking the account on the phone and NOT finding the video. The post counts as failed, and{' '}
            <strong>Retry failed</strong> (on this row or for the session) will send it to this phone again. If the video is actually there, a
            retry posts it twice.
          </>
        }
        onConfirm={() => outcome.onMark(post, platform, attempt, 'mark-failed', name)}
      />
    </div>
  )
}

/** Mark as posted for a platform nothing was sent to — the video was posted by hand outside the farm (0.23.0). */
function MarkByHandButton({ post, platform, name, phone, outcome }: { post: Post; platform: string; name: string; phone: string; outcome: OutcomeActions }): ReactElement {
  const title = platformTitle(platform)
  return (
    <ConfirmDialog
      trigger={
        <Button variant="ghost" size="sm" disabled={outcome.busy(post)} title={`You posted this video to ${title} yourself, outside the farm`}>
          Mark as posted (done by hand)
        </Button>
      }
      title={`Mark “${name}” as posted on ${title}, done by hand?`}
      destructive={false}
      confirmLabel="Mark as posted"
      description={
        <>
          No phone of the farm sent this. It is recorded as posted by hand on {phone}’s account, and the farm will <strong>never send this video
          to {title}</strong>. Remove posted mark undoes it, and Retry failed then sends it to {phone}.
        </>
      }
      onConfirm={() => outcome.onMark(post, platform, null, 'mark-posted', name)}
    />
  )
}

/**
 * Turn one platform off for one video, or back on (0.45.0).
 *
 * Offered on exactly two kinds of cell, and on nothing else: one that has sent nothing (**Skip**) and
 * one already skipped (**Enable**). Everything between them is a record of what a phone did, which a
 * skip may not overwrite — so there is no button, rather than a button whose only possible answer is
 * the member's refusal.
 *
 * Skip is not behind a confirm and Enable is. That looks backwards and is not: skipping sends nothing
 * and is undone by the button that replaces it, while enabling puts a real video on a real account at
 * the next turn — the direction that cannot be taken back is the one that asks.
 */
function SkipButton({ post, platform, name, skipped, outcome }: { post: Post; platform: string; name: string; skipped: boolean; outcome: OutcomeActions }): ReactElement {
  const busy = outcome.busy(post)
  const title = platformTitle(platform)
  if (!skipped) {
    return (
      <Button variant="ghost" size="sm" disabled={busy} title={`Do not post this video to ${title}. Nothing is sent, and you can enable it again.`} onClick={() => outcome.onSkip(post, platform, true, name)}>
        Skip
      </Button>
    )
  }
  return (
    <ConfirmDialog
      trigger={
        <Button variant="outline" size="sm" disabled={busy} title={`Post this video to ${title} after all`}>
          Enable
        </Button>
      }
      title={`Post “${name}” to ${title} after all?`}
      destructive={false}
      confirmLabel="Enable"
      description={
        <>
          This platform goes back to <strong>waiting</strong> and is sent to this video’s phone at its next turn — within a minute on a session
          that is already running. Make sure the phone is signed in to {title}, or the upload fails there.
        </>
      }
      onConfirm={() => outcome.onSkip(post, platform, false, name)}
    />
  )
}

/** A row's own Retry failed: this one video, to the phones where it failed, behind a confirm. */
function RetryVideoButton({ post, name, outcome, deleted }: { post: Post; name: string; outcome: OutcomeActions; deleted: boolean }): ReactElement {
  const busy = outcome.busy(post)
  // A deleted file cannot be sent again (0.34.0): the button says why instead of re-sending a job that can only fail.
  if (deleted) {
    return (
      <Button variant="outline" size="sm" disabled title="This video's file was deleted from Files, so it cannot be sent again. Upload it again and add it to a new session.">
        <ArrowsClockwiseIcon aria-hidden />
        Retry failed
      </Button>
    )
  }
  return (
    <ConfirmDialog
      trigger={
        <Button variant="outline" size="sm" disabled={busy} title="Send this video again to the phones where it failed">
          <ArrowsClockwiseIcon aria-hidden />
          Retry failed
        </Button>
      }
      title={`Retry “${name}” where it failed?`}
      destructive={false}
      confirmLabel="Retry failed"
      description={
        <>
          This video is sent again, now, to the phone where its upload <strong>failed</strong>, on every platform that failed. A platform that
          posted is left alone, and so is one that was not confirmed — mark that one first. It goes out straight away, not at a paced turn.
        </>
      }
      onConfirm={() => outcome.onRetry(post, name)}
    />
  )
}

/** The first line of an attempt: round, phone, what it did, when, and the run. */
function AttemptLine({
  attempt,
  devices,
  now,
  nowSec,
  word,
  earlier,
}: {
  attempt: AttemptRow
  devices: ReadonlyMap<string, string>
  now: number
  nowSec: number
  word: string
  earlier: boolean
}): ReactElement {
  return (
    <>
      <div className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
        <span className="rounded-inner bg-muted-2 px-1.5 py-px text-[10.5px] text-text-2">
          {earlier ? 'earlier · ' : ''}attempt {attempt.round}
        </span>
        <span className="text-text-3">{attemptPhone(attempt, devices)}</span>
        <span className={cn(ATTEMPT_TONES[attempt.state] ?? 'text-dim')} title={attempt.state === 'unverified' ? UNVERIFIED_MEANING : undefined}>
          {word}
        </span>
        {markedByHand(attempt) ? <HandBadge /> : null}
        {attempt.at !== null ? <span className="text-faint">{attempt.manual ? 'marked' : 'sent'} {relativeTime(attempt.at, now)}</span> : null}
        {attempt.manual ? null : attempt.settledAt !== null ? (
          <span className="text-faint">finished {relativeTime(attempt.settledAt, now)}</span>
        ) : attempt.state === 'queued' && attempt.at !== null ? (
          <span className="text-faint">running for {span(nowSec - attempt.at)}</span>
        ) : null}
        {hasRun(attempt.jobId) ? <JobLink jobId={attempt.jobId} /> : null}
      </div>
    </>
  )
}

/** The sentence for a session the farm has not reported on — said, never left as a blank. */
const NOT_REPORTED = 'Nothing reported yet — the farm has not looked at this session since it was made.'

/**
 * One session on the list: what it is, how far it has got, what broke, and the
 * way in.
 *
 * The title is the way in — a real button, so it is reachable from the
 * keyboard — and the rest of the row is for reading. Platforms and pacing have
 * their own columns on a wide box; on a narrow one they move under the title
 * rather than vanish, because pacing is what explains a session that looks
 * stuck.
 */
function SessionRow({
  group,
  onOpen,
  busy,
  onStart,
  onRetry,
  onStop,
  onRemove,
}: {
  group: Group
  onOpen: () => void
  busy: boolean
  onStart: () => void
  onRetry: () => void
  onStop: (action: 'stop' | 'start' | 'pause') => void
  onRemove: () => void
}): ReactElement {
  const p = group.progress
  const total = p?.total ?? group.videoArtifactIds.length
  const platforms = group.platforms.map(platformTitle).join(', ')
  const pacing = pacingLine(group)
  const quiet = p !== null && p.running === 0 && p.waiting === 0 && p.failed === 0 && p.attention === 0
  // A session finishes when nothing is left to send, and a skipped platform is nothing left to send
  // (0.45.0). Without this, four skips held "All posted" back forever on a session that was done.
  const allDone = p !== null && total > 0 && p.posted + p.skipped === total

  return (
    <TableRow>
      <TableCell className="min-w-[12rem]">
        <button
          type="button"
          onClick={onOpen}
          className="rounded-small text-left text-row font-medium wrap-anywhere text-text underline-offset-2 outline-none hover:text-accent hover:underline focus-visible:ring-2 focus-visible:ring-accent/40"
        >
          {group.title}
        </button>
        {/* Said on the row, not only by the absence of a Stop button: a stopped session that still shows "4 waiting" otherwise reads as one that is stuck. */}
        {group.stopped ? (
          <Badge variant="outline" className="ml-1.5 align-middle text-warn">
            paused
          </Badge>
        ) : null}
        {/* A pause the router made itself says why, or it reads as a stop nobody pressed. */}
        {autoPauseOf(group)?.reason ? <div className="mt-0.5 text-[11px] text-warn">{autoPauseOf(group)?.reason}</div> : null}
        <div className="mt-0.5 text-[11px] text-faint">{relativeTime(group.createdAt)}</div>
        <div className="text-[11px] text-faint @2xl:hidden">{platforms}</div>
        <div className="text-[11px] text-faint @5xl:hidden">{pacing}</div>
      </TableCell>
      <TableCell className="hidden text-[12px] text-text-2 @2xl:table-cell">{platforms}</TableCell>
      <TableCell>
        {/* Posted-only on purpose; failures are never drawn as progress, they are counted in Status. */}
        <div className="flex min-w-[8rem] flex-col gap-1">
          <Progress value={percent(p?.posted ?? 0, total)} className="w-full" />
          <span className="readout text-[11.5px] whitespace-nowrap text-dim">
            {p?.posted ?? 0} of {total} posted
          </span>
        </div>
      </TableCell>
      <TableCell>
        {p === null ? (
          <span className="text-[11.5px] text-dim" title={NOT_REPORTED}>
            Nothing reported yet
          </span>
        ) : quiet ? (
          allDone ? (
            <span className="text-[11.5px] text-ok">{p.skipped > 0 ? `All posted, ${p.skipped} skipped` : 'All posted'}</span>
          ) : (
            <span className="text-faint">—</span>
          )
        ) : (
          <div className="flex flex-wrap items-center gap-1">
            <ProgressBadges group={group} />
          </div>
        )}
      </TableCell>
      <TableCell className="hidden text-[11.5px] text-dim @5xl:table-cell">{pacing}</TableCell>
      <TableCell>
        <SessionActions group={group} busy={busy} onStart={onStart} onRetry={onRetry} onStop={onStop} onRemove={onRemove} className="flex-nowrap" />
      </TableCell>
    </TableRow>
  )
}

/**
 * Running, waiting, failed, needs a look — as badges, only the ones that are
 * non-zero. Shared by the list's Status column and the session page's header
 * so the two can never word a count differently.
 */
function ProgressBadges({ group }: { group: Group }): ReactElement | null {
  const p = group.progress
  if (p === null) return null
  return (
    <>
      {p.running > 0 ? <Badge variant="default">{p.running} running</Badge> : null}
      {p.waiting > 0 ? <Badge variant="secondary">{p.waiting} waiting</Badge> : null}
      {/* Never folded into anything softer: a session with failures says how
          many, before anything is opened. */}
      {p.failed > 0 ? <Badge variant="destructive">{p.failed} failed</Badge> : null}
      {p.attention > 0 ? (
        <Badge variant="warn" title="Some posted and some did not, or a result could not be confirmed. Open the session to see which phone.">
          {p.attention} need a look
        </Badge>
      ) : null}
      {/* Last, and `secondary`: a skip is neither progress nor a problem, and it is here only so the
          count in front of it is never read as "four went missing". */}
      {p.skipped > 0 ? (
        <Badge variant="secondary" title="Platforms you turned off for a phone. Nothing was sent, and nothing failed. Open the session to enable one again.">
          {p.skipped} skipped
        </Badge>
      ) : null}
    </>
  )
}

/**
 * The header of a session's own page: title, the farm's own summary line, the
 * three actions, the progress bar and the pacing.
 */
function SessionHead({
  group,
  busy,
  onStart,
  onRetry,
  onStop,
  onRemove,
  onEditPacing,
}: {
  group: Group
  busy: boolean
  onStart: () => void
  onRetry: () => void
  onStop: (action: 'stop' | 'start' | 'pause') => void
  onRemove: () => void
  onEditPacing: (edit: PacingChange, onDone: () => void) => void
}): ReactElement {
  const [editingPacing, setEditingPacing] = useState(false)
  const p = group.progress
  const total = p?.total ?? group.videoArtifactIds.length
  const summary = summaryLine(group)

  return (
    <>
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 grow">
          <h2 className="text-row font-medium wrap-anywhere text-text">{group.title}</h2>
          <p className="mt-0.5 text-[11.5px] leading-relaxed text-dim">{summary ?? NOT_REPORTED}</p>
        </div>
        <SessionActions group={group} busy={busy} onStart={onStart} onRetry={onRetry} onStop={onStop} onRemove={onRemove} className="shrink-0 flex-wrap" />
      </div>

      {/* How far along, and what that number leaves out. The bar is posted-only
          on purpose; failures are never drawn as progress, they are counted
          beside it in their own words. */}
      <div className="mt-3 flex flex-wrap items-center gap-x-2.5 gap-y-1">
        <Progress value={percent(p?.posted ?? 0, total)} className="min-w-[120px] max-w-xs grow" />
        <span className="readout text-[11.5px] text-dim">
          {p?.posted ?? 0} of {total} posted
        </span>
        <ProgressBadges group={group} />
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-faint">
        <span>{relativeTime(group.createdAt)}</span>
        <span aria-hidden>·</span>
        <span>{group.platforms.map(platformTitle).join(', ')}</span>
        <span aria-hidden>·</span>
        <span>{pacingLine(group)}</span>
        <Button type="button" variant="ghost" size="sm" className="h-6 px-1.5 text-[11px]" disabled={busy} onClick={() => setEditingPacing((open) => !open)}>
          <PencilSimpleIcon aria-hidden />
          Edit pacing
        </Button>
      </div>
      {editingPacing ? (
        <PacingForm group={group} busy={busy} onSave={(edit) => onEditPacing(edit, () => setEditingPacing(false))} onClose={() => setEditingPacing(false)} />
      ) : null}
    </>
  )
}

/** A session's new pacing, as `smm/update-group` takes it (0.30.0). */
type PacingChange = { concurrency: number; gapMinSec: number; gapMaxSec: number }

/**
 * "At once" and the gap range of a session that already exists (0.30.0). The owner (2026-09-15): the pacing chosen when a
 * session was made could not be changed afterwards. Saves only a valid change; says what each half affects.
 */
function PacingForm({ group, busy, onSave, onClose }: { group: Group; busy: boolean; onSave: (edit: PacingChange) => void; onClose: () => void }): ReactElement {
  const ids = useId()
  const lo0 = Math.min(group.pacing.gapSec[0], group.pacing.gapSec[1])
  const hi0 = Math.max(group.pacing.gapSec[0], group.pacing.gapSec[1])
  const [concurrency, setConcurrency] = useState(String(group.pacing.concurrency))
  const [gapMin, setGapMin] = useState(String(lo0))
  const [gapMax, setGapMax] = useState(String(hi0))
  const read = (s: string): number => (/^\d+$/.test(s.trim()) ? Number.parseInt(s, 10) : Number.NaN)
  const c = read(concurrency)
  const a = read(gapMin)
  const b = read(gapMax)
  const valid = c >= 1 && c <= 500 && a >= 0 && a <= 86_400 && b >= 0 && b <= 86_400
  const edit: PacingChange = { concurrency: c, gapMinSec: Math.min(a, b), gapMaxSec: Math.max(a, b) }
  const dirty = valid && (edit.concurrency !== group.pacing.concurrency || edit.gapMinSec !== lo0 || edit.gapMaxSec !== hi0)
  const field = (id: string, label: string, value: string, set: (v: string) => void, min: number, max: number): ReactElement => (
    <div className="space-y-1">
      <label htmlFor={`${ids}-${id}`} className="block text-[11.5px] font-medium text-text-2">
        {label}
      </label>
      <Input id={`${ids}-${id}`} type="number" min={min} max={max} value={value} onChange={(e) => set(e.target.value)} disabled={busy} className="h-8 w-28" />
    </div>
  )
  return (
    <form
      className="mt-2 space-y-2 rounded-inner border border-line bg-panel px-3 py-2.5"
      onSubmit={(e) => {
        e.preventDefault()
        if (dirty && !busy) onSave(edit)
      }}
    >
      <div className="flex flex-wrap items-end gap-3">
        {field('at-once', 'At once', concurrency, setConcurrency, 1, 500)}
        {field('gap-from', 'Gap from (s)', gapMin, setGapMin, 0, 86_400)}
        {field('gap-to', 'Gap to (s)', gapMax, setGapMax, 0, 86_400)}
      </div>
      <p className="max-w-prose text-[11px] leading-relaxed text-dim">
        “At once” applies from the next video the farm sends. A new gap spaces again the videos whose turn has not come yet; a video already sent or
        posted is left as it is.
      </p>
      {!valid ? <p className="text-[11px] text-danger">“At once” is a whole number from 1 to 500, and each gap from 0 to 86400 seconds.</p> : null}
      <div className="flex flex-wrap items-center gap-1.5">
        <Button type="submit" size="sm" disabled={!dirty || busy}>
          Save
        </Button>
        <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={onClose}>
          Cancel
        </Button>
        {valid && !dirty ? <span className="text-[11px] text-faint">Nothing changed yet.</span> : null}
      </div>
    </form>
  )
}

/**
 * Start, Retry failed and Remove, each behind its confirmation — the one copy
 * of them, drawn by both the list's rows and a session's own page.
 *
 * One component rather than two similar ones, because the wording of Start,
 * Retry and Remove is the most consequential text in this plugin — each one
 * publishes to, or stops publishing to, somebody's real account — and two
 * copies of it would drift apart on the first edit.
 */
function SessionActions({
  group,
  busy,
  onStart,
  onRetry,
  onStop,
  onRemove,
  className,
}: {
  group: Group
  busy: boolean
  onStart: () => void
  onRetry: () => void
  onStop: (action: 'stop' | 'start' | 'pause') => void
  onRemove: () => void
  className?: string
}): ReactElement {
  const total = group.progress?.total ?? group.videoArtifactIds.length
  return (
    <div className={cn('flex items-center justify-end gap-1.5', className)}>
      {/*
        A stopped session offers Start again, and NOT Start or Retry failed.
        The two Starts mean different things — give the waiting videos their
        turns, versus let this session send at all — and side by side the
        operator has to guess which one they need. Retry failed is worse than
        useless while stopped: it re-queues rows the gate will not send, so it
        looks like it did nothing.
      */}
      {group.stopped ? (
        <Button size="sm" disabled={busy} onClick={() => onStop('start')}>
          <PlayIcon aria-hidden />
          Play
        </Button>
      ) : null}
      {group.stopped ? null : (
      <ConfirmDialog
        trigger={
          <Button size="sm" disabled={busy}>
            <PlayIcon aria-hidden />
            Start
          </Button>
        }
        title={`Start “${group.title}”?`}
        destructive={false}
        confirmLabel="Start"
        description={
          <>
            Every video in this session is given its turn: the first goes now and the rest are spread{' '}
            <span className="readout">{pacingLine(group)}</span>. Phones post as their turn comes, so this finishes minutes or hours from now, not
            at once. Starting a session that is already part-way through only gives a turn to videos that never got one — nothing that has already
            posted is posted again.
          </>
        }
        onConfirm={onStart}
      />
      )}

      {group.stopped ? null : (
      <ConfirmDialog
        trigger={
          <Button variant="outline" size="sm" disabled={busy}>
            <ArrowsClockwiseIcon aria-hidden />
            Retry failed
          </Button>
        }
        title={`Retry the failures in “${group.title}”?`}
        destructive={false}
        confirmLabel="Retry failed"
        description={
          <>
            Only the phones whose upload <strong>failed</strong> are sent again, re-spaced by this session’s own gaps.
            <br />A phone that already posted is left alone — re-sending it would put the same video on that account twice, and that cannot be
            undone. A post that was <strong>not confirmed</strong> is left alone for the same reason: it may well have posted. Check that account on
            the phone and use Mark as posted or Mark as failed on its row — a post marked as failed is retried here.
          </>
        }
        onConfirm={onRetry}
      />
      )}

      {/* Pause (0.64.0): nothing new goes out, and a video already on a phone is left to finish. */}
      {group.stopped ? null : (
        <Button variant="outline" size="sm" disabled={busy} onClick={() => onStop('pause')}>
          <PauseIcon aria-hidden />
          Pause
        </Button>
      )}

      {group.stopped ? null : (
        <ConfirmDialog
          trigger={
            <Button variant="outline" size="sm" disabled={busy}>
              <SquareIcon aria-hidden />
              Stop
            </Button>
          }
          title={`Stop “${group.title}”?`}
          destructive
          confirmLabel="Stop"
          description={
            <>
              Every upload this session has <strong>running right now</strong> is cancelled on its phone, and goes back into the queue. Nothing more
              is sent until you start it again.
              <br />
              Anything that already posted stays posted — a stop never undoes a post, and the session keeps every row saying what each phone did.
            </>
          }
          onConfirm={() => onStop('stop')}
        />
      )}

      <ConfirmDialog
        trigger={
          <Button variant="ghost" size="sm" disabled={busy} aria-label={`Remove ${group.title}`}>
            <TrashIcon aria-hidden />
            Remove
          </Button>
        }
        title={`Remove “${group.title}” and stop what is left?`}
        confirmLabel="Remove and stop"
        description={
          <>
            Removing the session STOPS it: whatever has not gone out yet stays where it is and is never sent. What has already posted stays
            posted — that cannot be taken back — and the video rows keep their own record of it. What you lose is this session's entry, the place these{' '}
            {total} video{total === 1 ? '' : 's'} are watched and retried together.
          </>
        }
        onConfirm={onRemove}
      />
    </div>
  )
}

/**
 * The way back to what actually happened on the phone.
 *
 * A plain `<a>`, and deliberately: Studio's own screens use `next/link` because
 * an internal link must not remount React and kill a live socket, but a plugin
 * view cannot import `next/link` — `@enkaku/ui` is the whole of what it may
 * reach. Leaving the farm's own Jobs screen is a real navigation anyway, and
 * this panel holds no socket to lose.
 *
 * The query key is `job`, not `id`: `JobsScreen` reads `params.get('job')`
 * (`packages/studio/src/components/jobs/JobsScreen.tsx`), and a link that
 * opened the list with nothing selected would be a link that lies about where
 * it goes.
 */
function JobLink({ jobId }: { jobId: string }): ReactElement {
  return (
    <a
      href={`/jobs?job=${encodeURIComponent(jobId)}`}
      className="readout rounded-small text-accent underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-accent/40"
      title={`Open job ${jobId} on the Jobs screen`}
    >
      run
    </a>
  )
}
