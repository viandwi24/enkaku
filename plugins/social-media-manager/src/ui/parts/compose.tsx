import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { z } from 'zod'
import {
  Badge,
  Button,
  Card,
  CardContent,
  Checkbox,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Spinner,
  Switch,
  Textarea,
  cn,
  fileSize,
  useAction,
} from '@enkaku/ui'
import { PLATFORM_IDS } from '../../platforms'
import { autoCaption } from '../autocaption'
import {
  PLATFORMS,
  POST_TEXT_MAX,
  captionFromName,
  composedHashtags,
  defaultSessionTitle,
  hashtagText,
  deviceName,
  listDevices,
  listVideos,
  parseHashtags,
  pickHost,
  platformLabel,
  postedText,
  runMember,
  uploadVideo,
  type Artifact,
  type Device,
  type PlatformId,
} from '../shared'
import {
  DevicePicker,
  newPick,
  pickRefusal,
  resolvePick,
  type DevicePick,
} from './device-picker'
import {
  AutoStatus,
  BulkProgress,
  CaptionStylePanel,
  ReadinessNote,
  isWorking,
  stateOf,
  useAutoCaptionSetup,
  useBulkRun,
  type AutoState,
} from './autocaption-ui'

/**
 * The top half of the one screen: everything that happens BEFORE a session
 * exists — upload the videos, say where they go and how fast, name the batch,
 * create it.
 *
 * ## Why the whole thing is one panel and not a wizard
 *
 * The job is a single decision made out of six smaller ones, and every one of
 * them changes the answer to another: picking a second platform changes how
 * many phones this reaches, adding ten videos changes how long it will take,
 * narrowing to two labels can take the fleet to zero. A wizard hides the four
 * you are not on, so the operator finds out about the interaction at the end,
 * on a summary step, with a Back button. Here the two numbers that actually
 * matter — *how many phones* and *how long* — are recomputed on every
 * keystroke and sit under the control that moves them.
 *
 * ## The two sentences this screen exists to say
 *
 * - **"goes to 38 phones"** — the fleet the choice above resolves to. Since
 *   0.40.0 every choice is an EXPLICIT list of phones, and `planDispatch` sends
 *   a row carrying one to exactly those phones, labelled for the platform or
 *   not — so this count and the router's are the same list by construction. A
 *   screen whose count disagreed with the router would promise phones and send
 *   to none.
 * - **"about 20 to 59 minutes from Start"** — the span `planSchedule` will
 *   actually produce: it draws a gap BETWEEN successive turns, so forty videos
 *   have thirty-nine gaps, not forty. Concurrency is a cap on how many may be
 *   uploading at once and does not shorten that span, so it is named in the
 *   same sentence without being folded into the arithmetic.
 *
 * Both are estimates and both say so with the word "about". Nothing on this
 * panel words a thing that has not happened yet as done.
 */

// ---------------------------------------------------------------------------
// The pacing sentence
// ---------------------------------------------------------------------------

/** Seconds as the coarsest unit that still reads as a number a person would say. */
function spanUnit(seconds: number): { divisor: number; word: string } {
  if (seconds >= 5400) return { divisor: 3600, word: 'hours' }
  if (seconds >= 90) return { divisor: 60, word: 'minutes' }
  return { divisor: 1, word: 'seconds' }
}

function roundSpan(seconds: number, divisor: number): number {
  const value = seconds / divisor
  return divisor === 3600 ? Math.round(value * 10) / 10 : Math.round(value)
}

/**
 * "40 videos, 4 at a time, 30–90s apart — about 20 to 59 minutes from Start".
 *
 * The span is `(n - 1) × gap`, which is what `planSchedule` does: the first
 * video's turn is `startAt` itself and a gap is drawn before each one after it.
 * Saying `n × gap` would overstate a forty-video batch by one gap, which is
 * small; saying it for a two-video batch would double it, which is not.
 */
function pacingSentence(input: {
  videos: number
  concurrency: number
  gapLo: number
  gapHi: number
}): string {
  const { videos, concurrency, gapLo, gapHi } = input
  if (videos === 0) return 'No video picked yet, so there is nothing to pace.'
  const head = `${videos} video${videos === 1 ? '' : 's'}, ${concurrency} at a time, ${gapLo}–${gapHi}s apart`
  if (videos === 1) return `${head} — the one video goes out as soon as you press Start.`
  const lo = (videos - 1) * gapLo
  const hi = (videos - 1) * gapHi
  if (hi === 0) return `${head} — every turn lands the moment you press Start.`
  const unit = spanUnit(hi)
  const from = roundSpan(lo, unit.divisor)
  const to = roundSpan(hi, unit.divisor)
  const range = from === to ? `about ${to} ${unit.word}` : `about ${from} to ${to} ${unit.word}`
  return `${head} — ${range} from Start.`
}

// ---------------------------------------------------------------------------
// Uploads
// ---------------------------------------------------------------------------

interface UploadRow {
  id: number
  name: string
  /** 0..1, from the XHR's own progress events. */
  fraction: number
  state: 'waiting' | 'uploading' | 'done' | 'failed'
  /** The farm's own sentence, never a rewritten one. */
  error: string | null
}

// ---------------------------------------------------------------------------
// A minimal loader, local to this panel
// ---------------------------------------------------------------------------

interface Loaded<T> {
  data: T | null
  error: string | null
  loading: boolean
  reload: () => void
}

