import type { WorkflowDocInput } from '@enkaku/protocol'

/**
 * The three-platform warm-up rotation (plan 314), shipped by this plugin as
 * `smm/warmup-rotation` (plan 315) — tuned for a trading and finance niche.
 *
 * The owner's real use (2026-09-14): eighty phones warmed up at once, every
 * day at a fixed hour, so each phone's For You page fills with trading and
 * finance content — without eighty phones visibly doing the same thing at the
 * same moment. So one run is four layers of difference, each from a different
 * source:
 *
 * 1. **When it starts** — a random 0-2 min wait per phone, on top of whatever
 *    per-device delay the schedule itself adds.
 * 2. **Which platform** — `($device.number + slot + $run.repeat + day) % 3`:
 *    TikTok, Instagram or YouTube. Keyed on the phone's durable NUMBER (never
 *    its batch position — CLAUDE.md, "$device.number is the durable device
 *    key"), so the fleet splits into exact thirds (80 → 27/27/26).
 *    `$run.repeat` is the PHASE (plan 316): run it from a schedule with 3
 *    repetitions, sub-groups of 27, order by device number and "one after
 *    another", and every sub-group runs in turn, then the platform groups swap
 *    and the sub-groups run again — every phone warms up every platform in one
 *    day. `day` shifts the whole rotation daily; `slot` shifts it for a second
 *    schedule on the same day.
 * 3. **Which style** — inside a platform, a weighted switch sends each phone to
 *    one of three sub-groups with different activities: on TikTok one phone
 *    watches its For You page while the next searches a keyword and another
 *    checks notifications. Drawn per run, so the sub-groups are different
 *    phones every day.
 * 4. **How it behaves** — each style is a shuffle (random order, a random gap
 *    between `gapMinSec` and `gapMaxSec`, a failing member does not end the
 *    run), and every count is a fresh draw scaled by `amount`: how many
 *    videos, reels or scrolls, how long to watch, and which keyword to search.
 *    The pace is the operator's: a slow warm-up is longer gaps and a larger
 *    amount.
 *
 * `keywords` is the niche: searched as queries and passed to every script that
 * tilts watch time, likes or comments toward matching content. Ten Indonesian
 * trading and finance terms by default; change them per schedule.
 *
 * Refs are `@latest` on purpose: the platform packs version independently of
 * this one, and a pin to today's tiktok version would point at a version a
 * fresh farm, seeded with a newer pack, never had. The farm's `/validate`
 * says so (`W_WORKFLOW_LATEST_REF`), and that is the honest trade.
 */

/** Whole days since the epoch in WIB (UTC+7), so the rotation turns at local midnight, not 07:00. */
const DAY = 'floor((now() + 25200000) / 86400000)'
/** `$run.repeat` is the phase (plan 316): a schedule with 3 sequential repetitions gives every phone every platform in one day. */
const PLATFORM = `($device.number + $params.slot + $run.repeat + ${DAY}) % 3`
/** One of the keywords, drawn for this step. */
const KEYWORD = { expr: 'at($params.keywords, rand(len($params.keywords)))' }
const KEYWORDS = { param: 'keywords' }
const GAP = { expr: '($params.gapMinSec + rand() * max(0, $params.gapMaxSec - $params.gapMinSec)) * 1000' }
/** A count scaled by the operator's `amount` — never below 1. */
const scaled = (expr: string) => ({ expr: `max(1, round((${expr}) * $params.amount))` })

type Node = WorkflowDocInput['nodes'][number]

function script(id: string, title: string, ref: string, x: number, y: number, params: Record<string, unknown> = {}): Node {
  return { id, title, ui: { x, y }, enabled: true, kind: 'script', script: ref, params } as Node
}

function shuffle(id: string, title: string, x: number, members: string[]): Node {
  return {
    id,
    title,
    ui: { x, y: 380 },
    enabled: true,
    kind: 'shuffle',
    members,
    between: GAP,
    betweenMaxMs: 300000,
    continueOnMemberFailure: true,
    next: 'done',
  } as Node
}

function styles(id: string, title: string, x: number, cases: { to: string; label: string }[]): Node {
  return {
    id,
    title,
    ui: { x, y: 260 },
    enabled: true,
    kind: 'switch',
    mode: 'weighted',
    cases: cases.map((c) => ({ weight: 1, to: c.to, label: c.label })),
  } as Node
}

