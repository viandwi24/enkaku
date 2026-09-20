import type { PlatformId } from './platforms'

/**
 * What a phone can be asked to do during a warm-up, as data this plugin can
 * type-check (plan 900 D1, wave 2).
 *
 * This is the same nine styles `workflows/warmup-rotation.ts` drew as a graph,
 * with the same scripts and the same counts. What changed is the language: a
 * count that was `scaled('15 + rand(25)')` — a string for an expression engine
 * to parse at run time — is `scaled(draw, 15, 25)` here, and a typo in it fails
 * `bun run typecheck` rather than a phone.
 *
 * ## Why the counts are drawn, not fixed
 *
 * Every number below is a base plus a random spread, scaled by the operator's
 * `amount`. That is not decoration: eighty phones that each scroll exactly
 * twenty videos are eighty phones doing an identical thing, which is the shape
 * a platform looks for. The draw happens per phone per session.
 *
 * ## Why `@latest` on every ref
 *
 * The platform packs version independently of this one, and a pin to today's
 * tiktok version would name a version a fresh farm — seeded with a newer pack —
 * never had. Inherited from the rotation, and the trade is unchanged.
 */

/** Everything a params function is allowed to read. Passed in so a test gets the same draw twice. */
export interface WarmupDraw {
  keywords: readonly string[]
  /** Scales every count; 0.5 is a short session, 2 a long one. */
  amount: number
  /** The account's interests, as rates: the base like and comment chances, and what a keyword match multiplies them by. */
  like: { chance: number; commentChance: number; keywordBoost: number }
  random: () => number
}

export interface WarmupActivity {
  /** Stable id, used by a session row and by nothing else. */
  id: string
  title: string
  /** The script ref this dispatches, `pack/member@latest`. */
  script: string
  params: (draw: WarmupDraw) => Record<string, unknown>
}

export interface WarmupStyle {
  /** Stable id — `styleWeights` keys on it, so renaming one resets an operator's weighting. */
  id: string
  platform: PlatformId
  title: string
  activities: readonly WarmupActivity[]
}

/** A count: base plus a spread, scaled by `amount`, never below 1. */
export function scaled(draw: WarmupDraw, base: number, spread: number): number {
  return Math.max(1, Math.round((base + Math.floor(draw.random() * spread)) * draw.amount))
}

/**
 * The same, but never below `min`.
 *
 * `scaled` floors at 1, and two members declare a higher minimum of their own
 * (`youtube/check-notifications` wants `maxItems >= 5`, `check-profile` wants
 * `maxRows >= 3`). A low `amount` would otherwise draw a value the member's own
 * schema refuses at dispatch — a failure the operator would read as the script
 * being broken. Carried over from the rotation, which learnt it in 0.49.0.
 */
export function scaledAtLeast(draw: WarmupDraw, min: number, base: number, spread: number): number {
  return Math.max(min, Math.round((base + Math.floor(draw.random() * spread)) * draw.amount))
}

/** One of the operator's keywords, drawn for this step. */
export function keyword(draw: WarmupDraw): string {
  return draw.keywords[Math.floor(draw.random() * draw.keywords.length)] ?? (draw.keywords[0] as string)
}

/**
 * The like settings, for the members that accept them.
 *
 * Spread only onto scripts whose schema actually declares these two names —
 * checked member by member against the packs (2026-09-20). A params object
 * carrying a name the member does not declare is refused at dispatch, so this
 * is never applied blanket.
 */
export function likes(draw: WarmupDraw): { likeProbability: number; keywordBoostFactor: number } {
  return { likeProbability: draw.like.chance, keywordBoostFactor: draw.like.keywordBoost }
}

/**
 * Like AND the comment sheet, for the members that accept both.
 *
 * ## What the keywords are actually for
 *
 * They are the account's INTERESTS, not a search term list. The owner put it
 * plainly (2026-09-20): *"keywords itu dipakai sebagai sarana personality atau
 * interests nya ... selama nanti pas di scroll fyp ada title / description /
 * hastags yang berhubungan sama kata trading, maka menaikan likes dan open
 * comment section"*.
 *
 * Every scrolling member already implements exactly that — it reads the
 * caption, the author and the hashtags of what is on screen, and multiplies
 * BOTH chances by `keywordBoostFactor` on a match. What was missing was this
 * plugin sending the second one: eight of the nine styles passed
 * `likeProbability` and left `commentProbability` at the script's own default,
 * so a phone's interests tilted what it liked and never what it read. Found by
 * checking every activity's params against the packs' schemas
 * (`scripts/check-warmup-params.ts`), not on a phone — an unsent param is
 * silent, which is why it survived a working feature for two versions.
 */
