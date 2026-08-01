import type { ArtifactInfo } from '@enkaku/protocol'
import type { ArtifactSink, DeviceSnapshot, DeviceSnapshotSource } from '@enkaku/session'
import { eq } from 'drizzle-orm'
import type { Db } from '../db'
import { devices } from '../db/schema'
import { createArtifactStore } from '../runner/artifact-store'

/** Sumber data device untuk session, dibaca dari SQLite (mode lokal). */
export function createDbDeviceSource(db: Db): DeviceSnapshotSource {
  return {
    get(deviceId): DeviceSnapshot | null {
      const row = db.select().from(devices).where(eq(devices.id, deviceId)).get()
      if (!row) return null
      return {
        id: row.id,
        stableId: row.stableId,
        serial: row.serial,
        label: row.label,
        status: (row.status ?? 'offline') as DeviceSnapshot['status'],
        androidVersion: row.androidVersion,
        apiLevel: row.apiLevel,
        screenW: row.screenW,
        screenH: row.screenH,
        transport: row.transport,
        display: row.display,
        input: row.input,
        inspection: row.inspection,
        preferredInputMode:
          (row.settings as { input?: { preferredMode?: 'uhid' | 'sdk' | 'aoa' } } | null)?.input?.preferredMode ??
          'uhid',
      }
    },
  }
}

/** Artifact ditulis ke disk + baris DB (mode lokal). */
export function createDbArtifactSink(deps: {
  db: Db
  dataDir: string
  jobId: string
  onSaved: (info: ArtifactInfo) => void
}): ArtifactSink {
  const store = createArtifactStore(deps)
  return {
    async save(input) {
      const info = await store.save(input)
      return { path: info.path, sizeBytes: info.sizeBytes ?? 0 }
    },
  }
}
