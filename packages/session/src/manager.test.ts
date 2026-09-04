import { describe, expect, test } from 'bun:test'
import type { AdbClient } from '@enkaku/adb'
import type { ScrcpySession } from '@enkaku/scrcpy'
import { createRateMeter, createSessionManager, RateMeter, type PrepStep } from './manager'
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
      getClipboard: async () => '',
      setClipboard: async () => {},
    },
    close: async () => {
      for (const cb of closeHandlers) cb('closed by test')
    },
  } as unknown as ScrcpySession
}

/** A scrcpy session whose packets a test controls directly — config/keyframe/frame. */
function fakeScrcpyWithPackets(): {
  session: ScrcpySession
  emit: (kind: 'config' | 'keyframe' | 'frame', data?: Uint8Array) => void
  fireClose: (reason: string) => void
} {
  let packetCb: ((p: { kind: string; data: Uint8Array; ptsUs: bigint; receivedAt: number }) => void) | null = null
  const closeHandlers = new Set<(reason: string) => void>()
  const session = {
    meta: { deviceName: 'test phone', codec: 'h264', width: 704, height: 1600 },
    onPacket: (cb: typeof packetCb) => {
      packetCb = cb
    },
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
      getClipboard: async () => '',
      setClipboard: async () => {},
    },
    close: async () => {},
  } as unknown as ScrcpySession
  return {
    session,
    emit: (kind, data = new Uint8Array([1, 2, 3])) => packetCb?.({ kind, data, ptsUs: 0n, receivedAt: Date.now() }),
    fireClose: (reason) => {
      for (const cb of closeHandlers) cb(reason)
    },
  }
}

/** A fake, controllable clock/timer pair for the control-linger tests. */
function fakeTimers() {
  let now = 0
  const pending = new Map<number, { at: number; fn: () => void }>()
  let nextId = 1
  return {
    timers: {
      set: (fn: () => void, ms: number) => {
        const id = nextId++
        pending.set(id, { at: now + ms, fn })
        return id
      },
      clear: (h: unknown) => {
        pending.delete(h as number)
      },
      now: () => now,
    },
    advance(ms: number) {
      now += ms
      for (const [id, entry] of [...pending]) {
        if (entry.at <= now) {
          pending.delete(id)
          entry.fn()
        }
      }
    },
  }
}

