import { PushJobParamsSchema } from '@enkaku/protocol'
import type { JobRow } from '../../db/schema'
import type { TransferService } from '../../device/transfer'
import { runTransfer, type TransferBroadcast } from '../../device/transfer-dispatch'
import { EnkakuError } from '../../util/errors'
import type { ExecutorContext, JobExecutor } from '../executor'

/**
 * `internal:push` (plan 93 §4.6, §5 step 93.9) — a near-copy of
 * `createInstallExecutor` (`jobs/executors/install.ts`): a batch push across
 * a cluster reuses the SAME concurrency/ordering/reporting/cancel machinery,
 * with no new orchestration. `requires: { gate: 'files', setting:
 * 'transfer.enabled' }` closes the same F10 gap `internal:install` closes
 * (plan 93 §3.12, step 93.8) — a batch/schedule dispatch of `internal:push`
 * is gated exactly like the REST `POST /:id/push` sibling.
 */
export function createPushExecutor(deps: { transfer: TransferService; broadcast: TransferBroadcast }): JobExecutor {
  return {
    requires: { gate: 'files', setting: 'transfer.enabled' },

    validateParams(params) {
      const parsed = PushJobParamsSchema.safeParse(params)
      if (!parsed.success) {
        throw new EnkakuError('invalid_job_params', parsed.error.issues.map((i) => i.message).join('; '))
      }
      return parsed.data
    },

    run(job: JobRow, ctx: ExecutorContext): Promise<unknown> {
      const params = PushJobParamsSchema.parse(job.params)
      return runTransfer({
        transfer: deps.transfer,
        broadcast: deps.broadcast,
        deviceId: job.deviceId,
        kind: 'push',
        signal: ctx.signal,
        op: (transferId, onProgress) =>
          deps.transfer.push(job.deviceId, params.artifactId, params.remotePath, {
            transferId,
            onProgress,
            ...(params.mediaScan !== undefined ? { mediaScan: params.mediaScan } : {}),
          }),
      })
    },
  }
}
