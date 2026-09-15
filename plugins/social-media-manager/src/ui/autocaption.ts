import { BadResponseError, api, coreBase, describeApiError } from '@enkaku/ui'
import { z } from 'zod'
import { fitPlatformCaptions, type PlatformCaptions } from '../platform-captions'
import { PLATFORM_IDS, type PlatformId } from '../platforms'
import { CORE, normaliseHashtags, uploadArtifact } from './shared'

/**
 * Auto captions: a video's own speech, written up as a social caption.
 *
 * ## The pipeline, per video
 *
 * 1. **Extract the speech, in the browser.** The farm has no ffmpeg (licence
 *    policy), and its transcriber accepts WAV only. The browser already ships a
 *    decoder for every format it can play, so the video is fetched from the
 *    farm, decoded by Web Audio, mixed down to mono 16 kHz, and encoded as
 *    16-bit PCM WAV here.
 * 2. **Upload that WAV** as an artifact, the same multipart upload the videos
 *    use, and delete it again once it has been read — it is scaffolding, not
 *    something an operator uploaded.
 * 3. **`media.transcribe`** on the farm (local Whisper).
 * 4. **No speech → an empty caption**, clearly marked, never an invented one.
 * 5. **`ai.generate`** writes the caption from the transcript and the stored
 *    caption style; the answer is cleaned (quotes, markdown, one line) and cut to
 *    the 2200 characters the service accepts.
 *
 * Every failure is this video's own and carries a short reason; a bulk run
 * never stops for one.
 */

// ---------------------------------------------------------------------------
// The farm's capabilities
// ---------------------------------------------------------------------------

const EnvelopeSchema = z.object({ ok: z.literal(true), output: z.unknown() })

/** `POST /api/v1/cap/<id>`. A refusal throws with the capability's own `code` and message (the `api` helper does that). */
async function cap<S extends z.ZodType>(id: string, input: unknown, output: S, signal?: AbortSignal): Promise<z.infer<S>> {
  const path = `${CORE}/api/v1/cap/${id}`
  const res = await api(path, EnvelopeSchema, { method: 'POST', json: input, signal })
  const parsed = output.safeParse(res.output)
  if (!parsed.success) throw new BadResponseError(path, z.prettifyError(parsed.error))
  return parsed.data
}

const AiStatusSchema = z.object({
  configured: z.boolean(),
  connectorId: z.string().nullable(),
  connectorName: z.string().nullable(),
  kind: z.enum(['anthropic', 'openrouter']).nullable(),
  model: z.string().nullable(),
  reason: z.string().nullable(),
})

const AiGenerateSchema = z.object({
  text: z.string(),
  connectorId: z.string(),
  connectorName: z.string(),
  model: z.string(),
})

const TranscribeStatusSchema = z.object({
  available: z.boolean(),
  model: z.string().nullable(),
  reason: z.string().nullable(),
  // Added by core plan 318; optional so a core without them still reads.
  cli: z.object({ path: z.string().nullable(), source: z.string(), detail: z.string().nullable() }).optional(),
  modelId: z.string().optional(),
  provisioning: z.boolean().optional(),
})

/** `whisper-model-small` or `/…/ggml-small-q5_1.bin` → `small`; the full path is noise in a one-line status. */
function whisperModelName(status: z.infer<typeof TranscribeStatusSchema>): string | null {
  if (status.modelId) return status.modelId.replace(/^whisper-model-/, '')
  const file = status.model?.split(/[\\/]/).pop() ?? null
  return file ? (/ggml-([a-z]+)/.exec(file)?.[1] ?? file) : null
}

const TranscribeSchema = z.object({
  text: z.string(),
  language: z.string().nullable(),
  speech: z.boolean(),
  durationMs: z.number().nullable(),
  segments: z.array(z.object({ startMs: z.number(), endMs: z.number(), text: z.string() })),
})

