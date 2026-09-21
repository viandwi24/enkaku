import { z } from 'zod'
import { PlatformIdSchema, type PlatformId } from './platforms'

/**
 * The video recap: what each phone's own account has posted, and how each post
 * is doing.
 *
 * ## The question this answers, and the one it refuses
 *
 * The owner asked for one number per posted video, on all three platforms, for
 * a fleet that will be seventy-three phones (2026-09-21) — and named the hard
 * part himself: *"ga mungkin dong melakukan scroll kebawah dan rekap satu per
 * satu ... dikasih max aja misal 6 ... terus nextnya 6 lagi berarti ada sistem
 * smart merge jadi biar datanya itu tetap sync"*. An account with eighty
 * videos cannot be scrolled to the bottom every day, so a run reads a WINDOW
 * of the newest few, and this module is what makes two windows taken a day
 * apart describe the same videos.
 *
 * What it refuses is to open a video to find out which one it is. Playing a
 * post adds a view to the very number being recapped, and a daily recap of six
 * videos on seventy-three phones would add over a thousand fake views a day.
 *
 * ## Identity, where there is any
 *
 * Only YouTube gives a title alongside the count. TikTok's and Instagram's
 * grids give a number and a position and nothing else — no caption, no id, not
 * even a date (measured on the owner's moto g06 power, 2026-09-21; see each
 * pack's `my-videos`). So the merge has two modes and the READING decides
 * which: titles when the platform gives them, and otherwise an alignment.
 *
 * ## The alignment, and why it works
 *
 * A profile grid is append-at-front: a new post pushes every older one down by
 * one, and nothing reorders. So yesterday's list is today's list with `s` new
 * items in front — one unknown, a small integer — and two facts pin it down:
 *
 * 1. **A view count does not go down.** So a shift that would require a video
 *    to have lost views is not the shift that happened.
 * 2. **Between two runs a video grows a little, not a lot.** So among the
 *    shifts that survive (1), the true one is the one with the least growth —
 *    and the wrong ones are badly wrong, because pairing a video with its
 *    older neighbour means pairing it with a video that has been collecting
 *    views for days longer.
 *
 * ## Where it gives up
 *
 * An account whose whole window reads zero satisfies every shift at zero cost,
 * and nothing in the numbers can tell one from another. When both reads were
 * below the cap the LENGTH settles it — six videos yesterday and seven today
 * is one new video, whatever the counts say — and that is used. When even that
 * is unavailable the merge says `ambiguous` in the row's note rather than
 * picking silently, because a recap that has quietly attached yesterday's
 * history to the wrong video is worse than one that admits it lost the thread.
 */

export const RECAP_PREFIX = 'recap:'

/** Where the fleet-wide recap pacing lives. One row, read by the router every tick. */
export const RECAP_SETTINGS_KEY = 'settings:recap'

/**
 * How many phones read at once, across the WHOLE farm.
 *
 * Eight by default, because the owner watched the first version send a read to
 * every online phone in one tick: *"sya di prod 73 devices itu langsung jalan
 * semua serentak"*. A concurrency cap rather than a delay between batches — a
 * delay has to guess how long a read takes, while a cap paces itself, freeing
 * a slot the moment a phone answers.
 */
export const RECAP_CONCURRENCY_DEFAULT = 8

export const RecapSettingsSchema = z.object({
  version: z.literal(1),
  concurrency: z.number().int().min(1).max(50).default(RECAP_CONCURRENCY_DEFAULT),
})
export type RecapSettings = z.infer<typeof RecapSettingsSchema>

/** One row per phone per platform. The platform is in the key so a scan can read one platform's fleet. */
export function recapRowKey(platform: PlatformId, deviceId: string): string {
  return `${RECAP_PREFIX}${platform}:${deviceId}`
}

/** Every recap row for one platform. */
export function recapPlatformPrefix(platform: PlatformId): string {
  return `${RECAP_PREFIX}${platform}:`
}

/** A key that only this run can have minted, so two phones read in the same second never collide. */
export function newVideoKey(nowSec: number): string {
  return `v-${nowSec}-${Math.random().toString(16).slice(2, 6)}`
}

export const RecapPointSchema = z.object({
  at: z.number().int().nonnegative(),
  views: z.number().int().nonnegative(),
})

