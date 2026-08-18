import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { openDb, runMigrations, type Db } from '../db'
import { workspaceFiles } from '../db/schema'
import { EnkakuError } from '../util/errors'
import { createWorkspaceStore, type WorkspaceQuotas, type WorkspaceStore } from './store'

/**
 * Plan 115's own additions to the workspace store (§3.4's write-routing
 * policy, §3.5's quota wording, criterion 10's pre-plan-115 legacy row) —
 * kept in a file of its own rather than folded into `store.test.ts` (plan
 * 64's), which is already large and entirely about the driver-agnostic
 * behaviour (CAS, quotas, list, grep) that predates drivers existing at
 * all. Everything below is specifically about WHICH driver a write lands on
 * and what does/does not change when one does.
 */

const enc = (s: string) => new TextEncoder().encode(s)
const dec = (b: Uint8Array) => new TextDecoder().decode(b)

const dirs: string[] = []
function tmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'enkaku-workspace-routing-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function setUp(quotas: WorkspaceQuotas, fsContentRoot: string): { db: Db; store: WorkspaceStore } {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  return { db: opened.db, store: createWorkspaceStore(opened.db, () => quotas, { fsContentRoot }) }
}

const QUOTAS: WorkspaceQuotas = { maxFileBytes: 10 * 1024 * 1024, maxFilesPerScope: 1_000, maxTotalBytesPerScope: 64 * 1024 * 1024, inlineMaxBytes: 32 }

function rowFor(db: Db, path: string) {
  const row = db.select().from(workspaceFiles).where(eq(workspaceFiles.path, path)).get()
  if (!row) throw new Error(`no row for ${path}`)
  return row
}

describe('§3.4 — write-routing policy: small text stays inline, larger or non-text goes to fs', () => {
  test('text at or under inlineMaxBytes is stored inline — storage="inline", locator NULL, content in the row', () => {
    const root = tmpRoot()
    const { db, store } = setUp(QUOTAS, root)
    store.write('/notes/short.txt', { content: enc('a short note'), contentType: 'text/plain', actor: null }) // 12 bytes <= 32
    const row = rowFor(db, '/notes/short.txt')
    expect(row.storage).toBe('inline')
    expect(row.locator).toBeNull()
    expect(dec(new Uint8Array(row.content))).toBe('a short note')
    // Nothing was written to the fs content root for an inline write.
    expect(readdirSync(root)).toEqual([])
  })

  test('text OVER inlineMaxBytes routes to fs — storage="fs", a real locator, empty content column, bytes on disk', () => {
    const root = tmpRoot()
    const { db, store } = setUp(QUOTAS, root)
    const big = 'x'.repeat(64) // > 32-byte inlineMaxBytes, but still text/plain
    store.write('/notes/long.txt', { content: enc(big), contentType: 'text/plain', actor: null })
    const row = rowFor(db, '/notes/long.txt')
    expect(row.storage).toBe('fs')
    expect(row.locator).toBe(row.hash)
    expect(new Uint8Array(row.content).byteLength).toBe(0)
    expect(existsSync(join(root, row.hash.slice(0, 2), row.hash))).toBe(true)
    // The store still reads it back correctly through the fs driver.
    expect(dec(store.read('/notes/long.txt').content)).toBe(big)
  })

  test('binary content under the threshold STILL routes to fs — the policy is "text AND under the threshold", not size alone', () => {
    const root = tmpRoot()
    const { store } = setUp(QUOTAS, root)
    const small = new Uint8Array([0, 1, 2, 3, 4]) // 5 bytes, well under 32
    const meta = store.write('/media/tiny.bin', { content: small, contentType: 'application/octet-stream', actor: null })
    expect(existsSync(join(root, meta.hash.slice(0, 2), meta.hash))).toBe(true)
  })

  test('a write exactly AT inlineMaxBytes stays inline; one byte over crosses to fs (the boundary is inclusive)', () => {
    const root = tmpRoot()
    const { db, store } = setUp(QUOTAS, root)
    store.write('/a.txt', { content: enc('x'.repeat(32)), contentType: 'text/plain', actor: null })
    store.write('/b.txt', { content: enc('x'.repeat(33)), contentType: 'text/plain', actor: null })
    expect(rowFor(db, '/a.txt').storage).toBe('inline')
    expect(rowFor(db, '/b.txt').storage).toBe('fs')
  })

  test('the threshold is workspace.inlineMaxBytes: a caller with a stricter setting routes the SAME content differently', () => {
    const root = tmpRoot()
    const strict = { ...QUOTAS, inlineMaxBytes: 2 }
    const { db, store } = setUp(strict, root)
    store.write('/x.txt', { content: enc('abc'), contentType: 'text/plain', actor: null }) // 3 bytes > 2
    expect(rowFor(db, '/x.txt').storage).toBe('fs')
  })

  test('overwriting an inline file with content that now crosses the threshold moves it to fs on the SAME path', () => {
    const root = tmpRoot()
    const { db, store } = setUp(QUOTAS, root)
    const first = store.write('/grows.txt', { content: enc('short'), contentType: 'text/plain', actor: null })
    expect(rowFor(db, '/grows.txt').storage).toBe('inline')
    store.write('/grows.txt', { content: enc('x'.repeat(100)), contentType: 'text/plain', ifMatch: first.hash, actor: null })
    const row = rowFor(db, '/grows.txt')
    expect(row.storage).toBe('fs')
    expect(row.locator).not.toBeNull()
    expect(dec(store.read('/grows.txt').content)).toBe('x'.repeat(100))
  })
})

