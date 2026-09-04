import { describe, expect, test } from 'bun:test'
import { ExecutorRegistry, type JobExecutor } from './executor'

/** A stand-in executor — identity is all these tests need; `run`/`validateParams` are never called. */
function fakeExecutor(): JobExecutor {
  return {
    validateParams: (params) => params,
    run: async () => undefined,
  }
}

/**
 * Plan 210 §4.8 — `ExecutorRegistry` has ONE fallback, not one per kind:
 * `scripts.kind` is gone, and `daemon.ts` never passed a `scriptKind` to
 * `ExecutorHost` in production, so the per-kind dispatch this class used to
 * carry was dead weight (the workflow fallback was unreachable).
 */
describe('ExecutorRegistry (plan 210 §4.8)', () => {
  test('a built-in id wins over the fallback', () => {
    const registry = new ExecutorRegistry()
    const builtIn = fakeExecutor()
    const fallback = fakeExecutor()
    registry.register('internal:sleep', builtIn)
    registry.setFallback(fallback)

    expect(registry.get('internal:sleep')).toBe(builtIn)
    expect(registry.get('some-script-row-id')).toBe(fallback)
  })

  test('isBuiltIn only ever asks about the map', () => {
    const registry = new ExecutorRegistry()
    registry.register('internal:sleep', fakeExecutor())
    expect(registry.isBuiltIn('internal:sleep')).toBe(true)
    expect(registry.isBuiltIn('some-row-id')).toBe(false)
  })

  test('get() with no fallback registered at all returns null', () => {
    const registry = new ExecutorRegistry()
    expect(registry.get('anything')).toBeNull()
  })
})
