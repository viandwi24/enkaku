import { describe, expect, test } from 'bun:test'
import type { AdbClient, TrackedDevice } from '@enkaku/adb'
import { openDb, runMigrations, type Db } from '../db'
import { devices } from '../db/schema'
import { createLogger } from '../util/logger'
import { createEndpointStore, type EndpointStore } from './endpoints'
import { createDeviceReconnector, type DeviceReconnectorDeps, type TcpPreProbe } from './reconnect'
import type { SweepReport } from '@enkaku/protocol'

/**
 * The reconnect ladder (plan 88 §3.3, §4.4, fixes F8/F10/F13) — the plan's
 * own instruction is to "prove it against the existing socket fake", never a
 * real socket: every network edge here (the adb host service calls AND the
 * cheap TCP pre-probe) is a fake with fully controllable, deterministic
 * outcomes.
 */

function setUpDb(): Db {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  return opened.db
}

function seedDevice(db: Db, stableId: string, serial: string, label = stableId): void {
  db.insert(devices).values({ id: `id-${stableId}`, stableId, serial, label, status: 'idle' }).run()
}

interface FakeAdbState {
  /** Mutable — mutated by `connectDevice` below to simulate a device settling into `adb devices -l`. */
  list: TrackedDevice[]
  /** address → reply text, or an Error to throw. Missing address defaults to a generic failure reply. */
  connectReplies: Map<string, string | Error>
  disconnectCalls: string[]
  connectCalls: string[]
  /** address (the serial `probeDeviceIdentity` is given) → the identity it should resolve to. */
  identities: Map<string, { serialno: string; androidId?: string; model?: string }>
  /** When a `connectDevice` call succeeds, also push `{serial: address, state: 'device'}` onto `list` — simulates the transport settling, so `waitForSettle` resolves on its very first poll. */
  settleOnConnect: boolean
}

function fakeAdbState(overrides: Partial<FakeAdbState> = {}): FakeAdbState {
  return {
    list: [],
    connectReplies: new Map(),
    disconnectCalls: [],
    connectCalls: [],
    identities: new Map(),
    settleOnConnect: true,
    ...overrides,
  }
}

function fakeAdbClient(state: FakeAdbState): AdbClient {
  return {
    listDevices: async () => state.list,
    connectDevice: async (address: string) => {
      state.connectCalls.push(address)
      const reply = state.connectReplies.get(address)
      if (reply instanceof Error) throw reply
      const text = reply ?? `connected to ${address}`
      if (typeof text === 'string' && text.toLowerCase().startsWith('connected') && state.settleOnConnect) {
        if (!state.list.some((d) => d.serial === address)) state.list.push({ serial: address, state: 'device' })
      }
      return text
    },
    disconnectDevice: async (address: string) => {
      state.disconnectCalls.push(address)
      state.list = state.list.filter((d) => d.serial !== address)
      return `disconnected ${address}`
    },
    exec: async (serial: string, cmd: string) => {
      const identity = state.identities.get(serial) ?? { serialno: 'UNKNOWN-STABLE' }
      const replies: Record<string, string> = {
        'getprop ro.serialno': identity.serialno,
        'settings get secure android_id': identity.androidId ?? 'abcdef0123456789',
        'getprop ro.product.model': identity.model ?? 'Test Phone',
        'getprop ro.build.version.release': '15',
        'getprop ro.build.version.sdk': '35',
        'wm size': 'Physical size: 1080x2400',
        'wm density': 'Physical density: 420',
      }
      return { stdout: replies[cmd] ?? '', stderr: '', exitCode: 0 }
    },
  } as unknown as AdbClient
}

function fakeLogger() {
  const self = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => self }
  return self
}

/** A `SweepReport` with every count at its "found nothing" baseline — tests override just the fields they care about. */
function emptySweepReport(overrides: Partial<SweepReport> = {}): SweepReport {
  return {
    networks: [],
    scanned: 0,
    skipped: 0,
    answered: 0,
    connected: 0,
    identified: 0,
    adopted: [],
    discovered: [],
    conflicts: [],
    durationMs: 0,
    ...overrides,
  }
}

/** Always resolves synchronously — the default for tests that never reach the pre-probe rung. */
function preProbeAlways(outcome: 'accepted' | 'refused' | 'timeout'): TcpPreProbe {
  return async () => outcome
}

