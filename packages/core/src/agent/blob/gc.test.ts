import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { openDb, runMigrations, type Db } from '../../db'
import { agentBlobs, agentMessages, agentThreads } from '../../db/schema'
import { createFarmSettingsStore } from '../../settings/farm-settings'
import { createLogger } from '../../util/logger'
import { createBlobGc } from './gc'

function db(): Db {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  return opened.db
}

function makeGc(database: Db) {
  const settings = createFarmSettingsStore(database)
  return {
    settings,
    gc: createBlobGc({ db: database, settings, log: createLogger('test').child('blob-gc'), intervalMinutes: 60 }),
  }
}

let blobSeq = 0
function seedBlob(database: Db, opts: { ageHours: number; bytes?: number }): string {
  const id = `sha256:blob-${blobSeq++}`
  database
    .insert(agentBlobs)
    .values({
      id,
      mediaType: 'image/png',
      bytes: opts.bytes ?? 1000,
      width: 100,
      height: 100,
      data: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      createdAt: new Date(Date.now() - opts.ageHours * 60 * 60 * 1000),
    })
    .run()
  return id
}

let threadSeq = 0
function seedThread(database: Db): string {
  const id = `thread-${threadSeq++}`
  const now = new Date()
  database
    .insert(agentThreads)
    .values({ id, agentId: 'agent-1', title: null, origin: 'chat', onApprovalRequired: 'pause', deviceScope: null, createdBy: null, createdAt: now, updatedAt: now })
    .run()
  return id
}

let messageSeq = 0
/** Appends a message whose content references `blobId` — `nested: true` puts it inside a
 * `tool_result` block's own content array (an agent's screenshot); `nested: false` puts it at
 * the top level (a person's own attachment, `agent/runner.ts`'s `attachmentBlocks`). */
function seedMessageReferencing(database: Db, threadId: string, blobId: string, opts: { nested: boolean }): void {
  const content = opts.nested
    ? [{ type: 'tool_result', toolUseId: 'call-1', content: [{ type: 'image', blobId, mediaType: 'image/png', bytes: 1000 }] }]
    : [{ type: 'image', blobId, mediaType: 'image/png', bytes: 1000 }]
  database
    .insert(agentMessages)
    .values({ id: `msg-${messageSeq++}`, threadId, runId: null, seq: messageSeq, role: 'assistant', content, createdAt: new Date() })
    .run()
}

function allBlobIds(database: Db): string[] {
  return database.select({ id: agentBlobs.id }).from(agentBlobs).all().map((r) => r.id)
}

