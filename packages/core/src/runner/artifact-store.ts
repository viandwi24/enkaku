import { mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { ArtifactInfo } from '@enkaku/protocol'
import type { Db } from '../db'
import { artifacts } from '../db/schema'
import { EnkakuError } from '../util/errors'

const MAX_FILE_BYTES = 8 * 1024 * 1024

const slug = (label: string): string =>
  label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60) || 'artifact'

export interface ArtifactStore {
  save(input: {
    kind: 'screenshot' | 'file' | 'log'
    label: string
    data: Uint8Array
    ext?: string
  }): Promise<ArtifactInfo>
  jobDir(): string
}

/**
 * Per-job artifacts (spec §11.2, §7.2): `<app-data>/artifacts/<job-id>/`.
 * `path` is stored RELATIVE to app-data so the folder can be moved.
 */
export function createArtifactStore(deps: {
  db: Db
  dataDir: string
  jobId: string
  onSaved: (info: ArtifactInfo) => void
}): ArtifactStore {
  const dir = join(deps.dataDir, 'artifacts', deps.jobId)
  let seq = 0

  return {
    jobDir: () => dir,

    async save({ kind, label, data, ext }) {
      if (kind === 'file' && data.length > MAX_FILE_BYTES) {
        throw new EnkakuError('ARTIFACT_TOO_LARGE', `artifact "${label}" ${data.length} byte melebihi 8 MB`)
      }
      mkdirSync(dir, { recursive: true })
      seq += 1
      const extension = ext ?? (kind === 'screenshot' ? 'png' : kind === 'log' ? 'log' : 'bin')
      const filename = `${String(seq).padStart(3, '0')}-${slug(label)}.${extension}`
      const abs = join(dir, filename)
      await Bun.write(abs, data)
      const size = statSync(abs).size
      const info: ArtifactInfo = {
        id: crypto.randomUUID(),
        jobId: deps.jobId,
        deviceId: null,
        kind,
        label,
        path: join('artifacts', deps.jobId, filename),
        sizeBytes: size,
        createdAt: Math.floor(Date.now() / 1000),
      }
      deps.db
        .insert(artifacts)
        .values({
          id: info.id,
          jobId: info.jobId,
          kind: info.kind,
          label: info.label,
          path: info.path,
          sizeBytes: size,
          createdAt: new Date(),
        })
        .run()
      deps.onSaved(info)
      return info
    },
  }
}

/**
 * Device-scoped artifacts (plan 24 §4.6) — no job to belong to, so they live
 * under `<app-data>/artifacts/device-<device-id>/` instead of a job folder,
 * and the DB row carries `deviceId` with `jobId` left null. Used today for
 * "save last N lines" from the Monitor tab; kind is always `log`.
 */
export async function saveForDevice(
  deps: { db: Db; dataDir: string },
  deviceId: string,
  label: string,
  data: Uint8Array,
  ext = 'log',
): Promise<ArtifactInfo> {
  if (data.length > MAX_FILE_BYTES) {
    throw new EnkakuError('ARTIFACT_TOO_LARGE', `artifact "${label}" ${data.length} byte melebihi 8 MB`)
  }
  const relDir = join('artifacts', `device-${deviceId}`)
  const dir = join(deps.dataDir, relDir)
  mkdirSync(dir, { recursive: true })
  const filename = `${Date.now()}-${slug(label)}.${ext}`
  const abs = join(dir, filename)
  await Bun.write(abs, data)
  const size = data.length
  const info: ArtifactInfo = {
    id: crypto.randomUUID(),
    jobId: null,
    deviceId,
    kind: 'log',
    label,
    path: join(relDir, filename),
    sizeBytes: size,
    createdAt: Math.floor(Date.now() / 1000),
  }
  deps.db
    .insert(artifacts)
    .values({
      id: info.id,
      deviceId: info.deviceId,
      kind: info.kind,
      label: info.label,
      path: info.path,
      sizeBytes: size,
      createdAt: new Date(),
    })
    .run()
  return info
}

/**
 * Computes (but does not create) the destination for a pulled file (plan 39
 * §3.6, §4.2) — split from `saveForDevice` above because a pull streams
 * straight to disk via `@enkaku/adb`'s `pullFile` (up to `transfer.maxPullBytes`,
 * default 512 MB) rather than handing a whole `Uint8Array` through this
 * module, which would mean buffering a pull's entire contents in memory just
 * to satisfy this function's signature. The caller creates `dir`, streams
 * into `abs`, then calls `registerDeviceArtifact` once the file is written.
 */
export function devicePullArtifactPath(
  dataDir: string,
  deviceId: string,
  label: string,
  ext: string,
): { abs: string; rel: string; dir: string } {
  const relDir = join('artifacts', `device-${deviceId}`)
  const dir = join(dataDir, relDir)
  const filename = `${Date.now()}-${slug(label)}.${ext}`
  return { abs: join(dir, filename), rel: join(relDir, filename), dir }
}

/**
 * Registers a device-scoped artifact for a file ALREADY written to disk at
 * `devicePullArtifactPath`'s `abs` (plan 39 §3.6, §4.2) — no `MAX_FILE_BYTES`
 * check here, unlike `saveForDevice`: a pull's cap is `transfer.maxPullBytes`
 * (default 512 MB, far above the 8 MB `saveForDevice` enforces for "save last
 * N lines" style artifacts), and it was already enforced twice before this
 * point — once by `statRemote` and again by `pullFile`'s running-total check
 * — so re-applying the smaller cap here would be both redundant and wrong.
 */
export function registerDeviceArtifact(
  deps: { db: Db },
  opts: { deviceId: string; label: string; relPath: string; sizeBytes: number },
): ArtifactInfo {
  const info: ArtifactInfo = {
    id: crypto.randomUUID(),
    jobId: null,
    deviceId: opts.deviceId,
    kind: 'file',
    label: opts.label,
    path: opts.relPath,
    sizeBytes: opts.sizeBytes,
    createdAt: Math.floor(Date.now() / 1000),
  }
  deps.db
    .insert(artifacts)
    .values({
      id: info.id,
      deviceId: info.deviceId,
      kind: info.kind,
      label: info.label,
      path: info.path,
      sizeBytes: info.sizeBytes,
      createdAt: new Date(),
    })
    .run()
  return info
}