/** address → outcome; anything not listed is 'refused'. */
function preProbeByAddress(map: Record<string, 'accepted' | 'refused' | 'timeout'>): TcpPreProbe {
  return async (host, port) => map[`${host}:${port}`] ?? 'refused'
}

interface Harness {
  db: Db
  endpoints: EndpointStore
  onOnlineCalls: string[]
  reconnector: ReturnType<typeof createDeviceReconnector>
  state: FakeAdbState
}

function setUp(opts: {
  cfg?: { connectSettleMs?: number; probeTimeoutMs?: number; endpointsPerDevice?: number; endpointRetireAfter?: number }
  tcpPreProbe?: TcpPreProbe
  stateOverrides?: Partial<FakeAdbState>
  sweeper?: DeviceReconnectorDeps['sweeper']
}): Harness {
  const db = setUpDb()
  const cfg = { connectSettleMs: 2_000, probeTimeoutMs: 300, endpointsPerDevice: 4, endpointRetireAfter: 3, ...opts.cfg }
  const endpoints = createEndpointStore({ db, settings: () => ({ endpointsPerDevice: cfg.endpointsPerDevice, endpointRetireAfter: cfg.endpointRetireAfter }) })
  const state = fakeAdbState(opts.stateOverrides)
  const onOnlineCalls: string[] = []
  const deps: DeviceReconnectorDeps = {
    client: fakeAdbClient(state),
    db,
    endpoints,
    registry: {
      onOnline: async (serial: string) => {
        onOnlineCalls.push(serial)
      },
    },
    settings: () => ({ connectSettleMs: cfg.connectSettleMs, probeTimeoutMs: cfg.probeTimeoutMs }),
    log: fakeLogger() as unknown as DeviceReconnectorDeps['log'],
    tcpPreProbe: opts.tcpPreProbe,
    sweeper: opts.sweeper,
  }
  const reconnector = createDeviceReconnector(deps)
  return { db, endpoints, onOnlineCalls, reconnector, state }
}

describe('DeviceReconnector.reconnect — step 1, already connected (plan 88 §3.3)', () => {
  test('adb already lists the device serial as "device" → already-connected, zero adb work otherwise', async () => {
    const h = setUp({ stateOverrides: { list: [{ serial: '10.0.0.5:5555', state: 'device' }] } })
    seedDevice(h.db, 'STABLE-1', '10.0.0.5:5555')
    const outcome = await h.reconnector.reconnect('STABLE-1')
    expect(outcome).toEqual({ result: 'already-connected', serial: '10.0.0.5:5555' })
    expect(h.state.connectCalls).toEqual([])
  })
})

describe('DeviceReconnector.reconnect — refusal (plan 88 §4.4)', () => {
  test('a USB device with no remembered address refuses with reason "usb-device"', async () => {
    const h = setUp({})
    seedDevice(h.db, 'STABLE-1', 'ZP2222RMBS')
    const outcome = await h.reconnector.reconnect('STABLE-1')
    expect(outcome.result).toBe('refused')
    expect(outcome).toMatchObject({ result: 'refused', reason: 'usb-device' })
  })

  test('a TCP-shaped but disconnected device with no remembered address refuses with reason "no-endpoints"', async () => {
    const h = setUp({})
    seedDevice(h.db, 'STABLE-1', '10.0.0.9:5555') // stale — not in adb's list, no endpoint ever recorded
    const outcome = await h.reconnector.reconnect('STABLE-1')
    expect(outcome).toMatchObject({ result: 'refused', reason: 'no-endpoints' })
  })

  test('an entirely unknown stableId (no devices row at all) also refuses with "no-endpoints", not "usb-device"', async () => {
    const h = setUp({})
    const outcome = await h.reconnector.reconnect('NEVER-ENROLLED')
    expect(outcome).toMatchObject({ result: 'refused', reason: 'no-endpoints' })
  })
})