describe('SessionManager.build / state / acquire (plan 206 §4.3)', () => {
  test('acquire never builds: no base entry means device_not_ready', async () => {
    const manager = createSessionManager({ client: fakeClient(), devices, log: silentLog(), makeScrcpy: async () => fakeScrcpy() })
    await expect(manager.acquire(DEVICE_ID, () => {})).rejects.toMatchObject({ name: 'SessionError', code: 'device_not_ready' })
  })

  test('acquire awaits a build in flight rather than refusing a caller that arrived a moment early', async () => {
    let makeScrcpyCalls = 0
    const manager = createSessionManager({
      client: fakeClient(),
      devices,
      log: silentLog(),
      makeScrcpy: async () => {
        makeScrcpyCalls++
        await Bun.sleep(20)
        return fakeScrcpy()
      },
    })
    const buildPromise = manager.build(DEVICE_ID, { requireScrcpy: false })
    // Still building — `acquire` must await the SAME build, never start a second one.
    const acquirePromise = manager.acquire(DEVICE_ID, () => {})
    await buildPromise
    const session = await acquirePromise
    expect(session).not.toBeNull()
    expect(makeScrcpyCalls).toBe(1)
    await manager.closeAll()
  })

  test('build is coalesced per device — two concurrent build() calls produce exactly one scrcpy build', async () => {
    let builds = 0
    const manager = createSessionManager({
      client: fakeClient(),
      devices,
      log: silentLog(),
      makeScrcpy: async () => {
        builds++
        return fakeScrcpy()
      },
    })
    await Promise.all([manager.build(DEVICE_ID, { requireScrcpy: false }), manager.build(DEVICE_ID, { requireScrcpy: false })])
    expect(builds).toBe(1)
    expect(manager.state(DEVICE_ID)).toBe('ready')
    await manager.closeAll()
  })

  test('a build on a device that already has a base entry resolves immediately without a second build', async () => {
    let builds = 0
    const manager = createSessionManager({
      client: fakeClient(),
      devices,
      log: silentLog(),
      makeScrcpy: async () => {
        builds++
        return fakeScrcpy()
      },
    })
    await manager.build(DEVICE_ID, { requireScrcpy: false })
    await manager.build(DEVICE_ID, { requireScrcpy: false })
    expect(builds).toBe(1)
    await manager.closeAll()
  })

  test('build maps phases to steps 1..5 in order — step 5 arrives with the first real frame', async () => {
    const steps: PrepStep[] = []
    const fake = fakeScrcpyWithPackets()
    const manager = createSessionManager({ client: fakeClient(), devices, log: silentLog(), makeScrcpy: async () => fake.session })
    await manager.build(DEVICE_ID, { requireScrcpy: false, onStep: (s) => steps.push(s) })
    expect(steps).toEqual([1, 2, 3, 4])
    fake.emit('config')
    fake.emit('keyframe')
    expect(steps).toEqual([1, 2, 3, 4, 5])
    await manager.closeAll()
  })

  test('state() reports none, building, then ready', async () => {
    const manager = createSessionManager({
      client: fakeClient(),
      devices,
      log: silentLog(),
      makeScrcpy: async () => {
        await Bun.sleep(20)
        return fakeScrcpy()
      },
    })
    expect(manager.state(DEVICE_ID)).toBe('none')
    const pending = manager.build(DEVICE_ID, { requireScrcpy: false })
    expect(manager.state(DEVICE_ID)).toBe('building')
    await pending
    expect(manager.state(DEVICE_ID)).toBe('ready')
    await manager.closeAll()
  })

  test('whenReady resolves with the base session once a build in flight finishes', async () => {
    const manager = createSessionManager({
      client: fakeClient(),
      devices,
      log: silentLog(),
      makeScrcpy: async () => {
        await Bun.sleep(20)
        return fakeScrcpy()
      },
    })
    const buildPromise = manager.build(DEVICE_ID, { requireScrcpy: false })
    const readyPromise = manager.whenReady(DEVICE_ID)
    await buildPromise
    expect(await readyPromise).not.toBeNull()
    await manager.closeAll()
  })

  test('whenReady rejects device_not_ready when no build is in flight and none exists', async () => {
    const manager = createSessionManager({ client: fakeClient(), devices, log: silentLog(), makeScrcpy: async () => fakeScrcpy() })
    await expect(manager.whenReady(DEVICE_ID)).rejects.toMatchObject({ code: 'device_not_ready' })
  })

  test('whenReady with a timeout rejects device_not_ready if the build has not finished in time', async () => {
    const manager = createSessionManager({
      client: fakeClient(),
      devices,
      log: silentLog(),
      makeScrcpy: () => new Promise<ScrcpySession>(() => {}), // never resolves
    })
    void manager.build(DEVICE_ID, { requireScrcpy: false })
    await expect(manager.whenReady(DEVICE_ID, 5)).rejects.toMatchObject({ code: 'device_not_ready' })
  })
})