describe('criterion 3 — an over-quota write refuses with E_QUOTA naming the setting to raise', () => {
  test('over maxFileBytes names "workspace.maxFileBytes" in the message', () => {
    const root = tmpRoot()
    const { store } = setUp({ ...QUOTAS, maxFileBytes: 10 }, root)
    try {
      store.write('/big.bin', { content: new Uint8Array(11), contentType: 'application/octet-stream', actor: null })
      throw new Error('unreachable')
    } catch (err) {
      expect(err).toBeInstanceOf(EnkakuError)
      const e = err as EnkakuError
      expect(e.code).toBe('E_QUOTA')
      expect(e.message).toContain('workspace.maxFileBytes')
      expect(e.message).toContain('10') // the actual limit that was hit, not just its name
    }
  })

  test('over maxTotalBytesPerScope names "workspace.maxTotalBytesPerScope"', () => {
    const root = tmpRoot()
    const { store } = setUp({ ...QUOTAS, maxFileBytes: 1000, maxTotalBytesPerScope: 15 }, root)
    store.write('/shared/a.bin', { content: new Uint8Array(10), contentType: 'application/octet-stream', actor: null })
    try {
      store.write('/shared/b.bin', { content: new Uint8Array(10), contentType: 'application/octet-stream', actor: null })
      throw new Error('unreachable')
    } catch (err) {
      expect((err as EnkakuError).code).toBe('E_QUOTA')
      expect((err as EnkakuError).message).toContain('workspace.maxTotalBytesPerScope')
    }
  })

  test('over maxFilesPerScope names "workspace.maxFilesPerScope"', () => {
    const root = tmpRoot()
    const { store } = setUp({ ...QUOTAS, maxFilesPerScope: 1 }, root)
    store.write('/shared/a.bin', { content: new Uint8Array(1), contentType: 'application/octet-stream', actor: null })
    try {
      store.write('/shared/b.bin', { content: new Uint8Array(1), contentType: 'application/octet-stream', actor: null })
      throw new Error('unreachable')
    } catch (err) {
      expect((err as EnkakuError).code).toBe('E_QUOTA')
      expect((err as EnkakuError).message).toContain('workspace.maxFilesPerScope')
    }
  })
})

describe('move/rename touches no driver at all (§3.3): the locator is unchanged and no file moves', () => {
  test('renaming an fs-routed file leaves its locator, its on-disk file, and its bytes untouched', () => {
    const root = tmpRoot()
    const { db, store } = setUp(QUOTAS, root)
    const written = store.write('/videos/a.mp4', { content: enc('x'.repeat(100)), contentType: 'video/mp4', actor: null })
    const before = rowFor(db, '/videos/a.mp4')
    expect(before.storage).toBe('fs')
    const onDiskBefore = join(root, before.hash.slice(0, 2), before.hash)
    expect(existsSync(onDiskBefore)).toBe(true)

    store.move('/videos/a.mp4', '/videos/renamed.mp4', { ifMatch: written.hash })

    const after = rowFor(db, '/videos/renamed.mp4')
    expect(after.storage).toBe('fs')
    expect(after.locator).toBe(before.locator) // unchanged
    expect(after.hash).toBe(before.hash)
    // The SAME on-disk file still exists at the SAME path — nothing moved on disk.
    expect(existsSync(onDiskBefore)).toBe(true)
    expect(dec(store.read('/videos/renamed.mp4').content)).toBe('x'.repeat(100))
    // No new file was ever created — exactly one blob in the whole content root.
    const allFiles = readdirSync(root).flatMap((d) => readdirSync(join(root, d)))
    expect(allFiles).toEqual([before.hash])
  })

  test('renaming an inline file is a plain row update — no directory in the fs content root is ever created', () => {
    const root = tmpRoot()
    const { store } = setUp(QUOTAS, root)
    const written = store.write('/notes/a.txt', { content: enc('hi'), contentType: 'text/plain', actor: null })
    store.move('/notes/a.txt', '/notes/b.txt', { ifMatch: written.hash })
    expect(dec(store.read('/notes/b.txt').content)).toBe('hi')
    expect(readdirSync(root)).toEqual([]) // the fs driver was never touched
  })
})

