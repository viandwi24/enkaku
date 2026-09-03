import { z } from 'zod'
import { PullArgsSchema, PushArgsSchema, PushResultSchema } from '@enkaku/protocol'
import { defineCapability } from './types'

/** `device.push`, `device.pull` (plan 63 §4.3 table) — one-line delegations
 * to `ctx.deviceCall`, the same `TransferPort` a script's `ctx.device.push`/
 * `.pull` already uses (`device-executor.ts`). `quality: 'wall'`: neither
 * op touches the video stream. Source-only for `pull` — the artifact store,
 * never a client-supplied path leaving the device (plan 39 §3.7). */

const PullOutput = z.object({ artifactId: z.string(), bytes: z.number().int().nonnegative() })

export const devicePush = defineCapability({
  id: 'device.push',
  input: PushArgsSchema.extend({ deviceId: z.string() }),
  output: PushResultSchema,
  permission: 'device.files',
  activity: { kind: 'transfer' },
  deadline: 120_000,
  effect: 'write',
  description:
    'Push an already-uploaded artifact (artifactId) to an absolute path on the device. mediaScan defaults to "auto": MediaStore is told when the destination is under a known media root (plan 90 §4.6) — the result names which scan method, if any, actually ran.',
  handler: async (ctx, { deviceId, ...args }) => {
    const value = await ctx.deviceCall(deviceId, { method: 'push', args }, 'wall')
    return PushResultSchema.parse(value)
  },
})

export const devicePull = defineCapability({
  id: 'device.pull',
  input: PullArgsSchema.extend({ deviceId: z.string() }),
  output: PullOutput,
  permission: 'device.files',
  activity: { kind: 'transfer' },
  deadline: 120_000,
  effect: 'read',
  description: 'Pull a file from an absolute path on the device into the artifact store. Returns the new artifactId.',
  handler: async (ctx, { deviceId, ...args }) => {
    const value = await ctx.deviceCall(deviceId, { method: 'pull', args }, 'wall')
    return PullOutput.parse(value)
  },
})

export const DEVICE_FILES_CAPABILITIES = [devicePush, devicePull]
