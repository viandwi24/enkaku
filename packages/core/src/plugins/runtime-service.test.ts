import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ServerWebSocket } from 'bun'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  PluginListenerSchema,
  PluginServiceDeclarationSchema,
  SERVER_MESSAGE_TYPES,
  unknownPluginEventTypesMessage,
  type ServerMessage,
} from '@enkaku/protocol'
import { defineService } from '@enkaku/sdk'
import { isPortFree } from '@enkaku/session'
import { openDb, runMigrations } from '../db'
import { createKvStore } from '../kv/store'
import { createScriptRegistry } from '../scripts/registry'
import { WsHub } from '../server/ws'
import type { Logger } from '../util/logger'
import { createDevSlotStore } from './dev-slots'
import { createPluginRuntime, type PluginRuntime } from './runtime'
import { FIXTURE_BUNDLE } from './runtime-host.bundle'
import { createRuntimeHost, type RuntimeHost } from './runtime-host'
import { freshFixtureControl, type RuntimeHostFixtureControl } from './runtime-host.fixture'
import type { VerifyReport } from './verify-child'

/**
 * Plan 109 (M74 — the plugin runtime), steps **109.4 (listeners)** and
 * **109.5 (events)**, against the same really-installed fixture step 109.2
 * uses: bundled by `Bun.build`, staged, verified, activated, loaded by the
 * real host from the real content-addressed bundle cache.
 *
 * Criteria under test: 8 (`ctx.onStop` runs on every teardown path; two
 * consecutive reloads leave the plugin's own port bindable), 9 (a plugin that
 * fails to release a reported port gets ONE warn and status `stopping`, and
 * **the core never force-closes a socket it does not own**), 17 (a UDP
 * listener is accepted; `deviceReachable: true` on one is not), and 12 (an
 * event handler cannot veto, delay or modify a broadcast).
 *
 * ## Two of these criteria are ABSENCE claims, and an absence needs two controls
 *
 * Plan 109 §9 Q15 records what happens without them: step 109.1's criterion-11
 * test fingerprinted a registry shape that did not exist anywhere in the
 * workspace, inside a test whose whole job was proving an absence, so it could
 * never have fired. The rule it left behind — *a test that proves an absence
 * needs two controls: that the thing it looks for is real, and that it would
 * be seen if it were there* — is applied here twice, explicitly, and each
 * control is labelled where it appears:
 *
 * | absence claim | control 1 — the thing is real | control 2 — it would be seen |
 * |---|---|---|
 * | criterion 9: "the core never force-closes" | the leaked socket is a genuine `Bun.listen` whose port is bind-tested as occupied *before* and *after* the unload | the test closes that same socket itself, and the same bind test flips to free |
 * | criterion 12: "changes nothing about the broadcast" | the blocking handler really is entered and really burns its 150 ms | an inline observer burning the same 150 ms *does* delay the same measurement, by ~10× the assertion's own bound |
 */


/** The declaration the fixture bundle really carries — see `runtime-host.test.ts` on why the fake verify must match it. */
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

function control(): RuntimeHostFixtureControl {
  const existing = (globalThis as { __enkakuRuntimeHostFixture?: RuntimeHostFixtureControl }).__enkakuRuntimeHostFixture
  if (!existing) throw new Error('the fixture has not been loaded yet')
  return existing
}

interface RecordingLogger extends Logger {
  warns: string[]
  errors: string[]
}

/** Quiet, but keeps the lines criterion 9 is about — the warn IS the deliverable there. */
function recordingLog(): RecordingLogger {
  const warns: string[] = []
  const errors: string[] = []
  const self: RecordingLogger = {
    warns,
    errors,
    debug: () => {},
    info: () => {},
    warn: (msg: string) => {
      warns.push(msg)
    },
    error: (msg: string) => {
      errors.push(msg)
    },
    child: () => self,
  }
  return self
}

/** A port nothing holds right now. Ephemeral-bind-then-release: the same trick `PortAllocator` would use, and honest about being a snapshot. */
function freePort(): number {
  const probe = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } })
  const port = probe.port
  probe.stop(true)
  return port
}

interface Harness {
  host: RuntimeHost
  plugins: PluginRuntime
  log: RecordingLogger
  install(name: string, service?: VerifyReport['service']): Promise<void>
}

