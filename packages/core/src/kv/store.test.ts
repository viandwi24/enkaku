import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { openDb, runMigrations, type Db } from '../db'
import { EnkakuError } from '../util/errors'
import { buildSecretRedactor, createKvStore, type KvQuotas, type KvStore } from './store'

const GENEROUS: KvQuotas = { maxValueBytes: 65_536, maxKeyLength: 256, maxEntriesPerNamespace: 1_000, maxEntriesPerDevice: 5_000 }

let tmpDirs: string[] = []

function tempDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'enkaku-kv-'))
  tmpDirs.push(dir)
  return dir
}

function setUp(quotas: KvQuotas = GENEROUS): { db: Db; store: KvStore; dataDir: string } {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  const dataDir = tempDataDir()
  return { db: opened.db, store: createKvStore(opened.db, dataDir, () => quotas), dataDir }
}

function setUpFileBacked(quotas: KvQuotas = GENEROUS): {
  store: KvStore
  dataDir: string
  dbPath: string
  /** Flushes WAL into the main file so a raw read of `dbPath` actually sees everything written so
   * far — `openDb` runs in WAL mode, and without this a write can sit in `<dbPath>-wal` instead. */
  checkpoint: () => void
} {
  const dataDir = tempDataDir()
  const dbPath = join(dataDir, 'enkaku.db')
  const opened = openDb(dbPath)
  runMigrations(opened.db)
  return {
    store: createKvStore(opened.db, dataDir, () => quotas),
    dataDir,
    dbPath,
    checkpoint: () => opened.sqlite.exec('PRAGMA wal_checkpoint(TRUNCATE)'),
  }
}

afterEach(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true })
  tmpDirs = []
})

const GLOBAL = { kind: 'global' as const }
const deviceA = { kind: 'device' as const, stableId: 'stable-a' }
const deviceB = { kind: 'device' as const, stableId: 'stable-b' }

