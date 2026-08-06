import { z } from 'zod'
import { ClipboardGetArgsSchema, ClipboardSetArgsSchema } from '@enkaku/protocol'
import { defineCapability } from './types'

/** `device.clipboard.get`, `device.clipboard.set` (plan 63 §4.3 table) —
 * one-line delegations to `ctx.deviceCall`, the same clipboard bridge a
 * script's `ctx.device.clipboard.*` already uses (plan 38). A device with
 * no scrcpy control socket refuses `get` with the SAME coded
 * `E_CLIPBOARD_UNAVAILABLE` the driver already throws (`session.ts`'s
 * clipboard shim) — `invoke` passes it through unchanged rather than
 * collapsing it into `E_INTERNAL` (see `invoke.ts`'s `isCodedError`). */

const OkOutput = z.object({ ok: z.literal(true) })
const TextOutput = z.object({ text: z.string() })

export const deviceClipboardGet = defineCapability({
  id: 'device.clipboard.get',
  input: ClipboardGetArgsSchema.extend({ deviceId: z.string() }),
  output: TextOutput,
  permission: 'device.control',
  lease: 'device',
  deadline: 10_000,
  effect: 'read',
  description:
    'Read the device clipboard. Refuses with E_CLIPBOARD_UNAVAILABLE (never an empty string) on a device with ' +
    'no active scrcpy session — an empty clipboard and "cannot be read" are different facts.',
  handler: async (ctx, { deviceId }) => {
    const value = await ctx.deviceCall(deviceId, { method: 'clipboard.get', args: {} }, 'wall')
    return { text: z.string().parse(value) }
  },
})

export const deviceClipboardSet = defineCapability({
  id: 'device.clipboard.set',
  input: ClipboardSetArgsSchema.extend({ deviceId: z.string() }),
  output: OkOutput,
  permission: 'device.control',
  lease: 'control',
  deadline: 10_000,
  effect: 'write',
  description: 'Set the device clipboard. paste:true also pastes it into the currently focused field (scrcpy sessions only).',
  handler: async (ctx, { deviceId, ...args }) => {
    await ctx.deviceCall(deviceId, { method: 'clipboard.set', args })
    return { ok: true as const }
  },
})

export const DEVICE_CLIPBOARD_CAPABILITIES = [deviceClipboardGet, deviceClipboardSet]
