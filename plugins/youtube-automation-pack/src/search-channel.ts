import type { PluginMemberScript } from '@enkaku/sdk'
import { ui } from '@enkaku/sdk'
import type { UiNode } from '@enkaku/protocol'
import { z } from 'zod'
import { capture, firstMatch, hasId, isVisible, sleep, tapNode, waitForTree, YOUTUBE_PACKAGE } from './youtube'
import { flatten } from './tree'

/**
 * `search-channel` — search YouTube for a channel by name and open its channel
 * page.
 *
 * The MVP, exactly as scoped: open the app, search, submit, open the channel
 * from the results, hold, close. Nothing is subscribed to, liked, commented on,
 * or played.
 *
 * ## What running this on hardware taught it (moto g06 power, 720×1640, 2026-08-26)
 *
 * **YouTube's results page is Compose, and its rows carry no `resourceId` at
 * all.** A fully loaded results page had ids for exactly three things — the
 * search bar, the bottom navigation, and four `thumbnail_layout` nodes. Every
 * result's identity lived in its content DESCRIPTION, in the device's own
 * language (Indonesian here): `Buka channel`, `Subscribe ke Eno Bening.`,
 * `Lihat Channel`.
 *
 * That single fact decides the shape of this file: anchors are descriptions,
 * not ids; they are ladders with more than one language on them; and the row
 * pick is a tree walk, because `find()` returns row 0 of a `RecyclerView` and
 * can never report `ambiguous` (`tree.ts`'s header).
 *
 * ## Why every step captures a tree
 *
 * A YouTube layout is not a fact this repo owns — it moves with the app
 * version, the locale, and the A/B bucket the install landed in. Every step
 * saves its tree and screenshot as artifacts, so a failed run arrives already
 * carrying its own bug report. Every defect fixed in 0.1.1 and 0.1.2 was read
 * out of exactly those artifacts.
 */

const paramsSchema = z.object({
  query: z
    .string()
    .min(1)
    .describe('The channel to search for, e.g. "eno bening".')
    .meta(ui({ title: 'Channel name' })),
  holdMs: z
    .number()
    .int()
    .min(0)
    .max(60_000)
    .default(3_000)
    .describe('How long to stay on the channel page before closing the app (or before opening a video, when watching).')
    .meta(ui({ title: 'Hold on channel (ms)' })),
  /**
   * One enum rather than two booleans. "Watch the latest" and "watch a random
   * one" are mutually exclusive, and a pair of booleans lets an operator ask
   * for both — a state the script would then have to invent an answer for.
   * `none` is the default, so every existing caller keeps the behaviour it has.
   */
  watch: z
    .enum(['none', 'latest', 'random'])
    .default('none')
    .describe('After opening the channel: stop there, open its newest video, or open a random one from the first screenful.')
    .meta(
      ui({
        title: 'Watch a video',
        labels: { none: 'No — channel page only', latest: 'The newest video', random: 'A random video' },
      }),
    ),
  skipAds: z
    .boolean()
    .default(true)
    .describe("Press YouTube's own \"Skip ad\" button when it appears. Only that button — the advert itself is never touched.")
    .meta(ui({ title: 'Skip skippable ads' })),
  watchMs: z
    .number()
    .int()
    .min(0)
    .max(600_000)
    .default(15_000)
    .describe('How long to leave the video playing before closing the app. Ignored when not watching.')
    .meta(ui({ title: 'Watch for (ms)' })),
})

const resultSchema = z.object({
  query: z.string().describe('What was searched for.').meta(ui({ title: 'Query' })),
  channelOpened: z
    .boolean()
    .describe('Whether a channel page was actually reached. Never true on a guess — see `channelEvidence`.')
    .meta(ui({ title: 'Channel opened', summary: true })),
  channelTitle: z.string().describe('The channel name read off the page that opened. Empty when nothing qualified — never the query echoed back.').meta(ui({ title: 'Channel', summary: true })),
  channelEvidence: z.string().describe('What on the page proved it was a channel: a handle, a subscribe control, or the channel tab strip.').meta(ui({ title: 'Evidence', summary: true })),
  resultCount: z.number().int().describe('How many result rows the results page showed.').meta(ui({ title: 'Results' })),
  anchors: z
    .record(z.string(), z.string())
    .describe('Which rung of each ladder actually matched, and how long each wait took — the measured facts this run produced about the real app.')
    .meta(ui({ title: 'Anchors used' })),
  watched: z.boolean().describe('Whether a video was actually opened and confirmed playing. False whenever `watch` was `none`.').meta(ui({ title: 'Watched', summary: true })),
  videoTitle: z.string().describe("The video that opened, read off the player. Empty when nothing was watched — never the channel's name standing in for it.").meta(ui({ title: 'Video' })),
  watchEvidence: z.string().describe('What on the screen proved a video was playing, or why nothing was watched.').meta(ui({ title: 'Watch evidence' })),
  steps: z.array(z.string()).describe('Each step reached, in order — where a failed run stopped.').meta(ui({ title: 'Steps' })),
})

