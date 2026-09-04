import { describe, expect, test } from 'bun:test'
import { openDb, runMigrations } from '../db'
import { createPinStore } from './pins'

function setUp() {
  const opened = openDb(':memory:')
  runMigrations(opened.db, opened.sqlite)
  return { db: opened.db, pins: createPinStore(opened.db) }
}

describe('PinStore CRUD (plan 304 §3.3, §4.1)', () => {
  test('set then get round-trips the data', () => {
    const { pins } = setUp()
    pins.set('wf-a', 'n1', { videos: [1, 2, 3] }, 'u1')
    expect(pins.get('wf-a', 'n1')).toEqual({ data: { videos: [1, 2, 3] }, updatedAt: expect.any(Number) })
  })

  test('a second set on the same (workflow, node) upserts, not duplicates', () => {
    const { pins } = setUp()
    pins.set('wf-a', 'n1', { a: 1 }, 'u1')
    pins.set('wf-a', 'n1', { a: 2 }, 'u1')
    expect(pins.list('wf-a')).toHaveLength(1)
    expect(pins.get('wf-a', 'n1')?.data).toEqual({ a: 2 })
  })

  test('remove deletes it; a second remove returns false', () => {
    const { pins } = setUp()
    pins.set('wf-a', 'n1', { a: 1 }, 'u1')
    expect(pins.remove('wf-a', 'n1')).toBe(true)
    expect(pins.get('wf-a', 'n1')).toBeNull()
    expect(pins.remove('wf-a', 'n1')).toBe(false)
  })

  test('list never carries the data itself', () => {
    const { pins } = setUp()
    pins.set('wf-a', 'n1', { big: 'x'.repeat(1000) }, 'u1')
    const items = pins.list('wf-a')
    expect(items).toEqual([{ nodeId: 'n1', updatedAt: expect.any(Number), bytes: expect.any(Number) }])
    expect((items[0] as unknown as { data?: unknown }).data).toBeUndefined()
  })

  test('pins are scoped per (workflowName, nodeId) — a pin on one workflow never leaks into another', () => {
    const { pins } = setUp()
    pins.set('wf-a', 'n1', { a: 1 }, 'u1')
    pins.set('wf-b', 'n1', { a: 2 }, 'u1')
    expect(pins.get('wf-a', 'n1')?.data).toEqual({ a: 1 })
    expect(pins.get('wf-b', 'n1')?.data).toEqual({ a: 2 })
    expect(pins.list('wf-a')).toHaveLength(1)
  })

  test('readAll returns every pin on a workflow keyed by node id, with data', () => {
    const { pins } = setUp()
    pins.set('wf-a', 'n1', { a: 1 }, 'u1')
    pins.set('wf-a', 'n2', { a: 2 }, 'u1')
    const all = pins.readPins('wf-a')
    expect(all.get('n1')).toEqual({ a: 1 })
    expect(all.get('n2')).toEqual({ a: 2 })
    expect(all.size).toBe(2)
  })

  test('a pin over the byte cap is refused with E_PIN_TOO_LARGE', () => {
    const { pins } = setUp()
    let threw: unknown
    try {
      pins.set('wf-a', 'n1', { big: 'x'.repeat(300_000) }, 'u1')
    } catch (err) {
      threw = err
    }
    expect(threw).toBeDefined()
    expect((threw as { code?: string }).code).toBe('E_PIN_TOO_LARGE')
  })

  test('removeAll clears every pin on a workflow and reports the count', () => {
    const { pins } = setUp()
    pins.set('wf-a', 'n1', { a: 1 }, 'u1')
    pins.set('wf-a', 'n2', { a: 2 }, 'u1')
    pins.set('wf-b', 'n1', { a: 3 }, 'u1')
    expect(pins.removeAll('wf-a')).toBe(2)
    expect(pins.list('wf-a')).toHaveLength(0)
    expect(pins.list('wf-b')).toHaveLength(1)
  })
})
