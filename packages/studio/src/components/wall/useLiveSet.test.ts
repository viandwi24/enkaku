import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import type { DeviceInfo } from '@enkaku/protocol'
import { computeLiveSet, DWELL_MS, RAMP_STEP_MS, useLiveSet, type LiveSetInput } from './useLiveSet'

/**
 * `computeLiveSet` is the pure decision function this step's own brief asks
 * to keep "genuinely pure and separately testable" — every test in the
 * first `describe` block below calls it directly, with no DOM, no React, no
 * timers. It is what proves the ordering/eviction/budget/ramp rules of plan
 * 92 §4.6 hold, independent of whether the `IntersectionObserver`/dwell/ramp
 * wiring in `useLiveSet` itself (the second `describe` block, which DOES
 * need a DOM) is right.
 */

function device(id: string, overrides: Partial<DeviceInfo> = {}): DeviceInfo {
  return {
    id,
    stableId: id,
    serial: id,
    label: id,
    androidVersion: '15',
    apiLevel: 35,
    screenW: 720,
    screenH: 1600,
    density: 280,
    status: 'idle',
    lastSeen: 1,
    battery: null,
    quarantineReason: null,
    tags: [],
    cluster: null,
    lastCrashAt: null,
    readiness: { desired: 'awake', actual: 'awake', blocked: null, since: 0 },
    ...overrides,
  }
}

function hot(id: string): DeviceInfo {
  return device(id, { readiness: { desired: 'hot', actual: 'hot', blocked: null, since: 0 } })
}

function asleep(id: string): DeviceInfo {
  return device(id, { readiness: { desired: 'asleep', actual: 'asleep', blocked: null, since: 0 } })
}

function baseInput(overrides: Partial<LiveSetInput> = {}): LiveSetInput {
  return {
    devices: [],
    maxTiles: 8,
    rampConcurrency: 2,
    visibleIds: [],
    pinnedIds: [],
    liveIds: [],
    now: 0,
    ...overrides,
  }
}

describe('computeLiveSet — eligibility (plan 92 §3.2 rule 1, fixes F12)', () => {
  test('offline, quarantined and asleep devices are always blocked with the right reason, never a candidate', () => {
    const devices = [device('offline1', { status: 'offline' }), device('q1', { status: 'quarantined' }), asleep('sleeper'), device('ok')]
    const result = computeLiveSet(baseInput({ devices, visibleIds: devices.map((d) => d.id) }))
    expect(result.blocked).toEqual(
      expect.arrayContaining([
        { id: 'offline1', reason: 'offline' },
        { id: 'q1', reason: 'quarantined' },
        { id: 'sleeper', reason: 'asleep' },
      ]),
    )
    expect(result.blocked.length).toBe(3)
    expect(result.live).toEqual(['ok'])
    expect(result.pending).toEqual([])
    expect(result.budgeted).toEqual([])
  })

  test('an asleep device that is ALSO in liveIds/visibleIds/pinnedIds from a stale caller is still blocked — belt-and-braces (F12)', () => {
    const devices = [asleep('sleeper')]
    const result = computeLiveSet(baseInput({ devices, visibleIds: ['sleeper'], pinnedIds: ['sleeper'], liveIds: ['sleeper'] }))
    expect(result.live).toEqual([])
    expect(result.pending).toEqual([])
    expect(result.budgeted).toEqual([])
    expect(result.blocked).toEqual([{ id: 'sleeper', reason: 'asleep' }])
  })
})

describe('computeLiveSet — ordering within the cap (plan 92 §4.6, tests H2)', () => {
  test('ranks pinned > visible-and-hot > visible-and-already-live > visible-and-new; an off-screen, never-pinned, never-live device is never promoted even when the cap has room (§3.2 rule 2)', () => {
    const devices = [device('offscreen'), device('newAwake'), device('alreadyLive'), hot('hotOne'), device('pinnedOne')]
    const result = computeLiveSet(
      baseInput({
        devices,
        maxTiles: 8, // plenty of room — proves 'offscreen' is excluded on principle, not on cap pressure
        rampConcurrency: 8,
        visibleIds: ['newAwake', 'alreadyLive', 'hotOne'], // 'offscreen' and 'pinnedOne' are NOT visible
        pinnedIds: ['pinnedOne'],
        liveIds: ['alreadyLive'],
      }),
    )
    expect(result.live).toEqual(['pinnedOne', 'hotOne', 'alreadyLive', 'newAwake'])
    expect(result.pending).toEqual([])
    expect(result.budgeted).toEqual(['offscreen'])
  })

  test('an already-live tile is never evicted by a same-or-higher-tier newcomer at the cap; the newcomer is budgeted instead (stability)', () => {
    const devices = [device('live1'), device('newcomer')]
    const result = computeLiveSet(
      baseInput({
        devices,
        maxTiles: 1,
        rampConcurrency: 8,
        // 'newcomer' is listed FIRST (i.e. "newest") in visibleIds — without
        // the stability rule a plain visible-order sort would put it ahead
        // of 'live1' and evict a tile that is already decoding.
        visibleIds: ['newcomer', 'live1'],
        liveIds: ['live1'],
      }),
    )
    expect(result.live).toEqual(['live1'])
    expect(result.budgeted).toEqual(['newcomer'])
  })

  test('a previously-live tile that scrolled off screen is the FIRST evicted under budget pressure (§3.2 rule 4)', () => {
    const devices = [device('scrolledOff'), hot('nowVisibleHot')]
    const result = computeLiveSet(
      baseInput({
        devices,
        maxTiles: 1,
        rampConcurrency: 8,
        visibleIds: ['nowVisibleHot'], // 'scrolledOff' is no longer in the viewport at all
        liveIds: ['scrolledOff'],
      }),
    )
    expect(result.live).toEqual(['nowVisibleHot'])
    expect(result.budgeted).toEqual(['scrolledOff'])
  })
})

