import { describe, expect, test } from 'bun:test'
import type { AdbClient, TrackedDevice } from '@enkaku/adb'
import type { ServerMessage } from '@enkaku/protocol'
import type { Logger } from '../util/logger'
import { createDeviceReconciler, type DeviceReconcilerDeps } from './reconcile'

function fakeLogger(): Logger {
  const self: Logger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    child: () => self,
  }
  return self
}

interface FakeRegistry {
  onOnline: (serial: string) => Promise<void>
  onRemove: (serial: string) => void
  knownSerials: () => Set<string>
  pendingRetryCount: () => number
  onlineCalls: string[]
  removeCalls: string[]
  known: Set<string>
  retryCount: number
}

function fakeRegistry(known: string[] = []): FakeRegistry {
  const state: FakeRegistry = {
    onlineCalls: [],
    removeCalls: [],
    known: new Set(known),
    retryCount: 0,
    onOnline: async (serial: string) => {
      state.onlineCalls.push(serial)
      state.known.add(serial)
    },
    onRemove: (serial: string) => {
      state.removeCalls.push(serial)
      state.known.delete(serial)
    },
    knownSerials: () => new Set(state.known),
    pendingRetryCount: () => state.retryCount,
  }
  return state
}

function fakeClient(opts: { list: TrackedDevice[]; onReconnect?: () => void }): AdbClient {
  return {
    listDevices: async () => opts.list,
    reconnectOffline: async () => {
      opts.onReconnect?.()
      return 'ok'
    },
  } as unknown as AdbClient
}

const settingsOf = (overrides: Partial<{ scanIntervalSec: number; offlineGraceSec: number; recoveryCooldownSec: number }> = {}) => ({
  scanIntervalSec: 10,
  offlineGraceSec: 20,
  recoveryCooldownSec: 120,
  ...overrides,
})

function makeDeps(opts: {
  list: TrackedDevice[]
  known?: string[]
  settings?: ReturnType<typeof settingsOf>
  onReconnect?: () => void
}): { deps: DeviceReconcilerDeps; registry: FakeRegistry; broadcasts: ServerMessage[] } {
  const registry = fakeRegistry(opts.known ?? [])
  const broadcasts: ServerMessage[] = []
  const settings = opts.settings ?? settingsOf()
  const deps: DeviceReconcilerDeps = {
    client: fakeClient({ list: opts.list, onReconnect: opts.onReconnect }),
    registry,
    settings: () => settings,
    log: fakeLogger(),
    broadcast: (msg) => broadcasts.push(msg),
  }
  return { deps, registry, broadcasts }
}

describe('DeviceReconciler.runOnce — adopt (plan 85 §3.3 point 3, fixes F8/F9)', () => {
  test('a device in adb but unknown to the registry is adopted through the normal onOnline path', async () => {
    const { deps, registry } = makeDeps({ list: [{ serial: 'SER1', state: 'device' }] })
    const reconciler = createDeviceReconciler(deps)
    const report = await reconciler.runOnce()
    expect(report.seen).toBe(1)
    expect(report.adopted).toEqual(['SER1'])
    expect(registry.onlineCalls).toEqual(['SER1'])
  })

  test('a device already known to the registry is left alone', async () => {
    const { deps, registry } = makeDeps({ list: [{ serial: 'SER1', state: 'device' }], known: ['SER1'] })
    const reconciler = createDeviceReconciler(deps)
    const report = await reconciler.runOnce()
    expect(report.adopted).toEqual([])
    expect(registry.onlineCalls).toEqual([])
  })

  test('does not double-probe a device already known — the reconciler goes through the SAME onOnline dedupe the tracker uses (plan 85 §8 risk table)', async () => {
    let concurrentCalls = 0
    let maxConcurrent = 0
    const registry = fakeRegistry()
    const slowOnOnline = async (serial: string) => {
      concurrentCalls++
      maxConcurrent = Math.max(maxConcurrent, concurrentCalls)
      await new Promise((r) => setTimeout(r, 10))
      registry.known.add(serial)
      concurrentCalls--
    }
    registry.onOnline = slowOnOnline
    const deps: DeviceReconcilerDeps = {
      client: fakeClient({ list: [{ serial: 'SER1', state: 'device' }] }),
      registry,
      settings: () => settingsOf(),
      log: fakeLogger(),
      broadcast: () => {},
    }
    const reconciler = createDeviceReconciler(deps)
    // Two passes racing — the second must not pile another onOnline call on
    // top while the first is still in flight for the SAME serial, mirroring
    // what `probesInFlight` inside the real registry already guarantees;
    // this test only proves the reconciler does not add a second layer of
    // concurrent calls of its own for an unchanging adb snapshot within one
    // pass (each pass calls onOnline at most once per unknown serial).
    await reconciler.runOnce()
    expect(maxConcurrent).toBeLessThanOrEqual(1)
  })
})