/** Time for the app to draw after a cold launch. */
const LAUNCH_SETTLE_MS = 5_000
/** Time for a tap to take effect before the next dump. */
const UI_SETTLE_MS = 1_500
/** Budgets, not sleeps — see `waitForTree`. */
const RESULTS_BUDGET_MS = 30_000
const CHANNEL_BUDGET_MS = 25_000
const VIDEO_LIST_BUDGET_MS = 25_000
const PLAYER_BUDGET_MS = 30_000
/** How long to let a pre-roll advert run before giving up on it clearing. Generous: an unskippable one can run 30 s, and giving up is reported, not hidden. */
const AD_BUDGET_MS = 60_000

/** Ids belonging to the app's own chrome. A search for "eno bening" leaves "eno bening" in `search_query`, which is how 0.1.1 tapped the search bar and reopened the suggestions screen. */
const CHROME_IDS = [
  'search_query',
  'search_edit_text',
  'search_clear',
  'voice_search',
  'search_button',
  'menu_item_1',
  'menu_item_view',
  // The floating microphone. It sits OVER the content at roughly two-thirds
  // down the screen, so it is inside the content band by geometry and was the
  // single labelled node on an otherwise blank results page — which is what
  // made "results are ready" fire on nothing at all, intermittently, for two
  // runs out of three.
  'fab',
] as const

function isChrome(node: UiNode): boolean {
  // The system status and navigation bars are a different package entirely and
  // would otherwise be candidates for anything.
  if (node.packageName !== '' && node.packageName !== YOUTUBE_PACKAGE) return true
  return CHROME_IDS.some((id) => hasId(node, id))
}

/** Everything readable on a node — text and description together, because Compose leaves the text empty and puts the meaning in the description. */
function rawLabel(node: UiNode): string {
  return `${node.text} ${node.desc}`.trim()
}

/** {@link rawLabel}, lowercased, for matching. Kept separate because a name read OUT of a label must keep the capitalisation the app gave it. */
function label(node: UiNode): string {
  return rawLabel(node).toLowerCase()
}

/**
 * The search entry point on the home screen.
 *
 * `menu_item_1` is YouTube's own id for the toolbar's second action and has
 * been the search button for many versions — "has been" is not "is", which is
 * why the description rungs follow it, in both languages this farm might be in.
 */
export const SEARCH_ENTRY: readonly { via: string; test: (n: UiNode) => boolean }[] = [
  { via: 'id:menu_item_1', test: (n: UiNode) => hasId(n, 'menu_item_1') },
  { via: 'id:search_button', test: (n: UiNode) => hasId(n, 'search_button') },
  { via: 'desc:Search', test: (n: UiNode) => n.desc.trim().toLowerCase() === 'search' },
  { via: 'desc:Telusuri', test: (n: UiNode) => n.desc.trim().toLowerCase() === 'telusuri' },
  { via: 'desc:Cari', test: (n: UiNode) => n.desc.trim().toLowerCase() === 'cari' },
] as const

/** The search text field, once the search screen is open. */
export const SEARCH_FIELD: readonly { via: string; test: (n: UiNode) => boolean }[] = [
  { via: 'id:search_edit_text', test: (n: UiNode) => hasId(n, 'search_edit_text') },
  { via: 'class:EditText', test: (n: UiNode) => n.className.endsWith('EditText') },
] as const

/**
 * The band of the screen that holds CONTENT.
 *
 * Both edges were paid for on hardware. Above `CHROME_BOTTOM_Y` sits the search
 * bar, whose every child is clickable and carries a description ("Kembali ke
 * atas", "Hapus", "Penelusuran suara") — 0.1.1 picked the back button as a
 * result. Below the lower edge sits YouTube's own bottom navigation, whose four
 * items are ALSO clickable and ALSO carry descriptions ("Beranda", "Shorts",
 * "Subscription", "Anda") — 0.1.3's row test matched those on a results page
 * that had loaded nothing else, declared the results ready in zero
 * milliseconds, and then found no channel on an empty page.
 *
 * The lower edge is measured from the root's own height rather than fixed, so
 * it scales with the device: the nav's top was y=1472 on a 1640-tall screen.
 */
const CHROME_BOTTOM_Y = 160
const BOTTOM_NAV_BAND = 200

/**
 * The screen height, taken as the furthest `bottom` any node reaches.
 *
 * NOT `tree.bounds.bottom`, which is what this reached for first: **the root
 * node of a dump carries `bounds` of all zeros** (measured, 2026-08-26 — the
 * root also has an empty `packageName`). So the lower edge computed to −200,
 * `inContentBand` rejected every node on the screen, and a results page with
 * four thumbnails on it reported no channel row. A whole run's failure from one
 * field that looked safe to read.
 */
export function screenHeightOf(tree: UiNode): number {
  let height = 0
  for (const node of flatten(tree)) if (node.bounds.bottom > height) height = node.bounds.bottom
  return height
}

