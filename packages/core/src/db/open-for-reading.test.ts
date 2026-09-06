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

/*
  Teardown is janitorial and must never be able to fail a test.

  Windows refuses to unlink a file another handle still holds, and a SQLite
  database that has just been closed can stay locked for a moment longer
  (`-wal`/`-shm`, and any scanner that opened them). When `rmSync` threw, the
  loop stopped, the array was never cleared, and EVERY LATER TEST IN THIS FILE
  failed in its cleanup rather than on anything it asserts — the cascade is
  visible in `check-windows` as one slow real failure followed by a run of
  1ms ones (owner, 2026-09-06).

  Closing the handles first, which is what the previous fix did, is necessary
  and was not sufficient. So each step is now independent and tolerant, and
  the arrays are reset unconditionally: a temp directory the runner will
  destroy in a minute anyway is not worth a red build, and the assertions
  above it have already run.
*/
afterEach(() => {
  for (const sqlite of opened) {
    try {
      sqlite.close()
    } catch {
      // Already closed, or closing threw — either way the directory sweep below is what matters.
    }
  }
  opened = []
  for (const dir of dirs) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // Windows still holds it. Leave it; the runner is thrown away.
    }
  }
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
