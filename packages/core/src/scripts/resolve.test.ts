import { describe, expect, test } from 'bun:test'
import { openDb, runMigrations, type Db } from '../db'
import { scripts } from '../db/schema'
import { EnkakuError } from '../util/errors'
import { resolveScriptRef } from './resolve'

function setUp(): Db {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  return opened.db
}

function publish(
  db: Db,
  name: string,
  version: string,
  opts: { enabled?: boolean; createdAt?: number } = {},
): string {
  const id = `${name}-${version}-${crypto.randomUUID().slice(0, 8)}`
  db.insert(scripts)
    .values({
      id,
      name,
      version,
      bundle: 'export {}',
      enabled: opts.enabled ?? true,
      createdAt: new Date((opts.createdAt ?? 1_700_000_000) * 1000),
    })
    .run()
  return id
}

describe('resolveScriptRef — concrete versions', () => {
  test('checkout@1.0.1 resolves to that exact version (plan 62 acceptance #1)', () => {
    const db = setUp()
    publish(db, 'checkout', '1.0.0')
    const id = publish(db, 'checkout', '1.0.1')
    const row = resolveScriptRef(db, 'checkout@1.0.1')
    expect(row.id).toBe(id)
    expect(row.version).toBe('1.0.1')
  })

  test('script_not_found when the name does not exist', () => {
    const db = setUp()
    expect(() => resolveScriptRef(db, 'nope@1.0.0')).toThrow(EnkakuError)
    try {
      resolveScriptRef(db, 'nope@1.0.0')
    } catch (err) {
      expect(err).toBeInstanceOf(EnkakuError)
      expect((err as EnkakuError).code).toBe('script_not_found')
    }
  })

  test('script_version_not_found when the name exists but the version does not, naming the versions that do', () => {
    const db = setUp()
    publish(db, 'checkout', '1.0.0')
    publish(db, 'checkout', '1.0.1')
    try {
      resolveScriptRef(db, 'checkout@9.9.9')
      throw new Error('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(EnkakuError)
      expect((err as EnkakuError).code).toBe('script_version_not_found')
      expect((err as EnkakuError).message).toContain('1.0.0')
      expect((err as EnkakuError).message).toContain('1.0.1')
    }
  })

  test('script_disabled when the exact version is disabled', () => {
    const db = setUp()
    publish(db, 'checkout', '1.0.0', { enabled: false })
    try {
      resolveScriptRef(db, 'checkout@1.0.0')
      throw new Error('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(EnkakuError)
      expect((err as EnkakuError).code).toBe('script_disabled')
    }
  })
})

describe('resolveScriptRef — @latest', () => {
  test('resolves to the highest non-prerelease enabled semver (plan 62 acceptance #1)', () => {
    const db = setUp()
    publish(db, 'checkout', '1.0.0')
    const idLatest = publish(db, 'checkout', '1.2.0')
    publish(db, 'checkout', '1.1.0')
    const row = resolveScriptRef(db, 'checkout@latest')
    expect(row.id).toBe(idLatest)
    expect(row.version).toBe('1.2.0')
  })

  test('publish order does not win — a hotfix published later onto an old line still loses to semver order (plan 62 acceptance #2)', () => {
    const db = setUp()
    publish(db, 'checkout', '2.0.0', { createdAt: 1_700_000_000 })
    // Published AFTER 2.0.0, but semver-lower.
    publish(db, 'checkout', '1.9.9', { createdAt: 1_700_000_100 })
    const row = resolveScriptRef(db, 'checkout@latest')
    expect(row.version).toBe('2.0.0')
  })

  test('1.0.10 beats 1.0.9 under @latest — numeric, not string, comparison', () => {
    const db = setUp()
    publish(db, 'checkout', '1.0.9')
    const idTen = publish(db, 'checkout', '1.0.10')
    const row = resolveScriptRef(db, 'checkout@latest')
    expect(row.id).toBe(idTen)
  })

  test('prereleases are excluded from @latest, but naming one exactly still runs it (plan 62 acceptance #3)', () => {
    const db = setUp()
    const idStable = publish(db, 'checkout', '1.9.9')
    publish(db, 'checkout', '2.0.0-beta.1')
    const latest = resolveScriptRef(db, 'checkout@latest')
    expect(latest.id).toBe(idStable)
    expect(latest.version).toBe('1.9.9')

    const exact = resolveScriptRef(db, 'checkout@2.0.0-beta.1')
    expect(exact.version).toBe('2.0.0-beta.1')
  })

  test('only-prerelease script fails @latest with script_ref_unresolved, naming what exists (plan 62 acceptance #4)', () => {
    const db = setUp()
    publish(db, 'checkout', '1.0.0-alpha.1')
    publish(db, 'checkout', '1.0.0-beta.1')
    try {
      resolveScriptRef(db, 'checkout@latest')
      throw new Error('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(EnkakuError)
      expect((err as EnkakuError).code).toBe('script_ref_unresolved')
      expect((err as EnkakuError).message).toContain('1.0.0-alpha.1')
      expect((err as EnkakuError).message).toContain('1.0.0-beta.1')
    }
  })

  test('a disabled highest version falls through to the highest ENABLED one', () => {
    const db = setUp()
    const idEnabled = publish(db, 'checkout', '1.0.0')
    publish(db, 'checkout', '2.0.0', { enabled: false })
    const row = resolveScriptRef(db, 'checkout@latest')
    expect(row.id).toBe(idEnabled)
    expect(row.version).toBe('1.0.0')
  })

  test('only-disabled script fails @latest with script_ref_unresolved', () => {
    const db = setUp()
    publish(db, 'checkout', '1.0.0', { enabled: false })
    try {
      resolveScriptRef(db, 'checkout@latest')
      throw new Error('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(EnkakuError)
      expect((err as EnkakuError).code).toBe('script_ref_unresolved')
    }
  })
})
