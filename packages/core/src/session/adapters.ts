import { DeviceSettingsSchema, defaultDeviceSettings, type ArtifactInfo } from '@enkaku/protocol'
import type { ArtifactSink, DeviceSnapshot, DeviceSnapshotSource } from '@enkaku/session'
import { eq } from 'drizzle-orm'
import type { Db } from '../db'
import { devices } from '../db/schema'
import { createArtifactStore } from '../runner/artifact-store'

/** The device data source for sessions, read from SQLite (local mode). */
export function createDbDeviceSource(db: Db): DeviceSnapshotSource {
  return {
    get(deviceId): DeviceSnapshot | null {
      const row = db.select().from(devices).where(eq(devices.id, deviceId)).get()
      if (!row) return null
      // Legacy rows may still hold `prep.stayAwake` as a plain boolean (Plan 17
      // §4.2). Parsing the whole settings blob through the schema normalises
      // it the same way a fresh save would — this is the one place session
      // creation reads it, so it is the one place that needs to know about
      // the old shape.
      const settings = DeviceSettingsSchema.safeParse(row.settings ?? {})
      const prep = settings.success ? settings.data.prep : defaultDeviceSettings().prep
      const identity = settings.success ? settings.data.identity : defaultDeviceSettings().identity
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
        keepAwake: prep.keepAwake,
        standbyScreenOff: prep.standbyScreenOff,
        // Plan 58 §4.2 — the dead-config guard (plan 33 §5.9's lesson) applies
        // here too: identity is projected at the SAME seam the settings blob is
        // read, so it cannot be saved-and-never-read like `timing` once was.
        identity,
      }
    },
  }
}

/** Artifacts written to disk plus a DB row (local mode). */
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
