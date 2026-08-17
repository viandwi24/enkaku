import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { validatePluginSurface, type PluginSurface, type PluginSurfaceInput } from '@enkaku/protocol'
import { openDb, runMigrations, type Db } from '../db'
import { createKvStore } from '../kv/store'
import { createScriptRegistry } from '../scripts/registry'
import { createDevSlotStore } from './dev-slots'
import { createPluginRuntime, type PluginRuntime } from './runtime'
import { createSurfaceRegistry, resolvePluginSurface } from './surface-registry'
import type { VerifyReport } from './verify-child'

/**
 * Plan 108 §3.5, §5 step 108.6, criterion 6 — the merge of active plugins'
 * and dev slots' nav, and the resolution of one view.
 *
 * A real `Db` and a real `PluginRuntime`, because two of the three claims are
 * claims about ROW STATUS (`active` and nothing else) and about what survives
 * a stage/verify/activate round trip through the `plugins.manifest` JSON
 * column — neither is observable against a stubbed runtime.
 */

function surfaceOf(input: PluginSurfaceInput): PluginSurface {
  const checked = validatePluginSurface(input)
  if (!checked.ok) throw new Error(`test fixture is not a valid surface: ${checked.errors.join('; ')}`)
  return checked.value
}

/** Two views and three actions, so "only the actions this view references" has something to exclude. */
const accountsSurface = surfaceOf({
  nav: [
    { id: 'accounts', label: 'TikTok accounts', icon: 'users', view: 'accounts' },
    { id: 'settings', label: 'TikTok settings', icon: 'settings', view: 'settings' },
  ],
  views: {
    accounts: {
      title: 'TikTok accounts',
      data: { kind: 'kv.scan', key: 'accounts', rows: 'items', itemsAt: 'accounts' },
      table: { rowKey: 'username', columns: [{ field: 'username', header: 'Account' }] },
      toolbar: ['sync'],
      rowActions: ['switchTo'],
    },
    settings: {
      title: 'TikTok settings',
      data: { kind: 'kv.list', scope: 'global' },
      table: { rowKey: 'key', columns: [{ field: 'key', header: 'Key' }] },
      toolbar: ['saveSetting'],
    },
  },
  actions: {
    sync: { kind: 'batch', label: 'Sync accounts', script: 'tiktok/list-accounts@latest' },
    switchTo: { kind: 'job', label: 'Switch', script: 'tiktok/switch-account@latest', params: { target: { $row: 'username' } } },
    saveSetting: { kind: 'kv.set', label: 'Save', scope: 'global', key: { $form: 'key' }, value: { $form: 'value' } },
  },
})

const devSurface = surfaceOf({
  nav: [{ id: 'accounts', label: 'TikTok accounts (dev)', icon: 'users', view: 'accounts' }],
  views: {
    accounts: {
      title: 'TikTok accounts (dev)',
      data: { kind: 'kv.scan', key: 'accounts' },
      table: { rowKey: 'stableId', columns: [{ field: 'stableId', header: 'Device' }] },
      rowActions: ['ping'],
    },
  },
  actions: { ping: { kind: 'job', label: 'Ping', script: 'tiktok/ping@latest' } },
})

let dataDir: string

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'enkaku-surface-registry-'))
})

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true })
})

interface Harness {
  db: Db
  runtime: PluginRuntime
  /** The surface the next `verify`/`putDevSlot` will report; mutable so one harness can stage several plugins. */
  setReported(surface: PluginSurface | undefined): void
  /** Makes the next `verify` fail, so a genuinely `failed` row can be produced. */
  setFailing(failing: boolean): void
}

function setUp(): Harness {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  const db: Db = opened.db
  const kv = createKvStore(db, dataDir, () => ({ maxValueBytes: 65_536, maxKeyLength: 256, maxEntriesPerNamespace: 1_000, maxEntriesPerDevice: 5_000 }))
  const devSlots = createDevSlotStore()
  const registry = createScriptRegistry({ db, dataDir, devSlots })
  let reported: PluginSurface | undefined
  let failing = false
  const verify = async (_bundlePath: string, opts?: { expectedVersion?: string }): Promise<VerifyReport> =>
    failing
      ? { ok: false, error: 'the plugin\'s surface is invalid', errorCode: 'E_PLUGIN_SURFACE_INVALID', scripts: [], resetPackages: [] }
      : {
          ok: true,
          version: opts?.expectedVersion ?? '1.0.0',
          scripts: [{ id: 'login', paramsSchema: { type: 'object' }, runtime: null }],
          resetPackages: [],
          ...(reported ? { surface: reported } : {}),
        }
  const runtime = createPluginRuntime({ db, dataDir, registry, kv, devSlots, verify })
  return {
    db,
    runtime,
    setReported(surface) {
      reported = surface
    },
    setFailing(next) {
      failing = next
    },
  }
}

