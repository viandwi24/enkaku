import { describe, expect, test } from 'bun:test'
import { createDevSlotStore } from './dev-slots'

function owner(label = '/scripts/tiktok') {
  return { kind: 'workspace' as const, label }
}

describe('DevSlotStore', () => {
  test('put creates a slot with build.1 and stamps the version +dev.1', () => {
    const store = createDevSlotStore()
    const slot = store.put({
      pluginName: 'tiktok',
      declaredVersion: '1.0.0',
      bundlePath: '/tmp/tiktok.mjs',
      scripts: [{ exportId: 'login', paramsSchema: {} }],
      owner: owner(),
    })
    expect(slot.buildN).toBe(1)
    expect(slot.buildVersion).toBe('1.0.0+dev.1')
    expect(store.get('tiktok')).toEqual(slot)
  })

  test('hot reload is slot replacement — a second put increments buildN and overwrites (plan 82 §3.5)', () => {
    const store = createDevSlotStore()
    store.put({ pluginName: 'tiktok', declaredVersion: '1.0.0', bundlePath: '/tmp/a.mjs', scripts: [], owner: owner() })
    const second = store.put({ pluginName: 'tiktok', declaredVersion: '1.0.0', bundlePath: '/tmp/b.mjs', scripts: [], owner: owner() })
    expect(second.buildN).toBe(2)
    expect(second.buildVersion).toBe('1.0.0+dev.2')
    expect(store.get('tiktok')?.bundlePath).toBe('/tmp/b.mjs')
    expect(store.list()).toHaveLength(1)
  })

  test('putFailed records the error without dropping the last good build', () => {
    const store = createDevSlotStore()
    store.put({ pluginName: 'tiktok', declaredVersion: '1.0.0', bundlePath: '/tmp/a.mjs', scripts: [], owner: owner() })
    store.putFailed('tiktok', 'SyntaxError: unexpected token')
    const slot = store.get('tiktok')
    expect(slot?.lastBuildOk).toBe(false)
    expect(slot?.lastError).toContain('SyntaxError')
    expect(slot?.bundlePath).toBe('/tmp/a.mjs') // still runnable
  })

  test('putFailed on a plugin with no slot is a no-op', () => {
    const store = createDevSlotStore()
    expect(() => store.putFailed('nope', 'boom')).not.toThrow()
    expect(store.get('nope')).toBeNull()
  })

  test('drop removes the slot and resets its build counter (criterion 19 precondition)', () => {
    const store = createDevSlotStore()
    store.put({ pluginName: 'tiktok', declaredVersion: '1.0.0', bundlePath: '/tmp/a.mjs', scripts: [], owner: owner() })
    expect(store.drop('tiktok')).toBe(true)
    expect(store.get('tiktok')).toBeNull()
    expect(store.drop('tiktok')).toBe(false)
    const fresh = store.put({ pluginName: 'tiktok', declaredVersion: '1.0.0', bundlePath: '/tmp/c.mjs', scripts: [], owner: owner() })
    expect(fresh.buildN).toBe(1) // counter reset after a drop
  })

  test('sweep drops only expired slots', () => {
    let t = 1_000
    const store = createDevSlotStore({ ttlSec: 10, now: () => t })
    store.put({ pluginName: 'a', declaredVersion: '1.0.0', bundlePath: '/tmp/a.mjs', scripts: [], owner: owner() })
    t += 20
    store.put({ pluginName: 'b', declaredVersion: '1.0.0', bundlePath: '/tmp/b.mjs', scripts: [], owner: owner() })
    const dropped = store.sweep()
    expect(dropped).toBe(1)
    expect(store.get('a')).toBeNull()
    expect(store.get('b')).not.toBeNull()
  })

  test('touch extends a slot past what sweep would otherwise drop', () => {
    let t = 1_000
    const store = createDevSlotStore({ ttlSec: 10, now: () => t })
    store.put({ pluginName: 'a', declaredVersion: '1.0.0', bundlePath: '/tmp/a.mjs', scripts: [], owner: owner() })
    t += 5
    store.touch('a')
    t += 8 // 13 since put, but only 8 since touch
    expect(store.sweep()).toBe(0)
    expect(store.get('a')).not.toBeNull()
  })

  test('touch on a missing slot is a no-op', () => {
    const store = createDevSlotStore()
    expect(() => store.touch('nope')).not.toThrow()
  })
})
