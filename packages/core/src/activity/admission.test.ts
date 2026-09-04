import { describe, expect, test } from 'bun:test'
import type { DeviceActivity, DeviceStatus } from '@enkaku/protocol'
import { E_DEVICE_CONFLICT } from '@enkaku/protocol'
import { requireAdmission } from './admission'
import type { ControlPolicySettings } from './policy'

const ALLOW: ControlPolicySettings = { overControl: 'allow', idleSec: 30 }

function fakeStates(status: DeviceStatus | null) {
  return { current: (_deviceId: string) => status }
}

function fakeActivities(list: DeviceActivity[]) {
  return { list: (_deviceId: string) => list }
}

describe('requireAdmission (plan 205 §4.9)', () => {
  test('an unknown device throws device_not_found', () => {
    let threw: unknown
    try {
      requireAdmission(fakeActivities([]), () => ALLOW, fakeStates(null), 'd1', 'control')
    } catch (e) {
      threw = e
    }
    expect((threw as { code?: string } | undefined)?.code).toBe('device_not_found')
  })

  test('an offline device throws device_unavailable', () => {
    let threw: unknown
    try {
      requireAdmission(fakeActivities([]), () => ALLOW, fakeStates('offline'), 'd1', 'control')
    } catch (e) {
      threw = e
    }
    expect((threw as { code?: string } | undefined)?.code).toBe('device_unavailable')
  })

  test('a forbid decision throws E_DEVICE_CONFLICT', () => {
    const job: DeviceActivity = {
      id: 'job:1',
      kind: 'job',
      label: 'Running x',
      actor: { kind: 'system', id: 'core', label: 'Scheduler' },
      startedAt: 1,
      updatedAt: 1,
    }
    let threw: unknown
    try {
      requireAdmission(fakeActivities([job]), () => ALLOW, fakeStates('online'), 'd1', 'install')
    } catch (e) {
      threw = e
    }
    expect(threw).toBeInstanceOf(Error)
    expect((threw as { code?: string }).code).toBe(E_DEVICE_CONFLICT)
  })

  test('a warn decision returns { warning } instead of throwing', () => {
    const command: DeviceActivity = {
      id: 'command:c1',
      kind: 'command',
      label: 'Running an adb command',
      actor: { kind: 'user', id: 'c1', label: 'Rina' },
      startedAt: 1,
      updatedAt: 1,
    }
    const result = requireAdmission(fakeActivities([command]), () => ALLOW, fakeStates('online'), 'd1', 'job')
    expect(result.warning).not.toBeNull()
  })

  test('an allow decision returns { warning: null }', () => {
    const result = requireAdmission(fakeActivities([]), () => ALLOW, fakeStates('online'), 'd1', 'transfer')
    expect(result.warning).toBeNull()
  })
})