/**
 * Would a tap on this node's CENTRE actually land on it?
 *
 * `inContentBand` tests the node's top edge, which is the right question for
 * "is this content" and the wrong one for "can this be tapped". A video row at
 * the bottom of the list had its top inside the band and its centre underneath
 * the navigation bar — so `watch: 'random'` picked it, tapped its centre, and
 * landed on **Subscription**. `watch: 'latest'` never hit it, because row 0 is
 * always comfortably on screen: a defect that only one of two code paths could
 * ever reach.
 */
function isTappable(node: UiNode, tree: UiNode): boolean {
  const height = screenHeightOf(tree)
  const centreY = (node.bounds.top + node.bounds.bottom) / 2
  if (centreY <= CHROME_BOTTOM_Y) return false
  return height === 0 || centreY < height - BOTTOM_NAV_BAND
}

function inContentBand(node: UiNode, tree: UiNode): boolean {
  const height = screenHeightOf(tree)
  if (node.bounds.top <= CHROME_BOTTOM_Y) return false
  // A tree that somehow reports no height at all must not silently exclude
  // everything — that is the exact failure this function was written to fix.
  return height === 0 || node.bounds.top < height - BOTTOM_NAV_BAND
}

/**
 * Every node in the content band that actually SAYS something.
 *
 * This is the results page's real readiness signal, and it took three attempts
 * to find. `thumbnail_layout` is an id that exists — but it renders BEFORE the
 * labels do: a page measured mid-load carried four thumbnails and not one
 * readable string, so waiting on thumbnails declared the page ready and the
 * channel search then ran against a screen with nothing on it. Waiting on "any
 * clickable node with a description" matched the bottom navigation instead
 * (0.1.4). Bounded to the content band and required to be readable, the test is
 * simply: has anything a human could read appeared between the toolbar and the
 * navigation bar?
 */
export function contentNodes(tree: UiNode): UiNode[] {
  return flatten(tree).filter((n) => isVisible(n) && !isChrome(n) && inContentBand(n, tree) && label(n) !== '')
}

/** What the result reports as `resultCount` — the thumbnails when they carry ids, else the readable rows. */
export function resultRowsOf(tree: UiNode): UiNode[] {
  const thumbs = flatten(tree).filter((n) => isVisible(n) && hasId(n, 'thumbnail_layout'))
  return thumbs.length > 0 ? thumbs : contentNodes(tree)
}

/**
 * How many readable nodes a page must show before it counts as results.
 *
 * Two, not one, and the reason is the floating microphone above: a single
 * chrome control that drifts into the content band can impersonate a result,
 * and excluding each one by id as it is discovered is a game with no end. A
 * real results page shows a title, a channel, a duration and a view count on
 * every row — it is never one lonely string.
 */
const MIN_CONTENT_NODES = 2

export function hasResultRows(tree: UiNode): boolean {
  /*
   * Still on the suggestions screen, so nothing here is a result.
   *
   * The two screens are told apart by which search widget they carry, and both
   * spellings were measured: the SUGGESTIONS screen has `search_edit_text` (a
   * focused `EditText`, keyboard up), the RESULTS page has `search_query` (a
   * static view holding what was searched for). Without this the suggestion
   * rows — "eno bening podcast", "eno bening one piece" — are readable nodes in
   * the content band and count as results, which is how 0.1.0 tapped a
   * suggestion and reported it had opened a channel.
   */
  if (flatten(tree).some((n) => hasId(n, 'search_edit_text'))) return false
  return contentNodes(tree).length >= MIN_CONTENT_NODES
}

/**
 * Which row on the results page is the CHANNEL, not a video by it.
 *
 * The one genuinely hard step, and getting it wrong is silent: a search for a
 * channel returns that channel's videos too, every row looks alike to a
 * selector, and `find()` would hand back row 0 without ever reporting the
 * ambiguity. So the pick is a walk, in falling order of how much the page
 * itself corroborates the choice.
 *
 * The first two rungs are the buttons YouTube puts on the channel result
 * specifically — measured on hardware, in Indonesian, which is why both
 * languages are listed and why neither is a `resourceId`: there is none.
 */
export function pickChannelRow(tree: UiNode, query: string): { node: UiNode; via: string } | null {
  const nodes = flatten(tree).filter((n) => isVisible(n) && !isChrome(n) && isTappable(n, tree))
  const needle = query.trim().toLowerCase()

  const rungs: readonly { via: string; test: (n: UiNode) => boolean }[] = [
    { via: 'open-channel', test: (n) => n.clickable && /^(buka|open)\s+channel\b/.test(label(n)) },
    { via: 'view-channel', test: (n) => n.clickable && /^(lihat|view)\s+channel\b/.test(label(n)) },
    // "Subscribe ke Eno Bening." names the channel and appears on no other row.
    // Used to LOCATE the row, never tapped: `clickableFor` climbs to the row
    // container, and this member subscribes to nothing.
    { via: 'channel-named', test: (n) => label(n).includes('channel') && label(n).includes(needle) },
    { via: 'handle', test: (n) => /^@[\w.\-]+$/.test(n.text.trim()) || /^@[\w.\-]+$/.test(n.desc.trim()) },
  ]

  for (const rung of rungs) {
    const found = nodes.find(rung.test)
    if (found) {
      const node = found.clickable ? found : clickableFor(tree, found)
      return { node, via: `${rung.via}:${(found.desc || found.text).trim().slice(0, 40)}` }
    }
  }
  return null
}

