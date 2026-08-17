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
// the same way a direct `POST /api/scripts` publish would be.
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

// Plan 108 §3.9, §5 step 108.3. Every fixture below is a RAW object literal
// default export, never `definePlugin()` — which is the whole point: the SDK's
// author-time `validatePluginSurface` cannot have run, so what these prove is
// the PARENT's independent re-validation in `finalizeReport`.
const SURFACE = `
import { z } from 'zod'
export default {
  id: 'tiktok',
  version: '1.0.0',
  scripts: [
    { id: 'list-accounts', params: z.object({}), run: async () => {}, title: 'Sync accounts', description: 'Reads the switch-account sheet.' },
  ],
  surface: {
    nav: [{ id: 'accounts', label: 'TikTok accounts', icon: 'users', view: 'accounts' }],
    views: {
      accounts: {
        title: 'TikTok accounts',
        data: { kind: 'kv.scan', key: 'accounts', rows: 'items', itemsAt: 'accounts' },
        table: {
          rowKey: 'username',
          columns: [
            { field: 'username', header: 'Account' },
            { field: 'current', header: 'Signed in', schema: { type: 'boolean' }, width: 'narrow' },
          ],
        },
        toolbar: ['sync'],
        rowActions: ['rename'],
      },
    },
    actions: {
      sync: { kind: 'batch', label: 'Sync accounts', script: 'tiktok/list-accounts@latest' },
      rename: {
        kind: 'form',
        label: 'Rename',
        schema: { type: 'object', properties: { label: { type: 'string' } } },
        then: { kind: 'kv.set', label: 'Save', scope: 'device', key: { $literal: 'label' }, value: { $form: 'label' } },
      },
    },
  },
}
`

/** Malformed 1 of 4 — a cross-reference no schema can catch: the nav entry names a view this surface does not declare. */
const SURFACE_BAD_REFERENCE = `
import { z } from 'zod'
export default {
  id: 'tiktok',
  version: '1.0.0',
  scripts: [{ id: 'login', params: z.object({}), run: async () => {} }],
  surface: {
    nav: [{ id: 'accounts', label: 'Accounts', icon: 'users', view: 'missing-view' }],
    views: {},
    actions: {},
  },
}
`

/** Malformed 2 of 4 — an EMBEDDED JSON Schema over `checkDeclaredSchema`'s own limits, in a table column (criterion 4). */
const SURFACE_OVERSIZED_SCHEMA = `
import { z } from 'zod'
export default {
  id: 'tiktok',
  version: '1.0.0',
  scripts: [{ id: 'login', params: z.object({}), run: async () => {} }],
  surface: {
    nav: [],
    views: {
      accounts: {
        title: 'Accounts',
        data: { kind: 'kv.list', scope: 'global' },
        table: { rowKey: 'username', columns: [{ field: 'username', header: 'Account', schema: { type: 'string', description: 'x'.repeat(70_000) } }] },
      },
    },
    actions: {},
  },
}
`

/** Malformed 3 of 4 — an action kind the closed union does not have. */
const SURFACE_UNKNOWN_ACTION_KIND = `
import { z } from 'zod'
export default {
  id: 'tiktok',
  version: '1.0.0',
  scripts: [{ id: 'login', params: z.object({}), run: async () => {} }],
  surface: {
    nav: [],
    views: {
      accounts: {
        title: 'Accounts',
        data: { kind: 'kv.list', scope: 'global' },
        table: { rowKey: 'k', columns: [{ field: 'k', header: 'Key' }] },
        toolbar: ['shell'],
      },
    },
    actions: { shell: { kind: 'exec', label: 'Run a command', command: 'rm -rf /' } },
  },
}
`

/** Malformed 4 of 4 — a named cap exceeded (nine nav entries against `maxNav`'s eight). */
const SURFACE_CAP_EXCEEDED = `
import { z } from 'zod'
export default {
  id: 'tiktok',
  version: '1.0.0',
  scripts: [{ id: 'login', params: z.object({}), run: async () => {} }],
  surface: {
    nav: Array.from({ length: 9 }, (_, i) => ({ id: 'nav' + i, label: 'Nav ' + i, icon: 'users', view: 'accounts' })),
    views: {
      accounts: {
        title: 'Accounts',
        data: { kind: 'kv.list', scope: 'global' },
        table: { rowKey: 'k', columns: [{ field: 'k', header: 'Key' }] },
      },
    },
    actions: {},
  },
}
`

