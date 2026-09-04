import type { ScriptContext } from '@enkaku/sdk'
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

/** A small deterministic PRNG so a seeded run replays exactly (same model as tiktok-automation-pack/human.ts). */
export function makeRng(seed: number): () => number {
  let s = seed >>> 0 || 0x2f6e2b1
  return () => {
    s ^= s << 13
    s >>>= 0
    s ^= s >>> 17
    s ^= s << 5
    s >>>= 0
    return s / 0x100000000
  }
}

export function between(rng: () => number, lo: number, hi: number): number {
  return lo + rng() * (hi - lo)
}

export function pick<T>(rng: () => number, items: readonly T[]): T {
  return items[Math.floor(rng() * items.length)] as T
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Watch-time buckets: heavy-tailed and lumpy, never one uniform range (the model plan 40's `natural` profile implies). */
const WATCH_BUCKETS = [
  { weight: 0.15, lo: 1_500, hi: 3_500, label: 'skip' },
  { weight: 0.5, lo: 4_000, hi: 10_000, label: 'watch' },
  { weight: 0.25, lo: 10_000, hi: 25_000, label: 'engaged' },
  { weight: 0.1, lo: 25_000, hi: 55_000, label: 'hooked' },
] as const

export function pickWatchMs(rng: () => number): { ms: number; label: string } {
  const total = WATCH_BUCKETS.reduce((sum, b) => sum + b.weight, 0)
  let r = rng() * total
  for (const b of WATCH_BUCKETS) {
    r -= b.weight
    if (r <= 0) return { ms: Math.round(between(rng, b.lo, b.hi)), label: b.label }
  }
  const last = WATCH_BUCKETS[WATCH_BUCKETS.length - 1] as (typeof WATCH_BUCKETS)[number]
  return { ms: Math.round(between(rng, last.lo, last.hi)), label: last.label }
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
