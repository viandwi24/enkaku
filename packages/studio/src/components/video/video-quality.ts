import type { ControlQuality, VideoReprofileResponse, WallQuality } from '@enkaku/protocol'

/**
 * Plan 92 §3.6, §3.7, §3.9, §4.2 — step 92.8 (the Studio surfaces for
 * quality); reduced to a preset-only model by plan 212 §4.5. This module is
 * a DELIBERATE, DOCUMENTED duplicate of `packages/session/src/
 * video-profile.ts`'s `CONTROL_PRESETS`/`WALL_PRESETS`/`resolveVideoProfile`/
 * `computeAutoTiles`, not an import of it — Studio is a STATIC EXPORT and
 * cannot pull in `@enkaku/session`'s barrel (real Node dependencies).
 */

export interface VideoNumbers {
  maxSize: number
  maxFps: number
  bitRate: number
}

/**
 * Where one resolved number came from — mirrors `packages/session/src/
 * video-profile.ts`'s `VideoSource`. Plan 212 §4.5: there is no more numeric
 * override to produce a "customized" source, only a named preset or a
 * per-device override.
 */
export type VideoSource = 'preset' | 'device'

export interface VideoProfile extends VideoNumbers {
  source: { maxSize: VideoSource; maxFps: VideoSource; bitRate: VideoSource }
}

/** Preset tables. `control.sharp` and `wall.balanced` are the pre-plan-92 `QUALITY_PROFILES` constants, unchanged. */
export const CONTROL_PRESETS: Record<ControlQuality, VideoNumbers> = {
  sharp: { maxSize: 1600, maxFps: 30, bitRate: 4_000_000 },
  balanced: { maxSize: 1080, maxFps: 30, bitRate: 2_500_000 },
  light: { maxSize: 720, maxFps: 20, bitRate: 1_200_000 },
}
/** Plan 100 §3.4, revised again by step 100.8 — mirrors `packages/session/src/video-profile.ts`'s table exactly. */
export const WALL_PRESETS: Record<WallQuality, VideoNumbers> = {
  minimal: { maxSize: 240, maxFps: 10, bitRate: 350_000 },
  light: { maxSize: 320, maxFps: 14, bitRate: 650_000 },
  balanced: { maxSize: 480, maxFps: 18, bitRate: 1_100_000 },
  detailed: { maxSize: 640, maxFps: 22, bitRate: 1_500_000 },
}

/**
 * `wall.maxTiles: 0` (auto) — the min of a decode bound and a bandwidth
 * bound (plan 100 §3.1, §4.1). Mirrors `packages/session/src/video-profile.ts`'s
 * `computeAutoTiles` exactly (clamped to [4, 32]). `budget` is read live off
 * `GET /api/adb/stats` (plan 212 §4.1 turned the decode ceiling and both
 * bandwidth numbers into support constants with no settings field to read),
 * so this function no longer carries its own hard-coded fallback default —
 * a caller passes the numbers the server reports.
 */
export function computeAutoTiles(wallBitRate: number, budget: { decodeTileCeiling: number; bandwidthBps: number }): number {
  const decodeBound = budget.decodeTileCeiling
  const bandwidthBound = Math.floor(budget.bandwidthBps / wallBitRate)
  return Math.min(32, Math.max(4, Math.min(decodeBound, bandwidthBound)))
}

/** Mirrors `packages/session/src/video-profile.ts`'s type of the same name (plan 100 §3.1, §4.1, step 100.3). */
export type WallTransport = 'loopback' | 'lan' | 'wan'

/**
 * Mirrors `packages/session/src/video-profile.ts`'s `resolveWallBandwidthBps`
 * exactly (plan 100 §3.1, §3.6, §4.1; plan 212 §212.5 turns both numbers into
 * caller-supplied values — there is no more `wall.bandwidthBps` farm setting
 * to read, only the WAN advanced field and the LAN support constant).
 */
export function resolveWallBandwidthBps(transport: WallTransport, wanBandwidthBps: number, lanBandwidthBps: number): number {
  return transport === 'wan' ? wanBandwidthBps : lanBandwidthBps
}

/**
 * Decide one number's `VideoSource` (plan 212 §4.5) — a device override
 * always wins and reports `'device'`; otherwise it is the named preset.
 */
const sourceFor = (fromDevice: boolean): VideoSource => (fromDevice ? 'device' : 'preset')

