import { describe, expect, test } from 'bun:test'
import { openDb, runMigrations, type Db } from '../../db'
import { createTreeStore } from './store'

function setUp(): Db {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  return opened.db
}

describe('tree store — inbox (plan 67 §3.3, §4.1)', () => {
  test('enqueue then drain delivers exactly once and marks delivered', () => {
    const store = createTreeStore(setUp())
    store.enqueue({ targetRunId: 'run-1', fromRunId: 'run-0', kind: 'message', body: { text: 'hi' } })

    expect(store.undeliveredFor('run-1')).toHaveLength(1)
    const delivered = store.drain('run-1')
    expect(delivered).toHaveLength(1)
    expect(delivered[0]!.kind).toBe('message')
    expect(delivered[0]!.deliveredAt).not.toBeNull()

    // Draining again finds nothing new — already delivered.
    expect(store.drain('run-1')).toHaveLength(0)
    expect(store.undeliveredFor('run-1')).toHaveLength(0)
  })

  test('an undelivered message is visible via undeliveredFor before being drained (criterion 17)', () => {
    const store = createTreeStore(setUp())
    store.enqueue({ targetRunId: 'run-1', fromRunId: null, kind: 'child-result', body: { output: 'done' } })
    const pending = store.undeliveredFor('run-1')
    expect(pending).toHaveLength(1)
    expect(pending[0]!.deliveredAt).toBeNull()
  })

  test('inbox items for different runs do not cross-deliver', () => {
    const store = createTreeStore(setUp())
    store.enqueue({ targetRunId: 'run-a', fromRunId: null, kind: 'message', body: {} })
    store.enqueue({ targetRunId: 'run-b', fromRunId: null, kind: 'message', body: {} })
    expect(store.drain('run-a')).toHaveLength(1)
    expect(store.undeliveredFor('run-b')).toHaveLength(1)
  })

  test('multiple queued messages drain together, in one call, at the boundary', () => {
    const store = createTreeStore(setUp())
    store.enqueue({ targetRunId: 'run-1', fromRunId: null, kind: 'message', body: { n: 1 } })
    store.enqueue({ targetRunId: 'run-1', fromRunId: null, kind: 'message', body: { n: 2 } })
    expect(store.drain('run-1')).toHaveLength(2)
  })
})

describe('tree store — spawn grants (plan 67 §3.4, §4.1, criterion 5)', () => {
  test('the default is none — an ungranted pair cannot spawn', () => {
    const store = createTreeStore(setUp())
    expect(store.canSpawn('parent-1', 'child-1')).toBe(false)
  })

  test('granting allows, revoking refuses again', () => {
    const store = createTreeStore(setUp())
    store.grantSpawn('parent-1', 'child-1')
    expect(store.canSpawn('parent-1', 'child-1')).toBe(true)
    store.revokeSpawn('parent-1', 'child-1')
    expect(store.canSpawn('parent-1', 'child-1')).toBe(false)
  })

  test('granting the same pair twice does not error (idempotent)', () => {
    const store = createTreeStore(setUp())
    store.grantSpawn('parent-1', 'child-1')
    expect(() => store.grantSpawn('parent-1', 'child-1')).not.toThrow()
    expect(store.canSpawn('parent-1', 'child-1')).toBe(true)
  })

  test('a grant is directional — parent may spawn child does not imply the reverse', () => {
    const store = createTreeStore(setUp())
    store.grantSpawn('parent-1', 'child-1')
    expect(store.canSpawn('child-1', 'parent-1')).toBe(false)
  })

  test('listSpawnable returns every agent one parent may spawn', () => {
    const store = createTreeStore(setUp())
    store.grantSpawn('parent-1', 'child-1')
    store.grantSpawn('parent-1', 'child-2')
    expect(store.listSpawnable('parent-1').sort()).toEqual(['child-1', 'child-2'])
  })
})
