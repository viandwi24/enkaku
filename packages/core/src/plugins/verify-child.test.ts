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

// Plan 95 §4.9, §5 step 95.5 — publish path 2 of 3: a plugin member with a
// hostile params schema (here, a non-identifier field name) must be refused
// the same way a standalone script's `POST /api/scripts` would be.
const HOSTILE_PARAMS = `
import { z } from 'zod'
export default {
  id: 'p',
  version: '1.0.0',
  scripts: [
    { id: 'ok', params: z.object({}), run: async () => {} },
    { id: 'hostile', params: z.object({ 'bad name': z.string() }), run: async () => {} },
  ],
}
`

// Plan 98 §3.1, §4.5, §5 step 98.4 — a raw object literal default export
// (NOT `definePlugin()`), exactly like every other bundle in this file: this
// is the "hand-crafted bundle" `verify-child-entry.ts`'s own doc comment
// names as the reason params schemas are re-validated here rather than
// trusted from the SDK alone, applied to `runtime` too.
const HEALTHY_WITH_RUNTIME = `
import { z } from 'zod'
export default {
  id: 'p',
  version: '1.0.0',
  scripts: [
    { id: 'login', params: z.object({}), run: async () => {}, runtime: { timeoutMs: 45_000, maxRssBytes: 128 * 1024 * 1024 } },
  ],
}
`

const HOSTILE_RUNTIME = `
import { z } from 'zod'
export default {
  id: 'p',
  version: '1.0.0',
  scripts: [
    { id: 'ok', params: z.object({}), run: async () => {} },
    // Below RuntimeEnvelopeSchema's 1s floor — bypassing definePlugin() (and
    // therefore its author-machine fold/validate) entirely, since this
    // bundle never calls it.
    { id: 'hostile', params: z.object({}), run: async () => {}, runtime: { timeoutMs: 500 } },
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

  test('a plugin member with a hostile params schema is refused, naming the member and the finding (plan 95 §4.9, §5 step 95.5)', async () => {
    const path = writeBundle(HOSTILE_PARAMS)
    const report = await verifyPluginBundle(path)
    expect(report.ok).toBe(false)
    expect(report.error).toContain('E_PARAMS_SCHEMA_INVALID')
    expect(report.error).toContain('hostile')
    expect(report.error).toContain('bad name')
  }, 10_000)

  test('a member\'s runtime envelope is reported through the verify report (plan 98 §3.1, §5 step 98.4)', async () => {
    const path = writeBundle(HEALTHY_WITH_RUNTIME)
    const report = await verifyPluginBundle(path)
    expect(report.ok).toBe(true)
    expect(report.scripts[0]?.runtime).toEqual({ timeoutMs: 45_000, maxRssBytes: 128 * 1024 * 1024 })
  }, 10_000)

  test('a plugin member with a hostile runtime envelope (bypassing definePlugin entirely) is refused with E_RUNTIME_ENVELOPE_INVALID, naming the member', async () => {
    const path = writeBundle(HOSTILE_RUNTIME)
    const report = await verifyPluginBundle(path)
    expect(report.ok).toBe(false)
    expect(report.error).toContain('E_RUNTIME_ENVELOPE_INVALID')
    expect(report.error).toContain('hostile')
  }, 10_000)
})
