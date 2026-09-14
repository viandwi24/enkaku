import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import {
  Button,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Spinner,
  Textarea,
  cn,
  describeApiError,
  useAction,
} from '@enkaku/ui'
import {
  CAPTION_LANGUAGES,
  CAPTION_LIMIT,
  CAPTION_TONES,
  DEFAULT_CAPTION_STYLE,
  loadCaptionStyle,
  readReadiness,
  runPool,
  saveCaptionStyle,
  type CaptionOutcome,
  type CaptionStage,
  type CaptionStyle,
  type Readiness,
} from '../autocaption'
import { SpeechLink } from './speech'

/**
 * The React half of auto captions, shared by the compose page and a session's table: whether the farm can do it,
 * the stored caption style, one video's status line, and a bulk runner with progress and Stop.
 */

/** Two at a time: each one decodes a whole video in this tab and asks the farm's Whisper, which shares the core's CPU. */
export const AUTO_CONCURRENCY = 2

// ---------------------------------------------------------------------------
// Readiness and style
// ---------------------------------------------------------------------------

export interface AutoCaptionSetup {
  readiness: Readiness | null
  /** Still asking the farm. */
  checking: boolean
  recheck: () => void
  style: CaptionStyle
  /** The stored style could not be read; the defaults are in use and this says why. */
  styleError: string | null
  setStyle: (style: CaptionStyle) => void
}

export function useAutoCaptionSetup(): AutoCaptionSetup {
  const [readiness, setReadiness] = useState<Readiness | null>(null)
  const [checking, setChecking] = useState(true)
  const [tick, setTick] = useState(0)
  const [style, setStyle] = useState<CaptionStyle>(DEFAULT_CAPTION_STYLE)
  const [styleError, setStyleError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setChecking(true)
    readReadiness()
      .then((next) => {
        if (!cancelled) setReadiness(next)
      })
      .catch((e: unknown) => {
        if (!cancelled) setReadiness({ ready: false, blockers: [describeApiError(e)], engines: null, provisioning: false })
      })
      .finally(() => {
        if (!cancelled) setChecking(false)
      })
    return () => {
      cancelled = true
    }
  }, [tick])

  useEffect(() => {
    let cancelled = false
    loadCaptionStyle()
      .then((next) => {
        if (cancelled) return
        setStyle(next)
        setStyleError(null)
      })
      .catch((e: unknown) => {
        if (!cancelled) setStyleError(`The saved caption style could not be read, so the defaults are used: ${describeApiError(e)}`)
      })
    return () => {
      cancelled = true
    }
  }, [])

  // While the farm downloads the speech model, ask again every ten seconds, so the buttons come on by themselves.
  useEffect(() => {
    if (!readiness?.provisioning) return
    const timer = setTimeout(() => setTick((n) => n + 1), 10_000)
    return () => clearTimeout(timer)
  }, [readiness])

  return { readiness, checking, recheck: useCallback(() => setTick((n) => n + 1), []), style, styleError, setStyle }
}

/** Why the Auto caption buttons are off — beside them, in the farm's own words, never a silently greyed button. */
export function ReadinessNote({ setup }: { setup: AutoCaptionSetup }): ReactElement | null {
  const { readiness, checking, recheck } = setup
  if (checking && readiness === null) {
    return (
      <p className="flex items-center gap-1.5 text-[11.5px] text-dim">
        <Spinner className="size-3" /> Checking whether this farm can transcribe and write captions…
      </p>
    )
  }
  if (readiness === null) return null
  if (readiness.ready) {
    return (
      <p className="flex flex-wrap items-center gap-x-2 text-[11px] text-faint">
        {readiness.engines ? <span>Auto caption uses {readiness.engines}.</span> : null}
        <ManageLinks />
      </p>
    )
  }
  return (
    <div className="flex flex-wrap items-start gap-2 rounded-inner border border-warn/35 px-3 py-2">
      <ul className="min-w-0 grow space-y-0.5 text-[11.5px] leading-relaxed text-warn">
        {readiness.blockers.map((b) => (
          <li key={b}>{b}</li>
        ))}
      </ul>
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <ManageLinks />
        <Button type="button" variant="ghost" size="sm" disabled={checking} onClick={recheck}>
          {checking ? <Spinner className="size-3" /> : null}
          Check again
        </Button>
      </div>
    </div>
  )
}

/**
 * Where the two halves are managed. Speech (the Whisper CLI, its model, the doctor) is this page's own Speech tab
 * (0.20.0), switched to in place; the AI connectors live on the farm's Agents page — a plain link, because a plugin view
 * cannot use Studio's router and leaving for another page is a real navigation anyway.
 */
function ManageLinks(): ReactElement {
  return (
    <span className="inline-flex items-center gap-2 text-[11px]">
      <SpeechLink className="text-accent underline-offset-2 hover:underline">Manage speech</SpeechLink>
      <a href="/agents" className="text-accent underline-offset-2 hover:underline">
        AI connectors
      </a>
    </span>
  )
}