describe('SessionManager.attachViewer (plan 206 §3.4, §4.3)', () => {
  test('control attach before the base entry exists throws device_not_ready with state', async () => {
    const manager = createSessionManager({ client: fakeClient(), devices, log: silentLog(), makeScrcpy: async () => fakeScrcpy() })
    await expect(manager.attachViewer(DEVICE_ID, 'control', () => {})).rejects.toMatchObject({
      code: 'device_not_ready',
      details: { state: 'none' },
    })
  })

  test('wall attach: an ordinary wall viewer attaches to the base entry with no substitute', async () => {
    const manager = createSessionManager({ client: fakeClient(), devices, log: silentLog(), makeScrcpy: async () => fakeScrcpy() })
    await manager.build(DEVICE_ID, { requireScrcpy: true })
    const attach = await manager.attachViewer(DEVICE_ID, 'wall', () => {})
    expect(attach.quality).toBe('wall')
    expect(attach.substitute).toBeUndefined()
    await manager.closeAll()
  })

  test('control attach on a screencap-loop device reports control_encoder_unavailable and stays on wall', async () => {
    const screencapSnapshot = { ...snapshot, display: 'screencap-loop' }
    const screencapDevices: DeviceSnapshotSource = { get: (id) => (id === DEVICE_ID ? screencapSnapshot : null) }
    const manager = createSessionManager({ client: fakeClient(), devices: screencapDevices, log: silentLog() })
    await manager.build(DEVICE_ID, { requireScrcpy: false })
    const attach = await manager.attachViewer(DEVICE_ID, 'control', () => {})
    expect(attach.quality).toBe('wall')
    expect(attach.degradedReason).toBe('control_encoder_unavailable')
    await manager.closeAll()
  })

  test('control attach returns substitute wall and switches on the first cached keyframe', async () => {
    const wall = fakeScrcpy()
    const control = fakeScrcpyWithPackets()
    let makeScrcpyCalls = 0
    const manager = createSessionManager({
      client: fakeClient(),
      devices,
      log: silentLog(),
      makeScrcpy: async () => {
        makeScrcpyCalls++
        return makeScrcpyCalls === 1 ? wall : control.session
      },
    })
    await manager.build(DEVICE_ID, { requireScrcpy: true })

    let switched: unknown = null
    const attach = await manager.attachViewer(DEVICE_ID, 'control', () => {}, { onSwitched: (s) => (switched = s) })
    expect(attach.quality).toBe('wall')
    expect(attach.substitute).toBe('wall')
    expect(switched).toBeNull()

    // Not live yet — a second attach still gets the substitute, not a false "control".
    const second = await manager.attachViewer(DEVICE_ID, 'control', () => {})
    expect(second.substitute).toBe('wall')

    // The control build's own first keyframe arrives — every pending sink switches.
    await Bun.sleep(10) // let the control build's own async chain (transport connect, rotation, ...) finish subscribing to packets
    control.emit('config')
    control.emit('keyframe')
    expect(switched).not.toBeNull()

    // A THIRD attach after the entry is live goes straight to control.
    const third = await manager.attachViewer(DEVICE_ID, 'control', () => {})
    expect(third.quality).toBe('control')
    expect(third.substitute).toBeUndefined()

    await manager.closeAll()
  })

  test('a failed control build calls onControlFailed for every pending sink; the sinks stay on the wall entry', async () => {
    const manager = createSessionManager({
      client: fakeClient(),
      devices,
      log: silentLog(),
      makeScrcpy: async (_deviceId, _transport, profile) => (profile.quality === 'wall' ? fakeScrcpy() : null),
    })
    await manager.build(DEVICE_ID, { requireScrcpy: true })
    let failedReason: string | null = null
    const attach = await manager.attachViewer(DEVICE_ID, 'control', () => {}, { onControlFailed: (reason) => (failedReason = reason) })
    expect(attach.substitute).toBe('wall')
    await Bun.sleep(10)
    expect(failedReason).not.toBeNull()
    await manager.closeAll()
  })
})

