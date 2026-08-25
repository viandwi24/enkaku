import { describe, expect, test } from 'bun:test'
import type { DeviceInfo } from '@enkaku/protocol'
import { computeTargetPreview, describeCommandTarget, matchesTarget } from './target-preview'

function device(overrides: Partial<DeviceInfo> = {}): DeviceInfo {
  return {
    id: 'dev-1',
    stableId: 'stable-1',
    label: 'Pixel 6',
    status: 'idle',
    tags: [],
    cluster: null,
    heldBy: null,
    assistedBy: [],
    battery: null,
    lastCrashAt: null,
    readiness: 'awake',
    connection: { medium: 'USB' },
    agent: 'absent',
    ...overrides,
  } as unknown as DeviceInfo
}

describe('matchesTarget', () => {
  test('deviceIds — exact membership', () => {
    const d = device({ id: 'a' })
    expect(matchesTarget(d, { deviceIds: ['a', 'b'] })).toBe(true)
    expect(matchesTarget(d, { deviceIds: ['b'] })).toBe(false)
  })

  test('clusterId — the device must belong to that cluster', () => {
    const d = device({ cluster: { id: 'c1', name: 'Rack A' } })
    expect(matchesTarget(d, { clusterId: 'c1' })).toBe(true)
    expect(matchesTarget(d, { clusterId: 'c2' })).toBe(false)
    expect(matchesTarget(device(), { clusterId: 'c1' })).toBe(false)
  })

  test('tags — AND semantics, matching the server\'s resolveTarget', () => {
    const d = device({ tags: ['pool:smoke', 'rack:a'] })
    expect(matchesTarget(d, { tags: ['pool:smoke'] })).toBe(true)
    expect(matchesTarget(d, { tags: ['pool:smoke', 'rack:a'] })).toBe(true)
    expect(matchesTarget(d, { tags: ['pool:smoke', 'rack:b'] })).toBe(false)
  })
})

describe('computeTargetPreview', () => {
  test('null target — an empty preview, not a crash', () => {
    const preview = computeTargetPreview([device()], null, 's1')
    expect(preview.matched).toEqual([])
    expect(preview.willAttempt).toEqual([])
  })

  test('offline and quarantined devices are excluded, with the exact resolveTarget reason words', () => {
    const devices = [
      device({ id: 'a', status: 'idle' }),
      device({ id: 'b', status: 'offline' }),
      device({ id: 'c', status: 'quarantined' }),
    ]
    const preview = computeTargetPreview(devices, { deviceIds: ['a', 'b', 'c'] }, null)
    expect(preview.willAttempt.map((d) => d.id)).toEqual(['a'])
    expect(preview.excluded).toEqual([
      { device: devices[1], reason: 'offline' },
      { device: devices[2], reason: 'quarantined' },
    ])
  })

  test('a busy device is attempted, with a caution — never promised either way', () => {
    const busy = device({ id: 'b', status: 'busy' })
    const preview = computeTargetPreview([busy], { deviceIds: ['b'] }, null)
    expect(preview.willAttempt.map((d) => d.id)).toEqual(['b'])
    expect(preview.caution).toHaveLength(1)
    expect(preview.caution[0]?.reason).toContain('automation job')
  })

  test('a device held by someone else is attempted, with a caution naming who', () => {
    const held = device({
      id: 'm',
      status: 'manual',
      heldBy: { kind: 'user', id: 'other-session', label: 'bea', runId: null, takeable: true, acquiredAt: 0, expiresAt: null },
    })
    const preview = computeTargetPreview([held], { deviceIds: ['m'] }, 'my-session')
    expect(preview.willAttempt.map((d) => d.id)).toEqual(['m'])
    expect(preview.caution[0]?.reason).toContain('bea')
  })

  test('a device the operator already holds is NOT cautioned — they already control it', () => {
    const heldByMe = device({
      id: 'm',
      status: 'manual',
      heldBy: { kind: 'user', id: 'my-session', label: 'me', runId: null, takeable: true, acquiredAt: 0, expiresAt: null },
    })
    const preview = computeTargetPreview([heldByMe], { deviceIds: ['m'] }, 'my-session')
    expect(preview.willAttempt.map((d) => d.id)).toEqual(['m'])
    expect(preview.caution).toEqual([])
  })
})

describe('describeCommandTarget', () => {
  test('a cluster resolves to its name when known, else its raw id', () => {
    const clusters = [{ id: 'c1', name: 'Rack A', description: null, createdAt: 0, deviceCount: 3, usableCount: 3 }]
    expect(describeCommandTarget({ clusterId: 'c1' }, [], clusters)).toBe('cluster Rack A')
    expect(describeCommandTarget({ clusterId: 'c9' }, [], clusters)).toBe('cluster c9')
  })

  test('tags join as-is', () => {
    expect(describeCommandTarget({ tags: ['pool:smoke', 'rack:a'] }, [], [])).toBe('pool:smoke, rack:a')
  })

  test('device ids resolve to labels, capped at three plus a count', () => {
    const devices = [device({ id: 'a', label: 'A' }), device({ id: 'b', label: 'B' })]
    expect(describeCommandTarget({ deviceIds: ['a', 'b'] }, devices, [])).toBe('A, B')
    expect(describeCommandTarget({ deviceIds: ['a', 'b', 'x', 'y'] }, devices, [])).toBe('A, B, x +1 more')
  })

  /**
   * Plan 124 §4.4 Group D, §3.2, criterion 6, step 124.4 — this summary is
   * what a command-history row and a saved command are LABELLED with, so two
   * identically modelled phones produced two history rows an operator could
   * not tell apart. It is a `.join(', ')` sentence, hence the `string` form of
   * the rule rather than `<DeviceName>`.
   */
  test('each device name carries its number (plan 124 §4.4)', () => {
    const devices = [
      device({ id: 'a', label: 'SM-F721U1', number: 7 } as Partial<DeviceInfo>),
      device({ id: 'b', label: 'SM-F721U1', number: 12 } as Partial<DeviceInfo>),
    ]
    expect(describeCommandTarget({ deviceIds: ['a', 'b'] }, devices, [])).toBe('#7 SM-F721U1, #12 SM-F721U1')
  })

  test('a device with no number keeps its bare label — no stray "#", no "#null" (criterion 7)', () => {
    const devices = [device({ id: 'a', label: 'A', number: null } as Partial<DeviceInfo>), device({ id: 'b', label: 'B', number: 3 } as Partial<DeviceInfo>)]
    expect(describeCommandTarget({ deviceIds: ['a', 'b'] }, devices, [])).toBe('A, #3 B')
  })

  test('an id no loaded device answers to stays a bare id — never "#undefined"', () => {
    const devices = [device({ id: 'a', label: 'A', number: 7 } as Partial<DeviceInfo>)]
    expect(describeCommandTarget({ deviceIds: ['a', 'gone'] }, devices, [])).toBe('#7 A, gone')
  })

  test('the cluster and tag branches are untouched — neither names a device', () => {
    const clusters = [{ id: 'c1', name: 'Rack A', description: null, createdAt: 0, deviceCount: 3, usableCount: 3 }]
    expect(describeCommandTarget({ clusterId: 'c1' }, [device({ id: 'a', number: 7 } as Partial<DeviceInfo>)], clusters)).toBe('cluster Rack A')
    expect(describeCommandTarget({ tags: ['pool:smoke'] }, [device({ id: 'a', number: 7 } as Partial<DeviceInfo>)], [])).toBe('pool:smoke')
  })
})
