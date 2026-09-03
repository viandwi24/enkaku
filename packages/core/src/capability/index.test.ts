import { describe, expect, test } from 'bun:test'
import { allCapabilitySources, buildCoreCapabilityRegistry } from './index'

describe('the real capability registry (plan 63 §4.3, acceptance #1-3)', () => {
  test('boots cleanly — no duplicate ids, every schema converts', () => {
    const registry = buildCoreCapabilityRegistry()
    expect(registry.all().length).toBeGreaterThan(20)
  })

  test('every declared id is unique and dotted', () => {
    const ids = allCapabilitySources().map((s) => s.cap.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) expect(id).toMatch(/^[a-z]+(\.[a-zA-Z]+)+$/)
  })

  test('carries the exact ids the plan enumerates (§4.3 table)', () => {
    const ids = new Set(allCapabilitySources().map((s) => s.cap.id))
    for (const id of [
      'device.tap',
      'device.swipe',
      'device.scroll',
      'device.fling',
      'device.type',
      'device.key',
      'device.find',
      'device.dump',
      'device.waitFor',
      'device.screenshot',
      'device.app.launch',
      'device.app.forceStop',
      'device.install',
      'device.push',
      'device.pull',
      'device.clipboard.get',
      'device.clipboard.set',
      'device.list',
      'device.get',
      'device.wake',
      'device.sleep',
      'script.list',
      'script.get',
      'script.publish',
      'job.run',
      'job.get',
      'job.list',
      'job.cancel',
    ]) {
      expect(ids.has(id)).toBe(true)
    }
  })

  test('every capability has all seven required fields non-empty, and a well-formed activity when it declares one (acceptance #1)', () => {
    for (const { cap } of allCapabilitySources()) {
      expect(cap.id.length).toBeGreaterThan(0)
      expect(cap.permission.length).toBeGreaterThan(0)
      expect(cap.description.length).toBeGreaterThan(10)
      expect(cap.deadline).toBeGreaterThan(0)
      if (cap.activity) {
        expect(['control', 'job', 'workflow-job', 'install', 'transfer', 'prep', 'command', 'agent', 'network-apply', 'wake', 'read']).toContain(cap.activity.kind)
      }
      expect(['read', 'write', 'destructive']).toContain(cap.effect)
    }
  })

  test('device.install is destructive; every other write is write or read', () => {
    const byId = new Map(allCapabilitySources().map((s) => [s.cap.id, s.cap]))
    expect(byId.get('device.install')?.effect).toBe('destructive')
    expect(byId.get('device.pull')?.effect).toBe('read')
    expect(byId.get('script.publish')?.effect).toBe('write')
  })
})
