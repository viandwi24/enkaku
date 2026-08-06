import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { verifyPluginBundle } from './verify-child'

const dirs: string[] = []
function writeBundle(source: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'enkaku-verify-child-'))
  dirs.push(dir)
  const path = join(dir, 'bundle.mjs')
  Bun.write(path, source)
  return path
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const HEALTHY = `
import { z } from 'zod'
export default {
  id: 'tiktok',
  version: '1.0.0',
  title: 'TikTok pack',
  scripts: [
    { id: 'login', params: z.object({ user: z.string() }), run: async () => 'login-ok' },
    { id: 'warmup', params: z.object({}), run: async () => 'warmup-ok' },
  ],
  reset: { packages: ['com.zhiliaoapp.musically'] },
}
`

const THROWS = `
throw new Error("boom: malformed plugin")
export default { id: 'x', version: '1.0.0', scripts: [] }
`

const HANGS = `
while (true) {}
export default { id: 'x', version: '1.0.0', scripts: [] }
`

const NOT_A_PLUGIN = `
export default { id: 'x', version: '1.0.0', params: {}, run: async () => {} }
`

const DUPLICATE_IDS = `
import { z } from 'zod'
export default {
  id: 'p',
  version: '1.0.0',
  scripts: [
    { id: 'a', params: z.object({}), run: async () => {} },
    { id: 'a', params: z.object({}), run: async () => {} },
  ],
}
`

describe('verifyPluginBundle', () => {
  test('a healthy bundle reports the plugin id, version, every script id, and JSON-Schema params', async () => {
    const path = writeBundle(HEALTHY)
    const report = await verifyPluginBundle(path)
    expect(report.ok).toBe(true)
    expect(report.pluginId).toBe('tiktok')
    expect(report.version).toBe('1.0.0')
    expect(report.title).toBe('TikTok pack')
    expect(report.scripts.map((s) => s.id)).toEqual(['login', 'warmup'])
    expect(report.scripts[0]?.paramsSchema).toBeTruthy()
    expect(report.resetPackages).toEqual(['com.zhiliaoapp.musically'])
  }, 10_000)

  test('a bundle that throws at import time is reported failed, verbatim (criterion 20)', async () => {
    const path = writeBundle(THROWS)
    const report = await verifyPluginBundle(path)
    expect(report.ok).toBe(false)
    expect(report.error).toContain('boom: malformed plugin')
  }, 10_000)

  test('a bundle that never returns from module scope is killed at the timeout (criterion 21)', async () => {
    const path = writeBundle(HANGS)
    const report = await verifyPluginBundle(path, { timeoutMs: 500 })
    expect(report.ok).toBe(false)
    expect(report.errorCode).toBe('E_PLUGIN_VERIFY_TIMEOUT')
  }, 10_000)

  test('a bundle with no definePlugin()-shaped default export is refused', async () => {
    const path = writeBundle(NOT_A_PLUGIN)
    const report = await verifyPluginBundle(path)
    expect(report.ok).toBe(false)
    expect(report.error).toContain('definePlugin')
  }, 10_000)

  test('duplicate script ids are refused, naming the id (criterion 22)', async () => {
    const path = writeBundle(DUPLICATE_IDS)
    const report = await verifyPluginBundle(path)
    expect(report.ok).toBe(false)
    expect(report.errorCode).toBe('E_PLUGIN_DUPLICATE_SCRIPT_ID')
    expect(report.error).toContain('"a"')
  }, 10_000)

  test('a version mismatch against the staged row is refused', async () => {
    const path = writeBundle(HEALTHY)
    const report = await verifyPluginBundle(path, { expectedVersion: '9.9.9' })
    expect(report.ok).toBe(false)
    expect(report.errorCode).toBe('E_PLUGIN_VERSION_MISMATCH')
  }, 10_000)

  test('a missing bundle file is reported failed, not thrown', async () => {
    const report = await verifyPluginBundle('/no/such/file.mjs')
    expect(report.ok).toBe(false)
  }, 10_000)
})
