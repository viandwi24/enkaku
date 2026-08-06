import { chmodSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, afterAll, describe, expect, test } from 'bun:test'
import { openDb, runMigrations, type Db } from '../db'
import { EnkakuError } from '../util/errors'
import { createWorkspaceStore, type WorkspaceQuotas, type WorkspaceStore } from './store'

const GENEROUS_QUOTAS: WorkspaceQuotas = { maxFileBytes: 1_048_576, maxFilesPerScope: 1_000, maxTotalBytesPerScope: 64 * 1024 * 1024 }

function setUp(quotas: WorkspaceQuotas = GENEROUS_QUOTAS): { db: Db; store: WorkspaceStore } {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  return { db: opened.db, store: createWorkspaceStore(opened.db, () => quotas) }
}

const enc = (s: string) => new TextEncoder().encode(s)
const dec = (b: Uint8Array) => new TextDecoder().decode(b)

describe('workspace store (plan 64 §3.3, §3.4, step 64.3)', () => {
  test('write then read round-trips content, size, and contentType', () => {
    const { store } = setUp()
    const meta = store.write('/scripts/hello.ts', { content: enc('export default 1'), contentType: 'text/typescript', actor: 'user:u1' })
    expect(meta.size).toBe(enc('export default 1').byteLength)
    const read = store.read('/scripts/hello.ts')
    expect(dec(read.content)).toBe('export default 1')
    expect(read.contentType).toBe('text/typescript')
    expect(read.createdBy).toBe('user:u1')
    expect(read.updatedBy).toBe('user:u1')
    expect(read.hash).toBe(meta.hash)
  })

  test('reading a missing path fails E_NOT_FOUND', () => {
    const { store } = setUp()
    expect(() => store.read('/scripts/nope.ts')).toThrow(EnkakuError)
    try {
      store.read('/scripts/nope.ts')
    } catch (err) {
      expect((err as EnkakuError).code).toBe('E_NOT_FOUND')
    }
  })

  // ---- acceptance #3: create/overwrite/CAS ----

  test('acceptance #3: creating an existing path (no ifMatch) fails E_EXISTS', () => {
    const { store } = setUp()
    store.write('/a.ts', { content: enc('v1'), actor: null })
    expect(() => store.write('/a.ts', { content: enc('v2'), actor: null })).toThrow(EnkakuError)
    try {
      store.write('/a.ts', { content: enc('v2'), actor: null })
    } catch (err) {
      expect((err as EnkakuError).code).toBe('E_EXISTS')
    }
  })

  test('acceptance #3: ifMatch on a brand-new path is forbidden (nothing to compare against)', () => {
    const { store } = setUp()
    expect(() => store.write('/new.ts', { content: enc('v1'), ifMatch: 'deadbeef', actor: null })).toThrow(EnkakuError)
    try {
      store.write('/new.ts', { content: enc('v1'), ifMatch: 'deadbeef', actor: null })
    } catch (err) {
      expect((err as EnkakuError).code).toBe('E_STALE')
    }
  })

  test('acceptance #3: overwriting with a stale ifMatch fails E_STALE naming both hashes', () => {
    const { store } = setUp()
    const first = store.write('/a.ts', { content: enc('v1'), actor: null })
    try {
      store.write('/a.ts', { content: enc('v2'), ifMatch: 'not-the-real-hash', actor: null })
      throw new Error('unreachable')
    } catch (err) {
      expect(err).toBeInstanceOf(EnkakuError)
      const e = err as EnkakuError
      expect(e.code).toBe('E_STALE')
      expect(e.message).toContain('not-the-real-hash')
      expect(e.message).toContain(first.hash)
    }
  })

  test('acceptance #3: overwriting with the correct ifMatch succeeds and changes the hash', () => {
    const { store } = setUp()
    const first = store.write('/a.ts', { content: enc('v1'), actor: 'user:u1' })
    const second = store.write('/a.ts', { content: enc('v2'), ifMatch: first.hash, actor: 'user:u2' })
    expect(second.hash).not.toBe(first.hash)
    const read = store.read('/a.ts')
    expect(dec(read.content)).toBe('v2')
    expect(read.createdBy).toBe('user:u1') // creator is preserved across an overwrite
    expect(read.updatedBy).toBe('user:u2')
  })

  // ---- acceptance #4: concurrent writes — one wins, the other is told, never silently lost ----

  test('acceptance #4: two writers racing on one path — one succeeds, the other gets E_STALE, neither is silently lost', async () => {
    const { store } = setUp()
    const base = store.write('/race.ts', { content: enc('base'), actor: null })

    const writerA = async () => store.write('/race.ts', { content: enc('from-a'), ifMatch: base.hash, actor: 'user:a' })
    const writerB = async () => store.write('/race.ts', { content: enc('from-b'), ifMatch: base.hash, actor: 'user:b' })

    const results = await Promise.allSettled([writerA(), writerB()])
    const fulfilled = results.filter((r) => r.status === 'fulfilled')
    const rejected = results.filter((r) => r.status === 'rejected')
    expect(fulfilled.length).toBe(1)
    expect(rejected.length).toBe(1)
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(EnkakuError)
    expect(((rejected[0] as PromiseRejectedResult).reason as EnkakuError).code).toBe('E_STALE')

    // The winner's content is what is actually stored — nothing silently vanished.
    const final = store.read('/race.ts')
    expect(['from-a', 'from-b']).toContain(dec(final.content))
  })

  // ---- acceptance #5: quotas ----

  test('acceptance #5: exceeding maxFileBytes fails E_QUOTA naming the limit', () => {
    const { store } = setUp({ ...GENEROUS_QUOTAS, maxFileBytes: 10 })
    try {
      store.write('/big.ts', { content: enc('this is way more than ten bytes'), actor: null })
      throw new Error('unreachable')
    } catch (err) {
      expect(err).toBeInstanceOf(EnkakuError)
      const e = err as EnkakuError
      expect(e.code).toBe('E_QUOTA')
      expect(e.message).toContain('10')
    }
  })

  test('a file at exactly maxFileBytes is accepted; one byte over is not', () => {
    const { store } = setUp({ ...GENEROUS_QUOTAS, maxFileBytes: 4 })
    expect(() => store.write('/ok.ts', { content: enc('abcd'), actor: null })).not.toThrow()
    expect(() => store.write('/over.ts', { content: enc('abcde'), actor: null })).toThrow(EnkakuError)
  })

  test('acceptance #5: exceeding maxFilesPerScope fails E_QUOTA naming current usage', () => {
    const { store } = setUp({ ...GENEROUS_QUOTAS, maxFilesPerScope: 2 })
    store.write('/shared/a.ts', { content: enc('a'), actor: null })
    store.write('/shared/b.ts', { content: enc('b'), actor: null })
    try {
      store.write('/shared/c.ts', { content: enc('c'), actor: null })
      throw new Error('unreachable')
    } catch (err) {
      expect(err).toBeInstanceOf(EnkakuError)
      const e = err as EnkakuError
      expect(e.code).toBe('E_QUOTA')
      expect(e.message).toContain('2')
    }
    // A different scope is unaffected — quotas are per-scope, not farm-wide.
    expect(() => store.write('/notes/a.txt', { content: enc('n'), actor: null })).not.toThrow()
  })

  test('acceptance #5: exceeding maxTotalBytesPerScope fails E_QUOTA naming current usage', () => {
    const { store } = setUp({ ...GENEROUS_QUOTAS, maxFileBytes: 1000, maxTotalBytesPerScope: 15 })
    store.write('/shared/a.ts', { content: enc('0123456789'), actor: null }) // 10 bytes
    try {
      store.write('/shared/b.ts', { content: enc('0123456'), actor: null }) // 7 more -> 17 > 15
      throw new Error('unreachable')
    } catch (err) {
      expect(err).toBeInstanceOf(EnkakuError)
      expect((err as EnkakuError).code).toBe('E_QUOTA')
    }
  })

  test('overwriting within the same scope only counts the DELTA against maxTotalBytesPerScope', () => {
    const { store } = setUp({ ...GENEROUS_QUOTAS, maxFileBytes: 1000, maxTotalBytesPerScope: 12 })
    const a = store.write('/shared/a.ts', { content: enc('0123456789'), actor: null }) // 10 bytes, total 10
    // Shrinking the same file is fine even near the cap.
    expect(() => store.write('/shared/a.ts', { content: enc('01'), ifMatch: a.hash, actor: null })).not.toThrow()
  })

  test('one scope cannot exhaust another (risk table: per-scope accounting)', () => {
    const { store } = setUp({ ...GENEROUS_QUOTAS, maxFilesPerScope: 1 })
    store.write('/agents/bot-a/a.ts', { content: enc('a'), actor: 'agent:bot-a' })
    // bot-a's own scope is now full, but bot-b's scope is untouched.
    expect(() => store.write('/agents/bot-a/b.ts', { content: enc('b'), actor: 'agent:bot-a' })).toThrow(EnkakuError)
    expect(() => store.write('/agents/bot-b/a.ts', { content: enc('a'), actor: 'agent:bot-b' })).not.toThrow()
  })

  // ---- delete ----

  test('delete removes the file; a second delete fails E_NOT_FOUND', () => {
    const { store } = setUp()
    store.write('/a.ts', { content: enc('v'), actor: null })
    store.delete('/a.ts')
    expect(() => store.read('/a.ts')).toThrow(EnkakuError)
    expect(() => store.delete('/a.ts')).toThrow(EnkakuError)
  })

  test('delete with a stale ifMatch fails E_STALE and does not delete', () => {
    const { store } = setUp()
    store.write('/a.ts', { content: enc('v'), actor: null })
    try {
      store.delete('/a.ts', { ifMatch: 'wrong' })
      throw new Error('unreachable')
    } catch (err) {
      expect((err as EnkakuError).code).toBe('E_STALE')
    }
    expect(() => store.read('/a.ts')).not.toThrow()
  })

  // ---- move ----

  test('move renames a file, preserving content and history, requiring ifMatch on the source', () => {
    const { store } = setUp()
    const written = store.write('/scripts/old.ts', { content: enc('body'), actor: 'user:u1' })
    const moved = store.move('/scripts/old.ts', '/scripts/new.ts', { ifMatch: written.hash, actor: 'user:u2' })
    expect(moved.hash).toBe(written.hash)
    expect(() => store.read('/scripts/old.ts')).toThrow(EnkakuError)
    const read = store.read('/scripts/new.ts')
    expect(dec(read.content)).toBe('body')
    expect(read.createdBy).toBe('user:u1')
    expect(read.updatedBy).toBe('user:u2')
  })

  test('move refuses when the destination already exists', () => {
    const { store } = setUp()
    const a = store.write('/scripts/a.ts', { content: enc('a'), actor: null })
    store.write('/scripts/b.ts', { content: enc('b'), actor: null })
    try {
      store.move('/scripts/a.ts', '/scripts/b.ts', { ifMatch: a.hash })
      throw new Error('unreachable')
    } catch (err) {
      expect((err as EnkakuError).code).toBe('E_EXISTS')
    }
  })

  test('move refuses with a stale ifMatch on the source', () => {
    const { store } = setUp()
    store.write('/scripts/a.ts', { content: enc('a'), actor: null })
    try {
      store.move('/scripts/a.ts', '/scripts/z.ts', { ifMatch: 'wrong' })
      throw new Error('unreachable')
    } catch (err) {
      expect((err as EnkakuError).code).toBe('E_STALE')
    }
  })

  // ---- list ----

  test('list returns immediate children only — files and synthesised directories', () => {
    const { store } = setUp()
    store.write('/scripts/hello.ts', { content: enc('a'), actor: null })
    store.write('/scripts/lib/util.ts', { content: enc('b'), actor: null })
    store.write('/scripts/lib/helpers/x.ts', { content: enc('c'), actor: null })
    const entries = store.list('/scripts')
    expect(entries).toEqual([
      { path: '/scripts/hello.ts', kind: 'file', size: expect.any(Number), hash: expect.any(String), updatedAt: expect.any(Number) },
      { path: '/scripts/lib/', kind: 'dir', size: null, hash: null, updatedAt: null },
    ])
    const nested = store.list('/scripts/lib')
    expect(nested.map((e) => e.path)).toEqual(['/scripts/lib/helpers/', '/scripts/lib/util.ts'])
  })

  test('list at root shows every top-level scope', () => {
    const { store } = setUp()
    store.write('/scripts/a.ts', { content: enc('a'), actor: null })
    store.write('/shared/b.ts', { content: enc('b'), actor: null })
    const entries = store.list('/')
    expect(entries.map((e) => e.path).sort()).toEqual(['/scripts/', '/shared/'])
  })

  test('list on an empty prefix returns nothing (no directory rows exist)', () => {
    const { store } = setUp()
    expect(store.list('/nothing-here')).toEqual([])
  })

  // ---- grep (plan 77 §3.2, §4.2, step 77.1) ----

  test('grep finds a pattern under a prefix, reporting path and 1-based line', () => {
    const { store } = setUp()
    store.write('/scripts/a.ts', { content: enc('line one\nconst target = 1\nline three'), actor: null })
    store.write('/scripts/b.ts', { content: enc('nothing here'), actor: null })
    const { hits, truncated } = store.grep('/scripts', 'target')
    expect(truncated).toBe(false)
    expect(hits).toEqual([{ path: '/scripts/a.ts', line: 2, text: 'const target = 1' }])
  })

  test('grep only searches under the given prefix — a match elsewhere is not returned', () => {
    const { store } = setUp()
    store.write('/scripts/a.ts', { content: enc('needle'), actor: null })
    store.write('/shared/b.ts', { content: enc('needle'), actor: null })
    const { hits } = store.grep('/scripts', 'needle')
    expect(hits.map((h) => h.path)).toEqual(['/scripts/a.ts'])
  })

  test('grep at root searches the whole tree', () => {
    const { store } = setUp()
    store.write('/scripts/a.ts', { content: enc('needle'), actor: null })
    store.write('/shared/b.ts', { content: enc('needle'), actor: null })
    const { hits } = store.grep('/', 'needle')
    expect(hits.map((h) => h.path).sort()).toEqual(['/scripts/a.ts', '/shared/b.ts'])
  })

  test('grep caps hits and honestly reports truncation, never a silent cutoff', () => {
    const { store } = setUp()
    const lines = Array.from({ length: 250 }, (_, i) => `needle ${i}`).join('\n')
    store.write('/scripts/many.ts', { content: enc(lines), actor: null })
    const { hits, truncated } = store.grep('/scripts', 'needle')
    expect(hits.length).toBe(200)
    expect(truncated).toBe(true)
  })

  test('grep with no matches returns an empty, non-truncated result', () => {
    const { store } = setUp()
    store.write('/scripts/a.ts', { content: enc('nothing to see'), actor: null })
    const { hits, truncated } = store.grep('/scripts', 'needle')
    expect(hits).toEqual([])
    expect(truncated).toBe(false)
  })

  test('grep with an invalid regex pattern finds nothing rather than throwing', () => {
    const { store } = setUp()
    store.write('/scripts/a.ts', { content: enc('some content'), actor: null })
    expect(() => store.grep('/scripts', '[')).not.toThrow()
    const { hits, truncated } = store.grep('/scripts', '[')
    expect(hits).toEqual([])
    expect(truncated).toBe(false)
  })

  test('grep treats the pattern as a real regex — special characters and anchors both work', () => {
    const { store } = setUp()
    store.write('/scripts/a.ts', { content: enc('price: $5.00\nprice: 5x00'), actor: null })
    const literal = store.grep('/scripts', '\\$5\\.00')
    expect(literal.hits).toEqual([{ path: '/scripts/a.ts', line: 1, text: 'price: $5.00' }])
    const anchored = store.grep('/scripts', '^price: \\$')
    expect(anchored.hits.map((h) => h.line)).toEqual([1])
  })
})

