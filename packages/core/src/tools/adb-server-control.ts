import type { AdbClient } from '@enkaku/adb'
import type { AdbServerPhase } from '@enkaku/protocol'
import { ToolchainError } from '@enkaku/toolchain'
import type { Logger } from '../util/logger'

export type { AdbServerPhase }

/** What the drain actually stopped, for the report (plan 88 §3.10, §4.8 — "the drain finally includes sessions"). */
export interface DrainResult {
  sessionsClosed: number
  leasesReleased: number
  /** Job ids force-failed because the drain proceeded with them still running (only non-empty when the caller bypassed its own busy-farm guard with `force`). */
  jobsFailed: string[]
}

/** What came back after the server restarted, for the report. */
export interface ReattachResult {
  attempted: number
  succeeded: number
  /**
   * `number` travels beside `label`, never composed into it (plan 124 §3.1,
   * §3.7 and §10's `MirrorMember` note): `AdbRestartDialog` is the one place
   * this list is rendered and it composes exactly once, so a pre-baked
   * `#7 …` here would double up the moment that dialog also holds a
   * `DeviceInfo`. `null` for a device whose reservation was released.
   */
  failed: Array<{ stableId: string; label: string; number: number | null }>
}

export interface AdbCycleReport {
  reason: 'swap' | 'restart'
  durationMs: number
  sessionsClosed: number
  leasesReleased: number
  jobsFailed: string[]
  devicesBefore: number
  devicesAfter: number
  reattachAttempted: number
  reattachSucceeded: number
  reattachFailed: Array<{ stableId: string; label: string; number: number | null }>
  serverVersion: string | null
}

export interface AdbCycleOpts {
  reason: 'swap' | 'restart'
  /** `null` for a fresh install with nothing to kill yet (mirrors `adb-swap.ts`'s own `oldBinaryPath` contract). For a plain restart this is the SAME path as `newBinaryPath` — there is no version change, only a stop/start. */
  oldBinaryPath: string | null
  newBinaryPath: string
  /** Persist the new active version pointer — supplied ONLY by a version swap. A restart never touches which version is active. */
  commit?: () => Promise<void>
  /**
   * The caller already decided to proceed despite running jobs / held leases
   * (its own `E_ADB_BUSY_FARM` guard, ahead of ever calling `cycle()`) —
   * threaded through to `drainSessions` so it, not `cycle()` itself, decides
   * whether a still-running job gets force-failed. `cycle()` never inspects
   * this value itself; sessions and leases are always drained regardless,
   * `force` only changes whether a running JOB is torn down too.
   */
  force?: boolean
}

export interface AdbServerControlDeps {
  getClient: () => AdbClient | null
  /** Stop and restart the track-devices stream around the cycle (same shape `adb-swap.ts` already used). */
  stopTracker: () => Promise<void>
  startTracker: () => Promise<void>
  /**
   * Drain live sessions, leases, and (if the caller proceeded despite them)
   * running jobs BEFORE the server is killed. F19: this was an unwired
   * optional dep since M1 — every caller of `cycle()` now gets a real drain,
   * not a no-op comment.
   */
  drainSessions?: (opts: { force: boolean }) => Promise<DrainResult>
  /**
   * Dial every remembered network address back up once the server is
   * running again (plan 88 §3.2, §3.10) — after a stop, adb's transport
   * table is empty and it will not go looking (F10). Omitted only in a
   * context with no address book at all (e.g. a test harness); the real
   * daemon always supplies this.
   */
  reattachEndpoints?: () => Promise<ReattachResult>
  /** One reconcile pass after reattach, so anything that came back is adopted immediately rather than waiting for the next scheduled pass. */
  reconcileOnce?: () => Promise<void>
  /** Broadcast a phase transition (`adb.server.phase`) — one event per phase, so twenty devices dropping together reads as one banner. */
  onPhase?: (phase: AdbServerPhase, reason: 'swap' | 'restart', detail: string) => void
  log: Logger
  /** How long the drain waits for in-flight adb work to settle before refusing (`E_TOOL_IN_USE`). Read fresh on every call — mirrors every other "settings, read live" dep in this codebase. */
  drainTimeoutMs?: () => number
  /**
   * Runs `<binaryPath> <args>` and waits for exit — `kill-server`/`start-server`
   * on the adb binary itself. Injectable (same "prove it against a fake,
   * never a real ___" rule `reconnect.ts`'s `tcpPreProbe` and
   * `adb-health.ts`'s `probeVersion` already follow) so a test never
   * actually spawns a process. Defaults to a real `Bun.spawn`.
   */
  spawnAdb?: (binaryPath: string, args: string[]) => Promise<{ exitCode: number }>
}

