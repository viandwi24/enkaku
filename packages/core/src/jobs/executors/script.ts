import type { JobRunner } from '@enkaku/session'
import { validateAgainstSchema } from '@enkaku/protocol'
import type { JobRow } from '../../db/schema'
import { parseJobRuntimeOverride } from '../../queue/job-store'
import { findShadowedPublished, type ScriptRegistry } from '../../scripts/registry'
import { EnkakuError } from '../../util/errors'
import type { ExecutorContext, JobExecutor } from '../executor'

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * `ScriptEntry.paramsSchema` is `unknown` (it crosses the DB boundary as a
 * raw JSON column — F7) — narrows it to the loose `{[key: string]: unknown}`
 * shape `validateAgainstSchema` expects, with a type guard rather than a cast. Not
 * `null`/an array/a primitive → `undefined`, which `validateAgainstSchema` already
 * treats as "no schema, nothing to violate".
 */
function asSchemaNode(value: unknown): Record<string, unknown> | undefined {
  return isPlainObject(value) ? value : undefined
}

/**
 * The real script executor (M4): delegates to JobRunner (a child
 * process plus IPC). It replaces the `internal:sleep` dummy as the main path;
 * dummy executor stays registered for exercising the queue without a device.
 *
 * Authoritative STRUCTURAL param validation now happens HERE too, at enqueue
 * (plan 95 §3.7, §5 step 95.6, fixes F10) — against the SAME published
 * `paramsSchema` the run form reads, through the one shared validator in
 * `@enkaku/protocol`. The child still parses with the real, live Zod schema
 * (`def.params.parse`) and is still the only place a `.refine()`/
 * `.superRefine()` constraint is enforced (§3.6) — but every representable
 * constraint (types, bounds, enums, required, ordered ranges) now fails
 * BEFORE a device is leased instead of after, because `validateScriptForRun`
 * (`jobs/validate-script.ts`) calls this before the job row is written and
 * `createBatch` (`clusters/dispatch.ts`) calls it before resolving targets.
 *
 * Plan 82 §3.3: reads the script through the `ScriptRegistry` rather than the
 * `scripts` table directly — `job.scriptId` can be a persisted row's id
 * (a published plugin member) OR a dev entry's id
 * (`dev:<plugin>/<script>`, which has no row at all). The registry is also
 * what supplies `exportId` — the plugin bundle's own member id — which is
 * what actually lets `child-entry.ts` select the right script out of a
 * shared bundle (§3.2, criterion 3); before this, only the bundle bytes were
 * threaded through, never which member to run.
 */
export function createScriptExecutor(deps: { registry: ScriptRegistry; runner: JobRunner }): JobExecutor {
  return {
    validateParams(params, scriptId) {
      const entry = deps.registry.get(scriptId)
      if (!entry) throw new EnkakuError('unknown_script', `no such script: ${scriptId}`)
      const result = validateAgainstSchema(asSchemaNode(entry.paramsSchema), params)
      if (!result.ok) {
        throw new EnkakuError(
          'invalid_job_params',
          result.issues.map((i) => `${i.path}: ${i.message}`).join('; '),
          undefined,
          result.issues,
        )
      }
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
      // A human sent input to this job's device while it was running (plan 91
      // §3.6, §4.8) — NOT an abort, forwarded to the child so a script that
      // registered `ctx.onAssist` can react; one that never did is unaffected.
      ctx.onAssist?.((e) => deps.runner.notifyAssist(job.id, e))

      // The bundle is materialised in the core (which has DB access); the runner only gets a path.
      const bundlePath = await deps.registry.bundlePath(entry)
      const result = await deps.runner.execute({
        id: job.id,
        deviceId: job.deviceId,
        bundlePath,
        params: job.params ?? {},
        // Undefined only for a bundle with no `scripts` array of its own
        // (`exportId` is null) — `child-entry.ts` then takes the
        // pre-plan-82 branch unchanged (criterion 27).
        ...(entry.exportId ? { scriptExportId: entry.exportId } : {}),
        // Plan 98 §3.1, §4.4, §5 step 98.4 — the script's own declared
        // envelope, pinned at the moment this entry was resolved (the
        // registry read it straight off the row/dev-slot, never re-resolved
        // — spec §11.6). Always passed, even when `null` (a pre-plan-98
        // script, or a dev slot that declared nothing): the runner
        // distinguishes "the host told me there is no declaration" (`null`)
        // from "the host never wired this at all" (`undefined`, only ever
        // true in a caller that has not been updated — see `JobSpec.runtime`'s
        // own doc comment in `@enkaku/session`).
        runtime: entry.runtime,
        // Plan 98 §3.8, §4.4, step 98.7 — the operator's own per-job layer,
        // pinned onto `jobs.runtime_override` at enqueue (`services/job-service.ts`)
        // and read back here off the SAME `JobRow` this executor already
        // holds — never re-validated against the farm ceiling again (that
        // already happened once, at enqueue; a job that was valid then stays
        // valid for its own lifetime, the same "pinned, not re-checked"
        // shape `job.scriptId`/`job.runtime` both already have). `null` for
        // every job enqueued with no override, and for every job that
        // predates this column.
        runtimeOverride: parseJobRuntimeOverride(job.runtimeOverride),
      })
      // Plan 98 §4.8, H1 — reported here, BEFORE the ok/fail branch below, so
      // a peak is recorded whether the job succeeded or failed (acceptance:
      // every job that ran a child gets a peak, not only successful ones).
      if (result.peakRssBytes !== undefined) ctx.onPeakRss?.(result.peakRssBytes)
      // Plan 97 §3.3, §3.4, §3.8, §4.5, §5 step 97.4 — the child's own
      // verdict, reported whether `run()` is about to resolve
      // (valid/invalid/undeclared/oversize) or throw (97.4's `partial`, a
      // `finish()` salvage) — mirrors `ctx.onPeakRss` immediately above
      // exactly: called at most once, right before this method settles
      // either way.
      if (result.outcome !== undefined) ctx.onResultOutcome?.(result.outcome)
      if (!result.ok) {
        const err = result.error ?? { code: 'SCRIPT_FAILED', message: 'the script failed', phase: 'run' }
        throw Object.assign(new EnkakuError(err.code, err.message), {
          code: err.code === 'CANCELLED' ? 'job_cancelled' : err.code,
          // The runner has always known which phase failed and this boundary
          // used to drop it (plan 60 §3.4), which is why "why did this fail"
          // could only be answered by opening the log.
          phase: err.phase,
          // Plan 97 §3.5, step 97.4 — a `finish()` salvage, if any, riding
          // the thrown error the same way `code`/`phase` already do:
          // `JobExecutor.run()` rejects on failure (00-overview §4.3's own
          // deliberate-deviation reasoning in `executor.ts`), so there is no
          // resolved return value left to carry it on.
          ...(result.value !== undefined ? { partialResult: result.value } : {}),
        })
      }
      return result.value ?? null
    },
  }
}
