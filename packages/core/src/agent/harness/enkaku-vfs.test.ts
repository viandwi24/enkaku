import { MemoryVFS, type VFS } from '@enkaku/harness'
import { describe, expect, test } from 'bun:test'
import { openDb, runMigrations } from '../../db'
import { createWorkspaceStore, type WorkspaceQuotas } from '../../workspace/store'
import { EnkakuVFS } from './enkaku-vfs'

/**
 * §7's contract suite (plan 77, criterion 1): the SAME assertions run against the harness's own
 * `MemoryVFS` and against `EnkakuVFS` — any divergence is a driver bug, not a design difference,
 * and this is the cheapest way to find one.
 */

const QUOTAS: WorkspaceQuotas = { maxFileBytes: 1_048_576, maxFilesPerScope: 1_000, maxTotalBytesPerScope: 64 * 1024 * 1024 }

function makeEnkakuVfs(): VFS {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  const store = createWorkspaceStore(opened.db, () => QUOTAS)
  return new EnkakuVFS(store, { read: ['/'], write: ['/'] }, { actor: 'user:u1' })
}

const drivers: { name: string; make: () => VFS }[] = [
  { name: 'MemoryVFS (harness)', make: () => new MemoryVFS() },
  { name: 'EnkakuVFS (plan 64 store)', make: makeEnkakuVfs },
]

