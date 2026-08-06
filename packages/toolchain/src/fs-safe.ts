import { copyFileSync, cpSync, existsSync, mkdirSync, renameSync, rmSync, unlinkSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * Filesystem moves that survive Windows.
 *
 * On Windows a rename fails with EPERM/EACCES whenever ANOTHER process holds a
 * handle to the target — Defender scanning a freshly written APK, the search
 * indexer walking a new folder, a sync client. It is not an ACL problem, so
 * running as Administrator does not help; the lock is transient and the cure is
 * a retry. Renaming a *directory* is the worst case: a handle on any single
 * file inside it is enough to fail the whole move.
 *
 * Every rename/rm on the tools tree goes through these helpers, never the bare
 * node:fs calls.
 */

/** Errors worth retrying — all of them mean "someone else is holding it, briefly". */
const TRANSIENT = new Set(['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY'])
const ATTEMPTS = 10
const MAX_DELAY_MS = 400

export interface FsSafeOptions {
  onWarn?: (msg: string) => void
}

function errCode(err: unknown): string {
  return typeof err === 'object' && err !== null && 'code' in err ? String((err as { code: unknown }).code) : ''
}

function isTransient(err: unknown): boolean {
  return TRANSIENT.has(errCode(err))
}

/** Retrying will never help these, but a copy will: a rename cannot cross a volume. */
function needsCopy(err: unknown): boolean {
  return isTransient(err) || errCode(err) === 'EXDEV'
}

/** Run a sync fs op, retrying transient lock errors with a capped backoff. Exported for tests. */
export async function withRetry<T>(op: () => T): Promise<T> {
  let last: unknown
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    try {
      return op()
    } catch (err) {
      if (!isTransient(err)) throw err
      last = err
      await Bun.sleep(Math.min(25 * 2 ** attempt, MAX_DELAY_MS))
    }
  }
  throw last
}

/** rm -rf that tolerates a transient lock (no-op when the path is gone). */
export async function rmPath(path: string): Promise<void> {
  await withRetry(() => rmSync(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }))
}

/**
 * Move a single file. Falls back to copy+unlink when the rename cannot win —
 * a copy opens a fresh destination handle, so it is not blocked by a reader
 * holding the source, and it crosses volumes.
 */
export async function moveFile(src: string, dest: string, opts: FsSafeOptions = {}): Promise<void> {
  mkdirSync(dirname(dest), { recursive: true })
  try {
    await withRetry(() => renameSync(src, dest))
    return
  } catch (err) {
    if (!needsCopy(err)) throw err
    opts.onWarn?.(`rename ${src} → ${dest} kept failing (${errCode(err)}) — falling back to copy`)
  }
  copyFileSync(src, dest)
  try {
    unlinkSync(src)
  } catch {
    // the source is a staging leftover; boot clears .staging anyway
  }
}

/**
 * Move a directory tree. Falls back to a recursive copy, then removes the
 * source best-effort. The copy is not atomic, so the caller must remove `dest`
 * itself if a later step fails.
 */
export async function moveDir(src: string, dest: string, opts: FsSafeOptions = {}): Promise<void> {
  mkdirSync(dirname(dest), { recursive: true })
  try {
    await withRetry(() => renameSync(src, dest))
    return
  } catch (err) {
    if (!needsCopy(err)) throw err
    opts.onWarn?.(`rename ${src} → ${dest} kept failing (${errCode(err)}) — falling back to a recursive copy`)
  }
  if (existsSync(dest)) await rmPath(dest)
  cpSync(src, dest, { recursive: true })
  await rmPath(src).catch(() => {})
}
