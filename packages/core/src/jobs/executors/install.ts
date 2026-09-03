import { InstallJobParamsSchema } from '@enkaku/protocol'
import type { JobRow } from '../../db/schema'
import type { TransferService } from '../../device/transfer'
import { runTransfer, type TransferBroadcast } from '../../device/transfer-dispatch'
import { EnkakuError } from '../../util/errors'
import type { ExecutorContext, JobExecutor } from '../executor'

/**
 * `internal:install` (plan 39 §4.5) — registered in the `ExecutorRegistry`
 * beside `internal:sleep`, so a batch install across a cluster reuses plan
 * 20's concurrency, ordering, reporting, and cancel with NO new
 * orchestration: the batch machinery already runs one job per target
 * device and already holds a job heartbeat per device; this executor's only job
 * is to turn `{ artifactId }` into one `TransferService.install` call and
 * honour `ctx.signal` the same way any other executor does.
 */
export function createInstallExecutor(deps: { transfer: TransferService; broadcast: TransferBroadcast }): JobExecutor {
  return {
    // Plan 93 §3.12, §4.6, step 93.8 — closes F10: a batch/schedule dispatch
    // of `internal:install` used to require only `job.run`, no `device.files`
    // and no `transfer.enabled`, unlike the REST `POST /:id/install` sibling
    // (`api/transfer.ts`'s `authorize`), which requires both. Enforced by
    // `jobs/validate-script.ts`'s `validateScriptForRun`, the one function
    // every dispatch path already funnels through.
    requires: { gate: 'files', setting: 'transfer.enabled' },

    validateParams(params) {
      const parsed = InstallJobParamsSchema.safeParse(params)
      if (!parsed.success) {
        throw new EnkakuError('invalid_job_params', parsed.error.issues.map((i) => i.message).join('; '))
      }
      return parsed.data
    },

    run(job: JobRow, ctx: ExecutorContext): Promise<unknown> {
      const params = InstallJobParamsSchema.parse(job.params)
      return runTransfer({
        transfer: deps.transfer,
        broadcast: deps.broadcast,
        deviceId: job.deviceId,
        kind: 'install',
        signal: ctx.signal,
        op: (transferId, onProgress) =>
          deps.transfer.install(job.deviceId, params.artifactId, {
            transferId,
            onProgress,
            ...(params.reinstall !== undefined ? { reinstall: params.reinstall } : {}),
            ...(params.grantPermissions !== undefined ? { grantPermissions: params.grantPermissions } : {}),
            ...(params.allowDowngrade !== undefined ? { allowDowngrade: params.allowDowngrade } : {}),
          }),
      })
    },
  }
}
