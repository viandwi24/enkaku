import type { ControlPreset, DeviceSettings, FarmSettings, VideoReprofileResponse, WallPreset } from '@enkaku/protocol'

/**
 * Plan 92 §3.6, §3.7, §3.9, §4.2 — step 92.8 (the Studio surfaces for
 * quality). This module is a DELIBERATE, DOCUMENTED duplicate of
 * `packages/session/src/video-profile.ts`'s `CONTROL_PRESETS`/
 * `WALL_PRESETS`/`resolveVideoProfile`/`computeAutoTiles`, not an import of
 * it — recorded here so the next reader does not "fix" the duplication
 * without reading why first.
 *
 * Why not `import ... from '@enkaku/session'`: that package's own barrel
 * (`packages/session/src/index.ts`) re-exports the job runner, the
 * child-process/container isolation providers, and other backend-only
 * modules with real Node dependencies (`child_process`, container APIs).
 * Studio is a STATIC EXPORT (`output: 'export'`, `00-overview.md` §3) built
 * once and served as plain files — nothing in its dependency graph may
 * assume a Node runtime is present at request time, and `@enkaku/session`
 * has no subpath export that would let this file pull in only
 * `video-profile.ts` without the rest of the barrel. Adding one was
 * considered and rejected for this step: it would touch
 * `packages/session/package.json` and this step's own file-ownership
 * boundary (this brief's own words) is Studio only.
 *
 * The duplication is guarded, not silent: `video-quality.test.ts` re-derives
 * every number in `CONTROL_PRESETS.sharp`/`WALL_PRESETS.balanced` from
 * `FarmSettingsSchema`'s own baked-in JSON Schema defaults (the schema
 * ships those two rows verbatim, `packages/protocol/src/settings.ts`), and
 * every OTHER preset row from that same schema's `.describe()` prose — the
 * only two places these numbers are expressed anywhere Studio can read them
 * live. A future edit to either `packages/session/src/video-profile.ts` or
 * `packages/protocol/src/settings.ts` that is not mirrored here fails that
 * test loudly instead of silently drifting.
 */

export interface VideoNumbers {
  maxSize: number
  maxFps: number
  bitRate: number
}

/** Where one resolved number came from — mirrors `packages/session/src/video-profile.ts`'s `VideoSource`. */
export type VideoSource = 'preset' | 'farm' | 'device'

export interface VideoProfile extends VideoNumbers {
  source: { maxSize: VideoSource; maxFps: VideoSource; bitRate: VideoSource }
}

/**
 * Preset tables. `control.sharp` and `wall.balanced` are the pre-plan-92
 * `QUALITY_PROFILES` constants, unchanged — pinned by `video-quality.test.ts`
 * against `FarmSettingsSchema`'s own defaults, the same pinning
 * `packages/session/src/video-profile.test.ts` does independently against
 * the real preset tables.
 */
export const CONTROL_PRESETS: Record<ControlPreset, VideoNumbers> = {
  sharp: { maxSize: 1600, maxFps: 30, bitRate: 4_000_000 },
  balanced: { maxSize: 1080, maxFps: 30, bitRate: 2_500_000 },
  light: { maxSize: 720, maxFps: 20, bitRate: 1_200_000 },
}
/**
 * Plan 100 §3.4, revised again by step 100.8 — mirrors
 * `packages/session/src/video-profile.ts`'s table exactly (see that file's
 * own comment for the fps/size reasoning, and why these fps numbers are
 * themselves an interim raise pending §7.3/H-1's hardware ladder).
 */
export const WALL_PRESETS: Record<WallPreset, VideoNumbers> = {
  minimal: { maxSize: 240, maxFps: 10, bitRate: 350_000 },
  light: { maxSize: 320, maxFps: 14, bitRate: 650_000 },
  balanced: { maxSize: 480, maxFps: 18, bitRate: 1_100_000 },
  detailed: { maxSize: 640, maxFps: 22, bitRate: 1_500_000 },
}

/**
 * The pre-plan-100 bandwidth-only budget, in bits per second (plan 92 §3.7).
 * Mirrors `packages/session/src/video-profile.ts`'s constant of the same
 * name — still the number the WAN/cloud branch is pinned to (plan 100
 * §3.6), just no longer the only bound on loopback/LAN.
 */
export const WALL_VIDEO_BUDGET_BPS = 20_000_000

