import { between, makeRng, pick, pickDwellMs, planRevisitStep, type DwellBucket, type RevisitMove, type RevisitPlan, type RevisitStep, type ScriptContext } from '@enkaku/sdk'
import type { UiNode } from '@enkaku/protocol'
import { flatten } from './tree'
import { centre, hasId, isVisible, tapNode, YOUTUBE_PACKAGE } from './youtube'

/**
 * Human-shaped behaviour shared by every member in this pack: the RNG, the
 * randomised gestures, and the like/comment anchors MEASURED ON HARDWARE
 * (moto g06 power, 720×1640, Indonesian locale, signed out, 2026-09-03).
 *
 * ## The measurement notes that shaped this file
 *
 * - The Shorts action rail is x∈[608,720] (like [608,900][720,1005], comment
 *   [608,1005][720,1110]) and every one of those nodes is CLICKABLE — a swipe
 *   that starts in the rail presses a button instead of scrolling. Corridors
 *   here stay left of x=0.82·width.
 * - The bottom nav sits at y∈[1433,1556] and is also clickable content. A
 *   swipe ending there opens Subscription/Anda; a fling started below 0.80·h
 *   can too. Start band is 0.55–0.78·h, end never below 0.10·h.
 * - Like button spellings (Indonesian, all measured 2026-09-03 on a SIGNED-OUT
 *   device): "Sukai video ini" is the plain button, "suka video ini bersama
 *   29 ribu orang lainnya" is the button WITH ITS TOTAL COUNT — still
 *   NOT liked: every like tap on that device answered with the account sheet
 *   (`:id/title` "Akun" + `:id/add_account` "Tambahkan akun"). Reading the
 *   count line as a liked state made a whole job claim `already-liked` on a
 *   device that cannot like; `likeState` below keeps them apart. The account
 *   sheet is not a like either: `pressLike` reports 'not-signed-in' and backs
 *   out instead of logging a success that never happened.
 * - The Shorts comment sheet: header `modern_title` "Komentar", close is
 *   `close_button` "Tutup" (both ids survived the dump), comment rows carry
 *   "Sukai komentar ini …" — which is why the like ladder below anchors on
 *   "video ini" and never on a bare "suka".
 */

/*
  The rng, `between` and `pick` come from the SDK now (0.39.10), re-exported so no call site in this
  pack changes. The old comment here said "same model as tiktok-automation-pack/human.ts" — that was
  the problem, not a reassurance: three packs kept three copies of one generator and each fix reached
  only one of them. The SDK's sequence was checked against this one across 8 seeds x 2000 draws and
  is identical, so a seeded run replays exactly as before. (This copy wrote an extra `s >>>= 0` after
  the first shift; it changes how JS reads the sign, never the 32 bits, so the streams agree.)

  One deliberate difference: the SDK's `pick` THROWS on an empty list where this one returned
  `undefined` cast as T — a cast that turned an empty ladder into a crash further away from its cause.
*/
export { between, makeRng, pick }

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/*
  Watch-time buckets: heavy-tailed and lumpy, never one uniform range (the model plan 40's `natural`
  profile implies). The TABLE is YouTube's and stays here — a Short is not a TikTok clip and not a
  reel, and these four ranges were read off this app. Only the weighted draw around it moved to the
  SDK, which takes the table as an argument for exactly that reason.
*/
const WATCH_BUCKETS: readonly DwellBucket[] = [
  { label: 'skip', weight: 0.15, ms: [1_500, 3_500] },
  { label: 'watch', weight: 0.5, ms: [4_000, 10_000] },
  { label: 'engaged', weight: 0.25, ms: [10_000, 25_000] },
  { label: 'hooked', weight: 0.1, ms: [25_000, 55_000] },
]

export function pickWatchMs(rng: () => number): { ms: number; label: string } {
  return pickDwellMs(rng, 0, WATCH_BUCKETS)
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/** Frame size from the PNG IHDR (see tiktok-automation-pack/human.ts — `DeviceApi` exposes no accessor). */
export function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 24) return null
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (dv.getUint32(0) !== 0x89504e47) return null
  const width = dv.getUint32(16)
  const height = dv.getUint32(20)
  return width > 0 && height > 0 ? { width, height } : null
}

