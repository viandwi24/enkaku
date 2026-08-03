import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acquireDataDirLock } from './data-dir-lock'
import { EnkakuError } from './errors'

const freshDir = () => mkdtempSync(join(tmpdir(), 'enkaku-lock-'))

/**
 * The invariant: one core per data directory. Two cores sharing one would
 * fight over the same phones through `adb forward`, which produces symptoms
 * that all point at the video pipeline and none at the real cause.
 */
describe('acquireDataDirLock', () => {
  test('writes a lock naming this process, and releases it', () => {
    const dir = freshDir()
    const lock = acquireDataDirLock(dir)

    const path = join(dir, 'enkaku.lock')
    expect(existsSync(path)).toBe(true)
    expect(JSON.parse(readFileSync(path, 'utf8')).pid).toBe(process.pid)

    lock.release()
    expect(existsSync(path)).toBe(false)
  })

  test('refuses to start when a live process already holds the directory', () => {
    const dir = freshDir()
    // This very process is unquestionably alive.
    writeFileSync(join(dir, 'enkaku.lock'), JSON.stringify({ pid: process.pid, startedAt: 'earlier' }))

    expect(() => acquireDataDirLock(dir)).toThrow(EnkakuError)
    try {
      acquireDataDirLock(dir)
    } catch (err) {
      expect((err as EnkakuError).code).toBe('E_DATA_DIR_IN_USE')
      // The message has to be actionable: which process, and which file.
      expect((err as Error).message).toContain(String(process.pid))
      expect((err as Error).message).toContain('enkaku.lock')
    }
  })

  test('takes over a lock whose process is gone — the normal case after kill -9', () => {
    const dir = freshDir()
    // Very unlikely to exist, and the assertion below proves it does not.
    const deadPid = 999_999
    let alive = true
    try {
      process.kill(deadPid, 0)
    } catch {
      alive = false
    }
    expect(alive).toBe(false)

    writeFileSync(join(dir, 'enkaku.lock'), JSON.stringify({ pid: deadPid, startedAt: 'yesterday' }))
    const lock = acquireDataDirLock(dir)
    expect(JSON.parse(readFileSync(join(dir, 'enkaku.lock'), 'utf8')).pid).toBe(process.pid)
    lock.release()
  })

  test('a corrupt lock file never bricks the farm', () => {
    const dir = freshDir()
    writeFileSync(join(dir, 'enkaku.lock'), 'not json at all')
    const lock = acquireDataDirLock(dir)
    expect(JSON.parse(readFileSync(join(dir, 'enkaku.lock'), 'utf8')).pid).toBe(process.pid)
    lock.release()
  })

  test('release leaves another core’s lock alone', () => {
    const dir = freshDir()
    const lock = acquireDataDirLock(dir)
    // Simulate: we were killed, another core took the directory over.
    writeFileSync(join(dir, 'enkaku.lock'), JSON.stringify({ pid: process.pid + 1, startedAt: 'later' }))

    lock.release()
    expect(existsSync(join(dir, 'enkaku.lock'))).toBe(true)
    expect(JSON.parse(readFileSync(join(dir, 'enkaku.lock'), 'utf8')).pid).toBe(process.pid + 1)
  })

  test('release is idempotent', () => {
    const dir = freshDir()
    const lock = acquireDataDirLock(dir)
    lock.release()
    expect(() => lock.release()).not.toThrow()
  })
})
