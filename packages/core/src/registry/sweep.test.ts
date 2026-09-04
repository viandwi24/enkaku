import { describe, expect, test } from 'bun:test'
import type { AdbClient, TrackedDevice } from '@enkaku/adb'
import { eq } from 'drizzle-orm'
import { openDb, runMigrations, type Db } from '../db'
import { devices, discoveredDevices } from '../db/schema'
import { createEndpointStore, type EndpointStore } from './endpoints'
import { createSweeper, type SweeperDeps, type SweeperSettings, type Sweeper } from './sweep'
import type { TcpPreProbe } from './reconnect'

/**
 * The bounded sweep (plan 88 §3.5, §4.5, §5 step 88.3) — proven the same way
 * `reconnect.test.ts` proves the ladder: every network edge (the cheap TCP
 * pre-probe, `host:connect`, the identity probe) is a fully controllable
 * fake, never a real socket. §5 step 88.3's own instruction: "a sweep of a
 * subnet holding 20 devices completes in under 5s, probes ≤254 addresses,
 * issues host:connect only to hosts that answered, and reports counts that
 * add up. A stableId nobody admitted lands in the Discovered tray, never in
 * `devices`."
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
  list: TrackedDevice[]
  /** address → reply text, or an Error to throw. Missing address defaults to a generic success reply — most sweep tests care about which addresses got PROBED at all, not the connect reply text. */
  connectReplies: Map<string, string | Error>
  disconnectCalls: string[]
  connectCalls: string[]
  /** address → the identity `probeDeviceIdentity` should resolve to. Missing address never settles (see `settleOnConnect`), so it never reaches the identity probe at all — the sweep's own "connected but unidentifiable" path. */
  identities: Map<string, { serialno: string; androidId?: string; model?: string }>
  /** Addresses that settle into `device` state immediately on a successful connect — every address with a configured identity, unless explicitly excluded. */
  settleExclude: Set<string>
}

