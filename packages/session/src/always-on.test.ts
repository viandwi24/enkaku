import { describe, expect, test } from 'bun:test'
import type { TrackedDevice } from '@enkaku/adb'
import {
  createAlwaysOn,
  usbRootOf,
  rebuildDelayMs,
  prepLabel,
  recoveringLabel,
  PREP_QUEUED_LABEL,
  REBUILD_BACKOFF_MS,
  REBUILD_JITTER,
  rebuildOrder,
  recoveryStepOf,
  INSPECTOR_PREWARM_DELAY_MS,
  FIRST_FRAME_TIMEOUT_MS,
  type ActivityPort,
  type AlwaysOnDeps,
} from './always-on'
import type { SessionManager, PrepStep } from './manager'
import type { DeviceSnapshot, DeviceSnapshotSource } from './types'
import type { Logger } from './logger'

const silentLog = (): Logger => {
  const l = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => l }
  return l as unknown as Logger
}

function snapshotFor(id: string, serial: string): DeviceSnapshot {
  return {
    id,
    stableId: `stable-${id}`,
    serial,
    label: id,
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
  }
}

/** A fake, controllable clock/timer pair. */
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
    /** Fires every timer due at or before `now + ms`, advancing one at a time so a fired timer can itself schedule another. */
    advance(ms: number) {
      const target = now + ms
      for (;;) {
        let earliest: { id: number; at: number; fn: () => void } | null = null
        for (const [id, entry] of pending) {
          if (entry.at <= target && (!earliest || entry.at < earliest.at)) earliest = { id, at: entry.at, fn: entry.fn }
        }
        if (!earliest) break
        pending.delete(earliest.id)
        now = earliest.at
        earliest.fn()
      }
      now = target
    },
    /**
     * How many timers are armed. The park path (2026-09-18) is defined by the absence of one — a
     * parked device waits for its phone to come back, not for a delay — and "no rebuild was
     * scheduled" cannot be asserted by advancing a clock, only by looking.
     */
    pending: () => pending.size,
  }
}

/** A fake `SessionManager` narrowed to what `AlwaysOnDeps.sessions` needs — `build` is scripted per test. */
function fakeSessions(buildImpl: (deviceId: string, opts: { requireScrcpy: boolean; onStep?: (step: PrepStep) => void }) => Promise<void>): Pick<SessionManager, 'build' | 'closeDevice' | 'get'> {
  const built = new Set<string>()
  return {
    build: async (deviceId, opts) => {
      await buildImpl(deviceId, opts)
      built.add(deviceId)
    },
    closeDevice: async () => {},
    get: (deviceId) => (built.has(deviceId) ? ({ prewarmInspector: async () => {} } as never) : null),
  }
}

/** Records every activity call — `start` returns a monotonically increasing id per device. */
function recordingActivities(): ActivityPort & { calls: string[]; lastLabel: (deviceId: string) => string | undefined; lastMeta: (deviceId: string) => Record<string, unknown> | undefined } {
  const labels = new Map<string, string>()
  const metas = new Map<string, Record<string, unknown>>()
  const calls: string[] = []
  return {
    calls,
    start: (deviceId, input) => {
      calls.push(`start:${deviceId}:${input.label}`)
      labels.set(deviceId, input.label)
      if (input.meta) metas.set(deviceId, input.meta)
      return `prep:${deviceId}`
    },
    update: (deviceId, id, patch) => {
      calls.push(`update:${deviceId}:${id}:${patch.label ?? ''}`)
      if (patch.label) labels.set(deviceId, patch.label)
      if (patch.meta) metas.set(deviceId, patch.meta)
    },
    end: (deviceId, id) => {
      calls.push(`end:${deviceId}:${id}`)
    },
    lastLabel: (deviceId) => labels.get(deviceId),
    lastMeta: (deviceId) => metas.get(deviceId),
  }
}