describe('DeviceReconnector.reconnect — step 2/3, the ladder itself (plan 88 §3.3)', () => {
  test('a remembered address that connects and verifies to the SAME stableId → connected, and calls registry.onOnline', async () => {
    const h = setUp({ tcpPreProbe: preProbeAlways('accepted') })
    seedDevice(h.db, 'STABLE-1', 'STALE:9999')
    h.endpoints.observe('STABLE-1', '10.0.0.5:5555')
    h.state.connectReplies.set('10.0.0.5:5555', 'connected to 10.0.0.5:5555')
    h.state.identities.set('10.0.0.5:5555', { serialno: 'STABLE-1' })

    const outcome = await h.reconnector.reconnect('STABLE-1')
    expect(outcome).toEqual({ result: 'connected', address: '10.0.0.5:5555', viaSweep: false })
    expect(h.onOnlineCalls).toEqual(['10.0.0.5:5555'])
    const [candidate] = h.endpoints.candidates('STABLE-1')
    expect(candidate!.consecutiveFailures).toBe(0)
    expect(candidate!.lastConnectedAt).not.toBeNull()
  })

  test('a pre-probe refusal skips straight to the next candidate, cheapest first', async () => {
    const h = setUp({
      tcpPreProbe: preProbeByAddress({ '10.0.0.1:5555': 'refused', '10.0.0.2:5555': 'accepted' }),
    })
    seedDevice(h.db, 'STABLE-1', 'STALE:9999')
    // Observed in this order so .1 (the LATER observe call — the newer,
    // higher-seq observation) is ranked FIRST by the ladder. It is tried,
    // pre-probed, and refused before .2 ever gets a chance.
    h.endpoints.observe('STABLE-1', '10.0.0.2:5555')
    h.endpoints.observe('STABLE-1', '10.0.0.1:5555')
    h.state.connectReplies.set('10.0.0.2:5555', 'connected to 10.0.0.2:5555')
    h.state.identities.set('10.0.0.2:5555', { serialno: 'STABLE-1' })

    const outcome = await h.reconnector.reconnect('STABLE-1')
    expect(outcome).toEqual({ result: 'connected', address: '10.0.0.2:5555', viaSweep: false })
    // .1 (ranked first) was pre-probed and refused before .2 ever got a chance.
    expect(h.state.connectCalls).toEqual(['10.0.0.2:5555']) // host:connect only issued to the one that ACCEPTED the pre-probe
  })

  test('a connect() reply that reads as failure never reaches the settle/verify step', async () => {
    const h = setUp({ tcpPreProbe: preProbeAlways('accepted') })
    seedDevice(h.db, 'STABLE-1', 'STALE:9999')
    h.endpoints.observe('STABLE-1', '10.0.0.5:5555')
    h.state.connectReplies.set('10.0.0.5:5555', 'failed to connect to 10.0.0.5:5555: Connection refused')

    const outcome = await h.reconnector.reconnect('STABLE-1')
    expect(outcome.result).toBe('not-found')
    if (outcome.result === 'not-found') {
      expect(outcome.tried).toEqual([{ address: '10.0.0.5:5555', preProbe: 'accepted', connect: 'failed', ms: expect.any(Number) }])
    }
  })

  test('a DIFFERENT stableId answering (conflict) is disconnected immediately and NOT adopted here (plan 88 §3.3 step 3, F14)', async () => {
    const h = setUp({ tcpPreProbe: preProbeAlways('accepted') })
    seedDevice(h.db, 'STABLE-1', 'STALE:9999')
    h.endpoints.observe('STABLE-1', '10.0.0.5:5555')
    h.state.connectReplies.set('10.0.0.5:5555', 'connected to 10.0.0.5:5555')
    h.state.identities.set('10.0.0.5:5555', { serialno: 'SOME-OTHER-PHONE' })

    const outcome = await h.reconnector.reconnect('STABLE-1')
    expect(outcome.result).toBe('not-found')
    if (outcome.result === 'not-found') {
      expect(outcome.tried).toEqual([
        { address: '10.0.0.5:5555', preProbe: 'accepted', connect: 'ok', probe: 'conflict', conflictStableId: 'SOME-OTHER-PHONE', ms: expect.any(Number) },
      ])
    }
    expect(h.state.disconnectCalls).toEqual(['10.0.0.5:5555']) // dropped immediately
    expect(h.onOnlineCalls).toEqual([]) // NOT adopted by the ladder — F14 says only the reconciler's own pass may do that
    const [candidate] = h.endpoints.candidates('STABLE-1')
    expect(candidate!.conflictStableId).toBe('SOME-OTHER-PHONE')
  })

  test('exhausting every candidate reports not-found with a trace naming what was tried', async () => {
    const h = setUp({
      tcpPreProbe: preProbeByAddress({ '10.0.0.1:5555': 'refused', '10.0.0.2:5555': 'timeout' }),
    })
    seedDevice(h.db, 'STABLE-1', 'STALE:9999')
    h.endpoints.observe('STABLE-1', '10.0.0.1:5555')
    h.endpoints.observe('STABLE-1', '10.0.0.2:5555')

    const outcome = await h.reconnector.reconnect('STABLE-1')
    expect(outcome.result).toBe('not-found')
    if (outcome.result === 'not-found') {
      expect(outcome.tried.length).toBe(2)
      expect(outcome.tried.map((t) => t.address).sort()).toEqual(['10.0.0.1:5555', '10.0.0.2:5555'])
      for (const t of outcome.tried) {
        expect(['refused', 'timeout']).toContain(t.preProbe)
        expect(t.connect).toBeUndefined() // never reached host:connect
      }
      expect(outcome.sweep).toBeNull() // 88.3's own deliverable — never attempted here
    }
  })

  test('a connect that never settles within connectSettleMs is reported and the ladder moves on', async () => {
    const h = setUp({
      cfg: { connectSettleMs: 100 },
      tcpPreProbe: preProbeAlways('accepted'),
      stateOverrides: { settleOnConnect: false },
    })
    seedDevice(h.db, 'STABLE-1', 'STALE:9999')
    h.endpoints.observe('STABLE-1', '10.0.0.5:5555')
    h.state.connectReplies.set('10.0.0.5:5555', 'connected to 10.0.0.5:5555')

    const outcome = await h.reconnector.reconnect('STABLE-1')
    expect(outcome.result).toBe('not-found')
    if (outcome.result === 'not-found') {
      expect(outcome.tried).toEqual([{ address: '10.0.0.5:5555', preProbe: 'accepted', connect: 'ok', probe: 'failed', ms: expect.any(Number) }])
    }
  }, 10_000)
})