/**
 * Is this a channel page?
 *
 * Deliberately structural rather than a title match: the channel's own name is
 * what this run is trying to LEARN, so testing for it would be circular.
 * Descriptions are checked as well as text, for the Compose reason above.
 */
export function channelPageEvidence(tree: UiNode): { onChannel: boolean; via: string } {
  const nodes = flatten(tree)
    .filter(isVisible)
    .filter((n) => n.packageName === '' || n.packageName === YOUTUBE_PACKAGE)

  /*
   * The search bar disqualifies the page outright, and this is not belt-and-
   * braces — it is the fix for a false positive the fixture tests caught before
   * it ever ran: a RESULTS page for a channel carries `Subscribe ke Eno
   * Bening.` on the channel's own row, so the subscribe rung below matched the
   * results page itself. `waitForTree` would then have returned the instant the
   * results loaded, and the run would have reported "channel opened" while
   * still sitting on the results list.
   *
   * A results or suggestions screen always has the query in a search field; a
   * channel page never does.
   */
  if (nodes.some((n) => hasId(n, 'search_query') || hasId(n, 'search_edit_text'))) return { onChannel: false, via: 'still-on-search' }

  const handle = nodes.find((n) => /^@[\w.\-]+$/.test(n.text.trim()) || /^@[\w.\-]+$/.test(n.desc.trim()))
  if (handle) return { onChannel: true, via: `handle:${(handle.text || handle.desc).trim()}` }

  const subscribe = nodes.find((n) => hasId(n, 'subscribe_button') || /^(subscribe|subscribed|langganan|berlangganan)\b/.test(label(n)))
  if (subscribe) return { onChannel: true, via: 'subscribe-control' }

  // The channel's own tab strip. Weaker than the two above and listed last for
  // that reason — but it is what remains when a channel shows no handle and the
  // subscribe control has scrolled away.
  const tabs = ['video', 'videos', 'shorts', 'live', 'playlist', 'komunitas', 'community', 'postingan', 'posts']
  const seen = new Set(nodes.map(label).filter((v) => tabs.includes(v)))
  if (seen.size >= 2) return { onChannel: true, via: `tabs:${[...seen].sort().join(',')}` }

  return { onChannel: false, via: 'none' }
}

/**
 * The channel's own name, read off the page that opened.
 *
 * Read from the SUBSCRIBE control's description first — measured on hardware,
 * that description is `Subscribe ke Eno Bening.`, which names the channel
 * exactly and appears on no other screen. The verified badge
 * (`Eno Bening, Terverifikasi`) is the second rung.
 *
 * The "largest text node" heuristic this replaces looked reasonable and was
 * wrong on the very first real channel page: a channel's own tab strip
 * (Beranda / Video / Shorts / Live / Podcast) draws bigger text than the title
 * in the toolbar, so the run reported the channel's name as **"Beranda"** —
 * a confident, plausible, completely wrong answer. The tab labels are now
 * excluded by name and the title is taken from the topmost remaining text.
 *
 * Empty when nothing qualifies — never the query echoed back, which would make
 * a wrong page look like the right one.
 */
const CHANNEL_TABS = ['beranda', 'home', 'video', 'videos', 'shorts', 'live', 'podcast', 'playlist', 'komunitas', 'community', 'postingan', 'posts', 'about', 'tentang', 'store', 'toko']

export function readChannelTitle(tree: UiNode): string {
  /*
   * A title read off a page that is not a channel page is meaningless, and
   * worse than meaningless when it is plausible: on a results page this
   * returned the QUERY (out of the search bar), and on a mid-load page it
   * returned "Subscription" (out of the bottom navigation). Both read like an
   * answer. Gating on the same evidence the caller checks means the title and
   * `channelOpened` can never disagree.
   */
  if (!channelPageEvidence(tree).onChannel) return ''
  // `isChrome` is not optional here: the search bar holds the QUERY verbatim,
  // so without it a page with no channel on it reports the thing that was
  // searched for as though it were the channel that was found.
  const nodes = flatten(tree)
    .filter((n) => isVisible(n) && !isChrome(n) && inContentBand(n, tree))
    .filter((n) => n.packageName === '' || n.packageName === YOUTUBE_PACKAGE)

  for (const node of nodes) {
    const subscribe = /^subscribe\s+(?:ke|to)\s+(.+?)\.?$/i.exec(rawLabel(node))
    if (subscribe?.[1]) return titleCaseFrom(node, subscribe[1])
  }
  for (const node of nodes) {
    const verified = /^(.+?),\s*(?:terverifikasi|verified)$/i.exec(rawLabel(node))
    if (verified?.[1]) return titleCaseFrom(node, verified[1])
  }

  const handle = nodes.find((n) => /^@[\w.\-]+$/.test(n.text.trim()) || /^@[\w.\-]+$/.test(n.desc.trim()))
  const candidates = nodes
    .filter((n) => {
      const text = n.text.trim()
      if (text === '' || text.startsWith('@')) return false
      if (CHANNEL_TABS.includes(text.toLowerCase())) return false
      if (handle && n.bounds.top > handle.bounds.bottom) return false
      return true
    })
    .sort((a, b) => a.bounds.top - b.bounds.top)
  return candidates[0]?.text.trim() ?? ''
}

