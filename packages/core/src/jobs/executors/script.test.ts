import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createJobRunner, type KvRunnerDeps } from '@enkaku/session'
import { openDb, runMigrations, type Db } from '../../db'
import { scripts } from '../../db/schema'
import { createDevSlotStore } from '../../plugins/dev-slots'
import { createScriptRegistry } from '../../scripts/registry'
import { EnkakuError } from '../../util/errors'
import type { Logger } from '../../util/logger'
import { createScriptExecutor } from './script'

/**
 * `executors/script.ts` after plan 82's registry wiring — two things that
 * were previously unreachable (`db`-direct table reads have no id for a dev
 * slot, and never carried `exportId` at all):
 *
 * 1. A dev entry shadowing a published one logs it, on the run's first log
 *    line, naming the published version and the dev owner (criterion 16).
 * 2. `ctx.kv`'s namespace for a plugin member is the PLUGIN's id, shared
 *    across every member — not the member's own export id (plan 79 §3.2,
 *    plan 82 §3.10) — a gap this pass found while wiring exportId through:
 *    `job-runner.ts` used to key the kv namespace off `ready`'s `scriptId`
 *    alone, which for a plugin member is the export id (`login`), not the
 *    plugin (`tiktok`), so two scripts in one plugin would NOT have shared
 *    the same kv namespace before this fix.
 */

function setUpDb(): Db {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  return opened.db
}

const silentLog = (): Logger => {
  const l = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => l }
  return l as unknown as Logger
}

function fakeSessions() {
  return {
    acquire: async () => ({ deviceId: 'd1', inspector: null, whenInspectorReady: async () => {} }) as never,
    release: () => {},
    get: () => null as never,
    closeDevice: async () => {},
    closeIfIdle: async () => {},
    idleSessions: () => [],
    closeAll: async () => 0,
  }
}

const dirs: string[] = []
function writeBundle(source: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'enkaku-script-executor-test-'))
  dirs.push(dir)
  const path = join(dir, 'bundle.mjs')
  Bun.write(path, source)
  return path
}

const PLUGIN_BUNDLE = `
export default {
  id: 'tiktok',
  version: '1.0.0+dev.1',
  scripts: [
    { id: 'login', version: '1.0.0+dev.1', params: { parse: (v) => v }, run: async () => 'dev-login-ok' },
  ],
}
`

