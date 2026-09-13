import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { z } from 'zod'
import {
  Badge,
  Button,
  Card,
  CardContent,
  Checkbox,
  EmptyState,
  ErrorState,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Spinner,
  Textarea,
  cn,
  fileSize,
  useAction,
} from '@enkaku/ui'
import {
  PLATFORMS,
  captionFromName,
  defaultSessionTitle,
  deviceName,
  listDevices,
  listVideos,
  pickHost,
  platformLabel,
  runMember,
  uploadVideo,
  type Artifact,
  type Device,
  type PlatformId,
} from '../shared'

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
 * - **"goes to 38 phones"** — the fleet the choice above resolves to, worked
 *   out the same way `routeTargets` works it out on the service side:
 *   `deviceIds` NARROWS, and the platform's own label is still required on top
 *   of it (`posts.ts`'s `allowed` ∩ `deviceCarriesPlatform`). A screen that
 *   counted only the ticked boxes would promise forty phones for a choice that
 *   resolves to none.
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
// Resolving a fleet — the same rule the service side applies
// ---------------------------------------------------------------------------

/** `deviceCarriesPlatform`'s own normalisation (`platforms.ts`): a label is typed by a human onto a chip. */
function normaliseLabel(name: string): string {
  return name.toLowerCase().replace(/\s+/g, '')
}

function carriesPlatform(device: Device, platform: PlatformId): boolean {
  const want = normaliseLabel(platformLabel(platform))
  return device.labels.some((l) => normaliseLabel(l.name) === want)
}

/** Which phones this screen is about to reach, for the platforms chosen. */
function resolveFleet(pool: readonly Device[], platforms: readonly PlatformId[]): Device[] {
  if (platforms.length === 0) return []
  return pool.filter((d) => platforms.some((p) => carriesPlatform(d, p)))
}

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

/** A phone chooser with three modes, because "which phones" is genuinely three different questions. */
type PhoneMode = 'labelled' | 'labels' | 'devices'

const EMPTY_DEVICES: Device[] = []
const EMPTY_VIDEOS: Artifact[] = []

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
  const [phoneMode, setPhoneMode] = useState<PhoneMode>('labelled')
  const [chosenLabels, setChosenLabels] = useState<ReadonlySet<string>>(() => new Set<string>())
  const [chosenDevices, setChosenDevices] = useState<ReadonlySet<string>>(() => new Set<string>())
  const [assignment, setAssignment] = useState<'one-per-phone' | 'every-phone'>('one-per-phone')
  const [order, setOrder] = useState<'as-listed' | 'random'>('random')
  const [concurrency, setConcurrency] = useState(4)
  const [gapMin, setGapMin] = useState(30)
  const [gapMax, setGapMax] = useState(90)
  const [ownCaptions, setOwnCaptions] = useState(false)
  const [captionText, setCaptionText] = useState('')
  const [title, setTitle] = useState(() => defaultSessionTitle())

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

  /** Every label the fleet actually wears — chips built from the farm, never a typed-in list. */
  const fleetLabels = useMemo(() => {
    const seen = new Map<string, string>()
    for (const device of fleet) {
      for (const label of device.labels) {
        const key = normaliseLabel(label.name)
        if (!seen.has(key)) seen.set(key, label.name)
      }
    }
    return [...seen.values()].sort((a, b) => a.localeCompare(b))
  }, [fleet])

  /** The pool BEFORE the platform label is applied — what the operator's mode says. */
  const pool = useMemo(() => {
    if (phoneMode === 'labelled') return fleet
    if (phoneMode === 'labels') {
      const want = new Set([...chosenLabels].map(normaliseLabel))
      return fleet.filter((d) => d.labels.some((l) => want.has(normaliseLabel(l.name))))
    }
    return fleet.filter((d) => chosenDevices.has(d.id))
  }, [phoneMode, fleet, chosenLabels, chosenDevices])

  const resolved = useMemo(() => resolveFleet(pool, chosenPlatforms), [pool, chosenPlatforms])
  const onlineResolved = useMemo(() => resolved.filter((d) => d.status === 'online').length, [resolved])

  /**
   * What actually goes in `deviceIds`.
   *
   * Empty for the default mode, because an empty array means *any phone
   * carrying the platform's label* to `newPost`, which is exactly what the
   * default says. In the other two modes the pool is sent BEFORE the platform
   * filter: narrowing it here to the phones that already carry the label would
   * silently drop a phone the operator labels an hour from now, and this list
   * is stored on the row for as long as the session lives.
   */
  const deviceIds = useMemo(() => (phoneMode === 'labelled' ? [] : pool.map((d) => d.id)), [phoneMode, pool])

  // --- videos ---------------------------------------------------------------
  const chosenVideos = useMemo(() => allVideos.filter((v) => selected.has(v.id)), [allVideos, selected])
  const chosenIds = useMemo(() => chosenVideos.map((v) => v.id), [chosenVideos])

  /**
   * The captions, in the SAME order as `chosenIds`.
   *
   * `add-group` pairs `lines[index]` with `videos[index]`, so these two arrays
   * are one data structure split in half and must never be built from
   * different orderings of the same set.
   */
  const autoCaptions = useMemo(() => chosenVideos.map((v) => captionFromName(v.label)), [chosenVideos])
  const captionsToSend = ownCaptions ? captionText : autoCaptions.join('\n')
  const captionLines = useMemo(
    () =>
      captionsToSend
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l !== ''),
    [captionsToSend],
  )

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
    if (phoneMode === 'labels' && chosenLabels.size === 0) {
      out.push('“Only these labels” is chosen and no label is ticked — an empty choice would quietly mean every labelled phone, which is not what it says.')
    }
    if (phoneMode === 'devices' && chosenDevices.size === 0) {
      out.push('“Only these phones” is chosen and no phone is ticked — an empty choice would quietly mean every labelled phone, which is not what it says.')
    }
    if (captionLines.length === 0) {
      out.push('There is no caption. Every post needs one — the upload flow refuses an empty caption on the device.')
    } else if (captionLines.length !== 1 && captionLines.length !== chosenIds.length) {
      out.push(
        `${chosenIds.length} video${chosenIds.length === 1 ? '' : 's'} but ${captionLines.length} caption line${captionLines.length === 1 ? '' : 's'}. Give one line (used for every video) or exactly one line per video.`,
      )
    }
    if (host === null) {
      out.push('No phone is online. The farm runs this session’s bookkeeping as a job on a phone, so one has to be reachable — nothing is posted by that job.')
    }
    return out
  }, [uploading, chosenIds.length, chosenPlatforms.length, title, phoneMode, chosenLabels.size, chosenDevices.size, captionLines.length, host])

  // --- what is worth saying without stopping anything ----------------------
  const warnings = useMemo(() => {
    const out: string[] = []
    if (concurrency > 8) {
      out.push(
        `${concurrency} at a time is more than this farm is likely to manage. On a laptop driving forty phones the real limit is adb, not this number — the extra turns queue behind it rather than going faster.`,
      )
    }
    if (chosenPlatforms.length > 0 && resolved.length === 0) {
      out.push('This resolves to no phone, so the session would be created and hold everything. Label the phones that post to this platform, or widen the choice above.')
    }
    if (assignment === 'one-per-phone' && resolved.length > 0 && chosenIds.length > resolved.length) {
      out.push(
        `${chosenIds.length} videos over ${resolved.length} phone${resolved.length === 1 ? '' : 's'}: with one video per phone the extra turns wait for a phone to come free rather than doubling up.`,
      )
    }
    return out
  }, [concurrency, chosenPlatforms.length, resolved.length, assignment, chosenIds.length])

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
                captions: captionsToSend,
                platforms: chosenPlatforms,
                assignment,
                order,
                concurrency,
                gapMinSec: gapLo,
                gapMaxSec: gapHi,
                ...(deviceIds.length > 0 ? { deviceIds } : {}),
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
            setTitle(defaultSessionTitle())
            videos.reload()
          },
        },
      )
    },
    [host, title, chosenIds, captionsToSend, chosenPlatforms, assignment, order, concurrency, gapLo, gapHi, deviceIds, run, onCreated, videos],
  )

  return (
    /*
      `@container`, not a viewport breakpoint: this panel does not know how wide
      its box is, and every width decision below is about the box.
    */
    <Card className="@container">
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
              'flex flex-col items-center gap-2 rounded-lg border border-dashed px-4 py-6 text-center transition-colors',
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
            <ul className="mt-3 space-y-1.5">
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
          <div className="mb-2 flex flex-wrap items-center gap-2">
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
            <ul className="max-h-64 space-y-1 overflow-y-auto rounded-lg border border-border p-1">
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
            <p key={p.id} className="mt-2 text-[11.5px] text-dim">
              {p.title} cannot be picked: this build has no verified upload flow for it, so nothing would be sent.
            </p>
          ))}
        </Step>

        <Step n={4} title="Which phones" hint="A choice here narrows the platform’s own label. It never widens it.">
          <Select value={phoneMode} onValueChange={(next) => setPhoneMode(next as PhoneMode)}>
            <SelectTrigger className="w-full @md:w-80">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="labelled">Any phone carrying the platform’s label</SelectItem>
              <SelectItem value="labels">Only phones with the labels I choose</SelectItem>
              <SelectItem value="devices">Only the phones I choose</SelectItem>
            </SelectContent>
          </Select>

          {phoneMode === 'labels' ? (
            fleetLabels.length === 0 ? (
              <p className="mt-2 text-[11.5px] text-dim">No phone in this farm carries a label yet, so there is nothing to narrow by.</p>
            ) : (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {fleetLabels.map((name) => {
                  const on = chosenLabels.has(name)
                  return (
                    <Button
                      key={name}
                      size="sm"
                      variant={on ? 'default' : 'outline'}
                      aria-pressed={on}
                      onClick={() =>
                        setChosenLabels((prev) => {
                          const copy = new Set(prev)
                          if (copy.has(name)) copy.delete(name)
                          else copy.add(name)
                          return copy
                        })
                      }
                    >
                      {name}
                    </Button>
                  )
                })}
              </div>
            )
          ) : null}

          {phoneMode === 'devices' ? (
            devices.error ? (
              <ErrorState message={devices.error} onRetry={devices.reload} />
            ) : fleet.length === 0 ? (
              <p className="mt-2 text-[11.5px] text-dim">The farm listed no phone at all.</p>
            ) : (
              <ul className="mt-2 max-h-56 space-y-1 overflow-y-auto rounded-lg border border-border p-1">
                {fleet.map((device) => (
                  <li key={device.id}>
                    <label className="flex cursor-pointer items-center gap-2 rounded-small px-2 py-1.5 text-[12px] hover:bg-hover">
                      <Checkbox
                        checked={chosenDevices.has(device.id)}
                        onCheckedChange={(next) =>
                          setChosenDevices((prev) => {
                            const copy = new Set(prev)
                            if (next === true) copy.add(device.id)
                            else copy.delete(device.id)
                            return copy
                          })
                        }
                      />
                      <span className="min-w-0 grow wrap-anywhere">{deviceName(device)}</span>
                      <span className="flex-none text-[11px] text-faint">{device.status}</span>
                    </label>
                  </li>
                ))}
              </ul>
            )
          ) : null}

          {/*
            The number this whole step exists for. It is the INTERSECTION the
            service side will compute, not the count of ticked boxes, so a
            choice that resolves to nothing says so here rather than at 2 a.m.
          */}
          <p className="mt-2 text-[12.5px]">
            {chosenPlatforms.length === 0 ? (
              <span className="text-dim">Pick a platform above and this says how many phones it reaches.</span>
            ) : devices.loading && devices.data === null ? (
              <span className="text-dim">Counting the fleet…</span>
            ) : resolved.length === 0 ? (
              <span className="text-warn">
                Goes to no phone: nothing in this choice carries the {chosenPlatforms.map((p) => `“${platformLabel(p)}”`).join(' or ')} label.
              </span>
            ) : (
              <>
                <span className="font-medium">
                  Goes to {resolved.length} phone{resolved.length === 1 ? '' : 's'}
                </span>
                <span className="text-dim">
                  {' '}
                  ({onlineResolved} online right now
                  {phoneMode === 'labelled' ? '' : `, narrowed from ${fleet.length}`})
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
          <p className="mt-2 text-[12.5px] font-medium">{pacing}</p>
        </Step>

        <Step n={6} title="Captions" hint="Taken from each file’s own name unless you write your own.">
          <label className="flex cursor-pointer items-center gap-2 text-[12px]">
            <Checkbox checked={ownCaptions} onCheckedChange={(next) => setOwnCaptions(next === true)} />
            <span>Write my own</span>
          </label>

          {ownCaptions ? (
            <>
              <Textarea
                className="mt-2 min-h-24 text-[12px]"
                value={captionText}
                placeholder={'One line for every video, or exactly one line per video.'}
                onChange={(e) => setCaptionText(e.target.value)}
              />
              <p className="mt-1 text-[11.5px] text-dim">
                {captionLines.length} line{captionLines.length === 1 ? '' : 's'} for {chosenIds.length} video
                {chosenIds.length === 1 ? '' : 's'}.
              </p>
            </>
          ) : autoCaptions.length === 0 ? (
            <p className="mt-2 text-[11.5px] text-dim">Pick a video and its caption appears here.</p>
          ) : (
            <div className="mt-2 rounded-lg border border-border bg-panel-2 px-2 py-1.5">
              <ul className="space-y-0.5 text-[11.5px] text-dim">
                {autoCaptions.slice(0, 3).map((caption, index) => (
                  // The list is derived from an ordered selection and has no
                  // stable key of its own; the video's id is the key that
                  // belongs to the row this caption came from.
                  <li key={chosenIds[index] ?? index} className="wrap-anywhere">
                    {caption}
                  </li>
                ))}
              </ul>
              {autoCaptions.length > 3 ? (
                <p className="mt-1 text-[11px] text-faint">…and {autoCaptions.length - 3} more, one per file name.</p>
              ) : null}
            </div>
          )}
        </Step>

        <Step n={7} title="Name this session" hint="It is how you will find it on the Sessions tab.">
          <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={defaultSessionTitle()} />
        </Step>

        {warnings.length > 0 ? (
          <ul className="space-y-1 rounded-lg border border-warn/35 px-3 py-2 text-[11.5px] leading-relaxed text-dim">
            {warnings.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        ) : null}

        {refusals.length > 0 ? (
          <ul className="space-y-1 rounded-lg border border-border px-3 py-2 text-[11.5px] leading-relaxed text-dim">
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
    <section className="space-y-2">
      <div>
        <h3 className="text-[13px] font-medium">
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