/**
 * The matched name, but taken from the node's own `text` when that says the
 * same thing — a description is lowercased and punctuated by the framework
 * ("subscribe ke eno bening."), whereas the toolbar's text node carries the
 * channel's real capitalisation.
 */
function titleCaseFrom(node: UiNode, matched: string): string {
  const text = node.text.trim()
  return text !== '' && text.toLowerCase() === matched.toLowerCase() ? text : matched.trim()
}

/**
 * The nearest clickable ancestor of `node`, or `node` itself.
 *
 * A row's label is usually an inert node inside a clickable container; tapping
 * the label does nothing, which reads as "the script did not tap" rather than
 * "the script tapped the wrong thing" and is much harder to debug.
 */
export function clickableFor(tree: UiNode, node: UiNode): UiNode {
  const path: UiNode[] = []
  const walk = (current: UiNode, trail: UiNode[]): boolean => {
    const next = [...trail, current]
    if (current === node) {
      path.push(...next)
      return true
    }
    return current.children.some((child) => walk(child, next))
  }
  walk(tree, [])
  for (let i = path.length - 1; i >= 0; i--) {
    const candidate = path[i]
    if (candidate?.clickable) return candidate
  }
  return node
}


// ---------------------------------------------------------------------------
// Watching a video (plan-less feature, 0.3.0). Everything below is measured the
// same way the search half was: run it, read the artifact, fix what the tree
// actually says rather than what the app is assumed to look like.
// ---------------------------------------------------------------------------

/** The channel page's own Video tab. `desc` first, because this app's tab strip carries its labels there and its ids nowhere. */
const VIDEO_TAB = [
  // Measured on the channel page: the tab strip's items are `tabs_bar_text_tab_view`.
  { via: 'id:tabs_bar_text_tab_view', test: (n: UiNode) => hasId(n, 'tabs_bar_text_tab_view') && ['video', 'videos'].includes(label(n)) },
  { via: 'label:video', test: (n: UiNode) => n.clickable && ['video', 'videos'].includes(label(n)) },
] as const

/**
 * Is a pre-roll advert on screen?
 *
 * Measured on the first watch run: opening a video landed on a 6-second
 * sponsored spot, and every "watch" was really watching that. Detected, waited
 * out, and reported — never interacted with. This script does not tap the
 * advert, does not skip it, and does not touch its controls; it waits for the
 * player to move on, exactly as it would if nobody were holding the phone.
 */
export function adEvidence(tree: UiNode): { ad: boolean; via: string } {
  const nodes = flatten(tree).filter((n) => isVisible(n) && (n.packageName === '' || n.packageName === YOUTUBE_PACKAGE))
  /*
   * Ids ONLY, and this is the correction that matters. A free-text rung for
   * "bersponsor"/"sponsored" was tried and it matched a **sponsored card in the
   * recommendations feed below the video** — which never goes away. The
   * pre-roll had finished at 6 seconds; the wait ran the full 90-second budget
   * and then reported a timeout on an advert that was long over.
   *
   * These two ids belong to the player's own advert overlay. If a future
   * layout renames them, this reports no advert and the watch clock starts
   * immediately — the same behaviour as a video with no advert, which is the
   * honest degradation. Guessing from words on the screen is not.
   */
  const byId = nodes.find((n) => hasId(n, 'ad_progress_text') || hasId(n, 'player_learn_more_button'))
  if (byId) return { ad: true, via: `id:${byId.resourceId.split('/').pop() ?? ''}` }
  return { ad: false, via: 'none' }
}

/**
 * YouTube's own "Skip ad" control, once it becomes pressable.
 *
 * The id first; the labels are the fallback, in both languages this farm might
 * be in. Note what is NOT here: nothing that matches the advert's own body, its
 * "Kunjungi pengiklan" call to action, or its "Pelajari selengkapnya" link.
 * This script presses the one control YouTube puts on screen for a viewer to
 * dismiss the spot with, and touches nothing else about the advert.
 */
export function skipControlOf(tree: UiNode): UiNode | null {
  const nodes = flatten(tree).filter((n) => isVisible(n) && n.enabled && (n.packageName === '' || n.packageName === YOUTUBE_PACKAGE))
  const byId = nodes.find((n) => hasId(n, 'skip_ad_button') || hasId(n, 'ad_skip_button') || hasId(n, 'skip_button'))
  if (byId) return byId
  return nodes.find((n) => /^(lewati iklan|lewati|skip ad|skip ads|skip)\b/.test(label(n))) ?? null
}

