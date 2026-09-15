import { z } from 'zod'
import { composePostText, hashtagsFor, normalizeHashtags, type HashtagRule } from './hashtags'
import { PLATFORM_IDS, type PlatformId } from './platforms'

/**
 * A caption per platform (0.27.0).
 *
 * The owner (2026-09-15): one text for every platform does not fit any of them. A YouTube Short's
 * "caption" is its TITLE — 100 characters, typed through adb — so a 250-character TikTok caption was cut
 * to its first words and lost every hashtag; Instagram keeps five hashtags and drops emoji. So a post
 * keeps its shared caption (and hashtags), plus an OPTIONAL text per platform. When a platform has one,
 * that text is exactly what the platform's job receives, instead of the shared caption and hashtags.
 *
 * This module is pure and imports nothing but zod and two zod-only siblings, so the page (`ui/`) uses the
 * same limits and the same fitting the service enforces.
 *
 * ## The limits, and where each was measured
 *
 * Every number below is read from the platform pack that types the text. None is guessed silently; the
 * one that is a policy rather than a measurement says so.
 */

/**
 * TikTok's caption: 2200 characters. The `tiktok/post-video` member's own `caption` parameter is
 * `.max(2_200)` (`plugins/tiktok-automation-pack/src/post-video.ts`), so a longer text is refused before
 * the phone is touched. That is the pack's limit; TikTok's own in-app maximum is NOT measured anywhere in
 * this repo (unverified), and the pack's 2200 is the binding one either way.
 */
export const TIKTOK_CAPTION_MAX = 2_200
/**
 * TikTok hashtags: 5. The pack's `maxHashtags` parameter defaults to 5 and this plugin never sends it, so
 * the pack drops every hashtag past the fifth (`capHashtags`). A policy cap of the pack, not TikTok's own
 * limit (the pack says it does not read the platform's). TikTok types through the farm's IME, which
 * carries emoji, so the text is not reduced to ASCII.
 */
export const TIKTOK_HASHTAG_MAX = 5

/**
 * YouTube's title: 100 characters — `TITLE_MAX` in `plugins/youtube-automation-pack/src/post-video.ts`.
 * The pack fits a longer caption itself (`youtubeTitle`); a text stored here is already within it.
 */
export const YOUTUBE_TITLE_MAX = 100
/** The least title text kept before a hashtag is given room — the pack's `TITLE_MIN_TEXT`, mirrored so a fitted title matches what the pack would type. */
export const YOUTUBE_TITLE_MIN_TEXT = 40
/**
 * Hashtags in a GENERATED YouTube title: 3. A policy of this plugin, not a measured limit: the title has
 * 100 characters, and "a few" hashtags leave room for words. A hand-written title may carry more; the pack
 * keeps as many as fit.
 */
export const YOUTUBE_TITLE_HASHTAGS = 3

/** Instagram's caption: 2200 characters — `CAPTION_MAX` in `plugins/instagram-automation-pack/src/post-video.ts`. */
export const INSTAGRAM_CAPTION_MAX = 2_200
/** Instagram hashtags: 5 — `INSTAGRAM_HASHTAG_LIMIT` in the same file, measured on a 20-phone production run (2026-09-14). */
export const INSTAGRAM_HASHTAG_MAX = 5

export interface PlatformCaptionLimit {
  /** The most characters the platform's job accepts for this text. */
  maxLength: number
  /** Hashtags past this many are left out by the pack (or, for YouTube, by this plugin's generation). */
  maxHashtags: number
  /**
   * The text is typed with `adb shell input text`, which carries printable ASCII only: emoji and accented
   * letters are dropped by the pack (`asciiTitle` in the youtube pack, `captionLines` in the instagram pack).
   */
  asciiOnly: boolean
  /** A single line (a title), not a caption with paragraphs. */
  singleLine: boolean
}

