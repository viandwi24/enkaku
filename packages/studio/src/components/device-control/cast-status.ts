import type { CastStats } from './use-cast'

/**
 * What a cast is doing, in one word an operator can act on (plan 600 §3.3).
 *
 * Before this, three call sites each collapsed every non-streaming state
 * into the single word "Disconnected" — `LiveView.tsx`'s tile overlay,
 * `Cast.tsx`'s window overlay, and `Cast.tsx`'s own status chip (which at
 * least said "No frames for Ns"). That word is a claim about the DEVICE,
 * and none of those states are about the device:
 *
 *  - a session being built says nothing about the phone except that it is
 *    there,
 *  - a session the farm is rebuilding is a phone under control ten seconds
 *    ago and again ten seconds from now,
 *  - a stalled H.264 stream is a phone streaming perfectly into a congested
 *    socket.
 *
 * The owner read the tile's version of it as a casting failure on a phone
 * that was online and being controlled at the time (field report,
 * 2026-09-06) — the same misreading `DeviceScreenCard`'s `idleLabelOf`
 * already fixed for the tile-budget case two days earlier, in a file this
 * one could not see.
 *
 * This is the only place in Studio that turns `CastStats` into words.
 */
export type CastStatusKind = 'live' | 'connecting' | 'preparing' | 'reconnecting' | 'stalled' | 'offline' | 'unauthorized' | 'error'

export interface CastStatus {
  kind: CastStatusKind
  /** The label to render. Short enough for a 9:19.5 tile at wall size. */
  label: string
  /** The farm is working on it — render a spinner, not a dead-tile treatment. */
  busy: boolean
  /** The server's own sentence, when it sent one. For a tooltip, never for the label. */
  detail: string | null
}

/**
 * Seconds without a frame before a stream stops counting as live.
 *
 * scrcpy repeats the previous frame about ten times a second even on a
 * completely static screen, so silence this long is a real stall, not an
 * idle phone.
 */
export const LIVE_STALE_SEC = 5

export function isCastLive(stats: Pick<CastStats, 'streaming' | 'staleSec'>): boolean {
  return stats.streaming && stats.staleSec < LIVE_STALE_SEC
}

export function castStatusOf(stats: CastStats): CastStatus {
  const detail = stats.notice ?? stats.error ?? null
  if (stats.error && stats.error.toLowerCase().includes('unauthor')) {
    return { kind: 'unauthorized', label: 'Unauthorized', busy: false, detail: stats.error }
  }
  if (stats.error) return { kind: 'error', label: 'Video error', busy: false, detail: stats.error }
  if (!stats.streaming) {
    // The one surviving "Disconnected": the server itself said the device is
    // offline. Everything else that used to wear this word was a claim
    // about the farm's own plumbing, not about the phone.
    if (stats.noticeKind === 'offline') return { kind: 'offline', label: 'Disconnected', busy: false, detail: stats.notice }
    // `notice` is set only by the two retrying codes (`E_SESSION_PREPARING`,
    // `device_offline`), so its presence IS the "the farm is on it" signal.
    if (stats.notice) return { kind: 'preparing', label: 'Preparing', busy: true, detail: stats.notice }
    // `stopped` carries `stream.ended`'s reason and the cast is already
    // climbing `RESTART_BACKOFF_MS` to get the picture back.
    if (stats.stopped) return { kind: 'reconnecting', label: 'Reconnecting', busy: true, detail: stats.stopped }
    return { kind: 'connecting', label: 'Connecting', busy: true, detail }
  }
  if (stats.staleSec >= LIVE_STALE_SEC) {
    return { kind: 'stalled', label: `No frames · ${stats.staleSec}s`, busy: false, detail }
  }
  return { kind: 'live', label: 'Streaming', busy: false, detail }
}
