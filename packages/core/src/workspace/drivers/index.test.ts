import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'
import { openDb, runMigrations, type Db } from '../../db'
import { createWorkspaceStore, type WorkspaceQuotas, type WorkspaceStore } from '../store'
import { createFsContentDriver, createInlineDriver } from './index'

/**
 * The content driver seam (plan 115 §3.1, §4.1, step 115.1 — tested here per
 * step 115.7, §7). `inline` and `fs` each get their own round trip; the
 * refcounted delete (criterion 8) and the "no operator name ever reaches
 * disk" claim (§3.3) are proven THROUGH the store, per this step's own
 * instructions, since both are properties of how the store CALLS a driver,
 * not of the driver in isolation.
 */

const enc = (s: string) => new TextEncoder().encode(s)
const dec = (b: Uint8Array) => new TextDecoder().decode(b)

function sha256Hex(bytes: Uint8Array): string {
  const hasher = new Bun.CryptoHasher('sha256')
  hasher.update(bytes)
  return hasher.digest('hex')
}

const dirs: string[] = []
function tmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'enkaku-workspace-fs-driver-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('createFsContentDriver — round trip and content addressing (§3.3)', () => {
  test('put then get round-trips the exact bytes', () => {
    const driver = createFsContentDriver(tmpRoot())
    const content = enc('these are some video bytes, not really')
    const hash = sha256Hex(content)
    const { locator } = driver.put(content, hash)
    expect(locator).toBe(hash)
    expect(dec(driver.get(locator))).toBe('these are some video bytes, not really')
  })

  test('the on-disk layout is exactly <root>/<first-two-hex-chars>/<sha256>', () => {
    const root = tmpRoot()
    const driver = createFsContentDriver(root)
    const content = enc('layout check')
    const hash = sha256Hex(content)
    driver.put(content, hash)
    const expectedPath = join(root, hash.slice(0, 2), hash)
    expect(existsSync(expectedPath)).toBe(true)
    expect(readFileSync(expectedPath)).toEqual(Buffer.from(content))
  })

  test('the same content written twice yields the identical locator (content-addressed, §3.3)', () => {
    const root = tmpRoot()
    const driver = createFsContentDriver(root)
    const content = enc('duplicate me')
    const hash = sha256Hex(content)
    const first = driver.put(content, hash)
    const second = driver.put(content, hash)
    expect(first.locator).toBe(second.locator)
    // Still exactly one file on disk for it — the second `put` was a no-op.
    expect(readdirSync(join(root, hash.slice(0, 2)))).toEqual([hash])
  })

  test('delete unlinks the file at its locator', () => {
    const root = tmpRoot()
    const driver = createFsContentDriver(root)
    const content = enc('to be deleted')
    const hash = sha256Hex(content)
    driver.put(content, hash)
    const onDisk = join(root, hash.slice(0, 2), hash)
    expect(existsSync(onDisk)).toBe(true)
    driver.delete(hash)
    expect(existsSync(onDisk)).toBe(false)
  })

  test('no operator-supplied name ever reaches the filesystem — the locator is ALWAYS a bare hex digest, never a path (§3.3, "structurally absent")', () => {
    const root = tmpRoot()
    const driver = createFsContentDriver(root)
    // `put`'s own signature is `(content, hash)` — there is no `path` or
    // `name` parameter for a caller to smuggle a traversal attempt through
    // in the first place. An operator might have named this file (in the
    // WORKSPACE, i.e. the store's own `path` column, which this driver never
    // sees) something like "../../etc/passwd" — that string has no bearing
    // on where this driver puts the bytes: only `content`'s own sha256 does.
    const content = enc('a video an operator named ../../etc/passwd in the workspace')
    const hash = sha256Hex(content)
    const { locator } = driver.put(content, hash)
    expect(locator).toBe(hash)
    expect(locator).toMatch(/^[0-9a-f]{64}$/)
    expect(existsSync(join(root, hash.slice(0, 2), hash))).toBe(true)
    // Walk the whole root: every directory is exactly two hex chars, every
    // file inside it is exactly a 64-char hex digest — nothing resembling a
    // name, a `..` segment, or any operator-chosen string ever landed here.
    for (const entry of readdirSync(root)) {
      expect(entry).toMatch(/^[0-9a-f]{2}$/)
      for (const file of readdirSync(join(root, entry))) {
        expect(file).toMatch(/^[0-9a-f]{64}$/)
      }
    }
  })
})

