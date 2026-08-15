import { describe, expect, test } from 'bun:test'
import { EnkakuError } from '../util/errors'
import { ExecutorRegistry } from './executor'
import { validateScriptForRun } from './validate-script'

function registryWith(requires?: { gate?: 'files' | 'shell'; setting?: 'transfer.enabled' }): ExecutorRegistry {
  const registry = new ExecutorRegistry()
  registry.register('internal:sleep', { validateParams: (p) => p, run: async () => undefined })
  registry.register('internal:install', { validateParams: (p) => p, run: async () => undefined, requires })
  return registry
}

describe('validateScriptForRun — unchanged behaviour with no requires (plan 20 §4.4)', () => {
  test('an unknown scriptId (with findScript wired) is refused', () => {
    const registry = registryWith()
    expect(() => validateScriptForRun({ registry, findScript: () => null }, 'no-such-script', {})).toThrow(EnkakuError)
  })

  test('a script with no requires runs regardless of role/settings', () => {
    const registry = registryWith()
    const params = validateScriptForRun(
      { registry, actorRole: () => 'operator', shellMode: () => 'off', transferEnabled: () => false },
      'internal:sleep',
      { x: 1 },
    )
    expect(params).toEqual({ x: 1 })
  })
})

/**
 * `JobExecutor.requires` (plan 93 §3.12, §4.6, step 93.8) — the ONE place
 * every dispatch path funnels through. These tests exercise the function
 * directly, independent of any HTTP route, so the gate's own rules (role
 * half vs. setting half, and what "unwired" means for each) are pinned once
 * rather than only observed indirectly through `api/batches.ts`/`api/
 * schedules.ts`'s own HTTP-level tests.
 */
describe('validateScriptForRun — JobExecutor.requires (plan 93 §3.12, §4.6, step 93.8)', () => {
  const requires = { gate: 'files' as const, setting: 'transfer.enabled' as const }

  test('an operator without device.files (shell.mode: admin) is refused with auth.forbidden', () => {
    const registry = registryWith(requires)
    expect(() =>
      validateScriptForRun(
        { registry, actorRole: () => 'operator', shellMode: () => 'admin', transferEnabled: () => true },
        'internal:install',
        {},
      ),
    ).toThrow(EnkakuError)
  })

  test('an operator under shell.mode: operator (widened) passes the role half', () => {
    const registry = registryWith(requires)
    const params = validateScriptForRun(
      { registry, actorRole: () => 'operator', shellMode: () => 'operator', transferEnabled: () => true },
      'internal:install',
      {},
    )
    expect(params).toEqual({})
  })

  test('an admin passes the role half under shell.mode: admin (mode: off refuses even an admin — canUseFiles\'s own rule)', () => {
    const registry = registryWith(requires)
    const params = validateScriptForRun(
      { registry, actorRole: () => 'admin', shellMode: () => 'admin', transferEnabled: () => true },
      'internal:install',
      {},
    )
    expect(params).toEqual({})
  })

  test('transfer.enabled: false refuses even an admin who passes the role half', () => {
    const registry = registryWith(requires)
    expect(() =>
      validateScriptForRun(
        { registry, actorRole: () => 'admin', shellMode: () => 'admin', transferEnabled: () => false },
        'internal:install',
        {},
      ),
    ).toThrow(EnkakuError)
  })

  test('no actorRole wired (a schedule firing at cron time — no interactive actor) skips the role half but transfer.enabled still binds', () => {
    const registry = registryWith(requires)
    // The role half is skipped (no interactive actor — schedules/runner.ts's
    // own "farm-wide authority to fire" precedent), so this succeeds even
    // though no role was ever supplied.
    const params = validateScriptForRun({ registry, shellMode: () => 'admin', transferEnabled: () => true }, 'internal:install', {})
    expect(params).toEqual({})

    // The SETTING half is never skipped just because there is no actor.
    expect(() =>
      validateScriptForRun({ registry, shellMode: () => 'admin', transferEnabled: () => false }, 'internal:install', {}),
    ).toThrow(EnkakuError)
  })

  test('actorRole wired but returning null (an unauthenticated/system caller) also skips the role half', () => {
    const registry = registryWith(requires)
    const params = validateScriptForRun(
      { registry, actorRole: () => null, shellMode: () => 'admin', transferEnabled: () => true },
      'internal:install',
      {},
    )
    expect(params).toEqual({})
  })

  test('with every new dep unwired, the gate is not evaluated at all — exactly pre-93.8 behaviour (F10)', () => {
    const registry = registryWith(requires)
    const params = validateScriptForRun({ registry }, 'internal:install', {})
    expect(params).toEqual({})
  })

  test('shellMode wired but actorRole absent skips the role half (setting half still binds)', () => {
    const registry = registryWith(requires)
    const params = validateScriptForRun({ registry, shellMode: () => 'off', transferEnabled: () => true }, 'internal:install', {})
    expect(params).toEqual({})
  })
})