describe('createScriptExecutor — dev shadow logging (criterion 16)', () => {
  test('running a dev entry that shadows a published one logs which was used, naming the published version and the dev owner, on the first log line', async () => {
    const db = setUpDb()
    const dataDir = `/tmp/enkaku-script-executor-test-${crypto.randomUUID()}`

    // A published, active `tiktok/login@1.0.0`.
    db.insert(scripts)
      .values({ id: 's-login', name: 'tiktok/login', version: '1.0.0', bundle: 'export {}', pluginId: 'p1', exportId: 'login', enabled: true, createdAt: new Date() })
      .run()

    const devSlots = createDevSlotStore()
    const bundlePath = writeBundle(PLUGIN_BUNDLE)
    devSlots.put({
      pluginName: 'tiktok',
      declaredVersion: '1.0.0',
      bundlePath,
      scripts: [{ exportId: 'login', paramsSchema: {} }],
      owner: { kind: 'workspace', label: '/scripts/tiktok' },
    })

    const registry = createScriptRegistry({ db, dataDir, devSlots })
    const devEntry = registry.resolve('tiktok/login@latest', { allowDev: true })
    expect(devEntry.origin).toBe('dev') // dev wins over published (§4.4)

    const runner = createJobRunner({
      logDir: `/tmp/enkaku-script-executor-test-logs-${crypto.randomUUID()}`,
      sessions: fakeSessions(),
      artifacts: () => ({ save: async () => ({ path: 'x', sizeBytes: 0 }) }),
      log: silentLog() as never,
      onLog: () => {},
      onArtifact: () => {},
      onPhase: () => {},
      heartbeat: () => {},
    })

    const executor = createScriptExecutor({ registry, runner })
    const logged: string[] = []
    const ctx = {
      signal: new AbortController().signal,
      heartbeat: () => {},
      log: { debug: () => {}, info: (m: string) => logged.push(m), warn: () => {}, error: () => {}, child: () => ctx.log } as unknown as Logger,
    }

    const job = { id: 'job-shadow-1', scriptId: devEntry.id, deviceId: 'd1', params: {} } as never
    const result = await executor.run(job, ctx as never)
    expect(result).toBe('dev-login-ok')
    expect(logged.length).toBeGreaterThan(0)
    expect(logged[0]).toContain('DEV build')
    expect(logged[0]).toContain('tiktok/login@1.0.0') // the published version it shadows
    expect(logged[0]).toContain('/scripts/tiktok') // the dev owner
  }, 20000)

  test('running a PUBLISHED entry (no shadowing) logs nothing about a dev build', async () => {
    const db = setUpDb()
    const dataDir = `/tmp/enkaku-script-executor-test-${crypto.randomUUID()}`
    db.insert(scripts)
      .values({ id: 's-standalone', name: 'checkout', version: '1.0.0', bundle: `export default { id: 'checkout', version: '1.0.0', params: { parse: (v) => v }, run: async () => 'ok' }`, enabled: true, createdAt: new Date() })
      .run()
    const registry = createScriptRegistry({ db, dataDir, devSlots: createDevSlotStore() })
    const runner = createJobRunner({
      logDir: `/tmp/enkaku-script-executor-test-logs-${crypto.randomUUID()}`,
      sessions: fakeSessions(),
      artifacts: () => ({ save: async () => ({ path: 'x', sizeBytes: 0 }) }),
      log: silentLog() as never,
      onLog: () => {},
      onArtifact: () => {},
      onPhase: () => {},
      heartbeat: () => {},
    })
    const executor = createScriptExecutor({ registry, runner })
    const logged: string[] = []
    const ctx = {
      signal: new AbortController().signal,
      heartbeat: () => {},
      log: { debug: () => {}, info: (m: string) => logged.push(m), warn: () => {}, error: () => {}, child: () => ctx.log } as unknown as Logger,
    }
    const job = { id: 'job-standalone-1', scriptId: 's-standalone', deviceId: 'd1', params: {} } as never
    await executor.run(job, ctx as never)
    expect(logged.some((m) => m.includes('DEV build'))).toBe(false)
  }, 20000)
})

const NAMESPACE_PLUGIN_BUNDLE = `
export default {
  id: 'tiktok',
  version: '1.0.0',
  scripts: [
    { id: 'login', version: '1.0.0', params: { parse: (v) => v }, run: async (ctx) => { await ctx.kv.global.set('probe', 1); return 'login-ok' } },
    { id: 'warmup', version: '1.0.0', params: { parse: (v) => v }, run: async (ctx) => { await ctx.kv.global.set('probe', 2); return 'warmup-ok' } },
  ],
}
`

describe("ctx.kv's namespace for a plugin member is the PLUGIN's id, shared across every member (plan 79 §3.2, plan 82 §3.10)", () => {
  test('two DIFFERENT members of the SAME plugin issue kv calls under the SAME namespace — the plugin id, not their own export id', async () => {
    const db = setUpDb()
    const dataDir = `/tmp/enkaku-script-executor-kv-test-${crypto.randomUUID()}`
    db.insert(scripts)
      .values([
        { id: 's-login', name: 'tiktok/login', version: '1.0.0', bundle: NAMESPACE_PLUGIN_BUNDLE, pluginId: 'p1', exportId: 'login', enabled: true, createdAt: new Date() },
        { id: 's-warmup', name: 'tiktok/warmup', version: '1.0.0', bundle: NAMESPACE_PLUGIN_BUNDLE, pluginId: 'p1', exportId: 'warmup', enabled: true, createdAt: new Date() },
      ])
      .run()
    const registry = createScriptRegistry({ db, dataDir, devSlots: createDevSlotStore() })

    const namespaces: string[] = []
    const kv: KvRunnerDeps = {
      call: async (ctx) => {
        namespaces.push(ctx.namespace)
        return { version: 1 }
      },
      redact: (_ctx, text) => text,
    }

    const runner = createJobRunner({
      logDir: `/tmp/enkaku-script-executor-kv-test-logs-${crypto.randomUUID()}`,
      sessions: fakeSessions(),
      artifacts: () => ({ save: async () => ({ path: 'x', sizeBytes: 0 }) }),
      log: silentLog() as never,
      onLog: () => {},
      onArtifact: () => {},
      onPhase: () => {},
      heartbeat: () => {},
      kv,
    })
    const executor = createScriptExecutor({ registry, runner })
    const ctx = { signal: new AbortController().signal, heartbeat: () => {}, log: silentLog() }

    await executor.run({ id: 'job-ns-1', scriptId: 's-login', deviceId: 'd1', params: {} } as never, ctx as never)
    await executor.run({ id: 'job-ns-2', scriptId: 's-warmup', deviceId: 'd1', params: {} } as never, ctx as never)

    expect(namespaces).toEqual(['tiktok', 'tiktok'])
  }, 20000)
})