export interface Frame {
  width: number
  height: number
}

export async function frameOf(ctx: ScriptContext<unknown>): Promise<Frame> {
  const size = pngSize(await ctx.device.screenshot())
  if (!size) throw new Error('could not read the frame size from a PNG screenshot')
  return size
}

/**
 * One randomised UP-swipe that actually turns a paged feed (Shorts).
 *
 * Nothing is fixed: corridor x, start y, distance, duration, horizontal drift
 * and curvature all come from the RNG, so no two swipes are the same gesture.
 * Displacement crosses 55–78% of the page and release is at full speed
 * (`linear`) because a ViewPager snaps back below that — the same measured
 * constraint the tiktok pack records for its own feed.
 *
 * It verifies the page turned: two screenshots, byte-compared. No change means
 * the feed bounced, and the caller retries — a bot that scrolls is only a bot
 * if the scroll happened.
 */
export async function swipeUpRandomised(ctx: ScriptContext<unknown>, frame: Frame, rng: () => number, opts?: { strength?: number }): Promise<void> {
  const boost = opts?.strength ?? 1
  const x = Math.round(between(rng, 0.16, 0.58) * frame.width)
  const startY = Math.round(between(rng, 0.62, 0.78) * frame.height)
  const distance = Math.round(Math.min(0.82, between(rng, 0.55, 0.78) * boost) * frame.height)
  const endY = Math.max(Math.round(0.08 * frame.height), startY - distance)
  const ms = Math.round(between(rng, 130, 260) / boost)
  await ctx.device.swipe({ x, y: startY }, { x: Math.round(x + between(rng, -14, 14)), y: endY }, ms, {
    easing: 'linear',
    curvature: Number(between(rng, 0, 0.08).toFixed(3)),
  })
}

/** One DOWN-swipe (scroll a list back / read down) with the same full randomisation. */
export async function swipeDownRandomised(ctx: ScriptContext<unknown>, frame: Frame, rng: () => number): Promise<void> {
  const x = Math.round(between(rng, 0.16, 0.58) * frame.width)
  const startY = Math.round(between(rng, 0.2, 0.35) * frame.height)
  const distance = Math.round(between(rng, 0.35, 0.6) * frame.height)
  const ms = Math.round(between(rng, 160, 320))
  await ctx.device.swipe({ x, y: startY }, { x: Math.round(x + between(rng, -12, 12)), y: Math.min(Math.round(0.9 * frame.height), startY + distance) }, ms, {
    easing: 'linear',
    curvature: Number(between(rng, 0, 0.06).toFixed(3)),
  })
}

/**
 * Advance a paged feed by exactly one item, bouncing harder if the page did
 * not move. Returns false when three attempts left the screen byte-identical
 * — reported, never hidden.
 */
export async function advanceFeedVerified(ctx: ScriptContext<unknown>, frame: Frame, rng: () => number): Promise<boolean> {
  for (const strength of [1, 1.25, 1.5]) {
    const before = await ctx.device.screenshot()
    await swipeUpRandomised(ctx, frame, rng, { strength })
    await sleep(between(rng, 700, 1_400))
    if (!bytesEqual(before, await ctx.device.screenshot())) return true
  }
  return false
}

/** A small randomised scroll inside the comment sheet — reading, never posting. */
export async function scrollCommentsRandomised(ctx: ScriptContext<unknown>, frame: Frame, rng: () => number, times: number): Promise<void> {
  for (let i = 0; i < times; i++) {
    const x = Math.round(between(rng, 0.2, 0.75) * frame.width)
    const startY = Math.round(between(rng, 0.7, 0.85) * frame.height)
    const endY = Math.round(between(rng, 0.45, 0.6) * frame.height)
    await ctx.device.swipe({ x, y: startY }, { x: x + Math.round(between(rng, -10, 10)), y: endY }, Math.round(between(rng, 220, 420)), {
      curvature: Number(between(rng, 0, 0.05).toFixed(3)),
    })
    await sleep(between(rng, 900, 2_200))
  }
}

/** Where a pull starts and ends, as fractions of the frame height (0.35.0). */
export interface PullBand {
  startY: readonly [number, number]
  endY: readonly [number, number]
}

