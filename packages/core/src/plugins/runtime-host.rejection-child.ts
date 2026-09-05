import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, runMigrations } from '../db'
import { createKvStore } from '../kv/store'
import { createScriptRegistry } from '../scripts/registry'
import type { Logger } from '../util/logger'
import { createDevSlotStore } from './dev-slots'
import { createPluginRuntime } from './runtime'
import { createRuntimeHost } from './runtime-host'
import type { RuntimeHostFixtureControl } from './runtime-host.fixture'
import type { VerifyReport } from './verify-child'

/**
 * Plan 109 (M74), step 109.2 — **criterion 4's proof, and why it cannot live
 * in `runtime-host.test.ts`.**
 *
 * `bun test` installs its own unhandled-rejection handling and does NOT call
 * `process.on('unhandledRejection')` listeners: a floating rejection inside a
 * test is reported by the runner and fails the test, and the listener never
 * fires (measured on Bun 1.3.14, 2026-08-17 — a one-line probe with a listener
 * that only increments a counter never incremented it). So the ONE mechanism
 * criterion 4 turns on is invisible to the test runner, and a test written
 * inside it would either fail for the wrong reason or quietly assert nothing.
 *
 * This file is that test's child process: an ordinary Bun program with a real
 * database, a real plugin row, the real host, and the real fixture bundle. It
 * runs one case, prints one JSON line on stdout, and exits. The parent asserts
 * on the JSON.
 *
 * It is deliberately NOT a `*.test.ts` file, so no runner ever picks it up.
 *
 *     bun runtime-host.rejection-child.ts <case>
 */

type Case =
  /** An Error created inside the plugin's own module — attribution tier 3 (the bundle path in the stack). */
  | 'module-stack'
  /** An error the CORE built, floated by the plugin through two `.then()` hops — tier 2 (the stamp on the reason). */
  | 'tagged-reason'
  /** A non-Error rejection from inside the plugin — no stack, no stamp: the honest gap. */
  | 'non-error'
  /** Two plugins loaded from one content-addressed bundle: the stack names both, so it names neither. */
  | 'ambiguous'
  /** The production default: an unattributable rejection is rethrown, so the process dies exactly as it would with no handler installed. */
  | 'unattributed-rethrow'

function silentLog(): Logger {
  const self: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => self }
  return self
}

function control(): RuntimeHostFixtureControl {
  const existing = (globalThis as { __enkakuRuntimeHostFixture?: RuntimeHostFixtureControl }).__enkakuRuntimeHostFixture
  if (!existing) throw new Error('the fixture module did not install its control object')
  return existing
}

async function main(): Promise<void> {
  const which = (process.argv[2] ?? '') as Case

  const fixturePath = join(import.meta.dir, 'runtime-host.fixture.ts')
  const built = await Bun.build({ entrypoints: [fixturePath], target: 'bun', format: 'esm' })
  if (!built.success) throw new Error(`fixture bundle failed: ${built.logs.map(String).join('; ')}`)
  const bundle = await built.outputs[0]!.text()

  const opened = openDb(':memory:')
  runMigrations(opened.db)
  const dataDir = mkdtempSync(join(tmpdir(), 'enkaku-rejection-child-'))
  const kv = createKvStore(opened.db, dataDir, () => ({
    maxValueBytes: 65_536,
    maxKeyLength: 256,
    maxEntriesPerNamespace: 1_000,
    maxEntriesPerDevice: 5_000,
  }))
  const registry = createScriptRegistry({ db: opened.db, dataDir, devSlots: createDevSlotStore() })
  const report: VerifyReport = {
    ok: true,
    pluginId: 'fixture',
    version: '1.0.0',
    scripts: [{ id: 'noop', paramsSchema: { type: 'object' }, runtime: null }],
    service: {
      permissions: ['device.list'],
      isolation: 'in-process',
      // Mirrors `runtime-host.fixture.ts`'s own declaration (steps 109.4/109.5)
      // — the fixture's `setup` calls `ctx.onEvent('device.status')`, and the
      // host refuses a subscription the MANIFEST does not declare.
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
    },
    resetPackages: [],
  }
  const plugins = createPluginRuntime({ db: opened.db, dataDir, registry, kv, verify: async () => report })
  const host = createRuntimeHost({
    plugins,
    dataDir,
    store: kv,
    resolveStableId: () => null,
    log: silentLog(),
    // Every case but the last one uses `'report'`, so the child can print its
    // findings; the last one is the production default and is expected to kill
    // this process, which is the whole assertion.
    unattributedRejection: which === 'unattributed-rethrow' ? 'rethrow' : 'report',
  })

  const install = async (name: string, text: string): Promise<void> => {
    const staged = await plugins.stage({ name, version: '1.0.0', bundle: text })
    await plugins.verify(staged.id)
    plugins.activate(staged.id)
    await host.load(name)
  }

  if (which === 'ambiguous') {
    // Byte-identical bundles are ONE file in the content-addressed cache, so
    // one stack frame names two plugins.
    await install('twin-a', bundle)
    await install('twin-b', bundle)
  } else {
    await install('fixture', bundle)
  }

  switch (which) {
    case 'module-stack':
    case 'ambiguous':
      control().float!('error')
      break
    case 'tagged-reason':
      control().floatPortRejection!()
      break
    case 'non-error':
    case 'unattributed-rethrow':
      control().float!('string')
      break
    default:
      throw new Error(`unknown case: ${which}`)
  }

  /**
   * Wait for the counter to MOVE, not for a fixed 150 ms.
   *
   * The handler that attributes a floating rejection runs on its own turn of
   * the loop, and a fixed sleep only asks "has enough wall clock passed on
   * the machine I was written on". On a CI runner working through 5 599 tests
   * it had not: the counter read zero and the test failed there while passing
   * on every developer's machine (2026-09-05).
   *
   * The ceiling is what the `non-error` case needs — it asserts the counter
   * NEVER moves, so there is nothing to poll for and it pays the full wait
   * once. Twenty times the old sleep, and still a fifth of the test's own
   * 30-second budget.
   */
  const deadline = Date.now() + 3_000
  while (Date.now() < deadline) {
    const seen = host.list().some((v) => v.counters.unhandledRejections > 0 || v.counters.failures > 0)
    if (seen) break
    await Bun.sleep(10)
  }
  // Reached only when the process survived — which is itself the finding for
  // every case except `unattributed-rethrow`.
  const views = host.list().map((v) => ({
    name: v.name,
    status: v.status,
    unhandledRejections: v.counters.unhandledRejections,
    failures: v.counters.failures,
    lastError: v.lastError?.message ?? null,
  }))
  /**
   * Hand the line over with an AWAITED write, never `console.log`.
   *
   * stdout here is a pipe (the parent spawns with `stdout: 'pipe'`), and a
   * write to a pipe is buffered: `console.log` queues the bytes and returns.
   * The `process.exit(0)` below then ends the process at once and discards
   * whatever has not drained — so on a loaded runner the parent reads no JSON
   * line at all, `result` is null, and the case fails in about the time a
   * SUCCESSFUL run takes (405 ms and 551 ms observed on CI, against a ~640 ms
   * local baseline; a genuine timeout would have taken the loop's full 3 s).
   * The finding was never wrong — it just never arrived.
   *
   * `Bun.write` resolves once the bytes are handed to the pipe, which is the
   * one thing this process exists to deliver.
   */
  await Bun.write(Bun.stdout, `${JSON.stringify({ survived: true, views })}\n`)
  host.dispose()
  opened.sqlite.close()
  rmSync(dataDir, { recursive: true, force: true })
  process.exit(0)
}

void main()