export interface AdbServerControl {
  /**
   * The ONLY function in this workspace that stops the adb server (plan 88
   * §3.10, spec §10.4). Two entry points, one implementation, one mutex:
   *   - the Toolchain Manager's adb version swap (`commit` supplied);
   *   - the operator's "Restart adb server" on the Tools page (`commit` absent).
   *
   * Seven steps, always in this order: drain (queue, then sessions/leases/
   * jobs) → stop the old binary → [swap the binary pointer] → start the new
   * binary → restart the tracker → resume the queue → reattach remembered
   * network addresses → reconcile once. A failed `start-server` brings the
   * OLD binary back up before rethrowing (F18's rollback, preserved
   * verbatim) — the farm is never left with no adb server at all.
   */
  cycle(opts: AdbCycleOpts): Promise<AdbCycleReport>
  /** Whether a cycle is currently running — a version swap and a restart can never interleave. */
  busy(): boolean
}

const DEFAULT_DRAIN_TIMEOUT_MS = 30_000

/** `AdbClient.listDevices()`, but tolerant of a client that is mid-restart or briefly unreachable — used only for the report's before/after counts, never to decide anything. */
async function countOnline(client: AdbClient): Promise<number> {
  const list = await client.listDevices().catch(() => [])
  return list.filter((d) => d.state === 'device').length
}

const defaultSpawnAdb: NonNullable<AdbServerControlDeps['spawnAdb']> = async (binaryPath, args) => {
  const proc = Bun.spawn([binaryPath, ...args], { stdout: 'ignore', stderr: 'ignore' })
  const exitCode = await proc.exited
  return { exitCode }
}

