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
  /**
   * Plan 99 §3.2, §4.6, §4.7 — read FRESH on every save (the same
   * "accessor, not a value" convention `resetPolicy`/`adb.maxConcurrent`
   * already use), so a save that lands while node 2 is running stamps node
   * 2 even though this whole `ArtifactStore` was built once, at job start,
   * for the job's WHOLE lifetime. Undefined (every non-workflow job) stamps
   * nothing — `nodeId` reads back `null`, byte-identical to before this
   * field existed. See this file's own module doc for the full mechanism.
   */
  nodeId?: () => string | null
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
        nodeId: deps.nodeId?.() ?? null,
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
          nodeId: info.nodeId,
        })
        .run()
      deps.onSaved(info)
      return info
    },
  }
}

/**
 * Plan 99 §3.2, §4.6, §4.7 — tracks which workflow NODE is currently
 * executing for a given job, so `createArtifactStore`'s `nodeId` accessor
 * above (read fresh on every save, from `createDbArtifactSink` in
 * `session/adapters.ts`, which is the SAME factory `createJobRunner`'s
 * `artifacts: (jobId) => ArtifactSink` is built from in `daemon.ts`) can
 * stamp `artifacts.node_id` with ZERO changes to `@enkaku/session` or the
 * child boundary (plan 99 §3.1, §3.2's "the runner learns nothing about
 * nodes").
 *
 * The mechanism, in one sentence: `JobRunner.execute()` calls
 * `deps.artifacts(job.id)` exactly once per node execution (every node in a
 * workflow shares the SAME `job.id`, §3.2) — the workflow executor
 * (`jobs/executors/workflow.ts`) calls `begin(job.id, node.id)`
 * immediately before that `execute()` call and `end(job.id)` immediately
 * after it resolves, so any artifact the child saves DURING that window
 * (through the ordinary, unmodified `ctx.artifact.save()` IPC path) is
 * attributed correctly. A standalone (non-workflow) job never calls
 * `begin`, so `current()` reads back `null` for it — the pre-plan-99
 * behaviour, unchanged.
 *
 * `noteAttempt`/`attempts` piggyback on the SAME per-job window for a
 * second fact `job_nodes.attempts` needs and has no other seam for:
 * `JobRunnerDeps.onPhase(jobId, attempt, phase)` already fires on every
 * attempt of every execution (daemon.ts's own callback, extended to call
 * `noteAttempt` here), and `attempt` resets to 1 at the top of every
 * `execute()` call (`job-runner.ts`'s own `let attempt = 0` inside
 * `execute()`) — so the highest value seen between one `begin`/`end` pair is
 * exactly how many attempts THIS node execution spent, with no new IPC
 * message and no runner change.
 */
export interface JobNodeTracker {
  begin(jobId: string, nodeId: string): void
  end(jobId: string): void
  current(jobId: string): string | null
  noteAttempt(jobId: string, attempt: number): void
  /** The highest attempt number seen since the last `begin` for this job; 0 if none (a gate, or a resolve/binding failure that never called `runner.execute()`). */
  attempts(jobId: string): number
}

export function createJobNodeTracker(): JobNodeTracker {
  const nodeByJob = new Map<string, string>()
  const attemptsByJob = new Map<string, number>()
  return {
    begin(jobId, nodeId) {
      nodeByJob.set(jobId, nodeId)
      attemptsByJob.set(jobId, 0)
    },
    end(jobId) {
      nodeByJob.delete(jobId)
      attemptsByJob.delete(jobId)
    },
    current(jobId) {
      return nodeByJob.get(jobId) ?? null
    },
    noteAttempt(jobId, attempt) {
      const prev = attemptsByJob.get(jobId)
      if (prev === undefined) return // no workflow node currently in flight for this job — nothing to attribute the attempt to
      if (attempt > prev) attemptsByJob.set(jobId, attempt)
    },
    attempts(jobId) {
      return attemptsByJob.get(jobId) ?? 0
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
 *
 * `jobId` (plan 93 §3.13, §4.6, step 93.9 — closes F12): a pull performed by
 * a batch/job passes `job.id` here so the artifact can be traced back to the
 * run that produced it; a pull with no job behind it (the REST route, the
 * script IPC bridge) passes `null`, exactly the pre-plan-93 value. Threaded
 * explicitly by every caller — never defaulted — so a caller that forgets it
 * fails to typecheck rather than silently landing `null`.
 */
export function registerDeviceArtifact(
  deps: { db: Db },
  opts: { deviceId: string; label: string; relPath: string; sizeBytes: number; jobId: string | null },
): ArtifactInfo {
  const info: ArtifactInfo = {
    id: crypto.randomUUID(),
    jobId: opts.jobId,
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
      jobId: info.jobId,
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