describe('SessionManager — encoder split (plan 206 §3.4, §4.3)', () => {
  test('a device never holds more than two entries (wall and control)', async () => {
    const wall = fakeScrcpy()
    const control = fakeScrcpy()
    let calls = 0
    const manager = createSessionManager({
      client: fakeClient(),
      devices,
      log: silentLog(),
      makeScrcpy: async () => {
        calls++
        return calls === 1 ? wall : control
      },
    })
    await manager.build(DEVICE_ID, { requireScrcpy: true })
    await manager.attachViewer(DEVICE_ID, 'control', () => {})
    // Only two possible slots exist at all: wall and control — `encoders()` proves it.
    const [report] = manager.encoders()
    expect(report).toBeDefined()
    expect(report!.wall).not.toBeNull()
    // control may or may not be live yet, but never anything beyond these two.
    await manager.closeAll()
  })

  test('the control entry closes 15 s after the last control viewer detaches', async () => {
    const control = fakeScrcpyWithPackets()
    let calls = 0
    const { timers, advance } = fakeTimers()
    const manager = createSessionManager({
      client: fakeClient(),
      devices,
      log: silentLog(),
      timers,
      makeScrcpy: async () => {
        calls++
        return calls === 1 ? fakeScrcpy() : control.session
      },
    })
    await manager.build(DEVICE_ID, { requireScrcpy: true })
    // A first attach kicks off the control build; it never switches on its
    // own here (no hooks) — it exists only to bring the entry live.
    await manager.attachViewer(DEVICE_ID, 'control', () => {})
    await Bun.sleep(10) // let the control build's own async chain (transport connect, rotation, ...) finish subscribing to packets
    control.emit('config')
    control.emit('keyframe')

    // A SECOND attach, now that the entry is live, goes straight to control (no substitute).
    const onFrame = () => {}
    const attach = await manager.attachViewer(DEVICE_ID, 'control', onFrame)
    expect(attach.quality).toBe('control')

    manager.detachViewer(onFrame)
    let report = manager.encoders()[0]
    expect(report!.control).not.toBeNull()
    expect(report!.control!.lingerEndsAt).not.toBeNull()

    advance(14_999)
    report = manager.encoders()[0]
    expect(report!.control).not.toBeNull()

    advance(2)
    await Bun.sleep(5)
    report = manager.encoders()[0]
    expect(report!.control).toBeNull()

    await manager.closeAll()
  })

  test('a later attach before the linger fires cancels it and reuses the control entry', async () => {
    const control = fakeScrcpyWithPackets()
    let calls = 0
    const { timers, advance } = fakeTimers()
    const manager = createSessionManager({
      client: fakeClient(),
      devices,
      log: silentLog(),
      timers,
      makeScrcpy: async () => {
        calls++
        return calls === 1 ? fakeScrcpy() : control.session
      },
    })
    await manager.build(DEVICE_ID, { requireScrcpy: true })
    await manager.attachViewer(DEVICE_ID, 'control', () => {}) // brings the entry live
    await Bun.sleep(10) // let the control build's own async chain (transport connect, rotation, ...) finish subscribing to packets
    control.emit('config')
    control.emit('keyframe')

    const onFrame = () => {}
    await manager.attachViewer(DEVICE_ID, 'control', onFrame) // live — lands directly on control
    manager.detachViewer(onFrame)

    advance(1_000)
    const attach = await manager.attachViewer(DEVICE_ID, 'control', () => {})
    expect(attach.quality).toBe('control') // reused, not rebuilt
    expect(calls).toBe(2) // wall + one control build, never a second control build

    advance(20_000) // long past the original linger
    expect(manager.encoders()[0]!.control).not.toBeNull()
    await manager.closeAll()
  })

  test('a job sink on the base entry survives a control switch', async () => {
    const control = fakeScrcpyWithPackets()
    let calls = 0
    const manager = createSessionManager({
      client: fakeClient(),
      devices,
      log: silentLog(),
      makeScrcpy: async () => {
        calls++
        return calls === 1 ? fakeScrcpy() : control.session
      },
    })
    await manager.build(DEVICE_ID, { requireScrcpy: true })
    const jobFrames: number[] = []
    const jobSink = (chunk: Uint8Array) => jobFrames.push(chunk.byteLength)
    await manager.acquire(DEVICE_ID, jobSink)

    await manager.attachViewer(DEVICE_ID, 'control', () => {})
    await Bun.sleep(10) // let the control build's own async chain (transport connect, rotation, ...) finish subscribing to packets
    control.emit('config')
    control.emit('keyframe')

    // The job sink is still on the base entry and keeps receiving wall frames.
    expect(manager.get(DEVICE_ID)).not.toBeNull()
    manager.release(DEVICE_ID, jobSink)
    await manager.closeAll()
  })

  test('closing the base entry closes the control entry and reports onSessionEnded once', async () => {
    const wall = fakeScrcpyWithPackets()
    const control = fakeScrcpyWithPackets()
    let calls = 0
    const ended: Array<{ deviceId: string; reason: string }> = []
    const manager = createSessionManager({
      client: fakeClient(),
      devices,
      log: silentLog(),
      onSessionEnded: (deviceId, reason) => ended.push({ deviceId, reason }),
      makeScrcpy: async () => {
        calls++
        return calls === 1 ? wall.session : control.session
      },
    })
    await manager.build(DEVICE_ID, { requireScrcpy: true })
    await manager.attachViewer(DEVICE_ID, 'control', () => {})
    await Bun.sleep(10) // let the control build's own async chain (transport connect, rotation, ...) finish subscribing to packets
    control.emit('config')
    control.emit('keyframe')
    expect(manager.encoders()[0]!.control).not.toBeNull()

    wall.fireClose('device unplugged')
    await Bun.sleep(10)

    expect(ended).toEqual([{ deviceId: DEVICE_ID, reason: 'the scrcpy session ended: device unplugged' }])
    expect(manager.encoders()).toEqual([])
  })
})