function baseDeps(overrides: Partial<AlwaysOnDeps> = {}): AlwaysOnDeps {
  const devices: DeviceSnapshotSource = { get: () => null }
  return {
    sessions: fakeSessions(async () => {}),
    devices,
    listDevices: async () => [],
    deviceNumber: () => null,
    activities: recordingActivities(),
    buildsPerUsbRoot: () => 4,
    log: silentLog(),
    // The unjittered midpoint, so every test that asserts the backoff schedule sees its exact numbers.
    rng: () => 0.5,
    ...overrides,
  }
}

describe('usbRootOf (plan 206 §4.2)', () => {
  test('3-1.4.3 is 3', () => {
    expect(usbRootOf('3-1.4.3')).toBe('3')
  })
  test('undefined is network', () => {
    expect(usbRootOf(undefined)).toBe('network')
  })
  test('no dash at all is the whole string', () => {
    expect(usbRootOf('nodash')).toBe('nodash')
  })
})

describe('rebuildDelayMs (plan 206 §4.2)', () => {
  test('jitter spreads each rung by ±30% and never beyond', () => {
    expect(rebuildDelayMs(1, () => 0)).toBe(700)
    expect(rebuildDelayMs(1, () => 0.5)).toBe(1_000)
    expect(rebuildDelayMs(1, () => 0.999_999)).toBe(1_300)
    expect(rebuildDelayMs(4, () => 0)).toBe(21_000)
    expect(rebuildDelayMs(4, () => 1)).toBe(39_000)
    // An rng out of range is clamped, not trusted.
    expect(rebuildDelayMs(2, () => 7)).toBe(3_000 * (1 + REBUILD_JITTER))
    expect(rebuildDelayMs(2, () => -1)).toBe(3_000 * (1 - REBUILD_JITTER))
  })

  test('matches the documented schedule and repeats the last value', () => {
    expect(rebuildDelayMs(1)).toBe(REBUILD_BACKOFF_MS[0])
    expect(rebuildDelayMs(2)).toBe(REBUILD_BACKOFF_MS[1])
    expect(rebuildDelayMs(3)).toBe(REBUILD_BACKOFF_MS[2])
    expect(rebuildDelayMs(4)).toBe(REBUILD_BACKOFF_MS[3])
    expect(rebuildDelayMs(5)).toBe(REBUILD_BACKOFF_MS[3])
    expect(rebuildDelayMs(99)).toBe(REBUILD_BACKOFF_MS[3])
  })
})

describe('label helpers', () => {
  test('prepLabel', () => {
    expect(prepLabel(3)).toBe('Preparing, step 3 of 5')
  })
  test('recoveringLabel', () => {
    expect(recoveringLabel(2)).toBe('Recovering, attempt 2')
  })
})

