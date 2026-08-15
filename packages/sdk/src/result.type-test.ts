import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { defineScript } from './define-script'

/**
 * Plan 97 §0.3 H1, §5 step 97.2's own verifiable result: a second, optional
 * generic on `ScriptDefinition` must infer correctly in BOTH directions —
 * omitting `result` leaves `run` returning `Promise<unknown>` exactly as
 * today, and declaring it makes a wrong return value a compile error in the
 * author's own editor.
 *
 * `@ts-expect-error` is the assertion: `bash scripts/typecheck.sh` runs real
 * `tsc --noEmit -p packages/sdk` over this file, and `@ts-expect-error`
 * itself is a compile error when the following line does NOT already fail
 * to compile (the identical technique `vocabulary.test.ts` already uses for
 * `ui()`'s overloads — see its own header comment). So a regression that
 * made a wrong `run` return value legal again would fail typecheck HERE,
 * not silently pass. `bun test` cannot see any of this (Bun strips types
 * without checking them), which is why every `defineScript(...)` call below
 * is otherwise inert and each test carries its own runtime assertion so a
 * plain read of the file shows it is not a no-op.
 *
 * Named `result.type-test.ts`, not `result.test.ts`, on purpose: this file's
 * job is served entirely by `tsc`, and a name outside `bun test`'s default
 * discovery glob (`*.test.ts`) keeps a type-only file out of the ordinary
 * test run rather than adding assertions that never do anything under Bun's
 * own type stripping. It can still be run explicitly:
 * `bun test packages/sdk/src/result.type-test.ts`.
 */
describe('ScriptDefinition<S, R> — the H1 inference guarantee (plan 97 §0.3, §4.2)', () => {
  test('declaring no `result` at all: `run` may return ANY value, with no cast and no explicit generic argument — unchanged from before this plan', () => {
    const def = defineScript({
      id: 'no-result',
      version: '1.0.0',
      params: z.object({}),
      async run() {
        // No `result` was declared, so this is `Promise<unknown>` — any shape compiles.
        return { anything: 'goes', count: 42 }
      },
    })
    expect(def.result).toBeUndefined()
  })

  test('declaring `result` and returning exactly the declared shape compiles cleanly', () => {
    const def = defineScript({
      id: 'typed-result',
      version: '1.0.0',
      params: z.object({}),
      result: z.object({ videos: z.number().int(), watchSeconds: z.number() }),
      async run() {
        return { videos: 12, watchSeconds: 240 }
      },
    })
    expect(def.result).toBeDefined()
  })

  test('a `run` returning the WRONG shape for the declared `result` is a compile error, not a runtime surprise', () => {
    const def = defineScript({
      id: 'wrong-result',
      version: '1.0.0',
      params: z.object({}),
      result: z.object({ videos: z.number().int() }),
      // @ts-expect-error — `videos` must be a number; the declared result schema does not accept a string here.
      async run() {
        return { videos: 'twelve' }
      },
    })
    expect(def.id).toBe('wrong-result')
  })

  test('a `run` missing a field the declared `result` requires is also a compile error', () => {
    const def = defineScript({
      id: 'missing-field',
      version: '1.0.0',
      params: z.object({}),
      result: z.object({ videos: z.number().int(), watchSeconds: z.number() }),
      // @ts-expect-error — `watchSeconds` is required by the declared result schema and is missing here.
      async run() {
        return { videos: 12 }
      },
    })
    expect(def.id).toBe('missing-field')
  })
})
