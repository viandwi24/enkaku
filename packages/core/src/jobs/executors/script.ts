import type { JobRunner } from '@enkaku/session'
import type { JobRow } from '../../db/schema'
import { findShadowedPublished, type ScriptRegistry } from '../../scripts/registry'
import { EnkakuError } from '../../util/errors'
import type { ExecutorContext, JobExecutor } from '../executor'

/**
 * The real script executor (M4): delegates to JobRunner (a child
 * process plus IPC). It replaces the `internal:sleep` dummy as the main path;
 * dummy executor stays registered for exercising the queue without a device.
 *
 * Authoritative param validation happens IN THE CHILD (`def.params.parse` from
 * the bundle) — here the params are just passed straight through.
 *
 * Plan 82 §3.3: reads the script through the `ScriptRegistry` rather than the
 * `scripts` table directly — `job.scriptId` can be a persisted row's id
 * (standalone or a published plugin member) OR a dev entry's id
 * (`dev:<plugin>/<script>`, which has no row at all). The registry is also
 * what supplies `exportId` — the plugin bundle's own member id — which is
 * what actually lets `child-entry.ts` select the right script out of a
 * shared bundle (§3.2, criterion 3); before this, only the bundle bytes were
 * threaded through, never which member to run.
 */
export function createScriptExecutor(deps: { registry: ScriptRegistry; runner: JobRunner }): JobExecutor {
  return {
    validateParams(params) {
      return params ?? {}
    },

    async run(job: JobRow, ctx: ExecutorContext): Promise<unknown> {
      const entry = deps.registry.get(job.scriptId)
      if (!entry) throw new EnkakuError('unknown_script', `no such script: ${job.scriptId}`)
      if (!entry.enabled) throw new EnkakuError('script_disabled', `the script ${entry.name} is disabled`)

      // A dev entry never shadows a published one silently (plan 82 §3.5) —
      // logged on the very first line of the job's own log, before anything
      // else this run does.
      const shadowed = findShadowedPublished(deps.registry, entry)
      if (shadowed) {
        ctx.log.info(
          `running the DEV build of "${entry.name}" (${entry.version}, owned by ${entry.devOwner ?? 'a dev session'}) — this shadows the published "${shadowed.name}@${shadowed.version}"`,
        )
      }

      // A cancel from the core aborts the child (grace → SIGTERM → SIGKILL).
      ctx.signal.addEventListener('abort', () => deps.runner.abort(job.id, 'cancelled'))
      // A crash of a package the farm's crash policy cares about (plan 37
      // §3.5, §4.4) — a SEPARATE abort path from `signal` above, so it
      // settles as `APP_CRASHED` (script-class, never blames the device)
      // rather than as a plain cancel.
      ctx.onCrash?.((e) => deps.runner.abort(job.id, 'crashed', `${e.package} crashed: ${e.exception}`))

      // The bundle is materialised in the core (which has DB access); the runner only gets a path.
      const bundlePath = await deps.registry.bundlePath(entry)
      const result = await deps.runner.execute({
        id: job.id,
        deviceId: job.deviceId,
        bundlePath,
        params: job.params ?? {},
        // Undefined for a standalone script (no `scripts` array in its
        // bundle, `exportId` is null) — `child-entry.ts` then takes the
        // pre-plan-82 branch unchanged (criterion 27).
        ...(entry.exportId ? { scriptExportId: entry.exportId } : {}),
      })
      if (!result.ok) {
        const err = result.error ?? { code: 'SCRIPT_FAILED', message: 'the script failed', phase: 'run' }
        throw Object.assign(new EnkakuError(err.code, err.message), {
          code: err.code === 'CANCELLED' ? 'job_cancelled' : err.code,
          // The runner has always known which phase failed and this boundary
          // used to drop it (plan 60 §3.4), which is why "why did this fail"
          // could only be answered by opening the log.
          phase: err.phase,
        })
      }
      return result.value ?? null
    },
  }
}
