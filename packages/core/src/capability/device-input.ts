import { z } from 'zod'
import { FlingArgsSchema, KeyArgsSchema, ScrollArgsSchema, SwipeArgsSchema, TapArgsSchema, TypeArgsSchema } from '@enkaku/protocol'
import { defineCapability } from './types'

/**
 * The six input capabilities (plan 63 §4.3 table). Every handler is a
 * one-line delegation to `ctx.deviceCall`, which runs the SAME
 * `createDeviceExecutor` (`@enkaku/session`) the script IPC bridge uses —
 * no gesture math, no timing logic, no driver behaviour is written here
 * (step 63.4). `deviceId` is added to each shared `@enkaku/protocol`
 * device-arg schema so `DeviceCallSchema` (session) and these capability
 * inputs both derive from ONE declaration of each operation's arguments
 * (plan 63 §3.7 — see `device-args.ts`'s own comment for why the wrapper
 * differs but the shape does not).
 *
 * `device.tap`'s output distinguishes "tapped" from "the selector matched
 * nothing" — the ONE distinction `resolveTarget` (`device-executor.ts`)
 * already throws a coded `element_not_found` for today. The plan's own
 * illustrative example additionally proposes `rejected-oversized` and
 * `ambiguous` reasons with a returned `bounds`/`matches` count; the current
 * driver collapses every non-match into a single `null` (or, for `tap`,
 * discards the resolved point entirely), so reporting those two reasons
 * here would not be truthful without changing `device-executor.ts`'s
 * behaviour, which step 63.4 forbids. This ships the narrower, honest
 * schema — still fully typed, never widened to `z.unknown()` — and is
 * recorded as a found §8 risk in the plan's own terms rather than silently
 * ignored (see the implementation report).
 */

const OkOutput = z.object({ ok: z.literal(true) })

const TapOutput = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), reason: z.literal('not-found') }),
])

async function tappable(run: () => Promise<unknown>): Promise<z.infer<typeof TapOutput>> {
  try {
    await run()
    return { ok: true }
  } catch (err) {
    if (err instanceof Error && (err as { code?: unknown }).code === 'element_not_found') {
      return { ok: false, reason: 'not-found' }
    }
    throw err
  }
}

export const deviceTap = defineCapability({
  id: 'device.tap',
  input: TapArgsSchema.extend({ deviceId: z.string() }),
  output: TapOutput,
  permission: 'device.control',
  activity: { kind: 'control' },
  deadline: 15_000,
  effect: 'write',
  description:
    'Tap a UI element on the device, located by selector (id, text, desc, or an exact point). ' +
    'Returns { ok: false, reason: "not-found" } without tapping anything if the selector matches ' +
    'nothing on screen — it never guesses.',
  handler: (ctx, { deviceId, target }) => tappable(() => ctx.deviceCall(deviceId, { method: 'tap', args: { target } })),
})

export const deviceSwipe = defineCapability({
  id: 'device.swipe',
  input: SwipeArgsSchema.extend({ deviceId: z.string() }),
  output: OkOutput,
  permission: 'device.control',
  activity: { kind: 'control' },
  deadline: 15_000,
  effect: 'write',
  description: 'Drag from one point to another over a duration, with an optional curved gesture path and easing.',
  handler: async (ctx, { deviceId, ...args }) => {
    await ctx.deviceCall(deviceId, { method: 'swipe', args })
    return { ok: true as const }
  },
})

export const deviceScroll = defineCapability({
  id: 'device.scroll',
  input: ScrollArgsSchema.extend({ deviceId: z.string() }),
  output: OkOutput,
  permission: 'device.control',
  activity: { kind: 'control' },
  deadline: 15_000,
  effect: 'write',
  description: 'A controlled drag that ends at low velocity and stops where it is put — scroll a list a bounded distance.',
  handler: async (ctx, { deviceId, ...args }) => {
    await ctx.deviceCall(deviceId, { method: 'scroll', args })
    return { ok: true as const }
  },
})

export const deviceFling = defineCapability({
  id: 'device.fling',
  input: FlingArgsSchema.extend({ deviceId: z.string() }),
  output: OkOutput,
  permission: 'device.control',
  activity: { kind: 'control' },
  deadline: 15_000,
  effect: 'write',
  description: 'A short, fast gesture that ends at high velocity and lets a list coast — use for a big, imprecise scroll.',
  handler: async (ctx, { deviceId, ...args }) => {
    await ctx.deviceCall(deviceId, { method: 'fling', args })
    return { ok: true as const }
  },
})

export const deviceType = defineCapability({
  id: 'device.type',
  input: TypeArgsSchema.extend({ deviceId: z.string() }),
  output: OkOutput,
  permission: 'device.control',
  activity: { kind: 'control' },
  deadline: 30_000,
  effect: 'write',
  description:
    'Type text into whatever was last tapped (or bulk-deliver it, if nothing was tapped this session). ' +
    'Per-character delivery by default so autocomplete and validation actually run; set instant:true to skip that.',
  handler: async (ctx, { deviceId, ...args }) => {
    await ctx.deviceCall(deviceId, { method: 'type', args })
    return { ok: true as const }
  },
})

export const deviceKey = defineCapability({
  id: 'device.key',
  input: KeyArgsSchema.extend({ deviceId: z.string() }),
  output: OkOutput,
  permission: 'device.control',
  activity: { kind: 'control' },
  deadline: 10_000,
  effect: 'write',
  description: 'Send one hardware/software key event (a keycode number, or a name like "BACK", "HOME", "ENTER").',
  handler: async (ctx, { deviceId, ...args }) => {
    await ctx.deviceCall(deviceId, { method: 'key', args })
    return { ok: true as const }
  },
})

export const DEVICE_INPUT_CAPABILITIES = [deviceTap, deviceSwipe, deviceScroll, deviceFling, deviceType, deviceKey]
