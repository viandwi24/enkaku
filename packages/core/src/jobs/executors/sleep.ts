import { SleepJobParamsSchema } from '@enkaku/protocol'
import type { JobRow } from '../../db/schema'
import { EnkakuError } from '../../util/errors'
import type { ExecutorContext, JobExecutor } from '../executor'

/**
 * The `internal:sleep` dummy executor (plan 04 §4.5) — exercises the whole
 * queue and lease without touching adb at all. Plan 05 replaces it with the
 * subprocess runner, but it stays useful for queue testing.
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
        // ignoreCancel makes a "stubborn" job — the reaper and lease-expiry settle it.
        if (params.ignoreCancel) {
          ctx.log.warn(`job ${job.id} is ignoring the cancel (ignoreCancel) — waiting for lease expiry`)
          return
        }
        cleanup()
        reject(new EnkakuError('job_cancelled', 'the job was cancelled'))
      }
      ctx.signal.addEventListener('abort', onAbort)

      if (params.failAfterMs !== undefined) {
        timers.push(
          setTimeout(() => {
            cleanup()
            reject(new EnkakuError('job_failed_simulated', `simulated failure after ${params.failAfterMs}ms`))
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