/**
 * The own channel's pull band (0.35.0). The pull must start INSIDE the video list, below the collapsing header and
 * its tabs bar, and end above the bottom bar. Measured on both channel screens this pack has:
 *
 * - `screen-channel.json` (a channel with videos, 720x1640): tabs bar to y=789, list `results` `[0,789][720,1472]`,
 *   bottom bar from y=1472 — the list is 0.48–0.90h.
 * - `screen-channel-uploading.json` (right after Upload, 720x1600): tabs bar to y=530, list `[0,530][720,1420]`,
 *   bottom bar from y=1420 — the list is 0.33–0.89h.
 *
 * Start 0.50–0.56h and end 0.80–0.86h sit inside the list on both, far below the status bar and the notification
 * shade's edge, and a drag of 0.24–0.36h is several times Android's swipe-refresh trigger distance.
 */
export const CHANNEL_PULL_BAND: PullBand = { startY: [0.5, 0.56], endY: [0.8, 0.86] }

/**
 * One pull-to-refresh drag, fully randomised and pure so its geometry is testable. The corridor x 0.28–0.66 keeps
 * clear of both side edges (the system back gesture), and the slow `easeInOutCubic` release is a deliberate drag
 * that holds the list at its top — a fast flick flings instead of refreshing. A drag, never a tap.
 */
export function pullToRefreshPath(
  frame: Frame,
  rng: () => number,
  band: PullBand = CHANNEL_PULL_BAND,
): { from: { x: number; y: number }; to: { x: number; y: number }; ms: number; curvature: number } {
  const x = Math.round(between(rng, 0.28, 0.66) * frame.width)
  const fromY = Math.round(between(rng, band.startY[0], band.startY[1]) * frame.height)
  const toY = Math.round(between(rng, band.endY[0], band.endY[1]) * frame.height)
  return {
    from: { x, y: fromY },
    to: { x: Math.round(x + between(rng, -18, 18)), y: toY },
    ms: Math.round(between(rng, 420, 720)),
    curvature: Number(between(rng, 0, 0.05).toFixed(3)),
  }
}

export async function pullToRefresh(ctx: ScriptContext<unknown>, frame: Frame, rng: () => number, band: PullBand = CHANNEL_PULL_BAND): Promise<void> {
  const p = pullToRefreshPath(frame, rng, band)
  await ctx.device.swipe(p.from, p.to, p.ms, { easing: 'easeInOutCubic', curvature: p.curvature })
}

/**
 * What a post-confirmation round does before it reads the channel again (0.35.0). `refresh` pulls the page on
 * screen down; `home` visits Home first and comes back. The owner asked for this on 2026-09-15: a person waiting
 * for an upload checks back at uneven intervals, and sometimes wanders off and returns, rather than re-reading one
 * page on a fixed period.
 */
export type ConfirmMove = 'refresh' | 'home'

export interface ConfirmStep {
  move: ConfirmMove
  /** How long to wait before this round's move. */
  waitMs: number
  /** How long to stay on Home before coming back (0 for `refresh`). */
  lingerMs: number
  /** Pull to refresh once back on the page. Always true for `refresh`. */
  pull: boolean
}

export interface ConfirmPlan {
  /** The usual wait between rounds; now and then one runs 1.3–1.7x longer. */
  waitMs: readonly [number, number]
  /** The chance a round visits Home first, when the rules below leave the choice open. */
  homeChance: number
  /** The chance a `home` round also pulls to refresh once back on the page. */
  pullAfterHome: number
}

/** A run of pulls this long is broken by a trip Home, so the loop is never pull-only. */
export const MAX_REFRESHES_IN_A_ROW = 3

/**
 * Plan the next round from the moves already made. Two rules keep it from reading as either mechanical or
 * erratic: never two Home trips in a row, and never more than `MAX_REFRESHES_IN_A_ROW` pulls in a row. Pure and
 * seeded, so a run replays exactly.
 */
export function planConfirmStep(rng: () => number, recent: readonly ConfirmMove[], plan: ConfirmPlan): ConfirmStep {
  // The body that used to be here is now the SDK's `planRevisitStep` (0.39.10), and its own test
  // transcribes this exact implementation and asserts the two agree step for step over 120 rounds on
  // four seeds. The waits this pack uses are still this pack's — they arrive in `plan`.
  return planRevisitStep(rng, recent as readonly RevisitMove[], { ...plan, waitMs: [plan.waitMs[0], plan.waitMs[1]] } as RevisitPlan) as ConfirmStep
}