describe('createInlineDriver — bytes stay in the row, never on disk (§3.2)', () => {
  test('put returns the empty locator and touches no directory the caller gives it', () => {
    const driver = createInlineDriver()
    const { locator } = driver.put(enc('anything'), 'irrelevant-hash')
    expect(locator).toBe('')
  })

  test('get is unreachable — inline content is read by the store directly from the row, never through this driver', () => {
    const driver = createInlineDriver()
    expect(() => driver.get('')).toThrow()
  })

  test('delete is a no-op — inline bytes die with the row, not with a driver call', () => {
    const driver = createInlineDriver()
    expect(() => driver.delete('')).not.toThrow()
  })

  test('the driver never imports/touches node:fs — proven indirectly: no root/path argument exists on its interface at all', () => {
    // `createInlineDriver` takes no arguments (unlike `createFsContentDriver(root)`) — there is no
    // filesystem location for it to even be configured with.
    expect(createInlineDriver.length).toBe(0)
  })
})

// ---- Criterion 8 and §3.3's traversal claim, through the STORE (both are properties of how
// store.ts CALLS a driver, not of the driver alone — tested here rather than against the bare
// driver per this step's own instructions). ----

const GENEROUS_QUOTAS: WorkspaceQuotas = { maxFileBytes: 10 * 1024 * 1024, maxFilesPerScope: 1_000, maxTotalBytesPerScope: 64 * 1024 * 1024, inlineMaxBytes: 16 }

function setUpStore(fsContentRoot: string, quotas: WorkspaceQuotas = GENEROUS_QUOTAS): { db: Db; store: WorkspaceStore } {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  return { db: opened.db, store: createWorkspaceStore(opened.db, () => quotas, { fsContentRoot }) }
}

describe('criterion 8 — two rows sharing a locator: deleting one must not make the other unreadable', () => {
  test('the store refcounts the fs driver\'s locator across two rows with identical content', () => {
    const root = tmpRoot()
    const { store } = setUpStore(root)
    // Both files are large/binary enough (over `inlineMaxBytes`, and not a text contentType) to
    // route to the `fs` driver, per §3.4's write-routing policy.
    const bytes = new Uint8Array(1000).fill(42)
    const a = store.write('/shared/a.mp4', { content: bytes, contentType: 'video/mp4', actor: null })
    const b = store.write('/shared/b.mp4', { content: bytes, contentType: 'video/mp4', actor: null })
    expect(a.hash).toBe(b.hash) // identical content -> identical content address -> shared locator

    const onDisk = join(root, a.hash.slice(0, 2), a.hash)
    expect(existsSync(onDisk)).toBe(true)

    // Deleting ONE of the two rows must not delete the shared bytes — the other row still points at
    // that exact locator.
    store.delete('/shared/a.mp4')
    expect(existsSync(onDisk)).toBe(true) // the blob survives — b.mp4 still references it
    expect(dec(store.read('/shared/b.mp4').content)).toBe(dec(bytes))

    // Only once the LAST row referencing it is gone does the blob actually get unlinked.
    store.delete('/shared/b.mp4')
    expect(existsSync(onDisk)).toBe(false)
  })
})

describe('§3.3 — the operator\'s workspace path never becomes the on-disk name, proven end to end through the store', () => {
  test('a literal ".." path segment is rejected long before any driver runs (defense layer one: path.ts)', () => {
    const root = tmpRoot()
    const { store } = setUpStore(root)
    expect(() => store.write('/../../etc/passwd', { content: enc('x'), actor: null })).toThrow()
  })

  test('a validly-named file still lands on disk addressed by hash alone — its workspace path appears nowhere in the filesystem (defense layer two: content addressing, §3.3)', () => {
    const root = tmpRoot()
    const { store } = setUpStore(root)
    const content = new Uint8Array(1000).fill(7)
    const meta = store.write('/uploads/very-secret-video-name.mp4', { content, contentType: 'video/mp4', actor: null })
    const onDisk = join(root, meta.hash.slice(0, 2), meta.hash)
    expect(existsSync(onDisk)).toBe(true)
    // Nowhere under root does "uploads", "very-secret-video-name", or ".mp4" appear as a path
    // component — every directory and file is a bare hex string.
    for (const entry of readdirSync(root)) {
      expect(entry).toMatch(/^[0-9a-f]{2}$/)
      for (const file of readdirSync(join(root, entry))) {
        expect(file).toMatch(/^[0-9a-f]{64}$/)
      }
    }
  })
})
