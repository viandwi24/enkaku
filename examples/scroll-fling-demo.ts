import { definePlugin } from '@enkaku/sdk'
import { z } from 'zod'

/**
 * Plan 40 §5 step 40.6 / §7 — the demo that verifies the plan's core claim
 * (acceptance #1): a `fling` on a long list causes it to coast after
 * release, and the same gesture under `profile: 'instant'` stops dead.
 *
 * Point it at any long scrollable screen — the manual smoke test in plan 40
 * §7 uses Settings → Apps (`com.android.settings`,
 * `.Settings$AppListActivity`), which every Android build ships.
 *
 * The assertion is screenshot-based rather than selector-based, on purpose:
 * `Selector` only matches by id/desc/text/point (`packages/protocol/src/ui-node.ts`),
 * so there is no app-agnostic way to ask "what list item is now on top".
 * Raw PNG bytes are: if the picture right after the fling "ends" differs
 * from the picture `coastCheckMs` later, the list was still moving on its
 * own — it coasted. Under `profile: 'instant'` the two screenshots come back
 * byte-identical, because the list stopped the moment the linear swipe did.
 * That is the A/B this whole plan is built around (spec §9.3, plan 40 §2):
 *
 *   1. run with the farm's default timing profile (`natural`) → `coasted: true`
 *   2. set Timing → profile to `instant`, run again → `coasted: false`
 *
 * The demo is a one-member plugin because a script cannot be published on its
 * own (plan 110 §3.1). Helpers like `sleep`/`bytesEqual` below sit in the same
 * module and are bundled with it, exactly as they were before.
 */
export default definePlugin({
  id: 'scroll-fling-demo',
  version: '1.0.0',
  title: 'Scroll fling demo',
  description: 'Proves a fling coasts under the natural timing profile and stops dead under instant.',
  scripts: [
    {
      id: 'main',
      title: 'Fling and check for coast',
      description: 'Flings a long list, then compares two screenshots to see whether it kept moving.',
      params: z.object({
        package: z.string().default('com.android.settings'),
        activity: z.string().default('.Settings$AppListActivity'),
        /** Let the list render before the first fling. */
        settleMs: z.number().int().min(0).default(1_000),
        /**
         * How long after the fling to take the second screenshot. Long enough
         * that a coasting `OverScroller` is still visibly mid-flight; short
         * enough that a genuinely stopped list has no time to be nudged by
         * anything else on screen.
         */
        coastCheckMs: z.number().int().positive().default(250),
      }),
      timeout: 60_000,

      async prepare(ctx) {
        await ctx.device.app.forceStop(ctx.params.package)
        await ctx.device.app.launch(ctx.params.package, { activity: ctx.params.activity })
      },

      async run(ctx) {
        await sleep(ctx.params.settleMs)

        await ctx.device.fling({ direction: 'down', strength: 'hard' })
        const rightAfterFling = await ctx.device.screenshot()
        await sleep(ctx.params.coastCheckMs)
        const afterCoastWindow = await ctx.device.screenshot()

        const coasted = !bytesEqual(rightAfterFling, afterCoastWindow)
        ctx.log.info(
          coasted
            ? `the list kept changing ${ctx.params.coastCheckMs}ms after the fling "ended" — it coasted`
            : `the list was already still ${ctx.params.coastCheckMs}ms after the fling — no coast detected`,
          { coastCheckMs: ctx.params.coastCheckMs },
        )
        await ctx.artifact.file('right-after-fling', rightAfterFling, { ext: 'png' })
        await ctx.artifact.file('after-coast-window', afterCoastWindow, { ext: 'png' })

        return { coasted }
      },

      async finish(ctx) {
        if (ctx.error) await ctx.artifact.screenshot('failed')
        await ctx.device.app.forceStop(ctx.params.package)
      },
    },
  ],
})

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}