export const RecapVideoSchema = z.object({
  /** Minted when the video was first seen. The only durable name a TikTok or Instagram post has here. */
  key: z.string().min(1),
  /** The platform's own title, where it gives one. Empty on TikTok and Instagram. */
  title: z.string().default(''),
  views: z.number().int().nonnegative(),
  /** What the phone actually drew — kept so a misparse can be seen rather than inferred. */
  viewsText: z.string().default(''),
  /** True when the platform rounded the number for display, so it is not exact. */
  approx: z.boolean().default(false),
  /** Position in the last reading, 0 newest. `null` once it has been pushed out of the window. */
  rank: z.number().int().nonnegative().nullable().default(null),
  /**
   * The position it held when it was last IN the window, kept after `rank`
   * goes null.
   *
   * This is what lets a video come back. Widening the window brings videos
   * that had fallen out into the reading again, at the END of it, and without
   * a remembered position there is no way to line them up — they were minted
   * as new videos and the account was reported with the same post twice, its
   * views counted twice (owner's farm, 2026-09-21: a six-video window widened
   * to twelve reported thirteen videos and 277,101 views where the truth was
   * twelve and 275,446).
   */
  lastRank: z.number().int().nonnegative().nullable().default(null),
  firstSeenAt: z.number().int().nonnegative(),
  lastSeenAt: z.number().int().nonnegative(),
  /** Every reading that CHANGED the count, oldest first, capped — this is the growth an operator reads. */
  history: z.array(RecapPointSchema).default([]),
})
export type RecapVideo = z.infer<typeof RecapVideoSchema>

export const RecapRowSchema = z.object({
  version: z.literal(1),
  platform: PlatformIdSchema,
  deviceId: z.string().min(1),
  deviceName: z.string().default(''),
  account: z.string().default(''),
  /** When the phone last answered — successfully or not. */
  readAt: z.number().int().nonnegative(),
  /** When a reading last actually landed. A failed refresh leaves this alone. */
  syncedAt: z.number().int().nonnegative().default(0),
  state: z.enum(['never', 'reading', 'ok', 'failed']).default('never'),
  /** Why the last read failed, or what the last merge could not be sure of. Empty when there is nothing to say. */
  note: z.string().default(''),
  /** The job the current read is waiting on, or empty. */
  jobId: z.string().default(''),
  videos: z.array(RecapVideoSchema).default([]),
  /** True when the phone could not join two scrolls, so its list stops short of what it asked for. */
  truncated: z.boolean().default(false),
  /** How many videos the last reading covered — the window, not the account's total. */
  window: z.number().int().nonnegative().default(0),
  /** How many the next read should ask for. Stored on the row so the router does not need the member's params. */
  asked: z.number().int().min(1).max(30).default(6),
  /**
   * True when the last reading covered the WHOLE account rather than filling
   * its window.
   *
   * The merge's length rule — "seven videos where there were six is one new
   * video" — is only sound when what is stored is everything there is. A
   * window that filled up says nothing about how many videos the account has,
   * so a later reading that is longer may be longer at the BACK, not the
   * front. Recorded here rather than inferred, because it is a fact about the
   * reading that produced the row and nothing later can recover it.
   */
  complete: z.boolean().default(false),
})
export type RecapRow = z.infer<typeof RecapRowSchema>

/** One video as a phone just read it. No key: the merge decides which stored video this is. */
export interface RecapReadingVideo {
  rank: number
  title?: string
  views: number
  viewsText?: string
  approx?: boolean
}

export interface RecapReading {
  account: string
  videos: readonly RecapReadingVideo[]
  truncated: boolean
  /** What the phone was ASKED for. A reading shorter than this covers the whole account. */
  asked: number
  /** Whether what is already stored is the whole account. Defaults to false, which is the safe answer. */
  previousComplete?: boolean
}

/** How many readings of one video to keep. A daily recap keeps two months; an hourly one keeps two days. */
export const MAX_HISTORY = 60

/**
 * How far a count may fall and still be the same video.
 *
 * Not zero. A rounded count (`140,1 rb`) moves in steps of a hundred, and
 * platforms do quietly revise counts down after filtering. Two percent, or two
 * views, whichever is larger — enough to absorb both, far too little to let a
 * video be mistaken for its older neighbour.
 */