const cleanup: Array<() => void> = []

function setUp(opts?: {
  disposerTimeoutMs?: number
  eventTimeoutMs?: number
  errorBudget?: { failures: number; windowMs: number }
  scheduleEvent?: (fn: () => void) => void
}): Harness {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  const db = opened.db
  const dataDir = mkdtempSync(join(tmpdir(), 'enkaku-runtime-service-'))
  const kv = createKvStore(db, dataDir, () => ({ maxValueBytes: 65_536, maxKeyLength: 256, maxEntriesPerNamespace: 1_000, maxEntriesPerDevice: 5_000 }))
  const registry = createScriptRegistry({ db, dataDir, devSlots: createDevSlotStore() })
  const log = recordingLog()

  let report: VerifyReport = { ok: true, pluginId: 'fixture', version: '1.0.0', scripts: [], service: FIXTURE_SERVICE, resetPackages: [] }
  const plugins = createPluginRuntime({ db, dataDir, registry, kv, verify: async () => report })
  const host = createRuntimeHost({
    plugins,
    dataDir,
    store: kv,
    resolveStableId: () => null,
    log,
    unattributedRejection: 'report',
    ...opts,
  })

  cleanup.push(() => {
    host.dispose()
    opened.sqlite.close()
    rmSync(dataDir, { recursive: true, force: true })
  })

  return {
    host,
    plugins,
    log,
    async install(name, service) {
      report = {
        ok: true,
        pluginId: name,
        version: '1.0.0',
        scripts: [],
        service: service ?? FIXTURE_SERVICE,
        resetPackages: [],
      }
      const staged = await plugins.stage({ name, version: '1.0.0', bundle: FIXTURE_BUNDLE })
      await plugins.verify(staged.id)
      plugins.activate(staged.id)
    },
  }
}

beforeEach(() => {
  ;(globalThis as { __enkakuRuntimeHostFixture?: RuntimeHostFixtureControl }).__enkakuRuntimeHostFixture = freshFixtureControl()
})

afterEach(() => {
  // A leaked socket belongs to the FIXTURE, so the test that created it is the
  // only thing that can close it. Doing it here too means one failing
  // assertion cannot leave a port bound for the rest of the file.
  control().leakedServer?.stop(true)
  for (const fn of cleanup.splice(0)) fn()
})

// ---------------------------------------------------------------------------
// 109.4 — listeners
// ---------------------------------------------------------------------------

describe('ctx.isPortFree — the bind test, lent (§3.3, R5)', () => {
  test('it is the primitive PortAllocator already uses, not a second implementation', async () => {
    const port = freePort()
    expect(await isPortFree(port)).toBe(true)
    const held = Bun.listen({ hostname: '127.0.0.1', port, socket: { data() {} } })
    try {
      expect(await isPortFree(port)).toBe(false)
    } finally {
      held.stop(true)
    }
    expect(await isPortFree(port)).toBe(true)
  })

  test('a plugin reaches it through its own context, and gets the same answers', async () => {
    const h = setUp()
    await h.install('fixture')
    await h.host.load('fixture')
    const port = freePort()
    expect(await control().isPortFree!(port)).toBe(true)
    const held = Bun.listen({ hostname: '127.0.0.1', port, socket: { data() {} } })
    try {
      expect(await control().isPortFree!(port)).toBe(false)
    } finally {
      held.stop(true)
    }
  })

  test('it refuses a port number that is not one, rather than answering about it', async () => {
    const h = setUp()
    await h.install('fixture')
    await h.host.load('fixture')
    await expect(control().isPortFree!(70_000)).rejects.toMatchObject({ code: 'E_BAD_REQUEST' })
  })
})

