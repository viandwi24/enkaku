import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'
import { openDb, openForReading, runMigrations } from './index'

let dirs: string[] = []
let opened: Database[] = []

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'enkaku-read-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const sqlite of opened) sqlite.close()
  opened = []
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  dirs = []
})

describe('openForReading — a second process reading a database it does not own', () => {
  test('reads committed rows while the owner still holds the database open, WAL uncheckpointed', () => {
    const dir = freshDir()
    const path = join(dir, 'enkaku.db')
    const writer = openDb(path)
    opened.push(writer.sqlite)
    runMigrations(writer.db, writer.sqlite)
    writer.sqlite.exec("INSERT INTO devices (id, stable_id, serial, label, status) VALUES ('d1', 's1', 'ZP1', 'Phone', 'online')")
    // Deliberately NOT checkpointed: this is the state the core is in for as
    // long as it is running, and the state doctor and backup actually meet.

    const reader = openForReading(path)
    opened.push(reader)
    expect(reader.query('SELECT serial FROM devices').get()).toEqual({ serial: 'ZP1' })
  })

  test('a missing file throws rather than conjuring an empty database', () => {
    const dir = freshDir()
    expect(() => openForReading(join(dir, 'enkaku.db'))).toThrow()
    // The distinction the doctor checks depend on: "no such file" must stay
    // reachable as its own answer, never a silently-created empty schema.
    expect(() => new Database(join(dir, 'enkaku.db'), { readonly: true, create: false })).toThrow()
  })

  test('a file that is not a database throws — the caller reports it, this does not paper over it', () => {
    const dir = freshDir()
    const path = join(dir, 'enkaku.db')
    writeFileSync(path, 'this is not a database')
    const db = openForReading(path)
    opened.push(db)
    // The open itself can succeed (SQLite is lazy); the first read is what
    // fails, and both doctor checks catch exactly there.
    expect(() => db.query('SELECT 1 FROM devices').get()).toThrow()
  })
})