/*
  A build against a phone adb does not have cannot succeed, and no delay makes
  it succeed. Before 2026-09-18 it went on the ordinary backoff ladder, which
  tops out at 30 s — so a hub that dropped twenty phones produced twenty doomed
  builds every half minute, each one a rotation assert, a farm tag and a scrcpy
  handshake aimed at nothing, for as long as the phones were away.

  The farm-wide brake (`adbReachable`) does not cover this: it only holds once
  the health monitor has latched `server-unreachable`, and a server that comes
  back in eight seconds — which is what the owner's did — never latches it. The
  log of that morning contains no "holding N queued build(s)" line at all.
*/
describe('createAlwaysOn — a device adb has lost (2026-09-18)', () => {
  const GONE = () => new Error("device 'R9RY90A6X4X' not found")

  test('parks instead of scheduling a rebuild, and schedules no timer at all', async () => {
    const { timers, advance, pending } = fakeTimers()
    const deps = baseDeps({
      sessions: fakeSessions(async () => {
        throw GONE()
      }),
      timers,
    })
    const alwaysOn = createAlwaysOn(deps)
    alwaysOn.start()
    alwaysOn.deviceOnline('d1')
    await Bun.sleep(5)
    expect(alwaysOn.stateOf('d1').state).toBe('recovering')
    // The ladder's first rung is 1 s. Nothing may be waiting on it.
    expect(pending()).toBe(0)
    advance(60_000)
    expect(alwaysOn.stats().running).toBe(0)
  })

  test('the phone coming back requeues it immediately — no backoff to wait out', async () => {
    const { timers, advance } = fakeTimers()
    let fail = true
    const deps = baseDeps({
      sessions: fakeSessions(async () => {
        if (fail) throw GONE()
      }),
      timers,
    })
    const alwaysOn = createAlwaysOn(deps)
    alwaysOn.start()
    alwaysOn.deviceOnline('d1')
    await Bun.sleep(5)
    expect(alwaysOn.stateOf('d1').state).toBe('recovering')

    fail = false
    // `onDeviceReady` fires this on a flap-return too, which is what un-parks it.
    alwaysOn.deviceOnline('d1')
    await Bun.sleep(5)
    expect(['preparing', 'ready']).toContain(alwaysOn.stateOf('d1').state)
  })

  /** The narrowness that matters: an ordinary build failure still retries. */
  test('a build that fails for any other reason still goes on the backoff ladder', async () => {
    const { timers, pending } = fakeTimers()
    const deps = baseDeps({
      sessions: fakeSessions(async () => {
        throw new Error('the scrcpy server never answered on port 65360')
      }),
      timers,
    })
    const alwaysOn = createAlwaysOn(deps)
    alwaysOn.start()
    alwaysOn.deviceOnline('d1')
    await Bun.sleep(5)
    expect(alwaysOn.stateOf('d1').state).toBe('recovering')
    expect(pending()).toBeGreaterThan(0)
  })
})