const youtubeNodes = (tree: UiNode): UiNode[] =>
  flatten(tree).filter((n) => isVisible(n) && (n.packageName === '' || n.packageName === YOUTUBE_PACKAGE))

/** Ladders the like/comment walk share: first a resource id, then labels in both languages this farm might be in. */
export interface Rung {
  via: string
  test: (n: UiNode) => boolean
}

const LIKE_RUNGS: readonly Rung[] = [
  { via: 'id:like-button', test: (n) => hasId(n, 'like-button') || hasId(n, 'like_button') || hasId(n, 'like-toggle-button-identify') },
  { via: 'desc:sukai-video', test: (n) => /^(sukai|suka) video ini\b/.test(n.desc.trim()) },
  { via: 'desc:like-video', test: (n) => /^like this video\b/i.test(n.desc.trim()) },
]

const COMMENT_OPEN_RUNGS: readonly Rung[] = [
  { via: 'id:comment-button', test: (n) => hasId(n, 'comment-button') || hasId(n, 'comments_button') },
  { via: 'desc:lihat-komentar', test: (n) => /^lihat [\d.,]+ ribu? komentar|^lihat \d+ komentar/i.test(n.desc.trim()) },
  { via: 'desc:komentar', test: (n) => /^(komentar|comments)\b/i.test(n.desc.trim()) && n.clickable },
  { via: 'desc:show-comments', test: (n) => /^show comments|^tampilkan komentar/i.test(n.desc.trim()) },
]

export const COMMENTS_CLOSE_RUNGS: readonly Rung[] = [
  { via: 'id:close_button', test: (n) => hasId(n, 'close_button') },
  { via: 'desc:tutup', test: (n) => n.desc.trim().toLowerCase() === 'tutup' },
  { via: 'desc:close', test: (n) => n.desc.trim().toLowerCase() === 'close' },
]

function firstIn(tree: UiNode, rungs: readonly Rung[], extra?: (n: UiNode) => boolean): { node: UiNode; via: string } | null {
  const nodes = youtubeNodes(tree).filter((n) => (extra ? extra(n) : n.clickable))
  for (const rung of rungs) {
    const node = nodes.find(rung.test)
    if (node) return { node, via: rung.via }
  }
  return null
}

/** The account sheet YouTube puts up when a signed-out device tries to write: "Akun" + "Tambahkan akun". */
export function signInSheetUp(tree: UiNode): boolean {
  const nodes = youtubeNodes(tree)
  return nodes.some((n) => hasId(n, 'add_account') || hasId(n, 'account_list'))
}

/**
 * Is the like button currently showing the LIKED spelling?
 *
 * Measured the hard way, 2026-09-03: `suka video ini bersama 29 ribu orang
 * lainnya` first read like a state and was not — it is the button's TOTAL
 * like count, present on a signed-out device whose like tap only ever opens
 * the account sheet. Treating it as "already liked" made a whole job report
 * `already-liked` three times and `signedIn: true` on a device that cannot
 * like anything. The liked spellings are the ones that name the VIEWER
 * ("Anda …", "Batalkan …", English "Liked"); the count line is now read as
 * not-liked, which is what it was measured to be.
 */
export function likeState(tree: UiNode): 'liked' | 'not-liked' | 'unknown' {
  for (const n of youtubeNodes(tree)) {
    const d = n.desc.trim()
    if (/^(anda menyukai|batalkan (?:suka|like)|liked this video|suka video ini$)/i.test(d)) return 'liked'
    if (/^(sukai|like) video ini\b/i.test(d)) return 'not-liked'
    if (/^suka video ini bersama/i.test(d)) return 'not-liked'
  }
  return 'unknown'
}

/**
 * Press like, once, honestly.
 *
 * `'liked'` means the tree AFTER the tap says so; `'not-signed-in'` means the
 * account sheet came up and it was dismissed with BACK — the like did NOT
 * register and the run says so. Nothing here ever un-likes.
 */
