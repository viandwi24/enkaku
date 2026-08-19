import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { PluginServiceDeclarationSchema, unsupportedIsolationMessage } from '@enkaku/protocol'
import { openDb, runMigrations } from '../db'
import { createKvStore } from '../kv/store'
import { createScriptRegistry } from '../scripts/registry'
import type { Logger } from '../util/logger'
import { createDevSlotStore } from './dev-slots'
import { createPluginRuntime, type PluginRuntime } from './runtime'
import { FIXTURE_BUNDLE } from './runtime-host.bundle'
import { createRuntimeHost, type RuntimeHost } from './runtime-host'
import { freshFixtureControl, type RuntimeHostFixtureControl } from './runtime-host.fixture'
import type { VerifyReport } from './verify-child'

/**
 * Plan 109 (M74 — the plugin runtime), step 109.2. **The host's containment
 * policies, against a plugin that really is installed.**
 *
 * `runtime-host.fixture.ts` is bundled by `Bun.build` — the same call a real
 * publish makes — staged, verified, activated, and then loaded by the real
 * host from the real content-addressed bundle cache. Nothing here substitutes
 * a stand-in for the plugin: the whole point of criterion 4 is that a floating
 * rejection is traced back to a plugin's own module, and a fixture living in
 * this file's module could never exercise that.
 *
 * Criteria under test: 3 (a handler that throws, rejects or overruns its
 * deadline is contained, charged, and harms nothing else), 4 (a floating
 * rejection is ATTRIBUTED), 5 (the error budget disables the service, verbatim,
 * and never retries), 7 (`isolation: 'process'` is accepted by the schema and
 * refused by the farm). Criterion 7's verify half lives in
 * `verify-child.test.ts`, where the verify boundary's other refusals already
 * are.
 *
 * H2 — 10 000 invocations without leaking memory or handles — is the last
 * `describe` in this file and is gated behind `ENKAKU_TEST_H2=1`, the same way
 * a device-dependent test is gated behind `ENKAKU_TEST_DEVICE=1`. It takes
 * tens of seconds; its measured numbers are recorded in plan 109 §0.2.
 */


function control(): RuntimeHostFixtureControl {
  const existing = (globalThis as { __enkakuRuntimeHostFixture?: RuntimeHostFixtureControl }).__enkakuRuntimeHostFixture
  if (!existing) throw new Error('the fixture has not been loaded yet')
  return existing
}

/** Quiet: these tests deliberately produce a great deal of `error`-level output. */
function silentLog(): Logger {
  const self: Logger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    child: () => self,
  }
  return self
}

/**
 * The declaration `runtime-host.fixture.ts` really carries, restated here so
 * the injected `verify` writes the same manifest the real verify child would.
 * They are asserted equal by the end-to-end test below — a fake verify that
 * drifted from the bundle would otherwise make every other test in this file
 * exercise a manifest no publish could produce.
 */
const FIXTURE_SERVICE: VerifyReport['service'] = {
  permissions: ['device.list'],
  isolation: 'in-process',
  listeners: [{ id: 'probe', proto: 'tcp', deviceReachable: false, description: 'the fixture listener' }],
  events: ['device.status', 'job.status'],
  webhooks: [
    { id: 'hook', description: 'the fixture webhook', maxBodyBytes: 65_536, rateLimitPerMin: 60, toleranceSec: 300 },
    {
      id: 'strict',
      body: { type: 'object', required: ['a'], properties: { a: { type: 'string' } } },
      maxBodyBytes: 256,
      rateLimitPerMin: 5,
      toleranceSec: 300,
    },
  ],
  resetData: null,
}

function serviceReport(overrides: Partial<VerifyReport> = {}): VerifyReport {
  return {
    ok: true,
    pluginId: 'fixture',
    version: '1.0.0',
    scripts: [{ id: 'noop', paramsSchema: { type: 'object' }, runtime: null }],
    service: FIXTURE_SERVICE,
    resetPackages: [],
    ...overrides,
  }
}

