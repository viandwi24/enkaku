import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, test } from 'bun:test'
import { checkFileHash, checkWhisperCli } from './health'

const dir = mkdtempSync(join(tmpdir(), 'enkaku-health-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

/** A tiny shell script standing in for whisper-cli — POSIX only, like every spawn test in this package. */
function fakeCli(name: string, body: string): string {
  const path = join(dir, name)
  writeFileSync(path, `#!/bin/sh\n${body}\n`)
  chmodSync(path, 0o755)
  return path
}

describe.skipIf(process.platform === 'win32')('checkWhisperCli (plan 318)', () => {
  test('exit 0 with usage on stderr, after backend noise: ok, and the detail is the usage line', async () => {
    const path = fakeCli('whisper-ok', 'echo "load_backend: loaded BLAS backend" >&2\necho "ggml_metal_device_init: testing" >&2\necho "" >&2\necho "usage: whisper-cli [options] file0 file1 ..." >&2\nexit 0')
    const health = await checkWhisperCli(path)
    expect(health.ok).toBe(true)
    expect(health.detail).toBe('usage: whisper-cli [options] file0 file1 ...')
  })

  test('exit 0 that is not whisper at all: not ok', async () => {
    const path = fakeCli('not-whisper', 'echo "hello"\nexit 0')
    const health = await checkWhisperCli(path)
    expect(health.ok).toBe(false)
    expect(health.detail).toContain('exit 0')
  })

  test('a non-zero exit: not ok, with the exit code', async () => {
    const path = fakeCli('whisper-broken', 'echo "dyld: Library not loaded: libggml.dylib" >&2\nexit 134')
    const health = await checkWhisperCli(path)
    expect(health.ok).toBe(false)
    expect(health.detail).toContain('exit 134')
    expect(health.detail).toContain('libggml')
  })

  test('a binary that hangs is killed at the timeout', async () => {
    const path = fakeCli('whisper-hangs', 'sleep 5')
    const health = await checkWhisperCli(path, 200)
    expect(health.ok).toBe(false)
    expect(health.detail).toContain('timed out')
  })

  test('a path that does not exist: not ok, never a throw', async () => {
    const health = await checkWhisperCli(join(dir, 'nope'))
    expect(health.ok).toBe(false)
  })
})

describe('checkFileHash (streamed, plan 318)', () => {
  test('a matching sha256 passes, a different one fails', async () => {
    const path = join(dir, 'model.bin')
    const bytes = new Uint8Array(300_000).map((_, i) => i % 251)
    writeFileSync(path, bytes)
    const sha = new Bun.CryptoHasher('sha256').update(bytes).digest('hex')
    expect(await checkFileHash(path, sha)).toMatchObject({ ok: true, detail: 'sha256 matches' })
    expect((await checkFileHash(path, 'f'.repeat(64))).ok).toBe(false)
  })
})
