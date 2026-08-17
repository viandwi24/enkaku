import { describe, expect, test } from 'bun:test'
import { computeDefaultTarget } from './useTargetSelection'

/**
 * Plan 104 (M69) §3.2's own table, tested directly against the pure
 * function `useTargetSelection.reset()` calls — no component mount needed
 * for the defaulting RULE itself; `TargetPicker.test.tsx` covers the
 * rendered, always-visible count on top of it.
 */
describe('computeDefaultTarget — plan 104 §3.2', () => {
  test('nothing selected: a device popup targets its own device, single', () => {
    const d = computeDefaultTarget({
      devices: [{ id: 'a' }, { id: 'b' }],
      allow: ['single', 'cluster', 'devices'],
      initialDeviceId: 'b',
    })
    expect(d).toEqual({ mode: 'single', deviceId: 'b' })
  })

  test('N devices selected: a device popup arrives pre-filled with them, devices mode', () => {
    const d = computeDefaultTarget({
      devices: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
      allow: ['single', 'cluster', 'devices'],
      initialDeviceId: 'a',
      initialSelectedIds: ['a', 'b', 'c'],
    })
    expect(d).toEqual({ mode: 'devices', deviceIds: ['a', 'b', 'c'] })
  })

  test('a live selection wins over an explicit single device when both are present', () => {
    const d = computeDefaultTarget({
      devices: [{ id: 'a' }, { id: 'b' }],
      allow: ['single', 'cluster', 'devices'],
      initialDeviceId: 'a',
      initialSelectedIds: ['a', 'b'],
    })
    expect(d.mode).toBe('devices')
  })

  test('a fleet toolbar with a selection pre-fills devices mode, with no explicit single device at all', () => {
    const d = computeDefaultTarget({
      devices: [{ id: 'a' }, { id: 'b' }],
      allow: ['single', 'devices'],
      initialSelectedIds: ['a', 'b'],
    })
    expect(d).toEqual({ mode: 'devices', deviceIds: ['a', 'b'] })
  })

  test('a cluster screen defaults to that cluster', () => {
    const d = computeDefaultTarget({
      devices: [{ id: 'a' }],
      allow: ['single', 'cluster', 'devices'],
      initialClusterId: 'cl-1',
    })
    expect(d).toEqual({ mode: 'cluster', clusterId: 'cl-1' })
  })

  test('a selection is ignored when the action does not allow devices mode at all', () => {
    const d = computeDefaultTarget({
      devices: [{ id: 'a' }, { id: 'b' }],
      allow: ['single', 'cluster'],
      initialDeviceId: 'a',
      initialSelectedIds: ['a', 'b'],
    })
    expect(d).toEqual({ mode: 'single', deviceId: 'a' })
  })

  test('no context at all falls back to the first ready device', () => {
    const d = computeDefaultTarget({
      devices: [{ id: 'a' }, { id: 'b' }],
      readyNow: [{ id: 'b' }],
      allow: ['single', 'cluster', 'devices'],
    })
    expect(d).toEqual({ mode: 'single', deviceId: 'b' })
  })

  test('an explicit device wins even when offline (absent from readyNow), as long as it is still in the pool', () => {
    const d = computeDefaultTarget({
      devices: [{ id: 'a' }, { id: 'b' }],
      readyNow: [{ id: 'b' }],
      allow: ['single', 'cluster', 'devices'],
      initialDeviceId: 'a',
    })
    expect(d).toEqual({ mode: 'single', deviceId: 'a' })
  })

  test('duplicate ids in a live selection collapse to one', () => {
    const d = computeDefaultTarget({
      devices: [{ id: 'a' }],
      allow: ['devices'],
      initialSelectedIds: ['a', 'a', 'b'],
    })
    expect(d.deviceIds).toEqual(['a', 'b'])
  })

  test('single not allowed at all falls back to the first allowed mode, empty', () => {
    const d = computeDefaultTarget({ devices: [{ id: 'a' }], allow: ['cluster', 'devices'] })
    expect(d).toEqual({ mode: 'cluster', clusterId: '' })
  })
})