export function createAdbServerControl(deps: AdbServerControlDeps): AdbServerControl {
  const spawnAdb = deps.spawnAdb ?? defaultSpawnAdb
  let inFlight: Promise<AdbCycleReport> | null = null

  async function cycleImpl(opts: AdbCycleOpts): Promise<AdbCycleReport> {
    const started = Date.now()
    const client = deps.getClient()
    const log = deps.log
    const drainTimeoutMs = deps.drainTimeoutMs?.() ?? DEFAULT_DRAIN_TIMEOUT_MS

    const emit = (phase: AdbServerPhase, detail: string): void => {
      deps.onPhase?.(phase, opts.reason, detail)
      log.info(`adb ${opts.reason}: ${phase}${detail ? ` — ${detail}` : ''}`)
    }

    const devicesBefore = client ? await countOnline(client) : 0

    let sessionsClosed = 0
    let leasesReleased = 0
    let jobsFailed: string[] = []

    if (client) {
      // 1. Drain the adb queue itself first — nothing below matters if a
      // command is still in flight when the server dies underneath it.
      emit('draining', 'pausing the adb queue')
      client.pauseQueue()
      const idle = await client.waitQueueIdle(drainTimeoutMs)
      if (!idle) {
        client.resumeQueue()
        throw new ToolchainError('E_TOOL_IN_USE', `the adb drain exceeded ${drainTimeoutMs}ms — ${opts.reason} cancelled`)
      }
      // Sessions, leases, and (if the caller's own busy-farm guard was
      // bypassed) running jobs — F19's fix. Every live wall tile and manual
      // hold is released BEFORE the transport table is thrown away, instead
      // of being silently orphaned by it.
      if (deps.drainSessions) {
        const result = await deps.drainSessions({ force: Boolean(opts.force) })
        sessionsClosed = result.sessionsClosed
        leasesReleased = result.leasesReleased
        jobsFailed = result.jobsFailed
      }
      await deps.stopTracker()
    }

    let serverVersion: string | null = null
    try {
      // 2. Stop the old binary — the single `kill-server` call site in the
      // workspace (spec §10.4, plan 88 §3.10).
      if (opts.oldBinaryPath) {
        emit('stopping', 'kill-server (old binary)')
        await spawnAdb(opts.oldBinaryPath, ['kill-server'])
      } else {
        emit('stopping', 'no prior binary to stop')
      }

      // 3. Swap the binary pointer — ONLY for a version swap.
      if (opts.commit) {
        emit('swapping', 'committing the new binary pointer')
        await opts.commit()
      }

      // 4. Start the new binary.
      emit('starting', 'start-server')
      const { exitCode } = await spawnAdb(opts.newBinaryPath, ['start-server'])
      if (exitCode !== 0) {
        // Keep the system alive: bring the old binary back up before
        // throwing (F18's rollback, verbatim — the pointer itself is rolled
        // back by whoever catches this, e.g. `ToolchainManager.activate`).
        if (opts.oldBinaryPath) {
          log.warn(`adb ${opts.reason}: the new start-server failed — bringing the old binary back up`)
          await spawnAdb(opts.oldBinaryPath, ['start-server'])
        }
        throw new ToolchainError('E_HEALTH_CHECK_FAILED', `adb start-server on the new binary exited ${exitCode}`)
      }
      client?.setAdbPath(opts.newBinaryPath)
      serverVersion = client ? await client.version().catch(() => null) : null
    } finally {
      // 5 & 6. Restart the tracker, resume the queue — whatever happened
      // above, the system has to come back up (mirrors `adb-swap.ts`'s own
      // `finally`).
      if (client) {
        await deps.startTracker().catch((err) => log.warn(`adb ${opts.reason}: the tracker failed to restart: ${String(err)}`))
        client.resumeQueue()
      }
    }

    // 7. Reattach every remembered network address — without this, a TCP
    // device is simply gone: adb's transport table is empty after a stop
    // and it will not go looking (F10). This is why the OTG address book
    // and the restart button are one plan (plan 88 §3.10).
    let reattachAttempted = 0
    let reattachSucceeded = 0
    let reattachFailed: Array<{ stableId: string; label: string; number: number | null }> = []
    if (client && deps.reattachEndpoints) {
      emit('reattaching', 'dialling remembered network addresses')
      const r = await deps.reattachEndpoints()
      reattachAttempted = r.attempted
      reattachSucceeded = r.succeeded
      reattachFailed = r.failed
    }

    // 8. One reconcile pass — anything that came back (USB hotplug, a
    // successful reattach) is adopted now instead of waiting for the next
    // scheduled pass.
    if (client && deps.reconcileOnce) {
      emit('reconciling', 'one reconcile pass')
      await deps.reconcileOnce().catch((err) => log.warn(`adb ${opts.reason}: post-${opts.reason} reconcile failed, the periodic scan will retry: ${String(err)}`))
    }

    const devicesAfter = client ? await countOnline(client) : 0
    emit('done', `${devicesAfter}/${devicesBefore} device(s) back online`)

    return {
      reason: opts.reason,
      durationMs: Date.now() - started,
      sessionsClosed,
      leasesReleased,
      jobsFailed,
      devicesBefore,
      devicesAfter,
      reattachAttempted,
      reattachSucceeded,
      reattachFailed,
      serverVersion,
    }
  }

  return {
    async cycle(opts) {
      if (inFlight) throw new ToolchainError('E_TOOL_IN_USE', 'an adb swap or restart is already in progress')
      const run = cycleImpl(opts).catch((err) => {
        deps.onPhase?.('failed', opts.reason, err instanceof Error ? err.message : String(err))
        throw err
      })
      inFlight = run
      try {
        return await run
      } finally {
        if (inFlight === run) inFlight = null
      }
    },
    busy: () => inFlight !== null,
  }
}
