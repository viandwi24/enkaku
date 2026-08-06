import { z } from 'zod'
import { AppForceStopArgsSchema, AppLaunchArgsSchema, InstallArgsSchema, InstallResultSchema } from '@enkaku/protocol'
import { defineCapability } from './types'

/** `device.app.launch`, `device.app.forceStop`, `device.install` (plan 63
 * §4.3 table) — one-line delegations to `ctx.deviceCall`, the same executor
 * a script's `ctx.device.app.*`/`ctx.device.install` runs through. */

const OkOutput = z.object({ ok: z.literal(true) })

export const deviceAppLaunch = defineCapability({
  id: 'device.app.launch',
  input: AppLaunchArgsSchema.extend({ deviceId: z.string() }),
  output: OkOutput,
  permission: 'device.control',
  lease: 'control',
  deadline: 10_000,
  effect: 'write',
  description: 'Launch an app by package name (optionally a specific activity). Does not confirm the app actually opened.',
  handler: async (ctx, { deviceId, ...args }) => {
    await ctx.deviceCall(deviceId, { method: 'app.launch', args })
    return { ok: true as const }
  },
})

export const deviceAppForceStop = defineCapability({
  id: 'device.app.forceStop',
  input: AppForceStopArgsSchema.extend({ deviceId: z.string() }),
  output: OkOutput,
  permission: 'device.control',
  lease: 'control',
  deadline: 10_000,
  effect: 'write',
  description: 'Force-stop an app by package name.',
  handler: async (ctx, { deviceId, ...args }) => {
    await ctx.deviceCall(deviceId, { method: 'app.forceStop', args })
    return { ok: true as const }
  },
})

export const deviceInstall = defineCapability({
  id: 'device.install',
  input: InstallArgsSchema.extend({ deviceId: z.string() }),
  output: InstallResultSchema,
  permission: 'device.files',
  lease: 'control',
  deadline: 120_000,
  effect: 'destructive',
  description:
    'Install an APK already uploaded as an artifact (artifactId, never a client URL). Reinstalls and grants ' +
    'runtime permissions by default. Hard or impossible to undo cleanly — treat as destructive.',
  handler: async (ctx, { deviceId, ...args }) => {
    const value = await ctx.deviceCall(deviceId, { method: 'install', args })
    return InstallResultSchema.parse(value)
  },
})

export const DEVICE_APP_CAPABILITIES = [deviceAppLaunch, deviceAppForceStop, deviceInstall]