function codeOf(e: unknown): string | null {
  return e && typeof e === 'object' && 'code' in e ? String((e as { code: unknown }).code) : null
}

function isAbort(e: unknown): boolean {
  return e instanceof DOMException ? e.name === 'AbortError' : e instanceof Error && e.name === 'AbortError'
}

export interface Readiness {
  /** Both capabilities answered and both can work. */
  ready: boolean
  /** Why not, one sentence per missing half — shown beside the buttons, never swallowed. */
  blockers: string[]
  /** `Claude (claude-…) · whisper base` — what will do the work, for the line under the buttons. */
  engines: string | null
  /** The farm is downloading the speech model right now — worth asking again shortly rather than waiting for a click. */
  provisioning: boolean
}

/**
 * Whether auto captions can run at all on this farm, asked BEFORE a button is
 * enabled. A farm too old to have either capability answers 404, which is a
 * reason like any other rather than a crash.
 */
export async function readReadiness(): Promise<Readiness> {
  const [ai, transcribe] = await Promise.allSettled([cap('ai.status', {}, AiStatusSchema), cap('media.transcribe.status', {}, TranscribeStatusSchema)])
  const blockers: string[] = []
  const engines: string[] = []

  if (ai.status === 'rejected') {
    blockers.push(`The farm could not say whether AI is set up: ${describeApiError(ai.reason)}`)
  } else if (!ai.value.configured) {
    blockers.push(`AI is not set up on this farm${ai.value.reason ? `: ${ai.value.reason}` : ' — add an AI connector first.'}`)
  } else {
    engines.push([ai.value.connectorName ?? ai.value.kind ?? 'AI', ai.value.model ? `(${ai.value.model})` : ''].filter(Boolean).join(' '))
  }

  if (transcribe.status === 'rejected') {
    blockers.push(`The farm could not say whether it can transcribe: ${describeApiError(transcribe.reason)}`)
  } else if (!transcribe.value.available) {
    blockers.push(`Transcription is not available on this farm${transcribe.value.reason ? `: ${transcribe.value.reason}` : '.'}`)
  } else {
    const name = whisperModelName(transcribe.value)
    const source = transcribe.value.cli?.source
    engines.push(`speech: Whisper ${name ?? 'local'}${source && source !== 'missing' ? ` (CLI from ${source})` : ''}`)
  }

  const provisioning = transcribe.status === 'fulfilled' && transcribe.value.provisioning === true
  return { ready: blockers.length === 0, blockers, engines: blockers.length === 0 ? engines.join(' · ') : null, provisioning }
}

// ---------------------------------------------------------------------------
// The caption style, stored in this plugin's own data
// ---------------------------------------------------------------------------

export const CAPTION_STYLE_KEY = 'settings:caption-style'

/** The limit `smm/update-post` and the platform flows enforce. */
export const CAPTION_LIMIT = 2200

export const CAPTION_LANGUAGES = [
  { id: 'id', title: 'Indonesian' },
  { id: 'en', title: 'English' },
  { id: 'ms', title: 'Malay' },
  { id: 'jv', title: 'Javanese' },
  { id: 'es', title: 'Spanish' },
  { id: 'pt', title: 'Portuguese' },
  { id: 'hi', title: 'Hindi' },
  { id: 'ar', title: 'Arabic' },
  { id: 'zh', title: 'Chinese' },
  { id: 'ja', title: 'Japanese' },
] as const

export const CAPTION_TONES = [
  { id: 'casual', title: 'Casual' },
  { id: 'informative', title: 'Informative' },
  { id: 'hype', title: 'Hype' },
  { id: 'professional', title: 'Professional' },
  { id: 'funny', title: 'Funny' },
] as const

