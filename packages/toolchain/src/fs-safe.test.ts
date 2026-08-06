import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { moveDir, moveFile, rmPath, withRetry } from './fs-safe'

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'enkaku-fs-safe-'))
}

/** The shape node throws when another process is holding the target. */
function lockError(code: string): NodeJS.ErrnoException {
  const err = new Error(`${code}: operation not permitted, rename`) as NodeJS.ErrnoException
  err.code = code
  return err
}

describe('fs-safe', () => {
  test('moveFile creates the destination folder and removes the source', async () => {
    const dir = tmp()
    try {
      const src = join(dir, 'a.part')
      writeFileSync(src, 'payload')
      const dest = join(dir, 'tool', '1.0.0', 'ui-server.apk')
      await moveFile(src, dest)
      expect(readFileSync(dest, 'utf8')).toBe('payload')
      expect(existsSync(src)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('moveDir moves a tree', async () => {
    const dir = tmp()
    try {
      const src = join(dir, 'stage')
      mkdirSync(join(src, 'nested'), { recursive: true })
      writeFileSync(join(src, 'nested', 'adb.exe'), 'bin')
      const dest = join(dir, 'tools', 'adb', '36.0.0')
      await moveDir(src, dest)
      expect(readFileSync(join(dest, 'nested', 'adb.exe'), 'utf8')).toBe('bin')
      expect(existsSync(src)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a transient lock error is retried until it wins', async () => {
    // What Windows does when Defender is scanning what we just wrote: the first
    // renames lose, a later one wins.
    let calls = 0
    const result = await withRetry(() => {
      calls++
      if (calls <= 2) throw lockError('EPERM')
      return 'moved'
    })
    expect(result).toBe('moved')
    expect(calls).toBe(3)
  })

  test('EBUSY and EACCES are treated as transient too', async () => {
    for (const code of ['EBUSY', 'EACCES', 'ENOTEMPTY']) {
      let calls = 0
      await withRetry(() => {
        calls++
        if (calls === 1) throw lockError(code)
        return true
      })
      expect(calls).toBe(2)
    }
  })

  test('a real error surfaces immediately without retrying', async () => {
    let calls = 0
    const run = withRetry(() => {
      calls++
      throw lockError('ENOENT')
    })
    await expect(run).rejects.toThrow('ENOENT')
    expect(calls).toBe(1)
  })

  test('moveFile overwrites an existing destination', async () => {
    const dir = tmp()
    try {
      const src = join(dir, 'a.part')
      const dest = join(dir, 'final', 'ui-server.apk')
      mkdirSync(join(dir, 'final'), { recursive: true })
      writeFileSync(dest, 'stale')
      writeFileSync(src, 'fresh')
      await moveFile(src, dest)
      expect(readFileSync(dest, 'utf8')).toBe('fresh')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('rmPath is a no-op on a missing path', async () => {
    await rmPath(join(tmpdir(), 'enkaku-does-not-exist-4f2a'))
  })
})