describe('kv store (plan 79 §3, §4.1, step 79.3)', () => {
  // Criterion 1
  test('a device-scoped value written for one device is read back by a later call on the SAME device', () => {
    const { store } = setUp()
    store.set(deviceA, 'login', 'session', { userId: 'u1' })
    const entry = store.get(deviceA, 'login', 'session')
    expect(entry?.value).toEqual({ userId: 'u1' })
  })

  // Criterion 2
  test('a device-scoped value is invisible to a DIFFERENT device — same key, same namespace', () => {
    const { store } = setUp()
    store.set(deviceA, 'login', 'session', { userId: 'u1' })
    expect(store.get(deviceB, 'login', 'session')).toBeNull()
  })

  // Criterion 3
  test('two namespaces writing the same key in the same scope do not see each other\'s value', () => {
    const { store } = setUp()
    store.set(GLOBAL, 'plugin-a', 'token', 'a-token')
    store.set(GLOBAL, 'plugin-b', 'token', 'b-token')
    expect(store.get(GLOBAL, 'plugin-a', 'token')?.value).toBe('a-token')
    expect(store.get(GLOBAL, 'plugin-b', 'token')?.value).toBe('b-token')
  })

  test('global and device scope with the same namespace+key do not collide either', () => {
    const { store } = setUp()
    store.set(GLOBAL, 'ns', 'k', 'global-value')
    store.set(deviceA, 'ns', 'k', 'device-value')
    expect(store.get(GLOBAL, 'ns', 'k')?.value).toBe('global-value')
    expect(store.get(deviceA, 'ns', 'k')?.value).toBe('device-value')
  })

  // Criterion 5
  test('setIfVersion with a stale version returns null and leaves the stored value unchanged', () => {
    const { store } = setUp()
    const written = store.set(GLOBAL, 'ns', 'k', 'v1')
    expect(written.version).toBe(1)
    const result = store.setIfVersion(GLOBAL, 'ns', 'k', 'v2', 99)
    expect(result).toBeNull()
    expect(store.get(GLOBAL, 'ns', 'k')?.value).toBe('v1')
  })

  test('setIfVersion with the correct version succeeds and bumps the version', () => {
    const { store } = setUp()
    const written = store.set(GLOBAL, 'ns', 'k', 'v1')
    const result = store.setIfVersion(GLOBAL, 'ns', 'k', 'v2', written.version)
    expect(result?.version).toBe(2)
    expect(store.get(GLOBAL, 'ns', 'k')?.value).toBe('v2')
  })

  test('setIfVersion against a key that does not exist yet returns null', () => {
    const { store } = setUp()
    expect(store.setIfVersion(GLOBAL, 'ns', 'nope', 'v', 1)).toBeNull()
    expect(store.get(GLOBAL, 'ns', 'nope')).toBeNull()
  })

  // Criterion 6
  test('two concurrent increment calls on one key yield exactly +2, never a lost update', async () => {
    const { store } = setUp()
    const results = await Promise.all([
      Promise.resolve().then(() => store.increment(GLOBAL, 'ns', 'counter', 1)),
      Promise.resolve().then(() => store.increment(GLOBAL, 'ns', 'counter', 1)),
    ])
    expect(new Set(results)).toEqual(new Set([1, 2]))
    expect(store.get(GLOBAL, 'ns', 'counter')?.value).toBe(2)
  })

  test('increment auto-vivifies a missing key starting from 0', () => {
    const { store } = setUp()
    expect(store.increment(GLOBAL, 'ns', 'fresh', 5)).toBe(5)
  })

  test('increment refuses a non-numeric existing value', () => {
    const { store } = setUp()
    store.set(GLOBAL, 'ns', 'k', 'not a number')
    expect(() => store.increment(GLOBAL, 'ns', 'k')).toThrow(EnkakuError)
  })

  // Criterion 7
  test('a value past its TTL reads as null BEFORE any sweep has run', () => {
    const { store } = setUp()
    store.set(GLOBAL, 'ns', 'temp', 'v', { ttlSec: -1 }) // already expired the instant it's written
    expect(store.get(GLOBAL, 'ns', 'temp')).toBeNull()
  })

  test('sweepExpired deletes an expired row and counts it', () => {
    const { store } = setUp()
    store.set(GLOBAL, 'ns', 'temp', 'v', { ttlSec: -1 })
    expect(store.sweepExpired()).toBe(1)
    expect(store.sweepExpired()).toBe(0)
  })

  test('a non-expired TTL value is read back fine', () => {
    const { store } = setUp()
    store.set(GLOBAL, 'ns', 'temp', 'v', { ttlSec: 3600 })
    expect(store.get(GLOBAL, 'ns', 'temp')?.value).toBe('v')
  })

  // Criterion 8
  test('a value larger than the cap is refused with E_KV_VALUE_TOO_LARGE; nothing is written', () => {
    const { store } = setUp({ ...GENEROUS, maxValueBytes: 16 })
    expect(() => store.set(GLOBAL, 'ns', 'k', 'this string is definitely over sixteen bytes')).toThrow(EnkakuError)
    expect(store.get(GLOBAL, 'ns', 'k')).toBeNull()
  })

  test('quota: maxEntriesPerNamespace refuses a new key once at the limit', () => {
    const { store } = setUp({ ...GENEROUS, maxEntriesPerNamespace: 1 })
    store.set(GLOBAL, 'ns', 'k1', 'v')
    expect(() => store.set(GLOBAL, 'ns', 'k2', 'v')).toThrow(EnkakuError)
    // Overwriting the EXISTING key is still fine — it is not a new entry.
    expect(() => store.set(GLOBAL, 'ns', 'k1', 'v2')).not.toThrow()
  })

  test('quota: maxEntriesPerDevice is enforced across every namespace on one device', () => {
    const { store } = setUp({ ...GENEROUS, maxEntriesPerDevice: 1 })
    store.set(deviceA, 'ns1', 'k1', 'v')
    expect(() => store.set(deviceA, 'ns2', 'k2', 'v')).toThrow(EnkakuError)
    // A different device is unaffected.
    expect(() => store.set(deviceB, 'ns1', 'k1', 'v')).not.toThrow()
  })

  // Criterion 9 is covered in device/lifecycle.test.ts (deleteDevice is exercised through Forget).
  test('deleteDevice removes every value for that stableId, across namespaces, and counts them', () => {
    const { store } = setUp()
    store.set(deviceA, 'ns1', 'k1', 'v')
    store.set(deviceA, 'ns2', 'k2', 'v')
    store.set(deviceB, 'ns1', 'k1', 'v')
    store.set(GLOBAL, 'ns1', 'k1', 'v')
    expect(store.deleteDevice('stable-a')).toBe(2)
    expect(store.get(deviceA, 'ns1', 'k1')).toBeNull()
    expect(store.get(deviceA, 'ns2', 'k2')).toBeNull()
    // Untouched: a different device, and the global scope.
    expect(store.get(deviceB, 'ns1', 'k1')?.value).toBe('v')
    expect(store.get(GLOBAL, 'ns1', 'k1')?.value).toBe('v')
    expect(store.deleteDevice('stable-a')).toBe(0)
  })

  // Criterion 10
  test('list paginates by keyset and NEVER returns a secret\'s plaintext', () => {
    const { store } = setUp()
    store.set(GLOBAL, 'ns', 'a', 'plain-a')
    store.set(GLOBAL, 'ns', 'b', 'super-secret-value', { secret: true })
    store.set(GLOBAL, 'ns', 'c', 'plain-c')
    const page1 = store.list(GLOBAL, 'ns', { limit: 2 })
    expect(page1.items.map((i) => i.key)).toEqual(['a', 'b'])
    expect(page1.items.find((i) => i.key === 'b')?.value).toBeNull()
    expect(page1.items.find((i) => i.key === 'b')?.secret).toBe(true)
    expect(page1.items.find((i) => i.key === 'b')?.hint).not.toBeNull()
    expect(page1.nextCursor).toBe('b')

    const page2 = store.list(GLOBAL, 'ns', { limit: 2, cursor: page1.nextCursor })
    expect(page2.items.map((i) => i.key)).toEqual(['c'])
    expect(page2.nextCursor).toBeNull()
  })

  test('list respects a prefix filter', () => {
    const { store } = setUp()
    store.set(GLOBAL, 'ns', 'user:1', 'v')
    store.set(GLOBAL, 'ns', 'user:2', 'v')
    store.set(GLOBAL, 'ns', 'other', 'v')
    const page = store.list(GLOBAL, 'ns', { prefix: 'user:', limit: 50 })
    expect(page.items.map((i) => i.key).sort()).toEqual(['user:1', 'user:2'])
  })

  test('list excludes an expired row even before a sweep', () => {
    const { store } = setUp()
    store.set(GLOBAL, 'ns', 'temp', 'v', { ttlSec: -1 })
    store.set(GLOBAL, 'ns', 'live', 'v')
    const page = store.list(GLOBAL, 'ns', { limit: 50 })
    expect(page.items.map((i) => i.key)).toEqual(['live'])
  })

  // get() DOES decrypt — only used by a running job (never the HTTP API directly).
  test('get() on a secret entry DOES return the decrypted plaintext (the job-only path)', () => {
    const { store } = setUp()
    store.set(GLOBAL, 'ns', 'token', 'sk-real-secret', { secret: true })
    const entry = store.get(GLOBAL, 'ns', 'token')
    expect(entry?.value).toBe('sk-real-secret')
    expect(entry?.secret).toBe(true)
    expect(entry?.hint).toContain('…')
  })

  // Criterion 12
  test('a key with a "/" is refused', () => {
    const { store } = setUp()
    expect(() => store.set(GLOBAL, 'ns', 'a/b', 'v')).toThrow(EnkakuError)
  })

  test('a key with a space is refused', () => {
    const { store } = setUp()
    expect(() => store.set(GLOBAL, 'ns', 'a b', 'v')).toThrow(EnkakuError)
  })

  test('a key over maxKeyLength is refused', () => {
    const { store } = setUp({ ...GENEROUS, maxKeyLength: 4 })
    expect(() => store.set(GLOBAL, 'ns', 'toolong', 'v')).toThrow(EnkakuError)
  })

  test('an empty key is refused', () => {
    const { store } = setUp()
    expect(() => store.set(GLOBAL, 'ns', '', 'v')).toThrow(EnkakuError)
  })

  test('delete removes a key and returns true; a second delete returns false', () => {
    const { store } = setUp()
    store.set(GLOBAL, 'ns', 'k', 'v')
    expect(store.delete(GLOBAL, 'ns', 'k')).toBe(true)
    expect(store.delete(GLOBAL, 'ns', 'k')).toBe(false)
  })

  test('delete with a stale ifVersion returns false and leaves the value in place', () => {
    const { store } = setUp()
    store.set(GLOBAL, 'ns', 'k', 'v')
    expect(store.delete(GLOBAL, 'ns', 'k', { ifVersion: 99 })).toBe(false)
    expect(store.get(GLOBAL, 'ns', 'k')?.value).toBe('v')
  })

  test('deleteNamespace removes every key under one (scope, namespace) and counts them', () => {
    const { store } = setUp()
    store.set(GLOBAL, 'ns1', 'a', 'v')
    store.set(GLOBAL, 'ns1', 'b', 'v')
    store.set(GLOBAL, 'ns2', 'a', 'v')
    expect(store.deleteNamespace(GLOBAL, 'ns1')).toBe(2)
    expect(store.get(GLOBAL, 'ns1', 'a')).toBeNull()
    expect(store.get(GLOBAL, 'ns2', 'a')?.value).toBe('v')
  })

  // Criterion 4 — the secret-leak goal, asserted against a REAL file-backed DB.
  test('a secret\'s plaintext never appears in the raw enkaku.db file on disk', () => {
    const { store, dbPath, checkpoint } = setUpFileBacked()
    const SECRET = 'sk-ant-VERY-REAL-LOOKING-SECRET-VALUE-1234567890'
    store.set(GLOBAL, 'tiktok-login', 'session-token', SECRET, { secret: true })
    // A non-secret value, for contrast — this one SHOULD be findable (JSON text column).
    store.set(GLOBAL, 'tiktok-login', 'username', 'plain-username')
    checkpoint()

    const raw = readFileSync(dbPath, 'latin1') // byte-preserving read; the value is plain ASCII here
    expect(raw).not.toContain(SECRET)
    expect(raw).toContain('plain-username')
  })

  test('list() never leaks a secret plaintext either, on the same file-backed DB', () => {
    const { store } = setUpFileBacked()
    const SECRET = 'sk-ant-another-very-real-secret-abcdef'
    store.set(GLOBAL, 'ns', 'token', SECRET, { secret: true })
    const page = store.list(GLOBAL, 'ns', { limit: 50 })
    expect(JSON.stringify(page)).not.toContain(SECRET)
  })
})

