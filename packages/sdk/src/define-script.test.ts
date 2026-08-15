import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { defineScript } from './define-script'
import type { ScriptDefinition } from './types'

function baseDef(extra?: Partial<ScriptDefinition>): ScriptDefinition {
  return { id: 'checkout', version: '1.0.0', params: z.object({}), run: async () => 'ok', ...extra } as ScriptDefinition
}

describe('defineScript', () => {
  test('rejects a missing id', () => {
    expect(() => defineScript(baseDef({ id: '' }))).toThrow(/id/)
  })

  test('rejects a non-semver version', () => {
    expect(() => defineScript(baseDef({ version: 'v1' }))).toThrow(/semver/)
  })

  test('rejects a missing run function', () => {
    expect(() => defineScript({ id: 'x', version: '1.0.0', params: z.object({}) } as unknown as ScriptDefinition)).toThrow(/run/)
  })

  test('rejects a missing Zod params schema', () => {
    expect(() => defineScript({ id: 'x', version: '1.0.0', params: {} as never, run: async () => {} })).toThrow(/params/)
  })

  describe('`result` (plan 97 §3.2, §4.2, fixes F1/F2)', () => {
    test('a definition with no `result` at all is unaffected — optional, always optional', () => {
      const def = defineScript(baseDef())
      expect(def.result).toBeUndefined()
    })

    test('a definition declaring a Zod `result` schema is accepted and kept intact', () => {
      const resultSchema = z.object({ videos: z.number().int() })
      const def = defineScript({
        id: 'checkout',
        version: '1.0.0',
        params: z.object({}),
        result: resultSchema,
        run: async () => ({ videos: 3 }),
      })
      expect(def.result).toBe(resultSchema)
    })

    test('a non-Zod `result` is rejected with the same message shape as `params`', () => {
      // `{} as unknown as z.ZodTypeAny` (never `as never`) so `R`'s inference stays a real Zod
      // type and `run`'s expected return does not collapse to `Promise<never>` — this test is
      // about the RUNTIME rejection of a malformed `result`, not a compile-time one.
      expect(() =>
        defineScript({
          id: 'x',
          version: '1.0.0',
          params: z.object({}),
          result: {} as unknown as z.ZodTypeAny,
          run: async () => {},
        }),
      ).toThrow(/result/)
    })
  })

  test('freezes the definition', () => {
    const def = defineScript(baseDef())
    expect(Object.isFrozen(def)).toBe(true)
  })

  test('a script declaring neither `timeout`/`retries` nor `runtime` gets no envelope at all (plan 98 §3.1, backward compatibility)', () => {
    const def = defineScript(baseDef())
    expect(def.runtime).toBeUndefined()
  })

  describe('the timeout/retries ⇒ runtime fold (plan 98 §4.2)', () => {
    test('the deprecated `timeout` field alone folds into `runtime.timeoutMs`', () => {
      const def = defineScript(baseDef({ timeout: 30_000 }))
      expect(def.runtime?.timeoutMs).toBe(30_000)
      // The deprecated field itself is untouched — kept forever, never removed.
      expect(def.timeout).toBe(30_000)
    })

    test('the deprecated `retries` field alone folds into `runtime.retries`', () => {
      const def = defineScript(baseDef({ retries: 3 }))
      expect(def.runtime?.retries).toBe(3)
    })

    test('a `runtime` object alone is validated and kept as-is', () => {
      const def = defineScript(baseDef({ runtime: { maxRssBytes: 128 * 1024 * 1024, maxConcurrent: 2 } }))
      expect(def.runtime?.maxRssBytes).toBe(128 * 1024 * 1024)
      expect(def.runtime?.maxConcurrent).toBe(2)
    })

    test('`timeout` and `runtime.timeoutMs` agreeing is fine — the fold is idempotent', () => {
      const def = defineScript(baseDef({ timeout: 45_000, runtime: { timeoutMs: 45_000 } }))
      expect(def.runtime?.timeoutMs).toBe(45_000)
    })

    test('`retries` and `runtime.retries` agreeing is fine', () => {
      const def = defineScript(baseDef({ retries: 2, runtime: { retries: 2 } }))
      expect(def.runtime?.retries).toBe(2)
    })

    test('`timeout` and `runtime.timeoutMs` DISAGREEING throws, naming both numbers, at import time', () => {
      expect(() => defineScript(baseDef({ timeout: 30_000, runtime: { timeoutMs: 60_000 } }))).toThrow(/30000.*60000|60000.*30000/)
    })

    test('`retries` and `runtime.retries` DISAGREEING throws, naming both numbers', () => {
      expect(() => defineScript(baseDef({ retries: 1, runtime: { retries: 5 } }))).toThrow(/\b1\b.*\b5\b|\b5\b.*\b1\b/)
    })

    test('a `runtime` object combined with a DIFFERENT field (e.g. maxRssBytes) alongside an agreeing `timeout` is fine', () => {
      const def = defineScript(baseDef({ timeout: 10_000, runtime: { timeoutMs: 10_000, maxRssBytes: 256 * 1024 * 1024 } }))
      expect(def.runtime?.timeoutMs).toBe(10_000)
      expect(def.runtime?.maxRssBytes).toBe(256 * 1024 * 1024)
    })

    test('an out-of-bounds `runtime.timeoutMs` (below the 1s floor) throws at import time, on the author\'s own machine', () => {
      expect(() => defineScript(baseDef({ runtime: { timeoutMs: 500 } }))).toThrow()
    })

    test('an out-of-bounds `runtime.maxRssBytes` (below the 64 MB floor) throws at import time', () => {
      expect(() => defineScript(baseDef({ runtime: { maxRssBytes: 1024 } }))).toThrow()
    })
  })
})
