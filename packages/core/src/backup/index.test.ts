import { Database } from 'bun:sqlite'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'
import { openDb, runMigrations } from '../db'
import { devices } from '../db/schema'
import { SECRETS_KEY_FILE } from '../secrets/store'
import { createBackup, defaultBackupFilename, resolveOutputPath } from './index'
import { readTarGz } from './tar'

const tempDirs: string[] = []

function freshDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'enkaku-backup-test-'))
  tempDirs.push(dir)
  return dir
}

/** A real, migrated `enkaku.db` in a fresh data dir, with one device row. */
function dataDirWithLiveDb(): string {
  const dataDir = freshDataDir()
  const opened = openDb(join(dataDir, 'enkaku.db'))
  runMigrations(opened.db, opened.sqlite)
  opened.db
    .insert(devices)
    .values({ id: 'd1', stableId: 'stable-1', serial: 'emulator-5554', label: 'Pixel test', status: 'ready' })
    .run()
  opened.sqlite.close()
  return dataDir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

describe('createBackup', () => {
  test('the backup of a live database is readable and complete', async () => {
    const dataDir = dataDirWithLiveDb()
    const outputPath = join(dataDir, 'out.tar.gz')

    const summary = await createBackup({ dataDir, outputPath })

    expect(summary.outputPath).toBe(outputPath)
    expect(existsSync(outputPath)).toBe(true)
    expect(summary.dbBytes).toBeGreaterThan(0)

    const entries = readTarGz(readFileSync(outputPath))
    const dbEntry = entries.find((e) => e.name === 'enkaku.db')
    expect(dbEntry).toBeDefined()

    // The extracted snapshot must be a real, openable, complete database —
    // not just some bytes with the right name.
    const extractedPath = join(dataDir, 'extracted.db')
    writeFileSync(extractedPath, dbEntry!.data)
    const check = new Database(extractedPath, { readonly: true })
    const integrity = check.query('PRAGMA integrity_check').get() as { integrity_check?: string }
    expect(integrity.integrity_check).toBe('ok')
    const rows = check.query('SELECT stable_id, label FROM devices').all() as Array<{ stable_id: string; label: string }>
    check.close()
    expect(rows).toEqual([{ stable_id: 'stable-1', label: 'Pixel test' }])
  })

  test('secrets.key is included in the archive, byte-for-byte', async () => {
    const dataDir = dataDirWithLiveDb()
    const keyBytes = new Uint8Array(32).map((_, i) => i)
    writeFileSync(join(dataDir, SECRETS_KEY_FILE), keyBytes)
    const outputPath = join(dataDir, 'out.tar.gz')

    const summary = await createBackup({ dataDir, outputPath })
    expect(summary.hasSecretsKey).toBe(true)

    const entries = readTarGz(readFileSync(outputPath))
    const keyEntry = entries.find((e) => e.name === SECRETS_KEY_FILE)
    expect(keyEntry).toBeDefined()
    expect(keyEntry!.data).toEqual(keyBytes)
  })

  test('a legacy network-credentials.key file is also carried into the archive when present', async () => {
    const dataDir = dataDirWithLiveDb()
    const legacyBytes = new Uint8Array(32).fill(7)
    writeFileSync(join(dataDir, 'network-credentials.key'), legacyBytes)
    const outputPath = join(dataDir, 'out.tar.gz')

    const summary = await createBackup({ dataDir, outputPath })
    expect(summary.hasLegacyKey).toBe(true)

    const entries = readTarGz(readFileSync(outputPath))
    const legacyEntry = entries.find((e) => e.name === 'network-credentials.key')
    expect(legacyEntry?.data).toEqual(legacyBytes)
  })

  test('reports hasSecretsKey: false without failing when no key file exists yet', async () => {
    const dataDir = dataDirWithLiveDb()
    const outputPath = join(dataDir, 'out.tar.gz')
    const summary = await createBackup({ dataDir, outputPath })
    expect(summary.hasSecretsKey).toBe(false)
    expect(summary.hasLegacyKey).toBe(false)
  })

  test('the archive includes a README manifest warning about the sensitivity of the key', async () => {
    const dataDir = dataDirWithLiveDb()
    writeFileSync(join(dataDir, SECRETS_KEY_FILE), new Uint8Array(32))
    const outputPath = join(dataDir, 'out.tar.gz')
    await createBackup({ dataDir, outputPath })

    const entries = readTarGz(readFileSync(outputPath))
    const readme = entries.find((e) => e.name === 'README.txt')
    expect(readme).toBeDefined()
    const text = new TextDecoder().decode(readme!.data)
    expect(text).toContain('DECRYPT EVERY CREDENTIAL')
    expect(text).toContain(SECRETS_KEY_FILE)
  })

  test('does not silently overwrite an existing file at the output path', async () => {
    const dataDir = dataDirWithLiveDb()
    const outputPath = join(dataDir, 'out.tar.gz')
    writeFileSync(outputPath, 'not a backup, do not touch me')

    await expect(createBackup({ dataDir, outputPath })).rejects.toThrow(/already exists/)
    // The pre-existing file must be untouched.
    expect(readFileSync(outputPath, 'utf8')).toBe('not a backup, do not touch me')
  })

  test('fails clearly when there is no enkaku.db yet, rather than producing an empty archive', async () => {
    const dataDir = freshDataDir()
    const outputPath = join(dataDir, 'out.tar.gz')
    await expect(createBackup({ dataDir, outputPath })).rejects.toThrow(/no enkaku\.db/)
    expect(existsSync(outputPath)).toBe(false)
  })

  test('captures a write sitting only in an active, uncheckpointed WAL', async () => {
    const dataDir = dataDirWithLiveDb()

    // A second connection, held open across the backup call, simulating the
    // core still running and holding the database open — the exact scenario
    // `enkaku backup` has to be safe against. The write below is committed
    // but deliberately never checkpointed into enkaku.db itself.
    const writer = new Database(join(dataDir, 'enkaku.db'))
    writer.exec('PRAGMA journal_mode = WAL;')
    writer.run('INSERT INTO devices (id, stable_id, serial, label, status) VALUES (?, ?, ?, ?, ?)', [
      'd2',
      'stable-2',
      'emulator-5556',
      'From the WAL',
      'ready',
    ])
    expect(existsSync(join(dataDir, 'enkaku.db-wal'))).toBe(true)

    try {
      const outputPath = join(dataDir, 'out.tar.gz')
      await createBackup({ dataDir, outputPath })

      const entries = readTarGz(readFileSync(outputPath))
      const dbEntry = entries.find((e) => e.name === 'enkaku.db')!
      const extractedPath = join(dataDir, 'extracted-wal.db')
      writeFileSync(extractedPath, dbEntry.data)
      const check = new Database(extractedPath, { readonly: true })
      const rows = check.query('SELECT label FROM devices ORDER BY id').all() as Array<{ label: string }>
      check.close()
      expect(rows.map((r) => r.label)).toEqual(['Pixel test', 'From the WAL'])
    } finally {
      writer.close()
    }
  })
})

describe('resolveOutputPath', () => {
  test('with no argument, writes the default filename into the current directory', () => {
    const now = new Date('2026-08-11T12:34:56.000Z')
    const resolved = resolveOutputPath(undefined, now)
    expect(resolved.endsWith(defaultBackupFilename(now))).toBe(true)
  })

  test('an existing directory gets the default filename appended', () => {
    const dir = freshDataDir()
    const now = new Date('2026-08-11T12:34:56.000Z')
    const resolved = resolveOutputPath(dir, now)
    expect(resolved).toBe(join(dir, defaultBackupFilename(now)))
  })

  test('a path with a trailing slash is treated as a directory even if it does not exist yet', () => {
    const now = new Date('2026-08-11T12:34:56.000Z')
    const resolved = resolveOutputPath('/tmp/does-not-exist-yet/', now)
    expect(resolved.endsWith(defaultBackupFilename(now))).toBe(true)
  })

  test('an explicit file path is used verbatim (resolved to absolute)', () => {
    const resolved = resolveOutputPath('my-backup.tar.gz')
    expect(resolved.endsWith('my-backup.tar.gz')).toBe(true)
    expect(resolved).not.toContain('enkaku-backup-')
  })
})

describe('defaultBackupFilename', () => {
  test('is filesystem-safe (no colons) and timestamped', () => {
    const name = defaultBackupFilename(new Date('2026-08-11T12:34:56.000Z'))
    expect(name).toBe('enkaku-backup-2026-08-11T12-34-56-000Z.tar.gz')
  })
})