export async function pressLike(
  ctx: ScriptContext<unknown>,
  rng: () => number,
): Promise<'liked' | 'already-liked' | 'not-signed-in' | 'no-button' | 'not-confirmed'> {
  await sleep(between(rng, 250, 700))
  const tree = await ctx.device.dump()
  if (likeState(tree) === 'liked') return 'already-liked'
  const hit = firstIn(tree, LIKE_RUNGS)
  if (!hit) return 'no-button'
  await tapNode(ctx, hit.node)
  await sleep(between(rng, 800, 1_500))
  const after = await ctx.device.dump()
  if (signInSheetUp(after)) {
    await ctx.device.key('BACK')
    await sleep(600)
    return 'not-signed-in'
  }
  return likeState(after) === 'liked' ? 'liked' : 'not-confirmed'
}

/**
 * Open the comment sheet, read a few comments by scrolling, and close it.
 * Never types, never likes a comment, never opens a reply thread — reading
 * only. The outcome names which rung matched, so the next app update that
 * moves a control shows up as a changed `via` string and not a silent miss.
 */
export async function browseComments(
  ctx: ScriptContext<unknown>,
  rng: () => number,
  opts: { scrollTimes: number },
): Promise<'browsed' | 'no-button' | 'not-signed-in' | 'no-close'> {
  await sleep(between(rng, 250, 700))
  const tree = await ctx.device.dump()
  const hit = firstIn(tree, COMMENT_OPEN_RUNGS)
  if (!hit) return 'no-button'
  await tapNode(ctx, hit.node)
  await sleep(between(rng, 1_800, 3_200))

  const sheet = await ctx.device.dump()
  if (signInSheetUp(sheet)) {
    await ctx.device.key('BACK')
    await sleep(600)
    return 'not-signed-in'
  }

  const frame = await frameOf(ctx)
  await scrollCommentsRandomised(ctx, frame, rng, opts.scrollTimes)

  const open = await ctx.device.dump()
  const closer = firstIn(open, COMMENTS_CLOSE_RUNGS)
  if (closer) {
    await tapNode(ctx, closer.node)
  } else {
    await ctx.device.key('BACK')
  }
  await sleep(between(rng, 700, 1_300))
  return firstIn(await ctx.device.dump(), COMMENTS_CLOSE_RUNGS) ? 'no-close' : 'browsed'
}

/** The clickable row in a context menu carrying one of these labels, e.g. the home overflow's "Download". */
export async function tapMenuItem(ctx: ScriptContext<unknown>, matchers: readonly RegExp[]): Promise<string | null> {
  const tree = await ctx.device.dump()
  const nodes = youtubeNodes(tree).filter((n) => isVisible(n))
  for (const m of matchers) {
    const textNode = nodes.find((n) => m.test(n.text.trim()) || m.test(n.desc.trim()))
    if (!textNode) continue
    await ctx.device.tap({ point: centre(textNode) })
    return textNode.resourceId ? `id:${textNode.resourceId.split('/').pop()}` : `label:${(textNode.text || textNode.desc).trim().slice(0, 40)}`
  }
  return null
}

/** Read a snackbar/toast line out of a tree — the measured "Download tidak tersedia" arrives as a `message` node. */
export function snackbarText(tree: UiNode): string {
  const hit = youtubeNodes(tree).find((n) => hasId(n, 'message') || hasId(n, 'snackbar_text') || hasId(n, 'toast_message'))
  return hit ? (hit.text.trim() || hit.desc.trim()) : ''
}

/**
 * If any keyword appears in `text` (case-insensitive), the effective
 * probability is boosted.  No penalty on non-match — the operator's base
 * chance stays untouched, and only matched content gets the lift.
 */
export function keywordBoost(text: string, keywords: string[], base: number, factor: number): number {
  if (!keywords.length || base <= 0) return base
  const lower = text.toLowerCase()
  const hit = keywords.some((k) => k.trim() !== '' && lower.includes(k.toLowerCase()))
  return hit ? Math.min(1, base * factor) : base
}

/** Every non-empty desc/text in the tree, first-seen order — the words a keyword tilt can match against. */
export function readableStrings(tree: UiNode): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const n of flatten(tree)) {
    for (const raw of [n.desc, n.text]) {
      const v = raw.trim()
      if (v && !seen.has(v)) { seen.add(v); out.push(v) }
    }
  }
  return out
}
