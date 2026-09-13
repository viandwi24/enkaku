import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
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
  PlayIcon,
  Progress,
  Spinner,
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
  type Group,
  type Post,
} from '../shared'

/**
 * The watching half of the screen, in two places: the **Sessions** tab (every
 * upload session, newest first) and a **session's own page** (every video in
 * one of them, with every phone under it).
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

/** `z.unknown()` — a DELETE whose body nobody reads, said out loud rather than defaulted into. */
const Ignored = z.unknown()

interface Loaded {
  groups: Group[]
  posts: Post[]
  /** Artifact id → the operator's own name for that video. Missing when the upload has since been deleted. */
  videos: Map<string, string>
}

/**
 * One snapshot of everything this panel draws.
 *
 * The three reads are deliberately one load: a session's card is a group row
 * and its page is the post rows, and showing a fresh group beside stale posts
 * would let a header's counts disagree with the rows under it for a whole poll
 * interval.
 *
 * `listVideos` is allowed to fail on its own — a name is a nicety and the id's
 * first eight characters are the fallback the rest of this file already uses,
 * while the posts are the thing an operator came here for.
 */
async function loadAll(): Promise<Loaded> {
  const [groups, posts, videos] = await Promise.all([listGroups(), listPosts(), listVideos().catch(() => [])])
  const names = new Map<string, string>()
  for (const video of videos) {
    const label = video.label?.trim()
    if (label) names.set(video.id, label)
  }
  return { groups, posts, videos: names }
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
 */
function useSessionsData(refreshKey: number): {
  data: Loaded | null
  error: string | null
  loading: boolean
  reload: () => void
} {
  const [data, setData] = useState<Loaded | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

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

  return { data, error, loading, reload }
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

  const busy = (group: Group): boolean =>
    isPending(`start:${group.id}`) || isPending(`retry:${group.id}`) || isPending(`remove:${group.id}`)

  return { startSession, retrySession, removeSession, busy }
}

/** One shared empty map, so a render before the first load does not allocate one per card. */
const EMPTY_VIDEOS: ReadonlyMap<string, string> = new Map<string, string>()

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

/**
 * One session's own page: the same header the card carries, then every video in
 * it with every phone under it.
 *
 * It reads the same single load the list does, so a session opened while its
 * batch is moving keeps updating on the same ten-second poll — and the counts
 * in the header cannot disagree with the rows below them, because both came out
 * of one answer.
 */
export function SessionDetail({ groupId, refreshKey, onBack }: { groupId: string; refreshKey: number; onBack: () => void }): ReactElement {
  const { data, error, loading, reload } = useSessionsData(refreshKey)
  // Removing the session removes the page it is on: there is nothing left to
  // watch, so the operator is put back on the list rather than left looking at
  // a header for a thing that no longer exists.
  const { startSession, retrySession, removeSession, busy } = useSessionActions(reload, onBack)

  const group = (data?.groups ?? []).find((g) => g.id === groupId) ?? null
  const posts = postsOf(data, groupId)
  const videos = data?.videos ?? EMPTY_VIDEOS

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

          <div className="space-y-2">
            <h3 className="text-[12px] font-medium text-dim">
              {posts.length} video{posts.length === 1 ? '' : 's'} in this session
            </h3>
            {posts.length === 0 ? (
              <p className="text-[11.5px] leading-relaxed text-dim">
                No video rows carry this session’s id. They may have been removed, or this session was made by a build that stored them differently.
              </p>
            ) : (
              posts.map((post) => <VideoRow key={post.videoArtifactId} post={post} videos={videos} />)
            )}
          </div>
        </>
      )}
    </div>
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

/** One video in a session: what it is, what it says, and what each platform did with it. */
function VideoRow({ post, videos }: { post: Post; videos: ReadonlyMap<string, string> }): ReactElement {
  /**
   * Every platform this row has anything to say about — the ones it targets,
   * plus any it has already run on and has since been dropped from. A platform
   * that has run is shown whether or not it is still targeted: it happened.
   */
  const platforms = useMemo(() => {
    const seen = new Set<string>(post.platforms)
    for (const id of Object.keys(post.dispatch)) seen.add(id)
    return [...seen]
  }, [post])

  const name = videos.get(post.videoArtifactId) ?? shortId(post.videoArtifactId)

  return (
    <div className="rounded-inner bg-muted px-2.5 py-2">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="min-w-0 text-[12.5px] font-medium wrap-anywhere text-text">{name}</span>
        {post.notBeforeAt === null ? (
          <span className="text-[11px] text-faint">no turn yet</span>
        ) : (
          <span className="text-[11px] text-faint">due {relativeTime(post.notBeforeAt)}</span>
        )}
      </div>
      <p className="mt-0.5 line-clamp-2 max-w-prose text-[11.5px] leading-relaxed text-dim">{post.caption}</p>

      <div className="mt-1.5 space-y-1.5">
        {platforms.map((id) => (
          <PlatformLine key={id} platform={id} state={post.dispatch[id]} />
        ))}
      </div>
    </div>
  )
}

/**
 * One platform's row: the state, the phones it ran on, and a way back to each
 * run.
 *
 * A platform key that is absent from `dispatch` is a platform this row targets
 * and nothing has touched yet — rendered `pending` rather than left blank, so
 * "targeted and waiting" and "not targeted at all" never look the same.
 */
function PlatformLine({
  platform,
  state,
}: {
  platform: string
  state: Post['dispatch'][string] | undefined
}): ReactElement {
  const attempts = state?.attempts ?? []
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
      <span className="w-16 shrink-0 text-[11.5px] text-faint">{platformTitle(platform)}</span>
      <StateWord state={state?.state ?? 'pending'} />
      {attempts.length === 0 ? (
        state?.note ? (
          // The router's own sentence — why this row is standing still. Shown
          // verbatim: it is written for a person and usually names the fix.
          <span className="min-w-0 max-w-prose text-[11px] leading-relaxed text-dim">{state.note}</span>
        ) : null
      ) : (
        <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
          {attempts.map((attempt) => (
            <Attempt key={`${attempt.jobId}:${attempt.deviceId}`} attempt={attempt} />
          ))}
        </span>
      )}
    </div>
  )
}

/** One phone's attempt: which phone, what it did, the error if it failed, and the run itself. */
function Attempt({ attempt }: { attempt: Post['dispatch'][string]['attempts'][number] }): ReactElement {
  const phone = attempt.deviceName?.trim() || `device ${shortId(attempt.deviceId)}`
  const word = ATTEMPT_WORDS[attempt.state] ?? attempt.state
  return (
    <span className="inline-flex min-w-0 flex-wrap items-baseline gap-x-1 text-[11px]">
      <span className="text-text-3">{phone}</span>
      <span className={cn(ATTEMPT_TONES[attempt.state] ?? 'text-dim')} title={attempt.state === 'unverified' ? UNVERIFIED_MEANING : undefined}>
        {word}
      </span>
      {attempt.error ? (
        <span className="min-w-0 max-w-prose text-danger" title={attempt.error}>
          — {attempt.error}
        </span>
      ) : null}
      {attempt.jobId ? <JobLink jobId={attempt.jobId} /> : null}
    </span>
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