/**
 * Is a video actually playing?
 *
 * Structural, and never "the screen changed": a tap that opened the wrong thing
 * also changes the screen. The player carries transport controls and a
 * timeline, and none of those exist on a channel page.
 */
export function playerEvidence(tree: UiNode): { playing: boolean; via: string } {
  const nodes = flatten(tree).filter((n) => isVisible(n) && (n.packageName === '' || n.packageName === YOUTUBE_PACKAGE))

  const byId = nodes.find((n) => hasId(n, 'player_view') || hasId(n, 'watch_player') || hasId(n, 'player_control_play_pause_replay_button') || hasId(n, 'time_bar_current_time') || hasId(n, 'reel_watch_player') || hasId(n, 'reel_recycler'))
  if (byId) return { playing: true, via: `id:${byId.resourceId.split('/').pop() ?? ''}` }

  // The transport control, in both languages this farm might be in. A player
  // shows exactly one of pause/play at a time.
  const transport = nodes.find((n) => /^(jeda|pause|putar|play|mainkan)\b/.test(label(n)))
  if (transport) return { playing: true, via: `transport:${label(transport).slice(0, 24)}` }

  // A timestamp pair like "0:12 / 11:10" only ever appears on a player.
  const clock = nodes.find((n) => /\d+:\d{2}\s*\/\s*\d+:\d{2}/.test(rawLabel(n)))
  if (clock) return { playing: true, via: 'timeline' }

  // "0 menit 29 detik dari 0 menit 35 detik" — the SAME time bar, spelled out.
  // Measured 2026-09-03 (job 04047e08, artifact 04-player): a search result
  // that was a SHORT played perfectly while this function claimed no player,
  // because the reel's ids and its worded clock were both missing from every
  // rung above.
  const spelled = nodes.find((n) => /\d+\s*(menit|detik|jam|minute|second)[^\n]*\bdari\b/i.test(rawLabel(n)))
  if (spelled) return { playing: true, via: 'timeline(spelled)' }

  return { playing: false, via: 'none' }
}

/**
 * The rows on a channel's Video tab.
 *
 * A video row is identified by its DURATION, which every one of them carries in
 * its description ("11 menit, 10 detik") and nothing else on the page does —
 * not the tab strip, not the header, not the navigation. Falling back to the
 * thumbnail id covers a layout that words durations differently.
 */
export function videoRowsOf(tree: UiNode): UiNode[] {
  const byDuration = flatten(tree).filter((n) => {
    // `isTappable`, not `inContentBand`: a row is only a candidate if the point
    // this script would actually press is on the row itself.
    if (!isVisible(n) || isChrome(n) || !isTappable(n, tree)) return false
    const value = label(n)
    return /\b\d+\s*(menit|detik|jam|minute|minutes|second|seconds|hour|hours)\b/.test(value) || /\b\d+:\d{2}\b/.test(value)
  })
  if (byDuration.length > 0) return byDuration
  return flatten(tree).filter((n) => isVisible(n) && hasId(n, 'thumbnail_layout') && isTappable(n, tree))
}

/**
 * The video's title, read off the ROW that was tapped — not off the player.
 *
 * The row's description is one line carrying everything, measured on hardware:
 *
 * ```
 * Situasi GTA VI Yang Semakin Bocor - 11 menit, 45 detik - Buka channel - Eno Bening - 50 ribu x ditonton
 * ```
 *
 * The title is the first segment. Reading it here rather than from the player
 * is not a shortcut — scraping the player was tried and returned the video's
 * **closed-caption text** (`subtitle_window_identifier`), because a playing
 * video's captions are the first real text under the surface and the title node
 * is not always drawn at all. The row is what was chosen; the row is what gets
 * reported.
 *
 * Empty when the row carries nothing parseable, never a guess.
 */
export function titleFromRow(node: UiNode): string {
  const raw = (node.desc || node.text).trim()
  if (raw === '') return ''
  const first = raw.split(' - ')[0]?.trim() ?? ''
  // Strip a leading emoji or symbol run — a live badge renders as one and is
  // not part of the name.
  return first.replace(/^[^\p{L}\p{N}]+/u, '').trim()
}

