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
  INSPECTOR_PREWARM_DELAY_MS,
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
