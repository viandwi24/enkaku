import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { EnkakuError } from './errors'

/**
 * One core per data directory, enforced at startup.
 *
 * Two cores sharing a data directory is never correct — they open the same
 * SQLite file, and worse, they both drive the same phones. `adb forward` binds
 * a host port to exactly one device, so the second core silently re-binds
 * ports the first one is using: video from one phone, taps landing on another,
 * sessions dying 30 ms after they open, and nothing anywhere reporting an
 * error.
 *
 * That is not hypothetical. It happened three times in a single day of
 * development — a stale core from an earlier session, a smoke-test core left
 * behind by an automated run, and a second `bun run dev` — and each time it
 * cost hours, because every symptom pointed at the video pipeline instead of
 * at the fact that something else owned the device.
 *
 * A lock file turns all of that into one line at startup.
 */

const LOCK_FILE = 'enkaku.lock'

interface LockContents {
  pid: number
  /** ISO timestamp, for the error message — humans read this, code does not. */
  startedAt: string
}

export interface DataDirLock {
  /** Remove the lock. Idempotent, and safe to call on a lock already gone. */
  release(): void
}

/**
 * The host/port the core is about to bind, for the stale-lock port probe
 * below (plan 85 §4.7, fixes F14). Optional — a caller that does not pass it
 * gets exactly the pre-plan-85 behaviour, since not every caller (e.g. a
 * script that only wants the directory claimed) has a port to check yet.
 */
export interface DataDirLockPortCheck {
  host: string
  port: number
  /**
   * Injectable for tests — defaults to a real read-only bind test, exactly
   * like `doctor/context.ts`'s `tryBindPort`: attempt to bind, and release
   * immediately on success. Returns `true` when the port is free. Never
   * sends a signal to anything; it only tests the socket.
   */
  probe?: (host: string, port: number) => boolean
}

/** Read-only "is anything already listening here" — see `DataDirLockPortCheck.probe`'s doc comment above for the contract. */
function defaultProbePortFree(host: string, port: number): boolean {
  try {
    const server = Bun.listen({ hostname: host, port, socket: { data() {} } })
    server.stop(true)
    return true
  } catch {
    return false
  }
}

/** Whether a process with this pid exists. Signal 0 checks without signalling. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM means it exists but belongs to another user — still alive.
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function readLock(path: string): LockContents | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return null
    const { pid, startedAt } = parsed as Partial<LockContents>
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return null
    return { pid, startedAt: typeof startedAt === 'string' ? startedAt : 'unknown' }
  } catch {
    // Unreadable or malformed: treat as no lock rather than refusing to start.
    // A corrupt lock file must never be the thing that bricks a farm.
    return null
  }
}

/**
 * Whether a live core currently holds this data directory, and which pid.
 *
 * The read-only half of `acquireDataDirLock` below, for the commands that
 * must not touch a running farm's files (`enkaku reset`) but have no business
 * claiming the lock themselves. Same staleness rule: a lock whose pid is gone
 * is not in use.
 */
export function dataDirHolder(dataDir: string): { pid: number; startedAt: string } | null {
  const path = join(dataDir, LOCK_FILE)
  if (!existsSync(path)) return null
  const held = readLock(path)
  return held && isAlive(held.pid) ? held : null
}

/**
 * Claim `<dataDir>/enkaku.lock`, or refuse to start.
 *
 * A lock whose pid is gone is taken over — that is the normal case after a
 * `kill -9` or a crash, and requiring manual file deletion there would be a
 * worse failure than the one this prevents.
 *
 * Known limit: a recycled pid now belonging to an unrelated program reads as
 * "still held", so the core refuses to start until the file is removed. That
 * is the safe direction to be wrong in, and the error message names the file.
 *
 * `portCheck` (plan 85 §4.7, fixes F14): "is that pid alive" and "is the
 * port free" are two different questions, and a stale lock only answers the
 * first one. The field log that motivated this showed them disagreeing
 * directly — `taking over a stale lock from pid 19964 (no such process)`
 * immediately followed by `Failed to start server. Is port 7700 in use?`.
 * When `portCheck` is given and the lock turns out to be stale, this also
 * probes the port the core is about to bind, and warns *now*, at the point
 * the log was actively implying "the port is free", rather than only
 * failing later with an unexplained `EADDRINUSE`.
 */
export function acquireDataDirLock(
  dataDir: string,
  log?: { info: (m: string) => void; warn?: (m: string) => void },
  portCheck?: DataDirLockPortCheck,
): DataDirLock {
  mkdirSync(dataDir, { recursive: true })
  const path = join(dataDir, LOCK_FILE)

  const held = existsSync(path) ? readLock(path) : null
  if (held && isAlive(held.pid)) {
    throw new EnkakuError(
      'E_DATA_DIR_IN_USE',
      `another Enkaku core (pid ${held.pid}, started ${held.startedAt}) is already using ${dataDir}. ` +
        'Two cores cannot share a data directory: they would fight over the same devices. ' +
        `Stop that process, or delete ${path} if you are certain it is gone.`,
    )
  }
  if (held) {
    log?.info(`taking over a stale lock from pid ${held.pid} (no such process)`)
    if (portCheck) {
      const probe = portCheck.probe ?? defaultProbePortFree
      const portFree = probe(portCheck.host, portCheck.port)
      if (!portFree) {
        log?.warn?.(
          `the stale lock's owner (pid ${held.pid}) is gone, but something else is already listening on ${portCheck.host}:${portCheck.port} — ` +
            'a dead pid does not mean the port is free. If startup then fails with "port already in use", this is why; run `enkaku doctor` to name the holder.',
        )
      }
    }
  }

  const contents: LockContents = { pid: process.pid, startedAt: new Date().toISOString() }
  writeFileSync(path, JSON.stringify(contents), 'utf8')

  let released = false
  return {
    release() {
      if (released) return
      released = true
      // Only remove a lock that is still ours. If some other core took over
      // after we were forcibly killed, deleting its lock would hand the farm
      // to a third process.
      const current = readLock(path)
      if (current?.pid === process.pid) rmSync(path, { force: true })
    },
  }
}
