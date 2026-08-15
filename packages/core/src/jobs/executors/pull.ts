import { PullJobParamsSchema } from '@enkaku/protocol'
import type { JobRow } from '../../db/schema'
import type { TransferService } from '../../device/transfer'
import { runTransfer, type TransferBroadcast } from '../../device/transfer-dispatch'
import { EnkakuError } from '../../util/errors'
import type { ExecutorContext, JobExecutor } from '../executor'

/**
 * `internal:pull` (plan 93 §3.13, §4.6, §5 step 93.9) — a near-copy of
 * `createInstallExecutor`/`createPushExecutor`. Closes F12: `job.id` is
 * threaded into `TransferService.pull`'s `TransferOpts.jobId`, so
 * `registerDeviceArtifact` stamps the pulling job's id onto the artifact
 * instead of `null`, and a bulk pull's files are traceable back to the
 * batch that produced them (§3.13 point 1, `artifacts`'s own `(jobId,
 * createdAt)` index).
 */
export function createPullExecutor(deps: { transfer: TransferService; broadcast: TransferBroadcast }): JobExecutor {
  return {
    requires: { gate: 'files', setting: 'transfer.enabled' },

    validateParams(params) {
      const parsed = PullJobParamsSchema.safeParse(params)
      if (!parsed.success) {
        throw new EnkakuError('invalid_job_params', parsed.error.issues.map((i) => i.message).join('; '))
      }
      return parsed.data
    },

    run(job: JobRow, ctx: ExecutorContext): Promise<unknown> {
      const params = PullJobParamsSchema.parse(job.params)
      return runTransfer({
        transfer: deps.transfer,
        broadcast: deps.broadcast,
        deviceId: job.deviceId,
        kind: 'pull',
        signal: ctx.signal,
        op: (transferId, onProgress) => deps.transfer.pull(job.deviceId, params.remotePath, { transferId, onProgress, jobId: job.id }),
      })
    },
  }
}