export const CaptionStyleSchema = z.object({
  /** The language the CAPTION is written in (ISO-639-1). */
  language: z.string().min(2).catch('id'),
  /** The language spoken in the videos, as a hint to the transcriber — `auto` lets it detect. */
  speechLanguage: z.string().min(2).catch('auto'),
  tone: z.string().min(1).catch('casual'),
  niche: z.string().catch(''),
  hashtags: z.number().int().min(0).max(10).catch(5),
  maxLength: z.number().int().min(50).max(CAPTION_LIMIT).catch(300),
  extra: z.string().catch(''),
})
export type CaptionStyle = z.infer<typeof CaptionStyleSchema>

export const DEFAULT_CAPTION_STYLE: CaptionStyle = {
  language: 'id',
  speechLanguage: 'auto',
  tone: 'casual',
  niche: '',
  hashtags: 5,
  maxLength: 300,
  extra: '',
}

const KvPageSchema = z.object({ items: z.array(z.object({ key: z.string(), value: z.unknown() })) })

/** The stored style, or the defaults when none was ever saved. A field this build cannot read falls back to its default, alone. */
export async function loadCaptionStyle(): Promise<CaptionStyle> {
  const q = new URLSearchParams({ scope: 'global', prefix: CAPTION_STYLE_KEY, limit: '10' })
  const page = await api(`${CORE}/api/plugins/smm/data?${q.toString()}`, KvPageSchema)
  const row = page.items.find((item) => item.key === CAPTION_STYLE_KEY)
  if (!row || row.value === null || typeof row.value !== 'object') return DEFAULT_CAPTION_STYLE
  return CaptionStyleSchema.parse({ ...DEFAULT_CAPTION_STYLE, ...(row.value as Record<string, unknown>) })
}

export async function saveCaptionStyle(style: CaptionStyle): Promise<void> {
  await api(`${CORE}/api/plugins/smm/data/entry`, z.unknown(), {
    method: 'PUT',
    json: { scope: 'global', key: CAPTION_STYLE_KEY, value: style },
  })
}

function titleOf(list: readonly { id: string; title: string }[], id: string): string {
  return list.find((item) => item.id === id)?.title ?? id
}

// ---------------------------------------------------------------------------
// Audio extraction, in the browser
// ---------------------------------------------------------------------------

const SAMPLE_RATE = 16_000
/** Only the first ten minutes are transcribed: a caption does not need more, and a two-hour file would exhaust the tab. */
const MAX_SECONDS = 600
/** The whole file has to sit in memory to be decoded; past this a tab is likely to die rather than fail cleanly. */
const MAX_VIDEO_BYTES = 1024 * 1024 * 1024
/** Below this peak the track is silence — no reason to ask the transcriber. */
const SILENCE_PEAK = 0.002

interface ExtractedSpeech {
  wav: Blob
  /** True when the track is digital silence (or absent), so there is nothing to transcribe. */
  silent: boolean
  seconds: number
}

/**
 * The video's audio as mono 16 kHz 16-bit PCM WAV, from the farm's copy of the file.
 *
 * Decoded with an `OfflineAudioContext` at 16 kHz — `decodeAudioData` resamples
 * to its context's rate, so the decoded buffer is already a third of the size a
 * 48 kHz `AudioContext` would hold — then rendered once more into a one-channel
 * context, which down-mixes stereo, capped at the first ten minutes.
 */