const searchChannelScript: PluginMemberScript<typeof paramsSchema, typeof resultSchema> = {
  id: 'search-channel',
  node: { category: 'device', icon: 'search', summary: ['query', 'holdMs'], keywords: ['search', 'channel'] },
  title: 'Search channel',
  description: 'Searches YouTube for a channel by name, opens its channel page, holds for a moment, then closes the app. Opens a page — it never subscribes, likes, or comments.',
  params: paramsSchema,
  result: resultSchema,
  timeout: 4 * 60_000,

  async prepare(ctx) {
    // A cold start every time, so a run never inherits whatever screen the last
    // one left behind — the most common source of a "worked yesterday" failure.
    await ctx.device.app.forceStop(YOUTUBE_PACKAGE, { clearRecents: true })
    await ctx.device.app.launch(YOUTUBE_PACKAGE)
    await sleep(LAUNCH_SETTLE_MS)
  },

  async run(ctx) {
    const anchors: Record<string, string> = {}
    const steps: string[] = []
    const fail = (step: string, message: string): never => {
      steps.push(`${step}: FAILED`)
      throw new Error(`${message} (steps: ${steps.join(' → ')})`)
    }

    // --- 1. home -----------------------------------------------------------
    const home = await capture(ctx, '01-home')
    steps.push('home')

    const search = firstMatch(home, SEARCH_ENTRY)
    if (!search) fail('open-search', 'could not find the search button on the YouTube home screen — see artifact 01-home')
    anchors.searchEntry = search!.via
    await tapNode(ctx, search!.node)
    await sleep(UI_SETTLE_MS)

    // --- 2. type the query -------------------------------------------------
    const searchScreen = await capture(ctx, '02-search-open')
    steps.push('search-open')

    const field = firstMatch(searchScreen, SEARCH_FIELD)
    if (!field) fail('type-query', 'the search screen opened but no text field was found — see artifact 02-search-open')
    anchors.searchField = field!.via
    // Focus explicitly. YouTube usually focuses the field on open, but
    // "usually" is what makes a run flaky at 3am.
    await tapNode(ctx, field!.node)
    await sleep(500)
    await ctx.device.type(ctx.params.query)
    await sleep(UI_SETTLE_MS)
    await capture(ctx, '03-typed')
    steps.push('typed')

    // --- 3. submit and wait for ROWS ---------------------------------------
    await ctx.device.key('ENTER')
    const waited = await waitForTree(ctx, hasResultRows, { budgetMs: RESULTS_BUDGET_MS })
    anchors.resultsWaitMs = `${waited.waitedMs}`
    const results = await capture(ctx, '04-results', waited.tree)
    steps.push(waited.ok ? 'results' : 'results(timeout)')
    if (!waited.ok) fail('results', `the search was submitted but no result rows appeared within ${RESULTS_BUDGET_MS} ms — see artifact 04-results`)

    const rows = resultRowsOf(results)
    anchors.resultRows = `${rows.length}`

    // --- 4. open the channel ----------------------------------------------
    const target = pickChannelRow(results, ctx.params.query)
    if (!target) fail('open-channel', `no channel row matching "${ctx.params.query}" was found in the results — see artifact 04-results`)
    anchors.channelRow = target!.via
    await tapNode(ctx, target!.node)

    const opened = await waitForTree(ctx, (t) => channelPageEvidence(t).onChannel, { budgetMs: CHANNEL_BUDGET_MS })
    anchors.channelWaitMs = `${opened.waitedMs}`

    const channel = await capture(ctx, '05-channel', opened.tree)
    steps.push('channel')

    const evidence = channelPageEvidence(channel)
    anchors.channelPage = evidence.via
    if (!evidence.onChannel) {
      fail('verify-channel', 'the tap opened something, but it does not look like a channel page (no handle, no subscribe control, no channel tabs) — see artifact 05-channel')
    }

    const channelTitle = readChannelTitle(channel)
    steps.push('verified')

    await sleep(ctx.params.holdMs)

    // --- 5. optionally watch a video ---------------------------------------
    let watched = false
    let videoTitle = ''
    let watchEvidence = 'not requested'

    if (ctx.params.watch !== 'none') {
      const watch = await watchFromChannel(ctx, channel, anchors, steps)
      watched = watch.watched
      videoTitle = watch.videoTitle
      watchEvidence = watch.evidence
    }

    // --- 6. close ----------------------------------------------------------
    await ctx.device.app.forceStop(YOUTUBE_PACKAGE, { clearRecents: true })
    steps.push('closed')

    return { query: ctx.params.query, channelOpened: true, channelTitle, channelEvidence: evidence.via, resultCount: rows.length, watched, videoTitle, watchEvidence, anchors, steps }
  },
}

export default searchChannelScript

/**
 * Channel page → Video tab → one video → playing.
 *
 * Split out of `run` because it is a second walk with its own failure modes,
 * and because `watch: 'none'` must not pay for any of it. Throws on a real
 * failure, exactly like the search half — a run that meant to watch something
 * and did not must say so rather than return `watched: false` beside a green
 * job.
 */