describe('createAlwaysOn — the pump (plan 206 §4.2)', () => {
  test('deviceOnline enqueues exactly one build', async () => {
    let builds = 0
    const { timers } = fakeTimers()
    const always = createAlwaysOn(
      baseDeps({
        sessions: fakeSessions(async () => {
          builds++
        }),
        timers,
      }),
    )
    always.start()
    always.deviceOnline('dev-1')
    await Bun.sleep(5)
    expect(builds).toBe(1)
    // A second deviceOnline while it's already ready/queued/preparing is a no-op.
    always.deviceOnline('dev-1')
    await Bun.sleep(5)
    expect(builds).toBe(1)
  })

  test('calls before start() are queued and run at start()', async () => {
    let builds = 0
    const always = createAlwaysOn(
      baseDeps({
        sessions: fakeSessions(async () => {
          builds++
        }),
      }),
    )
    always.deviceOnline('dev-1')
    await Bun.sleep(5)
    expect(builds).toBe(0) // not started yet
    always.start()
    await Bun.sleep(5)
    expect(builds).toBe(1)
  })

  test('a queued device carries the Preparing, queued label', async () => {
    const activities = recordingActivities()
    let resolveBuild!: () => void
    const always = createAlwaysOn(
      baseDeps({
        activities,
        sessions: fakeSessions(() => new Promise((resolve) => (resolveBuild = resolve))),
      }),
    )
    always.start()
    always.deviceOnline('dev-1')
    expect(activities.lastLabel('dev-1')).toBe(PREP_QUEUED_LABEL)
    await Bun.sleep(5) // let the pump's own usb-root refresh (a microtask hop) reach sessions.build
    resolveBuild()
    await Bun.sleep(5)
  })

  test('steps update the label Preparing, step n of 5 and step 5 ends the activity', async () => {
    const activities = recordingActivities()
    const always = createAlwaysOn(
      baseDeps({
        activities,
        sessions: fakeSessions(async (_id, opts) => {
          for (const step of [1, 2, 3, 4, 5] as const) opts.onStep?.(step)
        }),
      }),
    )
    always.start()
    always.deviceOnline('dev-1')
    await Bun.sleep(5)
    expect(activities.calls).toContain('end:dev-1:prep:dev-1')
    expect(always.stateOf('dev-1').state).toBe('ready')
  })

  test('stagger: at most buildsPerUsbRoot builds per root run at once', async () => {
    const running = new Set<string>()
    let maxConcurrent = 0
    const gates = new Map<string, () => void>()
    const devices: DeviceSnapshotSource = {
      get: (id) => snapshotFor(id, id),
    }
    const always = createAlwaysOn(
      baseDeps({
        devices,
        listDevices: async () => Array.from({ length: 8 }, (_, i) => ({ serial: `dev-${i + 1}`, state: 'device', usb: '3-1.1' }) as TrackedDevice),
        buildsPerUsbRoot: () => 2,
        sessions: fakeSessions(
          (id) =>
            new Promise<void>((resolve) => {
              running.add(id)
              maxConcurrent = Math.max(maxConcurrent, running.size)
              gates.set(id, () => {
                running.delete(id)
                resolve()
              })
            }),
        ),
      }),
    )
    always.start()
    for (let i = 1; i <= 8; i++) always.deviceOnline(`dev-${i}`)
    await Bun.sleep(20)
    expect(maxConcurrent).toBeLessThanOrEqual(2)
    for (const release of gates.values()) release()
    await Bun.sleep(20)
  })

  test('stagger: the farm ceiling bounds the sum across roots', async () => {
    const running = new Set<string>()
    let maxConcurrent = 0
    const gates = new Map<string, () => void>()
    const devices: DeviceSnapshotSource = { get: (id) => snapshotFor(id, id) }
    const always = createAlwaysOn(
      baseDeps({
        devices,
        listDevices: async () =>
          Array.from({ length: 8 }, (_, i) => ({ serial: `dev-${i + 1}`, state: 'device', usb: i < 4 ? '3-1.1' : '4-1.1' }) as TrackedDevice),
        buildsPerUsbRoot: () => 4,
        farmCeiling: () => 3,
        sessions: fakeSessions(
          (id) =>
            new Promise<void>((resolve) => {
              running.add(id)
              maxConcurrent = Math.max(maxConcurrent, running.size)
              gates.set(id, () => {
                running.delete(id)
                resolve()
              })
            }),
        ),
      }),
    )
    always.start()
    for (let i = 1; i <= 8; i++) always.deviceOnline(`dev-${i}`)
    await Bun.sleep(20)
    expect(maxConcurrent).toBeLessThanOrEqual(3)
    for (const release of gates.values()) release()
    await Bun.sleep(20)
  })

  test('stagger: pending builds start in device-number order', async () => {
    const order: string[] = []
    const gates: Array<() => void> = []
    const numbers: Record<string, number | null> = { 'dev-a': 3, 'dev-b': 1, 'dev-c': 2 }
    const always = createAlwaysOn(
      baseDeps({
        deviceNumber: (id) => numbers[id] ?? null,
        buildsPerUsbRoot: () => 1,
        sessions: fakeSessions(
          (id) =>
            new Promise<void>((resolve) => {
              order.push(id)
              gates.push(resolve)
            }),
        ),
      }),
    )
    always.start()
    always.deviceOnline('dev-a')
    always.deviceOnline('dev-b')
    always.deviceOnline('dev-c')
    await Bun.sleep(10)
    // Only one build runs at a time (buildsPerUsbRoot: 1) — release them in turn.
    while (gates.length > 0) {
      gates.shift()!()
      await Bun.sleep(10)
    }
    expect(order).toEqual(['dev-b', 'dev-c', 'dev-a'])
  })

  test('a listDevices rejection groups every device under unknown and still builds', async () => {
    let builds = 0
    const always = createAlwaysOn(
      baseDeps({
        listDevices: async () => {
          throw new Error('adb not ready')
        },
        sessions: fakeSessions(async () => {
          builds++
        }),
      }),
    )
    always.start()
    always.deviceOnline('dev-1')
    await Bun.sleep(10)
    expect(builds).toBe(1)
  })
})