export const PLATFORM_CAPTION_LIMITS: Readonly<Record<PlatformId, PlatformCaptionLimit>> = {
  tiktok: { maxLength: TIKTOK_CAPTION_MAX, maxHashtags: TIKTOK_HASHTAG_MAX, asciiOnly: false, singleLine: false },
  youtube: { maxLength: YOUTUBE_TITLE_MAX, maxHashtags: YOUTUBE_TITLE_HASHTAGS, asciiOnly: true, singleLine: true },
  instagram: { maxLength: INSTAGRAM_CAPTION_MAX, maxHashtags: INSTAGRAM_HASHTAG_MAX, asciiOnly: true, singleLine: false },
}

/** The widest stored text, whatever the platform. Kept at 2200 for all three so a limit that loosens later never makes a stored row unreadable. */
export const PLATFORM_CAPTION_STORED_MAX = 2_200

/**
 * What a post stores. Every key optional; an absent key means "this platform posts the shared text".
 * `.strict()` like the row around it, so a platform a newer build added fails the parse loudly.
 */
export const PlatformCaptionsSchema = z
  .object({
    tiktok: z.string().min(1).max(PLATFORM_CAPTION_STORED_MAX).optional(),
    instagram: z.string().min(1).max(PLATFORM_CAPTION_STORED_MAX).optional(),
    youtube: z.string().min(1).max(PLATFORM_CAPTION_STORED_MAX).optional(),
  })
  .strict()
export type PlatformCaptions = z.infer<typeof PlatformCaptionsSchema>

