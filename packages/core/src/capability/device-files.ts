import { z } from 'zod'
import {
  DeviceFsDeleteArgsSchema,
  DeviceFsListArgsSchema,
  DeviceFsListResultSchema,
  DeviceFsMkdirArgsSchema,
  DeviceFsMoveArgsSchema,
  DeviceFsOkResultSchema,
  DeviceFsStatArgsSchema,
  DeviceFsStatResultSchema,
  DeviceMediaListArgsSchema,
  DeviceMediaListResultSchema,
  PullArgsSchema,
  PushArgsSchema,
  PushResultSchema,
} from '@enkaku/protocol'
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

/**
 * Plan 700 — the READ half of device files, and the file manager.
 *
 * These exist as capabilities, not only as SDK methods, because a capability
 * is what a PLUGIN's own Studio screen can invoke (`ctx.farm.call`, and the
 * surface's declared actions). A plugin that manages media on a farm's phones
 * needs to see what is there from its own view, not only from inside a job.
 *
 * All six carry `permission: 'device.files'` — the same gate push/pull use, so
 * an operator who has turned file access off loses these too rather than
 * discovering a second door. `quality: 'wall'`: none touches the video stream.
 */
export const deviceMediaList = defineCapability({
  id: 'device.media.list',
  input: DeviceMediaListArgsSchema.extend({ deviceId: z.string() }),
  output: DeviceMediaListResultSchema,
  permission: 'device.files',
  deadline: 30_000,
  effect: 'read',
  description:
    "What the phone's MediaStore holds, newest first — the read counterpart to push's mediaScan. `truncated` says the device had more rows than the window shows.",
  handler: async (ctx, { deviceId, ...args }) => {
    const value = await ctx.deviceCall(deviceId, { method: 'media.list', args }, 'wall')
    return DeviceMediaListResultSchema.parse(value)
  },
})

export const deviceFsList = defineCapability({
  id: 'device.fs.list',
  input: DeviceFsListArgsSchema.extend({ deviceId: z.string() }),
  output: DeviceFsListResultSchema,
  permission: 'device.files',
  deadline: 30_000,
  effect: 'read',
  description: 'List one level of a directory on the device. Directories first, then files, each alphabetical. Reads are not confined to user storage.',
  handler: async (ctx, { deviceId, ...args }) => {
    const value = await ctx.deviceCall(deviceId, { method: 'fs.list', args }, 'wall')
    return DeviceFsListResultSchema.parse(value)
  },
})

export const deviceFsStat = defineCapability({
  id: 'device.fs.stat',
  input: DeviceFsStatArgsSchema.extend({ deviceId: z.string() }),
  output: DeviceFsStatResultSchema,
  permission: 'device.files',
  deadline: 15_000,
  effect: 'read',
  description: 'One path on the device. `entry` is null when nothing is there — not found is an answer, not an error.',
  handler: async (ctx, { deviceId, ...args }) => {
    const value = await ctx.deviceCall(deviceId, { method: 'fs.stat', args }, 'wall')
    return DeviceFsStatResultSchema.parse(value)
  },
})

export const deviceFsMove = defineCapability({
  id: 'device.fs.move',
  input: DeviceFsMoveArgsSchema.extend({ deviceId: z.string() }),
  output: DeviceFsOkResultSchema,
  permission: 'device.files',
  activity: { kind: 'transfer' },
  deadline: 30_000,
  effect: 'write',
  description:
    'Rename or move a file on the device. Both ends must be under user storage. Refuses to overwrite an existing destination unless overwrite is set.',
  handler: async (ctx, { deviceId, ...args }) => {
    const value = await ctx.deviceCall(deviceId, { method: 'fs.move', args }, 'wall')
    return DeviceFsOkResultSchema.parse(value)
  },
})

export const deviceFsDelete = defineCapability({
  id: 'device.fs.delete',
  input: DeviceFsDeleteArgsSchema.extend({ deviceId: z.string() }),
  output: DeviceFsOkResultSchema,
  permission: 'device.files',
  activity: { kind: 'transfer' },
  deadline: 30_000,
  effect: 'write',
  description:
    'Delete a file on the device, or a directory when recursive is set. Confined to user storage; a storage root itself can never be removed.',
  handler: async (ctx, { deviceId, ...args }) => {
    const value = await ctx.deviceCall(deviceId, { method: 'fs.delete', args }, 'wall')
    return DeviceFsOkResultSchema.parse(value)
  },
})

export const deviceFsMkdir = defineCapability({
  id: 'device.fs.mkdir',
  input: DeviceFsMkdirArgsSchema.extend({ deviceId: z.string() }),
  output: DeviceFsOkResultSchema,
  permission: 'device.files',
  activity: { kind: 'transfer' },
  deadline: 15_000,
  effect: 'write',
  description: 'Create a directory on the device, under user storage. Creates missing parents unless parents is false.',
  handler: async (ctx, { deviceId, ...args }) => {
    const value = await ctx.deviceCall(deviceId, { method: 'fs.mkdir', args }, 'wall')
    return DeviceFsOkResultSchema.parse(value)
  },
})

export const DEVICE_FILES_CAPABILITIES = [
  devicePush,
  devicePull,
  deviceMediaList,
  deviceFsList,
  deviceFsStat,
  deviceFsMove,
  deviceFsDelete,
  deviceFsMkdir,
]