/**
 * Plan 112 step 112.2 / finding F12 — `secretHint` is `${first 7}…${last 4}` of the plaintext,
 * stored in the CLEAR on the row and returned by every read path. Right for an API key with a
 * public prefix (an operator has to tell two of them apart); wrong for a password.
 *
 * `hint: false` is the opt-out. The tests below pin BOTH halves of the contract: that the flag
 * works, and — the load-bearing half — that omitting it changes nothing at all.
 */
describe('KvSetOptions.hint (plan 112 step 112.2, finding F12)', () => {
  const PASSWORD = 'Sup3rSecretUpstreamPassword'

  test('a secret written with hint: false has hint === null on every in-process read path', () => {
    const { store } = setUp()
    const written = store.set(GLOBAL, 'proxy-manager', 'proxy-secret:a', { password: PASSWORD }, { secret: true, hint: false })
    // 1. the return of the write itself
    expect(written.secret).toBe(true)
    expect(written.hint).toBeNull()
    // 2. get() — the decrypting path a job/plugin uses
    const got = store.get(GLOBAL, 'proxy-manager', 'proxy-secret:a')
    expect(got?.value).toEqual({ password: PASSWORD })
    expect(got?.hint).toBeNull()
    // 3. list() — the browsing path every HTTP list is built on
    const listed = store.list(GLOBAL, 'proxy-manager', { limit: 50 }).items.find((i) => i.key === 'proxy-secret:a')
    expect(listed?.secret).toBe(true)
    expect(listed?.hint).toBeNull()
    // No fragment of the password is anywhere in what a BROWSING caller receives. (`written` and
    // `got` legitimately carry the plaintext — both are in-process returns to the caller that
    // supplied or asked for it; `api/kv.ts`'s `redactEntry` is what strips it at the HTTP edge,
    // asserted in `api/plugins-data.test.ts`.)
    expect(JSON.stringify(listed)).not.toContain(PASSWORD.slice(0, 7))
    expect(JSON.stringify(listed)).not.toContain(PASSWORD.slice(-4))
  })

  test('the hint column itself is null on disk — nothing to leak, rather than something not shown', () => {
    const { store, dbPath, checkpoint } = setUpFileBacked()
    store.set(GLOBAL, 'ns', 'credential', { password: PASSWORD }, { secret: true, hint: false })
    checkpoint()
    const raw = readFileSync(dbPath, 'latin1')
    expect(raw).not.toContain(PASSWORD)
    // The object-shaped hint would have been `{"passw…rd"}` (plan 112 §9 Q7's measurement); the
    // bare-string one would have been the eleven characters F12 names. Neither is on the row.
    // (Only fragments long enough to be distinctive are searched: a four-character tail like
    // `word` occurs in the migrations' own SQL text, and asserting on it would fail on noise.)
    expect(raw).not.toContain('{"passw')
    expect(raw).not.toContain(PASSWORD.slice(0, 7))
  })

  test('omitting the option is byte-for-byte the write this store has always done — the hint is still there', () => {
    const { store } = setUp()
    store.set(GLOBAL, 'ns', 'api-key', 'sk-ant-api03-abcdefgh7Xq2', { secret: true })
    expect(store.get(GLOBAL, 'ns', 'api-key')?.hint).toBe('sk-ant-…7Xq2')
    expect(store.list(GLOBAL, 'ns', { limit: 50 }).items[0]?.hint).toBe('sk-ant-…7Xq2')
  })

  test('hint: true is explicitly the same as omitting it', () => {
    const { store } = setUp()
    store.set(GLOBAL, 'ns', 'a', 'sk-ant-api03-abcdefgh7Xq2', { secret: true, hint: true })
    store.set(GLOBAL, 'ns', 'b', 'sk-ant-api03-abcdefgh7Xq2', { secret: true })
    expect(store.get(GLOBAL, 'ns', 'a')?.hint).toBe(store.get(GLOBAL, 'ns', 'b')?.hint)
  })

  test('hint: false on a NON-secret write changes nothing — a plain row never had a hint', () => {
    const { store } = setUp()
    const entry = store.set(GLOBAL, 'ns', 'plain', 'visible', { hint: false })
    expect(entry.hint).toBeNull()
    expect(store.get(GLOBAL, 'ns', 'plain')?.value).toBe('visible')
  })

  test('setIfVersion carries it too, so a credential can be updated without growing a hint', () => {
    const { store } = setUp()
    const first = store.set(GLOBAL, 'ns', 'credential', { password: PASSWORD }, { secret: true, hint: false })
    const second = store.setIfVersion(GLOBAL, 'ns', 'credential', { password: `${PASSWORD}-2` }, first.version, { secret: true, hint: false })
    expect(second?.hint).toBeNull()
    expect(store.get(GLOBAL, 'ns', 'credential')?.hint).toBeNull()
  })

  test('it is per write, not sticky: a later set() that omits it re-derives the hint', () => {
    const { store } = setUp()
    store.set(GLOBAL, 'ns', 'credential', 'sk-ant-api03-abcdefgh7Xq2', { secret: true, hint: false })
    expect(store.get(GLOBAL, 'ns', 'credential')?.hint).toBeNull()
    store.set(GLOBAL, 'ns', 'credential', 'sk-ant-api03-abcdefgh7Xq2', { secret: true })
    // Documented behaviour, not an accident — `KvSetOptions.hint` says so, and a caller storing a
    // credential must pass it on every write exactly as it passes `secret`.
    expect(store.get(GLOBAL, 'ns', 'credential')?.hint).toBe('sk-ant-…7Xq2')
  })
})

