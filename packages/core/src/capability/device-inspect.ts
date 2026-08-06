import { z } from 'zod'
import { DumpArgsSchema, FindArgsSchema, FindOutcomeSchema, ScreenshotArgsSchema, UiNodeSchema, WaitForArgsSchema } from '@enkaku/protocol'
import { defineCapability } from './types'

/**
 * The four inspection capabilities (plan 63 §4.3 table) — every handler
 * delegates to `ctx.deviceCall`, the same executor a script's `find`/
 * `dump`/`waitFor`/`screenshot` already runs through
 * (`@enkaku/session/device-executor.ts`). `quality: 'wall'` on every call
 * here (see `context.ts`'s `deviceCall` comment): none of these read the
 * video stream, so a plain read never forces a session that a Wall viewer
 * already has open at `wall` quality to restart at `control`.
 *
 * Rule #12 ("no capability result is a bare string"): `device.screenshot`'s
 * driver call already returns a base64 PNG string
 * (`device-executor.ts`'s `screenshot` case) — wrapped here in
 * `{ image, format }` rather than returned as-is.
 */

export const deviceFind = defineCapability({
  id: 'device.find',
  input: FindArgsSchema.extend({ deviceId: z.string() }),
  // Plan 74 §3.4, §4.3 — completes plan 63's deviation note: the driver can
  // now honestly say WHICH of not-found/rejected-oversized/ambiguous
  // happened, so the capability output is the full discriminated union
  // instead of the narrowed `{ ok:false, reason:'not-found' }` placeholder.
  output: FindOutcomeSchema,
  permission: 'device.control',
  lease: 'device',
  deadline: 10_000,
  effect: 'read',
  description:
    'Find one UI element by selector without acting on it. Never a bare null: { ok:false, reason } distinguishes ' +
    '"not-found" (nothing on screen matches — wait or navigate), "rejected-oversized" (the selector matched a ' +
    'container covering the whole screen — retrying the same selector will never help, narrow it instead), and ' +
    '"ambiguous" (several nodes matched — narrow the selector).',
  handler: async (ctx, { deviceId, sel }) => {
    const value = await ctx.deviceCall(deviceId, { method: 'find', args: { sel } }, 'wall')
    return FindOutcomeSchema.parse(value)
  },
})

export const deviceDump = defineCapability({
  id: 'device.dump',
  input: DumpArgsSchema.extend({ deviceId: z.string() }),
  output: UiNodeSchema,
  permission: 'device.control',
  lease: 'device',
  deadline: 15_000,
  effect: 'read',
  description:
    'The whole accessibility tree, the same one the Inspect panel shows. Use this to locate an element the ' +
    'four-shape selector grammar cannot reach (no resource id, no text), by walking the returned tree yourself.',
  handler: async (ctx, { deviceId }) => {
    const value = await ctx.deviceCall(deviceId, { method: 'dump', args: {} }, 'wall')
    return UiNodeSchema.parse(value)
  },
})

const WaitForOutput = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), node: UiNodeSchema }),
  z.object({
    ok: z.literal(false),
    reason: z.literal('timeout'),
    /**
     * Plan 74 §3.5, §4.3, criterion 9 — the LAST `FindOutcome` the polling
     * loop saw before giving up, so "every match was refused as a container"
     * reports as that rather than a bare timeout. Absent only when the
     * device never answered even once (the fallback outcome device-executor
     * seeds the loop with is itself `not-found`, so in practice this is
     * always present for a real timeout).
     */
    lastReason: z.enum(['not-found', 'rejected-oversized', 'ambiguous']).optional(),
    matches: z.number().int().optional(),
  }),
])

export const deviceWaitFor = defineCapability({
  id: 'device.waitFor',
  input: WaitForArgsSchema.extend({ deviceId: z.string() }),
  output: WaitForOutput,
  permission: 'device.control',
  lease: 'device',
  deadline: 65_000,
  effect: 'read',
  description:
    'Poll for a selector to appear, up to timeout milliseconds. Returns { ok: false, reason: "timeout", lastReason } ' +
    'rather than throwing when it never appears — lastReason says WHY every attempt failed (not-found / ' +
    'rejected-oversized / ambiguous), so a wait that only ever matched a container is distinguishable from one ' +
    'that never matched at all. The capability deadline (65s) is a hard ceiling above the requested timeout, so a ' +
    'timeout longer than that is truncated.',
  handler: async (ctx, { deviceId, sel, timeout, intervalMs }) => {
    try {
      const value = await ctx.deviceCall(deviceId, { method: 'waitFor', args: { sel, timeout, intervalMs } }, 'wall')
      return { ok: true as const, node: UiNodeSchema.parse(value) }
    } catch (err) {
      if (err instanceof Error && (err as { code?: unknown }).code === 'waitfor_timeout') {
        const details = (err as { details?: { reason?: unknown; matches?: unknown } }).details
        const reasonParse = z.enum(['not-found', 'rejected-oversized', 'ambiguous']).safeParse(details?.reason)
        const matchesParse = z.number().int().safeParse(details?.matches)
        return {
          ok: false as const,
          reason: 'timeout' as const,
          ...(reasonParse.success ? { lastReason: reasonParse.data } : {}),
          ...(matchesParse.success ? { matches: matchesParse.data } : {}),
        }
      }
      throw err
    }
  },
})

const ScreenshotOutput = z.object({ image: z.string(), format: z.literal('png') })

export const deviceScreenshot = defineCapability({
  id: 'device.screenshot',
  input: ScreenshotArgsSchema.extend({ deviceId: z.string() }),
  output: ScreenshotOutput,
  permission: 'device.control',
  lease: 'device',
  deadline: 10_000,
  effect: 'read',
  description: 'Take a screenshot of the device right now. Returns a base64-encoded PNG.',
  // Plan 70 §4.3 — a DECLARATION, not the loop pattern-matching on a field called "image": the
  // boot-time registry check asserts "image" actually exists on `ScreenshotOutput` above.
  imageOutputs: [{ dataField: 'image', mediaType: 'image/png' }],
  handler: async (ctx, { deviceId }) => {
    const value = await ctx.deviceCall(deviceId, { method: 'screenshot', args: {} }, 'wall')
    return { image: z.string().parse(value), format: 'png' as const }
  },
})

export const DEVICE_INSPECT_CAPABILITIES = [deviceFind, deviceDump, deviceWaitFor, deviceScreenshot]
