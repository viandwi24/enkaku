import { PerDeviceQueue, Semaphore } from '@enkaku/adb'
import { EnkakuError } from '../util/errors'

/**
 * One bounded adb CLI helper (plan 85 §3.4, §4.5) — fixes F11/F12, a single
 * defect with four faces that only goes away when fixed together:
 *
 *   1. The old `hostAdb` (duplicated verbatim in `daemon.ts` twice, plus a
 *      third copy for the guest-agent routes, plus a fourth in the ui-server
 *      launcher) piped `stderr` and never read it — the real
 *      `INSTALL_FAILED_*` reason was always on stderr, and the thrown error
 *      carried stdout only.
 *   2. It had no deadline: a wedged `adb.exe` hung its caller forever.
 *   3. It had no concurrency bound: a fleet-wide inspector attach could fire
 *      dozens of simultaneous `pm install` sessions over one USB controller
 *      (H5).
 *   4. The scrcpy server was launched through it as a fire-and-forget
 *      long-lived child, its whole stdout accumulated in memory for the life
 *      of the session, with nothing holding a handle to kill it on exit.
 *
 * This module is the one place any adb CLI process (`adb install`, `adb
 * push`, `adb forward`, or the long-lived `adb shell` that runs the scrcpy
 * server) gets spawned. `daemon.ts` builds exactly one instance and threads
 * it through `makeScrcpy`, `makeInspector`, and the guest-agent routes.
 */

/** Bounded diagnostic tail — never the whole session's output (plan 85 §3.4). */
const MAX_TAIL_BYTES = 64 * 1024
/** `run()`'s default deadline for an ordinary command (forward, uninstall, the scrcpy jar push). */
const DEFAULT_RUN_TIMEOUT_MS = 30_000
/** An APK install legitimately takes longer than a forward or a jar push (plan 85 §3.4). */
const INSTALL_TIMEOUT_MS = 180_000

export type HostAdbErrorCode = 'E_ADB_CLI_FAIL' | 'E_ADB_CLI_TIMEOUT'

/**
 * Thrown by `run()` on a non-zero exit or a deadline expiry. Carries the exit
 * code (`null` on a timeout kill) plus BOTH bounded tails — this is the
 * actual fix for F11's "exit 1: Performing Streamed Install" field report:
 * the real `INSTALL_FAILED_*` reason lives on `stderrTail`, which the old
 * helper never read at all.
 */
export class HostAdbError extends EnkakuError {
  constructor(
    code: HostAdbErrorCode,
    message: string,
    public readonly exitCode: number | null,
    public readonly stdoutTail: string,
    public readonly stderrTail: string,
  ) {
    super(code, message)
    this.name = 'HostAdbError'
  }
}

export interface HostAdbRunOptions {
  /** Default 30_000; 180_000 when `lane` is `'install'` and this is omitted. */
  timeoutMs?: number
  /**
   * `'install'` additionally takes the farm's `adb.maxInstallConcurrent`
   * semaphore AND serialises behind every other `'install'`-lane call on the
   * same `serial` (plan 85 §3.4, tests H5) — a fleet attaching inspectors at
   * once must not fire two concurrent `pm install` sessions on ONE device,
   * let alone dozens across the farm.
   */
  lane?: 'default' | 'install'
  /** Required when `lane` is `'install'`. */
  serial?: string
}

export interface LongLivedChild {
  readonly pid: number | null
  /** The last 64 KB of combined stdout+stderr, for diagnostics — bounded, never the whole session (F12). */
  tail(): string
  kill(): void
  /** Resolves with the exit code once the child has actually exited. */
  exited: Promise<number>
}

export interface HostAdb {
  run(args: string[], opts?: HostAdbRunOptions): Promise<string>
  /** For the scrcpy server: a long-lived child, drained continuously, never awaited to completion by the caller. */
  spawnLongLived(args: string[], opts?: { onExit?: (code: number, tail: string) => void }): LongLivedChild
  /**
   * Kills every child THIS instance spawned — nothing else. `killAll` only
   * ever iterates the `Bun.Subprocess` handles this module created with its
   * own `Bun.spawn` calls; it never looks up a pid, never shells out to `ps`
   * or `Get-Process`, and never touches the adb server itself. That is what
   * makes it safe to call from `daemon.stop()` unconditionally (plan 85 §8's
   * called-out risk: "must never enumerate the system").
   */
  killAll(): void
  stats(): { running: number; maxConcurrent: number; installsRunning: number; longLived: number }
}