export function likesAndComments(draw: WarmupDraw): { likeProbability: number; commentProbability: number; keywordBoostFactor: number } {
  return { likeProbability: draw.like.chance, commentProbability: draw.like.commentChance, keywordBoostFactor: draw.like.keywordBoost }
}

/**
 * The keyword boost alone, for a member that tilts watch time by keyword but
 * has no like of its own.
 *
 * `tiktok/keyword-videos` is the one: it declares `keywordBoostFactor` and
 * does NOT declare `likeProbability`. Found by checking every param in this
 * file against the packs' schemas (2026-09-20) rather than on a phone —
 * `likes()` was being spread onto it, and an undeclared param is refused at
 * dispatch, so every TikTok phone drawn into `tt-b` or `tt-c` would have
 * failed with a validation error that named the plugin and not this line.
 */
export function boost(draw: WarmupDraw): { keywordBoostFactor: number } {
  return { keywordBoostFactor: draw.like.keywordBoost }
}

const activity = (id: string, title: string, script: string, params: WarmupActivity['params'] = () => ({})): WarmupActivity => ({ id, title, script, params })

/**
 * The nine styles, three per platform — node for node the rotation's own.
 *
 * Three rather than one because a warm-up where every phone on a platform does
 * the same three things in the same order is one pattern, however well it is
 * shuffled. A phone draws a style per session, so the sub-groups are different
 * phones every time.
 */
