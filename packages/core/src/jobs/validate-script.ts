import type { ShellMode } from '@enkaku/protocol'
import { canUseFiles, canUseShell } from '../auth/acl'
import type { Role } from '../auth/service'
import { EnkakuError } from '../util/errors'
import type { ExecutorRegistry } from './executor'

/**
 * One validation path for every way a job can be created — a standalone job
 * (`job-service.ts`) or every job in a batch (`clusters/dispatch.ts`, plan 20
 * §4.4). Kept in one place so a batch cannot silently create N jobs each
 * doomed to fail individually at claim time; an unknown or disabled script
 * fails once, loudly, at creation.
 *
 * Plan 93 §3.12, §4.6, step 93.8 — also the ONE place `JobExecutor.requires`
 * is enforced, for all FOUR write paths onto `jobs` (`api/batches.ts`,
 * `services/job-service.ts`, `api/schedules.ts`, `schedules/runner.ts`'s own
 * cron-fired dispatch), closing F10: `POST /api/batches
 * {scriptId:'internal:install'}` used to require only `job.run` — no
 * `device.files`, no `transfer.enabled` — the same escalation `POST
 * /api/jobs` had with no permission check at all.
 *
 * `actorRole`/`shellMode`/`transferEnabled` are all NEW and optional, so
 * every existing test and caller keeps compiling; when any is absent the
 * corresponding half of the gate is not evaluated, which is exactly today's
 * behaviour. `actorRole` deliberately returning `null` (or being unwired)
 * is not "deny" — it means "no interactive actor" (a schedule firing at cron
 * time has none — `schedules/runner.ts`'s own precedent throughout this file:
 * `assertDeviceAllowed`/`canCancelJob` are both skipped the same way for the
 * identical reason), so the ROLE half of the gate is skipped while the
 * SETTING half (`transferEnabled`) still applies unconditionally — a farm
 * switch is farm-wide authority, not a per-user one.
 */
export function validateScriptForRun(
  deps: {
    registry: ExecutorRegistry
    findScript?: (scriptId: string) => { enabled: boolean } | null
    /** The acting user's role, resolved per call (an interactive route reads `c.get('user')`). Undefined/null-returning = no interactive actor. */
    actorRole?: () => Role | null
    /** Live `shell.mode`, read fresh — the same freshness contract every other settings-derived accessor in this codebase promises. */
    shellMode?: () => ShellMode
    /** Live `transfer.enabled`. */
    transferEnabled?: () => boolean
  },
  scriptId: string,
  params: unknown,
): unknown {
  if (!deps.registry.isBuiltIn(scriptId)) {
    const script = deps.findScript?.(scriptId) ?? null
    if (!script) throw new EnkakuError('unknown_script', `unknown script: ${scriptId}`)
    if (!script.enabled) throw new EnkakuError('script_disabled', `the script ${scriptId} is disabled`)
  }
  const executor = deps.registry.get(scriptId)
  if (!executor) throw new EnkakuError('unknown_script', `unknown script: ${scriptId}`)

  const requires = executor.requires
  if (requires?.gate && deps.actorRole && deps.shellMode) {
    const role = deps.actorRole()
    if (role) {
      const mode = deps.shellMode()
      const allowed = requires.gate === 'files' ? canUseFiles(role, mode) : canUseShell(role, mode)
      if (!allowed) {
        throw new EnkakuError(
          'auth.forbidden',
          `you do not have permission to run ${scriptId} (requires device.${requires.gate})`,
        )
      }
    }
  }
  if (requires?.setting === 'transfer.enabled' && deps.transferEnabled && !deps.transferEnabled()) {
    throw new EnkakuError(
      'auth.forbidden',
      `file transfer is disabled for this farm (transfer.enabled), required by ${scriptId}`,
    )
  }

  return executor.validateParams(params, scriptId)
}
