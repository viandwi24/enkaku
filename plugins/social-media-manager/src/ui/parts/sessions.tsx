import { useCallback, useEffect, useId, useMemo, useRef, useState, type MouseEvent, type ReactElement } from 'react'
import {
  ArrowsClockwiseIcon,
  Badge,
  Button,
  CaretLeftIcon,
  CaretRightIcon,
  Card,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  FilmStripIcon,
  LoadingRows,
  PencilSimpleIcon,
  PlayIcon,
  Progress,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Spinner,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Textarea,
  TrashIcon,
  api,
  cn,
  relativeTime,
  useAction,
  z,
} from '@enkaku/ui'
import {
  CORE,
  PLATFORMS,
  deviceName,
  listDevices,
  listGroups,
  listPosts,
  listVideos,
  pickHost,
  runMember,
  type Device,
  type Group,
  type Post,
} from '../shared'

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
 * A row's expansion also carries **Edit** — the video's bound phone, its
 * platforms and its caption, written by the service's own `smm/update-post`
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
 * with failures shows the number, on the card, before anything is opened.
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
}

type SaveEdit = (post: Post, changes: PostChanges, name: string, onDone: (warnings: string[]) => void) => void

/** The caption limit the member enforces, repeated so the form can say so before Save rather than after. */
const CAPTION_MAX = 2200

/** The router's own sentence for a one-per-phone row that found no phone to bind. Matched, not paraphrased. */
const NO_PHONE_LEFT = 'No phone is left for this video'

type PlatformState = Post['dispatch'][string]
type AttemptRow = PlatformState['attempts'][number]

interface Loaded {
  groups: Group[]
  posts: Post[]
  /** Artifact id → the operator's own name for that video. Missing when the upload has since been deleted. */
  videos: Map<string, string>
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
  const [groups, posts, videos, devices] = await Promise.all([
    listGroups(),
    listPosts(),
    listVideos().catch(() => []),
    listDevices().catch(() => []),
  ])
  const names = new Map<string, string>()
  for (const video of videos) {
    const label = video.label?.trim()
    if (label) names.set(video.id, label)
  }
  const phones = new Map<string, string>()
  for (const device of devices) phones.set(device.id, deviceName(device))
  return { groups, posts, videos: names, devices: phones, fleet: devices }
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
}

const STATE_TONES: Record<string, string> = {
  pending: 'bg-faint-2',
  dispatched: 'bg-accent',
  succeeded: 'bg-ok',
  partial: 'bg-warn',
  failed: 'bg-danger',
  unsupported: 'bg-faint-2',
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
  unverified: 'unverified',
}

const ATTEMPT_TONES: Record<string, string> = {
  queued: 'text-accent',
  success: 'text-ok',
  failed: 'text-danger',
  unverified: 'text-warn',
}

/** Why `unverified` is not an error, on the word itself — the one state nobody guesses right. */
const UNVERIFIED_MEANING =
  'The job finished but the script could not confirm the post appeared. It is never retried on its own, because if it did land a retry would post the same video twice.'

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
    () => (data?.groups ?? []).some((g) => g.progress === null || g.progress.running > 0 || g.progress.waiting > 0),
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

  const busy = (group: Group): boolean =>
    isPending(`start:${group.id}`) || isPending(`retry:${group.id}`) || isPending(`remove:${group.id}`)

  return { startSession, retrySession, removeSession, updatePost, saving, busy }
}

/** One shared empty map, so a render before the first load does not allocate one per card. */
const EMPTY_MAP: ReadonlyMap<string, string> = new Map<string, string>()
const EMPTY_FLEET: readonly Device[] = []
const NO_WARNINGS: readonly string[] = []

/**
 * The front page: every session, newest first, and nothing about any one of
 * them that does not fit on a card.
 *
 * What is deliberately NOT here is the videos. A session of forty carries forty
 * names, forty captions, up to eighty platform lines and every phone under
 * them — expanded inline, two open sessions made a page nobody could scan. So a
 * card answers the two questions a list is for, *is it out yet* and *what
 * broke*, and opening it goes to the session's own page for the rest.
 */
