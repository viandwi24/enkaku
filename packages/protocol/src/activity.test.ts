import { describe, expect, test } from 'bun:test'
import {
  ActivityKindSchema,
  DeviceActivityMessage,
  DeviceActivityWarningMessage,
  PolicyDecisionSchema,
  deviceState,
  type DeviceActivity,
} from './activity'
import { DeviceStatusSchema } from './device'

const ALL_KINDS = ActivityKindSchema.options

describe('ActivityKindSchema (MVP 04 §1.1)', () => {
  test('every declared kind parses', () => {
    for (const kind of ALL_KINDS) {
      expect(ActivityKindSchema.parse(kind)).toBe(kind)
    }
  })

  test('an unknown kind fails — the enum is closed for now (MVP 04 §5 item 3, §9 Q2)', () => {
    expect(ActivityKindSchema.safeParse('plugin-thing').success).toBe(false)
  })
})

function activity(overrides: Partial<DeviceActivity> = {}): DeviceActivity {
  return {
    id: 'control:client-1',
    kind: 'control',
    label: 'Controlled by Rina',
    actor: { kind: 'user', id: 'client-1', label: 'Rina' },
    startedAt: 1_700_000_000,
    updatedAt: 1_700_000_000,
    ...overrides,
  }
}

describe('DeviceActivityMessage', () => {
  test('round-trips without href/meta', () => {
    const payload = { deviceId: 'd1', change: 'added' as const, activity: activity(), lastControl: null }
    expect(DeviceActivityMessage.parse({ type: 'device.activity', payload })).toEqual({ type: 'device.activity', payload })
  })

  test('round-trips with href and meta', () => {
    const payload = {
      deviceId: 'd1',
      change: 'updated' as const,
      activity: activity({ href: '/jobs/detail?id=482', meta: { progress: 40 } }),
      lastControl: null,
    }
    expect(DeviceActivityMessage.parse({ type: 'device.activity', payload })).toEqual({ type: 'device.activity', payload })
  })

  test('carries a lastControl tail on an ended change', () => {
    const payload = {
      deviceId: 'd1',
      change: 'ended' as const,
      activity: activity(),
      lastControl: { actor: { kind: 'user' as const, id: 'client-1', label: 'Rina' }, endedAt: 1_700_000_030 },
    }
    expect(DeviceActivityMessage.parse({ type: 'device.activity', payload }).payload.lastControl).toEqual(payload.lastControl)
  })
})

describe('DeviceActivityWarningMessage', () => {
  test('round-trips', () => {
    const payload = { deviceId: 'd1', message: 'Running tiktok/login (job #482); your taps will interfere', conflicting: activity({ kind: 'job', id: 'job:482' }) }
    expect(DeviceActivityWarningMessage.parse({ type: 'device.activity.warning', payload })).toEqual({ type: 'device.activity.warning', payload })
  })
})

describe('PolicyDecisionSchema', () => {
  test('accepts all three decisions', () => {
    expect(PolicyDecisionSchema.parse({ decision: 'allow', message: '' }).decision).toBe('allow')
    expect(PolicyDecisionSchema.parse({ decision: 'warn', message: 'x' }).decision).toBe('warn')
    expect(PolicyDecisionSchema.parse({ decision: 'forbid', message: 'x', conflicting: activity() }).decision).toBe('forbid')
  })
})

describe('DeviceStatusSchema (MVP 04 §0.1, §4)', () => {
  test('accepts exactly offline, online, quarantined', () => {
    expect(DeviceStatusSchema.parse('offline')).toBe('offline')
    expect(DeviceStatusSchema.parse('online')).toBe('online')
    expect(DeviceStatusSchema.parse('quarantined')).toBe('quarantined')
  })

  test('rejects the deleted single-slot values idle, manual, busy', () => {
    expect(DeviceStatusSchema.safeParse('idle').success).toBe(false)
    expect(DeviceStatusSchema.safeParse('manual').success).toBe(false)
    expect(DeviceStatusSchema.safeParse('busy').success).toBe(false)
  })
})

/**
 * `deviceState` (MVP 15 §1's state-dot mapping) moved here from
 * `packages/studio/src/lib/activity.ts` by plan 205's §12 amendment — Studio
 * has zero tests (plan 200 §8.3), so the pure function is exercised beside
 * the schemas it reads instead.
 */
describe('deviceState (MVP 15 §1)', () => {
  const base = { status: 'online' as const, activities: [] as DeviceActivity[] }

  test('offline device is offline, regardless of activities', () => {
    expect(deviceState({ status: 'offline', activities: [activity({ kind: 'job', id: 'job:1' })] })).toBe('offline')
  })

  test('quarantined device is warn', () => {
    expect(deviceState({ status: 'quarantined', activities: [] })).toBe('warn')
  })

  test('a live job or workflow-job activity is job', () => {
    expect(deviceState({ ...base, activities: [activity({ kind: 'job', id: 'job:1' })] })).toBe('job')
    expect(deviceState({ ...base, activities: [activity({ kind: 'workflow-job', id: 'workflow-job:1' })] })).toBe('job')
  })

  test('a live control marker with no job is controlled', () => {
    expect(deviceState({ ...base, activities: [activity()] })).toBe('controlled')
  })

  test('online with no activities is free', () => {
    expect(deviceState(base)).toBe('free')
  })
})