async function publish(runtime: PluginRuntime, name: string, version = '1.0.0'): Promise<string> {
  const staged = await runtime.stage({ name, version, bundle: 'export {}' })
  await runtime.verify(staged.id)
  return staged.id
}

async function activate(runtime: PluginRuntime, name: string, version = '1.0.0'): Promise<void> {
  runtime.activate(await publish(runtime, name, version))
}

describe('ui() — active plugins and dev slots only (criterion 6)', () => {
  test('an active plugin contributes its nav', async () => {
    const h = setUp()
    h.setReported(accountsSurface)
    await activate(h.runtime, 'tiktok')

    const items = createSurfaceRegistry({ runtime: h.runtime }).ui()
    expect(items).toHaveLength(1)
    expect(items[0]?.plugin).toBe('tiktok')
    expect(items[0]?.version).toBe('1.0.0')
    expect(items[0]?.origin).toBe('plugin')
    expect(items[0]?.nav.map((n) => n.id)).toEqual(['accounts', 'settings'])
  })

  test('a merely STAGED (verified, not activated) plugin contributes nothing', async () => {
    const h = setUp()
    h.setReported(accountsSurface)
    await publish(h.runtime, 'tiktok')
    expect(createSurfaceRegistry({ runtime: h.runtime }).ui()).toEqual([])
  })

  test('a FAILED plugin contributes nothing (§3.9 — it registers nothing and disturbs nothing)', async () => {
    const h = setUp()
    h.setReported(accountsSurface)
    h.setFailing(true)
    const staged = await h.runtime.stage({ name: 'broken', version: '1.0.0', bundle: 'export {}' })
    const report = await h.runtime.verify(staged.id)
    expect(report.ok).toBe(false)
    expect(h.runtime.get('broken', '1.0.0')?.status).toBe('failed')
    expect(createSurfaceRegistry({ runtime: h.runtime }).ui()).toEqual([])
  })

  test('a DISABLED plugin contributes nothing, and its nav disappears (criterion 9)', async () => {
    const h = setUp()
    h.setReported(accountsSurface)
    await activate(h.runtime, 'tiktok')
    expect(createSurfaceRegistry({ runtime: h.runtime }).ui()).toHaveLength(1)

    h.runtime.disable('tiktok')
    expect(h.runtime.get('tiktok', '1.0.0')?.status).toBe('disabled')
    expect(createSurfaceRegistry({ runtime: h.runtime }).ui()).toEqual([])
  })

  test('a SUPERSEDED version contributes nothing — only the active one does', async () => {
    const h = setUp()
    h.setReported(accountsSurface)
    await activate(h.runtime, 'tiktok', '1.0.0')
    await activate(h.runtime, 'tiktok', '2.0.0')

    const items = createSurfaceRegistry({ runtime: h.runtime }).ui()
    expect(items).toHaveLength(1)
    expect(items[0]?.version).toBe('2.0.0')
  })

  test('a plugin with no surface at all is absent, not present-and-empty', async () => {
    const h = setUp()
    h.setReported(undefined)
    await activate(h.runtime, 'plain')
    expect(createSurfaceRegistry({ runtime: h.runtime }).ui()).toEqual([])
  })
})