describe('RateMeter (plan 206 §4.3)', () => {
  test('reports bytes and frames per second over a 5s window', () => {
    let now = 0
    const meter = new RateMeter(() => now)
    meter.record(1000)
    now += 1000
    meter.record(1000)
    now += 1000
    meter.record(1000)
    // 3000 bytes, 3 frames over a 2s span (clamped to at least 1s).
    expect(meter.bytesPerSec()).toBeGreaterThan(0)
    expect(meter.framesPerSec()).toBeGreaterThan(0)
  })

  test('old samples fall out of the 5s window', () => {
    let now = 0
    const meter = new RateMeter(() => now)
    meter.record(1000)
    now += 6_000 // past the window
    expect(meter.bytesPerSec()).toBe(0)
    expect(meter.framesPerSec()).toBe(0)
  })

  test('sinceSec counts from construction, monotonically', () => {
    let now = 1_000
    const meter = createRateMeter(() => now)
    expect(meter.sinceSec()).toBe(0)
    now += 3_000
    expect(meter.sinceSec()).toBe(3)
  })
})

describe('SessionManager — AdbInput gesture degrade reported once per session (plan 40 acceptance #8)', () => {
  test('no scrcpy available (no makeScrcpy) reports the degrade exactly once, even across repeated acquires', async () => {
    const events: { deviceId: string; kind: string; meta: Record<string, unknown> }[] = []
    const manager = createSessionManager({
      client: fakeClient(),
      devices,
      log: silentLog(),
      onEvent: (deviceId, kind, meta) => events.push({ deviceId, kind, meta }),
    })
    await manager.build(DEVICE_ID, { requireScrcpy: false })
    const onFrame = () => {}
    await manager.acquire(DEVICE_ID, onFrame)
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
    await manager.build(DEVICE_ID, { requireScrcpy: true })
    await manager.acquire(DEVICE_ID, () => {})
    expect(events.some((e) => e.kind === 'session.degraded' && e.meta.to === 'adb-input')).toBe(false)
    await manager.closeAll()
  })
})

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
    await manager.build(DEVICE_ID, { requireScrcpy: true })
    expect(manager.activeDeviceIds?.()).toEqual([DEVICE_ID])

    const closed = await manager.closeAll('adb-server-restart')

    expect(closed).toBe(1)
    expect(manager.activeDeviceIds?.()).toEqual([])
    const closedEvent = events.find((e) => e.kind === 'session.closed')
    expect(closedEvent?.meta.reason).toBe('adb-server-restart')
  })

  test("closeAll() with no reason defaults to 'shutdown' and still reports the count", async () => {
    const events: { deviceId: string; kind: string; meta: Record<string, unknown> }[] = []
    const manager = createSessionManager({
      client: fakeClient(),
      devices,
      log: silentLog(),
      onEvent: (deviceId, kind, meta) => events.push({ deviceId, kind, meta }),
    })
    await manager.build(DEVICE_ID, { requireScrcpy: false })

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
        maxFps: 3,
        bitRate: 800_000,
        source: { maxSize: 'preset', maxFps: 'farm', bitRate: 'preset' },
      }),
    })

    await manager.build(DEVICE_ID, { requireScrcpy: true })

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

  test("with no resolveProfile at all (a fixture/test manager, or the node package's own mini-core), makeScrcpy still receives a concrete profile — the byte-identical schema default, not undefined", async () => {
    const received: VideoProfile[] = []
    const manager = createSessionManager({
      client: fakeClient(),
      devices,
      log: silentLog(),
      makeScrcpy: async (_deviceId, _transport, profile) => {
        received.push(profile)
        return fakeScrcpy()
      },
    })

    await manager.build(DEVICE_ID, { requireScrcpy: true })

    expect(received).toHaveLength(1)
    expect(received[0]).toMatchObject({ maxSize: 480, maxFps: 18, bitRate: 1_100_000 })
    await manager.closeAll()
  })
})