export function SessionsPanel({ refreshKey, onOpen }: { refreshKey: number; onOpen: (groupId: string) => void }): ReactElement {
  const { data, error, loading, reload } = useSessionsData(refreshKey)
  const { startSession, retrySession, removeSession, busy } = useSessionActions(reload)

  const groups = data?.groups ?? []

  return (
    /**
     * `@container`, not a viewport breakpoint — this panel does not know how
     * wide the box it is in happens to be, and a `lg:` here would be a claim
     * about the window instead.
     */
    <div className="@container space-y-2.5 pt-1">
      <div className="flex items-center gap-2">
        {/* The spinner is for a REFRESH, and only while rows are already on
            screen — the first load draws skeletons instead. A panel whose rows
            vanish every ten seconds looks broken while working perfectly. */}
        {loading && data !== null ? <Spinner className="size-3.5 text-faint" /> : null}
        <div className="grow" />
        <Button variant="outline" size="sm" onClick={reload}>
          <ArrowsClockwiseIcon aria-hidden />
          Refresh
        </Button>
      </div>

      {/* The last refresh failed and an older picture is still up. Said out
          loud, quietly, rather than either hiding it or throwing away rows the
          operator is reading. */}
      {error !== null && data !== null ? (
        <p className="rounded-inner border border-warn/35 px-3 py-2 text-[11.5px] leading-relaxed text-dim">
          The last refresh did not get through, so what is below is from a moment ago. {error}
        </p>
      ) : null}

      {loading && data === null ? (
        <LoadingRows rows={2} />
      ) : error !== null && data === null ? (
        <ErrorState message={error} onRetry={reload} />
      ) : groups.length === 0 ? (
        <EmptyState
          icon={<FilmStripIcon className="size-4" aria-hidden />}
          title="No sessions yet"
          description="Open “New session”, drop in your videos, choose where they go and how fast — the session appears here, with every video, every phone and every failure in it."
        />
      ) : (
        groups.map((group) => (
          <SessionCard
            key={group.id}
            group={group}
            onOpen={() => onOpen(group.id)}
            busy={busy(group)}
            onStart={() => startSession(group)}
            onRetry={() => retrySession(group)}
            onRemove={() => removeSession(group)}
          />
        ))
      )}
    </div>
  )
}

/* ------------------------------------------------------------------------ *
 * The session page's vocabulary: buckets, cells, and the live line.
 * ------------------------------------------------------------------------ */

/**
 * The five things one post (one video on one platform) can be doing, as far as
 * an operator's next move is concerned. Every cell lands in exactly one, so the
 * chips always add up to All.
 */
type Bucket = 'running' | 'waiting' | 'posted' | 'failed' | 'look'
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
      'Some phones posted and some did not, a result could not be confirmed, or the platform is not supported in this build. None of these is retried on its own.',
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
 * - `unsupported` → Needs a look
 * - `dispatched`, or any current attempt still `queued` → Running
 * - `succeeded` → Posted
 * - `failed` → Failed
 * - `partial` (which is also where `unverified` lands) or a state this build
 *   does not know → Needs a look
 */
