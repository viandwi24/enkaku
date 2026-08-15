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
 * Plan 99 §3.1, §4.5, step 99.5 — `ExecutorRegistry.get()` gains a second,
 * optional `kind` parameter so a `'workflow'`-kind row can fall through to a
 * DIFFERENT executor than a `'script'`-kind row, once 99.7 registers one.
 * `kind` defaults to `'script'` everywhere, so the step's verifiable result
 * is exactly what these tests pin: `get(id, 'script')` returns byte-identical
 * to `get(id)` from before this step existed, and every current call site
 * (all single-argument) keeps its old behaviour with zero code changes.
 */
describe('ExecutorRegistry.get(scriptId, kind) (plan 99 §4.5)', () => {
  test('get(id, "script") returns exactly what get(id) returned before this step', () => {
    const registry = new ExecutorRegistry()
    const builtIn = fakeExecutor()
    const fallback = fakeExecutor()
    registry.register('internal:sleep', builtIn)
    registry.setFallback(fallback)

    expect(registry.get('internal:sleep')).toBe(builtIn)
    expect(registry.get('some-script-row-id')).toBe(fallback)

    expect(registry.get('internal:sleep', 'script')).toBe(builtIn)
    expect(registry.get('some-script-row-id', 'script')).toBe(fallback)
  })

  test('setFallback(executor) with no kind argument sets the "script" fallback, unchanged', () => {
    const registry = new ExecutorRegistry()
    const scriptFallback = fakeExecutor()
    registry.setFallback(scriptFallback)
    expect(registry.get('anything')).toBe(scriptFallback)
    expect(registry.get('anything', 'script')).toBe(scriptFallback)
  })

  test('a "workflow"-kind fallback is invisible to a plain get() call and vice versa', () => {
    const registry = new ExecutorRegistry()
    const scriptFallback = fakeExecutor()
    const workflowFallback = fakeExecutor()
    registry.setFallback(scriptFallback, 'script')
    registry.setFallback(workflowFallback, 'workflow')

    expect(registry.get('id')).toBe(scriptFallback)
    expect(registry.get('id', 'script')).toBe(scriptFallback)
    expect(registry.get('id', 'workflow')).toBe(workflowFallback)
  })

  test('a "workflow"-kind lookup with no workflow fallback registered is null, never the script fallback', () => {
    const registry = new ExecutorRegistry()
    registry.setFallback(fakeExecutor()) // 'script' only — the state before 99.7 lands
    expect(registry.get('id', 'workflow')).toBeNull()
  })

  test('a built-in id wins over both per-kind fallbacks, regardless of which kind is asked for', () => {
    const registry = new ExecutorRegistry()
    const builtIn = fakeExecutor()
    registry.register('internal:sleep', builtIn)
    registry.setFallback(fakeExecutor(), 'script')
    registry.setFallback(fakeExecutor(), 'workflow')
    expect(registry.get('internal:sleep', 'workflow')).toBe(builtIn)
    expect(registry.get('internal:sleep')).toBe(builtIn)
  })

  test('isBuiltIn is unaffected by kind — it only ever asked about the map', () => {
    const registry = new ExecutorRegistry()
    registry.register('internal:sleep', fakeExecutor())
    expect(registry.isBuiltIn('internal:sleep')).toBe(true)
    expect(registry.isBuiltIn('some-row-id')).toBe(false)
  })

  test('get() with no fallback registered at all returns null, exactly as before this step', () => {
    const registry = new ExecutorRegistry()
    expect(registry.get('anything')).toBeNull()
    expect(registry.get('anything', 'workflow')).toBeNull()
  })
})