describe('createAlwaysOn — failure and recovery (plan 206 §4.2, §3.6)', () => {
  test('scrcpy death: rebuild after 1 s, 3 s, 10 s, 30 s, 30 s with a recovering meta', async () => {
    const { timers, advance } = fakeTimers()
    const activities = recordingActivities()
    let buildAttempt = 0
    const always = createAlwaysOn(
      baseDeps({
        timers,
        activities,
        sessions: fakeSessions(async (_id, opts) => {
          buildAttempt++
          for (const step of [1, 2, 3, 4, 5] as const) opts.onStep?.(step)
        }),
      }),
    )
    always.start()
    always.deviceOnline('dev-1')
    await Bun.sleep(5)
    expect(always.stateOf('dev-1').state).toBe('ready')

    // The session died on its own — schedule the first rebuild.
    always.sessionEnded('dev-1', 'display error')
    expect(always.stateOf('dev-1').state).toBe('recovering')
    expect(activities.lastLabel('dev-1')).toBe('Recovering, attempt 1')
    expect(activities.lastMeta('dev-1')).toMatchObject({ recovering: true, attempt: 1 })

    advance(1_000)
    await Bun.sleep(5)
    expect(buildAttempt).toBe(2)
    expect(always.stateOf('dev-1').state).toBe('ready')

    always.sessionEnded('dev-1', 'display error')
    expect(activities.lastLabel('dev-1')).toBe('Recovering, attempt 1')
    advance(3_000)
    await Bun.sleep(5)
    expect(buildAttempt).toBe(3)

    always.sessionEnded('dev-1', 'display error')
    advance(10_000)
    await Bun.sleep(5)
    expect(buildAttempt).toBe(4)

    always.sessionEnded('dev-1', 'display error')
    advance(30_000)
    await Bun.sleep(5)
    expect(buildAttempt).toBe(5)

    always.sessionEnded('dev-1', 'display error')
    advance(30_000) // the fifth failure repeats the last (30s) step
    await Bun.sleep(5)
    expect(buildAttempt).toBe(6)
  })

  test('a build that reaches step 5 resets the attempt counter', async () => {
    const { timers, advance } = fakeTimers()
    let fail = true
    const always = createAlwaysOn(
      baseDeps({
        timers,
        sessions: fakeSessions(async (_id, opts) => {
          if (fail) {
            fail = false
            throw new Error('transient')
          }
          for (const step of [1, 2, 3, 4, 5] as const) opts.onStep?.(step)
        }),
      }),
    )
    always.start()
    always.deviceOnline('dev-1')
    await Bun.sleep(5)
    expect(always.stateOf('dev-1').attempt).toBe(1)
    advance(1_000)
    await Bun.sleep(5)
    expect(always.stateOf('dev-1').state).toBe('ready')
    expect(always.stateOf('dev-1').attempt).toBe(0)
  })

  test('the fifth consecutive failure builds without requireScrcpy', async () => {
    const { timers, advance } = fakeTimers()
    const seenRequireScrcpy: boolean[] = []
    const always = createAlwaysOn(
      baseDeps({
        timers,
        sessions: fakeSessions(async (_id, opts) => {
          seenRequireScrcpy.push(opts.requireScrcpy)
          throw new Error('scrcpy unavailable')
        }),
      }),
    )
    always.start()
    always.deviceOnline('dev-1')
    await Bun.sleep(5)
    for (const delay of [1_000, 3_000, 10_000, 30_000]) {
      advance(delay)
      await Bun.sleep(5)
    }
    expect(seenRequireScrcpy).toEqual([true, true, true, true, false])
  })

  test('deviceOffline cancels the timer and ends the activity', async () => {
    const { timers } = fakeTimers()
    const activities = recordingActivities()
    const always = createAlwaysOn(
      baseDeps({
        timers,
        activities,
        sessions: fakeSessions(async () => {
          throw new Error('fails forever')
        }),
      }),
    )
    always.start()
    always.deviceOnline('dev-1')
    await Bun.sleep(5)
    expect(always.stateOf('dev-1').state).toBe('recovering')
    always.deviceOffline('dev-1')
    expect(activities.calls).toContain('end:dev-1:prep:dev-1')
    expect(always.stateOf('dev-1').state).toBe('none')
  })
})