interface Harness {
  host: RuntimeHost
  plugins: PluginRuntime
  dataDir: string
  /** Stage → verify → activate a plugin named `name` carrying the fixture bundle. Does NOT load it. */
  install(name: string, opts?: { service?: VerifyReport['service']; bundle?: string }): Promise<void>
}

const cleanup: Array<() => void> = []

function setUp(opts?: {
  defaultTimeoutMs?: number
  maxTimeoutMs?: number
  startTimeoutMs?: number
  disposerTimeoutMs?: number
  errorBudget?: { failures: number; windowMs: number }
  /**
   * Wire `createPluginRuntime`'s `onLifecycle` to the host, so activating a
   * plugin loads it by itself (§4.2's Load row). OFF by default, and
   * deliberately: every other test in this file drives `load`/`unload`
   * explicitly, and an automatic load racing them would make `setupCalls`
   * mean two different things depending on timing.
   */
  lifecycle?: boolean
}): Harness {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  const db = opened.db
  const dataDir = mkdtempSync(join(tmpdir(), 'enkaku-runtime-host-'))
  const kv = createKvStore(db, dataDir, () => ({ maxValueBytes: 65_536, maxKeyLength: 256, maxEntriesPerNamespace: 1_000, maxEntriesPerDevice: 5_000 }))
  const registry = createScriptRegistry({ db, dataDir, devSlots: createDevSlotStore() })

  let report = serviceReport()
  let host: RuntimeHost | null = null
  const plugins = createPluginRuntime({
    db,
    dataDir,
    registry,
    kv,
    verify: async () => report,
    ...(opts?.lifecycle ? { onLifecycle: (event) => host?.handleLifecycle(event) } : {}),
  })
  host = createRuntimeHost({
    plugins,
    dataDir,
    store: kv,
    resolveStableId: () => null,
    log: silentLog(),
    // A test must not take the runner down to prove the unattributed path —
    // see `RuntimeHostDeps.unattributedRejection` for why production rethrows.
    unattributedRejection: 'report',
    ...opts,
  })

  cleanup.push(() => {
    host?.dispose()
    opened.sqlite.close()
    rmSync(dataDir, { recursive: true, force: true })
  })

  return {
    host,
    plugins,
    dataDir,
    async install(name, o) {
      report = serviceReport({ pluginId: name, ...(o?.service !== undefined ? { service: o.service } : {}) })
      if (o && 'service' in o && o.service === undefined) report = serviceReport({ pluginId: name, service: undefined })
      const staged = await plugins.stage({ name, version: '1.0.0', bundle: o?.bundle ?? FIXTURE_BUNDLE })
      await plugins.verify(staged.id)
      plugins.activate(staged.id)
    },
  }
}

beforeEach(() => {
  // One control object, shared by every loaded copy of the fixture module,
  // reset between tests so a previous test's mode cannot leak.
  ;(globalThis as { __enkakuRuntimeHostFixture?: RuntimeHostFixtureControl }).__enkakuRuntimeHostFixture = freshFixtureControl()
})

afterEach(() => {
  for (const fn of cleanup.splice(0)) fn()
})

// ---------------------------------------------------------------------------