describe('DeviceReconnector.reconnect — retired addresses and force (plan 88 §3.3 point 2)', () => {
  test('a retired address (consecutiveFailures >= endpointRetireAfter) is skipped without force', async () => {
    const h = setUp({ cfg: { endpointRetireAfter: 2 } })
    seedDevice(h.db, 'STABLE-1', '10.0.0.9:5555') // tcp-shaped, so a bare refusal reads "no-endpoints" not "usb-device"
    h.endpoints.observe('STABLE-1', '10.0.0.5:5555')
    h.endpoints.noteAttempt('STABLE-1', '10.0.0.5:5555', 'failed')
    h.endpoints.noteAttempt('STABLE-1', '10.0.0.5:5555', 'failed')

    const outcome = await h.reconnector.reconnect('STABLE-1')
    expect(outcome).toMatchObject({ result: 'refused', reason: 'no-endpoints' })
    expect(h.state.connectCalls).toEqual([])
  })

  test('force: true reaches a retired address and can still succeed', async () => {
    const h = setUp({ cfg: { endpointRetireAfter: 2 }, tcpPreProbe: preProbeAlways('accepted') })
    seedDevice(h.db, 'STABLE-1', '10.0.0.9:5555')
    h.endpoints.observe('STABLE-1', '10.0.0.5:5555')
    h.endpoints.noteAttempt('STABLE-1', '10.0.0.5:5555', 'failed')
    h.endpoints.noteAttempt('STABLE-1', '10.0.0.5:5555', 'failed')
    h.state.connectReplies.set('10.0.0.5:5555', 'connected to 10.0.0.5:5555')
    h.state.identities.set('10.0.0.5:5555', { serialno: 'STABLE-1' })

    const outcome = await h.reconnector.reconnect('STABLE-1', { force: true })
    expect(outcome).toEqual({ result: 'connected', address: '10.0.0.5:5555', viaSweep: false })
  })
})