async function watchFromChannel(
  ctx: Parameters<NonNullable<(typeof searchChannelScript)['run']>>[0],
  channel: UiNode,
  anchors: Record<string, string>,
  steps: string[],
): Promise<{ watched: boolean; videoTitle: string; evidence: string }> {
  const fail = (step: string, message: string): never => {
    steps.push(`${step}: FAILED`)
    throw new Error(`${message} (steps: ${steps.join(' → ')})`)
  }

  const tab = firstMatch(channel, VIDEO_TAB)
  if (!tab) fail('video-tab', 'the channel opened but it has no Video tab — see artifact 05-channel')
  anchors.videoTab = tab!.via
  await tapNode(ctx, tab!.node)

  const listed = await waitForTree(ctx, (t) => videoRowsOf(t).length > 0, { budgetMs: VIDEO_LIST_BUDGET_MS })
  anchors.videoListWaitMs = `${listed.waitedMs}`
  const list = await capture(ctx, '06-videos', listed.tree)
  steps.push(listed.ok ? 'videos' : 'videos(timeout)')
  if (!listed.ok) fail('videos', `the Video tab opened but no video rows appeared within ${VIDEO_LIST_BUDGET_MS} ms — see artifact 06-videos`)

  const rows = videoRowsOf(list)
  anchors.videoRows = `${rows.length}`

  /*
   * `latest` is row 0 because a channel's Video tab is newest-first by default.
   * That is the app's own ordering, not a claim this script can verify from a
   * dump — stated here rather than asserted in the result, which reports what
   * was opened and lets the operator judge.
   */
  const index = ctx.params.watch === 'random' ? Math.floor(Math.random() * rows.length) : 0
  const chosen = rows[index]
  if (!chosen) fail('pick-video', 'the video list rendered but a row could not be chosen from it — see artifact 06-videos')
  anchors.videoPick = `${ctx.params.watch}:${index + 1}/${rows.length}`
  // Read BEFORE the tap: the row is on screen now and will not be a moment from
  // now, and this is the only place the video's name is legibly available.
  const videoTitle = titleFromRow(chosen!)
  await tapNode(ctx, chosen!.clickable ? chosen! : clickableFor(list, chosen!))

  const playing = await waitForTree(ctx, (t) => playerEvidence(t).playing, { budgetMs: PLAYER_BUDGET_MS })
  anchors.playerWaitMs = `${playing.waitedMs}`
  const player = await capture(ctx, '07-player', playing.tree)
  steps.push('player')

  const evidence = playerEvidence(player)
  anchors.player = evidence.via
  if (!evidence.playing) {
    fail('verify-player', 'a row was tapped but nothing that looks like a player appeared (no transport control, no timeline) — see artifact 07-player')
  }

  /*
   * Wait the advert out before the watch clock starts.
   *
   * Without this, `watchMs` measures a sponsored spot rather than the video an
   * operator asked for — measured on the first watch run, where the whole ten
   * seconds went to a six-second advert. Nothing here interacts with the
   * advert: it is not tapped, not skipped, and its controls are not touched.
   * The script waits, which is what a phone does when nobody is holding it.
   */
  const advert = adEvidence(player)
  if (advert.ad) {
    anchors.adSeen = advert.via
    const cleared = await waitOutAdvert(ctx, anchors)
    await capture(ctx, '08-video')
    steps.push(cleared ? 'ad-cleared' : 'ad(timeout)')
    if (!cleared) {
      // Not a failure: an unskippable advert that outlasts the budget is a real
      // thing that happens, and the run still watched what it could. Reported,
      // not hidden.
      ctx.log.warn('youtube: the advert had not finished within the budget — the watch clock started anyway', { budgetMs: AD_BUDGET_MS })
    }
  }

  steps.push('watching')

  // Left playing, deliberately: this is the whole point of the parameter, and
  // the close in `run` is what ends it.
  await sleep(ctx.params.watchMs)
  steps.push('watched')

  return { watched: true, videoTitle, evidence: advert.ad ? `${evidence.via} (after advert ${advert.via})` : evidence.via }
}


/**
 * Wait for the advert to end, pressing "Skip ad" the moment it becomes
 * available.
 *
 * A loop rather than `waitForTree`, because this one has to ACT on what it
 * sees: the skip control is not there when the advert starts (YouTube holds it
 * back for a few seconds) and appears mid-wait. Measured before this existed,
 * two real runs sat through 50 s and 34 s of advert with a skip button on
 * screen for most of it.
 *
 * What it presses is YouTube's own dismiss control and nothing else. It does
 * not touch the advert, its call to action, or its links, and when the operator
 * turns `skipAds` off it presses nothing at all and simply waits.
 */
async function waitOutAdvert(ctx: Parameters<NonNullable<(typeof searchChannelScript)['run']>>[0], anchors: Record<string, string>): Promise<boolean> {
  const started = Date.now()
  let skipped = 0
  while (Date.now() - started < AD_BUDGET_MS) {
    const tree = await ctx.device.dump()
    if (!adEvidence(tree).ad) {
      anchors.adWaitMs = `${Date.now() - started}`
      if (skipped > 0) anchors.adSkipped = `${skipped}`
      return true
    }
    if (ctx.params.skipAds) {
      const skip = skipControlOf(tree)
      if (skip) {
        await tapNode(ctx, skip)
        skipped += 1
        // A short settle rather than a full poll interval: the player cuts to
        // the video immediately, and the next dump should see it.
        await sleep(700)
        continue
      }
    }
    await sleep(1_000)
  }
  anchors.adWaitMs = `${Date.now() - started}`
  if (skipped > 0) anchors.adSkipped = `${skipped}`
  return false
}
