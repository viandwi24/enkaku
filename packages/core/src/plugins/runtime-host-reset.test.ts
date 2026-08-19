import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'
import type { PluginServiceDeclaration } from '@enkaku/protocol'
import { openDb, runMigrations } from '../db'
import { createKvStore } from '../kv/store'
import { createDevSlotStore } from './dev-slots'
import { createPluginRuntime } from './runtime'
import { createRuntimeHost, type RuntimeHost } from './runtime-host'
import type { VerifyReport } from './verify-child'
import { createScriptRegistry } from '../scripts/registry'
import type { Logger } from '../util/logger'

/**
 * **Reset data, the host's half** — `RuntimeHost.resetData`.
 *
 * Two things are proven here and nowhere else:
 *
 * 1. **The borrowed authority is scoped to the PASS, not to the object.** The
 *    plugin's own `setup` context never carries it; the reset context carries it
 *    while the pass is open; and the very same reset context, stashed by the
 *    plugin and used a moment later, does not. That last one is the whole
 *    defence — a grant that survived the pass would be a standing permission
 *    wearing a scoped permission's name.
 * 2. **Every way a cleanup can fail to happen is REPORTED, never thrown.** Each
 *    one has to reach an operator as a reason nothing was deleted, and a throw
 *    would flatten four different next actions into one 500.
 *
 * The bundles below are hand-written objects rather than `defineService()`
 * results, for the reason `verify-child.test.ts` gives for the same choice: a
 * materialised bundle in a temp directory cannot resolve `@enkaku/sdk`, and the
 * host recognises a service by its brand rather than by its provenance.
 */

function silentLog(): Logger {
  const self: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => self }
  return self
}

const WITH_RESET: PluginServiceDeclaration = {
  permissions: ['standing.cap'],
  isolation: 'in-process',
  listeners: [],
  events: [],
  webhooks: [],
  resetData: { permissions: ['borrowed.cap'] },
}

const NO_RESET: PluginServiceDeclaration = { ...WITH_RESET, resetData: null }

/** One `ctx.farm` call the host forwarded, with the flag the broker would gate on. */
interface FarmCall {
  capability: string
  reset: boolean
}

const cleanup: Array<() => void> = []
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn()
})

function setUp(bundle: string, service: PluginServiceDeclaration = WITH_RESET): { host: RuntimeHost; calls: FarmCall[]; install(): Promise<void> } {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  const db = opened.db
  const dataDir = mkdtempSync(join(tmpdir(), 'enkaku-reset-host-'))
  const kv = createKvStore(db, dataDir, () => ({ maxValueBytes: 65_536, maxKeyLength: 256, maxEntriesPerNamespace: 1_000, maxEntriesPerDevice: 5_000 }))
  const registry = createScriptRegistry({ db, dataDir, devSlots: createDevSlotStore() })
  const report: VerifyReport = { ok: true, pluginId: 'pm', version: '1.0.0', scripts: [], service, resetPackages: [] }
  const plugins = createPluginRuntime({ db, dataDir, registry, kv, verify: async () => report })
  const calls: FarmCall[] = []
  const host = createRuntimeHost({
    plugins,
    dataDir,
    store: kv,
    resolveStableId: () => null,
    log: silentLog(),
    unattributedRejection: 'report',
    farm: async (_pluginId, capability, _input, opts) => {
      calls.push({ capability, reset: opts?.reset === true })
      return {}
    },
  })
  cleanup.push(() => {
    host.dispose()
    opened.sqlite.close()
    rmSync(dataDir, { recursive: true, force: true })
  })
  return {
    host,
    calls,
    async install() {
      const staged = await plugins.stage({ name: 'pm', version: '1.0.0', bundle })
      await plugins.verify(staged.id)
      plugins.activate(staged.id)
    },
  }
}

/** A bundle whose reset handler stashes its own context on `globalThis`, so a test can use it after the pass has closed. */
const STASHING_BUNDLE = `
const g = globalThis
g.__resetProbe = { setupCtx: null, resetCtx: null, sawData: null }
export default {
  id: 'pm',
  version: '1.0.0',
  service: {
    kind: 'enkaku.service',
    permissions: ['standing.cap'],
    isolation: 'in-process',
    listeners: [],
    events: [],
    webhooks: [],
    resetData: { permissions: ['borrowed.cap'] },
    async setup(ctx) {
      g.__resetProbe.setupCtx = ctx
      await ctx.farm.callRaw('from.setup')
    },
    async onResetData(ctx) {
      g.__resetProbe.resetCtx = ctx
      await ctx.farm.callRaw('during.reset')
      g.__resetProbe.sawData = (await ctx.storage.global.list()).items.length
      return { items: [{ kind: 'device', id: 's1', outcome: 'cleared', message: 'route off' }] }
    },
  },
}
`

