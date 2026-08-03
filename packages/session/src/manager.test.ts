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

const DEVICE_ID_2 = 'dev-2'
const snapshot2: DeviceSnapshot = { ...snapshot, id: DEVICE_ID_2, stableId: 'STABLE2', serial: 'SERIAL2' }
const twoDevices: DeviceSnapshotSource = {
  get: (id) => (id === DEVICE_ID ? snapshot : id === DEVICE_ID_2 ? snapshot2 : null),
}

/**
 * Idle session TTL (plan 42 §3.4, §4.4, §7). No fake-clock abstraction exists
 * in `SessionManager` today (it uses `setTimeout`/`Date.now()` directly, the
 * same as the pre-plan-42 5-second grace this replaces) — these tests use
 * short REAL delays via `idleTtlSec` returning fractional seconds, the same
 * style `Bun.sleep` already uses above, rather than introducing a new clock
 * injection seam this late in the plan.
 */
describe('SessionManager — idle session TTL (plan 42 §4.4)', () => {
  test('a release starts an idle timer; a re-acquire inside the window reuses the session without restarting it', async () => {
    let built = 0
    const manager = createSessionManager({
      client: fakeClient(),
      devices,
      log: silentLog(),
      makeScrcpy: async () => {
        built++
        return fakeScrcpy()
      },
      idleTtlSec: () => 0.2, // 200ms
    })

    const onFrame = () => {}
    const first = await manager.acquire(DEVICE_ID, onFrame)
    manager.release(DEVICE_ID, onFrame)
    // Still inside the TTL window — the entry must not have closed yet.
    await Bun.sleep(50)
    expect(manager.get(DEVICE_ID)).not.toBeNull()

    const second = await manager.acquire(DEVICE_ID, onFrame)
    expect(second).toBe(first)
    expect(built).toBe(1)
    await manager.closeAll()
  })

  test('idleTtlSec: 0 closes the session immediately on release — the pre-plan-42 behaviour, exactly', async () => {
    const manager = createSessionManager({
      client: fakeClient(),
      devices,
      log: silentLog(),
      makeScrcpy: async () => fakeScrcpy(),
      idleTtlSec: () => 0,
    })

    const onFrame = () => {}
    await manager.acquire(DEVICE_ID, onFrame)
    manager.release(DEVICE_ID, onFrame)
    // No grace period at all — closeEntry is kicked off synchronously inside
    // `release`; give its async close() a moment to actually finish.
    await Bun.sleep(10)
    expect(manager.get(DEVICE_ID)).toBeNull()
  })

  test('an idle session past its TTL closes on its own', async () => {
    const manager = createSessionManager({
      client: fakeClient(),
      devices,
      log: silentLog(),
      makeScrcpy: async () => fakeScrcpy(),
      idleTtlSec: () => 0.05, // 50ms
    })

    const onFrame = () => {}
    await manager.acquire(DEVICE_ID, onFrame)
    manager.release(DEVICE_ID, onFrame)
    expect(manager.get(DEVICE_ID)).not.toBeNull()
    await Bun.sleep(150)
    expect(manager.get(DEVICE_ID)).toBeNull()
  })

  test('maxIdleSessions evicts the least-recently-idle session immediately once the cap is exceeded', async () => {
    const manager = createSessionManager({
      client: fakeClient(),
      devices: twoDevices,
      log: silentLog(),
      makeScrcpy: async () => fakeScrcpy(),
      idleTtlSec: () => 60, // long enough that only the cap, not the TTL, explains a close
      maxIdleSessions: () => 1,
    })

    const onFrameA = () => {}
    const onFrameB = () => {}
    await manager.acquire(DEVICE_ID, onFrameA)
    await manager.acquire(DEVICE_ID_2, onFrameB)

    // dev-1 goes idle first — it is the oldest idle entry once dev-2 also idles.
    manager.release(DEVICE_ID, onFrameA)
    await Bun.sleep(5)
    manager.release(DEVICE_ID_2, onFrameB)
    await Bun.sleep(10)

    // The cap is 1: dev-1 (idle first) is evicted immediately; dev-2 (idle second) stays.
    expect(manager.get(DEVICE_ID)).toBeNull()
    expect(manager.get(DEVICE_ID_2)).not.toBeNull()
    await manager.closeAll()
  })

  test('closeIfIdle closes an idle session but leaves an actively-viewed one alone (a job must never yank video out from under a watcher)', async () => {
    const manager = createSessionManager({
      client: fakeClient(),
      devices: twoDevices,
      log: silentLog(),
      makeScrcpy: async () => fakeScrcpy(),
      idleTtlSec: () => 60,
    })

    const onFrameA = () => {}
    const onFrameB = () => {}
    await manager.acquire(DEVICE_ID, onFrameA)
    await manager.acquire(DEVICE_ID_2, onFrameB)
    // dev-1 is released (idle); dev-2 keeps its subscriber (actively viewed).
    manager.release(DEVICE_ID, onFrameA)

    await manager.closeIfIdle(DEVICE_ID)
    await manager.closeIfIdle(DEVICE_ID_2)

    expect(manager.get(DEVICE_ID)).toBeNull()
    expect(manager.get(DEVICE_ID_2)).not.toBeNull()
    await manager.closeAll()
  })

  test('idleSessions() reports every idle entry, oldest first', async () => {
    const manager = createSessionManager({
      client: fakeClient(),
      devices: twoDevices,
      log: silentLog(),
      makeScrcpy: async () => fakeScrcpy(),
      idleTtlSec: () => 60,
    })

    const onFrameA = () => {}
    const onFrameB = () => {}
    await manager.acquire(DEVICE_ID, onFrameA)
    await manager.acquire(DEVICE_ID_2, onFrameB)
    manager.release(DEVICE_ID, onFrameA)
    await Bun.sleep(5)
    manager.release(DEVICE_ID_2, onFrameB)

    const idle = manager.idleSessions()
    expect(idle.map((e) => e.deviceId)).toEqual([DEVICE_ID, DEVICE_ID_2])
    await manager.closeAll()
  })
})