export const WARMUP_STYLES: readonly WarmupStyle[] = [
  // --- TikTok ---------------------------------------------------------------
  {
    id: 'tt-a',
    platform: 'tiktok',
    title: 'For You, notifications and the shop',
    activities: [
      activity('tt-a-fyp', 'Scroll For You', 'tiktok/auto-scroll@latest', (d) => ({ videos: scaled(d, 15, 25), maxMinutes: scaled(d, 6, 8), keywords: [...d.keywords] })),
      activity('tt-a-notif', 'Check notifications', 'tiktok/notification-activity@latest', (d) => ({ scrolls: scaled(d, 1, 5) })),
      activity('tt-a-shop', 'Browse the shop', 'tiktok/shop-browse@latest', (d) => ({ scrolls: scaled(d, 3, 5) })),
    ],
  },
  {
    id: 'tt-b',
    platform: 'tiktok',
    title: 'Keyword videos and For You',
    activities: [
      activity('tt-b-videos', 'Watch keyword videos', 'tiktok/keyword-videos@latest', (d) => ({ query: keyword(d), videos: scaled(d, 2, 4), keywords: [...d.keywords], ...boost(d) })),
      activity('tt-b-fyp', 'Scroll For You (short)', 'tiktok/auto-scroll@latest', (d) => ({ videos: scaled(d, 8, 12), maxMinutes: scaled(d, 3, 5), keywords: [...d.keywords] })),
    ],
  },
  {
    id: 'tt-c',
    platform: 'tiktok',
    title: 'Search, notifications and videos',
    activities: [
      activity('tt-c-search', 'Search a keyword', 'tiktok/search-keyword@latest', (d) => ({ query: keyword(d) })),
      activity('tt-c-notif', 'Check notifications', 'tiktok/notification-activity@latest', (d) => ({ scrolls: scaled(d, 1, 4) })),
      activity('tt-c-videos', 'Watch keyword videos', 'tiktok/keyword-videos@latest', (d) => ({ query: keyword(d), videos: scaled(d, 1, 3), keywords: [...d.keywords], ...boost(d) })),
    ],
  },

  // --- Instagram ------------------------------------------------------------
  {
    id: 'ig-a',
    platform: 'instagram',
    title: 'Reels, stories and activity',
    activities: [
      activity('ig-a-reels', 'Scroll reels', 'instagram/scroll-reels@latest', (d) => ({ reels: scaled(d, 6, 10), keywords: [...d.keywords], ...likesAndComments(d) })),
      /* `watch-stories` likes but has no keyword boost of its own — it never reads a caption. Sending one would be refused. */
      activity('ig-a-stories', 'Watch stories', 'instagram/watch-stories@latest', (d) => ({ frames: scaled(d, 5, 10), likeProbability: d.like.chance })),
      activity('ig-a-activity', 'Check activity', 'instagram/check-activity@latest'),
    ],
  },
  {
    id: 'ig-b',
    platform: 'instagram',
    title: 'Explore, feed and inbox',
    activities: [
      activity('ig-b-explore', 'Explore reels', 'instagram/explore-reels@latest', (d) => ({ reels: scaled(d, 4, 8), keywords: [...d.keywords], ...likesAndComments(d) })),
      activity('ig-b-feed', 'Scroll feed', 'instagram/scroll-feed@latest', (d) => ({ posts: scaled(d, 8, 12), keywords: [...d.keywords], ...likes(d) })),
      activity('ig-b-inbox', 'Check inbox', 'instagram/check-inbox@latest'),
    ],
  },
  {
    id: 'ig-c',
    platform: 'instagram',
    title: 'Search, explore and the profile',
    activities: [
      activity('ig-c-search', 'Search a keyword', 'instagram/search-keyword@latest', (d) => ({ query: keyword(d) })),
      activity('ig-c-explore', 'Explore reels', 'instagram/explore-reels@latest', (d) => ({ reels: scaled(d, 3, 6), keywords: [...d.keywords], ...likesAndComments(d) })),
      activity('ig-c-profile', 'Check profile', 'instagram/check-profile@latest'),
    ],
  },

  // --- YouTube --------------------------------------------------------------
  {
    id: 'yt-a',
    platform: 'youtube',
    title: 'Shorts, search and notifications',
    activities: [
      activity('yt-a-shorts', 'Scroll Shorts', 'youtube/scroll-shorts@latest', (d) => ({ videos: scaled(d, 6, 10), keywords: [...d.keywords], ...likesAndComments(d) })),
      activity('yt-a-search', 'Search and play', 'youtube/search-play@latest', (d) => ({ query: keyword(d), watchMs: scaled(d, 20_000, 40_000), keywords: [...d.keywords], ...likesAndComments(d) })),
      activity('yt-a-notif', 'Check notifications', 'youtube/check-notifications@latest', (d) => ({ maxItems: scaledAtLeast(d, 5, 10, 20) })),
    ],
  },
  {
    id: 'yt-b',
    platform: 'youtube',
    title: 'Search and Shorts',
    activities: [
      activity('yt-b-search', 'Search and play', 'youtube/search-play@latest', (d) => ({ query: keyword(d), watchMs: scaled(d, 45_000, 90_000), keywords: [...d.keywords], ...likesAndComments(d) })),
      activity('yt-b-shorts', 'Scroll Shorts (short)', 'youtube/scroll-shorts@latest', (d) => ({ videos: scaled(d, 3, 6), keywords: [...d.keywords], ...likesAndComments(d) })),
    ],
  },
  {
    id: 'yt-c',
    platform: 'youtube',
    title: 'Watch, home, a channel and the profile',
    activities: [
      activity('yt-c-watch', 'Search and watch', 'youtube/watch-video@latest', (d) => ({ query: keyword(d), keywords: [...d.keywords], ...likesAndComments(d) })),
      activity('yt-c-home', 'Home feed', 'youtube/download-home@latest', (d) => ({ videos: scaled(d, 1, 2) })),
      activity('yt-c-channel', 'Open a channel', 'youtube/search-channel@latest', (d) => ({ query: keyword(d) })),
      activity('yt-c-profile', 'Check profile', 'youtube/check-profile@latest', (d) => ({ maxRows: scaledAtLeast(d, 3, 8, 12) })),
    ],
  },
]

/** The styles for one platform, in catalog order. */
export function stylesFor(platform: PlatformId): readonly WarmupStyle[] {
  return WARMUP_STYLES.filter((style) => style.platform === platform)
}