function useLoaded<T>(load: () => Promise<T>): Loaded<T> {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    load()
      .then((next) => {
        if (cancelled) return
        setData(next)
        setError(null)
      })
      .catch((e: unknown) => {
        if (cancelled) return
        setError(e instanceof Error ? e.message : String(e))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [load, tick])

  return { data, error, loading, reload: useCallback(() => setTick((n) => n + 1), []) }
}

function reason(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/**
 * As much of `add-group`'s result as this panel needs: the id of the session
 * it just wrote, so "Create and start" starts THAT one and not a namesake.
 * Loose on purpose — a newer member may return more, and more is not a reason
 * for the screen to say it failed.
 */
const CreatedGroupSchema = z.object({ groupId: z.string().min(1) })

const EMPTY_DEVICES: Device[] = []
const EMPTY_VIDEOS: Artifact[] = []

/**
 * Where a video's caption came from, which decides what a bulk auto caption may replace: the file name and an
 * earlier auto caption are fair game; words the operator TYPED are replaced only by "Auto caption all", confirmed.
 */
type CaptionSource = 'name' | 'typed' | 'auto' | 'no-speech'

interface VideoDraft {
  caption: string
  /** As typed — normalised with `parseHashtags` when sent. */
  hashtags: string
  source: CaptionSource
  /**
   * The words auto caption wrote for each platform (0.27.0), sent as `videoPlatformTexts`; `add-group` fits each with
   * the video's hashtags into that platform's own caption. Dropped the moment the caption is typed over, so a platform
   * never posts words the operator has since replaced.
   */
  platformTexts?: Partial<Record<PlatformId, string>>
}

export function ComposePanel({ onCreated }: { onCreated: (groupId: string | null) => void }): React.ReactElement {
  // --- the farm's two lists -------------------------------------------------
  const videosLoad = useCallback(() => listVideos(), [])
  const devicesLoad = useCallback(() => listDevices(), [])
  const videos = useLoaded(videosLoad)
  const devices = useLoaded(devicesLoad)

  const allVideos = videos.data ?? EMPTY_VIDEOS
  const fleet = devices.data ?? EMPTY_DEVICES

  // --- uploads --------------------------------------------------------------
  const [uploads, setUploads] = useState<UploadRow[]>([])
  const [uploading, setUploading] = useState(false)
  const [dragging, setDragging] = useState(false)
  const nextUploadId = useRef(0)
  const fileInput = useRef<HTMLInputElement | null>(null)

  // --- the choices ----------------------------------------------------------
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set<string>())
  /*
    Nothing preselected. A default platform is a real account somebody's videos
    go to because the screen guessed — and the guess is invisible when the
    operator's eye is on the file list. The refusal below asks for the choice in
    one line, which is the cheapest possible price for never posting somewhere
    nobody picked.
  */
  const [platforms, setPlatforms] = useState<ReadonlySet<PlatformId>>(() => new Set<PlatformId>())
  /*
    One pick, the shared four options (0.40.0). Every one of them resolves to an
    explicit list of phones, so a session created here never routes by a
    platform's label again — the picker says that under itself, and the refusals
    below stop a pick that resolves to nobody from ever becoming a session.
  */
  const [pick, setPick] = useState<DevicePick>(() => newPick())
  /*
    Which platform a phone does NOT post to (0.45.0). Empty by default and
    deliberately never guessed at from the labels on its own: a phone silently
    excluded is a video that never posts, and this screen's whole posture is
    that nothing about where a video goes is decided by a default nobody typed.
    The step below lists the labels and groups the chosen phones actually carry,
    so saying it is one press — but it is still a press.
  */
  const [skipRules, setSkipRules] = useState<SkipRules>(NO_SKIP_RULES)
  const [assignment, setAssignment] = useState<'one-per-phone' | 'every-phone'>('one-per-phone')
  const [order, setOrder] = useState<'as-listed' | 'random'>('random')
  const [concurrency, setConcurrency] = useState(4)
  const [gapMin, setGapMin] = useState(30)
  const [gapMax, setGapMax] = useState(90)
  const [ownCaptions, setOwnCaptions] = useState(false)
  const [captionText, setCaptionText] = useState('')
  const [title, setTitle] = useState(() => defaultSessionTitle())

  // --- per-video captions and hashtags, and auto captions --------------------
  /** Only videos someone (or the AI) has touched; the rest read their caption from the file name. */
  const [drafts, setDrafts] = useState<ReadonlyMap<string, VideoDraft>>(() => new Map())
  const [autoStates, setAutoStates] = useState<ReadonlyMap<string, AutoState>>(() => new Map())
  const [confirmAll, setConfirmAll] = useState(false)
  const [fixedText, setFixedText] = useState('')
  const [linesText, setLinesText] = useState('')
  const [randomLine, setRandomLine] = useState(false)
  const setup = useAutoCaptionSetup()
  const bulk = useBulkRun()

  const { run, isPending } = useAction()
  const submitting = isPending('create') || isPending('create-and-start')
  const busy = uploading || submitting

  /**
   * Uploads run ONE AT A TIME, and that is a decision rather than a
   * simplification: this core shares a laptop with forty phones, every one of
   * which is already carrying an scrcpy session, and forty parallel multipart
   * writes is the shape that makes the video wall stutter. A failure does not
   * abort the queue — thirty-nine good files must not be lost to the one the
   * disk refused — and every row keeps the farm's own message for its own
   * failure.
   */
  const startUploads = useCallback(
    async (files: readonly File[]) => {
      const queue = files.filter((f) => f.size > 0)
      if (queue.length === 0) return
      const jobs = queue.map((file) => ({ file, rowId: nextUploadId.current++ }))
      setUploads((prev) => [
        ...prev,
        ...jobs.map(({ file, rowId }) => ({ id: rowId, name: file.name, fraction: 0, state: 'waiting' as const, error: null })),
      ])
      setUploading(true)
      const stored: string[] = []
      for (const { file, rowId } of jobs) {
        setUploads((prev) => prev.map((r) => (r.id === rowId ? { ...r, state: 'uploading' } : r)))
        try {
          const id = await uploadVideo(file, (fraction) => {
            setUploads((prev) => prev.map((r) => (r.id === rowId ? { ...r, fraction } : r)))
          })
          stored.push(id)
          setUploads((prev) => prev.map((r) => (r.id === rowId ? { ...r, state: 'done', fraction: 1 } : r)))
        } catch (e: unknown) {
          setUploads((prev) => prev.map((r) => (r.id === rowId ? { ...r, state: 'failed', error: reason(e) } : r)))
        }
      }
      setUploading(false)
      if (stored.length > 0) {
        // Newly uploaded ids start ticked: an operator who just dropped forty
        // files means those forty, and making them tick each one again is work
        // the screen can do for them.
        setSelected((prev) => {
          const next = new Set(prev)
          for (const id of stored) next.add(id)
          return next
        })
        videos.reload()
      }
    },
    [videos],
  )

  // --- the fleet the choice resolves to ------------------------------------
  const chosenPlatforms = useMemo(
    () => PLATFORMS.filter((p) => p.postable && platforms.has(p.id)).map((p) => p.id),
    [platforms],
  )

  /** The pool BEFORE the platform label is applied — what the operator's mode says. */
  const pool = useMemo(() => resolvePick(pick, fleet), [pick, fleet])

  /*
    The router's own rule (`posts.ts` `planDispatch`): phones the operator CHOSE
    are eligible for the chosen platforms as they are. Every mode chooses phones
    now, so the pool IS the answer — a count that narrowed it by the platform's
    label on top would promise phones the router will not filter, and the owner's
    production session of 2026-09-14 was the same mistake in the other direction.
    The platforms still gate it: with none picked nothing has anywhere to go.
  */
  const resolved = useMemo(() => (chosenPlatforms.length === 0 ? [] : pool), [pool, chosenPlatforms])
  const onlineResolved = useMemo(() => resolved.filter((d) => d.status === 'online').length, [resolved])

  /**
   * What actually goes in `deviceIds` — always a list, never empty (0.40.0).
   *
   * An EMPTY `deviceIds` still means "any phone carrying the platform's label"
   * to `newPost`, and sessions written before 0.40.0 carry one and still route
   * that way. This screen can no longer produce that shape: every mode names
   * phones, and a mode that names none is refused above rather than submitted
   * as an empty list that would silently mean something else entirely.
   *
   * One video per phone sends the RESOLVED phones (0.12.0), so `add-group` can
   * pair each video with a phone when the session is created — the pairing the
   * owner expects to be fixed from the moment the spread is drawn. Every-phone
   * sessions send the pool itself, which is the same list.
   */
  const deviceIds = useMemo(
    () => (assignment === 'one-per-phone' ? resolved.map((d) => d.id) : pool.map((d) => d.id)),
    [assignment, resolved, pool],
  )

  /** Is there a skip rule at all? What decides whether `excludes` is sent, and what the step's summary reads. */
  const hasSkipRules = useMemo(
    () => skipRules.labels.length > 0 || skipRules.groups.length > 0 || Object.keys(skipRules.devices).length > 0,
    [skipRules],
  )

  // --- videos ---------------------------------------------------------------
  const chosenVideos = useMemo(() => allVideos.filter((v) => selected.has(v.id)), [allVideos, selected])
  const chosenIds = useMemo(() => chosenVideos.map((v) => v.id), [chosenVideos])

  /**
   * Each chosen video with its caption and hashtags, keyed by the video itself.
   *
   * Sent as `videoCaptions`/`videoHashtags` — records keyed by artifact id — so a caption can be empty (a video
   * with no speech) or run over several lines without shifting every video after it, which the old
   * one-line-per-video `captions` string could not survive. "Write my own" still sends that string.
   */
  const draftOf = useCallback(
    (video: Artifact): VideoDraft => drafts.get(video.id) ?? { caption: captionFromName(video.label), hashtags: '', source: 'name' },
    [drafts],
  )
  const perVideo = useMemo(() => chosenVideos.map((video) => ({ video, draft: draftOf(video) })), [chosenVideos, draftOf])
  const captionLines = useMemo(
    () =>
      captionText
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l !== ''),
    [captionText],
  )

  const fixedTags = useMemo(() => parseHashtags(fixedText), [fixedText])
  const hashtagLines = useMemo(
    () =>
      linesText
        .split('\n')
        .map((line) => hashtagText(parseHashtags(line)))
        .filter((line) => line !== ''),
    [linesText],
  )
  const linePicked = randomLine && hashtagLines.length > 0

  /** Videos that would post nothing at all: no caption, no hashtag of their own, none from the session. */
  const bareVideos = useMemo(
    () =>
      ownCaptions || fixedTags.length > 0 || linePicked
        ? 0
        : perVideo.filter(({ draft }) => draft.caption.trim() === '' && parseHashtags(draft.hashtags).length === 0).length,
    [ownCaptions, fixedTags.length, linePicked, perVideo],
  )
  const tooLong = useMemo(() => (ownCaptions ? 0 : perVideo.filter(({ draft }) => draft.caption.length > POST_TEXT_MAX).length), [ownCaptions, perVideo])
  const autoBusy = bulk.running || [...autoStates.values()].some(isWorking)

  const setDraft = useCallback((id: string, draft: VideoDraft) => {
    setDrafts((prev) => new Map(prev).set(id, draft))
  }, [])
  const setAuto = useCallback((id: string, state: AutoState | null) => {
    setAutoStates((prev) => {
      const next = new Map(prev)
      if (state === null) next.delete(id)
      else next.set(id, state)
      return next
    })
  }, [])

  /** One video through the pipeline. Its fields are locked while it runs, so a result never lands on top of typing. */
  const autoOne = useCallback(
    async (video: Artifact, signal: AbortSignal): Promise<void> => {
      setAuto(video.id, { phase: 'extracting' })
      const outcome = await autoCaption({
        videoArtifactId: video.id,
        name: video.label ?? video.id,
        style: setup.style,
        fixedHashtags: fixedTags,
        // All three, whatever is ticked now: the platforms may still change before the session is created.
        platforms: PLATFORM_IDS,
        signal,
        onStage: (phase) => setAuto(video.id, { phase }),
      })
      if (outcome.status === 'done') {
        setDraft(video.id, { caption: outcome.caption, hashtags: hashtagText(outcome.hashtags), source: 'auto', platformTexts: outcome.platformTexts })
      }
      else if (outcome.status === 'no-speech') setDraft(video.id, { caption: '', hashtags: '', source: 'no-speech' })
      setAuto(video.id, stateOf(outcome))
    },
    [setup.style, fixedTags, setAuto, setDraft],
  )

  const runBulk = useCallback(
    async (targets: readonly Artifact[]): Promise<void> => {
      setAutoStates((prev) => {
        const next = new Map(prev)
        for (const video of targets) next.set(video.id, { phase: 'queued' })
        return next
      })
      await bulk.start(targets, (video, signal) => autoOne(video, signal))
      // A Stop leaves the untouched ones queued; they go back to having no status.
      setAutoStates((prev) => {
        const next = new Map(prev)
        for (const [id, state] of next) if (state.phase === 'queued') next.delete(id)
        return next
      })
    },
    [bulk.start, autoOne],
  )

  /** "Only empty captions": still the file name, or emptied — but not a video already found to have no speech. */
  const emptyTargets = useMemo(
    () => perVideo.filter(({ draft }) => draft.source === 'name' || (draft.source !== 'no-speech' && draft.caption.trim() === '')).map(({ video }) => video),
    [perVideo],
  )
  const typedCount = useMemo(() => perVideo.filter(({ draft }) => draft.source === 'typed' && draft.caption.trim() !== '').length, [perVideo])

  const gapLo = Math.min(gapMin, gapMax)
  const gapHi = Math.max(gapMin, gapMax)

  const pacing = pacingSentence({ videos: chosenIds.length, concurrency, gapLo, gapHi })

  const host = useMemo(() => pickHost(fleet), [fleet])

  // --- what stops a submit, said in the farm's own terms --------------------
  const refusals = useMemo(() => {
    const out: string[] = []
    if (uploading) out.push('Videos are still uploading. The session can be created the moment the last one lands.')
    if (chosenIds.length === 0) out.push('No video is picked. A session needs at least one.')
    if (chosenPlatforms.length === 0) out.push('No platform is picked. Nothing would know where to post.')
    if (title.trim() === '') out.push('The session has no name. It is how you will find it on the Sessions tab.')
    /* An explicit mode with nothing ticked, worded once in the picker itself so all three panels refuse it the same way. */
    const emptyPick = pickRefusal(pick)
    if (emptyPick !== null) out.push(emptyPick)
    if (!ownCaptions) {
      if (tooLong > 0) {
        out.push(`${tooLong} caption${tooLong === 1 ? ' is' : 's are'} longer than ${POST_TEXT_MAX} characters, the most a platform accepts. Shorten ${tooLong === 1 ? 'it' : 'them'}.`)
      }
      if (autoBusy) out.push('Auto captions are still being written. Create the session once they finish, or press Stop.')
    } else if (captionLines.length === 0) {
      out.push('There is no caption. Every post needs one — the upload flow refuses an empty caption on the device.')
    } else if (captionLines.length !== 1 && captionLines.length !== chosenIds.length) {
      out.push(
        `${chosenIds.length} video${chosenIds.length === 1 ? '' : 's'} but ${captionLines.length} caption line${captionLines.length === 1 ? '' : 's'}. Give one line (used for every video) or exactly one line per video.`,
      )
    }
    /*
      A refusal, not a warning. It used to be a warning, and a warning is not
      read by someone about to press Create and start: the owner's production
      farm started a session that resolved to no phone and it sat, sending
      nothing, with no failure anywhere to find. A session that can never send
      is not something this page may create.
    */
    if (chosenPlatforms.length > 0 && resolved.length === 0) {
      out.push('The phones you chose resolve to none, so nothing would ever be sent. Choose at least one phone.')
    }
    if (host === null) {
      out.push('No phone is online. The farm runs this session’s bookkeeping as a job on a phone, so one has to be reachable — nothing is posted by that job.')
    }
    return out
  }, [uploading, chosenIds.length, chosenPlatforms, title, pick, ownCaptions, tooLong, autoBusy, captionLines.length, host, resolved.length])

  // --- what is worth saying without stopping anything ----------------------
  const warnings = useMemo(() => {
    const out: string[] = []
    if (concurrency > 8) {
      out.push(
        `${concurrency} at a time is more than this farm is likely to manage. On a laptop driving forty phones the real limit is adb, not this number — the extra turns queue behind it rather than going faster.`,
      )
    }
    if (assignment === 'one-per-phone' && resolved.length > 0 && chosenIds.length > resolved.length) {
      const extra = chosenIds.length - resolved.length
      out.push(
        `${chosenIds.length} videos but ${resolved.length} phone${resolved.length === 1 ? '' : 's'}: each phone gets exactly one video, so ${extra} video${extra === 1 ? ' gets' : 's get'} no phone and will not be sent. Add phones or pick fewer videos.`,
      )
    }
    /*
      A warning, not a refusal: a video with no speech legitimately has no caption yet, and the rest of the batch
      should not wait for it. The router holds such a row and sends nothing until it is given words.
    */
    if (bareVideos > 0) {
      out.push(
        `${bareVideos} video${bareVideos === 1 ? ' has' : 's have'} no caption and no hashtag. ${bareVideos === 1 ? 'It is' : 'They are'} held (“No caption yet — write one”) and never sent until given one — here, or later in the session’s table.`,
      )
    }
    return out
  }, [concurrency, chosenPlatforms.length, resolved.length, assignment, chosenIds.length, bareVideos])

  const canSubmit = refusals.length === 0 && !busy

  const submit = useCallback(
    (mode: 'create' | 'create-and-start') => {
      if (host === null) return
      const hostId = host.id
      const wanted = title.trim()
      const videoCount = chosenIds.length

      void run(
        mode,
        async () => {
          /*
            `runMember` waits for the member's own job to finish and hands back
            what it returned, so the new session's id is a FACT here rather than
            a row found by searching for the title just typed — which two
            sessions created on the same day from the same auto-title would
            both answer to.
          */
          let created: { groupId: string } | null
          try {
            created = await runMember(
              'smm/add-group@latest',
              {
                title: wanted,
                videoArtifactIds: chosenIds,
                ...(ownCaptions
                  ? { captions: captionText }
                  : {
                      videoCaptions: Object.fromEntries(perVideo.map(({ video, draft }) => [video.id, draft.caption.trim()])),
                      videoHashtags: Object.fromEntries(perVideo.map(({ video, draft }) => [video.id, parseHashtags(draft.hashtags)])),
                      videoPlatformTexts: Object.fromEntries(
                        perVideo.flatMap(({ video, draft }) =>
                          draft.platformTexts !== undefined && Object.keys(draft.platformTexts).length > 0 ? [[video.id, draft.platformTexts]] : [],
                        ),
                      ),
                    }),
                hashtags: { fixed: fixedTags, lines: hashtagLines, randomLine },
                platforms: chosenPlatforms,
                assignment,
                order,
                concurrency,
                gapMinSec: gapLo,
                gapMaxSec: gapHi,
                ...(deviceIds.length > 0 ? { deviceIds } : {}),
                // Sent only when there is something to say, so a session with no skips stores the
                // schema's own empty rule rather than three empty collections this screen assembled.
                ...(hasSkipRules && assignment === 'one-per-phone' ? { excludes: skipRules } : {}),
              },
              hostId,
              CreatedGroupSchema,
            )
          } catch (e: unknown) {
            throw new Error(`Nothing was created: ${reason(e)}`)
          }
          // The page is told as soon as the session exists, whatever happens to
          // the start half — a session that was written is a session the
          // operator must be able to see, and it carries its own id so they
          // land on it rather than on a list to search.
          onCreated(created?.groupId ?? null)
          if (mode === 'create') return

          if (created === null) {
            throw new Error(
              `“${wanted}” was created and is still held: the farm did not say which session it wrote, so nothing was started. Press Start on it.`,
            )
          }
          try {
            await runMember('smm/start-group@latest', { groupId: created.groupId }, hostId)
          } catch (e: unknown) {
            throw new Error(`“${wanted}” was created and is still held — it did not start: ${reason(e)}`)
          }
          onCreated(created.groupId)
        },
        {
          success:
            mode === 'create'
              ? `Session created — ${videoCount} video${videoCount === 1 ? '' : 's'} held until you press Start`
              : 'Started — the first video is going out now',
          failure: mode === 'create' ? 'The session was not created' : 'Create and start did not finish',
          onSuccess: () => {
            // Cleared so the next batch starts from an empty screen: leaving
            // forty ticked videos under a button that has already sent them is
            // how the same folder gets posted twice.
            setSelected(new Set<string>())
            setUploads([])
            setCaptionText('')
            setOwnCaptions(false)
            // The session's hashtags stay: they describe the account, not this folder, and the next batch usually wants them again.
            setDrafts(new Map())
            setAutoStates(new Map())
            // Cleared with the videos: a skip names THESE phones for THIS folder, and carrying it
            // into the next batch would turn a platform off for a session nobody meant it for.
            setSkipRules(NO_SKIP_RULES)
            setTitle(defaultSessionTitle())
            videos.reload()
          },
        },
      )
    },
    [
      host,
      title,
      chosenIds,
      ownCaptions,
      captionText,
      perVideo,
      fixedTags,
      hashtagLines,
      randomLine,
      chosenPlatforms,
      assignment,
      order,
      concurrency,
      gapLo,
      gapHi,
      deviceIds,
      // Both, and not only `skipRules`: `hasSkipRules` decides whether the field is sent at all, so a
      // stale one would drop a rule the operator had just ticked — with nothing on screen to say so.
      skipRules,
      hasSkipRules,
      run,
      onCreated,
      videos,
    ],
  )

  return (
    /*
      `@container`, not a viewport breakpoint: this panel does not know how wide
      its box is, and every width decision below is about the box.
    */
    <Card className="@container gap-0 py-0">
      {/* The card's own `py-6`/`gap-6` are cleared so the content's `p-4` is the only inset, even on all four sides. */}
      <CardContent className="space-y-5 p-4">
        <Step n={1} title="Upload the videos" hint="They land in the farm’s own files, the same place the Files screen writes to.">
          <div
            onDragOver={(e) => {
              e.preventDefault()
              setDragging(true)
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault()
              setDragging(false)
              if (busy) return
              void startUploads([...e.dataTransfer.files])
            }}
            className={cn(
              'flex flex-col items-center gap-2 rounded-inner border border-dashed px-4 py-6 text-center transition-colors',
              dragging ? 'border-accent bg-accent-soft' : 'border-border-2 bg-panel-2',
            )}
          >
            <p className="text-[12.5px] text-dim">Drop a folder of videos here</p>
            <input
              ref={fileInput}
              type="file"
              multiple
              accept="video/*,.mp4,.mov,.m4v,.webm,.mkv,.3gp"
              className="hidden"
              onChange={(e) => {
                const files = [...(e.target.files ?? [])]
                // Cleared so the same file can be chosen twice in a row — a
                // file input fires nothing when the value has not changed.
                e.target.value = ''
                void startUploads(files)
              }}
            />
            <Button variant="outline" size="sm" disabled={busy} onClick={() => fileInput.current?.click()}>
              Choose videos
            </Button>
            <p className="text-[11px] text-faint">One at a time, in the order you chose them — this core is sharing a laptop with the phones.</p>
          </div>

          {uploads.length > 0 ? (
            <ul className="space-y-1.5">
              {uploads.map((row) => (
                <li key={row.id} className="flex flex-wrap items-center gap-2 rounded-small border border-border px-2 py-1.5 text-[11.5px]">
                  <span className="min-w-0 grow wrap-anywhere">{row.name}</span>
                  {row.state === 'uploading' ? (
                    <span className="flex flex-none items-center gap-1.5 text-dim">
                      <Spinner className="size-3" />
                      <span className="readout">{Math.round(row.fraction * 100)}%</span>
                    </span>
                  ) : row.state === 'waiting' ? (
                    <span className="flex-none text-faint">Waiting its turn</span>
                  ) : row.state === 'done' ? (
                    <Badge variant="outline" className="flex-none">
                      Uploaded
                    </Badge>
                  ) : (
                    /* The farm's own sentence, whole — a shortened one is the reason nobody can fix an upload. */
                    <span className="flex-none text-danger">Failed — {row.error}</span>
                  )}
                </li>
              ))}
            </ul>
          ) : null}
        </Step>

        <Step n={2} title="Pick the videos" hint="Everything already uploaded, newest first.">
          <div className="flex flex-wrap items-center gap-2">
            <span className="readout text-[11.5px] text-dim">
              {selected.size} of {allVideos.length} picked
            </span>
            <div className="grow" />
            <Button
              variant="ghost"
              size="sm"
              disabled={allVideos.length === 0}
              onClick={() => setSelected(new Set(allVideos.map((v) => v.id)))}
            >
              Select all
            </Button>
            <Button variant="ghost" size="sm" disabled={selected.size === 0} onClick={() => setSelected(new Set<string>())}>
              Clear
            </Button>
            <Button variant="ghost" size="sm" onClick={videos.reload}>
              Refresh
            </Button>
          </div>

          {videos.loading && videos.data === null ? (
            <p className="flex items-center gap-2 text-[12px] text-dim">
              <Spinner className="size-3" /> Reading the farm’s files…
            </p>
          ) : videos.error ? (
            <ErrorState message={videos.error} onRetry={videos.reload} />
          ) : allVideos.length === 0 ? (
            <EmptyState title="No video uploaded yet" description="Drop a folder above. Anything stored as a video shows up here." />
          ) : (
            <ul className="max-h-64 space-y-1 overflow-y-auto rounded-inner border border-border p-1">
              {allVideos.map((video) => {
                const ticked = selected.has(video.id)
                return (
                  <li key={video.id}>
                    <label className="flex cursor-pointer items-center gap-2 rounded-small px-2 py-1.5 text-[12px] hover:bg-hover">
                      <Checkbox
                        checked={ticked}
                        onCheckedChange={(next) =>
                          setSelected((prev) => {
                            const copy = new Set(prev)
                            if (next === true) copy.add(video.id)
                            else copy.delete(video.id)
                            return copy
                          })
                        }
                      />
                      <span className="min-w-0 grow wrap-anywhere">{video.label ?? video.id}</span>
                      <span className="readout flex-none text-[11px] text-faint">{fileSize(video.sizeBytes)}</span>
                    </label>
                  </li>
                )
              })}
            </ul>
          )}
        </Step>

        <Step n={3} title="Where it posts" hint="Each platform sends to the phones carrying that platform’s label.">
          <div className="flex flex-wrap gap-2">
            {PLATFORMS.map((platform) => {
              const on = platform.postable && platforms.has(platform.id)
              return (
                <Button
                  key={platform.id}
                  size="sm"
                  variant={on ? 'default' : 'outline'}
                  /*
                    A toggle has to SAY it is pressed, not only look it. Colour
                    alone leaves the state unreadable to a screen reader, to a
                    colour-blind operator, and to anyone checking this screen
                    from a scaled-down screenshot — which is exactly how a
                    session went out to one platform when two were meant.
                  */
                  aria-pressed={on}
                  disabled={!platform.postable}
                  title={platform.postable ? `Phones carrying the “${platformLabel(platform.id)}” label` : undefined}
                  onClick={() =>
                    setPlatforms((prev) => {
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
          {/*
            Not a disabled button left to explain itself. `postable: false` is a
            statement about this BUILD — the pack has no verified upload flow
            for it — and a screen that only greys the button invites an
            operator to go looking for the permission they think they are
            missing.
          */}
          {PLATFORMS.filter((p) => !p.postable).map((p) => (
            <p key={p.id} className="text-[11.5px] text-dim">
              {p.title} cannot be picked: this build has no verified upload flow for it, so nothing would be sent.
            </p>
          ))}
        </Step>

        <Step
          n={4}
          title="Which phones"
          hint="Every option names the phones itself, so the platform’s label no longer decides anything here. Tick a platform’s own label under “Phones with the labels I choose” to reach exactly the phones it used to."
        >
          {/* The one chooser, shared with Cleanup and Accounts sync (0.39.0) — same options, same words, same refusals. */}
          <DevicePicker fleet={fleet} loading={devices.loading} error={devices.error} onRetry={devices.reload} value={pick} onChange={setPick} />

          {/*
            The number this whole step exists for. It is the INTERSECTION the
            service side will compute, not the count of ticked boxes, so a
            choice that resolves to nothing says so here rather than at 2 a.m.
          */}
          <p className="text-[12.5px]">
            {chosenPlatforms.length === 0 ? (
              <span className="text-dim">Pick a platform above and this says how many phones it reaches.</span>
            ) : devices.loading && devices.data === null ? (
              <span className="text-dim">Counting the fleet…</span>
            ) : resolved.length === 0 ? (
              <span className="text-warn">Goes to no phone: the phones you chose resolve to none.</span>
            ) : (
              <>
                <span className="font-medium">
                  Goes to {resolved.length} phone{resolved.length === 1 ? '' : 's'}
                </span>
                <span className="text-dim">
                  {' '}
                  ({onlineResolved} online right now, out of {fleet.length})
                </span>
              </>
            )}
          </p>
        </Step>

        <Step n={5} title="Spread and pacing" hint="How the turns are handed out, and how far apart they land.">
          <div className="grid gap-3 @md:grid-cols-2">
            <Field label="How to spread it">
              <Select value={assignment} onValueChange={(next) => setAssignment(next as 'one-per-phone' | 'every-phone')}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="one-per-phone">One video per phone (a folder of forty)</SelectItem>
                  <SelectItem value="every-phone">Every video to every phone</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field label="Order">
              <Select value={order} onValueChange={(next) => setOrder(next as 'as-listed' | 'random')}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="random">Shuffled</SelectItem>
                  <SelectItem value="as-listed">As listed</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field label="At once">
              <Input
                type="number"
                min={1}
                max={500}
                value={concurrency}
                onChange={(e) => setConcurrency(clampInt(e.target.value, 1, 500, concurrency))}
              />
            </Field>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Gap from (s)">
                <Input type="number" min={0} max={86_400} value={gapMin} onChange={(e) => setGapMin(clampInt(e.target.value, 0, 86_400, gapMin))} />
              </Field>
              <Field label="Gap to (s)">
                <Input type="number" min={0} max={86_400} value={gapMax} onChange={(e) => setGapMax(clampInt(e.target.value, 0, 86_400, gapMax))} />
              </Field>
            </div>
          </div>
          <p className="text-[12.5px] font-medium">{pacing}</p>
        </Step>

        <Step
          n={6}
          title="Skip platforms on some phones"
          hint="Optional. A phone with no YouTube channel should not be sent there — the video is still created, marked Skipped, and you can enable it later with one press."
        >
          <SkipRulesField assignment={assignment} pool={resolved} platforms={chosenPlatforms} rules={skipRules} onChange={setSkipRules} />
        </Step>

        <Step n={7} title="Captions" hint="Taken from each file’s own name unless you write your own.">
          <label className="flex cursor-pointer items-center gap-2 text-[12px]">
            <Checkbox checked={ownCaptions} onCheckedChange={(next) => setOwnCaptions(next === true)} />
            <span>Write my own</span>
          </label>

          {ownCaptions ? (
            <>
              <Textarea
                className="min-h-24 text-[12px]"
                value={captionText}
                placeholder={'One line for every video, or exactly one line per video.'}
                onChange={(e) => setCaptionText(e.target.value)}
              />
              <p className="text-[11.5px] text-dim">
                {captionLines.length} line{captionLines.length === 1 ? '' : 's'} for {chosenIds.length} video
                {chosenIds.length === 1 ? '' : 's'}.
              </p>
            </>
          ) : perVideo.length === 0 ? (
            <p className="text-[11.5px] text-dim">Pick a video and its caption appears here.</p>
          ) : (
            <>
              <CaptionStylePanel setup={setup} />
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!setup.readiness?.ready || bulk.running || busy}
                  title="Transcribe every picked video and write its caption and hashtags"
                  onClick={() => (typedCount > 0 ? setConfirmAll(true) : void runBulk(chosenVideos))}
                >
                  Auto caption all
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={!setup.readiness?.ready || bulk.running || busy || emptyTargets.length === 0}
                  title="Videos whose caption is empty or still the file name"
                  onClick={() => void runBulk(emptyTargets)}
                >
                  Only empty captions ({emptyTargets.length})
                </Button>
                <BulkProgress bulk={bulk} noun="captioned" />
              </div>
              <ReadinessNote setup={setup} />
              <ul className="max-h-[36rem] space-y-1.5 overflow-y-auto rounded-inner border border-border p-1.5">
                {perVideo.map(({ video, draft }) => (
                  <VideoCaptionRow
                    key={video.id}
                    video={video}
                    draft={draft}
                    state={autoStates.get(video.id)}
                    fixedTags={fixedTags}
                    linePicked={linePicked}
                    disabled={busy}
                    autoDisabled={!setup.readiness?.ready || bulk.running || busy}
                    onChange={(next) => setDraft(video.id, next)}
                    onAuto={() => void autoOne(video, bulk.signal())}
                  />
                ))}
              </ul>
              <ConfirmDialog
                trigger={<span className="hidden" />}
                open={confirmAll}
                onOpenChange={setConfirmAll}
                title="Replace the captions you typed?"
                description={`${typedCount} of the ${perVideo.length} picked videos have a caption you typed yourself. Auto caption all rewrites every one of them, and the typed words are lost. To keep them, use “Only empty captions” instead.`}
                confirmLabel="Replace them"
                destructive={false}
                onConfirm={() => {
                  void runBulk(chosenVideos)
                }}
              />
            </>
          )}
        </Step>

        <Step n={8} title="Hashtags" hint="Added after each caption, on a line of their own.">
          <div className="grid gap-3 @md:grid-cols-2">
            <Field label="Always add">
              <Input value={fixedText} placeholder="#fyp #viral" onChange={(e) => setFixedText(e.target.value)} />
              {fixedTags.length > 0 ? <p className="text-[11px] text-faint wrap-anywhere">{hashtagText(fixedTags)}</p> : null}
            </Field>
            <Field label="Hashtag lines — one set per line">
              <Textarea
                className="min-h-16 text-[12px]"
                value={linesText}
                placeholder={'#trading #gold\n#forex #xauusd'}
                onChange={(e) => setLinesText(e.target.value)}
              />
            </Field>
          </div>
          <label className="flex cursor-pointer items-center gap-2 text-[12px]">
            <Switch checked={randomLine} onCheckedChange={setRandomLine} />
            <span>Pick one line at random per video</span>
          </label>
          <p className="text-[11.5px] text-dim">
            {hashtagLines.length === 0
              ? 'No line written: each video posts with the hashtags above plus its own.'
              : randomLine
                ? `${hashtagLines.length} line${hashtagLines.length === 1 ? '' : 's'}: each video is given one of them at random when the session is created.`
                : `${hashtagLines.length} line${hashtagLines.length === 1 ? '' : 's'} written — a video is given one only while “Pick one line at random per video” is on.`}
          </p>
        </Step>

        <Step n={9} title="Name this session" hint="It is how you will find it on the Sessions tab.">
          <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={defaultSessionTitle()} />
        </Step>

        {warnings.length > 0 ? (
          <ul className="space-y-1 rounded-inner border border-warn/35 px-3 py-2 text-[11.5px] leading-relaxed text-dim">
            {warnings.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        ) : null}

        {refusals.length > 0 ? (
          <ul className="space-y-1 rounded-inner border border-border px-3 py-2 text-[11.5px] leading-relaxed text-dim">
            {refusals.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" disabled={!canSubmit} onClick={() => submit('create')}>
            {isPending('create') ? <Spinner className="size-3" /> : null}
            Create session
          </Button>
          <Button disabled={!canSubmit} onClick={() => submit('create-and-start')}>
            {isPending('create-and-start') ? <Spinner className="size-3" /> : null}
            Create and start
          </Button>
          <span className="text-[11.5px] text-faint">
            Creating a session sends nothing. Start is what gives every video its turn.
          </span>
        </div>
      </CardContent>
    </Card>
  )
}

/** One picked video's caption and hashtags, with its own Auto caption button and status. */
/* ------------------------------------------------------------------------ *
 * Skip rules (0.45.0)
 * ------------------------------------------------------------------------ */

/** The rule as `smm/add-group` takes it (`excludes.ts`'s `ExcludeRuleSchema`). */
interface SkipRules {
  devices: Record<string, PlatformId[]>
  labels: { label: string; platforms: PlatformId[] }[]
  groups: { group: string; platforms: PlatformId[] }[]
}

const NO_SKIP_RULES: SkipRules = { devices: {}, labels: [], groups: [] }

/** The same normalisation the service matches labels and group names with (`platforms.ts`'s `labelKey`). */
function labelKey(name: string): string {
  return name.toLowerCase().replace(/\s+/g, '')
}

/**
 * One platform toggled on or off in a rule list. A rule left with no platform is DROPPED rather than
 * stored empty — an entry that names a label and skips nothing would read as a rule on the session
 * page and do nothing at all.
 */
function toggleRule<T extends { platforms: PlatformId[] }>(entries: readonly T[], match: (entry: T) => boolean, make: () => T, platform: PlatformId): T[] {
  const found = entries.find(match)
  if (!found) return [...entries, make()]
  const platforms = found.platforms.includes(platform) ? found.platforms.filter((p) => p !== platform) : [...found.platforms, platform]
  return entries.map((entry) => (entry === found ? { ...entry, platforms } : entry)).filter((entry) => entry.platforms.length > 0)
}

/**
 * The phones a rule set actually skips, resolved here exactly as `excludes.ts`
 * resolves it on the service side — a union over the three halves.
 *
 * Computed on this screen for one reason: the operator has to see the ANSWER
 * before pressing Create, not the rules. "Every phone tagged no-youtube" is a
 * sentence anybody can write and nobody can check; "4 of 20 phones skip
 * YouTube, and #7 now posts nowhere" is the thing they meant to know.
 */
function resolveSkips(pool: readonly Device[], rules: SkipRules, platforms: readonly PlatformId[]): Map<string, Set<PlatformId>> {
  const out = new Map<string, Set<PlatformId>>()
  const add = (deviceId: string, platform: PlatformId) => {
    if (!platforms.includes(platform)) return
    const set = out.get(deviceId) ?? new Set<PlatformId>()
    set.add(platform)
    out.set(deviceId, set)
  }
  for (const device of pool) {
    for (const rule of rules.groups) {
      if (device.group === null) continue
      if (device.group.id !== rule.group && labelKey(device.group.name) !== labelKey(rule.group)) continue
      for (const platform of rule.platforms) add(device.id, platform)
    }
    for (const rule of rules.labels) {
      if (!device.labels.some((l) => labelKey(l.name) === labelKey(rule.label))) continue
      for (const platform of rule.platforms) add(device.id, platform)
    }
    for (const platform of rules.devices[device.id] ?? []) add(device.id, platform)
  }
  return out
}

/** A small platform toggle, the same shape (and the same `aria-pressed`) as the platform step's. */
function SkipToggle({ on, label, title, onClick }: { on: boolean; label: string; title: string; onClick: () => void }): React.ReactElement {
  return (
    <Button size="sm" variant={on ? 'default' : 'outline'} aria-pressed={on} title={title} className="h-6 px-2 text-[11px]" onClick={onClick}>
      {label}
    </Button>
  )
}

/**
 * Which platform each phone does NOT post to.
 *
 * Three ways to say it, because they are three different facts about a farm and
 * the operator already keeps them apart on the Devices screen: a GROUP is one
 * per phone, a LABEL is many per phone and is how "this one has no YouTube
 * channel" is actually recorded, and a phone NAMED by hand is the exception
 * that fits neither and must not force anyone to invent a label for one
 * evening's session.
 *
 * All three resolve to the same thing — a skip written onto the row when the
 * session is created, which the session page can undo one cell at a time. So
 * nothing here is a commitment: it is a starting position.
 */
function SkipRulesField({
  assignment,
  pool,
  platforms,
  rules,
  onChange,
}: {
  assignment: 'one-per-phone' | 'every-phone'
  pool: readonly Device[]
  platforms: readonly PlatformId[]
  rules: SkipRules
  onChange: (next: SkipRules) => void
}): React.ReactElement {
  /** Every label on the chosen phones, with how many carry it. The platform labels are in here too — skipping by them is legitimate. */
  const labels = useMemo(() => {
    const counts = new Map<string, { name: string; phones: number }>()
    for (const device of pool) {
      for (const seen of new Set(device.labels.map((l) => labelKey(l.name)))) {
        const name = device.labels.find((l) => labelKey(l.name) === seen)?.name ?? seen
        const row = counts.get(seen) ?? { name, phones: 0 }
        row.phones += 1
        counts.set(seen, row)
      }
    }
    return [...counts.values()].sort((a, b) => a.name.localeCompare(b.name))
  }, [pool])

  const groups = useMemo(() => {
    const counts = new Map<string, { id: string; name: string; phones: number }>()
    for (const device of pool) {
      if (device.group === null) continue
      const row = counts.get(device.group.id) ?? { id: device.group.id, name: device.group.name, phones: 0 }
      row.phones += 1
      counts.set(device.group.id, row)
    }
    return [...counts.values()].sort((a, b) => a.name.localeCompare(b.name))
  }, [pool])

  const resolved = useMemo(() => resolveSkips(pool, rules, platforms), [pool, rules, platforms])
  const cells = useMemo(() => [...resolved.values()].reduce((n, set) => n + set.size, 0), [resolved])
  /** Phones every chosen platform was skipped on: their video would go nowhere at all, which is never what anyone meant. */
  const stranded = useMemo(
    () => (platforms.length === 0 ? [] : pool.filter((d) => platforms.every((p) => resolved.get(d.id)?.has(p)))),
    [pool, platforms, resolved],
  )

  /*
    The one spread this cannot express, said out loud rather than drawn and quietly ignored.

    A skip is written onto a video's ROW, for the one phone that video belongs to. An every-phone
    session has no such pairing — the same video goes to every phone carrying the platform — so there
    is no row to write "this phone skips YouTube" on. Drawing the matrix anyway would be a knob that
    does not turn, which is this repo's own named failure. Choose the phones you want instead.
  */
  if (assignment !== 'one-per-phone') {
    return (
      <p className="text-[12.5px] text-dim">
        Skips need one video per phone: they are written onto each video’s own row, and an every-video-to-every-phone session gives a video no phone of
        its own. Switch the spread above to use them, or leave a platform out for the whole session in “Where it posts”.
      </p>
    )
  }

  if (platforms.length === 0 || pool.length === 0) {
    return <p className="text-[12.5px] text-dim">Pick the platforms and the phones above, and this lists what you can turn off for which phone.</p>
  }

  const setDevice = (deviceId: string, platform: PlatformId) => {
    const own = rules.devices[deviceId] ?? []
    const next = own.includes(platform) ? own.filter((p) => p !== platform) : [...own, platform]
    const devices = { ...rules.devices }
    if (next.length === 0) delete devices[deviceId]
    else devices[deviceId] = next
    onChange({ ...rules, devices })
  }

  return (
    <div className="space-y-3">
      {groups.length > 0 ? (
        <div className="space-y-1.5">
          <div className="text-[11.5px] font-medium text-dim">By device group</div>
          {groups.map((group) => {
            const on = rules.groups.find((g) => g.group === group.id)?.platforms ?? []
            return (
              <div key={group.id} className="flex flex-wrap items-center gap-2">
                <span className="min-w-[9rem] truncate text-[12px]" title={group.name}>
                  {group.name}
                </span>
                <span className="text-[11px] text-faint">
                  {group.phones} phone{group.phones === 1 ? '' : 's'}
                </span>
                {platforms.map((id) => (
                  <SkipToggle
                    key={id}
                    on={on.includes(id)}
                    label={PLATFORMS.find((p) => p.id === id)?.title ?? id}
                    title={`Every phone in “${group.name}” skips ${PLATFORMS.find((p) => p.id === id)?.title ?? id}`}
                    onClick={() =>
                      onChange({
                        ...rules,
                        groups: toggleRule(rules.groups, (g) => g.group === group.id, () => ({ group: group.id, platforms: [id] }), id),
                      })
                    }
                  />
                ))}
              </div>
            )
          })}
        </div>
      ) : null}

      {labels.length > 0 ? (
        <div className="space-y-1.5">
          <div className="text-[11.5px] font-medium text-dim">By label</div>
          {labels.map((label) => {
            const on = rules.labels.find((l) => labelKey(l.label) === labelKey(label.name))?.platforms ?? []
            return (
              <div key={label.name} className="flex flex-wrap items-center gap-2">
                <Badge variant="secondary" className="min-w-[9rem] justify-start truncate">
                  {label.name}
                </Badge>
                <span className="text-[11px] text-faint">
                  {label.phones} phone{label.phones === 1 ? '' : 's'}
                </span>
                {platforms.map((id) => (
                  <SkipToggle
                    key={id}
                    on={on.includes(id)}
                    label={PLATFORMS.find((p) => p.id === id)?.title ?? id}
                    title={`Every phone carrying “${label.name}” skips ${PLATFORMS.find((p) => p.id === id)?.title ?? id}`}
                    onClick={() =>
                      onChange({
                        ...rules,
                        labels: toggleRule(rules.labels, (l) => labelKey(l.label) === labelKey(label.name), () => ({ label: label.name, platforms: [id] }), id),
                      })
                    }
                  />
                ))}
              </div>
            )
          })}
        </div>
      ) : null}

      <div className="space-y-1.5">
        <div className="text-[11.5px] font-medium text-dim">By phone</div>
        {/*
          Scrolled rather than paged: forty phones is the size this exists for, and an operator
          looking for #21 scrolls to it far faster than they find the page it is on.
        */}
        <div className="max-h-64 space-y-1 overflow-y-auto rounded-inner border border-line p-2">
          {pool.map((device) => {
            const own = rules.devices[device.id] ?? []
            const byRule = resolved.get(device.id) ?? new Set<PlatformId>()
            return (
              <div key={device.id} className="flex flex-wrap items-center gap-2">
                <span className="min-w-[10rem] truncate text-[12px]" title={deviceName(device)}>
                  {deviceName(device)}
                </span>
                {platforms.map((id) => {
                  const title = PLATFORMS.find((p) => p.id === id)?.title ?? id
                  // A phone a GROUP or LABEL rule already skips shows it, and pressing it does
                  // nothing useful — the rule above is what turned it off, so it says so rather than
                  // offering a toggle that would appear not to work.
                  const fromRule = byRule.has(id) && !own.includes(id)
                  return fromRule ? (
                    <span key={id} className="rounded-inner bg-muted-2 px-2 py-[3px] text-[11px] text-dim" title={`Already skipped by a rule above`}>
                      {title}
                    </span>
                  ) : (
                    <SkipToggle key={id} on={own.includes(id)} label={title} title={`${deviceName(device)} skips ${title}`} onClick={() => setDevice(device.id, id)} />
                  )
                })}
              </div>
            )
          })}
        </div>
      </div>

      <p className="text-[12.5px]">
        {cells === 0 ? (
          <span className="text-dim">Nothing is skipped: every phone posts to every platform you picked.</span>
        ) : (
          <>
            <span className="font-medium">
              {cells} of {pool.length * platforms.length} phone-and-platform pairs skipped
            </span>
            <span className="text-dim"> — those go out as Skipped, and you can enable any of them on the session’s page.</span>
          </>
        )}
      </p>
      {stranded.length > 0 ? (
        <p className="text-[12.5px] text-warn">
          {stranded.length === 1 ? `${deviceName(stranded[0]!)} now posts nowhere` : `${stranded.length} phones now post nowhere`}: every platform you
          picked is skipped for {stranded.length === 1 ? 'it' : 'them'}, so {stranded.length === 1 ? 'its' : 'their'} video is created and never sent.
        </p>
      ) : null}
    </div>
  )
}

function VideoCaptionRow({
  video,
  draft,
  state,
  fixedTags,
  linePicked,
  disabled,
  autoDisabled,
  onChange,
  onAuto,
}: {
  video: Artifact
  draft: VideoDraft
  state: AutoState | undefined
  fixedTags: readonly string[]
  linePicked: boolean
  disabled: boolean
  autoDisabled: boolean
  onChange: (draft: VideoDraft) => void
  onAuto: () => void
}): React.ReactElement {
  const name = video.label ?? video.id
  const working = isWorking(state)
  const tags = composedHashtags(fixedTags, [], parseHashtags(draft.hashtags))
  const noSpeech = draft.source === 'no-speech' && draft.caption.trim() === ''
  const length = postedText(draft.caption, tags).length
  return (
    <li className="space-y-1.5 rounded-small border border-border px-2 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 grow truncate text-[12px] font-medium" title={name}>
          {name}
        </span>
        <AutoStatus state={state} noSpeech="No speech found — caption left empty" />
        <Button variant="outline" size="sm" disabled={autoDisabled || working} onClick={onAuto}>
          {working ? <Spinner className="size-3" /> : null}
          Auto caption
        </Button>
      </div>
      <Textarea
        rows={2}
        className={cn('min-h-12 text-[12px]', noSpeech && 'border-warn/60')}
        value={draft.caption}
        disabled={disabled || working}
        placeholder={noSpeech ? 'No speech found — write this one' : 'Caption'}
        aria-label={`Caption for ${name}`}
        onChange={(e) => onChange({ caption: e.target.value, hashtags: draft.hashtags, source: 'typed' })}
      />
      {noSpeech ? <p className="text-[11px] text-warn">No speech found — write this one.</p> : null}
      {draft.platformTexts !== undefined && Object.keys(draft.platformTexts).length > 0 ? (
        <p className="text-[11px] text-faint">
          Auto caption also wrote a caption for each platform, fitted to its limits when the session is created. Typing over the caption drops
          them; they can be changed on the session’s page.
        </p>
      ) : null}
      <Input
        className="h-7 text-[12px]"
        value={draft.hashtags}
        disabled={disabled || working}
        placeholder="#hashtags for this video"
        aria-label={`Hashtags for ${name}`}
        onChange={(e) => onChange({ ...draft, hashtags: e.target.value })}
      />
      <p className="text-[11px] text-faint wrap-anywhere">
        {tags.length === 0 && !linePicked ? 'Posts with no hashtag' : `Posts with ${[hashtagText(tags), linePicked ? '+ one random line' : ''].filter((s) => s !== '').join(' ')}`}
        {' · '}
        <span className={cn('readout tabular-nums', draft.caption.length > POST_TEXT_MAX && 'text-danger')}>
          {length} / {POST_TEXT_MAX}
        </span>
      </p>
    </li>
  )
}

/**
 * A number field that never lets an empty box become `NaN` in a submitted
 * parameter — an `<input type="number">` reports `''` mid-edit, and `Number('')`
 * is `0`, which would silently turn a half-typed gap into no gap at all.
 */
function clampInt(raw: string, min: number, max: number, fallback: number): number {
  const parsed = Number.parseInt(raw, 10)
  if (Number.isNaN(parsed)) return fallback
  return Math.min(max, Math.max(min, parsed))
}

function Step({ n, title, hint, children }: { n: number; title: string; hint: string; children: React.ReactNode }) {
  return (
    // One gap for everything a step holds, so no child adds a margin of its own on top of it.
    <section className="flex flex-col gap-2">
      <div className="space-y-0.5">
        <h3 className="text-row font-medium">
          <span className="readout mr-1.5 text-faint">{n}</span>
          {title}
        </h3>
        <p className="text-[11.5px] text-dim">{hint}</p>
      </div>
      {children}
    </section>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <span className="block text-[11.5px] font-medium text-dim">{label}</span>
      {children}
    </div>
  )
}