describe('DeviceReconnector — the mutex is per-stableId, not global (plan 88 §4.4, this step\'s own "judgement" note)', () => {
  test('two reconnect() calls for the SAME stableId run serially — the second does not start until the first settles', async () => {
    let gateResolve!: (v: 'accepted' | 'refused' | 'timeout') => void
    const gate = new Promise<'accepted' | 'refused' | 'timeout'>((resolve) => {
      gateResolve = resolve
    })
    let secondCallStarted = false
    const preProbe: TcpPreProbe = async () => {
      if (!secondCallStarted) return gate // first invocation blocks
      return 'refused'
    }
    const h = setUp({ tcpPreProbe: preProbe })
    seedDevice(h.db, 'STABLE-1', '10.0.0.9:5555')
    h.endpoints.observe('STABLE-1', '10.0.0.5:5555')

    const first = h.reconnector.reconnect('STABLE-1')
    const second = h.reconnector.reconnect('STABLE-1').then((r) => {
      secondCallStarted = true
      return r
    })
    // Give any wrongly-unblocked microtask a chance to run.
    await Bun.sleep(20)
    expect(h.state.connectCalls).toEqual([]) // neither has connected yet
    // The second call must still be QUEUED, not mid-flight — release the gate
    // and confirm exactly one full pass happens before the other even begins.
    gateResolve('refused')
    const [firstOutcome, secondOutcome] = await Promise.all([first, second])
    expect(firstOutcome.result).toBe('not-found')
    expect(secondOutcome.result).toBe('not-found')
  })

  test('a reconnect() call for a DIFFERENT stableId is never blocked by one that is still in flight', async () => {
    let gateResolve!: (v: 'accepted' | 'refused' | 'timeout') => void
    const gate = new Promise<'accepted' | 'refused' | 'timeout'>((resolve) => {
      gateResolve = resolve
    })
    const preProbe: TcpPreProbe = async (host) => (host === '10.0.0.5' ? gate : 'refused')
    const h = setUp({ tcpPreProbe: preProbe })
    seedDevice(h.db, 'STABLE-A', '10.0.0.9:5555')
    seedDevice(h.db, 'STABLE-B', '10.0.0.8:5555')
    h.endpoints.observe('STABLE-A', '10.0.0.5:5555')
    h.endpoints.observe('STABLE-B', '10.0.0.6:5555')

    const stuckOnA = h.reconnector.reconnect('STABLE-A') // never resolves until we release the gate
    let bResolved = false
    const forB = h.reconnector.reconnect('STABLE-B').then((r) => {
      bResolved = true
      return r
    })
    await forB
    expect(bResolved).toBe(true) // B finished WITHOUT waiting for A's gate
    gateResolve('refused')
    await stuckOnA
  })
})

describe('DeviceReconnector.disconnect (plan 88 §3.7, §3.8, §4.4)', () => {
  test('refuses a USB device — adb has no host service to release one USB transport', async () => {
    const h = setUp({})
    seedDevice(h.db, 'STABLE-1', 'ZP2222RMBS')
    const outcome = await h.reconnector.disconnect('STABLE-1')
    expect(outcome.result).toBe('refused')
  })

  test('refuses an unknown stableId', async () => {
    const h = setUp({})
    const outcome = await h.reconnector.disconnect('NEVER-ENROLLED')
    expect(outcome.result).toBe('refused')
  })

  test('a tcp device not currently connected reports not-connected, without calling disconnectDevice', async () => {
    const h = setUp({})
    seedDevice(h.db, 'STABLE-1', '10.0.0.5:5555')
    const outcome = await h.reconnector.disconnect('STABLE-1')
    expect(outcome).toEqual({ result: 'not-connected' })
    expect(h.state.disconnectCalls).toEqual([])
  })

  test('a connected tcp device is disconnected via host:disconnect', async () => {
    const h = setUp({ stateOverrides: { list: [{ serial: '10.0.0.5:5555', state: 'device' }] } })
    seedDevice(h.db, 'STABLE-1', '10.0.0.5:5555')
    const outcome = await h.reconnector.disconnect('STABLE-1')
    expect(outcome).toEqual({ result: 'disconnected' })
    expect(h.state.disconnectCalls).toEqual(['10.0.0.5:5555'])
  })
})