export async function extractSpeechWav(videoArtifactId: string, name: string, signal?: AbortSignal): Promise<ExtractedSpeech> {
  const res = await fetch(`${coreBase()}${CORE}/api/artifacts/${encodeURIComponent(videoArtifactId)}/content`, { credentials: 'include', signal })
  if (!res.ok) {
    throw new Error(res.status === 404 ? `“${name}” is no longer in the farm’s files.` : `Could not read “${name}” from the farm (HTTP ${res.status}).`)
  }
  const declared = Number(res.headers.get('content-length') ?? '0')
  if (declared > MAX_VIDEO_BYTES) {
    throw new Error(`“${name}” is too large to read in the browser (over 1 GB). Write this caption by hand.`)
  }
  const bytes = await res.arrayBuffer()
  if (signal?.aborted) throw new DOMException('Stopped', 'AbortError')

  const Offline = globalThis.OfflineAudioContext
  if (typeof Offline !== 'function') throw new Error('This browser has no Web Audio support, so it cannot read a video’s sound.')

  let decoded: AudioBuffer
  try {
    decoded = await new Offline(1, 1, SAMPLE_RATE).decodeAudioData(bytes)
  } catch {
    throw new Error(`This browser could not read the sound in “${name}” — the video may have no audio track, or use a codec the browser cannot decode.`)
  }
  if (decoded.length === 0) return { wav: new Blob([]), silent: true, seconds: 0 }

  // `decoded` is already at 16 kHz, so frames and samples are the same unit.
  const out = new Offline(1, Math.min(decoded.length, SAMPLE_RATE * MAX_SECONDS), SAMPLE_RATE)
  const source = out.createBufferSource()
  source.buffer = decoded
  source.connect(out.destination)
  source.start(0)
  const rendered = await out.startRendering()
  const samples = rendered.getChannelData(0)

  let peak = 0
  for (let i = 0; i < samples.length; i++) {
    const v = Math.abs(samples[i] as number)
    if (v > peak) peak = v
  }
  return { wav: encodeWav(samples, SAMPLE_RATE), silent: peak < SILENCE_PEAK, seconds: samples.length / SAMPLE_RATE }
}

/** 16-bit little-endian PCM, one channel, with the canonical 44-byte header. */
function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const dataBytes = samples.length * 2
  const buffer = new ArrayBuffer(44 + dataBytes)
  const view = new DataView(buffer)
  const ascii = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i))
  }
  ascii(0, 'RIFF')
  view.setUint32(4, 36 + dataBytes, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  view.setUint32(16, 16, true) // fmt chunk size
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true) // byte rate
  view.setUint16(32, 2, true) // block align
  view.setUint16(34, 16, true) // bits per sample
  ascii(36, 'data')
  view.setUint32(40, dataBytes, true)
  let offset = 44
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i] as number))
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true)
    offset += 2
  }
  return new Blob([buffer], { type: 'audio/wav' })
}

// ---------------------------------------------------------------------------
// The caption itself
// ---------------------------------------------------------------------------

/** How much transcript the model is shown. Ten minutes of speech is far more than a caption needs. */
const TRANSCRIPT_CHARS = 8000

/**
 * What the writer is asked for each platform (0.27.0), WITHOUT hashtags — they are added afterwards and fitted to the
 * platform's own limits (`platform-captions.ts`). The YouTube title is kept well under its 100 characters so a few
 * hashtags still fit beside it.
 */
function platformRule(id: PlatformId, style: CaptionStyle): string {
  switch (id) {
    case 'tiktok':
      return `"tiktok": a TikTok caption. The main point in the first line, then at most two short sentences. Under ${style.maxLength} characters. One or two emoji at most.`
    case 'instagram':
      return `"instagram": an Instagram Reels caption. The main point in the first line, then at most two short sentences of context. Under ${style.maxLength} characters. NO emoji (they cannot be typed on Instagram).`
    case 'youtube':
      return '"youtube": a YouTube Shorts TITLE of at most 60 characters that states the main point plainly: one line, NO emoji (they cannot be typed on YouTube), no clickbait the video does not back up.'
  }
}

