import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { UiNodeSchema, type UiNode } from '@enkaku/protocol'
import { sha256Hex } from '../../agent/blob/store'
import { EnkakuError } from '../../util/errors'

/**
 * The per-job trace file store (plan 128 §3.5) — frames and UI-tree snapshots
 * for one job's timeline, content-addressed by the SHA-256 of their bytes:
 *
 * ```
 * <dataDir>/traces/<jobId>/<sha256>.png      # a frame — the filename IS the hash
 * <dataDir>/traces/<jobId>/<sha256>.json.gz  # a gzipped UI tree snapshot
 * ```
 *
 * Two actions on an unchanged screen write ONE file and produce two events
 * both naming that hash: the owner's "every action has its own screenshot"
 * model is preserved exactly while the bytes are stored once (§3.5).
 *
 * **Why not the agent blob store** (plan 128 §0.4): `agent/blob/gc.ts`'s
 * `referencedBlobIds()` scans `agent_messages` and nothing else, so a trace
 * frame parked in `agent_blobs` would be an orphan the moment it was written
 * and would be swept once it cleared `retention.blobOrphanGraceHours` — every
 * trace screenshot vanishing 24 hours later. That GC is not wrong; that table
 * is the wrong home. `sha256Hex` is imported from it and reused as a PURE
 * function; the `agent_blobs` table is never touched here.
 *
 * The lifetime rule falls out of the layout: deleting a job is
 * `removeJob(jobId)` plus one `DELETE FROM job_events WHERE job_id = ?`. No
 * reference counting, no orphan sweep, and no query anywhere that has to be
 * kept in step — the price is that identical frames in two different jobs are
 * stored twice, given up deliberately in §2.
 */

/** Concrete, `ArrayBuffer`-backed bytes — what `Bun.gunzipSync` requires (it rejects the broader `ArrayBufferLike`, which also admits `SharedArrayBuffer`). */
type Bytes = Uint8Array<ArrayBuffer>

/** A content address as it appears in a filename and in a URL: 64 lowercase hex digits, nothing else. */
const HASH_RE = /^[0-9a-f]{64}$/

/**
 * A job id as it appears in a URL path segment. Ids are `crypto.randomUUID()`
 * everywhere in this repo, so this is deliberately narrower than "anything
 * without a slash": no separator, no `..`, no NUL, no drive letter.
 */
const JOB_ID_RE = /^[A-Za-z0-9_-]{1,64}$/

/**
 * Both of these guards exist because `<dataDir>/traces/<jobId>/<hash>.png` is
 * built from two values that arrive from a URL (`GET /api/jobs/:id/trace/frames/:hash`,
 * §4.3). A path is never built from unvalidated input: a `hash` of
 * `../../../etc/passwd` must be refused here, at the store, rather than
 * relied upon to be caught by whatever route happens to call it next.
 */
function assertJobId(jobId: string): void {
  if (!JOB_ID_RE.test(jobId)) {
    throw new EnkakuError('E_BAD_REQUEST', `invalid job id "${jobId}" for a trace path`)
  }
}

function assertHash(hash: string): void {
  if (!HASH_RE.test(hash)) {
    throw new EnkakuError('E_BAD_REQUEST', `invalid trace content hash "${hash}" (expected 64 lowercase hex digits)`)
  }
}

export interface TraceFrameStore {
  /** `<dataDir>/traces/<jobId>` — absolute; not created until something is written. */
  jobDir(jobId: string): string
  /**
   * Stores a frame under its own content hash and returns that hash. Writes
   * only when the file is absent, so a second identical frame costs one hash
   * and one `existsSync` (plan 128 §3.5, criterion 6).
   */
  putFrame(jobId: string, bytes: Uint8Array): Promise<string>
  /** The same, for a UI tree: the JSON is gzipped before it is written. */
  putUiTree(jobId: string, node: UiNode): Promise<string>
  /** The frame's bytes, or null when the file is gone (swept, or never captured) — a 404 upstream. */
  readFrame(jobId: string, hash: string): Promise<Bytes | null>
  /** The snapshot, gunzipped and re-validated, or null when the file is gone. */
  readUiTree(jobId: string, hash: string): Promise<UiNode | null>
  /** Removes the whole job directory. Idempotent — a job that never captured anything has none. */
  removeJob(jobId: string): Promise<void>
}

export function createTraceFrameStore(deps: { dataDir: string }): TraceFrameStore {
  function dirFor(jobId: string): string {
    assertJobId(jobId)
    return join(deps.dataDir, 'traces', jobId)
  }

  async function put(jobId: string, bytes: Uint8Array, ext: string): Promise<string> {
    const dir = dirFor(jobId)
    const hash = sha256Hex(bytes)
    const abs = join(dir, `${hash}.${ext}`)
    // Content-addressed: identical bytes are already on disk, byte for byte.
    // Rewriting them would only churn the file and lose its original mtime.
    if (existsSync(abs)) return hash
    mkdirSync(dir, { recursive: true })
    await Bun.write(abs, bytes)
    return hash
  }

  async function read(jobId: string, hash: string, ext: string): Promise<Bytes | null> {
    const dir = dirFor(jobId)
    assertHash(hash)
    const abs = join(dir, `${hash}.${ext}`)
    if (!existsSync(abs)) return null
    return await Bun.file(abs).bytes()
  }

  return {
    jobDir: dirFor,

    putFrame(jobId, bytes) {
      return put(jobId, bytes, 'png')
    },

    putUiTree(jobId, node) {
      const json = new TextEncoder().encode(JSON.stringify(node))
      return put(jobId, Bun.gzipSync(json), 'json.gz')
    },

    readFrame(jobId, hash) {
      return read(jobId, hash, 'png')
    },

    async readUiTree(jobId, hash) {
      const gz = await read(jobId, hash, 'json.gz')
      if (!gz) return null
      // Content off disk is external input like any other (00-overview §4.2):
      // parsed, never cast. A file that survived a truncated write or a disk
      // fault is a coded 500, NOT a silent null — null means "gone", and a
      // corrupt snapshot reported as gone would send a debugger looking for a
      // retention sweep that never ran.
      let parsed: unknown
      try {
        parsed = JSON.parse(new TextDecoder().decode(Bun.gunzipSync(gz)))
      } catch (err) {
        throw new EnkakuError('E_TRACE_CORRUPT', `trace ui snapshot ${hash} for job ${jobId} is unreadable`, err)
      }
      const result = UiNodeSchema.safeParse(parsed)
      if (!result.success) {
        throw new EnkakuError('E_TRACE_CORRUPT', `trace ui snapshot ${hash} for job ${jobId} is not a ui tree`)
      }
      return result.data
    },

    async removeJob(jobId) {
      rmSync(dirFor(jobId), { recursive: true, force: true })
    },
  }
}