/** The caption style, folded away under one button until it is wanted. Saved to this plugin's own data. */
export function CaptionStylePanel({ setup }: { setup: AutoCaptionSetup }): ReactElement {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<CaptionStyle>(setup.style)
  const { run, isPending } = useAction()

  // A style loaded after the panel mounted replaces the draft, unless it is open and being edited.
  const stored = setup.style
  useEffect(() => {
    if (!open) setDraft(stored)
  }, [stored, open])

  const dirty = JSON.stringify(draft) !== JSON.stringify(stored)
  const saving = isPending('caption-style')

  const save = (): void => {
    void run('caption-style', () => saveCaptionStyle(draft), {
      success: 'Caption style saved — auto captions use it from now on',
      failure: 'The caption style was not saved',
      onSuccess: () => setup.setStyle(draft),
    })
  }

  return (
    <div className="rounded-inner border border-border">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] hover:bg-hover"
      >
        <span className="font-medium">Caption style</span>
        <span className="min-w-0 grow truncate text-[11.5px] text-dim">{styleSummary(stored)}</span>
        <span className="flex-none text-[11px] text-faint">{open ? 'Hide' : 'Change'}</span>
      </button>
      {open ? (
        <div className="space-y-3 border-t border-border px-3 py-3">
          {setup.styleError ? <p className="text-[11.5px] text-warn">{setup.styleError}</p> : null}
          <div className="grid gap-3 @md:grid-cols-2">
            <StyleField label="Caption language">
              <Select value={draft.language} onValueChange={(language) => setDraft({ ...draft, language })}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CAPTION_LANGUAGES.map((l) => (
                    <SelectItem key={l.id} value={l.id}>
                      {l.title}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </StyleField>
            <StyleField label="Language spoken in the videos">
              <Select value={draft.speechLanguage} onValueChange={(speechLanguage) => setDraft({ ...draft, speechLanguage })}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">Detect it</SelectItem>
                  {CAPTION_LANGUAGES.map((l) => (
                    <SelectItem key={l.id} value={l.id}>
                      {l.title}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </StyleField>
            <StyleField label="Tone">
              <Select value={draft.tone} onValueChange={(tone) => setDraft({ ...draft, tone })}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CAPTION_TONES.map((t) => (
                    <SelectItem key={t.id} value={t.id}>
                      {t.title}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </StyleField>
            <StyleField label="Topic of the account">
              <Input value={draft.niche} placeholder="e.g. trading, gold, forex" onChange={(e) => setDraft({ ...draft, niche: e.target.value })} />
            </StyleField>
            <StyleField label="Hashtags per video (0–10)">
              <Input
                type="number"
                min={0}
                max={10}
                value={draft.hashtags}
                onChange={(e) => setDraft({ ...draft, hashtags: clamp(e.target.value, 0, 10, draft.hashtags) })}
              />
            </StyleField>
            <StyleField label={`Caption length, at most (characters, up to ${CAPTION_LIMIT})`}>
              <Input
                type="number"
                min={50}
                max={CAPTION_LIMIT}
                value={draft.maxLength}
                onChange={(e) => setDraft({ ...draft, maxLength: clamp(e.target.value, 50, CAPTION_LIMIT, draft.maxLength) })}
              />
            </StyleField>
          </div>
          <StyleField label="Anything else the writer should know">
            <Textarea
              className="min-h-16 text-[12px]"
              value={draft.extra}
              placeholder="e.g. mention the free class link in bio; never promise profit"
              onChange={(e) => setDraft({ ...draft, extra: e.target.value })}
            />
          </StyleField>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" size="sm" disabled={!dirty || saving} onClick={save}>
              {saving ? <Spinner className="size-3" /> : null}
              Save style
            </Button>
            <Button type="button" size="sm" variant="ghost" disabled={!dirty || saving} onClick={() => setDraft(stored)}>
              Undo changes
            </Button>
            <span className="text-[11px] text-faint">Hashtags come back in their own field, never inside the caption.</span>
          </div>
        </div>
      ) : null}
    </div>
  )
}

function styleSummary(style: CaptionStyle): string {
  const language = CAPTION_LANGUAGES.find((l) => l.id === style.language)?.title ?? style.language
  const tone = CAPTION_TONES.find((t) => t.id === style.tone)?.title ?? style.tone
  const parts = [language, tone.toLowerCase(), `${style.hashtags} hashtag${style.hashtags === 1 ? '' : 's'}`, `≤ ${style.maxLength} chars`]
  if (style.niche.trim() !== '') parts.push(style.niche.trim())
  return parts.join(' · ')
}

function StyleField({ label, children }: { label: string; children: React.ReactNode }): ReactElement {
  return (
    <div className="space-y-1">
      <span className="block text-[11.5px] font-medium text-dim">{label}</span>
      {children}
    </div>
  )
}

function clamp(raw: string, min: number, max: number, fallback: number): number {
  const parsed = Number.parseInt(raw, 10)
  if (Number.isNaN(parsed)) return fallback
  return Math.min(max, Math.max(min, parsed))
}

// ---------------------------------------------------------------------------
// One video's status
// ---------------------------------------------------------------------------

export type AutoState =
  | { phase: 'queued' }
  | { phase: CaptionStage }
  | { phase: 'done' }
  | { phase: 'no-speech'; reason: string }
  | { phase: 'failed'; reason: string }
  | { phase: 'stopped' }

export function isWorking(state: AutoState | undefined): boolean {
  return state !== undefined && (state.phase === 'queued' || state.phase === 'extracting' || state.phase === 'transcribing' || state.phase === 'writing')
}

export function stateOf(outcome: CaptionOutcome): AutoState {
  if (outcome.status === 'done') return { phase: 'done' }
  if (outcome.status === 'no-speech') return { phase: 'no-speech', reason: outcome.reason }
  if (outcome.status === 'failed') return { phase: 'failed', reason: outcome.reason }
  return { phase: 'stopped' }
}

const STAGE_WORDS: Record<CaptionStage | 'queued', string> = {
  queued: 'Waiting its turn',
  extracting: 'Extracting audio…',
  transcribing: 'Transcribing…',
  writing: 'Writing the caption…',
}

/** One line, the same words on both pages. `noSpeech` is what the page says it did with the caption. */
export function AutoStatus({ state, noSpeech, className }: { state: AutoState | undefined; noSpeech: string; className?: string }): ReactElement | null {
  if (state === undefined) return null
  const base = cn('text-[11px] leading-snug', className)
  switch (state.phase) {
    case 'queued':
    case 'extracting':
    case 'transcribing':
    case 'writing':
      return (
        <span className={cn(base, 'inline-flex items-center gap-1.5 text-dim')} role="status">
          {state.phase === 'queued' ? null : <Spinner className="size-3" />}
          {STAGE_WORDS[state.phase]}
        </span>
      )
    case 'done':
      return <span className={cn(base, 'text-ok')}>Auto caption done — check it and edit freely</span>
    case 'no-speech':
      return (
        <span className={cn(base, 'text-warn')} title={state.reason}>
          {noSpeech}
        </span>
      )
    case 'failed':
      return <span className={cn(base, 'text-danger')}>Auto caption failed: {state.reason}</span>
    case 'stopped':
      return <span className={cn(base, 'text-faint')}>Stopped before it finished</span>
  }
}

// ---------------------------------------------------------------------------
// A bulk run
// ---------------------------------------------------------------------------

export interface BulkRun {
  running: boolean
  done: number
  total: number
  start: <T>(items: readonly T[], worker: (item: T, signal: AbortSignal) => Promise<void>) => Promise<void>
  stop: () => void
  /** Aborts the videos in flight too — single-video runs share it, so leaving the page stops everything. */
  signal: () => AbortSignal
}

export function useBulkRun(): BulkRun {
  const [running, setRunning] = useState(false)
  const [done, setDone] = useState(0)
  const [total, setTotal] = useState(0)
  const controller = useRef<AbortController>(new AbortController())

  useEffect(() => () => controller.current.abort(), [])

  const start = useCallback(async <T,>(items: readonly T[], worker: (item: T, signal: AbortSignal) => Promise<void>): Promise<void> => {
    if (items.length === 0) return
    if (controller.current.signal.aborted) controller.current = new AbortController()
    const signal = controller.current.signal
    setRunning(true)
    setDone(0)
    setTotal(items.length)
    try {
      await runPool(
        items,
        AUTO_CONCURRENCY,
        async (item) => {
          await worker(item, signal)
          setDone((n) => n + 1)
        },
        signal,
      )
    } finally {
      setRunning(false)
    }
  }, [])

  const stop = useCallback(() => {
    controller.current.abort()
  }, [])

  const signal = useCallback(() => {
    if (controller.current.signal.aborted && !running) controller.current = new AbortController()
    return controller.current.signal
  }, [running])

  return { running, done, total, start, stop, signal }
}

/** `12 of 73 captioned` with Stop, while a bulk run is going. */
export function BulkProgress({ bulk, noun }: { bulk: BulkRun; noun: string }): ReactElement | null {
  if (!bulk.running) return null
  return (
    <span className="inline-flex items-center gap-2 text-[11.5px] text-dim">
      <Spinner className="size-3" />
      <span className="readout tabular-nums">
        {bulk.done} of {bulk.total} {noun}
      </span>
      <Button type="button" variant="outline" size="sm" onClick={bulk.stop}>
        Stop
      </Button>
    </span>
  )
}
