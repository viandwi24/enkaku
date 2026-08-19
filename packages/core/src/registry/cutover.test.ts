import { describe, expect, test } from 'bun:test'
import type { AdbClient } from '@enkaku/adb'
import type { ReconnectOutcome, ServerMessage, SweepReport } from '@enkaku/protocol'
import { createLogger } from '../util/logger'
import type { HostAdb } from '../device/host-adb'
import { createCutoverManager, type CutoverManagerDeps } from './cutover'
import type { DeviceReconnector } from './reconnect'

/**
 * The cutover state machine (plan 88 §3.4, §4.6, §5 step 88.5) — arm, flip,
 * watch. Every network edge (the device-service `tcpip:`/`getprop`/`setprop`
 * calls, the CLI fallback, and the reconnect ladder itself) is a fake with
 * fully controllable outcomes, per this plan's own "prove it against a fake,
 * never a real socket" discipline (already used by 88.2's `reconnect.test.ts`
 * and 88.3's `sweep.test.ts`).
 */

function fakeLogger() {
  const self = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => self }
  return self as unknown as ReturnType<typeof createLogger>
}

interface FakeClientState {
  tcpipError: Error | null
  props: Map<string, string>
  execError: Map<string, Error>
  tcpipCalls: Array<{ serial: string; port: number }>
}

function fakeClient(state: FakeClientState): AdbClient {
  return {
    tcpip: async (serial: string, port: number) => {
      state.tcpipCalls.push({ serial, port })
      if (state.tcpipError) throw state.tcpipError
    },
    exec: async (_serial: string, cmd: string) => {
      const m = /^getprop (\S+)$/.exec(cmd)
      if (m) {
        const err = state.execError.get(cmd)
        if (err) throw err
        return { stdout: state.props.get(m[1]!) ?? '', stderr: '', exitCode: 0 }
      }
      const setM = /^setprop (\S+) (\S+)$/.exec(cmd)
      if (setM) {
        const err = state.execError.get(cmd)
        if (err) throw err
        // A real device may silently ignore an unprivileged `setprop
        // persist.*` — the fake models that by NOT auto-updating `props`;
        // each test sets `props` explicitly to control the read-back.
        return { stdout: '', stderr: '', exitCode: 0 }
      }
      throw new Error(`fakeClient: unexpected exec ${cmd}`)
    },
  } as unknown as AdbClient
}

function fakeHostAdb(overrides: { runError?: Error } = {}): { hostAdb: Pick<HostAdb, 'run'>; calls: string[][] } {
  const calls: string[][] = []
  return {
    calls,
    hostAdb: {
      run: async (args: string[]) => {
        calls.push(args)
        if (overrides.runError) throw overrides.runError
        return ''
      },
    },
  }
}

function fakeEndpoints(): { declare: (stableId: string, address: string, medium: string | null) => void; calls: Array<{ stableId: string; address: string; medium: string | null }> } {
  const calls: Array<{ stableId: string; address: string; medium: string | null }> = []
  return {
    calls,
    declare: (stableId, address, medium) => {
      calls.push({ stableId, address, medium })
    },
  }
}

/**
 * `state` is a plain mutable object, not a getter — object-rest
 * destructuring (as `setUp` below does) copies a getter's CURRENT value
 * once, at destructure time, not a live reference to it. A plain nested
 * object survives that copy correctly, since only the OUTER wrapper is
 * spread, never `state` itself.
 */
function fakeReconnector(outcomes: ReconnectOutcome[]): { reconnector: Pick<DeviceReconnector, 'reconnect'>; state: { calls: number } } {
  const state = { calls: 0 }
  return {
    state,
    reconnector: {
      reconnect: async () => {
        const outcome = outcomes[Math.min(state.calls, outcomes.length - 1)]!
        state.calls++
        return outcome
      },
    },
  }
}

function baseProps(port: number): Map<string, string> {
  return new Map([
    ['service.adb.tcp.port', String(port)],
    ['persist.adb.tcp.port', String(port)],
  ])
}