describe('blob retention GC (agent_blobs)', () => {
  test('an unreferenced blob past the default grace window (24h) is deleted', () => {
    const database = db()
    const orphan = seedBlob(database, { ageHours: 25 })
    const { gc } = makeGc(database)

    const result = gc.sweepOnce()

    expect(result.deleted).toBe(1)
    expect(result.freedBytes).toBe(1000)
    expect(allBlobIds(database)).not.toContain(orphan)
  })

  test('an unreferenced blob still inside the grace window is left alone — the safe default', () => {
    const database = db()
    const recent = seedBlob(database, { ageHours: 1 })
    const { gc } = makeGc(database)

    const result = gc.sweepOnce()

    expect(result.deleted).toBe(0)
    expect(allBlobIds(database)).toContain(recent)
  })

  test('a brand-new blob (0 hours old) is never swept, regardless of reference state', () => {
    const database = db()
    const fresh = seedBlob(database, { ageHours: 0 })
    const { gc } = makeGc(database)

    const result = gc.sweepOnce()

    expect(result.deleted).toBe(0)
    expect(allBlobIds(database)).toContain(fresh)
  })

  test('a blob referenced by a live message at the TOP level survives no matter how old it is', () => {
    const database = db()
    const blobId = seedBlob(database, { ageHours: 24 * 365 }) // a year old
    const threadId = seedThread(database)
    seedMessageReferencing(database, threadId, blobId, { nested: false })
    const { gc } = makeGc(database)

    const result = gc.sweepOnce()

    expect(result.deleted).toBe(0)
    expect(allBlobIds(database)).toContain(blobId)
  })

  test('a blob referenced only inside a NESTED tool_result block survives — this is how an agent screenshot is actually stored', () => {
    const database = db()
    const blobId = seedBlob(database, { ageHours: 24 * 365 })
    const threadId = seedThread(database)
    seedMessageReferencing(database, threadId, blobId, { nested: true })
    const { gc } = makeGc(database)

    const result = gc.sweepOnce()

    expect(result.deleted).toBe(0)
    expect(allBlobIds(database)).toContain(blobId)
  })

  test('a blob orphaned by a deleted thread (its message removed) becomes eligible once past grace — matches thread/store.ts deleteThread\'s own comment that this GC is where blob cleanup happens', () => {
    const database = db()
    const blobId = seedBlob(database, { ageHours: 25 })
    const threadId = seedThread(database)
    seedMessageReferencing(database, threadId, blobId, { nested: false })
    // Simulate `deleteThread`: its own messages are gone, the blob row is untouched (by design).
    database.delete(agentMessages).where(eq(agentMessages.threadId, threadId)).run()
    const { gc } = makeGc(database)

    const result = gc.sweepOnce()

    expect(result.deleted).toBe(1)
    expect(allBlobIds(database)).not.toContain(blobId)
  })

  test('a dedupe-shared blob referenced by one thread survives even after a DIFFERENT thread referencing it is deleted', () => {
    const database = db()
    const blobId = seedBlob(database, { ageHours: 25 })
    const threadA = seedThread(database)
    const threadB = seedThread(database)
    seedMessageReferencing(database, threadA, blobId, { nested: false })
    seedMessageReferencing(database, threadB, blobId, { nested: true })
    // Thread A is deleted; thread B still references the same content-addressed blob.
    database.delete(agentMessages).where(eq(agentMessages.threadId, threadA)).run()

    const { gc } = makeGc(database)
    const result = gc.sweepOnce()

    expect(result.deleted).toBe(0)
    expect(allBlobIds(database)).toContain(blobId)
  })

  test('the sweep is idempotent — a second run over the same state deletes nothing further and does not throw', () => {
    const database = db()
    seedBlob(database, { ageHours: 25 })
    const { gc } = makeGc(database)

    const first = gc.sweepOnce()
    const second = gc.sweepOnce()

    expect(first.deleted).toBe(1)
    expect(second.deleted).toBe(0)
    expect(second.freedBytes).toBe(0)
    expect(allBlobIds(database)).toHaveLength(0)
  })

  test('the grace period is configurable — a shorter setting sweeps an otherwise-protected recent orphan', () => {
    const database = db()
    const orphan = seedBlob(database, { ageHours: 2 })
    const { gc, settings } = makeGc(database)
    settings.update({ retention: { blobOrphanGraceHours: 1 } })

    const result = gc.sweepOnce()

    expect(result.deleted).toBe(1)
    expect(allBlobIds(database)).not.toContain(orphan)
  })

  test('a longer setting protects an orphan the default would have swept', () => {
    const database = db()
    const orphan = seedBlob(database, { ageHours: 25 })
    const { gc, settings } = makeGc(database)
    settings.update({ retention: { blobOrphanGraceHours: 24 * 7 } })

    const result = gc.sweepOnce()

    expect(result.deleted).toBe(0)
    expect(allBlobIds(database)).toContain(orphan)
  })

  test('mixed sweep: referenced, in-grace, and expired-orphan blobs in the same table are each handled correctly in one pass', () => {
    const database = db()
    const referenced = seedBlob(database, { ageHours: 100 })
    const threadId = seedThread(database)
    seedMessageReferencing(database, threadId, referenced, { nested: false })
    const inGrace = seedBlob(database, { ageHours: 2 })
    const expiredOrphan = seedBlob(database, { ageHours: 100 })

    const { gc } = makeGc(database)
    const result = gc.sweepOnce()

    expect(result.deleted).toBe(1)
    const remaining = allBlobIds(database)
    expect(remaining).toContain(referenced)
    expect(remaining).toContain(inGrace)
    expect(remaining).not.toContain(expiredOrphan)
  })

  test('start()/stop() runs an immediate sweep and can be torn down without leaking a timer', () => {
    const database = db()
    seedBlob(database, { ageHours: 25 })
    const { gc } = makeGc(database)

    gc.start()
    expect(allBlobIds(database)).toHaveLength(0)
    gc.stop()
    gc.stop() // idempotent — must not throw
  })
})
