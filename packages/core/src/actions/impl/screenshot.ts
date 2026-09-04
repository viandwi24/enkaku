import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { ArtifactInfo } from '@enkaku/protocol'
import type { Db } from '../../db'
import { registerDeviceArtifact } from '../../runner/artifact-store'

/** `screenshot` (plan 207 §4.2) — writes through the one device-artifact writer, `registerDeviceArtifact`. */
export async function screenshotDevice(
  deps: { db: Db; dataDir: string; screenshot: (deviceId: string) => Promise<Uint8Array> },
  deviceId: string,
): Promise<ArtifactInfo> {
  const data = await deps.screenshot(deviceId)
  const relDir = join('artifacts', `device-${deviceId}`)
  const dir = join(deps.dataDir, relDir)
  mkdirSync(dir, { recursive: true })
  const filename = `screenshot-${Math.floor(Date.now() / 1000)}.png`
  const abs = join(dir, filename)
  await Bun.write(abs, data)
  return registerDeviceArtifact({ db: deps.db }, { deviceId, label: filename, relPath: join(relDir, filename), sizeBytes: data.length, runId: null })
}
