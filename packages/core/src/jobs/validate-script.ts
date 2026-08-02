import { EnkakuError } from '../util/errors'
import type { ExecutorRegistry } from './executor'

/**
 * One validation path for every way a job can be created — a standalone job
 * (`job-service.ts`) or every job in a batch (`clusters/dispatch.ts`, plan 20
 * §4.4). Kept in one place so a batch cannot silently create N jobs each
 * doomed to fail individually at claim time; an unknown or disabled script
 * fails once, loudly, at creation.
 */
export function validateScriptForRun(
  deps: { registry: ExecutorRegistry; findScript?: (scriptId: string) => { enabled: boolean } | null },
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
  return executor.validateParams(params)
}