describe.each(drivers)('VFS contract — $name', ({ make }) => {
  test('read on a missing path returns null, not a throw', async () => {
    const vfs = make()
    expect(await vfs.read('/nope.ts')).toBeNull()
  })

  test('stat on a missing path returns null', async () => {
    const vfs = make()
    expect(await vfs.stat('/nope.ts')).toBeNull()
  })

  test('exists is false for a missing path, true after a write', async () => {
    const vfs = make()
    expect(await vfs.exists('/a.ts')).toBe(false)
    await vfs.write('/a.ts', 'hi')
    expect(await vfs.exists('/a.ts')).toBe(true)
  })

  test('write then read round-trips content', async () => {
    const vfs = make()
    await vfs.write('/a.ts', 'hello world')
    expect(await vfs.read('/a.ts')).toBe('hello world')
  })

  test('write is unconditional — a second write overwrites without needing the prior version', async () => {
    const vfs = make()
    await vfs.write('/a.ts', 'v1')
    await vfs.write('/a.ts', 'v2')
    expect(await vfs.read('/a.ts')).toBe('v2')
  })

  test('write returns a version, and stat returns the SAME version for unchanged content', async () => {
    const vfs = make()
    const v1 = await vfs.write('/a.ts', 'content')
    const stat1 = await vfs.stat('/a.ts')
    expect(stat1?.version).toBe(v1)
    const stat2 = await vfs.stat('/a.ts')
    expect(stat2?.version).toBe(v1) // stable across reads of unchanged content (criterion 3)
  })

  test('writing different content changes the version', async () => {
    const vfs = make()
    const v1 = await vfs.write('/a.ts', 'v1')
    const v2 = await vfs.write('/a.ts', 'v2')
    expect(v2).not.toBe(v1)
  })

  // ---- writeIfVersion — the compare-and-swap the whole interface exists for (criterion 2) ----

  test('writeIfVersion succeeds when the expected version matches, and changes the content', async () => {
    const vfs = make()
    const v1 = await vfs.write('/a.ts', 'v1')
    const ok = await vfs.writeIfVersion('/a.ts', 'v2', v1)
    expect(ok).toBe(true)
    expect(await vfs.read('/a.ts')).toBe('v2')
  })

  test('writeIfVersion fails on a stale version and does NOT write', async () => {
    const vfs = make()
    await vfs.write('/a.ts', 'v1')
    const ok = await vfs.writeIfVersion('/a.ts', 'v2', 'not-the-real-version')
    expect(ok).toBe(false)
    expect(await vfs.read('/a.ts')).toBe('v1') // untouched
  })

  test('writeIfVersion on a path that does not exist fails — there is nothing to compare against', async () => {
    const vfs = make()
    const ok = await vfs.writeIfVersion('/nope.ts', 'v1', 'anything')
    expect(ok).toBe(false)
    expect(await vfs.exists('/nope.ts')).toBe(false)
  })

  test('a concurrent pair racing writeIfVersion — one wins, one loses, neither is silently lost (criterion 2)', async () => {
    const vfs = make()
    const base = await vfs.write('/race.ts', 'base')
    const [a, b] = await Promise.all([vfs.writeIfVersion('/race.ts', 'from-a', base), vfs.writeIfVersion('/race.ts', 'from-b', base)])
    const results = [a, b]
    expect(results.filter((r) => r === true).length).toBe(1)
    expect(results.filter((r) => r === false).length).toBe(1)
    const raceContent = await vfs.read('/race.ts')
    expect(['from-a', 'from-b']).toContain(raceContent ?? '')
  })

  // ---- delete ----

  test('delete removes the file and returns true; deleting again returns false', async () => {
    const vfs = make()
    await vfs.write('/a.ts', 'v')
    expect(await vfs.delete('/a.ts')).toBe(true)
    expect(await vfs.exists('/a.ts')).toBe(false)
    expect(await vfs.delete('/a.ts')).toBe(false)
  })

  // ---- list ----

  test('list returns every written file with its size', async () => {
    const vfs = make()
    await vfs.write('/a.ts', 'abc')
    await vfs.write('/dir/b.ts', 'de')
    const files = await vfs.list()
    expect(files.map((f) => f.path).sort()).toEqual(['/a.ts', '/dir/b.ts'].map((p) => p).sort())
    const a = files.find((f) => f.path === '/a.ts')
    expect(a?.size).toBe(3)
  })

  test('list on an empty VFS returns an empty array', async () => {
    const vfs = make()
    expect(await vfs.list()).toEqual([])
  })

  test('a deleted file no longer appears in list', async () => {
    const vfs = make()
    await vfs.write('/a.ts', 'v')
    await vfs.write('/b.ts', 'v')
    await vfs.delete('/a.ts')
    const files = await vfs.list()
    expect(files.map((f) => f.path)).toEqual(['/b.ts'])
  })

  // ---- grep ----

  test('grep finds a pattern and reports path + 1-based line', async () => {
    const vfs = make()
    await vfs.write('/a.ts', 'one\nconst needle = 1\nthree')
    const hits = await vfs.grep('needle')
    expect(hits).toEqual([{ path: '/a.ts', line: 2, text: 'const needle = 1' }])
  })

  test('grep with no matches returns an empty array', async () => {
    const vfs = make()
    await vfs.write('/a.ts', 'nothing to see')
    expect(await vfs.grep('needle')).toEqual([])
  })

  test('grep with an invalid regex pattern finds nothing rather than throwing', async () => {
    const vfs = make()
    await vfs.write('/a.ts', 'some content')
    await expect(vfs.grep('[')).resolves.toEqual([])
  })
})

// ---------------------------------------------------------------------------
// EnkakuVFS-specific behaviour — outside the shared contract because it does
// not apply to MemoryVFS at all (plan 77 §3.1, §3.2).
// ---------------------------------------------------------------------------

function setUpStore() {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  return createWorkspaceStore(opened.db, () => QUOTAS)
}