describe('the Reset data grant is open for the pass and shut afterwards', () => {
  test("setup's own context never carries it; the reset context does; the stashed reset context does not", async () => {
    const h = setUp(STASHING_BUNDLE)
    await h.install()
    await h.host.load('pm')

    const outcome = await h.host.resetData('pm')
    expect(outcome).toMatchObject({ declared: true, ran: true, skipped: null, error: null })
    expect(outcome.report.items).toHaveLength(1)

    // The same object the handler was given, used after the pass ended.
    const probe = (globalThis as { __resetProbe?: { resetCtx?: { farm: { callRaw(id: string): Promise<unknown> } } } }).__resetProbe
    await probe?.resetCtx?.farm.callRaw('after.reset')

    expect(h.calls).toEqual([
      { capability: 'from.setup', reset: false },
      { capability: 'during.reset', reset: true },
      { capability: 'after.reset', reset: false },
    ])
  })

  test('the handler sees its own data — the pass runs before anything is deleted', async () => {
    const h = setUp(STASHING_BUNDLE)
    await h.install()
    await h.host.load('pm')
    // The host deletes nothing at all, which is the property: `api/plugins.ts`
    // is the only thing that does, and only after this returns.
    await h.host.resetData('pm')
    const probe = (globalThis as { __resetProbe?: { sawData?: number | null } }).__resetProbe
    expect(probe?.sawData).toBe(0)
  })
})

describe('every way a cleanup can fail to happen is reported, never thrown', () => {
  test('a plugin declaring no reset block answers "nothing to undo" with no fault', async () => {
    const h = setUp(STASHING_BUNDLE, NO_RESET)
    await h.install()
    await h.host.load('pm')
    expect(await h.host.resetData('pm')).toEqual({ declared: false, ran: false, skipped: null, error: null, report: { items: [] } })
  })

  test('a service that was never loaded is skipped by name, and the message says nothing was deleted', async () => {
    const h = setUp(STASHING_BUNDLE)
    await h.install()
    const outcome = await h.host.resetData('pm')
    expect(outcome.ran).toBe(false)
    expect(outcome.skipped?.code).toBe('E_PLUGIN_RUNTIME_NOT_RUNNING')
    expect(outcome.skipped?.message).toContain('nothing was deleted')
  })

  test('a manifest that promises a handler the bundle does not export is a fault, not "nothing to undo"', async () => {
    const h = setUp(`
      export default {
        id: 'pm', version: '1.0.0',
        service: { kind: 'enkaku.service', permissions: [], isolation: 'in-process', listeners: [], events: [], webhooks: [], resetData: { permissions: [] }, setup() {} },
      }
    `)
    await h.install()
    await h.host.load('pm')
    const outcome = await h.host.resetData('pm')
    expect(outcome.ran).toBe(false)
    expect(outcome.skipped?.code).toBe('E_PLUGIN_RESET_MISSING')
  })

  test('a handler that throws is reported with its error, and reports no items', async () => {
    const h = setUp(`
      export default {
        id: 'pm', version: '1.0.0',
        service: {
          kind: 'enkaku.service', permissions: [], isolation: 'in-process', listeners: [], events: [], webhooks: [],
          resetData: { permissions: [] }, setup() {},
          onResetData() { throw new Error('the supervisor is gone') },
        },
      }
    `)
    await h.install()
    await h.host.load('pm')
    const outcome = await h.host.resetData('pm')
    expect(outcome.ran).toBe(true)
    expect(outcome.error?.message).toContain('the supervisor is gone')
    expect(outcome.report.items).toEqual([])
  })

  test('a report the farm cannot parse is a fault — a cleanup whose own account is unreadable is not a cleanup that succeeded', async () => {
    const h = setUp(`
      export default {
        id: 'pm', version: '1.0.0',
        service: {
          kind: 'enkaku.service', permissions: [], isolation: 'in-process', listeners: [], events: [], webhooks: [],
          resetData: { permissions: [] }, setup() {},
          onResetData() { return { items: [{ id: 's1', outcome: 'mostly-fine', message: 'hm' }] } },
        },
      }
    `)
    await h.install()
    await h.host.load('pm')
    const outcome = await h.host.resetData('pm')
    expect(outcome.error?.code).toBe('E_PLUGIN_RESET_REPORT_INVALID')
    expect(outcome.error?.message).toContain('Nothing was deleted')
  })

  test('a handler that returns nothing is an empty report, not a failure', async () => {
    const h = setUp(`
      export default {
        id: 'pm', version: '1.0.0',
        service: {
          kind: 'enkaku.service', permissions: [], isolation: 'in-process', listeners: [], events: [], webhooks: [],
          resetData: { permissions: [] }, setup() {},
          onResetData() {},
        },
      }
    `)
    await h.install()
    await h.host.load('pm')
    expect(await h.host.resetData('pm')).toMatchObject({ ran: true, error: null, report: { items: [] } })
  })
})