/**
 * `validateParams` (plan 95 §5 step 95.6, fixes F10) — before this plan the
 * comment on this method said params were "just passed straight through";
 * now it validates against the SAME `paramsSchema` a run form would read,
 * looked up through the registry by the `scriptId` `validateScriptForRun`
 * passes in (the fallback executor is one instance shared by every
 * non-built-in script, so it cannot know which schema applies any other
 * way).
 */
describe('createScriptExecutor.validateParams (plan 95 §5 step 95.6)', () => {
  function registryWithSchema(db: Db, paramsSchema: unknown) {
    db.insert(scripts)
      .values({ id: 'checkout', name: 'checkout', version: '1.0.0', bundle: 'export {}', enabled: true, paramsSchema, createdAt: new Date() })
      .run()
    return createScriptRegistry({ db, dataDir: `/tmp/enkaku-script-executor-validate-test-${crypto.randomUUID()}`, devSlots: createDevSlotStore() })
  }

  test('an out-of-range value is rejected with the path and message the plan names, and carries EnkakuError.issues', () => {
    const db = setUpDb()
    const registry = registryWithSchema(db, {
      type: 'object',
      properties: { videos: { type: 'integer', maximum: 2000 } },
      required: ['videos'],
    })
    const executor = createScriptExecutor({ registry, runner: {} as never })

    let caught: unknown
    try {
      executor.validateParams({ videos: 9999 }, 'checkout')
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(EnkakuError)
    expect((caught as EnkakuError).code).toBe('invalid_job_params')
    expect((caught as EnkakuError).issues).toEqual([{ path: 'videos', message: 'must be at most 2000' }])
  })

  test('a value inside every bound passes through unchanged', () => {
    const db = setUpDb()
    const registry = registryWithSchema(db, { type: 'object', properties: { videos: { type: 'integer', maximum: 2000 } } })
    const executor = createScriptExecutor({ registry, runner: {} as never })
    expect(executor.validateParams({ videos: 30 }, 'checkout')).toEqual({ videos: 30 })
  })

  test('a script with no declared paramsSchema accepts anything (F10: no schema is not a violation)', () => {
    const db = setUpDb()
    db.insert(scripts).values({ id: 'no-params', name: 'no-params', version: '1.0.0', bundle: 'export {}', enabled: true, createdAt: new Date() }).run()
    const registry = createScriptRegistry({ db, dataDir: `/tmp/enkaku-script-executor-validate-test-${crypto.randomUUID()}`, devSlots: createDevSlotStore() })
    const executor = createScriptExecutor({ registry, runner: {} as never })
    expect(executor.validateParams({ anything: 'goes' }, 'no-params')).toEqual({ anything: 'goes' })
  })

  test('an unknown scriptId throws unknown_script rather than crashing on a missing entry', () => {
    const db = setUpDb()
    const registry = createScriptRegistry({ db, dataDir: `/tmp/enkaku-script-executor-validate-test-${crypto.randomUUID()}`, devSlots: createDevSlotStore() })
    const executor = createScriptExecutor({ registry, runner: {} as never })
    expect(() => executor.validateParams({}, 'does-not-exist')).toThrow(EnkakuError)
  })
})

process.on('exit', () => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
