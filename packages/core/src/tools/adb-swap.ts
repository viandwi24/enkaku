import type { AdbClient } from '@enkaku/adb'
import type { AdbSwapHook } from '@enkaku/toolchain'
import { ToolchainError } from '@enkaku/toolchain'
import type { Logger } from '../util/logger'

export interface AdbSwapDeps {
  getClient: () => AdbClient | null
  /** Stop/start stream track-devices selama swap. */
  stopTracker: () => Promise<void>
  startTracker: () => Promise<void>
  /** Drain session/lease hidup — no-op di M1, diisi Plan 04 (M3). */
  drainSessions?: () => Promise<void>
  log: Logger
  drainTimeoutMs?: number
}

/**
 * Koordinator swap versi adb (plan 02 §4.11).
 * SATU-SATUNYA call site `adb kill-server` di seluruh codebase (spec §10.4):
 * drain (pause queue → tunggu in-flight → stop tracker) → kill-server binary
 * lama → commit pointer → start-server binary baru → resume.
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
          throw new ToolchainError('E_TOOL_IN_USE', `drain adb melewati timeout ${drainTimeoutMs}ms — swap dibatalkan`)
        }
        await deps.drainSessions?.() // no-op di M1, diisi Plan 04
        await deps.stopTracker()
      }

      try {
        // 2. kill-server dengan binary LAMA (call site tunggal se-codebase)
        if (oldBinaryPath) {
          log.info('adb swap: kill-server (binary lama)')
          const kill = Bun.spawn([oldBinaryPath, 'kill-server'], { stdout: 'ignore', stderr: 'ignore' })
          await kill.exited
        }

        // 3. commit pointer + DB (dari ToolchainManager)
        await commit()

        // 4. start-server dengan binary BARU
        log.info('adb swap: start-server (binary baru)')
        const start = Bun.spawn([newBinaryPath, 'start-server'], { stdout: 'ignore', stderr: 'ignore' })
        const exit = await start.exited
        if (exit !== 0) {
          // Jaga sistem tetap hidup: nyalakan kembali server dengan binary
          // lama sebelum melempar error (pointer di-rollback oleh caller
          // yang menerima error ini — lihat ToolchainManager.activate).
          if (oldBinaryPath) {
            log.warn('adb swap: start-server baru gagal — menyalakan kembali server binary lama')
            await Bun.spawn([oldBinaryPath, 'start-server'], { stdout: 'ignore', stderr: 'ignore' }).exited
          }
          throw new ToolchainError('E_HEALTH_CHECK_FAILED', `adb start-server binary baru exit ${exit}`)
        }
        client?.setAdbPath(newBinaryPath)
      } finally {
        // 5. resume — apa pun hasilnya, sistem harus kembali hidup
        if (client) {
          await deps.startTracker().catch((err) => log.warn(`adb swap: tracker gagal start ulang: ${String(err)}`))
          client.resumeQueue()
        }
      }
    },
  }
}
