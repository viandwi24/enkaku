import { eq } from 'drizzle-orm'
import type { Db } from '../../db'
import { scripts, type JobRow } from '../../db/schema'
import type { JobRunner } from '@enkaku/session'
import { materializeBundle } from '../../scripts/bundle-cache'
import { EnkakuError } from '../../util/errors'
import type { ExecutorContext, JobExecutor } from '../executor'

/**
 * The real script executor (M4): delegates to JobRunner (a child
 * process plus IPC). It replaces the `internal:sleep` dummy as the main path;
 * dummy executor stays registered for exercising the queue without a device.
 *
 * Authoritative param validation happens IN THE CHILD (`def.params.parse` from
 * the bundle) — here the params are just passed straight through.
 */
export function createScriptExecutor(deps: { db: Db; dataDir: string; runner: JobRunner }): JobExecutor {
  return {
    validateParams(params) {
      return params ?? {}
    },

    async run(job: JobRow, ctx: ExecutorContext): Promise<unknown> {
      const script = deps.db.select().from(scripts).where(eq(scripts.id, job.scriptId)).get()
      if (!script) throw new EnkakuError('unknown_script', `no such script: ${job.scriptId}`)
      if (!script.enabled) throw new EnkakuError('script_disabled', `the script ${script.name} is disabled`)

      // A cancel from the core aborts the child (grace → SIGTERM → SIGKILL).
      ctx.signal.addEventListener('abort', () => deps.runner.abort(job.id, 'cancelled'))
      // A crash of a package the farm's crash policy cares about (plan 37
      // §3.5, §4.4) — a SEPARATE abort path from `signal` above, so it
      // settles as `APP_CRASHED` (script-class, never blames the device)
      // rather than as a plain cancel.
      ctx.onCrash?.((e) => deps.runner.abort(job.id, 'crashed', `${e.package} crashed: ${e.exception}`))

      // The bundle is materialised in the core (which has DB access); the runner only gets a path.
      const bundlePath = await materializeBundle(deps.dataDir, script)
      const result = await deps.runner.execute({
        id: job.id,
        deviceId: job.deviceId,
        bundlePath,
        params: job.params ?? {},
      })
      if (!result.ok) {
        const err = result.error ?? { code: 'SCRIPT_FAILED', message: 'the script failed', phase: 'run' }
        throw Object.assign(new EnkakuError(err.code, err.message), {
          code: err.code === 'CANCELLED' ? 'job_cancelled' : err.code,
        })
      }
      return result.value ?? null
    },
  }
}
