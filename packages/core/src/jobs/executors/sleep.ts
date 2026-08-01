import { SleepJobParamsSchema } from '@enkaku/protocol'
import type { JobRow } from '../../db/schema'
import { EnkakuError } from '../../util/errors'
import type { ExecutorContext, JobExecutor } from '../executor'

/**
 * Dummy executor `internal:sleep` (plan 04 §4.5) — memvalidasi seluruh alur
 * queue/lease tanpa menyentuh adb sama sekali. Diganti runner subprocess
 * di Plan 05, tapi tetap berguna untuk tes queue.
 */
export const sleepExecutor: JobExecutor = {
  validateParams(params) {
    const parsed = SleepJobParamsSchema.safeParse(params)
    if (!parsed.success) {
      throw new EnkakuError('invalid_job_params', parsed.error.issues.map((i) => i.message).join('; '))
    }
    return parsed.data
  },

  run(job: JobRow, ctx: ExecutorContext): Promise<unknown> {
    const params = SleepJobParamsSchema.parse(job.params)
    return new Promise((resolve, reject) => {
      const timers: Array<ReturnType<typeof setTimeout>> = []
      const cleanup = () => {
        for (const t of timers) clearTimeout(t)
        ctx.signal.removeEventListener('abort', onAbort)
      }
      function onAbort() {
        // ignoreCancel: job "bandel" — reaper/lease-expiry yang menyelesaikan.
        if (params.ignoreCancel) {
          ctx.log.warn(`job ${job.id} mengabaikan cancel (ignoreCancel) — menunggu lease expiry`)
          return
        }
        cleanup()
        reject(new EnkakuError('job_cancelled', 'job dibatalkan'))
      }
      ctx.signal.addEventListener('abort', onAbort)

      if (params.failAfterMs !== undefined) {
        timers.push(
          setTimeout(() => {
            cleanup()
            reject(new EnkakuError('job_failed_simulated', `gagal disimulasikan setelah ${params.failAfterMs}ms`))
          }, params.failAfterMs),
        )
      }
      timers.push(
        setTimeout(() => {
          cleanup()
          resolve({ slept: params.durationMs })
        }, params.durationMs),
      )
    })
  },
}