describe('SessionManager.restartAt / reprofile (plan 92 §3.8, §4.3, §5 step 92.2 — plan 206 keeps the mechanism)', () => {
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

  test('restartAt is a no-op when the device has no open entry', async () => {
    const manager = createSessionManager({ client: fakeClient(), devices, log: silentLog(), makeScrcpy: async () => fakeScrcpy() })
    await expect(manager.restartAt!('no-such-device', 'control')).resolves.toBeUndefined()
    await manager.closeAll()
  })

  test('reprofile with no resolveProfile wired is a no-op', async () => {
    const manager = createSessionManager({ client: fakeClient(), devices, log: silentLog(), makeScrcpy: async () => fakeScrcpy() })
    await manager.build(DEVICE_ID, { requireScrcpy: true })
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
        maxFps: deviceId === 'dev-changed' ? wallFps.current : 5,
        bitRate: 800_000,
        source: { maxSize: 'preset', maxFps: 'farm', bitRate: 'preset' },
      }),
    })

    await manager.build('dev-changed', { requireScrcpy: true })
    await manager.build('dev-same', { requireScrcpy: true })
    expect(builds).toBe(2)

    wallFps.current = 8

    const result = await manager.reprofile!('farm settings changed')
    expect(result.restarted).toEqual(['dev-changed'])
    expect(result.skippedBusy).toEqual([])
    expect(result.unchanged).toBe(1)
    expect(builds).toBe(3)

    await manager.closeAll()
  })

  test('a device running a job is reported in skippedBusy and its session is never restarted (rule 4)', async () => {
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
      resolveProfile: (_deviceId, quality) => ({
        quality,
        maxSize: 480,
        maxFps: wallFps.current,
        bitRate: 800_000,
        source: { maxSize: 'preset', maxFps: 'farm', bitRate: 'preset' },
      }),
      hasRunningJob: (deviceId) => runningJobDeviceIds.has(deviceId),
    })

    await manager.build('dev-busy', { requireScrcpy: true })
    const busySession = manager.get('dev-busy')
    await manager.build('dev-idle', { requireScrcpy: true })
    expect(builds).toBe(2)
    runningJobDeviceIds.add('dev-busy')
    wallFps.current = 9

    const result = await manager.reprofile!('farm settings changed')
    expect(result.skippedBusy).toEqual(['dev-busy'])
    expect(result.restarted).toEqual(['dev-idle'])
    expect(manager.get('dev-busy')).toBe(busySession)
    expect(builds).toBe(3)

    await manager.closeAll()
  })
})

describe('SessionManager — one wake per session start (plan 125 §3.7 — unaffected by plan 206)', () => {
  test('deviceIsAwake: true skips the wake at build time', async () => {
    const calls: string[] = []
    const client = {
      exec: async (_serial: string, cmd: string) => {
        calls.push(cmd)
        return { stdout: '', stderr: '', exitCode: 0 }
      },
      execOut: async () => new Uint8Array(),
    } as unknown as AdbClient
    const manager = createSessionManager({
      client,
      devices,
      log: silentLog(),
      makeScrcpy: async () => fakeScrcpy(),
      deviceIsAwake: () => true,
    })
    await manager.build(DEVICE_ID, { requireScrcpy: true })
    expect(calls.some((c) => c.startsWith('svc power stayon'))).toBe(false)
    await manager.closeAll()
  })
})