function setUp(overrides: Partial<{
  clientState: FakeClientState
  hostAdbError: Error
  reconnectOutcomes: ReconnectOutcome[]
  armWindowSec: number
  armPollSec: number
}> = {}) {
  const clientState: FakeClientState = overrides.clientState ?? { tcpipError: null, props: baseProps(5555), execError: new Map(), tcpipCalls: [] }
  const client = fakeClient(clientState)
  const { hostAdb, calls: hostAdbCalls } = fakeHostAdb(overrides.hostAdbError ? { runError: overrides.hostAdbError } : {})
  const endpoints = fakeEndpoints()
  const { reconnector, state: reconnectorState } = fakeReconnector(overrides.reconnectOutcomes ?? [{ result: 'not-found', tried: [], sweep: null }])
  const broadcasts: ServerMessage[] = []
  const deps: CutoverManagerDeps = {
    client,
    hostAdb,
    endpoints,
    reconnector,
    settings: () => ({ tcpPort: 5555, armWindowSec: overrides.armWindowSec ?? 180, armPollSec: overrides.armPollSec ?? 5 }),
    broadcast: (msg) => broadcasts.push(msg),
    log: fakeLogger(),
  }
  const manager = createCutoverManager(deps)
  return { manager, clientState, hostAdbCalls, endpoints, reconnectorState, broadcasts }
}

const device = { id: 'dev-a', stableId: 'stable-a', serial: 'USB-SERIAL-1', label: 'Pixel Test' }

describe('createCutoverManager — enable + verified read-back (plan 88 §3.4 step 2, tests H1/H3)', () => {
  test('the happy path arms with persistSurvivesReboot true when both read-backs match', async () => {
    const { manager, clientState } = setUp()
    const state = await manager.start(device, { medium: 'wired' })
    expect(state.step).toBe('armed')
    expect(state.persistSurvivesReboot).toBe(true)
    expect(state.port).toBe(5555)
    expect(state.expiresAt).not.toBeNull()
    expect(clientState.tcpipCalls).toEqual([{ serial: 'USB-SERIAL-1', port: 5555 }])
  })

  test('an explicit port overrides discovery.tcpPort', async () => {
    const clientState: FakeClientState = { tcpipError: null, props: baseProps(5599), execError: new Map(), tcpipCalls: [] }
    const { manager } = setUp({ clientState })
    const state = await manager.start(device, { medium: 'wired', port: 5599 })
    expect(state.step).toBe('armed')
    expect(state.port).toBe(5599)
  })

  test('H1 fallback: when the device-service tcpip: call throws, hostAdb.run is used instead, and the rest of the step is unchanged', async () => {
    const clientState: FakeClientState = { tcpipError: new Error('unknown service tcpip'), props: baseProps(5555), execError: new Map(), tcpipCalls: [] }
    const { manager, hostAdbCalls } = setUp({ clientState })
    const state = await manager.start(device, { medium: 'wired' })
    expect(state.step).toBe('armed')
    expect(hostAdbCalls).toEqual([['-s', 'USB-SERIAL-1', 'tcpip', '5555']])
  })

  test('refuses to arm when the device-service AND the hostAdb fallback both fail', async () => {
    const clientState: FakeClientState = { tcpipError: new Error('device offline'), props: baseProps(5555), execError: new Map(), tcpipCalls: [] }
    const { manager } = setUp({ clientState, hostAdbError: new Error('adb: error: device offline') })
    const state = await manager.start(device, { medium: 'wired' })
    expect(state.step).toBe('failed')
    expect(state.detail).toMatch(/could not enable TCP mode/)
    expect(state.expiresAt).toBeNull()
  })

  test('refuses to arm when service.adb.tcp.port does not read back as the port just set (§3.4 step 2\'s own rule)', async () => {
    const clientState: FakeClientState = { tcpipError: null, props: new Map([['service.adb.tcp.port', '']]), execError: new Map(), tcpipCalls: [] }
    const { manager } = setUp({ clientState })
    const state = await manager.start(device, { medium: 'wired' })
    expect(state.step).toBe('failed')
    expect(state.detail).toMatch(/refusing to arm/)
    expect(state.expiresAt).toBeNull()
  })

  test('H3: persist.adb.tcp.port failing to read back still arms — the wizard measures, never promises', async () => {
    const clientState: FakeClientState = { tcpipError: null, props: new Map([['service.adb.tcp.port', '5555']]), execError: new Map(), tcpipCalls: [] }
    const { manager } = setUp({ clientState })
    const state = await manager.start(device, { medium: 'wired' })
    expect(state.step).toBe('armed')
    expect(state.persistSurvivesReboot).toBe(false)
    expect(state.detail).toMatch(/need re-arming after a reboot/)
  })

  test('H3: a setprop that throws (e.g. permission denied, unrooted) is tolerated, arms with persistSurvivesReboot false', async () => {
    const clientState: FakeClientState = {
      tcpipError: null,
      props: new Map([['service.adb.tcp.port', '5555']]),
      execError: new Map([['setprop persist.adb.tcp.port 5555', new Error('Unable to chmod')]]),
      tcpipCalls: [],
    }
    const { manager } = setUp({ clientState })
    const state = await manager.start(device, { medium: 'wired' })
    expect(state.step).toBe('armed')
    expect(state.persistSurvivesReboot).toBe(false)
  })
})