/** Quality-profile reuse/upgrade matrix (plan 42 §3.5, §4.5, §7). */
describe('SessionManager — quality profiles (plan 42 §4.5)', () => {
  test('a device not streaming starts at the requested quality', async () => {
    const manager = createSessionManager({
      client: fakeClient(),
      devices,
      log: silentLog(),
      makeScrcpy: async () => fakeScrcpy(),
    })
    const session = await manager.acquire(DEVICE_ID, () => {}, 'wall')
    expect(session.quality).toBe('wall')
    await manager.closeAll()
  })

  test('a wall request against a session already at control quality is shared as-is — never restarted, never downgraded', async () => {
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
    const control = await manager.acquire(DEVICE_ID, () => {}, 'control')
    expect(control.quality).toBe('control')
    const wallViewer = await manager.acquire(DEVICE_ID, () => {}, 'wall')
    expect(wallViewer).toBe(control)
    expect(wallViewer.quality).toBe('control')
    expect(built).toBe(1)
    await manager.closeAll()
  })

  test('a control request against a session already at control quality reuses it', async () => {
    const manager = createSessionManager({
      client: fakeClient(),
      devices,
      log: silentLog(),
      makeScrcpy: async () => fakeScrcpy(),
    })
    const first = await manager.acquire(DEVICE_ID, () => {}, 'control')
    const second = await manager.acquire(DEVICE_ID, () => {}, 'control')
    expect(second).toBe(first)
    await manager.closeAll()
  })

  test('opening Control on a device streaming at wall quality upgrades it: the session restarts at control quality', async () => {
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
    const onFrameWall = () => {}
    const wall = await manager.acquire(DEVICE_ID, onFrameWall, 'wall')
    expect(wall.quality).toBe('wall')
    expect(built).toBe(1)

    const onFrameControl = () => {}
    const control = await manager.acquire(DEVICE_ID, onFrameControl, 'control')
    expect(control.quality).toBe('control')
    expect(control).not.toBe(wall)
    expect(built).toBe(2) // restarted, not reused

    // The wall viewer's subscription survives the restart rather than being dropped.
    expect(manager.get(DEVICE_ID)).toBe(control)
    await manager.closeAll()
  })
})

/**
 * `AdbInput` cannot curve a gesture path (plan 40 §3.6, §4.2, acceptance #8)
 * — the degrade is reported once, at session creation, through the same
 * `onInputDegraded` hook the uhid→sdk degrade already uses. `createEntry`
 * runs exactly once per `DeviceSession` (a second `acquire` for the same
 * device reuses the existing entry), so "once per session" falls out of the
 * existing session-creation flow with no extra bookkeeping needed.
 */
describe('SessionManager — AdbInput gesture degrade reported once per session (plan 40 acceptance #8)', () => {
  test('no scrcpy available (no makeScrcpy) reports the degrade exactly once, even across repeated acquires', async () => {
    const events: { deviceId: string; kind: string; meta: Record<string, unknown> }[] = []
    const manager = createSessionManager({
      client: fakeClient(),
      devices,
      log: silentLog(),
      // No makeScrcpy at all → session.ts falls back to AdbInput.
      onEvent: (deviceId, kind, meta) => events.push({ deviceId, kind, meta }),
    })

    const onFrame = () => {}
    await manager.acquire(DEVICE_ID, onFrame)
    await manager.acquire(DEVICE_ID, onFrame) // same entry, reused — must not re-report
    await manager.acquire(DEVICE_ID, onFrame)

    const degraded = events.filter((e) => e.kind === 'session.degraded')
    expect(degraded.length).toBe(1)
    expect(degraded[0]!.meta.to).toBe('adb-input')
    expect(String(degraded[0]!.meta.reason)).toMatch(/gesture|curve|swipe/i)
    await manager.closeAll()
  })

  test('a session that CAN use scrcpy does not report the adb-input degrade at all', async () => {
    const events: { deviceId: string; kind: string; meta: Record<string, unknown> }[] = []
    const manager = createSessionManager({
      client: fakeClient(),
      devices,
      log: silentLog(),
      makeScrcpy: async () => fakeScrcpy(),
      onEvent: (deviceId, kind, meta) => events.push({ deviceId, kind, meta }),
    })
    await manager.acquire(DEVICE_ID, () => {})
    expect(events.some((e) => e.kind === 'session.degraded' && e.meta.to === 'adb-input')).toBe(false)
    await manager.closeAll()
  })
})