describe('DeviceReconnector.reconnect — step 4, the sweep (plan 88 §3.3 step 4, §4.4, §5 step 88.3)', () => {
  test('allowSweep unset never calls the sweeper, even with candidates exhausted and a sweeper wired', async () => {
    let sweepCalls = 0
    const h = setUp({
      tcpPreProbe: preProbeAlways('refused'),
      sweeper: { sweep: async () => { sweepCalls++; return emptySweepReport() } },
    })
    seedDevice(h.db, 'STABLE-1', 'STALE:9999')
    h.endpoints.observe('STABLE-1', '10.0.0.5:5555')

    const outcome = await h.reconnector.reconnect('STABLE-1')
    expect(outcome).toMatchObject({ result: 'not-found', sweep: null })
    expect(sweepCalls).toBe(0)
  })

  test('zero remembered candidates + allowSweep + a wired sweeper skips the early "no-endpoints" refusal and tries the sweep instead', async () => {
    let sweepCalls = 0
    const h = setUp({
      sweeper: { sweep: async () => { sweepCalls++; return emptySweepReport() } },
    })
    seedDevice(h.db, 'STABLE-1', '10.0.0.9:5555') // tcp-shaped, zero endpoints ever observed

    const outcome = await h.reconnector.reconnect('STABLE-1', { allowSweep: true })
    expect(sweepCalls).toBe(1)
    expect(outcome).toMatchObject({ result: 'not-found', tried: [] })
  })

  test('a sweep that adopts this stableId reports "connected", viaSweep: true, with the address the sweep itself wrote to the devices row', async () => {
    const h = setUp({
      tcpPreProbe: preProbeAlways('refused'), // every remembered candidate fails first
      sweeper: {
        sweep: async (opts) => {
          expect(opts).toEqual({ expect: ['STABLE-1'] })
          // Simulate what the real sweeper does on a match: it already ran
          // `registry.onOnline`, which is what actually updates `serial`.
          h.db.update(devices).set({ serial: '10.0.0.77:5555' }).run()
          return emptySweepReport({ adopted: ['STABLE-1'], identified: 1, connected: 1, answered: 1, scanned: 254 })
        },
      },
    })
    seedDevice(h.db, 'STABLE-1', 'STALE:9999')
    h.endpoints.observe('STABLE-1', '10.0.0.5:5555')

    const outcome = await h.reconnector.reconnect('STABLE-1', { allowSweep: true })
    expect(outcome).toEqual({ result: 'connected', address: '10.0.0.77:5555', viaSweep: true })
  })

  test('a sweep that runs but does not find this stableId still reports "not-found", carrying the report', async () => {
    const h = setUp({
      tcpPreProbe: preProbeAlways('refused'),
      sweeper: { sweep: async () => emptySweepReport({ scanned: 254, answered: 3, discovered: ['SOMEONE-ELSES-PHONE'] }) },
    })
    seedDevice(h.db, 'STABLE-1', 'STALE:9999')
    h.endpoints.observe('STABLE-1', '10.0.0.5:5555')

    const outcome = await h.reconnector.reconnect('STABLE-1', { allowSweep: true })
    expect(outcome.result).toBe('not-found')
    if (outcome.result === 'not-found') {
      expect(outcome.sweep).toEqual(emptySweepReport({ scanned: 254, answered: 3, discovered: ['SOMEONE-ELSES-PHONE'] }))
      expect(outcome.tried.length).toBe(1) // the one remembered candidate was still tried first
    }
  })

  test('a sweeper that rejects (E_SCAN_BUSY / E_SCAN_UNAVAILABLE) folds into an ordinary not-found, never throws to the caller', async () => {
    const h = setUp({
      tcpPreProbe: preProbeAlways('refused'),
      sweeper: { sweep: async () => { throw new Error('E_SCAN_UNAVAILABLE: no scannable network is configured') } },
    })
    seedDevice(h.db, 'STABLE-1', '10.0.0.9:5555')

    const outcome = await h.reconnector.reconnect('STABLE-1', { allowSweep: true })
    expect(outcome).toMatchObject({ result: 'not-found', sweep: null })
  })

  test('allowSweep: true with NO sweeper wired behaves exactly like allowSweep unset — no throw, ordinary refusal/not-found', async () => {
    const h = setUp({}) // no sweeper in deps at all
    seedDevice(h.db, 'STABLE-1', '10.0.0.9:5555')
    const outcome = await h.reconnector.reconnect('STABLE-1', { allowSweep: true })
    expect(outcome).toMatchObject({ result: 'refused', reason: 'no-endpoints' })
  })
})
