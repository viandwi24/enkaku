import { z } from 'zod'

/**
 * Hashtags, kept apart from the caption (0.19.0).
 *
 * The owner (2026-09-14): a caption is written per video (by hand or by auto caption), while hashtags are partly a
 * decision about the whole session — "every video must carry #fyp", or "use one of these lines, picked at random" —
 * and partly the video's own. So they are stored as three pieces and only JOINED at the moment a post is sent:
 *
 * - the session's `fixed` hashtags, on every video;
 * - one of the session's `lines`, picked once per video when the session is made (`randomLine`), so a retry posts the
 *   same hashtags the first attempt did;
 * - the video's own `hashtags`.
 *
 * `composePostText` is the one place the three become the text an upload flow types.
 */

/** What a platform's caption box holds, and what `update-post` enforces for the caption alone. */
export const POST_TEXT_LIMIT = 2_200

export const HashtagRuleSchema = z.object({
  /** On every video of the session, e.g. `['#fyp']`. */
  fixed: z.array(z.string().min(1).max(100)).max(30).default([]),
  /** Candidate lines, each a space-separated set of hashtags, e.g. `'#trading #gold'`. */
  lines: z.array(z.string().min(1).max(500)).max(50).default([]),
  /** Pick one line at random for each video when the session is made. With it off, no line is used. */
  randomLine: z.boolean().default(false),
})
export type HashtagRule = z.infer<typeof HashtagRuleSchema>

export const NO_HASHTAG_RULE: HashtagRule = { fixed: [], lines: [], randomLine: false }

/**
 * `'#FYP, trading  #gold'` → `['#FYP', '#trading', '#gold']`: split on spaces, commas and newlines, one leading `#`
 * each, characters a hashtag cannot hold dropped, duplicates (case-insensitive) removed, first spelling kept.
 */
export function normalizeHashtags(input: readonly string[] | string): string[] {
  const raw = typeof input === 'string' ? [input] : input
  const out: string[] = []
  const seen = new Set<string>()
  for (const chunk of raw) {
    for (const token of chunk.split(/[\s,]+/)) {
      const body = token.replace(/^#+/, '').replace(/[^\p{L}\p{N}_]/gu, '')
      if (body === '') continue
      const key = body.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      out.push(`#${body}`)
    }
  }
  return out
}

/** The line a new video gets: a random index when the rule asks for one and has lines, otherwise null. */
export function pickHashtagLine(rule: HashtagRule, random: () => number = Math.random): number | null {
  if (!rule.randomLine || rule.lines.length === 0) return null
  return Math.min(rule.lines.length - 1, Math.floor(random() * rule.lines.length))
}

/** Everything a video posts with, in order: the session's fixed ones, its picked line, its own — deduplicated. */
export function hashtagsFor(input: { rule: HashtagRule; line: number | null; own: readonly string[] }): string[] {
  const line = input.line !== null ? (input.rule.lines[input.line] ?? '') : ''
  return normalizeHashtags([...input.rule.fixed, line, ...input.own])
}

/**
 * The text an upload flow types: the caption, a blank line, the hashtags. Never longer than `POST_TEXT_LIMIT` —
 * hashtags are dropped from the END until it fits, so the caption and the session's fixed hashtags are the last to
 * go. Empty when both the caption and the hashtags are.
 */
export function composePostText(caption: string, hashtags: readonly string[]): string {
  const text = caption.trim().slice(0, POST_TEXT_LIMIT)
  const tags = [...hashtags]
  const join = (): string => (tags.length === 0 ? text : text === '' ? tags.join(' ') : `${text}\n\n${tags.join(' ')}`)
  while (tags.length > 0 && join().length > POST_TEXT_LIMIT) tags.pop()
  return join()
}
