import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Spawns the REAL `child-entry.ts` against a crafted bundle and captures its
 * first IPC message (`ready` or `result`) — proving the plugin-bundle
 * selection mechanism (plan 82 §3.2, §3.10) actually works at the child
 * process boundary, the same boundary a real job runs through.
 *
 * This is deliberately NOT exercised through `@enkaku/session`'s
 * `job-runner.ts`/`isolation.ts` orchestration (out of bounds for this
 * change — see the plan's own report): it spawns the child directly, the
 * same way `plugins/verify-child.ts` (`packages/core`) spawns its own
 * throwaway child, and passes `ENKAKU_SCRIPT_EXPORT_ID` the same way
 * `isolation.ts`'s existing `SpawnRequest.env` would carry it once a caller
 * populates it — nothing about `child-entry.ts`'s OWN contract changed to
 * make this test possible.
 */

const ENTRY = fileURLToPath(new URL('./child-entry.ts', import.meta.url))

const dirs: string[] = []
function writeBundle(source: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'enkaku-child-entry-test-'))
  dirs.push(dir)
  const path = join(dir, 'bundle.mjs')
  Bun.write(path, source)
  return path
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

interface FirstMessage {
  t: string
  [k: string]: unknown
}

/** Spawns the child, resolves with the FIRST IPC message it sends, then kills it. */
function firstMessage(bundlePath: string, env: Record<string, string> = {}): Promise<FirstMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      proc.kill()
      reject(new Error('timed out waiting for the child\'s first IPC message'))
    }, 10_000)
    const proc = Bun.spawn([process.execPath, ENTRY, bundlePath], {
      ipc(message) {
        clearTimeout(timer)
        resolve(message as FirstMessage)
        proc.kill()
      },
      stdout: 'ignore',
      stderr: 'ignore',
      env: { ...process.env, ...env },
    })
  })
}

const STANDALONE_BUNDLE = `
export default {
  id: 'checkout',
  version: '1.0.0',
  params: { parse: (v) => v },
  run: async () => 'ok',
  reset: { packages: ['com.example.app'] },
}
`

const PLUGIN_BUNDLE = `
export default {
  id: 'tiktok',
  version: '1.0.0',
  reset: { packages: ['com.zhiliaoapp.musically'] },
  scripts: [
    { id: 'login', version: '1.0.0', params: { parse: (v) => v }, run: async () => 'login-ok', reset: { packages: ['com.zhiliaoapp.musically.extra'] } },
    { id: 'warmup', version: '1.0.0', params: { parse: (v) => v }, run: async () => 'warmup-ok' },
  ],
}
`

describe('child-entry.ts — standalone bundle (criterion 27, backward compatibility)', () => {
  test('a pre-plan-82 bundle (no scripts array) reports ready exactly as before, ignoring the env var', async () => {
    const path = writeBundle(STANDALONE_BUNDLE)
    const msg = await firstMessage(path, { ENKAKU_SCRIPT_EXPORT_ID: 'login' })
    expect(msg.t).toBe('ready')
    expect(msg.scriptId).toBe('checkout')
    expect(msg.reset).toEqual({ packages: ['com.example.app'] })
  })
})

describe('child-entry.ts — plugin bundle (plan 82 §3.2)', () => {
  test('selects the right member by ENKAKU_SCRIPT_EXPORT_ID (criterion 3, at the child boundary)', async () => {
    const path = writeBundle(PLUGIN_BUNDLE)
    const msg = await firstMessage(path, { ENKAKU_SCRIPT_EXPORT_ID: 'login' })
    expect(msg.t).toBe('ready')
    expect(msg.scriptId).toBe('login')
  })

  test('selecting a different member picks a DIFFERENT script out of the SAME bundle', async () => {
    const path = writeBundle(PLUGIN_BUNDLE)
    const msg = await firstMessage(path, { ENKAKU_SCRIPT_EXPORT_ID: 'warmup' })
    expect(msg.scriptId).toBe('warmup')
  })

  test('the plugin\'s own reset.packages merges with the selected member\'s (criterion 5)', async () => {
    const path = writeBundle(PLUGIN_BUNDLE)
    const msg = await firstMessage(path, { ENKAKU_SCRIPT_EXPORT_ID: 'login' })
    expect(msg.reset).toEqual({ packages: ['com.zhiliaoapp.musically', 'com.zhiliaoapp.musically.extra'] })
  })

  test('a member with no reset of its own still gets the plugin\'s', async () => {
    const path = writeBundle(PLUGIN_BUNDLE)
    const msg = await firstMessage(path, { ENKAKU_SCRIPT_EXPORT_ID: 'warmup' })
    expect(msg.reset).toEqual({ packages: ['com.zhiliaoapp.musically'] })
  })

  test('no ENKAKU_SCRIPT_EXPORT_ID against a plugin bundle fails cleanly (BAD_BUNDLE), never runs the wrong thing', async () => {
    const path = writeBundle(PLUGIN_BUNDLE)
    const msg = await firstMessage(path, {})
    expect(msg.t).toBe('result')
    expect(msg.ok).toBe(false)
    expect((msg.error as { code: string }).code).toBe('BAD_BUNDLE')
  })

  test('an ENKAKU_SCRIPT_EXPORT_ID naming a script the plugin does not have fails cleanly', async () => {
    const path = writeBundle(PLUGIN_BUNDLE)
    const msg = await firstMessage(path, { ENKAKU_SCRIPT_EXPORT_ID: 'does-not-exist' })
    expect(msg.t).toBe('result')
    expect(msg.ok).toBe(false)
  })
})