describe('EnkakuVFS — version is the store\'s sha256 (plan 77 §3.1, criterion 3)', () => {
  test('the returned version is a 64-character hex sha256 digest, not the harness\'s sha1', async () => {
    const vfs = new EnkakuVFS(setUpStore(), { read: ['/'], write: ['/'] })
    const version = await vfs.write('/a.ts', 'content')
    expect(version).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('EnkakuVFS — scope respected on every method (plan 64 §3.2, plan 77 §3.2, criterion 4)', () => {
  test('read outside the read scope throws rather than leaking content', async () => {
    const store = setUpStore()
    const admin = new EnkakuVFS(store, { read: ['/'], write: ['/'] })
    await admin.write('/agents/y/secret.ts', 'top secret')

    const scoped = new EnkakuVFS(store, { read: ['/agents/x/'], write: ['/agents/x/'] })
    await expect(scoped.read('/agents/y/secret.ts')).rejects.toThrow()
  })

  test('list only returns files within the read scope', async () => {
    const store = setUpStore()
    const admin = new EnkakuVFS(store, { read: ['/'], write: ['/'] })
    await admin.write('/agents/x/mine.ts', 'a')
    await admin.write('/agents/y/theirs.ts', 'b')

    const scoped = new EnkakuVFS(store, { read: ['/agents/x/'], write: ['/agents/x/'] })
    const files = await scoped.list()
    expect(files.map((f) => f.path)).toEqual(['/agents/x/mine.ts'])
  })

  test('grep never returns a hit from outside the read scope (criterion 4, the negative case)', async () => {
    const store = setUpStore()
    const admin = new EnkakuVFS(store, { read: ['/'], write: ['/'] })
    await admin.write('/agents/y/secret.ts', 'const password = 1')

    const scoped = new EnkakuVFS(store, { read: ['/agents/x/'], write: ['/agents/x/'] })
    await scoped.write('/agents/x/mine.ts', 'const password = 2') // in-scope match should still be found
    const hits = await scoped.grep('password')
    expect(hits.map((h) => h.path)).toEqual(['/agents/x/mine.ts'])
  })

  test('write outside the write scope throws, even when readable', async () => {
    const store = setUpStore()
    const scoped = new EnkakuVFS(store, { read: ['/'], write: ['/agents/x/'] })
    await expect(scoped.write('/shared/notes.md', 'hi')).rejects.toThrow()
  })
})

describe('EnkakuVFS — writeExcludePrefixes (plan 77 §3.4, §4.4, criterion 11)', () => {
  test('a write to an excluded prefix throws even though it is within the write scope', async () => {
    const store = setUpStore()
    const vfs = new EnkakuVFS(store, { read: ['/'], write: ['/'] }, { writeExcludePrefixes: ['/skills/'] })
    await expect(vfs.write('/skills/checkout/SKILL.md', 'x')).rejects.toThrow()
    await expect(vfs.delete('/skills/checkout/SKILL.md')).rejects.toThrow()
  })

  test('a write outside the excluded prefix, still within scope, succeeds normally', async () => {
    const store = setUpStore()
    const vfs = new EnkakuVFS(store, { read: ['/'], write: ['/'] }, { writeExcludePrefixes: ['/skills/'] })
    await expect(vfs.write('/scripts/a.ts', 'x')).resolves.toBeTruthy()
  })

  test('reads are unaffected by writeExcludePrefixes — only write/delete are refused', async () => {
    const store = setUpStore()
    const admin = new EnkakuVFS(store, { read: ['/'], write: ['/'] })
    await admin.write('/skills/checkout/SKILL.md', 'body')
    const vfs = new EnkakuVFS(store, { read: ['/'], write: ['/'] }, { writeExcludePrefixes: ['/skills/'] })
    expect(await vfs.read('/skills/checkout/SKILL.md')).toBe('body')
  })
})

describe('EnkakuVFS — root prefix (plan 77 §4.4, used by the skills driver)', () => {
  test('a VFS rooted at /skills exposes relative paths and writes under the prefix', async () => {
    const store = setUpStore()
    const skillsVfs = new EnkakuVFS(store, { read: ['/skills/'], write: ['/skills/'] }, { root: '/skills' })
    await skillsVfs.write('checkout/SKILL.md', '---\nname: checkout\n---\nbody')

    const files = await skillsVfs.list()
    expect(files.map((f) => f.path)).toEqual(['checkout/SKILL.md'])

    // The SAME file, seen through the absolute (unrooted) workspace VFS.
    const admin = new EnkakuVFS(store, { read: ['/'], write: ['/'] })
    expect(await admin.read('/skills/checkout/SKILL.md')).toContain('name: checkout')
  })
})