describe('computeLiveSet — the budget (plan 92 §3.2 rule 4, §3.7)', () => {
  test('honours maxTiles as a hard cap; the remainder is reported budgeted, in rank order', () => {
    const devices = [device('a'), device('b'), device('c')]
    const result = computeLiveSet(baseInput({ devices, maxTiles: 2, rampConcurrency: 8, visibleIds: ['a', 'b', 'c'] }))
    expect(result.live.length + result.pending.length).toBe(2)
    expect(result.budgeted).toEqual(['c'])
  })

  test('maxTiles 0 means "no budget known yet" — never "auto": nothing is live, every eligible device is budgeted', () => {
    const devices = [device('a'), device('b')]
    const result = computeLiveSet(baseInput({ devices, maxTiles: 0, visibleIds: ['a', 'b'] }))
    expect(result.live).toEqual([])
    expect(result.pending).toEqual([])
    expect([...result.budgeted].sort()).toEqual(['a', 'b'])
  })
})

describe('computeLiveSet — the ramp gate (plan 92 §3.3)', () => {
  test('promotes at most rampConcurrency NEW ids per call, hot ones first; the rest wait as pending', () => {
    const devices = [hot('hot1'), hot('hot2'), device('awake1'), device('awake2')]
    const result = computeLiveSet(
      baseInput({
        devices,
        maxTiles: 8, // the cap does not bind here — only the ramp does
        rampConcurrency: 2,
        visibleIds: ['hot1', 'hot2', 'awake1', 'awake2'],
      }),
    )
    expect(result.live).toEqual(['hot1', 'hot2'])
    expect(result.pending).toEqual(['awake1', 'awake2'])
    expect(result.budgeted).toEqual([])
  })

  test('an id already in liveIds never counts against the ramp — only NEW starts are gated', () => {
    const devices = [device('alreadyLive1'), device('alreadyLive2'), device('newOne')]
    const result = computeLiveSet(
      baseInput({
        devices,
        maxTiles: 8,
        rampConcurrency: 1,
        visibleIds: ['alreadyLive1', 'alreadyLive2', 'newOne'],
        liveIds: ['alreadyLive1', 'alreadyLive2'],
      }),
    )
    // Both already-live ids stay live even though rampConcurrency is 1 —
    // the ramp only gates the one genuinely NEW id.
    expect(new Set(result.live)).toEqual(new Set(['alreadyLive1', 'alreadyLive2', 'newOne']))
    expect(result.pending).toEqual([])
  })
})