describe('buildSecretRedactor (plan 79 §4.7)', () => {
  test('redacts every secret readable in the given scopes, naming the key', () => {
    const { store } = setUp()
    store.set(GLOBAL, 'ns', 'token', 'the-secret-value', { secret: true })
    store.set(deviceA, 'ns', 'other', 'device-secret-abc', { secret: true })
    store.set(GLOBAL, 'ns', 'plain', 'not a secret')

    const redact = buildSecretRedactor(store, [GLOBAL, deviceA], 'ns')
    const text = redact('leaking the-secret-value and device-secret-abc here')
    expect(text).not.toContain('the-secret-value')
    expect(text).not.toContain('device-secret-abc')
    expect(text).toContain('«redacted:token»')
    expect(text).toContain('«redacted:other»')
  })

  test('never touches text when there is nothing secret in scope', () => {
    const { store } = setUp()
    store.set(GLOBAL, 'ns', 'plain', 'not a secret')
    const redact = buildSecretRedactor(store, [GLOBAL], 'ns')
    expect(redact('hello world')).toBe('hello world')
  })

  test('does not redact a secret shorter than 8 characters (false-positive guard)', () => {
    const { store } = setUp()
    store.set(GLOBAL, 'ns', 'short', 'abc123', { secret: true })
    const redact = buildSecretRedactor(store, [GLOBAL], 'ns')
    expect(redact('the value is abc123')).toBe('the value is abc123')
  })
})