export function withinTolerance(stored: number, read: number): boolean {
  return read >= stored - Math.max(2, Math.round(stored * 0.02))
}

export interface MergeOutcome {
  videos: RecapVideo[]
  /** How many of the reading were new videos. */
  added: number
  /** Empty when the merge is sure; otherwise what it could not tell. */
  note: string
  /** True when this reading covered the whole account — stored for the next merge's length rule. */
  complete: boolean
}

/**
 * Fold one reading into what is already known about an account.
 *
 * `previous` is the stored list in whatever order it was left; the reading is
 * newest-first, as every grid draws it.
 */
export function mergeRecap(previous: readonly RecapVideo[], reading: RecapReading, nowSec: number): MergeOutcome {
  const incoming = [...reading.videos].sort((a, b) => a.rank - b.rank)
  if (incoming.length === 0) {
    // Nothing on screen. That is a real answer — an account that has posted
    // nothing — but it is never a reason to forget what was there before, so
    // the stored videos keep their counts and simply leave the window.
    return { videos: previous.map((video) => ({ ...video, rank: null })), added: 0, note: '', complete: reading.asked > 0 }
  }

  const titled = incoming.some((video) => (video.title ?? '').trim() !== '')
  /*
    ONE sequence, not a window and a leftover pile.

    Everything known about this account, in the order the account itself puts
    it: the videos in the window by their position, then the ones that have
    fallen out, by the position they last held. A wider window reads further
    down that same list, so a video that comes back is simply the next entry —
    matched, not minted. Aligning against the window alone is what counted the
    same video twice.
  */
  const sequence = [
    ...previous.filter((video) => video.rank !== null).sort((a, b) => (a.rank as number) - (b.rank as number)),
    ...previous
      .filter((video) => video.rank === null)
      .sort((a, b) => {
        const left = a.lastRank ?? Number.MAX_SAFE_INTEGER
        const right = b.lastRank ?? Number.MAX_SAFE_INTEGER
        return left !== right ? left - right : b.lastSeenAt - a.lastSeenAt
      }),
  ]

  const pairs = titled ? matchByTitle(sequence, incoming) : matchByShift(sequence, incoming, reading)

  const used = new Set<string>()
  const merged: RecapVideo[] = []
  for (let i = 0; i < incoming.length; i++) {
    const read = incoming[i] as RecapReadingVideo
    const match = pairs.pairing[i] ?? null
    const stored = match === null ? null : (sequence[match] as RecapVideo)
    if (stored) used.add(stored.key)
    merged.push(fold(stored, read, nowSec))
  }
  for (const video of sequence) if (!used.has(video.key)) merged.push({ ...video, rank: null })

  return { videos: merged, added: pairs.added, note: pairs.note, complete: incoming.length < reading.asked }
}

/** Update one stored video with what was just read, or mint a new one. */
function fold(stored: RecapVideo | null, read: RecapReadingVideo, nowSec: number): RecapVideo {
  const title = (read.title ?? '').trim()
  if (stored === null) {
    return {
      key: newVideoKey(nowSec),
      title,
      views: read.views,
      viewsText: read.viewsText ?? '',
      approx: read.approx ?? false,
      rank: read.rank,
      lastRank: read.rank,
      firstSeenAt: nowSec,
      lastSeenAt: nowSec,
      history: [{ at: nowSec, views: read.views }],
    }
  }
  const changed = stored.views !== read.views
  const history = changed ? [...stored.history, { at: nowSec, views: read.views }].slice(-MAX_HISTORY) : stored.history
  return {
    ...stored,
    // A platform that stopped giving a title must not erase the one it gave.
    title: title || stored.title,
    views: read.views,
    viewsText: read.viewsText ?? stored.viewsText,
    approx: read.approx ?? stored.approx,
    rank: read.rank,
    lastRank: read.rank,
    lastSeenAt: nowSec,
    history,
  }
}

interface Pairing {
  /** For each incoming video, which stored one it is — an index into `inWindow`, or `null` for a new video. */
  pairing: (number | null)[]
  added: number
  note: string
}