describe('criterion 8 — onStop runs on every teardown path, and two reloads leave the port bindable', () => {
  test('load, reload, reload, unload: the plugin`s own port survives every cycle', async () => {
    const h = setUp()
    await h.install('fixture')
    const port = freePort()
    control().listenerMode = 'report'
    control().listenerPort = port

    await h.host.load('fixture')
    expect(h.host.get('fixture')!.status).toBe('running')
    expect(h.host.get('fixture')!.listeners).toEqual([{ id: 'probe', port, proto: 'tcp', deviceReachable: false }])
    // Control: the listener is REAL. Every "the port came back" assertion below
    // is worthless if the fixture never bound anything.
    expect(await isPortFree(port)).toBe(false)

    // Reload #1 — the old instance must let go BEFORE the new one binds, or
    // the second `Bun.listen` on the same port throws and `setup` fails.
    const first = await h.host.reload('fixture')
    expect(first.status).toBe('running')
    expect(control().setupCalls).toBe(2)
    expect(control().disposerCalls).toBe(1)

    // Reload #2 — "reload twice in a row", verbatim from the criterion.
    const second = await h.host.reload('fixture')
    expect(second.status).toBe('running')
    expect(control().setupCalls).toBe(3)
    expect(control().disposerCalls).toBe(2)
    // Still exactly one reported listener: the previous instances' reports were
    // cleared with them, rather than accumulating into a list of ports nobody
    // is serving.
    expect(second.listeners).toEqual([{ id: 'probe', port, proto: 'tcp', deviceReachable: false }])
    expect(await isPortFree(port)).toBe(false)

    await h.host.unload('fixture', 'a test asked')
    expect(h.host.get('fixture')!.status).toBe('stopped')
    expect(control().disposerCalls).toBe(3)
    expect(h.host.get('fixture')!.listeners).toEqual([])
    // And now it is genuinely free — the whole point of the criterion.
    expect(await isPortFree(port)).toBe(true)
  }, 20_000)

  test('a setup that binds a port and then throws still leaves it released', async () => {
    const h = setUp()
    await h.install('fixture')
    const port = freePort()
    control().listenerMode = 'report'
    control().listenerPort = port
    // The fixture binds, registers its disposer, reports — and the disposer
    // registered before the throw is what has to run.
    control().disposerMode = 'ok'
    await h.host.load('fixture')
    expect(await isPortFree(port)).toBe(false)

    control().setupMode = 'throw'
    await expect(h.host.reload('fixture')).rejects.toThrow(/setup exploded/)
    expect(h.host.get('fixture')!.status).toBe('failed')
    expect(await isPortFree(port)).toBe(true)
  })

  test('unloadAll — what shutdown calls — releases it too', async () => {
    const h = setUp()
    await h.install('fixture')
    const port = freePort()
    control().listenerMode = 'report'
    control().listenerPort = port
    await h.host.load('fixture')
    await h.host.unloadAll('the core is shutting down')
    expect(await isPortFree(port)).toBe(true)
  })
})

