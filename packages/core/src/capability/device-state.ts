import { z } from 'zod'
import { DeviceInfoSchema, DeviceReadinessSchema } from '@enkaku/protocol'
import { EnkakuError } from '../util/errors'
import { defineCapability } from './types'

/**
 * `device.list`, `.get`, `.wake`, `.sleep` (plan 63 §4.3 table) — farm and
 * device-record operations that never need a session or the manual lease
 * (lease: 'none'): viewing a device's record must work even while it is
 * offline (the same as `GET /api/devices/:id` today), and `readiness.set`
 * already carries its OWN nuanced refusals for wake/sleep (offline,
 * quarantined, a running job, another operator's lease) that are more
 * precise than `invoke`'s generic online check — gating on `isDeviceOnline`
 * here would refuse Wake on an offline device with the wrong reason before
 * `readiness.set` ever got to say `device_offline` itself.
 */

const ListOutput = z.object({ items: z.array(DeviceInfoSchema) })

export const deviceList = defineCapability({
  id: 'device.list',
  input: z.object({}),
  output: ListOutput,
  permission: 'device.view',
  lease: 'none',
  deadline: 5_000,
  effect: 'read',
  description: 'List every device on the farm with its current status, battery, tags, cluster, and readiness.',
  handler: (ctx) => Promise.resolve({ items: ctx.listDevices() }),
})

export const deviceGet = defineCapability({
  id: 'device.get',
  input: z.object({ deviceId: z.string() }),
  output: DeviceInfoSchema,
  permission: 'device.view',
  lease: 'none',
  deadline: 5_000,
  effect: 'read',
  description: 'Get one device by id, including when it is offline.',
  handler: (ctx, { deviceId }) => {
    const device = ctx.getDevice(deviceId)
    if (!device) throw new EnkakuError('device_not_found', `no such device: ${deviceId}`)
    return Promise.resolve(device)
  },
})

const ReadinessSetInput = z.object({ deviceId: z.string() })

export const deviceWake = defineCapability({
  id: 'device.wake',
  input: ReadinessSetInput,
  output: DeviceReadinessSchema,
  permission: 'device.view',
  lease: 'none',
  deadline: 30_000,
  effect: 'write',
  description: 'Set a device\'s desired readiness to "awake" (wakes the screen, keeps it awake). Refuses on an offline or quarantined device.',
  handler: async (ctx, { deviceId }) => {
    if (!ctx.readiness) throw new EnkakuError('E_NOT_SUPPORTED', 'device readiness is not available (orchestrator mode)')
    return ctx.readiness.set(deviceId, 'awake', { userId: ctx.actor?.id ?? null, clientId: null })
  },
})

export const deviceSleep = defineCapability({
  id: 'device.sleep',
  input: ReadinessSetInput,
  output: DeviceReadinessSchema,
  permission: 'device.view',
  lease: 'none',
  deadline: 30_000,
  effect: 'write',
  description: 'Set a device\'s desired readiness to "asleep". Refuses while a job is running or another operator holds the lease.',
  handler: async (ctx, { deviceId }) => {
    if (!ctx.readiness) throw new EnkakuError('E_NOT_SUPPORTED', 'device readiness is not available (orchestrator mode)')
    return ctx.readiness.set(deviceId, 'asleep', { userId: ctx.actor?.id ?? null, clientId: null })
  },
})

export const DEVICE_STATE_CAPABILITIES = [deviceList, deviceGet, deviceWake, deviceSleep]