describe('createCutoverManager — arm, flip, watch (plan 88 §3.4 step 3)', () => {
  test('a typed manual address is declared immediately, before the enable step even runs', async () => {
    const { manager, endpoints } = setUp()
    await manager.start(device, { medium: 'wireless', address: '10.20.0.9:5555' })
    expect(endpoints.calls).toContainEqual({ stableId: 'stable-a', address: '10.20.0.9:5555', medium: 'wireless' })
  })

  test('while still on USB, "already-connected" against the OLD usb serial does NOT complete the cutover', async () => {
    const { manager, broadcasts } = setUp({
      reconnectOutcomes: [{ result: 'already-connected', serial: 'USB-SERIAL-1' }],
      armPollSec: 1,
    })
    await manager.start(device, { medium: 'wired' })
    // Let one poll tick run.
    await Bun.sleep(1100)
    const state = manager.get('stable-a')
    expect(state?.step).not.toBe('done')
    expect(state?.step).toBe('armed')
    // Never claims "done" for a USB serial — the whole point of the filter.
    expect(broadcasts.some((m) => m.type === 'device.cutover' && (m as { payload: { state: { step: string } } }).payload.state.step === 'done')).toBe(false)
  })

  test('once the phone answers on the network (a tcp address), the cutover completes and declares the medium', async () => {
    const { manager, endpoints } = setUp({
      reconnectOutcomes: [{ result: 'connected', address: '10.20.0.9:5555', viaSweep: true }],
      armPollSec: 1,
    })
    await manager.start(device, { medium: 'wired' })
    await Bun.sleep(1100)
    const state = manager.get('stable-a')
    expect(state?.step).toBe('done')
    expect(state?.connectedAddress).toBe('10.20.0.9:5555')
    expect(state?.detail).toMatch(/OTG/)
    expect(endpoints.calls).toContainEqual({ stableId: 'stable-a', address: '10.20.0.9:5555', medium: 'wired' })
  })

  test('wireless medium reads "Wi-Fi" in the done detail, not OTG', async () => {
    const { manager } = setUp({
      reconnectOutcomes: [{ result: 'connected', address: '10.20.0.9:5555', viaSweep: false }],
      armPollSec: 1,
    })
    await manager.start(device, { medium: 'wireless' })
    await Bun.sleep(1100)
    expect(manager.get('stable-a')?.detail).toMatch(/Wi-Fi/)
  })

  test('trace counts accumulate across polls from not-found outcomes', async () => {
    const sweep: SweepReport = {
      networks: [{ cidr: '10.20.0.0/24', label: 'Chassis A', addresses: 256, port: 5555 }],
      scanned: 254,
      skipped: 0,
      answered: 3,
      connected: 0,
      identified: 0,
      adopted: [],
      discovered: [],
      conflicts: [],
      durationMs: 500,
    }
    const { manager } = setUp({
      reconnectOutcomes: [{ result: 'not-found', tried: [{ address: '10.20.0.5:5555', preProbe: 'refused', ms: 5 }], sweep }],
      armPollSec: 1,
    })
    await manager.start(device, { medium: 'wired' })
    await Bun.sleep(1100)
    const state = manager.get('stable-a')
    expect(state?.step).toBe('armed')
    expect(state?.triedAddresses).toBe(1)
    expect(state?.answered).toBe(3)
    expect(state?.detail).toMatch(/swept 10.20.0.0\/24/)
  })

  test('the window expires after armWindowSec with no match — step fails, naming the three likely causes', async () => {
    const { manager } = setUp({ armWindowSec: 1, armPollSec: 1 })
    await manager.start(device, { medium: 'wired' })
    await Bun.sleep(1600)
    const state = manager.get('stable-a')
    expect(state?.step).toBe('failed')
    expect(state?.detail).toMatch(/port did not flip/)
    expect(state?.detail).toMatch(/DHCP lease/)
    expect(state?.detail).toMatch(/configured network is wrong/)
    expect(state?.expiresAt).toBeNull()
  })
})

