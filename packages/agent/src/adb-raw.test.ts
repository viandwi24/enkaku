import { describe, expect, test } from 'bun:test'
import type { AdbClient, AdbSocket } from '@enkaku/adb'
import type { AgentToControl } from '@enkaku/protocol'
import type { DeviceSnapshot, DeviceSnapshotSource, Logger } from '@enkaku/session'
import { createAdbRawHost } from './adb-raw'

function fakeLogger(): Logger {
  const noop: Logger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    child: () => noop,
  }
  return noop
}

function fakeSocket() {
  const written: Uint8Array[] = []
  let onData: ((c: Uint8Array) => void) | null = null
  let onEnd: ((err?: unknown) => void) | null = null
  let closeForce: boolean | null = null
  const socket = {
    write(chunk: Uint8Array) {
      written.push(chunk)
    },
    streamFrom(od: (c: Uint8Array) => void, oe: (err?: unknown) => void) {
      onData = od
      onEnd = oe
    },
    close(force = false) {
      closeForce = force
    },
  } as unknown as AdbSocket
  return {
    socket,
    written,
    emit: (c: Uint8Array) => onData?.(c),
    end: (err?: unknown) => onEnd?.(err),
    get closeForce() {
      return closeForce
    },
  }
}

function makeDevices(list: DeviceSnapshot[]): DeviceSnapshotSource {
  const byId = new Map(list.map((d) => [d.id, d]))
  return { get: (id) => byId.get(id) ?? null }
}

const DEVICE: DeviceSnapshot = {
  id: 'dev-1',
  stableId: 'stable-1',
  serial: 'SERIAL-1',
  label: 'Phone',
  status: 'idle',
  androidVersion: '13',
  apiLevel: 33,
  screenW: 1080,
  screenH: 2400,
  transport: 'adb-usb',
  display: 'scrcpy',
  input: 'scrcpy-uhid',
  inspection: 'ui-server',
  preferredInputMode: 'uhid',
}

describe('createAdbRawHost (plan 28 §4.3) — open/pipe/close', () => {
  test('openRequest opens a raw socket, replies ok:true, and pipes backend data as tunnel frames', async () => {
    const sent: AgentToControl[] = []
    const frames: Array<{ channelId: number; payload: Uint8Array }> = []
    const fake = fakeSocket()
    const client = { openRaw: async (serial: string, service: string) => fake.socket } as unknown as AdbClient
    const host = createAdbRawHost({
      client,
      devices: makeDevices([DEVICE]),
      send: (msg) => sent.push(msg),
      sendFrame: (channelId, payload) => frames.push({ channelId, payload }),
      log: fakeLogger(),
    })

    await host.openRequest({ id: 'req-1', payload: { deviceId: 'dev-1', service: 'shell:echo hi', channelId: 5 } })

    expect(sent).toEqual([{ type: 'adb.open.reply', id: 'req-1', payload: { ok: true } }])

    fake.emit(new TextEncoder().encode('device output'))
    expect(frames).toEqual([{ channelId: 5, payload: new TextEncoder().encode('device output') }])
  })

  test('openRequest against an unknown device replies device_not_found without calling openRaw', async () => {
    const sent: AgentToControl[] = []
    let openRawCalled = false
    const client = { openRaw: async () => ((openRawCalled = true), fakeSocket().socket) } as unknown as AdbClient
    const host = createAdbRawHost({
      client,
      devices: makeDevices([]),
      send: (msg) => sent.push(msg),
      sendFrame: () => {},
      log: fakeLogger(),
    })

    await host.openRequest({ id: 'req-1', payload: { deviceId: 'dev-missing', service: 'shell:x', channelId: 1 } })

    expect(openRawCalled).toBe(false)
    expect(sent).toEqual([{ type: 'adb.open.reply', id: 'req-1', payload: { ok: false, error: { code: 'device_not_found', message: 'no such device: dev-missing' } } }])
  })

  test('handleFrame writes downstream and emits adb.ack with the byte count — the delivery acknowledgement §3.3 depends on', async () => {
    const sent: AgentToControl[] = []
    const fake = fakeSocket()
    const client = { openRaw: async () => fake.socket } as unknown as AdbClient
    const host = createAdbRawHost({
      client,
      devices: makeDevices([DEVICE]),
      send: (msg) => sent.push(msg),
      sendFrame: () => {},
      log: fakeLogger(),
    })
    await host.openRequest({ id: 'req-1', payload: { deviceId: 'dev-1', service: 'sync:', channelId: 7 } })
    sent.length = 0 // drop the open.reply

    const chunk = new TextEncoder().encode('twelve bytes')
    host.handleFrame(7, chunk)

    expect(fake.written).toEqual([chunk])
    expect(sent).toEqual([{ type: 'adb.ack', payload: { channelId: 7, bytes: chunk.length } }])
  })

  test('handleFrame for an unknown channel is a harmless no-op', () => {
    const sent: AgentToControl[] = []
    const client = { openRaw: async () => fakeSocket().socket } as unknown as AdbClient
    const host = createAdbRawHost({ client, devices: makeDevices([DEVICE]), send: (msg) => sent.push(msg), sendFrame: () => {}, log: fakeLogger() })
    expect(() => host.handleFrame(999, new Uint8Array([1]))).not.toThrow()
    expect(sent).toEqual([])
  })

  test('close({reason:"reset"}) force-closes the socket; close({reason:"closed"}) does not', async () => {
    const fakeA = fakeSocket()
    const fakeB = fakeSocket()
    let call = 0
    const client = { openRaw: async () => [fakeA.socket, fakeB.socket][call++] } as unknown as AdbClient
    const host = createAdbRawHost({ client, devices: makeDevices([DEVICE]), send: () => {}, sendFrame: () => {}, log: fakeLogger() })
    await host.openRequest({ id: '1', payload: { deviceId: 'dev-1', service: 'shell:a', channelId: 1 } })
    await host.openRequest({ id: '2', payload: { deviceId: 'dev-1', service: 'shell:b', channelId: 2 } })

    host.close({ channelId: 1, reason: 'reset' })
    host.close({ channelId: 2, reason: 'closed' })

    expect(fakeA.closeForce).toBe(true)
    expect(fakeB.closeForce).toBe(false)
  })

  test('the backend ending (device/agent-adb side) sends adb.close exactly once and frees the per-device slot', async () => {
    const sent: AgentToControl[] = []
    const fake = fakeSocket()
    const client = { openRaw: async () => fake.socket } as unknown as AdbClient
    const host = createAdbRawHost({ client, devices: makeDevices([DEVICE]), send: (msg) => sent.push(msg), sendFrame: () => {}, log: fakeLogger() })
    await host.openRequest({ id: '1', payload: { deviceId: 'dev-1', service: 'shell:x', channelId: 3 } })
    sent.length = 0

    fake.end()
    expect(sent).toEqual([{ type: 'adb.close', payload: { channelId: 3, reason: 'closed' } }])

    // A frame for the now-closed channel is a no-op, not a crash or a second adb.close.
    host.handleFrame(3, new Uint8Array([1]))
    expect(sent).toEqual([{ type: 'adb.close', payload: { channelId: 3, reason: 'closed' } }])
  })

  test('channelClosed (defence in depth) force-closes the socket without a device-side leak', async () => {
    const fake = fakeSocket()
    const client = { openRaw: async () => fake.socket } as unknown as AdbClient
    const host = createAdbRawHost({ client, devices: makeDevices([DEVICE]), send: () => {}, sendFrame: () => {}, log: fakeLogger() })
    await host.openRequest({ id: '1', payload: { deviceId: 'dev-1', service: 'shell:x', channelId: 4 } })

    host.channelClosed(4)
    expect(fake.closeForce).toBe(true)
  })

  test('closeAll force-closes every open stream', async () => {
    const fakeA = fakeSocket()
    const fakeB = fakeSocket()
    let call = 0
    const client = { openRaw: async () => [fakeA.socket, fakeB.socket][call++] } as unknown as AdbClient
    const host = createAdbRawHost({ client, devices: makeDevices([DEVICE]), send: () => {}, sendFrame: () => {}, log: fakeLogger() })
    await host.openRequest({ id: '1', payload: { deviceId: 'dev-1', service: 'shell:a', channelId: 1 } })
    await host.openRequest({ id: '2', payload: { deviceId: 'dev-1', service: 'shell:b', channelId: 2 } })

    await host.closeAll()

    expect(fakeA.closeForce).toBe(true)
    expect(fakeB.closeForce).toBe(true)
  })
})