describe('the manifest carries the service declaration, and only an active plugin that declares one is loaded', () => {
  test('a plugin declaring no service is never loaded, and the host reports nothing for it (criterion 1)', async () => {
    const h = setUp()
    await h.install('quiet', { service: undefined })
    expect(h.plugins.service('quiet')).toBeNull()
    const summary = await h.host.loadActive()
    expect(summary).toEqual({ loaded: 0, failed: 0 })
    expect(h.host.list()).toEqual([])
    expect(control().setupCalls).toBe(0)
  })

  test('`isolation: "process"` never reaches the host: the manifest reader refuses it too (criterion 7)', async () => {
    const h = setUp()
    // The row is written by hand through the fake verify, i.e. as if a build
    // that HAD a process host had written it. This build has not, and the read
    // path is a second refusal, not a re-run of the first.
    await h.install('procplug', { service: { permissions: [], isolation: 'process', listeners: [], events: [], webhooks: [], resetData: null } })
    expect(h.plugins.service('procplug')).toBeNull()
    expect(await h.host.loadActive()).toEqual({ loaded: 0, failed: 0 })
  })

  test('the schema ACCEPTS `process` — reserving the field is the point (criterion 7)', () => {
    expect(PluginServiceDeclarationSchema.parse({ isolation: 'process' })).toEqual({ permissions: [], isolation: 'process', listeners: [], events: [], webhooks: [], resetData: null })
    expect(unsupportedIsolationMessage('process')).toContain('reserved but not implemented')
    expect(unsupportedIsolationMessage('in-process')).toBeNull()
  })

  test('a real bundle, really verified, really loaded — the whole path end to end', async () => {
    const opened = openDb(':memory:')
    runMigrations(opened.db)
    const dataDir = mkdtempSync(join(tmpdir(), 'enkaku-runtime-host-e2e-'))
    const kv = createKvStore(opened.db, dataDir, () => ({ maxValueBytes: 65_536, maxKeyLength: 256, maxEntriesPerNamespace: 1_000, maxEntriesPerDevice: 5_000 }))
    const registry = createScriptRegistry({ db: opened.db, dataDir, devSlots: createDevSlotStore() })
    // No injected `verify` — this spawns the real verify child, which imports
    // the real bundle and reports the real `defineService` declaration.
    const plugins = createPluginRuntime({ db: opened.db, dataDir, registry, kv })
    const host = createRuntimeHost({ plugins, dataDir, store: kv, resolveStableId: () => null, log: silentLog(), unattributedRejection: 'report' })
    cleanup.push(() => {
      host.dispose()
      opened.sqlite.close()
      rmSync(dataDir, { recursive: true, force: true })
    })

    const staged = await plugins.stage({ name: 'fixture', version: '1.0.0', bundle: FIXTURE_BUNDLE })
    const report = await plugins.verify(staged.id)
    expect(report.ok).toBe(true)
    // `defineService({ permissions: ['device.list'] })`, round-tripped through
    // the verify child's IPC and the parent's independent re-validation.
    expect(report.service).toEqual(FIXTURE_SERVICE)
    plugins.activate(staged.id)

    expect(await host.loadActive()).toEqual({ loaded: 1, failed: 0 })
    expect(host.get('fixture')?.status).toBe('running')
    expect(host.get('fixture')?.permissions).toEqual(['device.list'])
  }, 20_000)
})

describe('`starting` is never worded as `running` (§3.2, §4.2)', () => {
  test('a service whose setup has not resolved is `starting`, serves nothing, and only then becomes `running`', async () => {
    const h = setUp()
    await h.install('fixture')
    let open: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      open = resolve
    })
    control().setupMode = 'gate'
    control().gate = gate

    const loading = h.host.load('fixture')
    // Yield enough for the import and the call into `setup`, and no further.
    await Bun.sleep(60)
    expect(h.host.get('fixture')?.status).toBe('starting')

    // The distinction is OBSERVABLE and not merely cosmetic: a call into a
    // starting service is refused with its own code, so a caller can tell
    // "not yet" from "broken".
    await expect(h.host.invoke('fixture', { what: 'probe' }, () => 'x')).rejects.toMatchObject({ code: 'E_PLUGIN_RUNTIME_STARTING' })

    open()
    await loading
    expect(h.host.get('fixture')?.status).toBe('running')
    expect(await h.host.invoke('fixture', { what: 'probe' }, () => 'x')).toBe('x')
  })

  test('a setup that throws leaves the service `failed` with the error verbatim, never `running`', async () => {
    const h = setUp()
    await h.install('fixture')
    control().setupMode = 'throw'
    await expect(h.host.load('fixture')).rejects.toThrow()
    const view = h.host.get('fixture')
    expect(view?.status).toBe('failed')
    expect(view?.lastError?.message).toContain('fixture: setup exploded')
  })

  test('a setup that never resolves is ended by the start deadline and lands on `failed`', async () => {
    const h = setUp({ startTimeoutMs: 120 })
    await h.install('fixture')
    control().setupMode = 'hang'
    await expect(h.host.load('fixture')).rejects.toMatchObject({ code: 'E_PLUGIN_HANDLER_TIMEOUT' })
    expect(h.host.get('fixture')?.status).toBe('failed')
    expect(h.host.get('fixture')?.counters.timeouts).toBe(1)
  })
})