export function isCaptionPlatform(id: string): id is PlatformId {
  return (PLATFORM_IDS as readonly string[]).includes(id)
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

/**
 * The text as adb can type it, kept as readable as possible: accented letters lose their accent rather than the
 * whole letter (`café` → `cafe`, which the pack would otherwise type as `caf`), then anything that is still not
 * printable ASCII (emoji) is left out. Spaces collapse; lines are kept unless `singleLine`.
 */
export function asciiText(s: string, singleLine = false): string {
  const bare = s.normalize('NFKD').replace(/\p{M}/gu, '').replace(/\r\n?/g, '\n').replace(/[^\x20-\x7e\n]/g, '')
  if (singleLine) return bare.replace(/\s+/g, ' ').trim()
  return bare
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** A hashtag word in a text: `#` then letters, digits or underscores. */
const TAG_WORD = /^#[\p{L}\p{N}_]+$/u

/** The hashtags written inside a text, in order, without duplicates (ignoring case). */
export function hashtagsIn(text: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const word of text.split(/\s+/)) {
    if (!TAG_WORD.test(word)) continue
    const key = word.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(word)
  }
  return out
}

/** Hashtags adb can type: `#Café2026` → `#Cafe2026`; one that reduces to nothing is left out. */
function asciiHashtags(tags: readonly string[]): string[] {
  return normalizeHashtags(tags.map((t) => `#${t.replace(/^#+/, '').normalize('NFKD').replace(/\p{M}/gu, '').replace(/[^A-Za-z0-9_]/g, '')}`))
}

/**
 * `text` with every hashtag word past the first `max` left out (0.28.0). A caption written with seven hashtags inside
 * it used to keep all seven, and TikTok's post screen answered with its own "at most 5 hashtags" alert on the phone.
 */
function keepFirstHashtags(text: string, max: number): string {
  let seen = 0
  return text
    .split('\n')
    .map((line) =>
      line
        .split(' ')
        .filter((word) => !TAG_WORD.test(word) || ++seen <= max)
        .join(' ')
        .replace(/ {2,}/g, ' ')
        .trim(),
    )
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** What a cut caption ends with (0.31.0): three ASCII dots, so YouTube's and Instagram's adb typing can carry it. */
export const CUT_MARK = '...'

/**
 * `text` cut to at most `max` characters at a word boundary when one is reasonably near, ending in `CUT_MARK` when
 * anything was cut (0.31.0) — the owner (2026-09-15): a caption joined with its hashtags must never run past the limit,
 * and a cut caption should read as cut. Empty when not even a word and the mark fit.
 */
function cutWithMark(text: string, max: number): string {
  if (text.length <= max) return text
  const room = max - CUT_MARK.length
  if (room <= 0) return ''
  const slice = text.slice(0, room + 1)
  const space = slice.lastIndexOf(' ')
  const head = (space > room * 0.6 ? slice.slice(0, space) : text.slice(0, room)).replace(/[\s,.;:!?-]+$/, '')
  return head === '' ? '' : `${head}${CUT_MARK}`
}

/**
 * The caption, a blank line, the hashtags — within `max`. Hashtags are dropped from the END until it fits, but never the
 * first `keep` of them (the session's required hashtags, 0.31.0); if it still does not fit, the caption text is cut,
 * ending in `CUT_MARK`, and the kept hashtags stay whole.
 */
function joinWithin(body: string, tags: readonly string[], max: number, keep = 0): string {
  const kept = [...tags]
  const join = (b: string): string => (kept.length === 0 ? b : b === '' ? kept.join(' ') : `${b}\n\n${kept.join(' ')}`)
  while (kept.length > keep && join(body).length > max) kept.pop()
  if (join(body).length <= max) return join(body)
  const room = kept.length === 0 ? max : max - kept.join(' ').length - 2
  return join(cutWithMark(body, Math.max(0, room)))
}

/**
 * A title fitted to YouTube's 100 characters: as many hashtags as fit in their own order, never at the cost of the first
 * `YOUTUBE_TITLE_MIN_TEXT` characters of text — except the first `keep` (the session's required hashtags, 0.31.0), which
 * stay whenever they fit at all — then the text cut at a word boundary, ending in `CUT_MARK` (0.31.0).
 */
export function fitYouTubeTitle(text: string, tags: readonly string[], max = YOUTUBE_TITLE_MAX, keep = 0): string {
  const kept: string[] = []
  for (const [index, tag] of tags.entries()) {
    const tagsLength = [...kept, tag].join(' ').length
    if (tagsLength > max) break
    const room = max - tagsLength - (text === '' ? 0 : 1)
    if (index >= keep && room < Math.min(YOUTUBE_TITLE_MIN_TEXT, text.length)) break
    kept.push(tag)
  }
  const tagText = kept.join(' ')
  const budget = max - (tagText === '' ? 0 : tagText.length + (text === '' ? 0 : 1))
  const body = cutWithMark(text, Math.max(0, budget))
  return [body, tagText].filter((s) => s !== '').join(' ')
}

// ---------------------------------------------------------------------------
// Fitting a generated text to one platform
// ---------------------------------------------------------------------------

/**
 * One platform's text, fitted to that platform: the words written for it (`text`, no hashtags expected), plus
 * `hashtags` in order (the session's fixed ones first, so they are the last to go).
 *
 * - **TikTok** — text as written (emoji survive the IME), at most 5 hashtags counting any inside the text,
 *   within 2200 characters.
 * - **YouTube** — one ASCII line, at most 3 hashtags, fitted to 100 characters like the pack fits it.
 * - **Instagram** — ASCII lines, at most 5 hashtags counting any inside the text, within 2200 characters.
 *
 * Empty when nothing is left (a caption written entirely in a script adb cannot type, with no hashtags).
 */
export function fitPlatformCaption(platform: PlatformId, input: { text: string; hashtags: readonly string[]; required?: readonly string[] | undefined }): string {
  const limit = PLATFORM_CAPTION_LIMITS[platform]
  const tagsFor = (tags: readonly string[]): string[] => (limit.asciiOnly ? asciiHashtags(tags) : normalizeHashtags(tags))
  // The session's required hashtags come first and are never the ones dropped (0.31.0).
  const required = tagsFor(input.required ?? [])
  if (platform === 'youtube') {
    const line = asciiText(input.text, true)
    const inline = hashtagsIn(line)
    const words = line.split(' ').filter((w) => w !== '' && !TAG_WORD.test(w))
    const tags = tagsFor([...required, ...inline, ...input.hashtags]).slice(0, Math.max(limit.maxHashtags, required.length))
    return fitYouTubeTitle(words.join(' '), tags, limit.maxLength, required.length)
  }
  // Hashtags written inside the text give way to the required ones, so the platform's own cap never drops a required one.
  const body = keepFirstHashtags(limit.asciiOnly ? asciiText(input.text, limit.singleLine) : input.text.replace(/\r\n?/g, '\n').trim(), Math.max(0, limit.maxHashtags - required.length))
  const inline = hashtagsIn(body)
  const taken = new Set(inline.map((t) => t.toLowerCase()))
  const requiredLeft = required.filter((t) => !taken.has(t.toLowerCase()))
  const candidates = tagsFor([...requiredLeft, ...input.hashtags]).filter((t) => !taken.has(t.toLowerCase()))
  const tags = candidates.slice(0, Math.max(requiredLeft.length, limit.maxHashtags - inline.length))
  return joinWithin(body, tags, limit.maxLength, requiredLeft.length)
}

/**
 * Every requested platform's text at once, for a generated caption. `texts` holds what the writer produced for
 * each platform; a platform it said nothing for is fitted from the shared `caption`. A platform whose fitted
 * text is empty is absent from the answer, so it posts the shared text.
 */
export function fitPlatformCaptions(input: {
  platforms: readonly string[]
  caption: string
  texts?: Partial<Record<PlatformId, string>>
  hashtags: readonly string[]
  /** The session's required hashtags (0.31.0): never dropped from any platform's text. */
  required?: readonly string[] | undefined
}): PlatformCaptions {
  const out: PlatformCaptions = {}
  for (const id of PLATFORM_IDS) {
    if (!input.platforms.includes(id)) continue
    const written = input.texts?.[id]?.trim()
    const fitted = fitPlatformCaption(id, { text: written !== undefined && written !== '' ? written : input.caption, hashtags: input.hashtags, required: input.required })
    if (fitted !== '') out[id] = fitted
  }
  return out
}

// ---------------------------------------------------------------------------
// Checking a hand-written text, and what a job receives
// ---------------------------------------------------------------------------

const TITLES: Readonly<Record<PlatformId, string>> = { tiktok: 'TikTok', youtube: 'YouTube', instagram: 'Instagram' }

/**
 * What is wrong with a hand-written platform text: `error` is a refusal (over the platform's length), `warnings`
 * are what the pack will do to it anyway (drop emoji, drop hashtags past its limit). Warn, never refuse, for
 * anything the pack survives — the owner's rule for edits.
 */
export function checkPlatformCaption(platform: PlatformId, text: string): { error: string | null; warnings: string[] } {
  const limit = PLATFORM_CAPTION_LIMITS[platform]
  const title = TITLES[platform]
  const trimmed = text.trim()
  const warnings: string[] = []
  const what = platform === 'youtube' ? 'title' : 'caption'
  const error = trimmed.length > limit.maxLength ? `A ${title} ${what} can be at most ${limit.maxLength} characters; this one is ${trimmed.length}.` : null
  if (limit.asciiOnly && /[^\x20-\x7e\n]/.test(trimmed)) {
    warnings.push(`${title} is typed through adb, which cannot type emoji or accented letters — they are left out when it posts.`)
  }
  const tags = hashtagsIn(trimmed).length
  if (platform !== 'youtube' && tags > limit.maxHashtags) {
    warnings.push(`${title} keeps the first ${limit.maxHashtags} hashtags; the other ${tags - limit.maxHashtags} are left out when it posts.`)
  }
  return { error, warnings }
}

/** The fields of a post that decide what a platform's job types. */
export interface PostTextSource {
  caption: string
  hashtags: readonly string[]
  hashtagLine: number | null
  platformCaptions?: PlatformCaptions | undefined
}

/**
 * The text ONE platform's job receives (0.27.0): that platform's own caption when the post has one, otherwise the
 * shared text — the caption, the session's fixed hashtags, the line this video was given and its own — FITTED to
 * the platform (0.28.0, `fitPlatformCaption`). The router and Retry failed both send exactly this. Empty means there
 * is nothing to post there.
 *
 * Fitted because the owner's rule is that this plugin knows each platform's limits (2026-09-15): the shared text
 * went out whole to a post with no caption of its own — a caption file, or a row from before 0.27.0 — and TikTok
 * was sent seven hashtags. A platform this build has no limits for still gets the shared text as it is.
 */
export function platformPostText(post: PostTextSource, platform: string, rule: HashtagRule): string {
  const hashtags = hashtagsFor({ rule, line: post.hashtagLine, own: post.hashtags })
  if (!isCaptionPlatform(platform)) return composePostText(post.caption, hashtags)
  const own = post.platformCaptions?.[platform]?.trim()
  if (own === undefined || own === '') return sharedTextFor(platform, post.caption, hashtags, rule.fixed)
  // A text written by hand keeps every word, but never more hashtags than the platform takes. YouTube's pack fits its own title.
  const max = PLATFORM_CAPTION_LIMITS[platform].maxHashtags
  return platform !== 'youtube' && hashtagsIn(own).length > max ? keepFirstHashtags(own, max) : own
}

/** The shared caption and hashtags fitted to one platform — what fills a platform's own caption. Also the page's preview. */
export function sharedTextFor(platform: PlatformId, caption: string, hashtags: readonly string[], required?: readonly string[]): string {
  return fitPlatformCaption(platform, { text: caption, hashtags, required })
}

/** A caption platform's name as the page writes it. */
export function captionPlatformTitle(platform: PlatformId): string {
  return TITLES[platform]
}

/**
 * Every chosen platform with a caption of its own (0.28.0): a platform that has none gets the shared caption and
 * hashtags fitted to it. The owner (2026-09-15): TikTok, YouTube and Instagram each have their own caption, so each fits
 * its own platform — it is never one text for all three. A platform whose fitted text is empty (nothing to post there)
 * stays without one, and the router holds it.
 */
export function withPlatformCaptions(input: { platforms: readonly string[]; caption: string; hashtags: readonly string[]; captions: PlatformCaptions; required?: readonly string[] }): PlatformCaptions {
  const out: PlatformCaptions = { ...input.captions }
  for (const id of PLATFORM_IDS) {
    if (!input.platforms.includes(id) || (out[id] ?? '').trim() !== '') continue
    const fitted = sharedTextFor(id, input.caption, input.hashtags, input.required)
    if (fitted !== '') out[id] = fitted
  }
  return out
}

/**
 * The platform captions after the shared caption or hashtags changed (0.28.0). A platform whose caption was still the OLD
 * shared text fitted to it follows the new one; a platform whose caption was written for it — by hand or by auto caption —
 * keeps it, and is named in `kept` so the edit can say so.
 */
export function followSharedText(input: {
  platforms: readonly string[]
  before: { caption: string; hashtags: readonly string[] }
  after: { caption: string; hashtags: readonly string[] }
  captions: PlatformCaptions
  required?: readonly string[]
}): { captions: PlatformCaptions; kept: PlatformId[] } {
  const out: PlatformCaptions = { ...input.captions }
  const kept: PlatformId[] = []
  for (const id of PLATFORM_IDS) {
    if (!input.platforms.includes(id)) continue
    const stored = out[id]
    const fitted = sharedTextFor(id, input.after.caption, input.after.hashtags, input.required)
    if (stored !== undefined && stored !== sharedTextFor(id, input.before.caption, input.before.hashtags, input.required)) {
      if (stored !== fitted) kept.push(id)
      continue
    }
    if (fitted === '') delete out[id]
    else out[id] = fitted
  }
  return { captions: out, kept }
}

/** Every targeted platform's text, and which of them have nothing to post — what the router decides a hold from. */
export function platformPostTexts<P extends string>(post: PostTextSource & { platforms: readonly P[] }, rule: HashtagRule): { texts: Map<string, string>; bare: P[] } {
  const texts = new Map<string, string>()
  const bare: P[] = []
  for (const id of post.platforms) {
    const text = platformPostText(post, id, rule)
    texts.set(id, text)
    if (text === '') bare.push(id)
  }
  return { texts, bare }
}