/** YouTube: the title IS the identity, so nothing has to be inferred. */
function matchByTitle(known: readonly RecapVideo[], incoming: readonly RecapReadingVideo[]): Pairing {
  const pairing: (number | null)[] = []
  const taken = new Set<number>()
  let added = 0
  for (const read of incoming) {
    const title = (read.title ?? '').trim()
    const at = title === '' ? -1 : known.findIndex((video, index) => !taken.has(index) && video.title === title)
    if (at === -1) {
      pairing.push(null)
      added += 1
      continue
    }
    taken.add(at)
    pairing.push(at)
  }
  return { pairing, added, note: '' }
}

/**
 * TikTok and Instagram: find how many new videos are in front.
 *
 * See this module's header for why a shift is the right shape of answer and
 * why the least-growth one is the true one.
 */
function matchByShift(known: readonly RecapVideo[], incoming: readonly RecapReadingVideo[], reading: RecapReading): Pairing {
  if (known.length === 0) {
    return { pairing: incoming.map(() => null), added: incoming.length, note: '' }
  }

  /*
    A floor on how many are new, from the LENGTH alone.

    Only when neither reading was capped: a window that filled up says nothing
    about how many videos the account has, but two short readings are two
    complete counts, and seven videos where there were six is one new video
    whatever the numbers do. This is what rescues the case the counts cannot
    settle — a whole window still reading zero.
  */
  /*
    And only when the STORED side was complete too. A window that filled up
    says nothing about how many videos the account has, so a longer reading
    afterwards may be longer at the BACK — five videos this pass finally
    reached, not five new posts — and a floor derived from it would force the
    whole list to shift and rename every video on the account.
  */
  const capped = incoming.length >= reading.asked
  const floor = capped || reading.previousComplete !== true ? 0 : Math.max(0, incoming.length - known.length)

  let best: { shift: number; cost: number } | null = null
  let ties = 0
  const limit = Math.min(incoming.length, known.length + floor)
  for (let shift = floor; shift <= limit; shift++) {
    const deltas: number[] = []
    let valid = true
    for (let i = shift; i < incoming.length; i++) {
      const stored = known[i - shift]
      if (!stored) break
      const read = incoming[i] as RecapReadingVideo
      if (!withinTolerance(stored.views, read.views)) {
        valid = false
        break
      }
      deltas.push(Math.abs(read.views - stored.views) / Math.max(1, stored.views))
    }
    if (!valid || deltas.length === 0) continue
    const cost = median(deltas)
    if (best === null || cost < best.cost - 1e-9) {
      best = { shift, cost }
      ties = 0
    } else if (Math.abs(cost - best.cost) <= 1e-9) {
      ties += 1
    }
  }

  if (best === null) {
    /*
      No shift survives. Something happened that this model does not describe —
      a video deleted from the middle, an account switched under the same
      phone, a misread grid. Every incoming video is treated as new and the
      stored ones keep their last known counts out of the window, so nothing is
      lost and nothing is silently attached to the wrong video.
    */
    return {
      pairing: incoming.map(() => null),
      added: incoming.length,
      note: 'this reading could not be lined up with the last one — no shift of the list keeps every count from going backwards. The previous videos are kept with their last known counts, and these are recorded as new.',
    }
  }

  const pairing: (number | null)[] = []
  for (let i = 0; i < incoming.length; i++) pairing.push(i < best.shift ? null : i - best.shift < known.length ? i - best.shift : null)
  const note =
    ties > 0
      ? `${ties + 1} different readings of this list fit equally well (every count in the window is the same), so which videos are new is a guess. It matters only if one of them is.`
      : ''
  return { pairing, added: pairing.filter((at) => at === null).length, note }
}

/**
 * The middle of the relative growths, NOT their average.
 *
 * One video going viral is enough to break an average. Stored `[10, 20, 30,
 * 40]`, and overnight the newest goes 10 to 100 while the rest gain one view
 * each: the true shift (nothing new) averages a relative growth of 2.28,
 * because that one 9.0 drowns out three values near 0.03, while the shift that
 * claims a new video averages 0.67 and wins — inventing a post that was never
 * made and quietly dropping the oldest one from the account. A median reads
 * the same two shifts as 0.04 and 0.55 and gets it right.
 *
 * That is not a hypothetical: a warm-up farm exists to make some videos take
 * off, so the one-video-in-six that outgrows its neighbours by an order of
 * magnitude is the NORMAL case here, not the edge.
 */
function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = sorted.length >> 1
  if (sorted.length === 0) return 0
  return sorted.length % 2 === 1 ? (sorted[middle] as number) : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2
}
