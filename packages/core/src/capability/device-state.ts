import { z } from 'zod'
import { DeviceInfoSchema, DeviceReadinessSchema } from '@enkaku/protocol'
import { EnkakuError } from '../util/errors'
import { defineCapability } from './types'

/**
 * `device.list`, `.get`, `.wake`, `.sleep` (plan 63 §4.3 table) — farm and
 * device-record operations that mostly never need a session (no `activity`
 * field): viewing a device's record must work even while it is offline (the
 * same as `GET /api/devices/:id` today), and `readiness.set` already
 * carries its OWN nuanced refusals for sleep (offline, quarantined, a
 * running job, another operator's control marker) that are more precise
 * than `invoke`'s generic online check. `device.wake` is the one exception
 * (plan 205 §4.10): it declares `activity: { kind: 'wake' }` so `invoke`
 * wraps the wake sequence in a `wake:<deviceId>` marker other viewers can
 * see, at the cost of a generic `E_DEVICE_OFFLINE` (rather than
 * `readiness.set`'s own nuanced one) on a device that is not online — waking
 * a truly disconnected device was never meaningful anyway.
 */

const ListOutput = z.object({ items: z.array(DeviceInfoSchema) })

export const deviceList = defineCapability({
  id: 'device.list',
  input: z.object({}),
  output: ListOutput,
  permission: 'device.view',
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
  activity: { kind: 'wake' },
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
  deadline: 30_000,
  effect: 'write',
  description: 'Set a device\'s desired readiness to "asleep". Refuses while a job is running or another operator is controlling the device.',
  handler: async (ctx, { deviceId }) => {
    if (!ctx.readiness) throw new EnkakuError('E_NOT_SUPPORTED', 'device readiness is not available (orchestrator mode)')
    return ctx.readiness.set(deviceId, 'asleep', { userId: ctx.actor?.id ?? null, clientId: null })
  },
})

export const DEVICE_STATE_CAPABILITIES = [deviceList, deviceGet, deviceWake, deviceSleep]
