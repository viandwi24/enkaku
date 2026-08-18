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
      const instrumentation = settings.success ? settings.data.instrumentation : defaultDeviceSettings().instrumentation
      // Plan 92 §3.5, §4.4 — same dead-config guard as identity/tagTraffic
      // below: a device's own video override must be read here, at the one
      // seam session creation actually consults, or `resolveVideoProfile`
      // would only ever see the farm's numbers (F18).
      const video = settings.success ? settings.data.video : defaultDeviceSettings().video
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
        rotation: prep.rotation,
        // Plan 90 §3.2, §4.4, §5 step 90.5 — same dead-config guard as
        // identity/tagTraffic below: read here, at the one seam session
        // creation actually consults, or "auto" would be true only in the
        // schema (plan 33 §5.9's lesson, cited by the two settings below it).
        textInput: prep.textInput,
        // Plan 58 §4.2 — the dead-config guard (plan 33 §5.9's lesson) applies
        // here too: identity is projected at the SAME seam the settings blob is
        // read, so it cannot be saved-and-never-read like `timing` once was.
        identity,
        // Plan 87 §4.12, §5 step 87.13 — same dead-config guard as identity
        // above: the farm-tagging setting must be read here, not just saved,
        // or "on by default" (spec §17) would be true only in the schema.
        tagTraffic: instrumentation.tagTraffic,
        // Plan 92 §3.5, §4.4 — this device's own video override, resolved
        // against the farm's settings by `resolveVideoProfile`.
        video,
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
  /** Plan 99 §3.2, §4.6, §4.7 — forwarded straight to `createArtifactStore`; see its own doc comment. */
  nodeId?: () => string | null
  /** Plan 115 §3.6 — forwarded straight to `createArtifactStore`; see its own doc comment. */
  maxFileBytes: () => number
}): ArtifactSink {
  const store = createArtifactStore(deps)
  return {
    async save(input) {
      const info = await store.save(input)
      // Plan 115 §3.6 — `id` is what `ctx.artifact.file()` hands back to the
      // script, all the way through `job-runner.ts`'s `artifact.result`.
      return { id: info.id, path: info.path, sizeBytes: info.sizeBytes ?? 0 }
    },
  }
}