/**
 * The Studio-side reimplementation of `resolveVideoProfile({ controlQuality, wallQuality }, device, 'control')`.
 * Pure — no clock, no I/O — so the readout can call it on every keystroke of
 * an unsaved draft with no debounce needed. `device` is `null`/`undefined`
 * on the farm Settings page (there is no single device in view there); the
 * device page always passes its own `overrides`.
 */
export function resolveControlProfile(farm: { controlQuality: ControlQuality }, device?: { controlQuality?: ControlQuality } | null): VideoProfile {
  const name = device?.controlQuality ?? farm.controlQuality
  const numbers = CONTROL_PRESETS[name]
  const s = sourceFor(device?.controlQuality !== undefined)
  return { ...numbers, source: { maxSize: s, maxFps: s, bitRate: s } }
}

/** The Studio-side reimplementation of `resolveVideoProfile({ controlQuality, wallQuality }, device, 'wall')`. See `resolveControlProfile` above. */
export function resolveWallProfile(farm: { wallQuality: WallQuality }, device?: { wallQuality?: WallQuality } | null): VideoProfile {
  const name = device?.wallQuality ?? farm.wallQuality
  const numbers = WALL_PRESETS[name]
  const s = sourceFor(device?.wallQuality !== undefined)
  return { ...numbers, source: { maxSize: s, maxFps: s, bitRate: s } }
}

/** True when two profiles would produce a different encoder. Mirrors `sameVideoNumbers`. */
export function sameVideoNumbers(a: VideoNumbers, b: VideoNumbers): boolean {
  return a.maxSize === b.maxSize && a.maxFps === b.maxFps && a.bitRate === b.bitRate
}

/** `4 Mbit/s`, `2.5 Mbit/s`, `800 kbit/s` — matches the wording the schema's own `.describe()` text already uses. */
export function formatBitRatePreset(bps: number): string {
  if (bps >= 1_000_000) {
    const mb = bps / 1_000_000
    return `${mb % 1 === 0 ? mb.toFixed(0) : mb.toFixed(1)} Mbit/s`
  }
  return `${Math.round(bps / 1000)} kbit/s`
}

/** `20.0 Mbit/s` — always one decimal, for the projection/measured aggregate lines, where a trailing `.0` is the point. `bitsPerSec` — already bits, not bytes. */
export function formatMbps(bitsPerSec: number): string {
  return `${(bitsPerSec / 1_000_000).toFixed(1)} Mbit/s`
}

/** One line of the effective-profile readout (plan 92 §3.9, §5 step 92.8's own "where each number came from"). */
export interface ReadoutRow {
  label: string
  value: string
  sourceLabel: string
}

/**
 * A resolved `VideoProfile` turned into the three rows the readout renders
 * — the NUMBERS always come from `resolveControlProfile`/`resolveWallProfile`;
 * this function never recomputes a source, only renders the one the resolver
 * already reported.
 */
export function profileRows(profile: VideoProfile, labelFor: (s: VideoSource) => string): ReadoutRow[] {
  return [
    { label: 'Size', value: `${profile.maxSize} px`, sourceLabel: labelFor(profile.source.maxSize) },
    { label: 'Frame rate', value: `${profile.maxFps} fps`, sourceLabel: labelFor(profile.source.maxFps) },
    { label: 'Bitrate', value: formatBitRatePreset(profile.bitRate), sourceLabel: labelFor(profile.source.bitRate) },
  ]
}

/**
 * The `POST /api/video/reprofile` summary, turned into a toast (§3.8, §5
 * step 92.8's own second warning: "the summary toast must name the skipped
 * devices"). `labels` resolves `skippedBusy`'s bare device ids — the caller
 * fetches them via `fetchDeviceRefs` (`@/lib/api.ts`).
 */
export function buildReprofileToast(r: VideoReprofileResponse, labels: Record<string, string>): { message: string; description?: string } {
  const total = r.restarted.length
  if (total === 0 && r.skippedBusy.length === 0) {
    return {
      message: 'Already up to date',
      description: `${r.unchanged} live session${r.unchanged === 1 ? '' : 's'} already matched the new settings.`,
    }
  }
  const message = total === 0 ? 'No live sessions needed restarting' : `New video settings applied to ${total} device${total === 1 ? '' : 's'}`
  if (r.skippedBusy.length === 0) return { message }
  const names = r.skippedBusy.map((id) => labels[id] ?? id)
  const shown = names.slice(0, 5).join(', ')
  const extra = names.length > 5 ? ` +${names.length - 5} more` : ''
  return {
    message,
    description: `${r.skippedBusy.length} kept their picture until their job finishes: ${shown}${extra}`,
  }
}
