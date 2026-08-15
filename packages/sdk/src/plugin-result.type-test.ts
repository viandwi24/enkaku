import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { definePlugin, type PluginMemberScript } from './plugin'

/**
 * Plan 97 §3.2, §5 step 97.8 — the plugin-member half of H1
 * (`result.type-test.ts` already proves the standalone `defineScript` half).
 * `sdk/src/plugin.ts`'s `PluginMemberScript<S, R>` now carries the same
 * second generic `ScriptDefinition<S, R>` does — closing the gap step 97.2
 * left open and named as "left for whoever picks up 97.8".
 *
 * As `plugin.ts`'s own `PluginMemberScripts<S>` doc comment explains, this
 * is proven at the member's own `const` DECLARATION, exactly the pattern
 * `switch-account.ts`/`search-follow.ts` already use — not via
 * `definePlugin`'s array-position inference, which cannot carry a second,
 * independent generic per element (tried; recorded there).
 *
 * `@ts-expect-error` is the assertion, matching `result.type-test.ts`'s own
 * technique — see that file's header for why. Named `.type-test.ts` so it
 * is exercised by `bash scripts/typecheck.sh`'s real `tsc --noEmit -p
 * packages/sdk`, not by `bun test`'s type-stripped run (though it can still
 * be run explicitly, inertly, with `bun test`).
 */
describe('PluginMemberScript<S, R> — H1 for a plugin member (plan 97 §3.2, §5 step 97.8)', () => {
  test('a member declaring no `result` may return ANY value — unchanged from before this plan', () => {
    const noResult: PluginMemberScript<z.ZodObject<Record<string, never>>> = {
      id: 'no-result',
      params: z.object({}),
      async run() {
        return { anything: 'goes' }
      },
    }
    const plugin = definePlugin({ id: 'p', version: '1.0.0', scripts: [noResult] })
    expect(plugin.scripts[0]?.result).toBeUndefined()
  })

  const resultSchema = z.object({ videos: z.number().int() })

  test('a member declaring `result` and returning exactly the declared shape compiles cleanly', () => {
    const typedResult: PluginMemberScript<z.ZodObject<Record<string, never>>, typeof resultSchema> = {
      id: 'typed-result',
      params: z.object({}),
      result: resultSchema,
      async run() {
        return { videos: 12 }
      },
    }
    const plugin = definePlugin({ id: 'p', version: '1.0.0', scripts: [typedResult] })
    expect(plugin.scripts[0]?.result).toBeDefined()
  })

  test('a member `run` returning the WRONG shape for its declared `result` is a compile error at the member\'s own declaration', () => {
    const wrongResult: PluginMemberScript<z.ZodObject<Record<string, never>>, typeof resultSchema> = {
      id: 'wrong-result',
      params: z.object({}),
      result: resultSchema,
      // @ts-expect-error — `videos` must be a number; the declared result schema does not accept a string here.
      async run() {
        return { videos: 'twelve' }
      },
    }
    expect(wrongResult.id).toBe('wrong-result')
  })
})