describe('createAlwaysOn — inspector prewarm (plan 206 §3.9, §4.2)', () => {
  test('inspector prewarm is called 2 s after the first frame, never before', async () => {
    const { timers, advance } = fakeTimers()
    let prewarmed = 0
    const sessions: Pick<SessionManager, 'build' | 'closeDevice' | 'get'> = {
      build: async (_id, opts) => {
        for (const step of [1, 2, 3, 4, 5] as const) opts.onStep?.(step)
      },
      closeDevice: async () => {},
      get: () => ({ prewarmInspector: async () => void prewarmed++ }) as never,
    }
    const always = createAlwaysOn(baseDeps({ timers, sessions }))
    always.start()
    always.deviceOnline('dev-1')
    await Bun.sleep(5)
    expect(prewarmed).toBe(0)
    advance(INSPECTOR_PREWARM_DELAY_MS - 1)
    expect(prewarmed).toBe(0)
    advance(1)
    await Bun.sleep(5)
    expect(prewarmed).toBe(1)
  })
})

/*
  The owner's emulator sat at "Preparing, step 4 of 5" for the life of the
  core: `build()` had resolved, the display had started, and no frame ever
  arrived. Step 5 is emitted only by the first-frame handler, so nothing was
  left to move the record — and `retry-prepare` was refused BY that same
  activity. These assert the deadline that ends it.
*/
/** Lets every pending microtask and real-timer callback run — `pump()` is async. */
const flush = () => new Promise<void>((r) => setTimeout(r, 0))