describe('criterion 3 — a handler that throws, rejects, or overruns its deadline is contained and charged', () => {
  test('throws: the caller gets a coded failure and the plugin is charged', async () => {
    const h = setUp()
    await h.install('fixture')
    await h.host.load('fixture')
    control().handlerMode = 'throw'
    await expect(h.host.invoke('fixture', { what: 'handler' }, () => control().handler!())).rejects.toMatchObject({
      code: 'E_PLUGIN_HANDLER_FAILED',
    })
    const view = h.host.get('fixture')!
    expect(view.counters.failures).toBe(1)
    expect(view.lastError?.message).toContain('fixture: handler exploded')
    // Still running: one failure is a failure, not a verdict.
    expect(view.status).toBe('running')
  })

  test('rejects: the same, and the message is carried verbatim', async () => {
    const h = setUp()
    await h.install('fixture')
    await h.host.load('fixture')
    control().handlerMode = 'reject'
    await expect(h.host.invoke('fixture', { what: 'handler' }, () => control().handler!())).rejects.toThrow(/fixture: handler rejected/)
    expect(h.host.get('fixture')!.counters.failures).toBe(1)
  })

  test('hangs: the CALLER is freed at the deadline, the handler is only abandoned, and the host says so', async () => {
    const h = setUp({ defaultTimeoutMs: 80 })
    await h.install('fixture')
    await h.host.load('fixture')
    control().handlerMode = 'hang'
    await expect(h.host.invoke('fixture', { what: 'handler' }, () => control().handler!())).rejects.toMatchObject({
      code: 'E_PLUGIN_HANDLER_TIMEOUT',
    })
    const view = h.host.get('fixture')!
    expect(view.counters.timeouts).toBe(1)
    expect(view.counters.failures).toBe(1)
    // The handler is STILL PENDING. A promise cannot be cancelled, and the
    // host does not pretend otherwise — `lateSettlements` is the counter that
    // would move if it ever finished.
    expect(view.counters.lateSettlements).toBe(0)
  })

  test('a per-handler deadline is clamped by the host ceiling', async () => {
    const h = setUp({ defaultTimeoutMs: 10_000, maxTimeoutMs: 80 })
    await h.install('fixture')
    await h.host.load('fixture')
    control().handlerMode = 'hang'
    const started = Date.now()
    await expect(h.host.invoke('fixture', { what: 'handler', timeoutMs: 60_000 }, () => control().handler!())).rejects.toMatchObject({
      code: 'E_PLUGIN_HANDLER_TIMEOUT',
    })
    expect(Date.now() - started).toBeLessThan(3_000)
  })

  test('no other plugin is affected: a second service keeps running with untouched counters', async () => {
    const h = setUp()
    // A different bundle TEXT so the two plugins are two content-addressed
    // files — which is also what keeps stack-based attribution unambiguous.
    await h.install('bystander', { bundle: `${FIXTURE_BUNDLE}\n// bystander\n` })
    await h.install('fixture')
    await h.host.load('bystander')
    await h.host.load('fixture')

    control().handlerMode = 'throw'
    await expect(h.host.invoke('fixture', { what: 'handler' }, () => control().handler!())).rejects.toThrow()

    const bystander = h.host.get('bystander')!
    expect(bystander.status).toBe('running')
    expect(bystander.counters.failures).toBe(0)
    expect(bystander.lastError).toBeNull()
    expect(h.host.get('fixture')!.counters.failures).toBe(1)
  })

  test('a call into a plugin with no loaded service is refused rather than silently ignored', async () => {
    const h = setUp()
    await expect(h.host.invoke('nobody', { what: 'x' }, () => 1)).rejects.toMatchObject({ code: 'E_PLUGIN_RUNTIME_NOT_LOADED' })
  })
})