describe('namespaces() — the index the store shipped without', () => {
  test('lists only namespaces that actually have entries in the queried scope, ascending, with counts', () => {
    const { store } = setUp()
    store.set(GLOBAL, 'tiktok', 'a', 1)
    store.set(GLOBAL, 'tiktok', 'b', 2)
    store.set(GLOBAL, 'proxy-manager', 'a', 3)
    store.set(deviceA, 'tiktok', 'a', 4)

    expect(store.namespaces(GLOBAL)).toEqual([
      { namespace: 'proxy-manager', entries: 1, secrets: 0 },
      { namespace: 'tiktok', entries: 2, secrets: 0 },
    ])
    // The device scope sees ONLY its own rows — this is what stops a device panel advertising a
    // plugin that has never written anything for that device.
    expect(store.namespaces(deviceA)).toEqual([{ namespace: 'tiktok', entries: 1, secrets: 0 }])
  })

  test('a device scope with nothing stored is an empty list, not the global list', () => {
    const { store } = setUp()
    store.set(GLOBAL, 'tiktok', 'a', 1)
    expect(store.namespaces({ kind: 'device', stableId: 'stable-nothing' })).toEqual([])
  })

  test('counts secrets separately and never returns a value or a hint', () => {
    const { store } = setUp()
    store.set(GLOBAL, 'ns', 'plain', 'visible')
    store.set(GLOBAL, 'ns', 'token', 'sk-ant-api03-abcdefgh7Xq2', { secret: true })
    store.set(GLOBAL, 'ns', 'other', 'sk-ant-api03-zyxwvuts1234', { secret: true })

    const [row] = store.namespaces(GLOBAL)
    expect(row).toEqual({ namespace: 'ns', entries: 3, secrets: 2 })
    // The index is metadata only, by construction — widening it into a preview would turn an
    // enumeration route into a disclosure route (`KvNamespaceSchema` says the same).
    expect(JSON.stringify(row)).not.toContain('sk-ant')
    expect(JSON.stringify(row)).not.toContain('…')
  })

  test('an expired row is excluded the instant it is past, without waiting for sweepExpired', () => {
    const { store } = setUp()
    store.set(GLOBAL, 'lives', 'k', 1)
    store.set(GLOBAL, 'dies', 'k', 1, { ttlSec: -1 })
    expect(store.namespaces(GLOBAL)).toEqual([{ namespace: 'lives', entries: 1, secrets: 0 }])
  })

  test('a namespace disappears once its last entry is deleted — an index has nothing to index', () => {
    const { store } = setUp()
    store.set(GLOBAL, 'ns', 'only', 1)
    expect(store.namespaces(GLOBAL).length).toBe(1)
    store.delete(GLOBAL, 'ns', 'only')
    expect(store.namespaces(GLOBAL)).toEqual([])
  })
})