describe('a session that never produces a first frame', () => {
  test('is rebuilt once the deadline passes, instead of preparing for ever', async () => {
    const { timers, advance } = fakeTimers()
    const activities = recordingActivities()
    let builds = 0
    const deps = baseDeps({
      timers,
      activities,
      // Reaches `waiting-frame` and stops there — exactly what an emulator
      // whose encoder produces nothing does.
      sessions: fakeSessions(async (_id, opts) => {
        builds++
        opts.onStep?.(1)
        opts.onStep?.(4)
      }),
    })
    const alwaysOn = createAlwaysOn(deps)
    alwaysOn.start()
    alwaysOn.deviceOnline('d1')
    await Promise.resolve()
    advance(0)
    await flush()

    expect(activities.lastLabel('d1')).toBe(prepLabel(4))
    expect(builds).toBe(1)

    // Nothing happens before the deadline — a slow first frame is still a
    // first frame, and rebuilding under it would be worse than waiting.
    advance(FIRST_FRAME_TIMEOUT_MS - 1)
    await flush()
    expect(activities.lastLabel('d1')).toBe(prepLabel(4))

    advance(2)
    await flush()
    expect(activities.lastLabel('d1')).toBe(recoveringLabel(1))
  })

  test('closes the stuck entry before rebuilding, so the rebuild is not a no-op against the same session', async () => {
    // `SessionManager.build()` resolves immediately, with no `onStep` at all,
    // when the device's entry is still in the map (manager.ts's `build()`:
    // `if (entries.has(key)) return`). This fake mirrors exactly that —
    // proving the always-on builder must close the stuck entry itself
    // before the next `build()` can ever run a fresh attempt (owner's moto
    // g06, 2026-09-11: "Recovering, attempt N" looping for 15 minutes with
    // the same device-side scrcpy process still alive, because nothing ever
    // closed it).
    const { timers, advance } = fakeTimers()
    const activities = recordingActivities()
    let builds = 0
    let closes = 0
    const built = new Set<string>()
    const sessions: Pick<SessionManager, 'build' | 'closeDevice' | 'get'> = {
      build: async (deviceId, opts) => {
        if (built.has(deviceId)) return
        built.add(deviceId)
        builds++
        opts.onStep?.(1)
        opts.onStep?.(4) // stuck: the encoder never produces a frame
      },
      closeDevice: async (deviceId) => {
        closes++
        built.delete(deviceId)
      },
      get: () => null,
    }
    const alwaysOn = createAlwaysOn(baseDeps({ timers, activities, sessions }))
    alwaysOn.start()
    alwaysOn.deviceOnline('d1')
    await Promise.resolve()
    advance(0)
    await flush()
    expect(builds).toBe(1)

    // The deadline passes with no frame.
    advance(FIRST_FRAME_TIMEOUT_MS)
    await flush()
    expect(closes).toBe(1) // the stuck entry was torn down before the rebuild was scheduled
    expect(activities.lastLabel('d1')).toBe(recoveringLabel(1))

    // The backoff elapses and the rebuild actually calls `build()` again —
    // proof it is a fresh attempt, not the same frameless entry reused.
    advance(1_000)
    await flush()
    expect(builds).toBe(2)
  })

  test('a frame that does arrive disarms the deadline and ends the activity', async () => {
    const { timers, advance } = fakeTimers()
    const activities = recordingActivities()
    let builds = 0
    const deps = baseDeps({
      timers,
      activities,
      sessions: fakeSessions(async (_id, opts) => {
        builds++
        opts.onStep?.(4)
        opts.onStep?.(5)
      }),
    })
    const alwaysOn = createAlwaysOn(deps)
    alwaysOn.start()
    alwaysOn.deviceOnline('d1')
    await Promise.resolve()
    advance(0)
    await flush()

    expect(activities.calls).toContain('end:d1:prep:d1')
    // Long past the deadline: it must not fire against a healthy device.
    advance(FIRST_FRAME_TIMEOUT_MS * 3)
    await flush()
    expect(builds).toBe(1)
    expect(activities.lastLabel('d1')).not.toBe(recoveringLabel(1))
  })
})

describe('rebuildOrder — round-robin from the last device given a slot', () => {
  const numbers: Record<string, number | null> = { a: 1, b: 2, c: 3, d: 4, z: null }
  const numberOf = (id: string) => numbers[id] ?? null

  test('with no cursor it is plain device-number order, unnumbered last', () => {
    expect(rebuildOrder(['z', 'c', 'a', 'd', 'b'], numberOf, null)).toEqual(['a', 'b', 'c', 'd', 'z'])
  })

  test('it starts just after the cursor and wraps', () => {
    expect(rebuildOrder(['a', 'b', 'c', 'd', 'z'], numberOf, { number: 2, id: 'b' })).toEqual(['c', 'd', 'z', 'a', 'b'])
  })

  test('a cursor past the end wraps to the start', () => {
    expect(rebuildOrder(['a', 'b', 'c'], numberOf, { number: null, id: 'zz' })).toEqual(['a', 'b', 'c'])
  })

  test('the cursor need not still be queued', () => {
    expect(rebuildOrder(['a', 'd'], numberOf, { number: 3, id: 'c' })).toEqual(['d', 'a'])
  })
})

describe('recoveryStepOf', () => {
  test('steps 1-3 are building, 4 and 5 are waiting for the picture', () => {
    expect([1, 2, 3, 4, 5].map((s) => recoveryStepOf(s as PrepStep))).toEqual(['building', 'building', 'building', 'waiting-frame', 'waiting-frame'])
  })
})