describe('criterion 5 — the error budget', () => {
  test('N failures in the window disable the service, surface the last error verbatim, and never retry', async () => {
    const h = setUp({ errorBudget: { failures: 3, windowMs: 60_000 } })
    await h.install('fixture')
    await h.host.load('fixture')
    control().handlerMode = 'throw'

    for (let i = 0; i < 3; i++) {
      await expect(h.host.invoke('fixture', { what: `handler#${i}` }, () => control().handler!())).rejects.toThrow()
    }
    // The budget's own unload is queued on the plugin's lock; let it drain.
    await Bun.sleep(30)

    const view = h.host.get('fixture')!
    expect(view.disabledByBudget).toBe(true)
    expect(view.status).toBe('failed')
    expect(view.lastError?.message).toContain('fixture: handler exploded')
    // Verbatim: the plugin's own text, not a summary the host wrote over it.
    expect(view.lastError?.message).not.toContain('the error budget')

    await expect(h.host.invoke('fixture', { what: 'after' }, () => 'x')).rejects.toMatchObject({ code: 'E_PLUGIN_RUNTIME_DISABLED' })
    // And it stays disabled — nothing schedules a retry.
    await Bun.sleep(120)
    expect(h.host.get('fixture')!.status).toBe('failed')
    expect(control().disposerCalls).toBe(1)
  })

  test('an explicit start is the finite retry — it clears the budget and runs again', async () => {
    const h = setUp({ errorBudget: { failures: 2, windowMs: 60_000 } })
    await h.install('fixture')
    await h.host.load('fixture')
    control().handlerMode = 'throw'
    for (let i = 0; i < 2; i++) {
      await expect(h.host.invoke('fixture', { what: 'handler' }, () => control().handler!())).rejects.toThrow()
    }
    await Bun.sleep(30)
    expect(h.host.get('fixture')!.disabledByBudget).toBe(true)

    control().handlerMode = 'ok'
    const view = await h.host.load('fixture')
    expect(view.status).toBe('running')
    expect(view.disabledByBudget).toBe(false)
    expect(await h.host.invoke('fixture', { what: 'handler' }, () => control().handler!())).toBe('ok')
  })
})

/**
 * Criterion 4 runs in a CHILD PROCESS, and that is not a convenience.
 *
 * `bun test` installs its own unhandled-rejection handling and never calls
 * `process.on('unhandledRejection')` listeners (measured on Bun 1.3.14: a
 * listener that only increments a counter never incremented it, while the
 * runner reported the rejection and failed the test). The one mechanism this
 * criterion turns on is therefore invisible inside the runner, so the whole
 * case is driven by `runtime-host.rejection-child.ts` — a real Bun process,
 * with a real host, a real plugin row and the real fixture bundle — and this
 * file asserts on the JSON it prints.
 */