describe('criterion 9 — a port the plugin never released', () => {
  test('one warn naming the plugin and the port, status `stopping`, and the socket is left alone', async () => {
    const h = setUp()
    await h.install('fixture')
    const port = freePort()
    control().listenerMode = 'leak'
    control().listenerPort = port
    await h.host.load('fixture')
    // CONTROL 1 — the thing this test looks for is real: a genuine bound
    // socket, not a bookkeeping entry.
    expect(await isPortFree(port)).toBe(false)

    await h.host.unload('fixture', 'a test asked')

    // `stopping`, not `stopped`: the host does not know whether the plugin let
    // go, and every disposer it DID have finished, so this status can only
    // have come from the bind test.
    expect(h.host.get('fixture')!.status).toBe('stopping')

    const naming = h.log.warns.filter((w) => w.includes('fixture') && w.includes(String(port)))
    expect(naming).toHaveLength(1)
    expect(naming[0]).toContain('STILL BOUND')
    expect(naming[0]).toContain('does not force-close')

    // THE ABSENCE CLAIM: the core did not close it. The port is still occupied
    // after a full unload, which is only true if nothing closed the socket.
    expect(await isPortFree(port)).toBe(false)

    // CONTROL 2 — would a close be SEEN if there were one? Close it here, with
    // the same socket and the same assertion, and watch the answer flip. If
    // the bind test could not detect a close, control 1's reading above would
    // be vacuous.
    control().leakedServer!.stop(true)
    control().leakedServer = undefined
    expect(await isPortFree(port)).toBe(true)
  })

  test('the host is never given a socket to close: a reported listener is four scalars', async () => {
    const h = setUp()
    await h.install('fixture')
    const port = freePort()
    control().listenerMode = 'leak'
    control().listenerPort = port
    await h.host.load('fixture')

    const [reported] = h.host.get('fixture')!.listeners
    expect(reported).toBeDefined()
    expect(Object.keys(reported!).sort()).toEqual(['deviceReachable', 'id', 'port', 'proto'])

    /**
     * Does anything reachable from `value` look like something the core could
     * close? `Reflect.get` rather than `Object.values`, because a Bun listener
     * keeps `stop` on its PROTOTYPE — an own-keys walk finds nothing on one and
     * would have made this control pass for the wrong reason.
     */
    const CLOSERS = ['stop', 'close', 'end', 'unref', 'terminate']
    const looksClosable = (value: object): boolean => CLOSERS.some((member) => typeof Reflect.get(value, member) === 'function')
    const findsAHandle = (value: unknown, depth = 0): boolean => {
      if (depth > 4 || typeof value !== 'object' || value === null) return false
      if (depth > 0 && looksClosable(value)) return true
      for (const nested of Object.values(value)) {
        if (typeof nested === 'function') return true
        if (findsAHandle(nested, depth + 1)) return true
      }
      return false
    }

    // CONTROL — the walk WOULD find one. `Bun.listen`'s own listener is the
    // real shape a plugin might have passed along by mistake, and it is
    // exactly what `ReportedListenerSchema` strips.
    expect(findsAHandle({ id: 'planted', port, socket: control().leakedServer })).toBe(true)
    // The claim itself.
    expect(findsAHandle(reported)).toBe(false)

    control().leakedServer!.stop(true)
    control().leakedServer = undefined
  })

  test('a plugin that reports nothing gets no bind test and no warn — reporting is what makes a port visible, not what makes it exist', async () => {
    const h = setUp()
    await h.install('fixture')
    const port = freePort()
    // Bound and leaked, but NEVER reported: the fixture's `leak` mode reports,
    // so this one binds by hand outside the plugin entirely.
    const unreported = Bun.listen({ hostname: '127.0.0.1', port, socket: { data() {} } })
    try {
      await h.host.load('fixture')
      await h.host.unload('fixture', 'a test asked')
      // `stopped`, and silent. The core knows nothing about a socket nobody
      // told it about, and inventing a scan of every port on the machine to
      // find one is not a thing a farm gets to do.
      expect(h.host.get('fixture')!.status).toBe('stopped')
      expect(h.log.warns.filter((w) => w.includes(String(port)))).toHaveLength(0)
    } finally {
      unreported.stop(true)
    }
  })
})

