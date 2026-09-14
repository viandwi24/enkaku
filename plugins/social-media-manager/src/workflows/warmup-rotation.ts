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
 * 2. **Which platform** — `($device.number + slot + day) % 3`: TikTok,
 *    Instagram or YouTube. Keyed on the phone's durable NUMBER (never its batch
 *    position — CLAUDE.md, "$device.number is the durable device key"), so the
 *    fleet splits into exact thirds (80 → 27/27/26), and `day` (whole days
 *    since the epoch in WIB) moves every phone to the next platform each day:
 *    a single daily 09:00 schedule reaches all three platforms per phone over
 *    three days instead of the same one forever. `slot` shifts the whole
 *    rotation for a second schedule on the same day.
 * 3. **Which style** — inside a platform, a weighted switch sends each phone to
 *    one of three sub-groups with different activities: on TikTok one phone
 *    watches its For You page while the next searches a keyword and another
 *    checks notifications. Drawn per run, so the sub-groups are different
 *    phones every day.
 * 4. **How it behaves** — each style is a shuffle (random order, an 8-20 s
 *    random gap, a failing member does not end the run), and every count is a
 *    fresh draw: how many videos, reels or scrolls, how long to watch, and
 *    which of the keywords to search.
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
const PLATFORM = `($device.number + $params.slot + ${DAY}) % 3`
/** One of the keywords, drawn for this step. */
const KEYWORD = { expr: 'at($params.keywords, rand(len($params.keywords)))' }
const KEYWORDS = { param: 'keywords' }
const GAP = { expr: '8000 + rand() * 12000' }

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
    betweenMaxMs: 20000,
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
  ],
  entry: 'start',
  nodes: [
    { id: 'start', title: 'Start', ui: { x: 0, y: -120 }, enabled: true, kind: 'start', next: 'stagger' },
    {
      id: 'stagger',
      title: 'Random start (0-2 min)',
      ui: { x: 0, y: 0 },
      enabled: true,
      kind: 'delay',
      ms: { expr: 'rand(120000)' },
      maxMs: 120000,
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
    shuffle('tt-a', 'TikTok: For You + inbox', -960, ['tt-a-fyp', 'tt-a-notif']),
    script('tt-a-fyp', 'Scroll For You', 'tiktok/auto-scroll@latest', -960, 500, {
      videos: { expr: '15 + rand(25)' },
      maxMinutes: { expr: '6 + rand(8)' },
      keywords: KEYWORDS,
    }),
    script('tt-a-notif', 'Check notifications', 'tiktok/notification-activity@latest', -960, 570, { scrolls: { expr: '1 + rand(5)' } }),
    shuffle('tt-b', 'TikTok: keyword videos + For You', -720, ['tt-b-videos', 'tt-b-fyp']),
    script('tt-b-videos', 'Watch keyword videos', 'tiktok/keyword-videos@latest', -720, 500, {
      query: KEYWORD,
      videos: { expr: '2 + rand(4)' },
      keywords: KEYWORDS,
    }),
    script('tt-b-fyp', 'Scroll For You (short)', 'tiktok/auto-scroll@latest', -720, 570, {
      videos: { expr: '8 + rand(12)' },
      maxMinutes: { expr: '3 + rand(5)' },
      keywords: KEYWORDS,
    }),
    shuffle('tt-c', 'TikTok: search + inbox + videos', -480, ['tt-c-search', 'tt-c-notif', 'tt-c-videos']),
    script('tt-c-search', 'Search a keyword', 'tiktok/search-keyword@latest', -480, 500, { query: KEYWORD }),
    script('tt-c-notif', 'Check notifications', 'tiktok/notification-activity@latest', -480, 570, { scrolls: { expr: '1 + rand(4)' } }),
    script('tt-c-videos', 'Watch keyword videos', 'tiktok/keyword-videos@latest', -480, 640, {
      query: KEYWORD,
      videos: { expr: '1 + rand(3)' },
      keywords: KEYWORDS,
    }),

    // --- Instagram ---------------------------------------------------------
    styles('ig-style', 'Instagram style', 0, [
      { to: 'ig-a', label: 'Reels & stories' },
      { to: 'ig-b', label: 'Explore & feed' },
      { to: 'ig-c', label: 'Search & profile' },
    ]),
    shuffle('ig-a', 'Instagram: reels + stories + activity', -240, ['ig-a-reels', 'ig-a-stories', 'ig-a-activity']),
    script('ig-a-reels', 'Scroll reels', 'instagram/scroll-reels@latest', -240, 500, { reels: { expr: '6 + rand(10)' }, keywords: KEYWORDS }),
    script('ig-a-stories', 'Watch stories', 'instagram/watch-stories@latest', -240, 570, { frames: { expr: '5 + rand(10)' } }),
    script('ig-a-activity', 'Check activity', 'instagram/check-activity@latest', -240, 640),
    shuffle('ig-b', 'Instagram: explore + feed + inbox', 0, ['ig-b-explore', 'ig-b-feed', 'ig-b-inbox']),
    script('ig-b-explore', 'Explore reels', 'instagram/explore-reels@latest', 0, 500, { reels: { expr: '4 + rand(8)' }, keywords: KEYWORDS }),
    script('ig-b-feed', 'Scroll feed', 'instagram/scroll-feed@latest', 0, 570, { posts: { expr: '8 + rand(12)' }, keywords: KEYWORDS }),
    script('ig-b-inbox', 'Check inbox', 'instagram/check-inbox@latest', 0, 640),
    shuffle('ig-c', 'Instagram: search + explore + profile', 240, ['ig-c-search', 'ig-c-explore', 'ig-c-profile']),
    script('ig-c-search', 'Search a keyword', 'instagram/search-keyword@latest', 240, 500, { query: KEYWORD }),
    script('ig-c-explore', 'Explore reels', 'instagram/explore-reels@latest', 240, 570, { reels: { expr: '3 + rand(6)' }, keywords: KEYWORDS }),
    script('ig-c-profile', 'Check profile', 'instagram/check-profile@latest', 240, 640),

    // --- YouTube -----------------------------------------------------------
    styles('yt-style', 'YouTube style', 720, [
      { to: 'yt-a', label: 'Shorts' },
      { to: 'yt-b', label: 'Search & play' },
      { to: 'yt-c', label: 'Watch & home' },
    ]),
    shuffle('yt-a', 'YouTube: Shorts + search', 480, ['yt-a-shorts', 'yt-a-search']),
    script('yt-a-shorts', 'Scroll Shorts', 'youtube/scroll-shorts@latest', 480, 500, { videos: { expr: '6 + rand(10)' }, keywords: KEYWORDS }),
    script('yt-a-search', 'Search and play', 'youtube/search-play@latest', 480, 570, {
      query: KEYWORD,
      watchMs: { expr: '20000 + rand(40000)' },
      keywords: KEYWORDS,
    }),
    shuffle('yt-b', 'YouTube: search + Shorts', 720, ['yt-b-search', 'yt-b-shorts']),
    script('yt-b-search', 'Search and play', 'youtube/search-play@latest', 720, 500, {
      query: KEYWORD,
      watchMs: { expr: '45000 + rand(90000)' },
      keywords: KEYWORDS,
    }),
    script('yt-b-shorts', 'Scroll Shorts (short)', 'youtube/scroll-shorts@latest', 720, 570, { videos: { expr: '3 + rand(6)' }, keywords: KEYWORDS }),
    shuffle('yt-c', 'YouTube: watch + home', 960, ['yt-c-watch', 'yt-c-home']),
    script('yt-c-watch', 'Search and watch', 'youtube/watch-video@latest', 960, 500, { query: KEYWORD, keywords: KEYWORDS }),
    script('yt-c-home', 'Home feed', 'youtube/download-home@latest', 960, 570, { videos: { expr: '1 + rand(2)' } }),

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