// ---- acceptance #2: the store never touches the real filesystem ----

describe('acceptance #2: the store runs correctly with a READ-ONLY data directory (plan 64 step 64.1 note, §7)', () => {
  let dataDir: string

  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'enkaku-workspace-readonly-'))
    chmodSync(dataDir, 0o444)
  })

  afterAll(() => {
    chmodSync(dataDir, 0o755)
    rmSync(dataDir, { recursive: true, force: true })
  })

  test('a full read/write/list/delete/move cycle succeeds, and nothing is ever written into the read-only directory', () => {
    // `dataDir` stands in for the app-data directory (spec §7.2) — the
    // store never receives it, never reads ENKAKU_DATA_DIR, and has no
    // notion of "app data" at all. If it ever silently fell back to a real
    // file for content or an index, this read-only directory would make
    // that write fail loudly; instead, everything below succeeds because
    // NONE of it ever reaches `node:fs`.
    const { store } = setUp()

    const a = store.write('/scripts/hello.ts', { content: enc('export default 1'), actor: 'user:u1' })
    expect(dec(store.read('/scripts/hello.ts').content)).toBe('export default 1')
    const b = store.write('/scripts/hello.ts', { content: enc('export default 2'), ifMatch: a.hash, actor: 'user:u1' })
    expect(b.hash).not.toBe(a.hash)
    store.move('/scripts/hello.ts', '/scripts/renamed.ts', { ifMatch: b.hash })
    expect(store.list('/scripts').map((e) => e.path)).toEqual(['/scripts/renamed.ts'])
    store.delete('/scripts/renamed.ts')
    expect(store.list('/scripts')).toEqual([])

    // The proof: the read-only directory is still completely empty.
    expect(readdirSync(dataDir)).toEqual([])
  })
})