describe('criterion 4 — a floating rejection is ATTRIBUTED, not merely logged', () => {
  interface ChildResult {
    survived: boolean
    views: Array<{ name: string; status: string; unhandledRejections: number; failures: number; lastError: string | null }>
  }

  const CHILD = join(import.meta.dir, 'runtime-host.rejection-child.ts')

  async function runCase(which: string): Promise<{ exitCode: number; stdout: string; result: ChildResult | null }> {
    const proc = Bun.spawn([process.execPath, CHILD, which], { stdout: 'pipe', stderr: 'pipe' })
    const stdout = await new Response(proc.stdout).text()
    await new Response(proc.stderr).text()
    const exitCode = await proc.exited
    const line = stdout.trim().split('\n').filter((l) => l.startsWith('{')).pop()
    return { exitCode, stdout, result: line ? (JSON.parse(line) as ChildResult) : null }
  }

  test('an error created inside the plugin`s own module is attributed by its bundle path, and the core survives', async () => {
    const { exitCode, result } = await runCase('module-stack')
    expect(exitCode).toBe(0)
    expect(result?.survived).toBe(true)
    const view = result!.views[0]!
    expect(view.name).toBe('fixture')
    expect(view.unhandledRejections).toBe(1)
    // Charged: an attributed rejection is a failure against the plugin's own
    // budget, not merely a log line.
    expect(view.failures).toBe(1)
    expect(view.lastError).toContain('fixture: a floating rejection')
    // Still `running` — one rejection is a charge, not a verdict.
    expect(view.status).toBe('running')
  }, 30_000)

  test('an error the CORE built, floated through a `.then()` chain, is attributed by the stamp it carries', async () => {
    const { exitCode, result } = await runCase('tagged-reason')
    expect(exitCode).toBe(0)
    const view = result!.views[0]!
    expect(view.unhandledRejections).toBe(1)
    expect(view.lastError).toContain('capability broker is not available')
  }, 30_000)

  test('a non-Error rejection is reported UNATTRIBUTED and charged to nobody — the honest gap, stated', async () => {
    const { exitCode, result } = await runCase('non-error')
    expect(exitCode).toBe(0)
    // No stack, no stamp, no owned promise. Blaming "the only plugin loaded"
    // is precisely the guess this criterion exists to forbid.
    expect(result!.views[0]!.unhandledRejections).toBe(0)
    expect(result!.views[0]!.failures).toBe(0)
  }, 30_000)

  test('two plugins sharing one bundle file make a stack ambiguous, and an ambiguity is not resolved by picking one', async () => {
    const { exitCode, result } = await runCase('ambiguous')
    expect(exitCode).toBe(0)
    expect(result!.views.map((v) => v.unhandledRejections)).toEqual([0, 0])
  }, 30_000)

  test('the production default rethrows an unattributable rejection, so a CORE bug still kills the process exactly as it did before', async () => {
    const { exitCode, result } = await runCase('unattributed-rethrow')
    // Installing a handler must not make the core quieter about its own bugs:
    // with no handler at all, Bun prints the rejection and exits 1.
    expect(exitCode).toBe(1)
    expect(result).toBeNull()
  }, 30_000)
})

describe('unload — disposers, and what `stopping` means', () => {
  test('every onStop disposer runs on unload, and the service ends `stopped`', async () => {
    const h = setUp()
    await h.install('fixture')
    await h.host.load('fixture')
    await h.host.unload('fixture', 'a test asked')
    expect(control().disposerCalls).toBe(1)
    expect(h.host.get('fixture')!.status).toBe('stopped')
  })

  test('a disposer that throws is caught, and the service still reaches `stopped`', async () => {
    const h = setUp()
    await h.install('fixture')
    await h.host.load('fixture')
    control().disposerMode = 'throw'
    await h.host.unload('fixture', 'a test asked')
    expect(h.host.get('fixture')!.status).toBe('stopped')
  })

  test('a disposer that never finishes leaves the service `stopping`, and the core force-closes nothing', async () => {
    const h = setUp({ disposerTimeoutMs: 80 })
    await h.install('fixture')
    await h.host.load('fixture')
    control().disposerMode = 'hang'
    await h.host.unload('fixture', 'a test asked')
    // Not `stopped`: the host does not know whether the plugin let go, and
    // saying `stopped` would be a claim it cannot support (§3.3).
    expect(h.host.get('fixture')!.status).toBe('stopping')
  })

  test('a reload tears the old instance down before the new one starts, and the old context can no longer register anything', async () => {
    const h = setUp()
    await h.install('fixture')
    await h.host.load('fixture')
    await h.host.reload('fixture')
    expect(control().setupCalls).toBe(2)
    expect(control().disposerCalls).toBe(1)
    const view = h.host.get('fixture')!
    expect(view.starts).toBe(2)
    expect(view.status).toBe('running')
    // Exactly one disposer registered, i.e. the new instance's — the old one's
    // was consumed by the unload, not carried over.
    expect(view.counters.disposers).toBe(1)
  })

  test('unloadAll runs every plugin`s disposers (what `stop()` calls at shutdown)', async () => {
    const h = setUp()
    await h.install('bystander', { bundle: `${FIXTURE_BUNDLE}\n// bystander\n` })
    await h.install('fixture')
    await h.host.load('bystander')
    await h.host.load('fixture')
    await h.host.unloadAll('the core is shutting down')
    expect(control().disposerCalls).toBe(2)
    expect(h.host.list().every((v) => v.status === 'stopped')).toBe(true)
  })
})