/** A surface JSON cannot express at all — refused by the CHILD, before the parent ever sees it, and still reported under this plan's own code. */
const SURFACE_UNSERIALISABLE = `
import { z } from 'zod'
const surface = { nav: [], views: {}, actions: {} }
surface.self = surface
export default {
  id: 'tiktok',
  version: '1.0.0',
  scripts: [{ id: 'login', params: z.object({}), run: async () => {} }],
  surface,
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

describe('verifyPluginBundle — the surface (plan 108 §3.9, §5 step 108.3)', () => {
  test('a bundle declaring NO surface verifies exactly as it did before this plan (acceptance criterion 1)', async () => {
    const path = writeBundle(HEALTHY)
    const report = await verifyPluginBundle(path)
    expect(report.ok).toBe(true)
    expect(report.surface).toBeUndefined()
    // Not merely absent from the report — absent from every member too, so a
    // manifest written from this report is key-for-key what it always was.
    expect(report.scripts.map((s) => s.title)).toEqual([undefined, undefined])
    expect(report.scripts.map((s) => s.description)).toEqual([undefined, undefined])
  }, 10_000)

  test('a valid surface verifies and is reported PARSED, with every default applied', async () => {
    const path = writeBundle(SURFACE)
    const report = await verifyPluginBundle(path)
    expect(report.ok).toBe(true)
    expect(report.surface?.nav).toEqual([{ id: 'accounts', label: 'TikTok accounts', icon: 'users', view: 'accounts' }])
    // Defaults the bundle never wrote — proof the report carries the parsed form, not the raw one.
    expect(report.surface?.views.accounts?.table?.selectable).toBe(false)
    expect(report.surface?.views.accounts?.table?.columns[0]?.width).toBe('auto')
    expect(report.surface?.views.accounts?.data).toEqual({ kind: 'kv.scan', key: 'accounts', rows: 'items', itemsAt: 'accounts', includeMissing: true })
    expect(report.surface?.actions.sync).toMatchObject({ kind: 'batch', target: 'picker' })
    expect(report.surface?.actions.rename).toMatchObject({ kind: 'form', submitLabel: 'Save' })
  }, 10_000)

  test('a member\'s title and description reach the report (plan 108 §0.2 P8)', async () => {
    const path = writeBundle(SURFACE)
    const report = await verifyPluginBundle(path)
    expect(report.scripts[0]?.title).toBe('Sync accounts')
    expect(report.scripts[0]?.description).toBe('Reads the switch-account sheet.')
  }, 10_000)

  test('malformed 1/4 — a nav entry naming a view the surface does not declare fails with E_PLUGIN_SURFACE_INVALID, naming both', async () => {
    const path = writeBundle(SURFACE_BAD_REFERENCE)
    const report = await verifyPluginBundle(path)
    expect(report.ok).toBe(false)
    expect(report.errorCode).toBe('E_PLUGIN_SURFACE_INVALID')
    expect(report.error).toContain('"accounts"')
    expect(report.error).toContain('"missing-view"')
    expect(report.scripts).toEqual([])
  }, 10_000)

  test('malformed 2/4 — an embedded JSON Schema over checkDeclaredSchema\'s limits fails, naming the column and the limit (criterion 4)', async () => {
    const path = writeBundle(SURFACE_OVERSIZED_SCHEMA)
    const report = await verifyPluginBundle(path)
    expect(report.ok).toBe(false)
    expect(report.errorCode).toBe('E_PLUGIN_SURFACE_INVALID')
    expect(report.error).toContain('view "accounts" column "username"')
  }, 10_000)

  test('malformed 3/4 — an action kind outside the closed union fails, naming the action', async () => {
    const path = writeBundle(SURFACE_UNKNOWN_ACTION_KIND)
    const report = await verifyPluginBundle(path)
    expect(report.ok).toBe(false)
    expect(report.errorCode).toBe('E_PLUGIN_SURFACE_INVALID')
    expect(report.error).toContain('shell')
  }, 10_000)

  test('malformed 4/4 — a cap exceeded fails, naming the limit it hit', async () => {
    const path = writeBundle(SURFACE_CAP_EXCEEDED)
    const report = await verifyPluginBundle(path)
    expect(report.ok).toBe(false)
    expect(report.errorCode).toBe('E_PLUGIN_SURFACE_INVALID')
    expect(report.error).toContain('maxNav')
  }, 10_000)

  test('a surface JSON cannot express is refused by the child and still reported under this plan\'s code', async () => {
    const path = writeBundle(SURFACE_UNSERIALISABLE)
    const report = await verifyPluginBundle(path)
    expect(report.ok).toBe(false)
    expect(report.errorCode).toBe('E_PLUGIN_SURFACE_INVALID')
    expect(report.error).toContain('serialised to JSON')
  }, 10_000)
})