export const warmupRotation: WorkflowDocInput = {
  schema: 2,
  name: 'warmup-rotation',
  title: 'Warmup rotation (trading niche)',
  description:
    'Platform rotates per phone per day ($device.number + slot + day); each phone then draws one of three styles, shuffled with random gaps, counts and a trading keyword.',
  params: [
    {
      name: 'slot',
      type: 'number',
      required: true,
      default: 0,
      title: 'Session slot',
      description: 'Shifts the platform rotation. Leave 0 for one schedule a day; give a second schedule on the same day 1, a third 2.',
    },
    {
      name: 'keywords',
      type: 'stringList',
      required: true,
      default: ['trading', 'forex', 'gold', 'xau', 'scalping', 'full margin', 'belajar trading', 'saham', 'crypto', 'investasi'],
      title: 'Niche keywords',
      description: 'Searched as queries, and used to hold attention on matching videos. One to ten.',
      min: 1,
      max: 10,
    },
    {
      name: 'gapMinSec',
      type: 'number',
      required: true,
      default: 8,
      title: 'Gap between activities, min (s)',
      description: 'Each phone waits a random time between these two before its next activity. Slow: 20-60.',
      min: 0,
      max: 300,
    },
    {
      name: 'gapMaxSec',
      type: 'number',
      required: true,
      default: 20,
      title: 'Gap between activities, max (s)',
      description: 'Must be at least the minimum; the ceiling is 300.',
      min: 0,
      max: 300,
    },
    {
      name: 'amount',
      type: 'number',
      required: true,
      default: 1,
      title: 'Activity amount (×)',
      description: 'Scales how many videos, reels and scrolls, and how long to watch. 0.5 is a short session, 2 a long one.',
      min: 0.2,
      max: 3,
    },
    {
      name: 'startDelayMaxSec',
      type: 'number',
      required: true,
      default: 120,
      title: 'Random start delay, max (s)',
      description: 'Each phone first waits a random 0 to this many seconds, so a sub-group does not start in the same instant.',
      min: 0,
      max: 300,
    },
  ],
  entry: 'start',
  nodes: [
    { id: 'start', title: 'Start', ui: { x: 0, y: -120 }, enabled: true, kind: 'start', next: 'stagger' },
    {
      id: 'stagger',
      title: 'Random start delay',
      ui: { x: 0, y: 0 },
      enabled: true,
      kind: 'delay',
      ms: { expr: 'rand($params.startDelayMaxSec * 1000 + 1)' },
      maxMs: 300000,
      next: 'pick',
    },
    {
      id: 'pick',
      title: 'Platform for this phone today',
      ui: { x: 0, y: 120 },
      enabled: true,
      kind: 'switch',
      mode: 'predicate',
      cases: [
        { when: { left: { expr: PLATFORM }, op: 'eq', right: { const: 0 } }, to: 'tt-style', label: 'TikTok' },
        { when: { left: { expr: PLATFORM }, op: 'eq', right: { const: 1 } }, to: 'ig-style', label: 'Instagram' },
        { when: { left: { expr: PLATFORM }, op: 'eq', right: { const: 2 } }, to: 'yt-style', label: 'YouTube' },
      ],
      // A phone with no number reserved has no `$device.number`, so no case matches. It fails by name rather than
      // ending "succeeded" having warmed up nothing.
      default: 'no-number',
    },

    // --- TikTok ------------------------------------------------------------
    styles('tt-style', 'TikTok style', -720, [
      { to: 'tt-a', label: 'For You' },
      { to: 'tt-b', label: 'Keyword videos' },
      { to: 'tt-c', label: 'Search & inbox' },
    ]),
    shuffle('tt-a', 'TikTok: For You + notifications + shop', -960, ['tt-a-fyp', 'tt-a-notif', 'tt-a-shop']),
    script('tt-a-fyp', 'Scroll For You', 'tiktok/auto-scroll@latest', -960, 500, {
      videos: scaled('15 + rand(25)'),
      maxMinutes: scaled('6 + rand(8)'),
      keywords: KEYWORDS,
    }),
    script('tt-a-notif', 'Check notifications', 'tiktok/notification-activity@latest', -960, 570, { scrolls: scaled('1 + rand(5)') }),
    script('tt-a-shop', 'Browse the shop', 'tiktok/shop-browse@latest', -960, 640, { scrolls: scaled('3 + rand(5)') }),
    shuffle('tt-b', 'TikTok: keyword videos + For You + LIVE', -720, ['tt-b-videos', 'tt-b-fyp', 'tt-b-live']),
    script('tt-b-videos', 'Watch keyword videos', 'tiktok/keyword-videos@latest', -720, 500, {
      query: KEYWORD,
      videos: scaled('2 + rand(4)'),
      keywords: KEYWORDS,
    }),
    script('tt-b-fyp', 'Scroll For You (short)', 'tiktok/auto-scroll@latest', -720, 570, {
      videos: scaled('8 + rand(12)'),
      maxMinutes: scaled('3 + rand(5)'),
      keywords: KEYWORDS,
    }),
    script('tt-b-live', 'Browse LIVE', 'tiktok/live-browse@latest', -720, 640, { query: KEYWORD, scrolls: scaled('2 + rand(4)') }),
    shuffle('tt-c', 'TikTok: search + notifications + videos', -480, ['tt-c-search', 'tt-c-notif', 'tt-c-videos']),
    script('tt-c-search', 'Search a keyword', 'tiktok/search-keyword@latest', -480, 500, { query: KEYWORD }),
    script('tt-c-notif', 'Check notifications', 'tiktok/notification-activity@latest', -480, 570, { scrolls: scaled('1 + rand(4)') }),
    script('tt-c-videos', 'Watch keyword videos', 'tiktok/keyword-videos@latest', -480, 640, {
      query: KEYWORD,
      videos: scaled('1 + rand(3)'),
      keywords: KEYWORDS,
    }),

    // --- Instagram ---------------------------------------------------------
    styles('ig-style', 'Instagram style', 0, [
      { to: 'ig-a', label: 'Reels & stories' },
      { to: 'ig-b', label: 'Explore & feed' },
      { to: 'ig-c', label: 'Search & profile' },
    ]),
    shuffle('ig-a', 'Instagram: reels + stories + activity', -240, ['ig-a-reels', 'ig-a-stories', 'ig-a-activity']),
    script('ig-a-reels', 'Scroll reels', 'instagram/scroll-reels@latest', -240, 500, { reels: scaled('6 + rand(10)'), keywords: KEYWORDS }),
    script('ig-a-stories', 'Watch stories', 'instagram/watch-stories@latest', -240, 570, { frames: scaled('5 + rand(10)') }),
    script('ig-a-activity', 'Check activity', 'instagram/check-activity@latest', -240, 640),
    shuffle('ig-b', 'Instagram: explore + feed + inbox', 0, ['ig-b-explore', 'ig-b-feed', 'ig-b-inbox']),
    script('ig-b-explore', 'Explore reels', 'instagram/explore-reels@latest', 0, 500, { reels: scaled('4 + rand(8)'), keywords: KEYWORDS }),
    script('ig-b-feed', 'Scroll feed', 'instagram/scroll-feed@latest', 0, 570, { posts: scaled('8 + rand(12)'), keywords: KEYWORDS }),
    script('ig-b-inbox', 'Check inbox', 'instagram/check-inbox@latest', 0, 640),
    shuffle('ig-c', 'Instagram: search + explore + profile', 240, ['ig-c-search', 'ig-c-explore', 'ig-c-profile']),
    script('ig-c-search', 'Search a keyword', 'instagram/search-keyword@latest', 240, 500, { query: KEYWORD }),
    script('ig-c-explore', 'Explore reels', 'instagram/explore-reels@latest', 240, 570, { reels: scaled('3 + rand(6)'), keywords: KEYWORDS }),
    script('ig-c-profile', 'Check profile', 'instagram/check-profile@latest', 240, 640),

    // --- YouTube -----------------------------------------------------------
    styles('yt-style', 'YouTube style', 720, [
      { to: 'yt-a', label: 'Shorts' },
      { to: 'yt-b', label: 'Search & play' },
      { to: 'yt-c', label: 'Watch & home' },
    ]),
    shuffle('yt-a', 'YouTube: Shorts + search + live', 480, ['yt-a-shorts', 'yt-a-search', 'yt-a-live']),
    script('yt-a-shorts', 'Scroll Shorts', 'youtube/scroll-shorts@latest', 480, 500, { videos: scaled('6 + rand(10)'), keywords: KEYWORDS }),
    script('yt-a-search', 'Search and play', 'youtube/search-play@latest', 480, 570, {
      query: KEYWORD,
      watchMs: scaled('20000 + rand(40000)'),
      keywords: KEYWORDS,
    }),
    shuffle('yt-b', 'YouTube: search + Shorts', 720, ['yt-b-search', 'yt-b-shorts']),
    script('yt-b-search', 'Search and play', 'youtube/search-play@latest', 720, 500, {
      query: KEYWORD,
      watchMs: scaled('45000 + rand(90000)'),
      keywords: KEYWORDS,
    }),
    script('yt-b-shorts', 'Scroll Shorts (short)', 'youtube/scroll-shorts@latest', 720, 570, { videos: scaled('3 + rand(6)'), keywords: KEYWORDS }),
    script('yt-a-live', 'Browse live streams', 'youtube/scroll-live@latest', 480, 640, { query: KEYWORD, scrolls: scaled('3 + rand(5)') }),
    shuffle('yt-c', 'YouTube: watch + home + a channel', 960, ['yt-c-watch', 'yt-c-home', 'yt-c-channel']),
    script('yt-c-watch', 'Search and watch', 'youtube/watch-video@latest', 960, 500, { query: KEYWORD, keywords: KEYWORDS }),
    script('yt-c-home', 'Home feed', 'youtube/download-home@latest', 960, 570, { videos: scaled('1 + rand(2)') }),
    script('yt-c-channel', 'Open a channel', 'youtube/search-channel@latest', 960, 640, { query: KEYWORD }),

    {
      id: 'no-number',
      title: 'No device number',
      ui: { x: 240, y: 120 },
      enabled: true,
      kind: 'finish',
      status: 'fail',
      message: 'This phone has no device number, so its platform cannot be chosen. Reserve a number for it on the Devices page.',
    },
    { id: 'done', title: 'Done', ui: { x: 0, y: 760 }, enabled: true, kind: 'finish', status: 'succeed', message: '' },
  ],
  maxSteps: 50,
}