function buildPrompts(
  style: CaptionStyle,
  transcript: string,
  name: string,
  fixed: readonly string[],
  platforms: readonly PlatformId[],
): { system: string; prompt: string } {
  const language = titleOf(CAPTION_LANGUAGES, style.language)
  const tone = titleOf(CAPTION_TONES, style.tone).toLowerCase()
  const shape =
    platforms.length === 0
      ? '{"caption": "…", "hashtags": ["#…"]}'
      : `{"caption": "…", "hashtags": ["#…"], "platforms": {${platforms.map((id) => `"${id}": "…"`).join(', ')}}}`
  const rules = [
    'You write captions for short social media videos (TikTok, YouTube Shorts, Instagram Reels).',
    `Write the caption in ${language}, in a ${tone} tone.`,
    style.niche.trim() !== '' ? `The account is about: ${style.niche.trim()}.` : null,
    // 0.29.0 — the owner (2026-09-15): captions must be good, clear and to the point, carrying the big point of the video.
    'First decide the ONE main point of the video: what actually happens, or what the speaker is really telling the viewer. Everything you write serves that point.',
    'Open with that point in the first sentence, stated concretely (what, who, the result or the lesson) — never a generic hook such as "Check this out" or "Watch until the end".',
    'Be clear and to the point: short sentences, no filler, no rambling introduction, no saying the same thing twice. Two or three sentences are usually enough.',
    'Summarise what the video is about; do not retell the transcript line by line, and keep a speaker\'s own words only where they carry the point.',
    `Keep the caption under ${style.maxLength} characters; shorter is better once the point is made.`,
    'The caption itself contains NO hashtags — hashtags go only in the separate "hashtags" list.',
    style.hashtags === 0
      ? 'Return an empty "hashtags" list.'
      : `Give exactly ${style.hashtags} hashtag${style.hashtags === 1 ? '' : 's'} in the "hashtags" list that name what this video is specifically about, each starting with # and containing no spaces.`,
    fixed.length > 0 ? `These hashtags are already added to every post, so do not repeat them: ${fixed.join(' ')}.` : null,
    'Base it only on what the transcript says; never invent prices, results, promises or facts that are not in it.',
    'Plain text only: no quotation marks around the caption, no markdown, no title.',
    style.extra.trim() !== '' ? `Also: ${style.extra.trim()}` : null,
    platforms.length > 0
      ? `Also write the words for each platform in the "platforms" object, in the same language and tone, with NO hashtags in them:\n${platforms.map((id) => `- ${platformRule(id, style)}`).join('\n')}`
      : null,
    `Answer with strictly one JSON object and nothing else, exactly of the form ${shape}.`,
  ]
  const clipped = transcript.length > TRANSCRIPT_CHARS ? `${transcript.slice(0, TRANSCRIPT_CHARS)}…` : transcript
  return {
    system: rules.filter((r): r is string => r !== null).join('\n'),
    prompt: `Video file: ${name}\n\nTranscript of what is said in the video:\n"""\n${clipped}\n"""\n\nWrite the caption and hashtags as JSON.`,
  }
}

const AnswerSchema = z.object({
  caption: z.string().catch(''),
  hashtags: z.array(z.string()).catch([]),
  platforms: z.record(z.string(), z.unknown()).catch({}).default({}),
})

export interface ParsedAnswer {
  caption: string
  hashtags: string[]
  /** The words written for each platform, cleaned, with any hashtags taken out; a platform the answer left out is absent. */
  platformTexts: Partial<Record<PlatformId, string>>
}

