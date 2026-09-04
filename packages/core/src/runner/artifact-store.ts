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
  runDir(): string
}

/**
 * Per-run artifacts (spec §11.2, §7.2, plan 211): `<app-data>/artifacts/<run-id>/`.
 * `path` is stored RELATIVE to app-data so the folder can be moved.
 */
export function createArtifactStore(deps: {
  db: Db
  dataDir: string
  runId: string
  onSaved: (info: ArtifactInfo) => void
  /**
   * The `kind: 'file'` size cap (plan 115 §3.6, W5) — read fresh on every
   * save, so a settings change applies to the very next save with no
   * restart. Driven from `transfer.maxPushBytes` (the farm's own push
   * limit, W6) rather than the bare 8 MB `MAX_FILE_BYTES` this replaces for
   * this kind — a video is 5-50 MB, three orders of magnitude past the old
   * ceiling. Never applied to `kind: 'screenshot'` (§3.6: "the screenshot
   * path is untouched") or `kind: 'log'`.
   */
  maxFileBytes: () => number
}): ArtifactStore {
  const dir = join(deps.dataDir, 'artifacts', deps.runId)
  let seq = 0

  return {
    runDir: () => dir,

    async save({ kind, label, data, ext }) {
      if (kind === 'file') {
        const cap = deps.maxFileBytes()
        if (data.length > cap) {
          throw new EnkakuError('ARTIFACT_TOO_LARGE', `artifact "${label}" is ${data.length} bytes, exceeding the ${cap}-byte limit (transfer.maxPushBytes)`)
        }
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
        runId: deps.runId,
        deviceId: null,
        kind,
        label,
        path: join('artifacts', deps.runId, filename),
        sizeBytes: size,
        createdAt: Math.floor(Date.now() / 1000),
      }
      deps.db
        .insert(artifacts)
        .values({
          id: info.id,
          runId: info.runId,
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
 * Device-scoped artifacts (plan 24 §4.6) — no run to belong to, so they live
 * under `<app-data>/artifacts/device-<device-id>/` instead of a run folder,
 * and the DB row carries `deviceId` with `runId` left null. Used today for
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
    throw new EnkakuError('ARTIFACT_TOO_LARGE', `artifact "${label}" is ${data.length} bytes, exceeding the ${MAX_FILE_BYTES}-byte limit`)
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
    runId: null,
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
 *
 * `runId` (plan 93 §3.13, §4.6, step 93.9 — closes F12; renamed from `jobId`
 * by plan 211): a pull performed by a batch/job passes the run id here so
 * the artifact can be traced back to the run that produced it; a pull with
 * no job behind it (the REST route, the script IPC bridge) passes `null`,
 * exactly the pre-plan-93 value. Threaded explicitly by every caller — never
 * defaulted — so a caller that forgets it fails to typecheck rather than
 * silently landing `null`.
 */
export function registerDeviceArtifact(
  deps: { db: Db },
  opts: { deviceId: string; label: string; relPath: string; sizeBytes: number; runId: string | null },
): ArtifactInfo {
  const info: ArtifactInfo = {
    id: crypto.randomUUID(),
    runId: opts.runId,
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
      runId: info.runId,
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