describe('a recovering rebuild says where it is (meta.step)', () => {
  test('queued during the backoff, building once it has a slot, waiting-frame at step 4', async () => {
    const { timers, advance } = fakeTimers()
    const activities = recordingActivities()
    let buildNo = 0
    let finishSecond: (() => void) | null = null
    const always = createAlwaysOn(
      baseDeps({
        timers,
        activities,
        sessions: fakeSessions(async (_id, opts) => {
          buildNo++
          if (buildNo === 1) {
            for (const step of [1, 2, 3, 4, 5] as const) opts.onStep?.(step)
            return
          }
          opts.onStep?.(1)
          expect(activities.lastMeta('dev-1')).toMatchObject({ recovering: true, attempt: 1, step: 'building' })
          opts.onStep?.(4)
          await new Promise<void>((resolve) => (finishSecond = resolve))
          opts.onStep?.(5)
        }),
      }),
    )
    always.start()
    always.deviceOnline('dev-1')
    await flush()
    always.sessionEnded('dev-1', 'socket closed')
    expect(activities.lastMeta('dev-1')).toMatchObject({ recovering: true, attempt: 1, step: 'queued' })
    advance(1_000)
    await flush()
    expect(activities.lastMeta('dev-1')).toMatchObject({ recovering: true, attempt: 1, step: 'waiting-frame' })
    finishSecond!()
    await flush()
    expect(always.stateOf('dev-1').state).toBe('ready')
  })

  test('a first build carries no recovering meta at all', async () => {
    const activities = recordingActivities()
    const always = createAlwaysOn(
      baseDeps({
        activities,
        sessions: fakeSessions(async (_id, opts) => {
          opts.onStep?.(1)
          opts.onStep?.(4)
        }),
      }),
    )
    always.start()
    always.deviceOnline('dev-1')
    await flush()
    expect(activities.lastMeta('dev-1')).toBeUndefined()
    await always.stop()
  })
})

describe('a device that comes back while its rebuild waits out a backoff', () => {
  test('is rebuilt now, once, and the old backoff timer does not queue it a second time', async () => {
    const { timers, advance } = fakeTimers()
    let builds = 0
    let failNext = true
    const always = createAlwaysOn(
      baseDeps({
        timers,
        sessions: fakeSessions(async (_id, opts) => {
          builds++
          if (failNext) {
            failNext = false
            throw new Error('device not found')
          }
          for (const step of [1, 2, 3, 4, 5] as const) opts.onStep?.(step)
        }),
      }),
    )
    always.start()
    always.deviceOnline('dev-1')
    await flush()
    expect(builds).toBe(1)
    expect(always.stateOf('dev-1').state).toBe('recovering')

    // The phone is back (a flap inside the grace) before the 1 s backoff ends.
    advance(200)
    always.deviceOnline('dev-1')
    await flush()
    expect(builds).toBe(2)
    expect(always.stateOf('dev-1').state).toBe('ready')
    // The attempt counter is not reset by the return itself — only a frame does that.
    expect(always.stateOf('dev-1').attempt).toBe(0)

    // The original backoff would have fired here and started a phantom
    // second build against the healthy session.
    advance(5_000)
    await flush()
    expect(builds).toBe(2)
    advance(FIRST_FRAME_TIMEOUT_MS * 2)
    await flush()
    expect(builds).toBe(2)
    expect(always.stateOf('dev-1').state).toBe('ready')
  })
})

describe('jittered backoff uses the injected rng', () => {
  test('rng 0 rebuilds at 700 ms, not at 1 s', async () => {
    const { timers, advance } = fakeTimers()
    let builds = 0
    const always = createAlwaysOn(
      baseDeps({
        timers,
        rng: () => 0,
        sessions: fakeSessions(async (_id, opts) => {
          builds++
          for (const step of [1, 2, 3, 4, 5] as const) opts.onStep?.(step)
        }),
      }),
    )
    always.start()
    always.deviceOnline('dev-1')
    await flush()
    always.sessionEnded('dev-1', 'socket closed')
    advance(699)
    await flush()
    expect(builds).toBe(1)
    advance(1)
    await flush()
    expect(builds).toBe(2)
  })
})