/**
 * `wall.maxTiles: 0` (auto) — the min of a decode bound and a bandwidth
 * bound (plan 100 §3.1, §4.1). Mirrors `packages/session/src/video-profile.ts`'s
 * `computeAutoTiles` exactly (clamped to [4, 32]) — this is the SAME
 * formula the projection line (§3.7) and the settings section's own
 * "N live tiles at these settings ≈ X Mbit/s" readout both use, so a number
 * typed into the Advanced reveal and the tile count it implies never
 * disagree with what the server would actually derive.
 *
 * `budget` defaults to the pre-plan-100 bandwidth-only shape (a decode
 * ceiling high enough never to bind, the old 20 Mbit/s bandwidth bound) so
 * every existing caller that has not been updated for plan 100 step 100.3's
 * transport-aware wiring keeps computing exactly what it always has. A
 * caller that HAS the farm's real `wall.decodeTileCeiling` (and, once 100.3
 * lands, its transport-resolved bandwidth bound) should pass it explicitly.
 */
export function computeAutoTiles(wallBitRate: number, budget: { decodeTileCeiling: number; bandwidthBps: number } = { decodeTileCeiling: 32, bandwidthBps: WALL_VIDEO_BUDGET_BPS }): number {
  const decodeBound = budget.decodeTileCeiling
  const bandwidthBound = Math.floor(budget.bandwidthBps / wallBitRate)
  return Math.min(32, Math.max(4, Math.min(decodeBound, bandwidthBound)))
}

/** Mirrors `packages/session/src/video-profile.ts`'s type of the same name (plan 100 §3.1, §4.1, step 100.3). */
export type WallTransport = 'loopback' | 'lan' | 'wan'

/**
 * Mirrors `packages/session/src/video-profile.ts`'s `resolveWallBandwidthBps`
 * exactly (plan 100 §3.1, §3.6, §4.1, step 100.3) — WAN is hard-pinned to
 * `WALL_VIDEO_BUDGET_BPS`, never the farm's own `wall.bandwidthBps` draft
 * value, so the projection never implies a cloud farm's number would change
 * just because an operator typed a bigger `wall.bandwidthBps` while still on
 * WAN.
 */
export function resolveWallBandwidthBps(transport: WallTransport, farmBandwidthBps: number): number {
  return transport === 'wan' ? WALL_VIDEO_BUDGET_BPS : farmBandwidthBps
}

export type FarmVideoSettings = FarmSettings['video']
export type DeviceVideoSettings = DeviceSettings['video']

/**
 * Decide one number's `VideoSource` — mirrors
 * `packages/session/src/video-profile.ts`'s `sourceOf` exactly: a device
 * override always wins and reports `'device'`; otherwise the farm's own
 * stored value is compared against what the currently-selected preset would
 * produce — equal reads as `'preset'`, different reads as `'farm'` (an
 * operator typed a number into the Advanced reveal).
 */
function sourceOf(deviceValue: number | undefined, farmValue: number, presetValue: number): VideoSource {
  if (deviceValue !== undefined) return 'device'
  return farmValue === presetValue ? 'preset' : 'farm'
}

/**
 * The Studio-side reimplementation of `resolveVideoProfile(farm, device, 'control')`.
 * Pure — no clock, no I/O — so the readout can call it on every keystroke of
 * an unsaved draft with no debounce needed. `device` is `null`/`undefined`
 * on the farm Settings page (there is no single device in view there); the
 * device page always passes its own `DeviceSettings.video`.
 */
export function resolveControlProfile(farm: FarmVideoSettings, device?: DeviceVideoSettings | null): VideoProfile {
  const preset = CONTROL_PRESETS[farm.controlPreset]
  const maxSize = device?.controlMaxSize ?? farm.controlMaxSize
  const maxFps = device?.controlMaxFps ?? farm.controlMaxFps
  const bitRate = device?.controlBitRate ?? farm.controlBitRate
  return {
    maxSize,
    maxFps,
    bitRate,
    source: {
      maxSize: sourceOf(device?.controlMaxSize, farm.controlMaxSize, preset.maxSize),
      maxFps: sourceOf(device?.controlMaxFps, farm.controlMaxFps, preset.maxFps),
      bitRate: sourceOf(device?.controlBitRate, farm.controlBitRate, preset.bitRate),
    },
  }
}

/** The Studio-side reimplementation of `resolveVideoProfile(farm, device, 'wall')`. See `resolveControlProfile` above. */
export function resolveWallProfile(farm: FarmVideoSettings, device?: DeviceVideoSettings | null): VideoProfile {
  const preset = WALL_PRESETS[farm.wallPreset]
  const maxSize = device?.wallMaxSize ?? farm.wallMaxSize
  const maxFps = device?.wallMaxFps ?? farm.wallMaxFps
  const bitRate = device?.wallBitRate ?? farm.wallBitRate
  return {
    maxSize,
    maxFps,
    bitRate,
    source: {
      maxSize: sourceOf(device?.wallMaxSize, farm.wallMaxSize, preset.maxSize),
      maxFps: sourceOf(device?.wallMaxFps, farm.wallMaxFps, preset.maxFps),
      bitRate: sourceOf(device?.wallBitRate, farm.wallBitRate, preset.bitRate),
    },
  }
}