describe('the plugin lifecycle drives the host (§4.2`s Load and Unload rows)', () => {
  test('activate loads, disable unloads', async () => {
    const h = setUp({ lifecycle: true })
    // `install` activates, and the registry's `onLifecycle` is wired to the
    // host, so the load happens without anybody calling `load` here.
    await h.install('fixture')
    await Bun.sleep(120)
    expect(h.host.get('fixture')?.status).toBe('running')

    h.plugins.disable('fixture')
    await Bun.sleep(120)
    expect(h.host.get('fixture')?.status).toBe('stopped')
    expect(control().disposerCalls).toBe(1)
  })
})

/**
 * **H2** — *"an in-process plugin handler wrapped in try/catch + a deadline
 * survives 10 000 invocations of a deliberately-misbehaving fixture without
 * leaking memory or handles."*
 *
 * Gated behind `ENKAKU_TEST_H2=1`, the same discipline `ENKAKU_TEST_DEVICE=1`
 * applies to a device-dependent test: it takes tens of seconds, and CLAUDE.md's
 * rule about not cooking the maintainer's machine applies to a probe as much as
 * to a suite. Its measured numbers are recorded in plan 109 §0.2, whether or
 * not they are comfortable.
 */
describe.skipIf(process.env.ENKAKU_TEST_H2 !== '1')('H2 — 10 000 invocations of a misbehaving fixture', () => {
  test('memory and handles do not grow across 10 000 throw/reject/hang invocations', async () => {
    // The budget is set past the run so the fixture keeps being invoked; the
    // budget itself is proven above, and what this probe measures is leakage.
    const h = setUp({ defaultTimeoutMs: 5, errorBudget: { failures: 10_000_000, windowMs: 60_000 } })
    await h.install('fixture')
    await h.host.load('fixture')

    const modes = ['throw', 'reject', 'hang'] as const
    const sample = () => {
      Bun.gc(true)
      return { rss: process.memoryUsage.rss(), heap: process.memoryUsage().heapUsed }
    }

    // Warm up, so the baseline is not measuring first-run allocation.
    for (let i = 0; i < 300; i++) {
      control().handlerMode = modes[i % 3]!
      await h.host.invoke('fixture', { what: 'h2' }, () => control().handler!()).catch(() => {})
    }
    const before = sample()

    for (let i = 0; i < 10_000; i++) {
      control().handlerMode = modes[i % 3]!
      await h.host.invoke('fixture', { what: 'h2' }, () => control().handler!()).catch(() => {})
    }
    const after = sample()

    const view = h.host.get('fixture')!
    expect(view.counters.invocations).toBeGreaterThanOrEqual(10_000)
    expect(view.counters.failures).toBeGreaterThanOrEqual(10_000)
    expect(view.status).toBe('running')

    // Reported rather than merely asserted: the plan wants the number.
    console.error(
      `H2: rss ${(before.rss / 1e6).toFixed(1)}MB → ${(after.rss / 1e6).toFixed(1)}MB, ` +
        `heapUsed ${(before.heap / 1e6).toFixed(1)}MB → ${(after.heap / 1e6).toFixed(1)}MB, ` +
        `invocations ${view.counters.invocations}, failures ${view.counters.failures}, timeouts ${view.counters.timeouts}, late ${view.counters.lateSettlements}`,
    )
    // A generous bound: what a LEAK looks like here is linear growth in the
    // ~3 333 abandoned hung handlers, each holding a closure and an
    // AbortController. 64 MiB over 10 000 invocations would be ~6 KiB each,
    // far past anything the design retains on purpose.
    expect(after.heap - before.heap).toBeLessThan(64 * 1024 * 1024)
  }, 300_000)
})