/** Trailing `#tags` off the end of a text: `great video #a #b` → `great video`, `['#a', '#b']`. */
function splitTrailingTags(text: string): { caption: string; tags: string[] } {
  const words = text.trim().split(/\s+/)
  const tags: string[] = []
  while (words.length > 0 && /^#[^\s#]+$/.test(words[words.length - 1] as string)) tags.unshift(words.pop() as string)
  return { caption: words.join(' '), tags }
}

/**
 * The model's answer as `{ caption, hashtags }`, read defensively: the JSON object anywhere in the text (a fenced
 * block, a sentence before it), and when there is none, the text as the caption with its trailing hashtags split off.
 * Hashtags written inside the caption anyway are moved out; the session's fixed hashtags and anything past the style's
 * count are dropped.
 */
export function parseAnswer(raw: string, count: number, fixed: readonly string[]): ParsedAnswer {
  let caption = raw
  let tags: string[] = []
  let written: Record<string, unknown> = {}
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start !== -1 && end > start) {
    try {
      const parsed = AnswerSchema.safeParse(JSON.parse(raw.slice(start, end + 1)))
      if (parsed.success) {
        caption = parsed.data.caption
        tags = parsed.data.hashtags
        written = parsed.data.platforms
      }
    } catch {
      /* not JSON after all — read as plain text below */
    }
  }
  const cleaned = cleanCaption(caption)
  const split = splitTrailingTags(cleaned)
  const taken = new Set(normaliseHashtags(fixed).map((t) => t.toLowerCase()))
  const hashtags = normaliseHashtags([...tags, ...split.tags]).filter((t) => !taken.has(t.toLowerCase()))
  const platformTexts: Partial<Record<PlatformId, string>> = {}
  for (const id of PLATFORM_IDS) {
    const value = written[id]
    if (typeof value !== 'string') continue
    const text = splitTrailingTags(cleanCaption(value)).caption
    if (text !== '') platformTexts[id] = text
  }
  return { caption: split.caption, hashtags: hashtags.slice(0, count), platformTexts }
}

const QUOTE_PAIRS: readonly [string, string][] = [
  ['"', '"'],
  ["'", "'"],
  ['“', '”'],
  ['‘', '’'],
  ['«', '»'],
  ['`', '`'],
]