describe('useLiveSet — the stateful hook (plan 92 §4.6, tests H2)', () => {
  /**
   * happy-dom's own `IntersectionObserver` is a stub (`observe`/`unobserve`
   * never fire a callback — there is no real layout engine underneath it),
   * so every test below installs this fake instead and fires entries by
   * hand. This is the standard way to test `IntersectionObserver`-driven
   * code in a DOM that has no real geometry, not a workaround specific to
   * this hook.
   */
  class FakeIntersectionObserver implements IntersectionObserver {
    static instances: FakeIntersectionObserver[] = []
    readonly root = null
    readonly rootMargin = ''
    readonly thresholds: ReadonlyArray<number> = []
    observed = new Set<Element>()
    private readonly cb: IntersectionObserverCallback
    constructor(cb: IntersectionObserverCallback) {
      this.cb = cb
      FakeIntersectionObserver.instances.push(this)
    }
    observe(target: Element) {
      this.observed.add(target)
    }
    unobserve(target: Element) {
      this.observed.delete(target)
    }
    disconnect() {
      this.observed.clear()
    }
    takeRecords(): IntersectionObserverEntry[] {
      return []
    }
    fire(target: Element, isIntersecting: boolean) {
      this.cb([{ target, isIntersecting } as IntersectionObserverEntry], this)
    }
  }

  let originalIO: typeof IntersectionObserver

  beforeEach(() => {
    originalIO = globalThis.IntersectionObserver
    FakeIntersectionObserver.instances = []
    globalThis.IntersectionObserver = FakeIntersectionObserver as unknown as typeof IntersectionObserver
  })

  afterEach(() => {
    globalThis.IntersectionObserver = originalIO
    cleanup()
  })

  function mount(devices: DeviceInfo[], opts: { maxTiles?: number; rampConcurrency?: number } = {}) {
    const hook = renderHook((props: { devices: DeviceInfo[] }) => useLiveSet({ devices: props.devices, maxTiles: opts.maxTiles ?? 8, rampConcurrency: opts.rampConcurrency ?? 2 }), {
      initialProps: { devices },
    })
    const els = new Map(devices.map((d) => [d.id, document.createElement('div')]))
    act(() => {
      for (const d of devices) hook.result.current.tileRef(d.id)(els.get(d.id)!)
    })
    const observer = FakeIntersectionObserver.instances[0]!
    return { ...hook, els, observer }
  }

  test('cold load: before any tile reports intersecting, nothing is live — opening the wall wakes nobody', () => {
    const devices = [device('a'), device('b')]
    const { result } = mount(devices)
    expect(result.current.live.size).toBe(0)
    expect(result.current.pending.size).toBe(0)
  })

  test('fast scroll: a tile that intersects and un-intersects before DWELL_MS elapses never becomes live', async () => {
    const devices = [device('a')]
    const { result, els, observer } = mount(devices)
    act(() => observer.fire(els.get('a')!, true))
    await act(async () => {
      await new Promise((r) => setTimeout(r, DWELL_MS / 2))
    })
    act(() => observer.fire(els.get('a')!, false))
    await act(async () => {
      await new Promise((r) => setTimeout(r, DWELL_MS))
    })
    expect(result.current.live.has('a')).toBe(false)
    expect(result.current.pending.has('a')).toBe(false)
  }, 3000)

  test('an asleep device that dwells past DWELL_MS never becomes live (F12) — it stays reported as blocked', async () => {
    const devices = [asleep('sleeper')]
    const { result, els, observer } = mount(devices)
    act(() => observer.fire(els.get('sleeper')!, true))
    await act(async () => {
      await new Promise((r) => setTimeout(r, DWELL_MS + 200))
    })
    expect(result.current.live.has('sleeper')).toBe(false)
    expect(result.current.blocked.get('sleeper')).toBe('asleep')
  }, 3000)

  test('stopping on a row: dwelled tiles become live, hot ones first, at most rampConcurrency at once, the rest a ramp step later', async () => {
    const devices = [device('awake1'), hot('hot1'), device('awake2')]
    const { result, els, observer } = mount(devices, { rampConcurrency: 2 })
    act(() => {
      for (const d of devices) observer.fire(els.get(d.id)!, true)
    })

    await waitFor(
      () => {
        expect(result.current.live.size).toBe(2)
      },
      { timeout: DWELL_MS + 1000 },
    )
    // The hot device is one of the (at most 2) simultaneously outstanding —
    // it is never left waiting behind a cold one (H2, §3.2 rule 3).
    expect(result.current.live.has('hot1')).toBe(true)
    expect(result.current.pending.size).toBe(1)

    await waitFor(
      () => {
        expect(result.current.live.size).toBe(3)
      },
      { timeout: RAMP_STEP_MS + 1000 },
    )
    expect(result.current.pending.size).toBe(0)
  }, 6000)

  test('showLive pins a device out of turn — it becomes live even though it was never observed as visible', async () => {
    const devices = [device('a'), device('b')]
    const { result } = mount(devices, { maxTiles: 1 })
    await waitFor(() => expect(result.current.budgeted.has('b')).toBe(true))
    act(() => result.current.showLive('b'))
    await waitFor(() => expect(result.current.live.has('b')).toBe(true))
    expect(result.current.budgeted.has('a')).toBe(true)
  }, 3000)

  test('tileRef returns the SAME function for the same id across a devices-list update — a live-farm re-render must not re-observe every tile and reset its dwell timer', () => {
    const devices = [device('a')]
    const { result, rerender } = renderHook((props: { devices: DeviceInfo[] }) => useLiveSet({ devices: props.devices, maxTiles: 8, rampConcurrency: 2 }), {
      initialProps: { devices },
    })
    const ref1 = result.current.tileRef('a')
    rerender({ devices: [...devices] }) // a NEW array reference, identical content
    const ref2 = result.current.tileRef('a')
    expect(ref1).toBe(ref2)
  })
})