function fakeAdbState(overrides: Partial<FakeAdbState> = {}): FakeAdbState {
  return {
    list: [],
    connectReplies: new Map(),
    disconnectCalls: [],
    connectCalls: [],
    identities: new Map(),
    settleExclude: new Set(),
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
      if (typeof text === 'string' && text.toLowerCase().startsWith('connected') && !state.settleExclude.has(address)) {
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

/** Every address in `answering` accepts; everything else refuses. */
function preProbeAnswering(answering: Set<string>): TcpPreProbe {
  return async (host, port) => (answering.has(`${host}:${port}`) ? 'accepted' : 'refused')
}

const DEFAULT_SCAN: SweeperSettings['scan'] = { mode: 'on-demand', maxAddresses: 1024, concurrency: 32, probeTimeoutMs: 300 }

interface Harness {
  db: Db
  endpoints: EndpointStore
  onOnlineCalls: string[]
  sweeper: Sweeper
  state: FakeAdbState
}

function setUp(opts: {
  settings?: Partial<SweeperSettings>
  tcpPreProbe?: TcpPreProbe
  stateOverrides?: Partial<FakeAdbState>
  /** Overrides the fake `registry.onOnline` entirely, for the mutex/busy tests that never reach identification. */
  onOnline?: SweeperDeps['registry']['onOnline']
}): Harness {
  const db = setUpDb()
  const endpoints = createEndpointStore({ db, settings: () => ({ endpointsPerDevice: 4, endpointRetireAfter: 10 }) })
  const state = fakeAdbState(opts.stateOverrides)
  const onOnlineCalls: string[] = []

  // A REALISTIC (not merely recording) fake `onOnline`, matching exactly the
  // slice of `device-registry.ts`'s own admission behaviour this step's
  // "a sweep cannot enrol a device" requirement is about (plan 56, F14):
  // 'discovered' records a sighting — never a `devices` row; 'admitted'
  // updates the EXISTING row's `serial`; 'blocked' is a no-op. This is what
  // makes the "never in devices" assertions below prove something real,
  // not just that sweep.ts called a stub.
  const defaultOnOnline: SweeperDeps['registry']['onOnline'] = async (serial: string) => {
    onOnlineCalls.push(serial)
    const identity = state.identities.get(serial)
    if (!identity) return
    const stableId = identity.serialno
    const existing = db.select().from(devices).where(eq(devices.stableId, stableId)).get()
    if (existing) {
      db.update(devices).set({ serial }).where(eq(devices.stableId, stableId)).run()
      return
    }
    const blocked = false // no block table seeded in these tests
    if (blocked) return
    db.insert(discoveredDevices)
      .values({ stableId, serial, label: identity.model ?? null, androidVersion: '15', firstSeen: new Date(), lastSeen: new Date() })
      .onConflictDoUpdate({ target: discoveredDevices.stableId, set: { serial, lastSeen: new Date() } })
      .run()
  }

  const settings: SweeperSettings = {
    tcpPort: 5555,
    connectSettleMs: 2_000,
    networks: [],
    scan: DEFAULT_SCAN,
    ...opts.settings,
  }
  const deps: SweeperDeps = {
    client: fakeAdbClient(state),
    db,
    endpoints,
    registry: { onOnline: opts.onOnline ?? defaultOnOnline },
    settings: () => settings,
    log: fakeLogger() as unknown as SweeperDeps['log'],
    tcpPreProbe: opts.tcpPreProbe,
  }
  const sweeper = createSweeper(deps)
  return { db, endpoints, onOnlineCalls, sweeper, state }
}

describe('Sweeper.sweep — availability gates (plan 88 §3.5, §4.5)', () => {
  test('rejects E_SCAN_UNAVAILABLE when scan.mode is "off"', async () => {
    const h = setUp({ settings: { networks: [{ cidr: '10.0.0.0/24', label: '', medium: 'wired', scan: true }], scan: { ...DEFAULT_SCAN, mode: 'off' } } })
    await expect(h.sweeper.sweep()).rejects.toMatchObject({ code: 'E_SCAN_UNAVAILABLE' })
  })

  test('rejects E_SCAN_UNAVAILABLE when no network is marked scan: true', async () => {
    const h = setUp({ settings: { networks: [{ cidr: '10.0.0.0/24', label: '', medium: 'wired', scan: false }] } })
    await expect(h.sweeper.sweep()).rejects.toMatchObject({ code: 'E_SCAN_UNAVAILABLE' })
  })

  test('rejects E_SCAN_UNAVAILABLE with zero configured networks', async () => {
    const h = setUp({})
    await expect(h.sweeper.sweep()).rejects.toMatchObject({ code: 'E_SCAN_UNAVAILABLE' })
  })
})

describe('Sweeper.sweep — singleton mutex (plan 88 §3.5, §4.5, §5 step 88.3)', () => {
  test('a second concurrent call rejects E_SCAN_BUSY while one is running; running() reflects it', async () => {
    let gateResolve!: () => void
    const gate = new Promise<void>((resolve) => {
      gateResolve = resolve
    })
    const tcpPreProbe: TcpPreProbe = async () => {
      await gate
      return 'refused'
    }
    const h = setUp({ settings: { networks: [{ cidr: '10.0.0.0/24', label: '', medium: 'wired', scan: true }] }, tcpPreProbe })

    expect(h.sweeper.running()).toBe(false)
    const first = h.sweeper.sweep()
    await Bun.sleep(10) // let the first call actually start
    expect(h.sweeper.running()).toBe(true)

    await expect(h.sweeper.sweep()).rejects.toMatchObject({ code: 'E_SCAN_BUSY' })

    gateResolve()
    await first
    expect(h.sweeper.running()).toBe(false)
    // A THIRD call, after the first settled, is allowed again.
    const third = await h.sweeper.sweep()
    expect(third.scanned).toBeGreaterThan(0)
  })
})

describe('Sweeper.sweep — per-range port override (plan 88 §9 Q7, resolved; `docs/plans/96-m61-hotfixes.md` §96.44\'s follow-up)', () => {
  test('a network with its own `port` is probed on that port, not the farm-wide tcpPort — and the report names it', async () => {
    const probedAddresses: string[] = []
    const tcpPreProbe: TcpPreProbe = async (host, port) => {
      probedAddresses.push(`${host}:${port}`)
      return 'refused'
    }
    const h = setUp({
      settings: {
        tcpPort: 5555,
        networks: [{ cidr: '10.0.0.0/30', label: 'Overridden', medium: 'wired', scan: true, port: 7000 }],
      },
      tcpPreProbe,
    })

    const report = await h.sweeper.sweep()

    // A /30 has two usable hosts (.1, .2) — both probed on the OVERRIDE port.
    expect(probedAddresses.sort()).toEqual(['10.0.0.1:7000', '10.0.0.2:7000'])
    expect(report.networks).toEqual([{ cidr: '10.0.0.0/30', label: 'Overridden', addresses: 4, port: 7000 }])
  })

  test('a network with no `port` set still falls back to the farm-wide tcpPort — the report names that too', async () => {
    const probedAddresses: string[] = []
    const tcpPreProbe: TcpPreProbe = async (host, port) => {
      probedAddresses.push(`${host}:${port}`)
      return 'refused'
    }
    const h = setUp({
      settings: {
        tcpPort: 6060,
        networks: [{ cidr: '10.0.0.0/30', label: 'Default', medium: 'wired', scan: true }],
      },
      tcpPreProbe,
    })

    const report = await h.sweeper.sweep()

    expect(probedAddresses.sort()).toEqual(['10.0.0.1:6060', '10.0.0.2:6060'])
    expect(report.networks).toEqual([{ cidr: '10.0.0.0/30', label: 'Default', addresses: 4, port: 6060 }])
  })

  test('two networks — one overridden, one not — each probed on their own effective port in the same sweep', async () => {
    const probedAddresses: string[] = []
    const tcpPreProbe: TcpPreProbe = async (host, port) => {
      probedAddresses.push(`${host}:${port}`)
      return 'refused'
    }
    const h = setUp({
      settings: {
        tcpPort: 5555,
        networks: [
          { cidr: '10.0.0.0/30', label: 'Overridden', medium: 'wired', scan: true, port: 7000 },
          { cidr: '10.0.1.0/30', label: 'Default', medium: 'wired', scan: true },
        ],
      },
      tcpPreProbe,
    })

    const report = await h.sweeper.sweep()

    expect(probedAddresses.sort()).toEqual(['10.0.0.1:7000', '10.0.0.2:7000', '10.0.1.1:5555', '10.0.1.2:5555'])
    expect(report.networks).toEqual([
      { cidr: '10.0.0.0/30', label: 'Overridden', addresses: 4, port: 7000 },
      { cidr: '10.0.1.0/30', label: 'Default', addresses: 4, port: 5555 },
    ])
  })
})

describe('Sweeper.sweep — skip-known, counts add up (plan 88 §3.5, §4.5, §5 step 88.3 verifiable result)', () => {
  test('a /24 probes exactly 254 addresses (network/broadcast excluded), skips adb-known ones, and every count adds up', async () => {
    // Three of the 254 usable addresses in 10.0.0.0/24 are already known to
    // adb (any state) — skipped outright, never pre-probed.
    const known: TrackedDevice[] = [
      { serial: '10.0.0.5:5555', state: 'device' },
      { serial: '10.0.0.9:5555', state: 'offline' },
      { serial: '10.0.0.200:5555', state: 'unauthorized' },
    ]
    // Two addresses answer the pre-probe and turn out to be real devices —
    // one already admitted (STABLE-EXISTING), one brand new (STABLE-NEW).
    const h = setUp({
      settings: { networks: [{ cidr: '10.0.0.0/24', label: 'Chassis A', medium: 'wired', scan: true }] },
      stateOverrides: {
        list: known,
        connectReplies: new Map([
          ['10.0.0.20:5555', 'connected to 10.0.0.20:5555'],
          ['10.0.0.30:5555', 'connected to 10.0.0.30:5555'],
        ]),
        identities: new Map([
          ['10.0.0.20:5555', { serialno: 'STABLE-EXISTING' }],
          ['10.0.0.30:5555', { serialno: 'STABLE-NEW' }],
        ]),
      },
      tcpPreProbe: preProbeAnswering(new Set(['10.0.0.20:5555', '10.0.0.30:5555'])),
    })
    seedDevice(h.db, 'STABLE-EXISTING', 'STALE:9999')

    const report = await h.sweeper.sweep()

    expect(report.networks).toEqual([{ cidr: '10.0.0.0/24', label: 'Chassis A', addresses: 256, port: 5555 }])
    expect(report.skipped).toBe(3)
    expect(report.scanned).toBe(254 - 3) // every usable host in the /24 except the 3 already known
    expect(report.answered).toBe(2)
    expect(report.connected).toBe(2)
    expect(report.identified).toBe(2)
    expect(report.adopted).toEqual(['STABLE-EXISTING'])
    expect(report.discovered).toEqual(['STABLE-NEW'])
    expect(report.conflicts).toEqual([])
    // host:connect issued ONLY to the two that answered the pre-probe.
    expect(h.state.connectCalls.sort()).toEqual(['10.0.0.20:5555', '10.0.0.30:5555'])
    // Never probed twice.
    expect(new Set(h.state.connectCalls).size).toBe(h.state.connectCalls.length)

    // Acceptance #7 / this step's own instruction: the new stableId reaches
    // the tray, never `devices`.
    const newRow = h.db.select().from(devices).where(eq(devices.stableId, 'STABLE-NEW')).get()
    expect(newRow).toBeUndefined()
    const tray = h.db.select().from(discoveredDevices).where(eq(discoveredDevices.stableId, 'STABLE-NEW')).get()
    expect(tray).toBeDefined()
    expect(tray?.serial).toBe('10.0.0.30:5555')

    // The already-admitted device WAS reattached (its serial now points at
    // the newly found address) — this is a legitimate reconnect, not an
    // enrolment.
    const existingRow = h.db.select().from(devices).where(eq(devices.stableId, 'STABLE-EXISTING')).get()
    expect(existingRow?.serial).toBe('10.0.0.20:5555')
  })
})

describe('Sweeper.sweep — a sweep can NEVER enrol a device (plan 56, F14; this step\'s own required test)', () => {
  test('a brand-new stableId never gets a `devices` row, no matter how many times it is seen', async () => {
    const h = setUp({
      settings: { networks: [{ cidr: '10.0.0.0/24', label: '', medium: 'wired', scan: true }] },
      stateOverrides: {
        connectReplies: new Map([['10.0.0.42:5555', 'connected to 10.0.0.42:5555']]),
        identities: new Map([['10.0.0.42:5555', { serialno: 'NEVER-ADMITTED' }]]),
      },
      tcpPreProbe: preProbeAnswering(new Set(['10.0.0.42:5555'])),
    })

    await h.sweeper.sweep()
    expect(h.db.select().from(devices).where(eq(devices.stableId, 'NEVER-ADMITTED')).get()).toBeUndefined()
    expect(h.db.select().from(discoveredDevices).where(eq(discoveredDevices.stableId, 'NEVER-ADMITTED')).get()).toBeDefined()

    // Sweeping the SAME network again changes nothing about that guarantee —
    // repetition is not a loophole.
    await h.sweeper.sweep()
    expect(h.db.select().from(devices).where(eq(devices.stableId, 'NEVER-ADMITTED')).get()).toBeUndefined()
  })
})

describe('Sweeper.sweep — address-book conflicts (plan 88 §8 risk table)', () => {
  test('an address remembered for a DIFFERENT stableId is disconnected immediately and recorded as a conflict, never adopted', async () => {
    const h = setUp({
      settings: { networks: [{ cidr: '10.0.0.0/24', label: '', medium: 'wired', scan: true }] },
      stateOverrides: {
        connectReplies: new Map([['10.0.0.50:5555', 'connected to 10.0.0.50:5555']]),
        identities: new Map([['10.0.0.50:5555', { serialno: 'STABLE-B' }]]),
      },
      tcpPreProbe: preProbeAnswering(new Set(['10.0.0.50:5555'])),
    })
    seedDevice(h.db, 'STABLE-A', 'STALE:1111')
    h.endpoints.observe('STABLE-A', '10.0.0.50:5555') // the address book remembers .50 for STABLE-A

    const report = await h.sweeper.sweep()

    expect(report.conflicts).toEqual([{ address: '10.0.0.50:5555', expected: 'STABLE-A', found: 'STABLE-B' }])
    expect(report.adopted).toEqual([])
    expect(report.discovered).toEqual([])
    expect(h.state.disconnectCalls).toEqual(['10.0.0.50:5555'])
    expect(h.onOnlineCalls).toEqual([]) // never adopted by the sweep itself — the reconciler's own pass may pick it up later
  })
})

describe('Sweeper.sweep — bounded concurrency and the hard ceiling (plan 88 §3.5, §5 step 88.3)', () => {
  test('never more than `scan.concurrency` pre-probes in flight at once', async () => {
    let inFlight = 0
    let maxInFlight = 0
    const tcpPreProbe: TcpPreProbe = async () => {
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      await Bun.sleep(5)
      inFlight--
      return 'refused'
    }
    const h = setUp({
      settings: { networks: [{ cidr: '10.0.0.0/24', label: '', medium: 'wired', scan: true }], scan: { ...DEFAULT_SCAN, concurrency: 8 } },
      tcpPreProbe,
    })
    const report = await h.sweeper.sweep()
    expect(report.scanned).toBe(254)
    expect(maxInFlight).toBeLessThanOrEqual(8)
    expect(maxInFlight).toBeGreaterThan(1) // genuinely concurrent, not accidentally serial
  }, 10_000)

  test('the hard ceiling caps probes even if a network is misconfigured larger than maxAddresses', async () => {
    const h = setUp({
      // A /16 (65,536 usable addresses) with a tiny ceiling — defence in
      // depth: the settings-level refinement should already prevent this
      // combination from ever being SAVED, but the sweeper does not trust
      // that alone.
      settings: { networks: [{ cidr: '10.0.0.0/16', label: '', medium: 'wired', scan: true }], scan: { ...DEFAULT_SCAN, maxAddresses: 100 } },
      tcpPreProbe: async () => 'refused',
    })
    const report = await h.sweeper.sweep()
    expect(report.scanned).toBeLessThanOrEqual(100)
  })
})

describe('Sweeper.sweep — last-octet-first ordering (plan 88 §3.5, §5 step 88.3)', () => {
  test('the network holding a remembered (even retired) endpoint for an `expect`ed stableId is probed starting at that endpoint\'s final octet', async () => {
    const probedOrder: string[] = []
    const tcpPreProbe: TcpPreProbe = async (host) => {
      probedOrder.push(host)
      return 'refused'
    }
    const h = setUp({
      settings: { networks: [{ cidr: '10.0.0.0/24', label: '', medium: 'wired', scan: true }] },
      tcpPreProbe,
    })
    seedDevice(h.db, 'STABLE-1', 'STALE:9999')
    h.endpoints.observe('STABLE-1', '10.0.0.137:5555')
    h.endpoints.noteAttempt('STABLE-1', '10.0.0.137:5555', 'failed') // retired-or-not, still a usable hint
    for (let i = 0; i < 20; i++) h.endpoints.noteAttempt('STABLE-1', '10.0.0.137:5555', 'failed') // push well past any retirement threshold

    await h.sweeper.sweep({ expect: ['STABLE-1'] })

    expect(probedOrder[0]).toBe('10.0.0.137')
    expect(probedOrder[1]).toBe('10.0.0.138') // ascending from there
    expect(probedOrder.length).toBe(254)
    expect(new Set(probedOrder).size).toBe(254) // no address probed twice, even with the rotation
  })

  test('no `expect`, or no matching remembered endpoint, falls back to plain ascending order', async () => {
    const probedOrder: string[] = []
    const tcpPreProbe: TcpPreProbe = async (host) => {
      probedOrder.push(host)
      return 'refused'
    }
    const h = setUp({ settings: { networks: [{ cidr: '10.0.0.0/24', label: '', medium: 'wired', scan: true }] }, tcpPreProbe })

    await h.sweeper.sweep()

    expect(probedOrder[0]).toBe('10.0.0.1')
    expect(probedOrder[1]).toBe('10.0.0.2')
  })
})
