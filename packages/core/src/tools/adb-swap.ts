import type { AdbClient } from '@enkaku/adb'
import type { AdbSwapHook } from '@enkaku/toolchain'
import { ToolchainError } from '@enkaku/toolchain'
import type { Logger } from '../util/logger'

export interface AdbSwapDeps {
  getClient: () => AdbClient | null
  /** Stop and restart the track-devices stream around the swap. */
  stopTracker: () => Promise<void>
  startTracker: () => Promise<void>
  /** Drain live sessions and leases — a no-op in M1, filled in by Plan 04 (M3). */
  drainSessions?: () => Promise<void>
  log: Logger
  drainTimeoutMs?: number
}

/**
 * Koordinator swap versi adb (plan 02 §4.11).
 * The ONLY `adb kill-server` call site in the entire codebase (spec §10.4):
 * drain (pause queue → tunggu in-flight → stop tracker) → kill-server binary
 * binary → commit the pointer → start-server on the new binary → resume.
 */
export function createAdbSwapCoordinator(deps: AdbSwapDeps): AdbSwapHook {
  const drainTimeoutMs = deps.drainTimeoutMs ?? 30_000

  return {
    async swap(oldBinaryPath, newBinaryPath, commit) {
      const client = deps.getClient()
      const log = deps.log

      // 1. drain
      if (client) {
        log.info('adb swap: drain — pause queue, tunggu command in-flight')
        client.pauseQueue()
        const idle = await client.waitQueueIdle(drainTimeoutMs)
        if (!idle) {
          client.resumeQueue()
          throw new ToolchainError('E_TOOL_IN_USE', `the adb drain exceeded ${drainTimeoutMs}ms — swap cancelled`)
        }
        await deps.drainSessions?.() // no-op di M1, diisi Plan 04
        await deps.stopTracker()
      }

      try {
        // 2. kill-server with the OLD binary (the single call site in the codebase)
        if (oldBinaryPath) {
          log.info('adb swap: kill-server (old binary)')
          const kill = Bun.spawn([oldBinaryPath, 'kill-server'], { stdout: 'ignore', stderr: 'ignore' })
          await kill.exited
        }

        // 3. commit the pointer and DB (from ToolchainManager)
        await commit()

        // 4. start-server with the NEW binary
        log.info('adb swap: start-server (new binary)')
        const start = Bun.spawn([newBinaryPath, 'start-server'], { stdout: 'ignore', stderr: 'ignore' })
        const exit = await start.exited
        if (exit !== 0) {
          // Keep the system alive: bring the server back up on the old binary
          // before throwing (the pointer is rolled back by whoever catches this
          // error — see ToolchainManager.activate).
          if (oldBinaryPath) {
            log.warn('adb swap: the new start-server failed — bringing the old binary back up')
            await Bun.spawn([oldBinaryPath, 'start-server'], { stdout: 'ignore', stderr: 'ignore' }).exited
          }
          throw new ToolchainError('E_HEALTH_CHECK_FAILED', `adb start-server on the new binary exited ${exit}`)
        }
        client?.setAdbPath(newBinaryPath)
      } finally {
        // 5. resume — whatever happened, the system has to come back up
        if (client) {
          await deps.startTracker().catch((err) => log.warn(`adb swap: the tracker failed to restart: ${String(err)}`))
          client.resumeQueue()
        }
      }
    },
  }
}
