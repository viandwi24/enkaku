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

/**
 * F14: `process.kill(pid, 0)` answers "is that pid alive", never "is the
 * port free" — the field log showed the two disagreeing directly. These
 * tests are for the `portCheck` parameter that closes the gap: a stale
 * lock's takeover now also probes the port the core is about to bind, and
 * warns when the probe disagrees with what the takeover log line implies.
 */
describe('acquireDataDirLock — stale-lock port probe (plan 85 §4.7, F14)', () => {
  const deadPid = 999_999 // asserted dead the same way the "takes over" test above does

  function writeStaleLock(dir: string): void {
    writeFileSync(join(dir, 'enkaku.lock'), JSON.stringify({ pid: deadPid, startedAt: 'yesterday' }))
  }

  test('warns when the port is still answering despite the lock being stale', () => {
    const dir = freshDir()
    writeStaleLock(dir)
    const warnings: string[] = []
    const log = { info: () => {}, warn: (m: string) => warnings.push(m) }

    const lock = acquireDataDirLock(dir, log, { host: '127.0.0.1', port: 7700, probe: () => false })
    lock.release()

    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('127.0.0.1:7700')
    expect(warnings[0]).toContain(String(deadPid))
  })

  test('does not warn when the port probe reports it free', () => {
    const dir = freshDir()
    writeStaleLock(dir)
    const warnings: string[] = []
    const log = { info: () => {}, warn: (m: string) => warnings.push(m) }

    const lock = acquireDataDirLock(dir, log, { host: '127.0.0.1', port: 7700, probe: () => true })
    lock.release()

    expect(warnings).toHaveLength(0)
  })

  test('never probes the port when the lock was not stale (fresh acquire, nothing to take over)', () => {
    const dir = freshDir()
    let probed = false
    const lock = acquireDataDirLock(dir, undefined, { host: '127.0.0.1', port: 7700, probe: () => (probed = true) })
    expect(probed).toBe(false)
    lock.release()
  })

  test('omitting portCheck entirely leaves behaviour unchanged — no probe, no warn, no throw', () => {
    const dir = freshDir()
    writeStaleLock(dir)
    expect(() => acquireDataDirLock(dir)).not.toThrow()
  })

  test('the default probe is a real, read-only bind test when no probe function is injected', () => {
    const dir = freshDir()
    writeStaleLock(dir)
    const warnings: string[] = []
    const log = { info: () => {}, warn: (m: string) => warnings.push(m) }
    // Port 0 always binds (the OS assigns a free ephemeral port), so the
    // default bind-test probe should find it free and warn nothing — this
    // exercises `defaultProbePortFree` itself, not an injected fake.
    const lock = acquireDataDirLock(dir, log, { host: '127.0.0.1', port: 0 })
    lock.release()
    expect(warnings).toHaveLength(0)
  })
})