/** True when two profiles would produce a different encoder. Mirrors `sameVideoNumbers`. */
export function sameVideoNumbers(a: VideoNumbers, b: VideoNumbers): boolean {
  return a.maxSize === b.maxSize && a.maxFps === b.maxFps && a.bitRate === b.bitRate
}

/** `4 Mbit/s`, `2.5 Mbit/s`, `800 kbit/s` — matches the wording the schema's own `.describe()` text already uses, so a number typed in the Advanced reveal reads the same as the preset's own description. */
export function formatBitRatePreset(bps: number): string {
  if (bps >= 1_000_000) {
    const mb = bps / 1_000_000
    return `${mb % 1 === 0 ? mb.toFixed(0) : mb.toFixed(1)} Mbit/s`
  }
  return `${Math.round(bps / 1000)} kbit/s`
}

/** `20.0 Mbit/s` — always one decimal, for the projection/measured aggregate lines (§3.7, §3.9), where a trailing `.0` is the point (it is a computed rate, not a preset label). `bitsPerSec` — already bits, not bytes. */
export function formatMbps(bitsPerSec: number): string {
  return `${(bitsPerSec / 1_000_000).toFixed(1)} Mbit/s`
}

/** The six Advanced number fields, farm-schema key names, in the order the readout and "Reset to preset" both use. */
export const CONTROL_ADVANCED_KEYS = ['controlMaxSize', 'controlMaxFps', 'controlBitRate'] as const
export const WALL_ADVANCED_KEYS = ['wallMaxSize', 'wallMaxFps', 'wallBitRate'] as const
export const VIDEO_PRESET_KEYS = ['controlPreset', 'wallPreset'] as const
export const VIDEO_ADVANCED_KEYS = [...CONTROL_ADVANCED_KEYS, ...WALL_ADVANCED_KEYS] as const

/** `sharp` → `Sharp` — the enum value capitalised, matching how the schema's own `.describe()` prose names each preset. */
export function capitalize(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1)
}

/** One line of the effective-profile readout (plan 92 §3.9, §5 step 92.8's own "where each number came from"). */
export interface ReadoutRow {
  label: string
  value: string
  sourceLabel: string
}

/**
 * A resolved `VideoProfile` turned into the three rows the readout renders
 * — `labelFor` is the ONLY thing that differs between the farm Settings
 * page (three-way: preset / customized / device override, since a farm's
 * own readout never has a specific device in view) and the device page
 * (two-way: this device / the farm — plan 92 §5 step 92.8's acceptance
 * criterion 3, "the effective-profile readout names the farm as its
 * source"). The NUMBERS themselves always come from `resolveControlProfile`/
 * `resolveWallProfile` — this function never recomputes a source, only
 * renders the one the resolver already reported (this step's own brief,
 * §9 item 1).
 */
export function profileRows(profile: VideoProfile, labelFor: (s: VideoSource) => string): ReadoutRow[] {
  return [
    { label: 'Size', value: `${profile.maxSize} px`, sourceLabel: labelFor(profile.source.maxSize) },
    { label: 'Frame rate', value: `${profile.maxFps} fps`, sourceLabel: labelFor(profile.source.maxFps) },
    { label: 'Bitrate', value: formatBitRatePreset(profile.bitRate), sourceLabel: labelFor(profile.source.bitRate) },
  ]
}

/** Farm Settings page's own three-way label (§3.6, §3.9): names the preset by name so "which layer won" is legible without opening Advanced. */
export function farmSourceLabel(s: VideoSource, presetName: string): string {
  if (s === 'device') return 'device override' // never produced when `device` is omitted, kept for type completeness
  return s === 'preset' ? `${presetName} preset` : 'customized'
}

/** Device page's own two-way label (§5 step 92.8 acceptance criterion 3): collapses preset-vs-farm into one "the farm" answer, since a single device does not care HOW the farm arrived at its number. */
export function deviceSourceLabel(s: VideoSource): string {
  return s === 'device' ? 'this device' : 'the farm'
}

/**
 * The `POST /api/video/reprofile` summary, turned into a toast (§3.8, §5
 * step 92.8's own second warning: "the summary toast must name the skipped
 * devices"). `labels` resolves `skippedBusy`'s bare device ids (the
 * response schema carries ids only, not labels — `packages/protocol/src/
 * api/video.ts`) — the caller fetches them via `fetchDeviceRefs` (`@/lib/
 * api.ts`), the same resolver every other device-id-only response in Studio
 * already uses. Unresolved ids (a device forgotten between the reprofile
 * and the label fetch — should not happen in practice) fall back to the
 * raw id, never silently dropped from the count.
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