describe('criterion 10 — a row written before this plan (storage="inline", content in the row, locator NULL) still works', () => {
  /** Inserts a row directly, bypassing `store.write()` entirely — simulating a row that was written
   * by the pre-plan-115 code, which never knew `storage`/`locator` existed. Schema defaults
   * (`storage` -> 'inline') are what a REAL such row relies on; this insert sets it explicitly for
   * the test's own clarity, which is the same value the default would have produced. */
  function insertLegacyRow(db: Db, opts: { path: string; content: Uint8Array; contentType: string }): { hash: string } {
    const hasher = new Bun.CryptoHasher('sha256')
    hasher.update(opts.content)
    const hash = hasher.digest('hex')
    const now = new Date()
    db.insert(workspaceFiles)
      .values({
        id: crypto.randomUUID(),
        path: opts.path,
        content: Buffer.from(opts.content),
        contentType: opts.contentType,
        size: opts.content.byteLength,
        hash,
        storage: 'inline',
        locator: null,
        createdBy: 'user:legacy',
        updatedBy: 'user:legacy',
        createdAt: now,
        updatedAt: now,
      })
      .run()
    return { hash }
  }

  test('reads back exactly as written', () => {
    const root = tmpRoot()
    const { db, store } = setUp(QUOTAS, root)
    insertLegacyRow(db, { path: '/legacy/old.ts', content: enc('export default 1'), contentType: 'text/typescript' })
    const read = store.read('/legacy/old.ts')
    expect(dec(read.content)).toBe('export default 1')
    expect(read.contentType).toBe('text/typescript')
  })

  test('can be overwritten (CAS) — the new content re-routes by the SAME policy as any other write', () => {
    const root = tmpRoot()
    const { db, store } = setUp(QUOTAS, root)
    const { hash } = insertLegacyRow(db, { path: '/legacy/old.txt', content: enc('short'), contentType: 'text/plain' })
    // Overwrite with something big enough to cross the fs threshold.
    const updated = store.write('/legacy/old.txt', { content: enc('x'.repeat(100)), contentType: 'text/plain', ifMatch: hash, actor: 'user:new' })
    expect(updated.hash).not.toBe(hash)
    const row = rowFor(db, '/legacy/old.txt')
    expect(row.storage).toBe('fs')
    expect(dec(store.read('/legacy/old.txt').content)).toBe('x'.repeat(100))
  })

  test('can be moved — a plain row update, same as any other row', () => {
    const root = tmpRoot()
    const { db, store } = setUp(QUOTAS, root)
    const { hash } = insertLegacyRow(db, { path: '/legacy/a.txt', content: enc('v'), contentType: 'text/plain' })
    store.move('/legacy/a.txt', '/legacy/b.txt', { ifMatch: hash })
    expect(dec(store.read('/legacy/b.txt').content)).toBe('v')
    expect(() => store.read('/legacy/a.txt')).toThrow(EnkakuError)
  })

  test('can be deleted — no driver call happens for an inline row (nothing to unlink, no throw)', () => {
    const root = tmpRoot()
    const { db, store } = setUp(QUOTAS, root)
    insertLegacyRow(db, { path: '/legacy/gone.txt', content: enc('v'), contentType: 'text/plain' })
    expect(() => store.delete('/legacy/gone.txt')).not.toThrow()
    expect(() => store.read('/legacy/gone.txt')).toThrow(EnkakuError)
  })

  test('list() reports it exactly like any other file — the driver split is invisible to callers', () => {
    const root = tmpRoot()
    const { db, store } = setUp(QUOTAS, root)
    insertLegacyRow(db, { path: '/legacy/visible.txt', content: enc('v'), contentType: 'text/plain' })
    const entries = store.list('/legacy')
    expect(entries.map((e) => e.path)).toEqual(['/legacy/visible.txt'])
  })
})