describe('ui() — dev slots', () => {
  test('a dev slot contributes its nav, flagged origin: "dev" with its build version', async () => {
    const h = setUp()
    h.setReported(devSurface)
    await h.runtime.putDevSlot({ name: 'tiktok', owner: { kind: 'cli', label: 'me@laptop' }, source: { kind: 'bundle', bundle: 'export {}' } })

    const items = createSurfaceRegistry({ runtime: h.runtime }).ui()
    expect(items).toHaveLength(1)
    expect(items[0]?.origin).toBe('dev')
    expect(items[0]?.version).toBe('1.0.0+dev.1')
    expect(items[0]?.nav[0]?.label).toBe('TikTok accounts (dev)')
  })

  test('a dev slot SHADOWS an active plugin of the same name (plan 82 §3.5\'s precedent)', async () => {
    const h = setUp()
    h.setReported(accountsSurface)
    await activate(h.runtime, 'tiktok')
    h.setReported(devSurface)
    await h.runtime.putDevSlot({ name: 'tiktok', owner: { kind: 'cli', label: 'me@laptop' }, source: { kind: 'bundle', bundle: 'export {}' } })

    const items = createSurfaceRegistry({ runtime: h.runtime }).ui()
    expect(items).toHaveLength(1)
    expect(items[0]?.origin).toBe('dev')
    expect(items[0]?.nav.map((n) => n.label)).toEqual(['TikTok accounts (dev)'])
  })

  test('a dev slot declaring NO surface still shadows — the published screen does not leak back through it', async () => {
    const h = setUp()
    h.setReported(accountsSurface)
    await activate(h.runtime, 'tiktok')
    h.setReported(undefined)
    await h.runtime.putDevSlot({ name: 'tiktok', owner: { kind: 'cli', label: 'me@laptop' }, source: { kind: 'bundle', bundle: 'export {}' } })

    expect(createSurfaceRegistry({ runtime: h.runtime }).ui()).toEqual([])
    expect(resolvePluginSurface(h.runtime, 'tiktok')).toBeNull()
  })

  test('a dev slot and an unrelated active plugin both appear, sorted by plugin name', async () => {
    const h = setUp()
    h.setReported(accountsSurface)
    await activate(h.runtime, 'tiktok')
    h.setReported(devSurface)
    await h.runtime.putDevSlot({ name: 'alpha', owner: { kind: 'workspace', label: '/scripts/alpha' }, source: { kind: 'bundle', bundle: 'export {}' } })

    const items = createSurfaceRegistry({ runtime: h.runtime }).ui()
    expect(items.map((i) => i.plugin)).toEqual(['alpha', 'tiktok'])
    expect(items.map((i) => i.origin)).toEqual(['dev', 'plugin'])
  })
})

describe('resolveView() — only the actions this view references', () => {
  test('the accounts view carries its two actions and NOT the settings view\'s', async () => {
    const h = setUp()
    h.setReported(accountsSurface)
    await activate(h.runtime, 'tiktok')

    const resolved = createSurfaceRegistry({ runtime: h.runtime }).resolveView('tiktok', 'accounts')
    expect(resolved).not.toBeNull()
    expect(resolved?.viewId).toBe('accounts')
    expect(resolved?.view.title).toBe('TikTok accounts')
    expect(Object.keys(resolved?.actions ?? {}).sort()).toEqual(['switchTo', 'sync'])
    expect(resolved?.actions.saveSetting).toBeUndefined()
  })

  test('the settings view carries only its own single action', async () => {
    const h = setUp()
    h.setReported(accountsSurface)
    await activate(h.runtime, 'tiktok')

    const resolved = createSurfaceRegistry({ runtime: h.runtime }).resolveView('tiktok', 'settings')
    expect(Object.keys(resolved?.actions ?? {})).toEqual(['saveSetting'])
  })

  test('an unknown view id, and a plugin that is neither active nor dev, both resolve to null', async () => {
    const h = setUp()
    h.setReported(accountsSurface)
    await activate(h.runtime, 'tiktok')
    const surfaces = createSurfaceRegistry({ runtime: h.runtime })
    expect(surfaces.resolveView('tiktok', 'nope')).toBeNull()
    expect(surfaces.resolveView('ghost', 'accounts')).toBeNull()
  })

  test('a dev slot\'s view resolves from the DEV surface, not the published one', async () => {
    const h = setUp()
    h.setReported(accountsSurface)
    await activate(h.runtime, 'tiktok')
    h.setReported(devSurface)
    await h.runtime.putDevSlot({ name: 'tiktok', owner: { kind: 'cli', label: 'me@laptop' }, source: { kind: 'bundle', bundle: 'export {}' } })

    const resolved = createSurfaceRegistry({ runtime: h.runtime }).resolveView('tiktok', 'accounts')
    expect(resolved?.origin).toBe('dev')
    expect(Object.keys(resolved?.actions ?? {})).toEqual(['ping'])
    // The published surface's `settings` view is not reachable while the slot is held.
    expect(createSurfaceRegistry({ runtime: h.runtime }).resolveView('tiktok', 'settings')).toBeNull()
  })
})
