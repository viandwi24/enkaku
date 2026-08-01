import type { DeviceStatus } from '@enkaku/protocol'

/**
 * Kontrak data yang dibutuhkan session, **tanpa mengenal database**.
 *
 * Core menyediakan implementasi berbasis Drizzle/SQLite; agent menyediakan
 * versi in-memory. Satu implementasi session dipakai keduanya (plan 12 §3.2).
 */
export interface DeviceSnapshot {
  id: string
  stableId: string
  /** Alamat transport adb saat ini. */
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
}

export interface DeviceSnapshotSource {
  get(deviceId: string): DeviceSnapshot | null
}

export interface SavedArtifact {
  /** Path relatif terhadap root artifact host. */
  path: string
  sizeBytes: number
}

/**
 * Tujuan penyimpanan artifact. Core menulis ke disk + baris DB; agent
 * mengunggahnya ke control plane lewat tunnel.
 */
export interface ArtifactSink {
  save(input: {
    kind: 'screenshot' | 'file' | 'log'
    label: string
    data: Uint8Array
    ext?: string
  }): Promise<SavedArtifact>
}
