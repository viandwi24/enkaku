import { describe, expect, test } from 'bun:test'
import type { AdbClient, TrackedDevice } from '@enkaku/adb'
import { AdbTcpTransport, AdbUsbTransport } from './adb-transport'

/** Records every `listDevices`/`connectDevice`/`disconnectDevice` call; `listDevices` answers from `snapshot`. */
function fakeClient(snapshot: TrackedDevice[]): { client: AdbClient; connectCalls: string[]; disconnectCalls: string[] } {
  const connectCalls: string[] = []
  const disconnectCalls: string[] = []
  const client = {
    listDevices: async () => snapshot,
    connectDevice: async (hostPort: string) => {
      connectCalls.push(hostPort)
      return 'connected to ' + hostPort
    },
    disconnectDevice: async (hostPort: string) => {
      disconnectCalls.push(hostPort)
      return 'disconnected ' + hostPort
    },
  } as unknown as AdbClient
  return { client, connectCalls, disconnectCalls }
}

/**
 * Plan 88 §3.7, §5 step 88.1 — `AdbTcpTransport.connect()` becomes
 * ensure-connected and `disconnect()` becomes a documented no-op, fixing F12
 * (`DeviceSession.close()` used to drop the WHOLE farm transport for a
 * wireless/OTG device, not just the session) and its consequence H6 (that
 * device could then be unrecoverable from Studio).
 */
describe('AdbTcpTransport.connect — ensure-connected, not connect (plan 88 §3.7)', () => {
  test('a no-op when adb already lists the serial as device — no redundant host:connect', async () => {
    const { client, connectCalls } = fakeClient([{ serial: '10.20.0.37:5555', state: 'device' }])
    const transport = new AdbTcpTransport({ client, serial: '10.20.0.37:5555', stableId: 'STABLE1' })
    await transport.connect()
    expect(connectCalls).toEqual([])
  })

  test('dials when adb does not already have it — the pre-88.2 fallback, unchanged in effect', async () => {
    const { client, connectCalls } = fakeClient([])
    const transport = new AdbTcpTransport({ client, serial: '10.20.0.37:5555', stableId: 'STABLE1' })
    await transport.connect()
    expect(connectCalls).toEqual(['10.20.0.37:5555'])
  })

  test('dials when adb lists the serial but in a non-device state (e.g. offline)', async () => {
    const { client, connectCalls } = fakeClient([{ serial: '10.20.0.37:5555', state: 'offline' }])
    const transport = new AdbTcpTransport({ client, serial: '10.20.0.37:5555', stableId: 'STABLE1' })
    await transport.connect()
    expect(connectCalls).toEqual(['10.20.0.37:5555'])
  })

  test('only checks its own serial — another device already up does not short-circuit the dial', async () => {
    const { client, connectCalls } = fakeClient([{ serial: '10.20.0.99:5555', state: 'device' }])
    const transport = new AdbTcpTransport({ client, serial: '10.20.0.37:5555', stableId: 'STABLE1' })
    await transport.connect()
    expect(connectCalls).toEqual(['10.20.0.37:5555'])
  })
})

describe('AdbTcpTransport.disconnect — a documented no-op (plan 88 §3.7, fixes F12/H6)', () => {
  test('never calls host:disconnect — the device stays connected in adb devices', async () => {
    const { client, disconnectCalls } = fakeClient([{ serial: '10.20.0.37:5555', state: 'device' }])
    const transport = new AdbTcpTransport({ client, serial: '10.20.0.37:5555', stableId: 'STABLE1' })
    await transport.disconnect()
    expect(disconnectCalls).toEqual([])
  })

  test('safe to call more than once, same as every other idempotent close-time thunk in this repo', async () => {
    const { client, disconnectCalls } = fakeClient([])
    const transport = new AdbTcpTransport({ client, serial: '10.20.0.37:5555', stableId: 'STABLE1' })
    await transport.disconnect()
    await transport.disconnect()
    expect(disconnectCalls).toEqual([])
  })
})

describe('AdbUsbTransport.connect/disconnect — unchanged: already no-ops', () => {
  test('connect never touches the client', async () => {
    const { client, connectCalls } = fakeClient([])
    const transport = new AdbUsbTransport({ client, serial: 'ZP2222RMBS', stableId: 'STABLE1' })
    await transport.connect()
    expect(connectCalls).toEqual([])
  })

  test('disconnect never touches the client', async () => {
    const { client, disconnectCalls } = fakeClient([])
    const transport = new AdbUsbTransport({ client, serial: 'ZP2222RMBS', stableId: 'STABLE1' })
    await transport.disconnect()
    expect(disconnectCalls).toEqual([])
  })
})
