import type { DeviceStatus, KeepAwakeMode } from '@enkaku/protocol'

/**
 * The data contract the session needs, **with no knowledge of any database**.
 *
 * The core supplies a Drizzle/SQLite implementation; the agent supplies
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
 * Tujuan penyimpanan artifact. Core menulis ke disk + baris DB; agent
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