export interface HostAdbDeps {
  /**
   * Read fresh on every call, exactly like every other "adb might not be
   * ready yet" dep in `daemon.ts` (`guestAgentHostAdb`/`guestAgentExec`) —
   * throwing here (e.g. `E_ADB_UNAVAILABLE`) surfaces before anything is
   * spawned, rather than `hostAdb` needing its own readiness state.
   */
  binaryPath: () => string
  /** `adb.maxHostConcurrent`/`adb.maxInstallConcurrent`, read fresh so a live settings change takes effect on the next call without a restart. */
  settings: () => { maxHostConcurrent: number; maxInstallConcurrent: number }
  onLog?: (level: 'debug' | 'info' | 'warn', msg: string) => void
}

/** Keeps only the last `maxBytes` bytes pushed to it — never the whole session (F12). */
function createRingBuffer(maxBytes: number) {
  const chunks: Uint8Array[] = []
  let total = 0
  return {
    push(chunk: Uint8Array): void {
      chunks.push(chunk)
      total += chunk.length
      while (total > maxBytes && chunks.length > 1) {
        const removed = chunks.shift()
        if (removed) total -= removed.length
      }
      if (chunks.length === 1 && total > maxBytes) {
        const only = chunks[0]
        if (only) {
          chunks[0] = only.subarray(only.length - maxBytes)
          total = chunks[0].length
        }
      }
    },
    text(): string {
      const buf = new Uint8Array(total)
      let offset = 0
      for (const c of chunks) {
        buf.set(c, offset)
        offset += c.length
      }
      return new TextDecoder().decode(buf)
    },
  }
}

/**
 * Drains a stream to completion, chunk by chunk. Callers race this alongside
 * a sibling drain of the OTHER stream (stdout vs stderr) — sequentially
 * awaiting one before starting the other is exactly the F11 defect that let
 * an undrained stderr pipe fill and block the child (H4).
 */
async function drainStream(stream: ReadableStream<Uint8Array> | undefined, onChunk: (chunk: Uint8Array) => void): Promise<void> {
  if (!stream) return
  for await (const chunk of stream) {
    onChunk(chunk)
  }
}

