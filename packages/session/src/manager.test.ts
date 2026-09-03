import { describe, expect, test } from 'bun:test'
import type { AdbClient } from '@enkaku/adb'
import type { GuestAgentClientRunner } from '@enkaku/drivers'
import type { ScrcpySession } from '@enkaku/scrcpy'
import { createSessionManager } from './manager'
import type { DeviceSnapshot, DeviceSnapshotSource } from './types'
import type { Logger } from './logger'
import type { VideoProfile } from './video-profile'

const DEVICE_ID = 'dev-1'

const snapshot: DeviceSnapshot = {
  id: DEVICE_ID,
  stableId: 'STABLE1',
  serial: 'SERIAL1',
  label: 'test phone',
  status: 'online',
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

  test('a wall request against a device already at control quality builds its OWN entry — plan 100 §4.2, two independent slots, never shared', async () => {
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
    expect(wallViewer).not.toBe(control)
    expect(wallViewer.quality).toBe('wall')
    expect(built).toBe(2) // two independent, concurrent scrcpy sessions
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

  test('opening Control on a device streaming at wall quality does NOT restart the wall entry — plan 100 §3.2, a second independent entry instead', async () => {
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
    expect(built).toBe(2) // a SECOND, independent session — the wall entry was never rebuilt

    // Both slots stay open and independently addressable — `get` resolves
    // the highest-quality one (control); `getByQuality` reaches either.
    expect(manager.get(DEVICE_ID)).toBe(control)
    expect(manager.getByQuality!(DEVICE_ID, 'wall')).toBe(wall)
    expect(manager.getByQuality!(DEVICE_ID, 'control')).toBe(control)
    await manager.closeAll()
  })
})

/**
 * Plan 100 §3.2, §4.2, §5 step 100.4 — the second entry slot itself. G8's
 * restart is gone; a `control` acquire against an open `wall` entry now
 * builds a second, independent session and skips the wake/rotate/text-input/
 * farm-tag sequence entirely, because the open wall entry is live proof it
 * already ran. `PREP_DEVICE_ID`'s snapshot is deliberately NOT the shared
 * `devices`/`snapshot` fixture above: `keepAwake: 'off'` and no rotation/
 * text-input/guest-agent wiring there mean those four calls are already
 * no-ops for every OTHER test in this file regardless of `skipDevicePrep` —
 * which would make a "zero calls" assertion vacuous. This fixture is built
 * so the ordinary (non-fast) path provably WOULD issue every one of those
 * commands, so the fast path's zero-calls property is actually exercised.
 */
describe('SessionManager — the fast-path control entry (plan 100 §3.2, §4.2, §5 step 100.4)', () => {
  const PREP_DEVICE_ID = 'dev-prep'
  const prepSnapshot: DeviceSnapshot = {
    ...snapshot,
    id: PREP_DEVICE_ID,
    stableId: 'STABLE-PREP',
    serial: 'SERIAL-PREP',
    keepAwake: 'while-charging', // wakeDevice sends KEYCODE_WAKEUP + svc power stayon when NOT skipped
    rotation: 'lock-portrait', // applyRotation reads+writes accelerometer_rotation/user_rotation when NOT skipped
    textInput: 'auto', // applyTextInput enables+sets the Enkaku IME when a capable agent is wired and NOT skipped
  }
  const prepDevices: DeviceSnapshotSource = { get: (id) => (id === PREP_DEVICE_ID ? prepSnapshot : null) }

  /** Every shell command succeeds instantly AND is recorded, so a test can
   * assert exactly which commands were (or were not) sent. */
  function trackingClient(): { client: AdbClient; calls: string[] } {
    const calls: string[] = []
    const client = {
      exec: async (_serial: string, cmd: string) => {
        calls.push(cmd)
        return ''
      },
      execOut: async () => new Uint8Array(),
    } as unknown as AdbClient
    return { client, calls }
  }

  /** A guest-agent runner whose `hello()` advertises `text-input` — the one
   * capability `applyTextInput`'s `'auto'` mode actually acts on. Mirrors
   * `text-input.test.ts`'s own `fakeRunner` helper. */
  function fakeTextInputAgent(): GuestAgentClientRunner {
    return (async (fn: (client: unknown) => unknown) => fn({ hello: async () => ({ capabilities: ['text-input'] }) })) as unknown as GuestAgentClientRunner
  }

  test('the fast path issues ZERO wake/text-input/farm-tag commands — the wall entry is live proof they already ran — but DOES re-assert the rotation lock', async () => {
    const { client, calls } = trackingClient()
    let scrcpyBuilds = 0
    const manager = createSessionManager({
      client,
      devices: prepDevices,
      log: silentLog(),
      withGuestAgentClient: () => fakeTextInputAgent(),
      makeScrcpy: async () => {
        scrcpyBuilds++
        return fakeScrcpy()
      },
    })

    // Baseline: the ORDINARY path (wall, first entry for this device) DOES
    // issue every one of these commands with this fixture — proving the
    // fixture is not vacuously silent regardless of skipDevicePrep.
    const wallSession = await manager.acquire(PREP_DEVICE_ID, () => {}, 'wall')
    expect(calls.some((c) => c.includes('KEYCODE_WAKEUP'))).toBe(true)
    expect(calls.some((c) => c.includes('stayon'))).toBe(true)
    expect(calls.some((c) => c.includes('accelerometer_rotation') || c.includes('user_rotation'))).toBe(true)
    expect(calls.some((c) => c.includes('debug.enkaku.instrumented'))).toBe(true)
    // Text input is the one member of this baseline that is NO LONGER issued
    // at build time: plan 125 §3.8 (step 125.8) moved the guest-agent
    // bootstrap off the critical line, so it runs after the first frame or on
    // demand, never between the click and the picture. Driven explicitly here
    // so the fixture still proves it is not vacuously silent — which is what
    // makes the fast path's own `ime`-free assertion below mean something.
    expect(calls.some((c) => c.startsWith('ime '))).toBe(false)
    await wallSession.whenTextInputReady?.()
    expect(calls.some((c) => c.startsWith('ime '))).toBe(true)

    calls.length = 0 // isolate the SECOND (control, fast-path) build's own commands
    await manager.acquire(PREP_DEVICE_ID, () => {}, 'control')

    expect(scrcpyBuilds).toBe(2) // two independent, concurrent scrcpy sessions (G12)
    expect(calls.some((c) => c.includes('KEYCODE_WAKEUP'))).toBe(false)
    expect(calls.some((c) => c.includes('stayon'))).toBe(false)
    expect(calls.some((c) => c.startsWith('ime '))).toBe(false)
    expect(calls.some((c) => c.includes('debug.enkaku.instrumented'))).toBe(false)
    // Rotation is the ONE member of §4.2's skip list that is NOT skipped, and
    // the asymmetry is the point (plan 85 §3.7): waking a device that is
    // already awake is genuinely redundant, but the wall entry may have been
    // opened BEFORE the operator changed this setting, or with a different
    // value, or its own write may have been declined. So the fast build
    // re-asserts — two writes and their read-back confirmation, and NOTHING
    // ELSE. Note what is absent from the front of this list: the two capture
    // reads. The fast build captures nothing and reverts nothing; the still-
    // open wall entry remains the sole owner of the device's pre-farm state.
    expect(calls).toEqual([
      'settings put system accelerometer_rotation 0',
      'settings put system user_rotation 0',
      'settings get system accelerometer_rotation',
      'settings get system user_rotation',
    ])

    await manager.closeAll()
  })

  /**
   * Plan 85 §3.7 — the defect the farm owner reported: `prep.rotation` was
   * apply-once at session creation, so changing it while a wall tile was
   * streaming did nothing at all, and the UI said it had worked.
   */
  test('setRotation re-locks the session that is already running, through the entry that owns device prep', async () => {
    const { client, calls } = trackingClient()
    const manager = createSessionManager({
      client,
      devices: prepDevices,
      log: silentLog(),
      makeScrcpy: async () => fakeScrcpy(),
    })

    await manager.acquire(PREP_DEVICE_ID, () => {}, 'wall')
    await manager.acquire(PREP_DEVICE_ID, () => {}, 'control')
    calls.length = 0

    const outcome = await manager.setRotation!(PREP_DEVICE_ID, 'lock-landscape')
    expect(outcome?.mode).toBe('lock-landscape')
    // Written ONCE, not once per open entry: there is one physical screen.
    expect(calls.filter((c) => c === 'settings put system user_rotation 1').length).toBe(1)
    // And no second capture — the wall entry's own capture, taken before it
    // ever wrote anything, is what `close()` restores.
    expect(calls.filter((c) => c.startsWith('settings get')).length).toBe(2) // the read-back pair only

    await manager.closeAll()
  })

  test('setRotation on a device with no open session reports null rather than inventing a failure', async () => {
    const { client } = trackingClient()
    const manager = createSessionManager({ client, devices: prepDevices, log: silentLog(), makeScrcpy: async () => fakeScrcpy() })
    expect(await manager.setRotation!(PREP_DEVICE_ID, 'lock-portrait')).toBeNull()
  })

  test('a device with no open wall entry still gets the full, unchanged control acquire — no regression for an operator who never uses the Wall', async () => {
    const { client, calls } = trackingClient()
    const manager = createSessionManager({
      client,
      devices: prepDevices,
      log: silentLog(),
      withGuestAgentClient: () => fakeTextInputAgent(),
      makeScrcpy: async () => fakeScrcpy(),
    })

    await manager.acquire(PREP_DEVICE_ID, () => {}, 'control')
    expect(calls.some((c) => c.includes('KEYCODE_WAKEUP'))).toBe(true)
    expect(calls.some((c) => c.includes('stayon'))).toBe(true)
    expect(calls.some((c) => c.includes('debug.enkaku.instrumented'))).toBe(true)
    await manager.closeAll()
  })

  test('the wall entry is never touched: its makeScrcpy build count and its session identity stay unchanged when control is acquired afterward', async () => {
    let scrcpyBuilds = 0
    const phases: Array<{ deviceId: string; phase: string }> = []
    const manager = createSessionManager({
      client: trackingClient().client,
      devices: prepDevices,
      log: silentLog(),
      withGuestAgentClient: () => fakeTextInputAgent(),
      onPhase: (deviceId, phase) => phases.push({ deviceId, phase }),
      makeScrcpy: async () => {
        scrcpyBuilds++
        return fakeScrcpy()
      },
    })

    const wall = await manager.acquire(PREP_DEVICE_ID, () => {}, 'wall')
    expect(scrcpyBuilds).toBe(1)
    phases.length = 0 // isolate the control build's own phase events

    const control = await manager.acquire(PREP_DEVICE_ID, () => {}, 'control')
    expect(control).not.toBe(wall)
    expect(scrcpyBuilds).toBe(2) // the wall entry's own build count did NOT increment
    // No phase events at all landed for the wall session's own entry — a
    // restart would have re-emitted 'connecting'/'waking'/... for it.
    expect(phases.filter((p) => p.deviceId === PREP_DEVICE_ID).length).toBeGreaterThan(0) // the control build itself DID report phases
    expect(phases.some((p) => p.phase === 'waking')).toBe(false) // fast path: no wake-phase breadcrumb (§5 step 100.5)
    // The wall entry is still reachable, unchanged, at its own slot.
    expect(manager.getByQuality!(PREP_DEVICE_ID, 'wall')).toBe(wall)

    await manager.closeAll()
  })

  test('releasing the control entry does not affect the wall entry refcount, or vice versa', async () => {
    const manager = createSessionManager({
      client: trackingClient().client,
      devices: prepDevices,
      log: silentLog(),
      idleTtlSec: () => 0, // close immediately on refcount 0, so a wrong-slot release is observable right away
      withGuestAgentClient: () => fakeTextInputAgent(),
      makeScrcpy: async () => fakeScrcpy(),
    })

    const onWall = () => {}
    const onControl = () => {}
    await manager.acquire(PREP_DEVICE_ID, onWall, 'wall')
    await manager.acquire(PREP_DEVICE_ID, onControl, 'control')
    expect(manager.getByQuality!(PREP_DEVICE_ID, 'wall')).not.toBeNull()
    expect(manager.getByQuality!(PREP_DEVICE_ID, 'control')).not.toBeNull()

    manager.release(PREP_DEVICE_ID, onControl)
    // Control closed (idleTtlSec 0); the wall entry is completely unaffected.
    expect(manager.getByQuality!(PREP_DEVICE_ID, 'control')).toBeNull()
    expect(manager.getByQuality!(PREP_DEVICE_ID, 'wall')).not.toBeNull()

    manager.release(PREP_DEVICE_ID, onWall)
    expect(manager.getByQuality!(PREP_DEVICE_ID, 'wall')).toBeNull()

    await manager.closeAll()
  })

  test('a fast-path build that cannot produce a real scrcpy session throws E_CONTROL_SESSION_UNAVAILABLE, never falls back to screencap-loop under the Control label, and leaves the wall entry untouched', async () => {
    let scrcpyBuilds = 0
    const manager = createSessionManager({
      client: trackingClient().client,
      devices: prepDevices,
      log: silentLog(),
      withGuestAgentClient: () => fakeTextInputAgent(),
      makeScrcpy: async (_deviceId, _transport, profile) => {
        scrcpyBuilds++
        // The wall build (profile.maxFps === 5, this fixture's own wall
        // default) succeeds; the control (fast-path) build fails — the
        // shape H2 names: a platform rejection, not a hang.
        if (scrcpyBuilds > 1) throw new Error('encoder busy: only one concurrent MediaCodec session on this chipset')
        return fakeScrcpy()
      },
    })

    const wall = await manager.acquire(PREP_DEVICE_ID, () => {}, 'wall')
    await expect(manager.acquire(PREP_DEVICE_ID, () => {}, 'control')).rejects.toMatchObject({
      code: 'E_CONTROL_SESSION_UNAVAILABLE',
    })

    // No control entry was left behind — a bare `get`/`getByQuality` proves it.
    expect(manager.getByQuality!(PREP_DEVICE_ID, 'control')).toBeNull()
    // The wall entry is completely untouched — same object, still open.
    expect(manager.getByQuality!(PREP_DEVICE_ID, 'wall')).toBe(wall)
    expect(manager.get(PREP_DEVICE_ID)).toBe(wall) // highest-quality-wins falls back to wall since control never opened

    await manager.closeAll()
  })

  test('a device deliberately configured for screencap-loop is never reported as "control unavailable" — the fast path just builds its own screencap-loop entry', async () => {
    const screencapOnlySnapshot: DeviceSnapshot = { ...prepSnapshot, id: 'dev-screencap-only', display: 'screencap-loop' }
    const source: DeviceSnapshotSource = { get: (id) => (id === 'dev-screencap-only' ? screencapOnlySnapshot : null) }
    const manager = createSessionManager({
      client: trackingClient().client,
      devices: source,
      log: silentLog(),
      withGuestAgentClient: () => fakeTextInputAgent(),
      // makeScrcpy is never even called for this device (opts.display === 'screencap-loop').
      makeScrcpy: async () => fakeScrcpy(),
    })

    await manager.acquire('dev-screencap-only', () => {}, 'wall')
    const control = await manager.acquire('dev-screencap-only', () => {}, 'control')
    expect(control.displayEngineId).toBe('screencap-loop')
    await manager.closeAll()
  })

  test('closeDevice closes BOTH open entries for a device, not just one', async () => {
    const closedReasons: string[] = []
    const manager = createSessionManager({
      client: trackingClient().client,
      devices: prepDevices,
      log: silentLog(),
      withGuestAgentClient: () => fakeTextInputAgent(),
      onEvent: (_deviceId, kind, meta) => {
        if (kind === 'session.closed') closedReasons.push(String(meta.reason))
      },
      makeScrcpy: async () => fakeScrcpy(),
    })

    await manager.acquire(PREP_DEVICE_ID, () => {}, 'wall')
    await manager.acquire(PREP_DEVICE_ID, () => {}, 'control')
    await manager.closeDevice(PREP_DEVICE_ID)

    expect(manager.getByQuality!(PREP_DEVICE_ID, 'wall')).toBeNull()
    expect(manager.getByQuality!(PREP_DEVICE_ID, 'control')).toBeNull()
    expect(closedReasons.filter((r) => r === 'device_gone').length).toBe(2)
  })

  test('closeIfIdle closes every IDLE slot a device holds, but leaves an actively-viewed slot alone', async () => {
    const manager = createSessionManager({
      client: trackingClient().client,
      devices: prepDevices,
      log: silentLog(),
      idleTtlSec: () => 60, // long enough that release() alone would not close it
      withGuestAgentClient: () => fakeTextInputAgent(),
      makeScrcpy: async () => fakeScrcpy(),
    })

    const onWall = () => {}
    const onControl = () => {}
    await manager.acquire(PREP_DEVICE_ID, onWall, 'wall')
    manager.release(PREP_DEVICE_ID, onWall) // refcount 0, idleSince set — idle, but not yet TTL-closed (idleTtlSec: 60)
    await manager.acquire(PREP_DEVICE_ID, onControl, 'control') // stays subscribed — active

    await manager.closeIfIdle(PREP_DEVICE_ID)

    expect(manager.getByQuality!(PREP_DEVICE_ID, 'wall')).toBeNull() // idle — closed
    expect(manager.getByQuality!(PREP_DEVICE_ID, 'control')).not.toBeNull() // actively viewed — untouched

    manager.release(PREP_DEVICE_ID, onControl)
    await manager.closeAll()
  })

  test('videoStats reports both slots for a device, each with its own quality and profile', async () => {
    const manager = createSessionManager({
      client: trackingClient().client,
      devices: prepDevices,
      log: silentLog(),
      withGuestAgentClient: () => fakeTextInputAgent(),
      makeScrcpy: async () => fakeScrcpy(),
      resolveProfile: (_deviceId, quality) =>
        quality === 'control'
          ? { quality, maxSize: 1600, maxFps: 30, bitRate: 4_000_000, source: { maxSize: 'preset', maxFps: 'preset', bitRate: 'preset' } }
          : { quality, maxSize: 480, maxFps: 5, bitRate: 800_000, source: { maxSize: 'preset', maxFps: 'preset', bitRate: 'preset' } },
    })

    await manager.acquire(PREP_DEVICE_ID, () => {}, 'wall')
    await manager.acquire(PREP_DEVICE_ID, () => {}, 'control')

    const stats = manager.videoStats!()
    expect(stats.streams).toEqual({ control: 1, wall: 1 })
    expect(stats.profiles).toEqual(
      expect.arrayContaining([
        { deviceId: PREP_DEVICE_ID, quality: 'control', maxSize: 1600, maxFps: 30, bitRate: 4_000_000 },
        { deviceId: PREP_DEVICE_ID, quality: 'wall', maxSize: 480, maxFps: 5, bitRate: 800_000 },
      ]),
    )
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

/**
 * `closeAll(reason)` and `activeDeviceIds()` (plan 88 §3.10, §4.8, fixes
 * F19) — the adb restart flow's drain reads BOTH: a live count before
 * anything closes (for the confirmation dialog), and the real count of what
 * it actually closed (for `AdbCycleReport.sessionsClosed`), with the reason
 * threaded onto the wire so the device log reads as an operator action
 * ("adb-server-restart") rather than an unexplained drop.
 */
describe('SessionManager.closeAll(reason) / activeDeviceIds() (plan 88 §3.10, §4.8)', () => {
  test('activeDeviceIds() sees an open session before it is closed, and closeAll(reason) reports both the count and the reason', async () => {
    const events: { deviceId: string; kind: string; meta: Record<string, unknown> }[] = []
    const manager = createSessionManager({
      client: fakeClient(),
      devices,
      log: silentLog(),
      makeScrcpy: async () => fakeScrcpy(),
      onEvent: (deviceId, kind, meta) => events.push({ deviceId, kind, meta }),
    })

    expect(manager.activeDeviceIds?.()).toEqual([])
    await manager.acquire(DEVICE_ID, () => {})
    expect(manager.activeDeviceIds?.()).toEqual([DEVICE_ID])

    const closed = await manager.closeAll('adb-server-restart')

    expect(closed).toBe(1)
    expect(manager.activeDeviceIds?.()).toEqual([])
    const closedEvent = events.find((e) => e.kind === 'session.closed')
    expect(closedEvent?.meta.reason).toBe('adb-server-restart')
  })

  test('closeAll() with no reason defaults to \'shutdown\' and still reports the count', async () => {
    const events: { deviceId: string; kind: string; meta: Record<string, unknown> }[] = []
    const manager = createSessionManager({
      client: fakeClient(),
      devices,
      log: silentLog(),
      onEvent: (deviceId, kind, meta) => events.push({ deviceId, kind, meta }),
    })
    await manager.acquire(DEVICE_ID, () => {})

    const closed = await manager.closeAll()

    expect(closed).toBe(1)
    expect(events.find((e) => e.kind === 'session.closed')?.meta.reason).toBe('shutdown')
  })

  test('nothing open: closeAll() closes zero and activeDeviceIds() is empty', async () => {
    const manager = createSessionManager({ client: fakeClient(), devices, log: silentLog() })
    expect(manager.activeDeviceIds?.()).toEqual([])
    expect(await manager.closeAll()).toBe(0)
  })
})

/**
 * Plan 92 §3.5, §4.2, §4.3, step 92.1 — `SessionManagerDeps.resolveProfile`
 * is the seam that turns a saved `video.*` farm setting into an actual
 * scrcpy argument: `createEntry` calls it and threads the result into
 * `CreateSessionOpts.videoProfile`, which `createSession` hands straight to
 * `makeScrcpy` (`session.ts`, no `QUALITY_PROFILES[quality]` lookup left
 * anywhere). This is the manager-level half of the step's own verifiable
 * result — "setting `video.wallMaxFps: 3` and opening a new wall tile
 * spawns scrcpy with `max_fps 3`" — proven here by faking `resolveProfile`
 * the way a real settings change would resolve it, and asserting on the
 * exact object `makeScrcpy` received.
 */
describe('SessionManager — resolveProfile threads a resolved video profile into makeScrcpy (plan 92 §3.5, §4.2, §4.3)', () => {
  test('a custom resolveProfile reaches makeScrcpy verbatim — e.g. video.wallMaxFps: 3 spawns scrcpy with max_fps 3', async () => {
    const received: VideoProfile[] = []
    const manager = createSessionManager({
      client: fakeClient(),
      devices,
      log: silentLog(),
      makeScrcpy: async (_deviceId, _transport, profile) => {
        received.push(profile)
        return fakeScrcpy()
      },
      resolveProfile: (_deviceId, quality) => ({
        quality,
        maxSize: 480,
        maxFps: 3, // the setting under test: video.wallMaxFps: 3
        bitRate: 800_000,
        source: { maxSize: 'preset', maxFps: 'farm', bitRate: 'preset' },
      }),
    })

    await manager.acquire(DEVICE_ID, () => {}, 'wall')

    expect(received).toHaveLength(1)
    expect(received[0]).toEqual({
      quality: 'wall',
      maxSize: 480,
      maxFps: 3,
      bitRate: 800_000,
      source: { maxSize: 'preset', maxFps: 'farm', bitRate: 'preset' },
    })
    await manager.closeAll()
  })

  test('resolveProfile is called with the requested quality and this device\'s id', async () => {
    const calls: Array<{ deviceId: string; quality: string }> = []
    const manager = createSessionManager({
      client: fakeClient(),
      devices,
      log: silentLog(),
      makeScrcpy: async () => fakeScrcpy(),
      resolveProfile: (deviceId, quality) => {
        calls.push({ deviceId, quality })
        return { quality, maxSize: 1600, maxFps: 30, bitRate: 4_000_000, source: { maxSize: 'preset', maxFps: 'preset', bitRate: 'preset' } }
      },
    })

    await manager.acquire(DEVICE_ID, () => {}, 'control')

    expect(calls).toEqual([{ deviceId: DEVICE_ID, quality: 'control' }])
    await manager.closeAll()
  })

  test('with no resolveProfile at all (a fixture/test manager, or the node package\'s own mini-core), makeScrcpy still receives a concrete profile — the byte-identical schema default, not undefined', async () => {
    const received: VideoProfile[] = []
    const manager = createSessionManager({
      client: fakeClient(),
      devices,
      log: silentLog(),
      makeScrcpy: async (_deviceId, _transport, profile) => {
        received.push(profile)
        return fakeScrcpy()
      },
      // resolveProfile deliberately omitted.
    })

    await manager.acquire(DEVICE_ID, () => {}, 'wall')

    expect(received).toHaveLength(1)
    // Plan 100 §3.4/step 100.8 revised WALL_PRESETS.balanced (480px · 18fps ·
    // 1.1Mbit/s, was 480px · 5fps · 800kbit/s pre-plan-100) — this assertion
    // tracks the schema's own default, not a hand-picked number, so it moves
    // with it on purpose.
    expect(received[0]).toMatchObject({ maxSize: 480, maxFps: 18, bitRate: 1_100_000 })
    await manager.closeAll()
  })
})

/** Builds a `DeviceSnapshotSource` covering exactly the given ids, each a distinct device (not `DEVICE_ID`). */
function makeDevicesSource(ids: string[]): DeviceSnapshotSource {
  const map = new Map(ids.map((id) => [id, { ...snapshot, id, stableId: `STABLE-${id}`, serial: `SERIAL-${id}` }]))
  return { get: (id) => map.get(id) ?? null }
}

/**
 * The build lane (plan 92 §3.3, §4.3, §5 step 92.3, tests H1) — the
 * counting semaphore around `createEntry` that fixes F9. Every test here
 * proves one of the step's own load-bearing claims: it QUEUES rather than
 * refuses (every caller past the cap still eventually gets a session, none
 * errors), it releases on every path including a throw (a leaked permit
 * would silently shrink farm capacity until a restart), and the permit wait
 * sits OUTSIDE `inFlight`'s per-device dedupe (two callers for the SAME
 * device never compete against each other for a second permit).
 */
describe('SessionManager — the build lane (plan 92 §3.3, §4.3, §5 step 92.3, tests H1)', () => {
  test('bounds concurrent session builds to maxConcurrentBuilds() and every queued build still completes — none is refused', async () => {
    const CAP = 2
    const N = 6
    const ids = Array.from({ length: N }, (_, i) => `dev-${i + 1}`)
    const devicesSrc = makeDevicesSource(ids)

    let concurrent = 0
    let peakConcurrent = 0
    const observedBuildsRunning: number[] = []
    const manager = createSessionManager({
      client: fakeClient(),
      devices: devicesSrc,
      log: silentLog(),
      maxConcurrentBuilds: () => CAP,
      makeScrcpy: async () => {
        concurrent++
        peakConcurrent = Math.max(peakConcurrent, concurrent)
        observedBuildsRunning.push(manager.videoStats!().buildsRunning)
        // Long enough that every caller below is queued behind the cap at some point.
        await Bun.sleep(20)
        concurrent--
        return fakeScrcpy()
      },
    })

    const sessions = await Promise.all(ids.map((id) => manager.acquire(id, () => {})))

    // All 24-style callers eventually stream — none is refused.
    expect(sessions).toHaveLength(N)
    for (const id of ids) expect(manager.get(id)).not.toBeNull()
    // The peak observed concurrency, both from the fake encoder's own
    // counter and from the manager's own `videoStats()` read at the exact
    // moment each build started, never exceeds the cap.
    expect(peakConcurrent).toBeLessThanOrEqual(CAP)
    expect(observedBuildsRunning.every((n) => n <= CAP)).toBe(true)
    expect(manager.videoStats!().buildsRunning).toBe(0)
    expect(manager.videoStats!().buildQueueDepth).toBe(0)

    await manager.closeAll()
  })

  test('buildQueueDepth rises while extra builds wait for a permit and drains to 0 once every build finishes', async () => {
    const CAP = 1
    const ids = ['dev-a', 'dev-b', 'dev-c']
    const devicesSrc = makeDevicesSource(ids)
    const manager = createSessionManager({
      client: fakeClient(),
      devices: devicesSrc,
      log: silentLog(),
      maxConcurrentBuilds: () => CAP,
      makeScrcpy: async () => {
        await Bun.sleep(30)
        return fakeScrcpy()
      },
    })

    const pending = Promise.all(ids.map((id) => manager.acquire(id, () => {})))
    // Give the first build a moment to actually start; the other two must
    // be sitting in the queue by now.
    await Bun.sleep(5)
    expect(manager.videoStats!().buildsRunning).toBe(1)
    expect(manager.videoStats!().buildQueueDepth).toBe(2)

    await pending
    expect(manager.videoStats!().buildsRunning).toBe(0)
    expect(manager.videoStats!().buildQueueDepth).toBe(0)
    await manager.closeAll()
  })

  test('a build that throws still releases its permit — the lane never leaks capacity', async () => {
    const CAP = 1
    const devicesSrc = makeDevicesSource(['dev-good'])
    const manager = createSessionManager({
      client: fakeClient(),
      devices: devicesSrc,
      log: silentLog(),
      maxConcurrentBuilds: () => CAP,
      makeScrcpy: async () => fakeScrcpy(),
    })

    // 'dev-missing' is not in the device source — createEntry throws
    // `device_not_found` synchronously, from INSIDE the lane's permit.
    await expect(manager.acquire('dev-missing', () => {})).rejects.toThrow()
    expect(manager.videoStats!().buildsRunning).toBe(0)

    // If the failed build's permit had leaked, this would hang forever at
    // CAP=1 — it must not.
    const session = await manager.acquire('dev-good', () => {})
    expect(session).not.toBeNull()
    await manager.closeAll()
  })

  test('two callers for the SAME device share the one queued build — they never compete against each other for a second permit', async () => {
    const CAP = 1
    const devicesSrc = makeDevicesSource(['dev-x', 'dev-y'])
    let built = 0
    const manager = createSessionManager({
      client: fakeClient(),
      devices: devicesSrc,
      log: silentLog(),
      maxConcurrentBuilds: () => CAP,
      makeScrcpy: async () => {
        built++
        await Bun.sleep(20)
        return fakeScrcpy()
      },
    })

    // dev-y occupies the lane's one permit first.
    const yPromise = manager.acquire('dev-y', () => {})
    await Bun.sleep(5)
    expect(manager.videoStats!().buildsRunning).toBe(1)

    // Two callers for dev-x arrive while dev-y still holds the permit: both
    // must resolve to the SAME session once dev-x's queued build runs, and
    // it must build exactly once for dev-x (not once per caller) — proving
    // `inFlight`'s dedupe still coalesces them even though the lane is full.
    const [x1, x2] = await Promise.all([manager.acquire('dev-x', () => {}), manager.acquire('dev-x', () => {})])
    await yPromise

    expect(x1).toBe(x2)
    expect(built).toBe(2) // one build for dev-y, one shared build for dev-x
    await manager.closeAll()
  })

  test('with no maxConcurrentBuilds accessor wired, the lane is unbounded — the pre-plan-92 behaviour (F9)', async () => {
    const ids = ['dev-u1', 'dev-u2', 'dev-u3']
    const devicesSrc = makeDevicesSource(ids)
    let peakConcurrent = 0
    let concurrent = 0
    const manager = createSessionManager({
      client: fakeClient(),
      devices: devicesSrc,
      log: silentLog(),
      // maxConcurrentBuilds deliberately omitted.
      makeScrcpy: async () => {
        concurrent++
        peakConcurrent = Math.max(peakConcurrent, concurrent)
        await Bun.sleep(15)
        concurrent--
        return fakeScrcpy()
      },
    })

    await Promise.all(ids.map((id) => manager.acquire(id, () => {})))
    expect(peakConcurrent).toBe(ids.length)
    await manager.closeAll()
  })
})

/** `SessionManager.videoStats()` (plan 92 §3.3, §4.3, §5 step 92.3) — the `/api/adb/stats` `video` block's data source. */
describe('SessionManager.videoStats() (plan 92 §4.3)', () => {
  test('reports live streams by quality and each entry\'s resolved profile', async () => {
    const devicesSrc = makeDevicesSource(['dev-p', 'dev-q'])
    const manager = createSessionManager({
      client: fakeClient(),
      devices: devicesSrc,
      log: silentLog(),
      makeScrcpy: async () => fakeScrcpy(),
      resolveProfile: (_deviceId, quality) =>
        quality === 'control'
          ? { quality, maxSize: 1600, maxFps: 30, bitRate: 4_000_000, source: { maxSize: 'preset', maxFps: 'preset', bitRate: 'preset' } }
          : { quality, maxSize: 480, maxFps: 5, bitRate: 800_000, source: { maxSize: 'preset', maxFps: 'preset', bitRate: 'preset' } },
    })

    await manager.acquire('dev-p', () => {}, 'control')
    await manager.acquire('dev-q', () => {}, 'wall')

    const stats = manager.videoStats!()
    expect(stats.streams).toEqual({ control: 1, wall: 1 })
    expect(stats.buildsRunning).toBe(0)
    expect(stats.buildQueueDepth).toBe(0)
    expect(stats.profiles).toEqual(
      expect.arrayContaining([
        { deviceId: 'dev-p', quality: 'control', maxSize: 1600, maxFps: 30, bitRate: 4_000_000 },
        { deviceId: 'dev-q', quality: 'wall', maxSize: 480, maxFps: 5, bitRate: 800_000 },
      ]),
    )
    await manager.closeAll()
  })

  test('with no resolveProfile wired, profiles is empty rather than reporting made-up numbers', async () => {
    const manager = createSessionManager({
      client: fakeClient(),
      devices,
      log: silentLog(),
      makeScrcpy: async () => fakeScrcpy(),
    })
    await manager.acquire(DEVICE_ID, () => {})
    expect(manager.videoStats!().profiles).toEqual([])
    expect(manager.videoStats!().streams).toEqual({ control: 1, wall: 0 })
    await manager.closeAll()
  })
})

/**
 * `restartAt`/`reprofile` (plan 92 §3.8, §4.3, §5 step 92.2) — the "saved
 * but never read" fix for a video setting on an ALREADY-OPEN session. Two
 * clauses are the whole safety of this step, and each has its own test
 * below: a device running a job must never be restarted (`skippedBusy`), and
 * an existing viewer must never be dropped by the restart (the refcount
 * carry-over `restartAt` inherits from the pre-plan-92 `upgradeToControl`).
 */
describe('SessionManager.restartAt / reprofile (plan 92 §3.8, §4.3, §5 step 92.2)', () => {
  /** A `DeviceSnapshotSource` whose per-device `status` can be flipped mid-test (`reprofile`'s rule 4 needs a `busy` device). */
  function makeMutableDevicesSource(ids: string[]): { source: DeviceSnapshotSource; setStatus: (id: string, status: DeviceSnapshot['status']) => void } {
    const map = new Map(ids.map((id) => [id, { ...snapshot, id, stableId: `STABLE-${id}`, serial: `SERIAL-${id}` }]))
    return {
      source: { get: (id) => map.get(id) ?? null },
      setStatus: (id, status) => {
        const row = map.get(id)
        if (row) map.set(id, { ...row, status })
      },
    }
  }

  test('restartAt is a no-op when the device has no open entry — nothing to restart, and a plain acquire builds the right thing directly', async () => {
    const manager = createSessionManager({ client: fakeClient(), devices, log: silentLog(), makeScrcpy: async () => fakeScrcpy() })
    await expect(manager.restartAt!('no-such-device', 'control')).resolves.toBeUndefined()
    await manager.closeAll()
  })

  test('reprofile with no resolveProfile wired is a no-op — nothing to compare an open session against', async () => {
    const manager = createSessionManager({ client: fakeClient(), devices, log: silentLog(), makeScrcpy: async () => fakeScrcpy() })
    await manager.acquire(DEVICE_ID, () => {}, 'wall')
    const result = await manager.reprofile!('farm settings changed')
    expect(result).toEqual({ restarted: [], skippedBusy: [], unchanged: 0 })
    await manager.closeAll()
  })

  test('reprofile restarts a session whose resolved profile changed, and leaves an unchanged one alone (rule 1)', async () => {
    let builds = 0
    const { source } = makeMutableDevicesSource(['dev-changed', 'dev-same'])
    const wallFps = { current: 5 }
    const manager = createSessionManager({
      client: fakeClient(),
      devices: source,
      log: silentLog(),
      makeScrcpy: async () => {
        builds++
        return fakeScrcpy()
      },
      resolveProfile: (deviceId, quality) => ({
        quality,
        maxSize: 480,
        // Only `dev-changed`'s profile moves; `dev-same` resolves to the
        // exact numbers it was already built with.
        maxFps: deviceId === 'dev-changed' ? wallFps.current : 5,
        bitRate: 800_000,
        source: { maxSize: 'preset', maxFps: 'farm', bitRate: 'preset' },
      }),
    })

    await manager.acquire('dev-changed', () => {}, 'wall')
    await manager.acquire('dev-same', () => {}, 'wall')
    expect(builds).toBe(2)

    // The operator raises wall.wallMaxFps — only `dev-changed`'s RESOLVED
    // numbers actually move.
    wallFps.current = 8

    const result = await manager.reprofile!('farm settings changed')
    expect(result.restarted).toEqual(['dev-changed'])
    expect(result.skippedBusy).toEqual([])
    expect(result.unchanged).toBe(1)
    // `dev-changed` was rebuilt (a fresh scrcpy build); `dev-same` was not.
    expect(builds).toBe(3)

    await manager.closeAll()
  })

  test('a device running a job is reported in skippedBusy and its session is never restarted (rule 4, the blast-radius bound)', async () => {
    let builds = 0
    const { source } = makeMutableDevicesSource(['dev-busy', 'dev-idle'])
    const wallFps = { current: 5 }
    const runningJobDeviceIds = new Set<string>()
    const manager = createSessionManager({
      client: fakeClient(),
      devices: source,
      log: silentLog(),
      makeScrcpy: async () => {
        builds++
        return fakeScrcpy()
      },
      // Every device's resolved profile will "change" once `wallFps.current`
      // moves below — proves the busy device is skipped for HAVING A
      // RUNNING JOB, not because it happened to look unchanged.
      resolveProfile: (_deviceId, quality) => ({
        quality,
        maxSize: 480,
        maxFps: wallFps.current,
        bitRate: 800_000,
        source: { maxSize: 'preset', maxFps: 'farm', bitRate: 'preset' },
      }),
      hasRunningJob: (deviceId) => runningJobDeviceIds.has(deviceId),
    })

    const busySession = await manager.acquire('dev-busy', () => {}, 'wall')
    await manager.acquire('dev-idle', () => {}, 'wall')
    expect(builds).toBe(2)
    runningJobDeviceIds.add('dev-busy')
    wallFps.current = 9

    const result = await manager.reprofile!('farm settings changed')
    expect(result.skippedBusy).toEqual(['dev-busy'])
    expect(result.restarted).toEqual(['dev-idle'])
    // The busy device's session is the EXACT SAME object — never closed, never rebuilt.
    expect(manager.get('dev-busy')).toBe(busySession)
    expect(builds).toBe(3) // only dev-idle rebuilt

    await manager.closeAll()
  })

  test('a restarted session carries its subscriber and refcount across — the viewer is never dropped (the other safety clause)', async () => {
    let builds = 0
    const wallFps = { current: 5 }
    const manager = createSessionManager({
      client: fakeClient(),
      devices,
      log: silentLog(),
      // 0 closes a no-longer-subscribed session IMMEDIATELY, synchronously
      // (Plan 42 §4.4 acceptance #10) — the mechanism this test leans on:
      // with a real refcount carry-over, releasing ONE of two viewers must
      // NOT close the session (refcount 2 → 1, still > 0); with a BROKEN
      // carry-over (fresh entry starting at refcount 0), the very first
      // release would already underflow to 0 and close it right there.
      idleTtlSec: () => 0,
      makeScrcpy: async () => {
        builds++
        return fakeScrcpy()
      },
      resolveProfile: (_deviceId, quality) => ({
        quality,
        maxSize: 480,
        maxFps: wallFps.current,
        bitRate: 800_000,
        source: { maxSize: 'preset', maxFps: 'farm', bitRate: 'preset' },
      }),
    })

    // Two independent viewers (e.g. two wall tabs) — refcount 2.
    const viewerA = () => {}
    const viewerB = () => {}
    await manager.acquire(DEVICE_ID, viewerA, 'wall')
    await manager.acquire(DEVICE_ID, viewerB, 'wall')
    expect(builds).toBe(1)

    wallFps.current = 3
    const result = await manager.reprofile!('farm settings changed')
    expect(result.restarted).toEqual([DEVICE_ID])
    expect(builds).toBe(2) // rebuilt once

    // Releasing the FIRST of two carried-over viewers must leave the
    // session open (refcount 2 → 1) — this is the assertion a broken
    // carry-over would fail.
    manager.release(DEVICE_ID, viewerA)
    expect(manager.get(DEVICE_ID)).not.toBeNull()
    // Releasing the SECOND drops refcount to 0 and — with `idleTtlSec: 0` —
    // closes it right away, proving the manager was tracking a real count
    // the whole time, not merely never closing.
    manager.release(DEVICE_ID, viewerB)
    expect(manager.get(DEVICE_ID)).toBeNull()

    await manager.closeAll()
  })

  test('reprofile threads detail through onPhase for every restarted session — the operator sees WHY (rule 5, fixes F17)', async () => {
    const phases: Array<{ deviceId: string; phase: string; detail?: string }> = []
    const wallFps = { current: 5 }
    const manager = createSessionManager({
      client: fakeClient(),
      devices,
      log: silentLog(),
      makeScrcpy: async () => fakeScrcpy(),
      onPhase: (deviceId, phase, detail) => phases.push({ deviceId, phase, ...(detail ? { detail } : {}) }),
      resolveProfile: (_deviceId, quality) => ({
        quality,
        maxSize: 480,
        maxFps: wallFps.current,
        bitRate: 800_000,
        source: { maxSize: 'preset', maxFps: 'farm', bitRate: 'preset' },
      }),
    })

    await manager.acquire(DEVICE_ID, () => {}, 'wall')
    phases.length = 0 // only care about the RESTART's own phases

    wallFps.current = 2
    await manager.reprofile!('farm settings changed')

    const restartPhases = phases.filter((p) => p.deviceId === DEVICE_ID)
    expect(restartPhases.length).toBeGreaterThan(0)
    expect(restartPhases.every((p) => p.detail === 'applying new video settings')).toBe(true)

    await manager.closeAll()
  })
})

/**
 * **Plan 125 §3.7, §4.5, §5 step 125.7 — acceptance criterion 11, composed**:
 * `session.test.ts` pins `CreateSessionOpts.skipWake` itself; this pins the
 * wiring that decides it, which is where the real defect lived. `createSession`
 * never consulted the readiness manager, so on a cold `stream.start` the wake
 * ran twice — once from `readiness.hold(deviceId, 'viewer')` and again from the
 * `sessions.acquire` immediately after it (plan 125 §0.7, ≈3.2 s of a ≈4.3 s
 * cold start, on the owner's own measurement).
 *
 * `deviceIsAwake` stands in for `daemon.ts`'s real wiring,
 * `(deviceId) => readiness?.actual(deviceId) !== 'asleep'`. Counting `input
 * keyevent KEYCODE_WAKEUP` on the wire (rather than spying on `wakeDevice`)
 * keeps the assertion about what actually reaches the phone — the thing the
 * sealed-box constraint (§0.2) cares about.
 */
describe('SessionManager — one wake per session start (plan 125 §3.7, §5 step 125.7, acceptance #11)', () => {
  /** The shared `snapshot` opts out of keeping the screen awake; this farm's default (since 125.2) does not. */
  const awakeDevices: DeviceSnapshotSource = {
    get: (id) => (id === DEVICE_ID ? { ...snapshot, keepAwake: 'always' } : null),
  }

  function recordingClient(): { client: AdbClient; calls: string[] } {
    const calls: string[] = []
    const client = {
      exec: async (_serial: string, cmd: string) => {
        calls.push(cmd)
        return { stdout: '', stderr: '', exitCode: 0 }
      },
      execOut: async () => new Uint8Array(),
    } as unknown as AdbClient
    return { client, calls }
  }

  const wakeCount = (calls: string[]): number => calls.filter((c) => c === 'input keyevent KEYCODE_WAKEUP').length

  test('readiness reports the device already awake or hot: the build wakes it ZERO times', async () => {
    const { client, calls } = recordingClient()
    const manager = createSessionManager({
      client,
      devices: awakeDevices,
      log: silentLog(),
      makeScrcpy: async () => fakeScrcpy(),
      deviceIsAwake: () => true,
    })
    await manager.acquire(DEVICE_ID, () => {})
    expect(wakeCount(calls)).toBe(0)
    expect(calls.some((c) => c.startsWith('svc power stayon'))).toBe(false)
    await manager.closeAll()
    // ...and the close does not release a hold the readiness manager owns.
    expect(calls).not.toContain('svc power stayon false')
  })

  test('readiness reports the device asleep: the build wakes it EXACTLY ONCE', async () => {
    const { client, calls } = recordingClient()
    const manager = createSessionManager({
      client,
      devices: awakeDevices,
      log: silentLog(),
      makeScrcpy: async () => fakeScrcpy(),
      deviceIsAwake: () => false,
    })
    await manager.acquire(DEVICE_ID, () => {})
    expect(wakeCount(calls)).toBe(1)
    await manager.closeAll()
  })

  /**
   * The safe default in the only direction that matters: a manager with no
   * readiness manager behind it (the node package's mini-core, a fixture) must
   * behave exactly as it did before this plan. An unnecessary wake costs a
   * second; a missing one costs a boxed phone its screen.
   */
  test('no deviceIsAwake accessor wired: the wake happens exactly as it did before this plan', async () => {
    const { client, calls } = recordingClient()
    const manager = createSessionManager({
      client,
      devices: awakeDevices,
      log: silentLog(),
      makeScrcpy: async () => fakeScrcpy(),
    })
    await manager.acquire(DEVICE_ID, () => {})
    expect(wakeCount(calls)).toBe(1)
    await manager.closeAll()
    expect(calls).toContain('svc power stayon false')
  })

  /**
   * Read fresh at BUILD time, not at `acquire` time — a build queued behind the
   * farm-wide build lane can wait a while, and the answer that decides whether
   * to pay a 1422 ms `svc power stayon` has to be the one true when the build
   * actually runs.
   */
  test('the accessor is consulted at build time, so a device woken while the build was queued is not woken again', async () => {
    const { client, calls } = recordingClient()
    let awake = false
    const manager = createSessionManager({
      client,
      devices: awakeDevices,
      log: silentLog(),
      makeScrcpy: async () => fakeScrcpy(),
      deviceIsAwake: () => awake,
      maxConcurrentBuilds: () => 1,
    })
    // Flip the readiness answer before the build is allowed to start, standing
    // in for `readiness.hold` completing while this build waited for a permit.
    awake = true
    await manager.acquire(DEVICE_ID, () => {})
    expect(wakeCount(calls)).toBe(0)
    await manager.closeAll()
  })
})
