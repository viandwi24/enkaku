import { describe, expect, test } from 'bun:test'
import type { DeviceActivity, LastControl } from '@enkaku/protocol'
import { createActivityRegistry, LAST_CONTROL_TAIL_SEC } from './registry'
import { createLogger } from '../util/logger'

function fakeClock(startMs: number) {
  let ms = startMs
  return {
    now: () => ms,
    advanceSec: (sec: number) => {
      ms += sec * 1_000
    },
  }
}

function harness(startMs = 1_700_000_000_000, controlIdleSec = 30) {
  const clock = fakeClock(startMs)
  const events: Array<{ deviceId: string; change: string; activity: DeviceActivity; lastControl: LastControl | null }> = []
  const registry = createActivityRegistry({
    log: createLogger('test'),
    controlIdleSec: () => controlIdleSec,
    onChange: (deviceId, change, activity, lastControl) => events.push({ deviceId, change, activity, lastControl }),
    now: clock.now,
  })
  return { registry, events, clock }
}

describe('touchControl (MVP 04 §1.2)', () => {
  test('a first touchControl adds one marker labelled "Controlled by <label>"', () => {
    const { registry, events } = harness()
    const activity = registry.touchControl('d1', 'client-1', { kind: 'user', id: 'client-1', label: 'Rina' })
    expect(activity.label).toBe('Controlled by Rina')
    expect(activity.kind).toBe('control')
    expect(events).toHaveLength(1)
    expect(events[0]?.change).toBe('added')
  })

  test('a second touchControl 10s later fires updated and keeps one marker', () => {
    const { registry, events, clock } = harness()
    registry.touchControl('d1', 'client-1', { kind: 'user', id: 'client-1', label: 'Rina' })
    clock.advanceSec(10)
    registry.touchControl('d1', 'client-1', { kind: 'user', id: 'client-1', label: 'Rina' })
    expect(registry.liveControls('d1')).toHaveLength(1)
    expect(events).toHaveLength(2)
    expect(events[1]?.change).toBe('updated')
  })

})

describe('start / end (MVP 04 §1.1)', () => {
  test('start twice with the same id is one entry', () => {
    const { registry } = harness()
    registry.start('d1', { id: 'job:1', kind: 'job', label: 'Running x', actor: { kind: 'system', id: 'core', label: 'Scheduler' } })
    registry.start('d1', { id: 'job:1', kind: 'job', label: 'Running x (attempt 2)', actor: { kind: 'system', id: 'core', label: 'Scheduler' } })
    expect(registry.list('d1')).toHaveLength(1)
    expect(registry.list('d1')[0]?.label).toBe('Running x (attempt 2)')
  })

  test('end on a control activity records a lastControl tail', () => {
    const { registry } = harness()
    registry.touchControl('d1', 'client-1', { kind: 'user', id: 'client-1', label: 'Rina' })
    const ended = registry.end('d1', 'control:client-1')
    expect(ended).toBe(true)
    expect(registry.lastControl('d1')?.actor.label).toBe('Rina')
  })

  test('end on a non-control activity records no tail', () => {
    const { registry } = harness()
    registry.start('d1', { id: 'job:1', kind: 'job', label: 'Running x', actor: { kind: 'system', id: 'core', label: 'Scheduler' } })
    registry.end('d1', 'job:1')
    expect(registry.lastControl('d1')).toBeNull()
  })

  test('endWhere ends only matching ids', () => {
    const { registry } = harness()
    registry.touchControl('d1', 'client-1', { kind: 'user', id: 'client-1', label: 'Rina' })
    registry.start('d1', { id: 'command:client-1', kind: 'command', label: 'Running an adb command', actor: { kind: 'user', id: 'client-1', label: 'Rina' } })
    registry.start('d1', { id: 'job:1', kind: 'job', label: 'Running x', actor: { kind: 'system', id: 'core', label: 'Scheduler' } })
    const n = registry.endWhere((_, a) => a.kind === 'control' || a.kind === 'command')
    expect(n).toBe(2)
    expect(registry.list('d1')).toHaveLength(1)
    expect(registry.list('d1')[0]?.kind).toBe('job')
  })
})

describe('rebuild (boot projection)', () => {
  test('projects a running job, an install transfer and a provisioning component, firing no onChange', () => {
    const { registry, events } = harness()
    registry.rebuild({
      runningJobs: () => [{ id: 'j1', deviceId: 'd1', label: 'Running tiktok/login', startedAt: 1_700_000_000 }],
      transfers: () => [{ deviceId: 'd1', transferId: 't1', kind: 'install', label: 'Installing app.apk', startedAt: 1_700_000_000 }],
      preparing: () => [{ deviceId: 'd1', component: 'ui-server', since: 1_700_000_000 }],
    })
    expect(events).toHaveLength(0)
    const list = registry.list('d1')
    expect(list.map((a) => a.id).sort()).toEqual(['job:j1', 'prep:ui-server', 'transfer:t1'])
    const transfer = list.find((a) => a.id === 'transfer:t1')
    expect(transfer?.kind).toBe('install')
  })

  test('devicesWith("install") lists the device', () => {
    const { registry } = harness()
    registry.rebuild({
      runningJobs: () => [],
      transfers: () => [{ deviceId: 'd1', transferId: 't1', kind: 'install', label: 'Installing app.apk', startedAt: 1_700_000_000 }],
      preparing: () => [],
    })
    expect(registry.devicesWith('install')).toEqual(['d1'])
  })
})

describe('sweep expiry (fake clock, real interval)', () => {
  test('a control marker expires controlIdleSec after its last input, and the tail expires LAST_CONTROL_TAIL_SEC later', async () => {
    let ms = 1_700_000_000_000
    const events: Array<{ change: string; lastControl: LastControl | null }> = []
    const registry = createActivityRegistry({
      log: createLogger('test'),
      controlIdleSec: () => 30,
      onChange: (_d, change, _a, lastControl) => events.push({ change, lastControl }),
      now: () => ms,
    })
    registry.touchControl('d1', 'client-1', { kind: 'user', id: 'client-1', label: 'Rina' })
    ms += 30_000
    registry.startSweep()
    // Let the 1s-interval sweep tick at least once.
    await new Promise((r) => setTimeout(r, 1_100))
    registry.stopSweep()
    expect(registry.liveControls('d1')).toHaveLength(0)
    const ended = events.find((e) => e.change === 'ended')
    expect(ended?.lastControl?.actor.label).toBe('Rina')
    expect(registry.lastControl('d1')?.actor.label).toBe('Rina')

    // Advance past the tail window and sweep again.
    ms += LAST_CONTROL_TAIL_SEC * 1_000
    registry.startSweep()
    await new Promise((r) => setTimeout(r, 1_100))
    registry.stopSweep()
    expect(registry.lastControl('d1')).toBeNull()
  }, 10_000)
})