export function createHostAdb(deps: HostAdbDeps): HostAdb {
  const log = deps.onLog ?? (() => {})
  const initial = deps.settings()
  const hostSem = new Semaphore(Math.max(1, initial.maxHostConcurrent))
  const installSem = new Semaphore(Math.max(1, initial.maxInstallConcurrent))
  const installQueue = new PerDeviceQueue(installSem)
  // Every `Bun.Subprocess` this module has ever spawned and not yet reaped —
  // both one-shot (`run`) and long-lived (`spawnLongLived`) children live in
  // here, which is the ONLY thing `killAll` ever iterates.
  const children = new Set<Bun.Subprocess<'ignore', 'pipe', 'pipe'>>()
  const longLived = new Set<Bun.Subprocess<'ignore', 'pipe', 'pipe'>>()

  /** Pushes a live settings change onto the semaphores without dropping anyone already queued or running (`Semaphore.resize`, plan 23 §4.2). */
  function syncLimits(): void {
    const cfg = deps.settings()
    if (cfg.maxHostConcurrent !== hostSem.max) hostSem.resize(Math.max(1, cfg.maxHostConcurrent))
    if (cfg.maxInstallConcurrent !== installSem.max) installSem.resize(Math.max(1, cfg.maxInstallConcurrent))
  }

  async function spawnAndDrain(args: string[], timeoutMs: number): Promise<string> {
    const proc = Bun.spawn([deps.binaryPath(), ...args], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
    children.add(proc)
    const stdoutBuf = createRingBuffer(MAX_TAIL_BYTES)
    const stderrBuf = createRingBuffer(MAX_TAIL_BYTES)
    const startedAt = Date.now()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      proc.kill()
    }, timeoutMs)
    try {
      // Both streams drained CONCURRENTLY, alongside `exited` — the F11 fix.
      // A sequential drain (stdout to completion, then stderr) can deadlock
      // outright: the OS pipe buffer is finite, and a process that fills
      // stderr while nobody is reading it blocks on the write, which blocks
      // the exit this function is waiting for.
      const [exitCode] = await Promise.all([
        proc.exited,
        drainStream(proc.stdout, (c) => stdoutBuf.push(c)),
        drainStream(proc.stderr, (c) => stderrBuf.push(c)),
      ])
      const elapsedS = ((Date.now() - startedAt) / 1000).toFixed(1)
      const stdoutText = stdoutBuf.text()
      const stderrText = stderrBuf.text()
      if (timedOut) {
        const message = `adb ${args.join(' ')} timed out after ${timeoutMs}ms (killed)\n  stdout: ${stdoutText.trim()}\n  stderr: ${stderrText.trim()}`
        log('warn', message)
        throw new HostAdbError('E_ADB_CLI_TIMEOUT', message, null, stdoutText, stderrText)
      }
      if (exitCode !== 0) {
        // The plan §4.5 error shape, verbatim: exit code, elapsed time, BOTH
        // tails. This is what makes a broken install report its real
        // `INSTALL_FAILED_*` reason instead of the useless
        // "exit 1: Performing Streamed Install" the field log showed.
        throw new HostAdbError(
          'E_ADB_CLI_FAIL',
          `adb ${args.join(' ')} exited ${exitCode} after ${elapsedS}s\n  stdout: ${stdoutText.trim()}\n  stderr: ${stderrText.trim()}`,
          exitCode,
          stdoutText,
          stderrText,
        )
      }
      return stdoutText
    } finally {
      clearTimeout(timer)
      children.delete(proc)
    }
  }

  async function runHostBound(args: string[], timeoutMs: number): Promise<string> {
    syncLimits()
    const release = await hostSem.acquire()
    try {
      return await spawnAndDrain(args, timeoutMs)
    } finally {
      release()
    }
  }

  return {
    async run(args, opts) {
      const lane = opts?.lane ?? 'default'
      const timeoutMs = opts?.timeoutMs ?? (lane === 'install' ? INSTALL_TIMEOUT_MS : DEFAULT_RUN_TIMEOUT_MS)
      if (lane === 'install') {
        if (!opts?.serial) {
          throw new EnkakuError('E_BAD_REQUEST', "hostAdb.run: opts.serial is required when opts.lane is 'install'")
        }
        // The per-device chain (H5's fix): even though `maxInstallConcurrent`
        // may allow several installs farm-wide, a single device only ever
        // sees one `pm install`/`pm uninstall` at a time — a fleet attaching
        // inspectors on 20 devices at once must not turn into 40 concurrent
        // installs, but it also must never let the SAME device race two
        // installs against each other.
        return installQueue.run(opts.serial, () => runHostBound(args, timeoutMs))
      }
      return runHostBound(args, timeoutMs)
    },

    spawnLongLived(args, opts) {
      // Deliberately NOT gated by `hostSem`/`adb.maxHostConcurrent`: that
      // budget bounds bursty, short-lived CLI processes (install/push/
      // forward — see its own `.describe()` in `packages/protocol/src/
      // settings.ts`), which is why it has no fleet-size autoscaler the way
      // `adb.maxStreams` does (plan 85 §4.2). A long-lived `adb shell`
      // running the scrcpy server lives for the whole session; holding a
      // farm-wide slot for that long would silently re-introduce the exact
      // "a cap sized for two devices" bug this plan exists to remove, just
      // one layer down. It is still tracked in `children` for `killAll`/
      // `stats().longLived`, and its own output is bounded the same way.
      const proc = Bun.spawn([deps.binaryPath(), ...args], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
      children.add(proc)
      longLived.add(proc)
      const tailBuf = createRingBuffer(MAX_TAIL_BYTES)
      // Unlike `spawnAndDrain`'s `run()` path, nobody awaits these two drains
      // directly — a stream error (as opposed to a clean close, e.g. an
      // abrupt SIGKILL tearing down the pipe) must not become an unhandled
      // rejection and take the whole core down with it.
      drainStream(proc.stdout, (c) => tailBuf.push(c)).catch(() => undefined)
      drainStream(proc.stderr, (c) => tailBuf.push(c)).catch(() => undefined)
      const exited = proc.exited.then((code) => {
        children.delete(proc)
        longLived.delete(proc)
        opts?.onExit?.(code, tailBuf.text())
        return code
      })
      return {
        pid: proc.pid ?? null,
        tail: () => tailBuf.text(),
        kill: () => {
          try {
            proc.kill()
          } catch {
            // already dead
          }
        },
        exited,
      }
    },

    killAll() {
      if (children.size === 0) return
      log('info', `killing ${children.size} adb CLI child process(es) still running`)
      for (const proc of children) {
        try {
          proc.kill()
        } catch {
          // already dead
        }
      }
    },

    stats() {
      return {
        running: hostSem.inFlight,
        maxConcurrent: hostSem.max,
        installsRunning: installSem.inFlight,
        longLived: longLived.size,
      }
    },
  }
}