/** A model's caption text, cleaned: no fences, labels, quotes or markdown, no blank-line runs, within the service's limit. */
export function cleanCaption(raw: string): string {
  let text = raw.trim()
  text = text.replace(/^```[a-z]*\s*/i, '').replace(/\s*```$/, '')
  text = text.replace(/^(caption|keterangan|teks)\s*:\s*/i, '')
  text = text.replace(/\*\*(.+?)\*\*/g, '$1').replace(/__(.+?)__/g, '$1')
  text = text.replace(/^#{1,6}\s+/gm, '')
  text = text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ').trim()
  for (let again = true; again; ) {
    again = false
    for (const [open, close] of QUOTE_PAIRS) {
      if (text.length >= 2 && text.startsWith(open) && text.endsWith(close)) {
        text = text.slice(open.length, text.length - close.length).trim()
        again = true
      }
    }
  }
  if (text.length > CAPTION_LIMIT) {
    const cut = text.slice(0, CAPTION_LIMIT)
    const space = cut.lastIndexOf(' ')
    text = (space > CAPTION_LIMIT * 0.8 ? cut.slice(0, space) : cut).trim()
  }
  return text
}

// ---------------------------------------------------------------------------
// One video, end to end
// ---------------------------------------------------------------------------

export type CaptionStage = 'extracting' | 'transcribing' | 'writing'

export type CaptionOutcome =
  | {
      status: 'done'
      caption: string
      hashtags: string[]
      transcript: string
      /** The writer's words per requested platform, before any hashtag is added (what `add-group` fits once the session's line is picked). */
      platformTexts: Partial<Record<PlatformId, string>>
      /** Each requested platform's text, fitted with the fixed and the new hashtags — what a session row stores (0.27.0). */
      platformCaptions: PlatformCaptions
    }
  | { status: 'no-speech'; caption: ''; hashtags: []; reason: string }
  | { status: 'failed'; reason: string }
  | { status: 'stopped' }

export async function autoCaption(input: {
  videoArtifactId: string
  name: string
  style: CaptionStyle
  /** The hashtags the session adds anyway (its fixed ones, and the video's picked line) — never asked for again, and the first to go into each platform's text. */
  fixedHashtags?: readonly string[]
  /** The platforms to write a caption of their own for (0.27.0). None: only the shared caption, as before. */
  platforms?: readonly string[]
  signal?: AbortSignal
  onStage?: (stage: CaptionStage) => void
}): Promise<CaptionOutcome> {
  const { videoArtifactId, name, style, signal, onStage } = input
  const fixed = input.fixedHashtags ?? []
  const platforms = PLATFORM_IDS.filter((id) => input.platforms?.includes(id) === true)
  let stage: CaptionStage = 'extracting'
  let wavId: string | null = null
  try {
    onStage?.('extracting')
    const speech = await extractSpeechWav(videoArtifactId, name, signal)
    if (speech.silent) return { status: 'no-speech', caption: '', hashtags: [], reason: 'The video’s sound is silent.' }

    stage = 'transcribing'
    onStage?.('transcribing')
    const base = name.replace(/\.[^.]+$/, '') || 'video'
    wavId = await uploadArtifact(new File([speech.wav], `${base}-speech.wav`, { type: 'audio/wav' }))
    if (signal?.aborted) return { status: 'stopped' }
    const heard = await cap('media.transcribe', { artifactId: wavId, language: style.speechLanguage }, TranscribeSchema, signal)
    const transcript = heard.text.trim()
    if (!heard.speech || transcript === '') return { status: 'no-speech', caption: '', hashtags: [], reason: 'No speech was heard in the video.' }

    stage = 'writing'
    onStage?.('writing')
    const { system, prompt } = buildPrompts(style, transcript, name, fixed, platforms)
    // Each platform's words cost about another caption's worth of tokens.
    const tokens = Math.min(4000, Math.max(300, (style.maxLength + 200) * (1 + platforms.length)))
    const written = await cap('ai.generate', { prompt, system, maxOutputTokens: tokens, temperature: 0.7 }, AiGenerateSchema, signal)
    const answer = parseAnswer(written.text, style.hashtags, fixed)
    if (answer.caption === '') return { status: 'failed', reason: 'The AI answered with no caption text.' }
    const platformCaptions = fitPlatformCaptions({ platforms, caption: answer.caption, texts: answer.platformTexts, hashtags: [...fixed, ...answer.hashtags], required: fixed })
    return { status: 'done', caption: answer.caption, hashtags: answer.hashtags, transcript, platformTexts: answer.platformTexts, platformCaptions }
  } catch (e: unknown) {
    if (isAbort(e) || signal?.aborted) return { status: 'stopped' }
    return { status: 'failed', reason: failureReason(stage, e) }
  } finally {
    if (wavId !== null) {
      const id = wavId
      // Scaffolding, not an upload anyone made — removed whether or not the rest worked. A delete that fails leaves one small WAV in Files, nothing worse.
      void api(`${CORE}/api/artifacts/${encodeURIComponent(id)}`, z.unknown(), { method: 'DELETE' }).catch(() => undefined)
    }
  }
}

function failureReason(stage: CaptionStage, e: unknown): string {
  const code = codeOf(e)
  const message = describeApiError(e)
  if (code === 'E_AI_NOT_CONFIGURED') return `AI is not set up on this farm: ${message}`
  if (code === 'E_TRANSCRIBE_UNAVAILABLE') return `Transcription is not available: ${message}`
  if (code === 'artifact_not_found') return 'The farm lost the extracted audio before it was read. Try again.'
  if (stage === 'extracting') return message
  if (stage === 'transcribing') return `Transcription failed: ${message}`
  return `Writing the caption failed: ${message}`
}

/**
 * Run `worker` over `items`, `concurrency` at a time, stopping new work once
 * `signal` aborts. Every item's own failure is the worker's to report, so one
 * never stops the rest.
 */
export async function runPool<T>(items: readonly T[], concurrency: number, worker: (item: T) => Promise<void>, signal?: AbortSignal): Promise<void> {
  let next = 0
  const lane = async (): Promise<void> => {
    while (next < items.length && !signal?.aborted) {
      const item = items[next++] as T
      await worker(item)
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, lane))
}
