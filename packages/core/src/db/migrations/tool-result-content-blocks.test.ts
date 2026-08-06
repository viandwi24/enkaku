import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { openDb, runMigrations } from '../index'
import { agentMessages, agentThreads, migrationMarkers } from '../schema'
import { createLogger } from '../../util/logger'
import { migrateToolResultContentBlocks, MARKER_ID } from './tool-result-content-blocks'

function setUp() {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  return opened.db
}

function seedThread(db: ReturnType<typeof setUp>, id: string) {
  db.insert(agentThreads)
    .values({ id, agentId: 'agent-1', title: null, origin: 'chat', onApprovalRequired: 'pause', createdBy: null, createdAt: new Date(), updatedAt: new Date() })
    .run()
}

function seedMessage(db: ReturnType<typeof setUp>, id: string, threadId: string, seq: number, content: unknown) {
  db.insert(agentMessages).values({ id, threadId, runId: null, seq, role: 'tool', content, createdAt: new Date() }).run()
}

describe('migrateToolResultContentBlocks — the tool_result content migration (plan 70 §4.1)', () => {
  test('a legacy string tool_result becomes one text block with IDENTICAL text', () => {
    const db = setUp()
    seedThread(db, 't1')
    seedMessage(db, 'm1', 't1', 1, [{ type: 'tool_result', toolUseId: 'call-1', content: '{"echoed":"hi"}', isError: false }])

    const report = migrateToolResultContentBlocks(db, { log: createLogger('test') })
    expect(report).not.toBeNull()
    expect(report?.convertedBlocks).toBe(1)

    const row = db.select().from(agentMessages).where(eq(agentMessages.id, 'm1')).get()
    expect(row?.content).toEqual([{ type: 'tool_result', toolUseId: 'call-1', content: [{ type: 'text', text: '{"echoed":"hi"}' }], isError: false }])
  })

  test('preserves isError when absent (never invents the field)', () => {
    const db = setUp()
    seedThread(db, 't1')
    seedMessage(db, 'm1', 't1', 1, [{ type: 'tool_result', toolUseId: 'call-1', content: 'plain result' }])
    migrateToolResultContentBlocks(db, { log: createLogger('test') })
    const row = db.select().from(agentMessages).where(eq(agentMessages.id, 'm1')).get()
    expect(row?.content).toEqual([{ type: 'tool_result', toolUseId: 'call-1', content: [{ type: 'text', text: 'plain result' }] }])
  })

  test('an already-migrated row (content already an array) is left untouched', () => {
    const db = setUp()
    seedThread(db, 't1')
    const already = [{ type: 'tool_result', toolUseId: 'call-1', content: [{ type: 'text', text: 'already migrated' }] }]
    seedMessage(db, 'm1', 't1', 1, already)
    const report = migrateToolResultContentBlocks(db, { log: createLogger('test') })
    expect(report?.convertedBlocks).toBe(0)
    const row = db.select().from(agentMessages).where(eq(agentMessages.id, 'm1')).get()
    expect(row?.content).toEqual(already)
  })

  test('non-tool_result blocks (text, tool_use) are left byte-for-byte unchanged', () => {
    const db = setUp()
    seedThread(db, 't1')
    const content = [{ type: 'text', text: 'hello' }, { type: 'tool_use', id: 'c1', name: 'device_tap', input: { x: 1 } }]
    seedMessage(db, 'm1', 't1', 1, content)
    migrateToolResultContentBlocks(db, { log: createLogger('test') })
    const row = db.select().from(agentMessages).where(eq(agentMessages.id, 'm1')).get()
    expect(row?.content).toEqual(content)
  })

  test('the marker makes a second run a no-op — running it twice changes nothing', () => {
    const db = setUp()
    seedThread(db, 't1')
    seedMessage(db, 'm1', 't1', 1, [{ type: 'tool_result', toolUseId: 'call-1', content: 'x' }])
    const first = migrateToolResultContentBlocks(db, { log: createLogger('test') })
    expect(first).not.toBeNull()
    const rowAfterFirst = db.select().from(agentMessages).where(eq(agentMessages.id, 'm1')).get()

    const second = migrateToolResultContentBlocks(db, { log: createLogger('test') })
    expect(second).toBeNull()
    const rowAfterSecond = db.select().from(agentMessages).where(eq(agentMessages.id, 'm1')).get()
    expect(rowAfterSecond?.content).toEqual(rowAfterFirst?.content)

    const marker = db.select().from(migrationMarkers).where(eq(migrationMarkers.id, MARKER_ID)).get()
    expect(marker).toBeDefined()
  })

  test('runs cleanly with zero pre-existing messages', () => {
    const db = setUp()
    const report = migrateToolResultContentBlocks(db, { log: createLogger('test') })
    expect(report?.totalMessages).toBe(0)
    expect(report?.convertedBlocks).toBe(0)
  })

  test('a message with multiple tool_result blocks migrates every one', () => {
    const db = setUp()
    seedThread(db, 't1')
    seedMessage(db, 'm1', 't1', 1, [
      { type: 'tool_result', toolUseId: 'call-1', content: 'a' },
      { type: 'tool_result', toolUseId: 'call-2', content: 'b', isError: true },
    ])
    const report = migrateToolResultContentBlocks(db, { log: createLogger('test') })
    expect(report?.convertedBlocks).toBe(2)
    const row = db.select().from(agentMessages).where(eq(agentMessages.id, 'm1')).get()
    expect(row?.content).toEqual([
      { type: 'tool_result', toolUseId: 'call-1', content: [{ type: 'text', text: 'a' }] },
      { type: 'tool_result', toolUseId: 'call-2', content: [{ type: 'text', text: 'b' }], isError: true },
    ])
  })
})