function bucketOf(state: PlatformState | undefined): Bucket {
  if (!state || state.state === 'pending') return state?.attempts.some((a) => a.state === 'queued') ? 'running' : 'waiting'
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
  const { startSession, retrySession, removeSession, updatePost, saving, busy } = useSessionActions(reload, onBack)
  const now = useNow(TICK_MS)

  const group = (data?.groups ?? []).find((g) => g.id === groupId) ?? null
  const posts = useMemo(() => postsOf(data, groupId), [data, groupId])
  const videos = data?.videos ?? EMPTY_MAP
  const devices = data?.devices ?? EMPTY_MAP

  return (
    <div className="@container space-y-3 py-4">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" onClick={onBack}>
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

      {error !== null && data !== null ? (
        <p className="rounded-inner border border-warn/35 px-3 py-2 text-[11.5px] leading-relaxed text-dim">
          The last refresh did not get through, so what is below is from a moment ago. {error}
        </p>
      ) : null}

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
              onRemove={() => removeSession(group)}
            />
          </Card>

          <LiveLine moving={moving} updatedAt={updatedAt} posts={posts} now={now} />

          {posts.length === 0 ? (
            <p className="text-[11.5px] leading-relaxed text-dim">
              No video rows carry this session’s id. They may have been removed, or this session was made by a build that stored them differently.
            </p>
          ) : (
            <SessionTable
              group={group}
              posts={posts}
              videos={videos}
              devices={devices}
              fleet={data?.fleet ?? EMPTY_FLEET}
              now={now}
              onSave={updatePost}
              saving={saving}
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
    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 px-0.5 text-[11.5px] text-dim">
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
  devices,
  fleet,
  now,
  onSave,
  saving,
}: {
  group: Group
  posts: readonly Post[]
  videos: ReadonlyMap<string, string>
  devices: ReadonlyMap<string, string>
  fleet: readonly Device[]
  now: number
  onSave: SaveEdit
  saving: (post: Post) => boolean
}): ReactElement {
  const [filter, setFilter] = useState<Filter>('all')
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set())

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

  const counts = useMemo(() => {
    const c: Record<Bucket, number> = { running: 0, waiting: 0, posted: 0, failed: 0, look: 0 }
    for (const post of posts) {
      for (const platform of platforms) {
        if (hasPlatform(post, platform)) c[bucketOf(post.dispatch[platform])] += 1
      }
    }
    return c
  }, [posts, platforms])
  const total = counts.running + counts.waiting + counts.posted + counts.failed + counts.look

  const rows = useMemo(() => {
    const numbered = posts.map((post, i) => ({ post, turn: i + 1 }))
    if (filter === 'all') return numbered
    return numbered.filter(({ post }) => platforms.some((p) => hasPlatform(post, p) && bucketOf(post.dispatch[p]) === filter))
  }, [posts, platforms, filter])

  const toggle = useCallback((id: string) => {
    setOpen((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const columns = 4 + platforms.length

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
      </div>

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
        <div className="rounded-inner border border-line">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-12">#</TableHead>
                <TableHead>Video</TableHead>
                <TableHead className="hidden w-28 @xl:table-cell">Turn</TableHead>
                <TableHead className="hidden w-40 @3xl:table-cell">Phone</TableHead>
                {platforms.map((p) => (
                  <TableHead key={p} className="@3xl:w-60">
                    {platformTitle(p)}
                  </TableHead>
                ))}
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
                  devices={devices}
                  now={now}
                  filter={filter}
                  open={open.has(post.videoArtifactId)}
                  onToggle={toggle}
                  columns={columns}
                  posts={posts}
                  fleet={fleet}
                  onSave={onSave}
                  saving={saving(post)}
                  warnings={warnings.get(post.videoArtifactId) ?? NO_WARNINGS}
                  onWarnings={keepWarnings}
                />
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  )
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
        'inline-flex items-center gap-1.5 rounded-pill border px-2.5 py-1 text-[12px] transition-colors',
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
 * A one-per-phone session binds each video to ONE phone for every platform and
 * every retry, so this is the phone that posts it. An every-phone session has
 * no binding by design. A one-per-phone row with no binding says "no phone
 * left" in warn tone ONLY when the router has said so in its own sentence on
 * one of the row's platforms; otherwise the router simply has not bound it yet
 * (a row from before the binding existed is bound on its next tick), and it
 * reads "assigning…".
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
  const noPhone = noPhoneLeftNote(post)
  if (noPhone !== null) {
    return (
      <span className="text-[12px] text-warn" title={noPhone}>
        no phone left
      </span>
    )
  }
  return (
    <span className="text-[12px] text-dim" title="The router binds this video to one phone on its next check, about every 15 seconds.">
      assigning…
    </span>
  )
}

/** The router's "no phone left" sentence, when any of the row's platforms carries it. */
function noPhoneLeftNote(post: Post): string | null {
  for (const state of Object.values(post.dispatch)) if (state.note?.includes(NO_PHONE_LEFT)) return state.note
  return null
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
  devices,
  now,
  filter,
  open,
  onToggle,
  columns,
  posts,
  fleet,
  onSave,
  saving,
  warnings,
  onWarnings,
}: {
  post: Post
  turn: number
  group: Group
  platforms: readonly string[]
  videos: ReadonlyMap<string, string>
  devices: ReadonlyMap<string, string>
  now: number
  filter: Filter
  open: boolean
  onToggle: (id: string) => void
  columns: number
  posts: readonly Post[]
  fleet: readonly Device[]
  onSave: SaveEdit
  saving: boolean
  warnings: readonly string[]
  onWarnings: (videoArtifactId: string, list: readonly string[]) => void
}): ReactElement {
  const name = videos.get(post.videoArtifactId) ?? shortId(post.videoArtifactId)
  const detailId = `smm-video-${post.videoArtifactId}`

  function onRowClick(e: MouseEvent<HTMLTableRowElement>): void {
    if ((e.target as HTMLElement).closest('a')) return
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
            className="inline-flex items-center gap-1 rounded-inner px-1 py-0.5 text-[12px] text-dim focus-visible:outline-2 focus-visible:outline-accent"
          >
            <CaretRightIcon className={cn('size-3 shrink-0 text-faint transition-transform', open && 'rotate-90')} aria-hidden />
            <span className="readout tabular-nums">{turn}</span>
          </button>
        </TableCell>
        <TableCell className="align-top">
          <div className="max-w-[14rem] truncate text-[12.5px] font-medium text-text @3xl:max-w-[20rem]" title={name}>
            {name}
          </div>
          <div className="max-w-[14rem] truncate text-[11px] text-dim @3xl:max-w-[20rem]" title={post.caption}>
            {post.caption}
          </div>
          {/* Narrow boxes hide the Turn and Phone columns; their facts move under the name rather than vanish. */}
          <div className="mt-0.5 text-[11px] text-faint @xl:hidden">Turn {turnText(post, now)}</div>
          <div className="text-[11px] @3xl:hidden">
            <AssignedPhone post={post} group={group} devices={devices} />
          </div>
        </TableCell>
        <TableCell
          className="readout hidden align-top text-[11.5px] whitespace-nowrap text-dim @xl:table-cell"
          title={post.notBeforeAt === null ? undefined : new Date(post.notBeforeAt * 1000).toLocaleString()}
        >
          {turnText(post, now)}
        </TableCell>
        <TableCell className="hidden align-top @3xl:table-cell">
          <AssignedPhone post={post} group={group} devices={devices} />
        </TableCell>
        {platforms.map((p) => (
          <TableCell key={p} className="align-top">
            {hasPlatform(post, p) ? (
              <PlatformCell post={post} platform={p} devices={devices} now={now} dimmed={filter !== 'all' && bucketOf(post.dispatch[p]) !== filter} />
            ) : (
              <span className="text-[11px] text-faint">not sent here</span>
            )}
          </TableCell>
        ))}
      </TableRow>

      {open ? (
        <TableRow id={detailId} className="bg-muted/50 hover:bg-muted/50">
          <TableCell colSpan={columns} className="px-3 py-3">
            <VideoDetail
              post={post}
              platforms={platforms}
              devices={devices}
              now={now}
              posts={posts}
              videos={videos}
              fleet={fleet}
              onSave={onSave}
              saving={saving}
              warnings={warnings}
              onWarnings={onWarnings}
            />
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
  devices,
  now,
  dimmed,
}: {
  post: Post
  platform: string
  devices: ReadonlyMap<string, string>
  now: number
  dimmed: boolean
}): ReactElement {
  const state = post.dispatch[platform]
  const bucket = bucketOf(state)
  const info = bucketInfo(bucket)
  const attempts = state?.attempts ?? []
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
    const starts = attempts.filter((a) => a.state === 'queued' && a.at !== null).map((a) => a.at!)
    const since = starts.length > 0 ? Math.min(...starts) : (state?.at ?? null)
    when = since === null ? 'running' : `for ${span(nowSec - since)}`
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

  // Why, for the two buckets that need one.
  let why: string | null = null
  let whyTitle: string | undefined
  if (bucket === 'failed') {
    why = attempts.find((a) => a.state === 'failed' && a.error)?.error ?? state?.note ?? null
    whyTitle = why ?? undefined
  } else if (bucket === 'look') {
    if (state?.state === 'unsupported') why = 'Not supported in this build'
    else if (attempts.length === 1 && attempts[0]!.state === 'unverified') {
      why = 'Could not confirm it posted'
      whyTitle = UNVERIFIED_MEANING
    } else {
      why = state?.summary ?? state?.note ?? 'Some posted, some did not'
      whyTitle = state?.note ?? why
    }
  }

  const line2 = [where, when].filter((s): s is string => s !== null && s !== '')

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
        <div className={cn('max-w-[16rem] truncate text-[11px]', bucket === 'failed' ? 'text-danger' : 'text-warn')} title={whyTitle}>
          {why}
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
  platforms,
  devices,
  now,
  posts,
  videos,
  fleet,
  onSave,
  saving,
  warnings,
  onWarnings,
}: {
  post: Post
  platforms: readonly string[]
  devices: ReadonlyMap<string, string>
  now: number
  posts: readonly Post[]
  videos: ReadonlyMap<string, string>
  fleet: readonly Device[]
  onSave: SaveEdit
  saving: boolean
  warnings: readonly string[]
  onWarnings: (videoArtifactId: string, list: readonly string[]) => void
}): ReactElement {
  const [editing, setEditing] = useState(false)
  const shown = platforms.filter((p) => hasPlatform(post, p))
  const name = videos.get(post.videoArtifactId) ?? shortId(post.videoArtifactId)
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-start gap-x-3 gap-y-1.5">
        {editing ? (
          <div className="grow" />
        ) : (
          <p className="min-w-0 max-w-prose grow text-[11.5px] leading-relaxed whitespace-pre-wrap text-text-2">{post.caption}</p>
        )}
        {!editing ? (
          <Button
            variant="outline"
            size="sm"
            className="shrink-0"
            title="Change this video’s phone, platforms or caption for its next attempt"
            onClick={() => setEditing(true)}
          >
            <PencilSimpleIcon aria-hidden />
            Edit
          </Button>
        ) : null}
      </div>

      {warnings.length > 0 ? (
        <div className="flex flex-wrap items-start gap-2 rounded-inner border border-warn/35 bg-warn-soft px-3 py-2" role="status">
          <div className="min-w-0 grow space-y-0.5 text-[11.5px] leading-relaxed text-warn">
            <p className="font-medium">Saved, with {warnings.length === 1 ? 'a warning' : `${warnings.length} warnings`}:</p>
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
          posts={posts}
          videos={videos}
          devices={devices}
          fleet={fleet}
          saving={saving}
          onSave={onSave}
          onSaved={(list) => {
            onWarnings(post.videoArtifactId, list)
            setEditing(false)
          }}
          onClose={() => setEditing(false)}
        />
      ) : null}
      <div className="grid gap-3 @3xl:grid-cols-2">
        {shown.map((platform) => {
          const state = post.dispatch[platform]
          const attempts = state?.attempts ?? []
          const earlier = [...(state?.history ?? [])].reverse()
          return (
            <section key={platform} className="min-w-0 space-y-1.5 rounded-inner border border-line bg-panel px-3 py-2">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                <span className="text-[12px] font-medium text-text">{platformTitle(platform)}</span>
                <StateWord state={state?.state ?? 'pending'} />
              </div>
              {state?.note ? <p className="text-[11px] leading-relaxed text-dim">{state.note}</p> : null}

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
                      <AttemptDetail key={`${a.jobId}:${a.deviceId}`} attempt={a} devices={devices} now={now} />
                    ))}
                  </ul>
                )}
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
 * no platform, an empty or over-long caption. Save sends only the fields that
 * differ from the row as loaded; with nothing changed it stays disabled.
 */
function EditPostForm({
  post,
  name,
  posts,
  videos,
  devices,
  fleet,
  saving,
  onSave,
  onSaved,
  onClose,
}: {
  post: Post
  name: string
  posts: readonly Post[]
  videos: ReadonlyMap<string, string>
  devices: ReadonlyMap<string, string>
  fleet: readonly Device[]
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

  /** Device id → the file name of the OTHER video in this session that owns it. */
  const owners = useMemo(() => {
    const map = new Map<string, string>()
    for (const other of posts) {
      if (other.videoArtifactId === post.videoArtifactId) continue
      const otherName = videos.get(other.videoArtifactId) ?? shortId(other.videoArtifactId)
      const claim = (deviceId: string): void => {
        if (!map.has(deviceId)) map.set(deviceId, otherName)
      }
      if (other.assignedDeviceId !== null) claim(other.assignedDeviceId)
      for (const state of Object.values(other.dispatch)) {
        for (const a of state.attempts) if (a.state !== 'failed') claim(a.deviceId)
      }
    }
    return map
  }, [posts, post.videoArtifactId, videos])

  /** The fleet, plus the row's current phone when it has since left the farm — a select must be able to show its own value. */
  const options = useMemo(() => {
    const list = fleet.map((d) => ({ id: d.id, name: deviceName(d), status: d.status as string | null }))
    const current = post.assignedDeviceId
    if (current !== null && !list.some((o) => o.id === current)) {
      list.unshift({ id: current, name: devices.get(current) ?? `device ${shortId(current)}`, status: 'not on this farm' })
    }
    return list
  }, [fleet, devices, post.assignedDeviceId])

  const postable = PLATFORMS.filter((p) => p.postable)
  const nextPlatforms = [...chosen]

  const changes: PostChanges = {}
  if (onePerPhone && phone !== null && phone !== post.assignedDeviceId) changes.assignedDeviceId = phone
  if (!sameSet(nextPlatforms, post.platforms)) changes.platforms = nextPlatforms
  if (caption !== post.caption) changes.caption = caption
  const dirty = Object.keys(changes).length > 0

  const platformProblem = postable.some((p) => chosen.has(p.id)) ? null : 'Choose at least one platform.'
  const captionProblem =
    caption.trim().length === 0
      ? 'The caption cannot be empty.'
      : caption.length > CAPTION_MAX
        ? `The caption is ${caption.length} characters; the limit is ${CAPTION_MAX}.`
        : null
  const canSave = dirty && platformProblem === null && captionProblem === null && !saving

  const phoneOwner = onePerPhone && phone !== null ? owners.get(phone) : undefined
  const phoneLabel = options.find((o) => o.id === phone)?.name ?? (phone !== null ? `device ${shortId(phone)}` : '')

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
          <Select value={phone ?? ''} onValueChange={setPhone} disabled={saving}>
            <SelectTrigger className="w-full @md:w-96" aria-labelledby={`${ids}-phone`}>
              <SelectValue placeholder="No phone assigned yet" />
            </SelectTrigger>
            <SelectContent>
              {options.map((o) => {
                const owner = owners.get(o.id)
                return (
                  <SelectItem key={o.id} value={o.id}>
                    {o.name}
                    {o.status !== null && o.status !== 'online' ? ` · ${o.status}` : ''}
                    {owner !== undefined ? ` (has ${owner})` : ''}
                  </SelectItem>
                )
              })}
            </SelectContent>
          </Select>
          <p className="text-[11px] leading-relaxed text-dim">
            The one phone that posts this video, on every platform and every retry. A phone another video in this session already has is marked
            with that video’s name.
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
        <Textarea id={`${ids}-caption`} value={caption} onChange={(e) => setCaption(e.target.value)} rows={3} disabled={saving} />
        {captionProblem !== null ? <p className="text-[11px] text-danger">{captionProblem}</p> : null}
      </div>

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

/** One attempt in full: round, phone, what it did, when it was sent and settled, the whole error, and the run. */
function AttemptDetail({
  attempt,
  devices,
  now,
  earlier = false,
}: {
  attempt: AttemptRow
  devices: ReadonlyMap<string, string>
  now: number
  earlier?: boolean
}): ReactElement {
  const word = ATTEMPT_WORDS[attempt.state] ?? attempt.state
  const nowSec = Math.floor(now / 1000)
  return (
    <li className="text-[11px]">
      <div className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
        <span className="rounded-inner bg-muted-2 px-1.5 py-px text-[10.5px] text-text-2">
          {earlier ? 'earlier · ' : ''}attempt {attempt.round}
        </span>
        <span className="text-text-3">{attemptPhone(attempt, devices)}</span>
        <span className={cn(ATTEMPT_TONES[attempt.state] ?? 'text-dim')} title={attempt.state === 'unverified' ? UNVERIFIED_MEANING : undefined}>
          {word}
        </span>
        {attempt.at !== null ? <span className="text-faint">sent {relativeTime(attempt.at, now)}</span> : null}
        {attempt.settledAt !== null ? (
          <span className="text-faint">finished {relativeTime(attempt.settledAt, now)}</span>
        ) : attempt.state === 'queued' && attempt.at !== null ? (
          <span className="text-faint">running for {span(nowSec - attempt.at)}</span>
        ) : null}
        <JobLink jobId={attempt.jobId} />
      </div>
      {attempt.error ? <p className="mt-0.5 max-w-prose leading-relaxed wrap-anywhere text-danger">{attempt.error}</p> : null}
    </li>
  )
}

/**
 * One session on the list: what it is, how far it has got, and the way in.
 */
function SessionCard({
  group,
  onOpen,
  busy,
  onStart,
  onRetry,
  onRemove,
}: {
  group: Group
  onOpen: () => void
  busy: boolean
  onStart: () => void
  onRetry: () => void
  onRemove: () => void
}): ReactElement {
  return (
    <Card className="gap-0 rounded-card px-3.5 py-3">
      <SessionHead group={group} onOpen={onOpen} busy={busy} onStart={onStart} onRetry={onRetry} onRemove={onRemove} />
    </Card>
  )
}

/**
 * The header both screens share: title, the farm's own summary line, the three
 * actions, the progress bar and the pacing.
 *
 * One component rather than two similar ones, because the wording of Start,
 * Retry and Remove is the most consequential text in this plugin — each one
 * publishes to, or stops publishing to, somebody's real account — and two
 * copies of it would drift apart on the first edit.
 *
 * `onOpen` is what tells the two apart: on the list the title is the way into
 * the session, and on the session's own page there is nowhere left to go.
 */
function SessionHead({
  group,
  onOpen,
  busy,
  onStart,
  onRetry,
  onRemove,
}: {
  group: Group
  onOpen?: () => void
  busy: boolean
  onStart: () => void
  onRetry: () => void
  onRemove: () => void
}): ReactElement {
  const p = group.progress
  const total = p?.total ?? group.videoArtifactIds.length
  const summary = summaryLine(group)

  const heading = (
    <span className="min-w-0">
      <span className="block text-row font-medium wrap-anywhere text-text">{group.title}</span>
      <span className="mt-0.5 block text-[11.5px] leading-relaxed text-dim">
        {summary ?? 'Nothing reported yet — the farm has not looked at this session since it was made.'}
      </span>
    </span>
  )

  return (
    <>
      <div className="flex flex-wrap items-start gap-2">
        {onOpen ? (
          // The whole heading is the target, not a caret: opening the session is
          // the most common thing anyone does on this card, and a 16px chevron
          // is the smallest possible way to offer it.
          <button type="button" onClick={onOpen} className="flex min-w-0 grow items-start gap-1.5 text-left hover:underline">
            <CaretRightIcon className="mt-0.5 size-3.5 shrink-0 text-faint" aria-hidden />
            {heading}
          </button>
        ) : (
          <div className="flex min-w-0 grow items-start gap-1.5">{heading}</div>
        )}

        <div className="flex shrink-0 flex-wrap items-center justify-end gap-1">
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
                undone. A phone whose result could not be confirmed (<span className="readout">unverified</span>) is left alone for the same reason: it
                may well have posted, so it waits for a person to look rather than being re-sent.
              </>
            }
            onConfirm={onRetry}
          />

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
                posted — that cannot be taken back — and the video rows keep their own record of it. What you lose is this card, the place these{' '}
                {total} video{total === 1 ? '' : 's'} are watched and retried together.
              </>
            }
            onConfirm={onRemove}
          />
        </div>
      </div>

      {/* How far along, and what that number leaves out. The bar is posted-only
          on purpose; failures are never drawn as progress, they are counted
          beside it in their own words. */}
      <div className="mt-2.5 flex flex-wrap items-center gap-x-2.5 gap-y-1">
        <Progress value={percent(p?.posted ?? 0, total)} className="min-w-[120px] max-w-xs grow" />
        <span className="readout text-[11.5px] text-dim">
          {p?.posted ?? 0} of {total} posted
        </span>
        {p && p.running > 0 ? <Badge variant="default">{p.running} running</Badge> : null}
        {p && p.waiting > 0 ? <Badge variant="secondary">{p.waiting} waiting</Badge> : null}
        {/* Never folded into anything softer: a session with failures says how
            many, on the card, before anything is opened. */}
        {p && p.failed > 0 ? <Badge variant="destructive">{p.failed} failed</Badge> : null}
        {p && p.attention > 0 ? (
          <Badge variant="warn" title="Some posted and some did not, or a result could not be confirmed. Open the session to see which phone.">
            {p.attention} need a look
          </Badge>
        ) : null}
      </div>

      <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-faint">
        <span>{relativeTime(group.createdAt)}</span>
        <span aria-hidden>·</span>
        <span>{group.platforms.map(platformTitle).join(', ')}</span>
        <span aria-hidden>·</span>
        <span>{pacingLine(group)}</span>
      </div>
    </>
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
      className="readout text-accent underline-offset-2 hover:underline"
      title={`Open job ${jobId} on the Jobs screen`}
    >
      run
    </a>
  )
}