describe('criterion 17 — a UDP listener is accepted; claiming a device can dial it is not', () => {
  test('the schema takes a UDP listener', () => {
    const parsed = PluginListenerSchema.safeParse({ id: 'udp', proto: 'udp' })
    expect(parsed.success).toBe(true)
    expect(parsed.success && parsed.data.deviceReachable).toBe(false)
  })

  test('`deviceReachable: true` on it is refused, naming adb reverse`s TCP-only limit', () => {
    const parsed = PluginListenerSchema.safeParse({ id: 'udp', proto: 'udp', deviceReachable: true })
    expect(parsed.success).toBe(false)
    const message = parsed.success ? '' : parsed.error.issues.map((i) => i.message).join(' ')
    expect(message).toContain('adb reverse')
    expect(message).toContain('no UDP form')
  })

  test('the same refusal at VERIFY: a manifest declaring one does not parse', () => {
    // `PluginServiceDeclarationSchema` is what `verify-child.ts` re-validates
    // the child's report with, so failing here IS failing verification.
    const parsed = PluginServiceDeclarationSchema.safeParse({
      permissions: [],
      listeners: [{ id: 'udp', proto: 'udp', deviceReachable: true }],
    })
    expect(parsed.success).toBe(false)
    // …and TCP is fine, so this is not simply "listeners are refused".
    expect(PluginServiceDeclarationSchema.safeParse({ listeners: [{ id: 'tcp', proto: 'tcp', deviceReachable: true }] }).success).toBe(true)
  })

  test('the same refusal on the author`s own machine, at import time', () => {
    expect(() => defineService({ listeners: [{ id: 'udp', proto: 'udp', deviceReachable: true }], setup: () => {} })).toThrow(/adb reverse/)
    expect(() => defineService({ listeners: [{ id: 'udp', proto: 'udp' }], setup: () => {} })).not.toThrow()
  })

  test('and at run time: ctx.reportListener refuses the CLAIM, never the socket', async () => {
    const h = setUp()
    await h.install('fixture')
    control().listenerMode = 'udp-reachable'
    await h.host.load('fixture')
    // `setup` completed — the refusal is about the report, and a plugin that
    // catches it keeps running.
    expect(h.host.get('fixture')!.status).toBe('running')
    expect(control().reportError).toContain('adb reverse')
    // Nothing was recorded: a refused claim is not a quietly-downgraded one.
    expect(h.host.get('fixture')!.listeners).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 109.5 — events
// ---------------------------------------------------------------------------

/** A `device.status` broadcast — the real message the core sends when a device connects or disconnects. */
function deviceStatus(status: 'online' | 'offline'): ServerMessage {
  return { type: 'device.status', payload: { id: 'dev-1', stableId: 'stable-1', status } }
}

interface HubHarness {
  hub: WsHub
  /** Every frame each connected client received. */
  frames: string[][]
  detach(): void
}

/** A real `WsHub` with two connected clients and the plugin tap attached, exactly as `daemon.ts` wires it. */
function attachHub(host: RuntimeHost): HubHarness {
  const hub = new WsHub(recordingLog())
  const frames: string[][] = [[], []]
  for (const index of [0, 1]) {
    const ws = {
      send: (data: string) => {
        frames[index]!.push(data)
      },
    } as unknown as ServerWebSocket<unknown>
    hub.handlers.open?.(ws)
  }
  const detach = hub.addObserver((msg) => host.observeEvent(msg))
  return { hub, frames, detach }
}

describe('criterion 12 — an event handler cannot veto, delay, or modify a broadcast', () => {
  test('a handler that burns 150ms synchronously delays the broadcast by nothing at all', async () => {
    const h = setUp()
    await h.install('fixture')
    control().eventMode = 'block'
    control().blockMs = 150
    await h.host.load('fixture')
    const hub = attachHub(h.host)

    // A second, non-plugin consumer of the same fan-out: the core's own path.
    let coreObserverRan = false
    hub.hub.addObserver(() => {
      coreObserverRan = true
    })

    const started = Bun.nanoseconds()
    hub.hub.broadcast(deviceStatus('online'))
    const broadcastMs = (Bun.nanoseconds() - started) / 1e6
    const returnedAt = Date.now()

    // Nothing was delayed…
    expect(broadcastMs).toBeLessThan(50)
    // …nothing was vetoed: both clients have the frame, byte for byte…
    expect(hub.frames[0]).toHaveLength(1)
    expect(hub.frames[1]).toEqual(hub.frames[0]!)
    expect(JSON.parse(hub.frames[0]![0]!)).toEqual({ type: 'device.status', payload: { id: 'dev-1', stableId: 'stable-1', status: 'online' } })
    // …and the core's own path ran, inside the broadcast, before any of this.
    expect(coreObserverRan).toBe(true)
    // The handler had not even STARTED when `broadcast` returned. This is the
    // assertion that separates "detached" from "merely fast".
    expect(control().eventsSeen).toEqual([])

    await Bun.sleep(400)
    // CONTROL 1 — the blocking handler is real: it ran, and it really burned
    // its 150 ms. A handler that silently did nothing would satisfy every
    // timing assertion above for the wrong reason.
    expect(control().eventsSeen).toEqual(['device.status'])
    expect(control().eventEnteredAt[0]!).toBeGreaterThanOrEqual(returnedAt)
    expect(h.host.get('fixture')!.counters.eventDeliveries).toBe(1)
  }, 20_000)

  test('CONTROL 2 — the same measurement DOES see a delay when one exists', async () => {
    const h = setUp()
    await h.install('fixture')
    await h.host.load('fixture')
    const hub = attachHub(h.host)
    // An observer that burns the same 150 ms INLINE. The plugin tap is
    // detached; this one is not, and it is the only difference between the two
    // measurements. If this assertion failed, the "< 50 ms" above would prove
    // nothing about detachment — it would only prove the clock was not looking.
    hub.hub.addObserver(() => {
      const until = Date.now() + 150
      while (Date.now() < until) {
        // spin
      }
    })

    const started = Bun.nanoseconds()
    hub.hub.broadcast(deviceStatus('online'))
    const broadcastMs = (Bun.nanoseconds() - started) / 1e6
    expect(broadcastMs).toBeGreaterThan(140)
  }, 20_000)

  test('CONTROL 2b — and the PLUGIN path would delay it too, if dispatch were not detached', async () => {
    // The same fixture, the same 150 ms burn, the same measurement — with the
    // one thing that makes the claim true swapped out for the obvious
    // implementation (`schedule` = call it now). This is the control that says
    // the first test measures DETACHMENT rather than a handler that happened to
    // be quick: change nothing but `scheduleEvent`, and the delay appears.
    const h = setUp({ scheduleEvent: (fn) => fn() })
    await h.install('fixture')
    control().eventMode = 'block'
    control().blockMs = 150
    await h.host.load('fixture')
    const hub = attachHub(h.host)

    const started = Bun.nanoseconds()
    hub.hub.broadcast(deviceStatus('online'))
    const broadcastMs = (Bun.nanoseconds() - started) / 1e6
    expect(broadcastMs).toBeGreaterThan(140)
    expect(control().eventsSeen).toEqual(['device.status'])
  }, 20_000)

  test('a handler that throws changes nothing: every other subscriber, and the core`s own path, are untouched', async () => {
    const h = setUp()
    await h.install('fixture')
    control().eventMode = 'throw'
    await h.host.load('fixture')
    const hub = attachHub(h.host)
    let coreObserverRuns = 0
    hub.hub.addObserver(() => {
      coreObserverRuns++
    })

    hub.hub.broadcast(deviceStatus('offline'))
    hub.hub.broadcast(deviceStatus('online'))
    await Bun.sleep(200)

    expect(hub.frames[0]).toHaveLength(2)
    expect(hub.frames[1]).toHaveLength(2)
    expect(coreObserverRuns).toBe(2)
    const view = h.host.get('fixture')!
    // Charged to the plugin — an event handler is not exempt from the budget.
    expect(view.counters.eventDeliveries).toBe(2)
    expect(view.counters.failures).toBe(2)
    expect(view.lastError?.message).toContain('fixture: event handler exploded')
    // Two failures is a charge, not a verdict.
    expect(view.status).toBe('running')
  }, 20_000)

  test('a handler that hangs is abandoned at its deadline, and the broadcast never knew', async () => {
    const h = setUp({ eventTimeoutMs: 80 })
    await h.install('fixture')
    control().eventMode = 'hang'
    await h.host.load('fixture')
    const hub = attachHub(h.host)

    const started = Bun.nanoseconds()
    hub.hub.broadcast(deviceStatus('online'))
    expect((Bun.nanoseconds() - started) / 1e6).toBeLessThan(50)
    expect(hub.frames[0]).toHaveLength(1)

    await Bun.sleep(300)
    const view = h.host.get('fixture')!
    expect(view.counters.timeouts).toBe(1)
    expect(view.counters.failures).toBe(1)
  }, 20_000)

  test('budget-aware: a handler that always throws is disabled, and then stops receiving', async () => {
    const h = setUp({ errorBudget: { failures: 3, windowMs: 60_000 } })
    await h.install('fixture')
    control().eventMode = 'throw'
    await h.host.load('fixture')
    const hub = attachHub(h.host)

    for (let i = 0; i < 3; i++) {
      hub.hub.broadcast(deviceStatus('online'))
      await Bun.sleep(40)
    }
    await Bun.sleep(120)
    const view = h.host.get('fixture')!
    expect(view.disabledByBudget).toBe(true)
    expect(view.status).toBe('failed')

    const seenWhenDisabled = control().eventsSeen.length
    for (let i = 0; i < 5; i++) hub.hub.broadcast(deviceStatus('online'))
    await Bun.sleep(150)
    // Loud and finite: a plugin that misbehaves on every event does not spin
    // forever, it stops being handed events.
    expect(control().eventsSeen).toHaveLength(seenWhenDisabled)
    // …and the farm's own broadcast kept working throughout.
    expect(hub.frames[0]).toHaveLength(8)
  }, 20_000)
})

describe('subscriptions are declared, scoped to one instance, and dropped with it', () => {
  test('ctx.onEvent refuses a type the manifest does not declare', async () => {
    const h = setUp()
    await h.install('fixture')
    control().subscribeUndeclared = 'device.activity'
    await h.host.load('fixture')
    expect(control().subscribeError).toContain('E_PLUGIN_EVENT_UNDECLARED')
    expect(control().subscribeError).toContain('device.activity')
    // The declared one still worked, so this is a refusal and not a broken setup.
    expect(h.host.get('fixture')!.subscriptions).toEqual(['device.status'])
  })

  test('the view separates what was DECLARED from what was actually subscribed', async () => {
    const h = setUp()
    await h.install('fixture')
    await h.host.load('fixture')
    const view = h.host.get('fixture')!
    expect(view.events).toEqual(['device.status', 'job.status'])
    expect(view.subscriptions).toEqual(['device.status'])
    expect(view.counters.eventSubscriptions).toBe(1)
  })

  test('an unloaded service stops receiving, and a reloaded one does not receive twice', async () => {
    const h = setUp()
    await h.install('fixture')
    await h.host.load('fixture')
    const hub = attachHub(h.host)

    hub.hub.broadcast(deviceStatus('online'))
    await Bun.sleep(80)
    expect(control().eventsSeen).toHaveLength(1)

    await h.host.reload('fixture')
    hub.hub.broadcast(deviceStatus('online'))
    await Bun.sleep(80)
    // Exactly one more: the previous instance's subscription went with it,
    // rather than doubling every delivery on each reload.
    expect(control().eventsSeen).toHaveLength(2)

    await h.host.unload('fixture', 'a test asked')
    expect(h.host.get('fixture')!.subscriptions).toEqual([])
    hub.hub.broadcast(deviceStatus('online'))
    await Bun.sleep(80)
    expect(control().eventsSeen).toHaveLength(2)
    // The hub itself never stopped.
    expect(hub.frames[0]).toHaveLength(3)
  }, 20_000)

  test('an event nobody subscribed to costs one Map lookup and reaches nothing', async () => {
    const h = setUp()
    await h.install('fixture')
    await h.host.load('fixture')
    const hub = attachHub(h.host)
    hub.hub.broadcast({ type: 'heartbeat', payload: { t: 1 } })
    await Bun.sleep(60)
    expect(control().eventsSeen).toEqual([])
    expect(h.host.get('fixture')!.counters.eventDeliveries).toBe(0)
    expect(hub.frames[0]).toHaveLength(1)
  })
})

describe('the event vocabulary is the core`s own, and `device.connected` is not part of it (§9 Q1)', () => {
  test('SERVER_MESSAGE_TYPES is really derived from the union — the control that stops every check below being vacuous', () => {
    // Plan 109 §9 Q15's lesson, applied to a derived list rather than a
    // fingerprint: if the Zod probe behind this ever fails closed, the list is
    // empty, `unknownPluginEventTypesMessage` refuses everything, and the
    // assertions below would still "pass" for a check that had stopped
    // working. So: it is populated, and it contains messages declared in three
    // different files.
    expect(SERVER_MESSAGE_TYPES.length).toBeGreaterThan(50)
    expect(SERVER_MESSAGE_TYPES).toContain('device.status')
    expect(SERVER_MESSAGE_TYPES).toContain('device.added')
    expect(SERVER_MESSAGE_TYPES).toContain('device.removed')
    expect(SERVER_MESSAGE_TYPES).toContain('device.readiness')
    expect(SERVER_MESSAGE_TYPES).toContain('job.status')
    expect(SERVER_MESSAGE_TYPES).toContain('device.event')
  })

  test('the connect/disconnect names plan 109 §3.5 sketched do not exist, and the refusal says what does', () => {
    expect(SERVER_MESSAGE_TYPES).not.toContain('device.connected')
    expect(SERVER_MESSAGE_TYPES).not.toContain('device.disconnected')
    const message = unknownPluginEventTypesMessage(['device.connected'])
    expect(message).toContain('device.status')
    expect(message).toContain('device.added')
    expect(unknownPluginEventTypesMessage(['device.status', 'job.status'])).toBeNull()
  })
})
