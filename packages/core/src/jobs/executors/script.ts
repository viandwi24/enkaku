import { eq } from 'drizzle-orm'
import type { Db } from '../../db'
import { scripts, type JobRow } from '../../db/schema'
import type { JobRunner } from '../../runner/job-runner'
import { EnkakuError } from '../../util/errors'
import type { ExecutorContext, JobExecutor } from '../executor'

/**
 * Executor script sungguhan (M4): mendelegasikan ke JobRunner (child
 * process + IPC). Menggantikan dummy `internal:sleep` sebagai jalur utama;
 * dummy tetap terdaftar untuk menguji queue tanpa device.
 *
 * Validasi params otoritatif terjadi DI CHILD (`def.params.parse` dari
 * bundle) — di sini params hanya diteruskan apa adanya.
 */
export function createScriptExecutor(deps: { db: Db; runner: JobRunner }): JobExecutor {
  return {
    validateParams(params) {
      return params ?? {}
    },

    async run(job: JobRow, ctx: ExecutorContext): Promise<unknown> {
      const script = deps.db.select().from(scripts).where(eq(scripts.id, job.scriptId)).get()
      if (!script) throw new EnkakuError('unknown_script', `script tidak ada: ${job.scriptId}`)
      if (!script.enabled) throw new EnkakuError('script_disabled', `script ${script.name} dinonaktifkan`)

      // Cancel dari core → abort child (grace → SIGTERM → SIGKILL).
      ctx.signal.addEventListener('abort', () => deps.runner.abort(job.id, 'cancelled'))

      const result = await deps.runner.execute(job)
      if (!result.ok) {
        const err = result.error ?? { code: 'SCRIPT_FAILED', message: 'script gagal', phase: 'run' }
        throw Object.assign(new EnkakuError(err.code, err.message), {
          code: err.code === 'CANCELLED' ? 'job_cancelled' : err.code,
        })
      }
      return result.value ?? null
    },
  }
}
