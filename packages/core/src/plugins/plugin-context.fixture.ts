import { z } from 'zod'
import type { PluginContext } from '@enkaku/sdk'

/**
 * Plan 109 (M74) acceptance criterion 2's fixture — **one exported function,
 * called from a script handler and from an HTTP handler.**
 *
 * This is deliberately a separate module rather than a closure inside the
 * test: the whole claim is that a plugin author writes a helper ONCE, imports
 * it from both of their handlers, and does not have to know which one is
 * calling it. A helper defined inside the test that asserts it would not be
 * that.
 *
 * It touches all three shared members — `storage` (both scopes), `log`, and
 * `farm` — and nothing else. It never asks which entry point it is running
 * in, and there is no branch in it that could.
 */

export const CounterSchema = z.object({ runs: z.number().int() })
export type Counter = z.infer<typeof CounterSchema>

export const DeviceListSchema = z.array(z.object({ id: z.string() }))

export interface RunRecord {
  runs: number
  total: number
  devices: string[]
}

export async function recordRun(ctx: PluginContext, deviceId: string): Promise<RunRecord> {
  ctx.log.info('recording a run', { deviceId })

  const scoped = ctx.storage.forDevice(deviceId)
  const before = await scoped.get('counter', CounterSchema)
  const next: Counter = { runs: (before?.runs ?? 0) + 1 }
  await scoped.set('counter', next)

  const total = await ctx.storage.global.increment('total', 1)
  const devices = await ctx.farm.call('device.list', {}, DeviceListSchema)

  ctx.log.debug('recorded', { runs: next.runs, total })
  return { runs: next.runs, total, devices: devices.map((d) => d.id) }
}