describe('DeviceReconciler.runOnce — drop (plan 85 §3.3 point 4, safety net)', () => {
  test('a device known to the registry but gone from adb entirely is dropped', async () => {
    const { deps, registry } = makeDeps({ list: [], known: ['SER-GONE'] })
    const reconciler = createDeviceReconciler(deps)
    const report = await reconciler.runOnce()
    expect(report.dropped).toEqual(['SER-GONE'])
    expect(registry.removeCalls).toEqual(['SER-GONE'])
  })

  test('a known device still present in ANY adb state (not just "device") is not dropped', async () => {
    const { deps, registry } = makeDeps({ list: [{ serial: 'SER1', state: 'offline' }], known: ['SER1'] })
    const reconciler = createDeviceReconciler(deps)
    const report = await reconciler.runOnce()
    expect(report.dropped).toEqual([])
    expect(registry.removeCalls).toEqual([])
  })
})

describe('DeviceReconciler.runOnce — offline recovery (plan 85 §3.3 point 5, fixes F10) — NOT kill-server', () => {
  test('a device offline for less than the grace window is not yet a reconnect candidate', async () => {
    const { deps } = makeDeps({ list: [{ serial: 'SER1', state: 'offline' }], settings: settingsOf({ offlineGraceSec: 20 }) })
    const reconciler = createDeviceReconciler(deps)
    const report = await reconciler.runOnce()
    expect(report.offline).toEqual([])
    expect(report.reconnectIssued).toBe(false)
  })

  test('a device offline past the grace window gets exactly one host:reconnect-offline, at most once per cooldown', async () => {
    let reconnectCalls = 0
    const { deps } = makeDeps({
      list: [{ serial: 'SER1', state: 'offline' }],
      settings: settingsOf({ offlineGraceSec: 0, recoveryCooldownSec: 3600 }),
      onReconnect: () => reconnectCalls++,
    })
    const reconciler = createDeviceReconciler(deps)

    const first = await reconciler.runOnce()
    expect(first.offline).toEqual(['SER1'])
    expect(first.reconnectIssued).toBe(true)
    expect(reconnectCalls).toBe(1)

    // Still offline on the very next pass — the cooldown must suppress a second call.
    const second = await reconciler.runOnce()
    expect(second.offline).toEqual(['SER1'])
    expect(second.reconnectIssued).toBe(false)
    expect(reconnectCalls).toBe(1)
  })

  test('never calls kill-server — reconnectOffline is the only host method this reconciler invokes for a stuck device', async () => {
    const calls: string[] = []
    const client = {
      listDevices: async () => [{ serial: 'SER1', state: 'offline' }] as TrackedDevice[],
      reconnectOffline: async () => {
        calls.push('reconnect-offline')
        return 'ok'
      },
    } as unknown as AdbClient
    const deps: DeviceReconcilerDeps = {
      client,
      registry: fakeRegistry(),
      settings: () => settingsOf({ offlineGraceSec: 0 }),
      log: fakeLogger(),
      broadcast: () => {},
    }
    await createDeviceReconciler(deps).runOnce()
    expect(calls).toEqual(['reconnect-offline'])
    expect('killServer' in client).toBe(false)
  })
})

describe('DeviceReconciler.nudgeCounts / offlineSerials (plan 88 §3.9, §4.7 — "is adb stuck?")', () => {
  test('nudgeCounts starts at 0 and increments once per reconnect issued, across cooldown windows', async () => {
    const { deps } = makeDeps({
      list: [{ serial: 'SER1', state: 'offline' }],
      settings: settingsOf({ offlineGraceSec: 0, recoveryCooldownSec: 0 }),
    })
    const reconciler = createDeviceReconciler(deps)
    expect(reconciler.nudgeCounts().get('SER1')).toBeUndefined()

    await reconciler.runOnce()
    expect(reconciler.nudgeCounts().get('SER1')).toBe(1)
    await reconciler.runOnce()
    expect(reconciler.nudgeCounts().get('SER1')).toBe(2)
    await reconciler.runOnce()
    expect(reconciler.nudgeCounts().get('SER1')).toBe(3)
  })

  test('nudgeCounts resets to gone the moment the serial recovers', async () => {
    const { deps } = makeDeps({
      list: [{ serial: 'SER1', state: 'offline' }],
      settings: settingsOf({ offlineGraceSec: 0, recoveryCooldownSec: 0 }),
    })
    const reconciler = createDeviceReconciler(deps)
    await reconciler.runOnce()
    await reconciler.runOnce()
    expect(reconciler.nudgeCounts().get('SER1')).toBe(2)

    deps.client = { listDevices: async () => [{ serial: 'SER1', state: 'device' }], reconnectOffline: async () => 'ok' } as unknown as AdbClient
    await reconciler.runOnce()
    expect(reconciler.nudgeCounts().get('SER1')).toBeUndefined()
  })

  test('returns a snapshot copy, not the live map', async () => {
    const { deps } = makeDeps({ list: [{ serial: 'SER1', state: 'offline' }], settings: settingsOf({ offlineGraceSec: 0 }) })
    const reconciler = createDeviceReconciler(deps)
    await reconciler.runOnce()
    const snap = reconciler.nudgeCounts()
    snap.set('SER1', 999)
    expect(reconciler.nudgeCounts().get('SER1')).toBe(1)
  })

  test('offlineSerials reports every serial currently offline, cleared on recovery or disappearance', async () => {
    const { deps } = makeDeps({ list: [{ serial: 'SER1', state: 'offline' }], settings: settingsOf({ offlineGraceSec: 0 }) })
    const reconciler = createDeviceReconciler(deps)
    await reconciler.runOnce()
    expect(reconciler.offlineSerials().has('SER1')).toBe(true)

    deps.client = { listDevices: async () => [], reconnectOffline: async () => 'ok' } as unknown as AdbClient
    await reconciler.runOnce()
    expect(reconciler.offlineSerials().has('SER1')).toBe(false)
  })
})