describe('createCutoverManager — cancel (plan 88 §3.4: "reverts nothing") and restart', () => {
  test('cancel removes the session — get() returns null, and no further polls run', async () => {
    const { manager, reconnectorState } = setUp({ armPollSec: 1 })
    await manager.start(device, { medium: 'wired' })
    const cancelled = manager.cancel('stable-a')
    expect(cancelled?.step).toBe('armed')
    expect(manager.get('stable-a')).toBeNull()

    const callsAtCancel = reconnectorState.calls
    await Bun.sleep(1300)
    expect(reconnectorState.calls).toBe(callsAtCancel) // no poll fired after cancel
  })

  test('cancel on an unknown stableId is a harmless no-op', () => {
    const { manager } = setUp()
    expect(manager.cancel('never-started')).toBeNull()
  })

  test('stopAll clears every pending timer (00-overview §7: nothing outlives daemon.stop())', async () => {
    const { manager, reconnectorState } = setUp({ armPollSec: 1 })
    await manager.start(device, { medium: 'wired' })
    manager.stopAll()
    expect(manager.get('stable-a')).toBeNull()

    const callsAtStop = reconnectorState.calls
    await Bun.sleep(1300)
    expect(reconnectorState.calls).toBe(callsAtStop) // no poll fired after stopAll
  })

  test('starting again for the same device restarts cleanly — no double-polling from a leaked prior timer', async () => {
    const { manager, reconnectorState } = setUp({ armPollSec: 1 })
    await manager.start(device, { medium: 'wired' })
    await manager.start(device, { medium: 'wireless' }) // the operator retries at the chassis
    const callsRightAfterRestart = reconnectorState.calls
    await Bun.sleep(1300)
    // Exactly one poll fired in that window, not two (which a leaked first timer would cause).
    expect(reconnectorState.calls).toBe(callsRightAfterRestart + 1)
    expect(manager.get('stable-a')?.medium).toBe('wireless')
  })
})

describe('createCutoverManager — broadcasts (plan 88 §3.4: "a second browser tab sees the same thing")', () => {
  test('every step transition broadcasts device.cutover with the full state', async () => {
    const { manager, broadcasts } = setUp()
    await manager.start(device, { medium: 'wired' })
    expect(broadcasts.length).toBeGreaterThanOrEqual(2) // enabling-tcp, then armed
    for (const msg of broadcasts) {
      expect(msg.type).toBe('device.cutover')
      const payload = (msg as { payload: { state: { stableId: string } } }).payload
      expect(payload.state.stableId).toBe('stable-a')
    }
    const steps = broadcasts.map((m) => (m as { payload: { state: { step: string } } }).payload.state.step)
    expect(steps).toEqual(['enabling-tcp', 'armed'])
  })
})
