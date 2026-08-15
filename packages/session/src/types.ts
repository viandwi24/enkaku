import type { DeviceSettings, DeviceStatus, KeepAwakeMode, MediaScanMode, PushResult, RotationMode, TextInputMode } from '@enkaku/protocol'

/**
 * The data contract the session needs, **with no knowledge of any database**.
 *
 * The core supplies a Drizzle/SQLite implementation; the node supplies
 * an in-memory one. One session implementation serves both (plan 12 §3.2).
 */
export interface DeviceSnapshot {
  id: string
  stableId: string
  /** The current adb transport address. */
  serial: string
  label: string
  status: DeviceStatus
  androidVersion: string | null
  apiLevel: number | null
  screenW: number | null
  screenH: number | null
  transport: string | null
  display: string | null
  input: string | null
  inspection: string | null
  preferredInputMode: 'uhid' | 'sdk' | 'aoa'
  /** DeviceSettings.prep.keepAwake (Plan 17 §3.4). */
  keepAwake?: KeepAwakeMode
  /** DeviceSettings.prep.standbyScreenOff (Plan 17 §3.5). */
  standbyScreenOff?: boolean
  /** DeviceSettings.prep.rotation (Plan 85 §3.7, §4.1). */
  rotation?: RotationMode
  /** DeviceSettings.prep.textInput (plan 90 §3.2, §4.4, §5 step 90.5). */
  textInput?: TextInputMode
  /**
   * DeviceSettings.instrumentation.tagTraffic (spec §9.4/§17; plan 87 §4.12,
   * §5 step 87.13) — whether a session marks this device as farm-instrumented
   * via `./farm-tag.ts`. Undefined behaves like `true` (on by default,
   * matching §17), the same default `createSession` applies when the field
   * is omitted entirely.
   */
  tagTraffic?: boolean
  /**
   * DeviceSettings.identity (plan 58 §4.2) — the spoofed identity the device
   * presents (timezone/locale/GPS). Carried so a session/job can read what the
   * device claims to be, mirroring how `keepAwake`/`standbyScreenOff` flow.
   */
  identity?: {
    timezone?: string
    locale?: string
    gps?: { lat: number; lng: number; accuracy?: number }
  }
  /**
   * DeviceSettings.video (plan 92 §3.5, §4.4) — this device's own video
   * picture override, projected at the same seam as `keepAwake`/`identity`
   * above so it cannot be saved-and-never-read (F18). `resolveVideoProfile`
   * (`./video-profile.ts`) reads it as the "device" layer, farm settings
   * underneath. Undefined behaves exactly like `{}` (follow the farm on
   * every field) — the default a device with no override, or no row at all,
   * always resolves to.
   */
  video?: DeviceSettings['video']
}

export interface DeviceSnapshotSource {
  get(deviceId: string): DeviceSnapshot | null
}

export interface SavedArtifact {
  /** Path relative to the host's artifact root. */
  path: string
  sizeBytes: number
}

/**
 * Tujuan penyimpanan artifact. Core menulis ke disk + baris DB; node
 * uploads them to the control plane over the tunnel.
 */
export interface ArtifactSink {
  save(input: {
    kind: 'screenshot' | 'file' | 'log'
    label: string
    data: Uint8Array
    ext?: string
  }): Promise<SavedArtifact>
}

/**
 * The script API's `ctx.device.install`/`push`/`pull` (plan 39 §4.6) — the
 * SAME shape as `@enkaku/core`'s `TransferService`, deliberately re-declared
 * here rather than imported: `@enkaku/session` cannot depend on
 * `@enkaku/core` (core already depends on session), so the host injects its
 * real `TransferService` as an implementation of this narrower, deviceId-first
 * interface, the same pattern `ArtifactSink` above already establishes for
 * `ctx.artifact`. `remotePath` validation (absolute, no `..`, no
 * metacharacters — plan §4.6) happens inside the host's real implementation,
 * which is the one place it needs to happen: every caller of this interface,
 * local or remote, ends up there.
 */
export interface TransferPort {
  install(
    deviceId: string,
    opts: { artifactId: string; reinstall?: boolean; grantPermissions?: boolean; allowDowngrade?: boolean },
  ): Promise<{ package: string | null; durationMs: number; output: string }>
  /** `mediaScan` (plan 90 §4.6) defaults to `'auto'` at the executor when omitted. */
  push(deviceId: string, opts: { artifactId: string; remotePath: string; mediaScan?: MediaScanMode }): Promise<PushResult>
  pull(deviceId: string, opts: { remotePath: string }): Promise<{ artifactId: string; bytes: number }>
}