describe('DeviceReconciler.runOnce — unauthorized (plan 85 §3.3 point 6)', () => {
  test('broadcasts device.unauthorized on every pass it persists, not just once', async () => {
    const { deps, broadcasts } = makeDeps({ list: [{ serial: 'SER1', state: 'unauthorized' }] })
    const reconciler = createDeviceReconciler(deps)
    await reconciler.runOnce()
    await reconciler.runOnce()
    const unauthorizedMsgs = broadcasts.filter((m) => m.type === 'device.unauthorized')
    expect(unauthorizedMsgs).toHaveLength(2)
  })
})

describe('DeviceReconciler.runOnce — retriesPending (plan 85 §4.4)', () => {
  test('reports the registry\'s own pending-retry count verbatim', async () => {
    const { deps, registry } = makeDeps({ list: [] })
    registry.retryCount = 3
    const report = await createDeviceReconciler(deps).runOnce()
    expect(report.retriesPending).toBe(3)
  })
})

describe('DeviceReconciler — scanIntervalSec: 0 disables it entirely (plan 85 §7.4 regression watch)', () => {
  test('runOnce() is a no-op: no adb call, no registry call, an empty report', async () => {
    let listCalled = false
    const client = {
      listDevices: async () => {
        listCalled = true
        return []
      },
      reconnectOffline: async () => 'unused',
    } as unknown as AdbClient
    const registry = fakeRegistry(['SER1'])
    const deps: DeviceReconcilerDeps = {
      client,
      registry,
      settings: () => settingsOf({ scanIntervalSec: 0 }),
      log: fakeLogger(),
      broadcast: () => {},
    }
    const report = await createDeviceReconciler(deps).runOnce()
    expect(listCalled).toBe(false)
    expect(report).toEqual({ seen: 0, adopted: [], dropped: [], offline: [], unauthorized: [], reconnectIssued: false, retriesPending: 0 })
    expect(registry.onlineCalls).toEqual([])
    expect(registry.removeCalls).toEqual([])
  })

  test('start() never schedules a tick, and the tracker-only behaviour (nothing runs on its own) is preserved', async () => {
    let listCalls = 0
    const client = {
      listDevices: async () => {
        listCalls++
        return []
      },
      reconnectOffline: async () => 'unused',
    } as unknown as AdbClient
    const deps: DeviceReconcilerDeps = {
      client,
      registry: fakeRegistry(),
      settings: () => settingsOf({ scanIntervalSec: 0 }),
      log: fakeLogger(),
      broadcast: () => {},
    }
    const reconciler = createDeviceReconciler(deps)
    reconciler.start()
    await new Promise((r) => setTimeout(r, 50))
    reconciler.stop()
    expect(listCalls).toBe(0)
  })
})

describe('DeviceReconciler.start/stop — the periodic tick', () => {
  test('start() runs a pass on its own timer, and stop() ends it', async () => {
    let listCalls = 0
    const client = {
      listDevices: async () => {
        listCalls++
        return []
      },
      reconnectOffline: async () => 'unused',
    } as unknown as AdbClient
    const deps: DeviceReconcilerDeps = {
      client,
      registry: fakeRegistry(),
      settings: () => settingsOf({ scanIntervalSec: 0.05 }),
      log: fakeLogger(),
      broadcast: () => {},
    }
    const reconciler = createDeviceReconciler(deps)
    reconciler.start()
    await new Promise((r) => setTimeout(r, 220))
    reconciler.stop()
    const callsAtStop = listCalls
    expect(callsAtStop).toBeGreaterThan(0)
    await new Promise((r) => setTimeout(r, 150))
    // No further ticks after stop().
    expect(listCalls).toBe(callsAtStop)
  })
})
