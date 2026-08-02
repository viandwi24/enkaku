import { describe, expect, test } from 'bun:test'
import type { AdbClient } from '@enkaku/adb'
import type { ScrcpySession } from '@enkaku/scrcpy'
import { createSessionManager } from './manager'
import type { DeviceSnapshot, DeviceSnapshotSource } from './types'
import type { Logger } from './logger'

const DEVICE_ID = 'dev-1'

const snapshot: DeviceSnapshot = {
  id: DEVICE_ID,
  stableId: 'STABLE1',
  serial: 'SERIAL1',
  label: 'test phone',
  status: 'idle',
  androidVersion: '15',
  apiLevel: 35,
  screenW: 720,
  screenH: 1640,
  transport: 'adb-usb',
  display: 'scrcpy',
  input: 'scrcpy-uhid',
  inspection: 'uiautomator-dump',
  preferredInputMode: 'uhid',
  keepAwake: 'off',
  standbyScreenOff: false,
}

const devices: DeviceSnapshotSource = { get: (id) => (id === DEVICE_ID ? snapshot : null) }

const silentLog = (): Logger => {
  const l = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    child: () => l,
  }
  return l as unknown as Logger
}

/** Every shell command succeeds instantly; nothing touches a real device. */
const fakeClient = () => ({ exec: async () => '', execOut: async () => new Uint8Array() }) as unknown as AdbClient

/** A scrcpy session that never produces frames and never closes on its own. */
function fakeScrcpy(): ScrcpySession {
  const closeHandlers = new Set<(reason: string) => void>()
  return {
    meta: { deviceName: 'test phone', codec: 'h264', width: 704, height: 1600 },
    onPacket: () => {},
    onMetaChange: () => {},
    onClose: (cb: (reason: string) => void) => void closeHandlers.add(cb),
    control: {
      injectTouch: () => {},
      injectKeycode: () => {},
      injectText: () => {},
      uhidCreate: () => {},
      uhidInput: () => {},
      uhidDestroy: () => {},
      setDisplayPower: () => {},
      resetVideo: () => {},
    },
    close: async () => {
      for (const cb of closeHandlers) cb('closed by test')
    },
  } as unknown as ScrcpySession
}

describe('SessionManager.acquire', () => {
  /**
   * The bug this guards: `acquire` checked `entries`, then awaited session
   * creation with nothing marking the device as busy. Two `stream.start`
   * messages 50 ms apart therefore both saw an empty map and both built a
   * session — two scrcpy servers for one phone. The second registration
   * orphaned the first, and when the orphan's socket later closed it tore down
   * whichever session was current, killing a healthy stream.
   */
  test('concurrent acquires for one device build exactly one session', async () => {
    let built = 0
    const manager = createSessionManager({
      client: fakeClient(),
      devices,
      log: silentLog(),
      makeScrcpy: async () => {
        built++
        // Long enough that every caller below is inside the same window.
        await Bun.sleep(30)
        return fakeScrcpy()
      },
    })

    const sessions = await Promise.all([
      manager.acquire(DEVICE_ID, () => {}),
      manager.acquire(DEVICE_ID, () => {}),
      manager.acquire(DEVICE_ID, () => {}),
    ])

    expect(built).toBe(1)
    // All three callers must hold the same session, not copies of it.
    expect(sessions[0]).toBe(sessions[1])
    expect(sessions[1]).toBe(sessions[2])
    await manager.closeAll()
  })

  test('every concurrent caller is subscribed, so one release does not end the stream', async () => {
    const frames: string[] = []
    const manager = createSessionManager({
      client: fakeClient(),
      devices,
      log: silentLog(),
      makeScrcpy: async () => {
        await Bun.sleep(20)
        return fakeScrcpy()
      },
    })

    const a = () => frames.push('a')
    const b = () => frames.push('b')
    await Promise.all([manager.acquire(DEVICE_ID, a), manager.acquire(DEVICE_ID, b)])

    // Refcount must be 2: releasing one viewer leaves the session serving the other.
    manager.release(DEVICE_ID, a)
    expect(manager.get(DEVICE_ID)).not.toBeNull()
    await manager.closeAll()
  })

  /**
   * Closing a session ends its sockets, which fires `onDisplayError` a moment
   * later. Without an ownership check that late callback tore down whatever
   * entry was current by then — including a replacement created in between.
   */
  test('a session that is no longer current cannot close its replacement', async () => {
    let built = 0
    const manager = createSessionManager({
      client: fakeClient(),
      devices,
      log: silentLog(),
      makeScrcpy: async () => {
        built++
        return fakeScrcpy()
      },
    })

    await manager.acquire(DEVICE_ID, () => {})
    // closeAll ends the fake scrcpy session, which fires its close handlers.
    await manager.closeAll()
    expect(manager.get(DEVICE_ID)).toBeNull()

    // A fresh session for the same device must survive the previous one's
    // death notification.
    const second = await manager.acquire(DEVICE_ID, () => {})
    expect(built).toBe(2)
    await Bun.sleep(10)
    expect(manager.get(DEVICE_ID)).toBe(second)
    await manager.closeAll()
  })
})