describe('createAdbRawHost — the per-device stream cap (plan 28 §4.3, acceptance #8)', () => {
  const CAP = 32 // the settings schema's own max (`z.number().int().min(1).max(32)`) — see the comment on MAX_STREAMS_PER_DEVICE

  test('the (CAP+1)th concurrent stream for one device is refused with a coded error; the existing streams keep working', async () => {
    const sent: AgentToControl[] = []
    const sockets = Array.from({ length: CAP + 1 }, () => fakeSocket())
    let call = 0
    const client = { openRaw: async () => sockets[call++]!.socket } as unknown as AdbClient
    const host = createAdbRawHost({ client, devices: makeDevices([DEVICE]), send: (msg) => sent.push(msg), sendFrame: () => {}, log: fakeLogger() })

    for (let i = 0; i < CAP; i++) {
      await host.openRequest({ id: `req-${i}`, payload: { deviceId: 'dev-1', service: `shell:${i}`, channelId: i } })
    }
    expect(sent.every((m) => m.type === 'adb.open.reply' && m.payload.ok)).toBe(true)
    expect(call).toBe(CAP)

    sent.length = 0
    await host.openRequest({ id: 'req-over', payload: { deviceId: 'dev-1', service: 'shell:over', channelId: CAP } })
    expect(call).toBe(CAP) // openRaw never called past the cap
    expect(sent).toEqual([
      {
        type: 'adb.open.reply',
        id: 'req-over',
        payload: { ok: false, error: { code: 'E_ADB_STREAM_LIMIT', message: `this agent already has ${CAP} adb streams open for dev-1` } },
      },
    ])

    // An existing stream is unaffected by the refusal.
    sent.length = 0
    host.handleFrame(0, new TextEncoder().encode('still works'))
    expect(sent).toEqual([{ type: 'adb.ack', payload: { channelId: 0, bytes: 'still works'.length } }])
  })

  test('freeing a slot (the backend ending) lets a new stream open again', async () => {
    const sockets = Array.from({ length: CAP + 1 }, () => fakeSocket())
    let call = 0
    const client = { openRaw: async () => sockets[call++]!.socket } as unknown as AdbClient
    const host = createAdbRawHost({ client, devices: makeDevices([DEVICE]), send: () => {}, sendFrame: () => {}, log: fakeLogger() })
    for (let i = 0; i < CAP; i++) {
      await host.openRequest({ id: `req-${i}`, payload: { deviceId: 'dev-1', service: `shell:${i}`, channelId: i } })
    }
    sockets[0]!.end() // stream 0 ends, freeing its slot

    await host.openRequest({ id: 'req-over', payload: { deviceId: 'dev-1', service: 'shell:over', channelId: CAP } })
    expect(call).toBe(CAP + 1) // openRaw WAS called this time — the slot was free
  })
})
