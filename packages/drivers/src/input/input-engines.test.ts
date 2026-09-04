import { describe, expect, test } from 'bun:test'
import type { ScrcpySession } from '@enkaku/scrcpy'
import type { Transport } from '@enkaku/protocol'
import { androidMetaState } from '@enkaku/protocol'
import { AdbInput } from './adb-input'
import { MIN_TAP_HOLD_MS, sampleHoldMs, ScrcpySdkInput, ScrcpyUhidInput } from './scrcpy-input'
import { withAdbKeyFallback } from './adb-key-fallback'
import { buildGesturePath } from './gesture'

/**
 * Engine-level coverage for plan 40 §4.2: `gesture()`/`typeText()` on the
 * scrcpy engines send one control message per sample/character, and
 * `AdbInput` — which cannot curve a path — simply does not have `gesture` at
 * all (§3.6: absence, not a runtime lie).
 */

function fakeControl() {
  const calls: { fn: string; args: unknown[] }[] = []
  const control = {
    injectTouch: (...args: unknown[]) => calls.push({ fn: 'injectTouch', args }),
    injectKeycode: (...args: unknown[]) => calls.push({ fn: 'injectKeycode', args }),
    injectText: (...args: unknown[]) => calls.push({ fn: 'injectText', args }),
    uhidCreate: (...args: unknown[]) => calls.push({ fn: 'uhidCreate', args }),
    uhidInput: (...args: unknown[]) => calls.push({ fn: 'uhidInput', args }),
    uhidDestroy: (...args: unknown[]) => calls.push({ fn: 'uhidDestroy', args }),
    setDisplayPower: (...args: unknown[]) => calls.push({ fn: 'setDisplayPower', args }),
    resetVideo: (...args: unknown[]) => calls.push({ fn: 'resetVideo', args }),
    injectScroll: (...args: unknown[]) => calls.push({ fn: 'injectScroll', args }),
  }
  return { control, calls }
}

function fakeSession(control: ReturnType<typeof fakeControl>['control']): ScrcpySession {
  return { meta: null, onPacket: () => {}, onMetaChange: () => {}, onClose: () => {}, control, close: async () => {} } as unknown as ScrcpySession
}

describe('ScrcpySdkInput.gesture — one injectTouch per sample (plan 40 §4.2)', () => {
  test('down for the first sample, move for every sample in between, up for the last', async () => {
    const { control, calls } = fakeControl()
    const engine = new ScrcpySdkInput({ session: fakeSession(control), screenSize: () => ({ width: 1000, height: 2000 }) })
    const samples = buildGesturePath({ from: { x: 0, y: 0 }, to: { x: 500, y: 500 }, durationMs: 80, sampleIntervalMs: 8, rng: () => 0.5 })
    await engine.gesture(samples)

    const touches = calls.filter((c) => c.fn === 'injectTouch')
    expect(touches.length).toBe(samples.length)
    expect(touches[0]!.args[0]).toBe('down')
    expect(touches[touches.length - 1]!.args[0]).toBe('up')
    for (let i = 1; i < touches.length - 1; i++) expect(touches[i]!.args[0]).toBe('move')
  })
})

describe('ScrcpyUhidInput.gesture — one uhidInput report per sample, plus the initial untouched landing report (plan 40 §4.2)', () => {
  test('samples arrive as uhidInput reports, in order', async () => {
    const { control, calls } = fakeControl()
    const engine = new ScrcpyUhidInput({ session: fakeSession(control), screenSize: () => ({ width: 1000, height: 2000 }) })
    const samples = buildGesturePath({ from: { x: 100, y: 100 }, to: { x: 900, y: 900 }, durationMs: 80, sampleIntervalMs: 8, rng: () => 0.5 })
    await engine.gesture(samples)

    const reports = calls.filter((c) => c.fn === 'uhidInput')
    // One extra "land before touch" report ahead of the down (same quirk `tap`/`swipe` already have).
    expect(reports.length).toBe(samples.length + 1)
  })
})

describe('typeText — per-character delivery with a delay in the configured range (plan 40 §4.2, acceptance #5)', () => {
  test('ScrcpySdkInput sends one injectText per character', async () => {
    const { control, calls } = fakeControl()
    const engine = new ScrcpySdkInput({ session: fakeSession(control), screenSize: () => ({ width: 1000, height: 2000 }) })
    await engine.typeText('hello', { perCharMs: [0, 0] })
    const texts = calls.filter((c) => c.fn === 'injectText')
    expect(texts.map((c) => c.args[0])).toEqual(['h', 'e', 'l', 'l', 'o'])
  })

  test('AdbInput sends one "input text" exec per character, with a delay in the configured range', async () => {
    const cmds: string[] = []
    const transport = { exec: async (cmd: string) => { cmds.push(cmd); return '' }, execOut: async () => new Uint8Array() } as unknown as Transport
    const input = new AdbInput(transport)
    const start = Date.now()
    await input.typeText('abc', { perCharMs: [5, 10], rng: () => 1 }) // rng=1 -> always the high end
    const elapsed = Date.now() - start
    expect(cmds.length).toBe(3)
    for (const cmd of cmds) expect(cmd.startsWith('input text ')).toBe(true)
    // 3 characters at up to 10ms each (rng pinned to the high end) — a loose
    // bound, just enough to prove the delays actually ran rather than being a no-op.
    expect(elapsed).toBeGreaterThanOrEqual(15)
  })
})

/** A tiny deterministic PRNG (mulberry32), same as gesture.test.ts's, so a
 * test can assert exact reproducibility without depending on `Math.random`. */
function seededRng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * `sampleHoldMs` is the fix for the defect this plan closes:
 * `DeviceSettings.timing.tapJitterMs` used to reach nowhere — the actual tap
 * hold was `40 + Math.random() * 80` (a range that happened to coincide with
 * the schema default), hardcoded independently in both `ScrcpySdkInput.tap`
 * and `ScrcpyUhidInput.tap`. These test the sampling itself, deterministically
 * and without paying for a real `Bun.sleep` (the wiring from `tap()` down to
 * this function is covered separately below, for real, via elapsed time).
 */
describe('sampleHoldMs — tapJitterMs sampling (spec §9.3, §17: test realism, not evasion)', () => {
  test('the result always falls inside the configured [min, max] range', () => {
    const range: [number, number] = [100, 300]
    for (const r of [0, 0.1, 0.25, 0.5, 0.75, 0.9, 0.999]) {
      const hold = sampleHoldMs({ holdMs: range, rng: () => r })
      expect(hold).toBeGreaterThanOrEqual(range[0])
      expect(hold).toBeLessThanOrEqual(range[1])
    }
  })

  test('a different range produces a different duration for the same rng draw', () => {
    const rng = () => 0.5
    const narrow = sampleHoldMs({ holdMs: [40, 120], rng })
    const wide = sampleHoldMs({ holdMs: [1000, 3000], rng })
    expect(wide).not.toBe(narrow)
    expect(wide).toBeGreaterThan(narrow)
  })

  test('sampling is deterministic under an injected rng — the same seed reproduces the same output', () => {
    const a = sampleHoldMs({ holdMs: [40, 120], rng: seededRng(11) })
    const b = sampleHoldMs({ holdMs: [40, 120], rng: seededRng(11) })
    expect(a).toBe(b)
    // A different seed is not required to differ on every draw, but across
    // several draws the two streams diverge — proof `rng` is actually consulted.
    const c = Array.from({ length: 5 }, () => sampleHoldMs({ holdMs: [0, 1_000_000], rng: seededRng(11) }))
    const d = Array.from({ length: 5 }, () => sampleHoldMs({ holdMs: [0, 1_000_000], rng: seededRng(99) }))
    expect(c).not.toEqual(d)
  })

  test('tap with no holdMs holds MIN_TAP_HOLD_MS (16), not a sampled 40..120 range', () => {
    expect(MIN_TAP_HOLD_MS).toBe(16)
    expect(sampleHoldMs({ rng: () => 0 })).toBe(16)
    expect(sampleHoldMs({ rng: () => 1 })).toBe(16)
    expect(sampleHoldMs()).toBe(16)
  })

  test('tap with holdMs [40,120] and rng 0.5 holds 80 ms — the existing sampling still works for scripts', () => {
    expect(sampleHoldMs({ holdMs: [40, 120], rng: () => 0.5 })).toBe(80)
  })
})

describe('ScrcpySdkInput.tap — opts.holdMs reaches the actual hold, not just the sampler (plan 34-style wiring)', () => {
  test('down then up bracket the hold, and a larger holdMs range measurably lengthens the real wait', async () => {
    const { control, calls } = fakeControl()
    const engine = new ScrcpySdkInput({ session: fakeSession(control), screenSize: () => ({ width: 1000, height: 2000 }) })

    const start1 = Date.now()
    await engine.tap({ x: 10, y: 20 }, { holdMs: [0, 0] })
    const short = Date.now() - start1

    const start2 = Date.now()
    await engine.tap({ x: 10, y: 20 }, { holdMs: [150, 150] })
    const long = Date.now() - start2

    // Loose bound (100 of the 150ms configured) — enough to prove the range
    // reaches the real wait, not scheduling noise around a fixed constant.
    expect(long - short).toBeGreaterThanOrEqual(100)
    const touches = calls.filter((c) => c.fn === 'injectTouch')
    expect(touches.map((c) => c.args[0])).toEqual(['down', 'up', 'down', 'up'])
  })
})

describe('ScrcpyUhidInput.tap — opts.holdMs reaches the actual hold', () => {
  test('a larger holdMs range measurably lengthens the real wait (measured after warm-up, so the one-time UHID_SETTLE_MS does not confound it)', async () => {
    const { control } = fakeControl()
    const engine = new ScrcpyUhidInput({ session: fakeSession(control), screenSize: () => ({ width: 1000, height: 2000 }) })
    await engine.init() // pays the one-time ~1.5s settle cost up front

    const start1 = Date.now()
    await engine.tap({ x: 10, y: 20 }, { holdMs: [0, 0] })
    const short = Date.now() - start1

    const start2 = Date.now()
    await engine.tap({ x: 10, y: 20 }, { holdMs: [150, 150] })
    const long = Date.now() - start2

    expect(long - short).toBeGreaterThanOrEqual(100)
  }, 10_000)
})

describe('AdbInput.tap cannot honour tapJitterMs — a documented limitation, not an oversight (spec §9.3, §17)', () => {
  test('the same "input tap" command is sent whether or not holdMs is provided — accepted for interface parity, not applied', async () => {
    const cmds: string[] = []
    const transport = { exec: async (cmd: string) => { cmds.push(cmd); return '' }, execOut: async () => new Uint8Array() } as unknown as Transport
    const input = new AdbInput(transport)
    await input.tap({ x: 10, y: 20 })
    await input.tap({ x: 10, y: 20 }, { holdMs: [5000, 9000] })
    expect(cmds).toEqual(['input tap 10 20', 'input tap 10 20'])
  })

  test('a huge holdMs does not slow the call down — proof the option is genuinely ignored rather than silently honoured', async () => {
    const transport = { exec: async () => '', execOut: async () => new Uint8Array() } as unknown as Transport
    const input = new AdbInput(transport)
    const start = Date.now()
    await input.tap({ x: 10, y: 20 }, { holdMs: [2000, 2000] })
    expect(Date.now() - start).toBeLessThan(200)
  })
})

describe('AdbInput cannot curve a gesture — absence, not a lie (plan 40 §3.6, §4.2, acceptance #8)', () => {
  test('AdbInput has no gesture method at all', () => {
    const transport = { exec: async () => '', execOut: async () => new Uint8Array() } as unknown as Transport
    const input = new AdbInput(transport)
    expect('gesture' in input).toBe(false)
    expect((input as unknown as { gesture?: unknown }).gesture).toBeUndefined()
  })

  test('AdbInput.swipe still works as a plain linear swipe (the fallback a caller uses when gesture is absent)', async () => {
    const cmds: string[] = []
    const transport = { exec: async (cmd: string) => { cmds.push(cmd); return '' }, execOut: async () => new Uint8Array() } as unknown as Transport
    const input = new AdbInput(transport)
    await input.swipe({ x: 10, y: 20 }, { x: 30, y: 40 }, 300)
    expect(cmds).toEqual(['input swipe 10 20 30 40 300'])
  })
})

const KEY_A = { code: 'KeyA' as const, hidUsage: 0x04, androidKeycode: 29 }
const NO_META = { shift: false, ctrl: false, alt: false, meta: false }
const SHIFT_META = { shift: true, ctrl: false, alt: false, meta: false }

describe('the six new input verbs (plan 209 §4.7, §5 step 209.4)', () => {
  test('SDK keyDown/keyUp send INJECT_KEYCODE with the Android keycode and the meta state', async () => {
    // NOTE (plan 209 §11 discrepancy): the plan's own §5 step 209.4 prose gives the expected
    // meta state for Shift+A as `0x1041`, but `androidMetaState` (§4.4) sets SHIFT_ON (0x1) and
    // SHIFT_LEFT_ON (0x40) together for a shift-only chord, i.e. 0x41 — 0x1041 does not correspond
    // to any single-modifier combination the formula can produce. The formula (the file) wins.
    const { control, calls } = fakeControl()
    const engine = new ScrcpySdkInput({ session: fakeSession(control), screenSize: () => ({ width: 1000, height: 2000 }) })
    await engine.keyDown!(KEY_A, SHIFT_META)
    await engine.keyUp!(KEY_A, SHIFT_META)
    const keycodes = calls.filter((c) => c.fn === 'injectKeycode')
    expect(keycodes[0]!.args).toEqual(['down', 29, androidMetaState(SHIFT_META)])
    expect(keycodes[0]!.args[1]).toBe(29)
    expect(keycodes[0]!.args[2]).toBe(0x41)
    expect(keycodes[1]!.args).toEqual(['up', 29, androidMetaState(SHIFT_META)])
  })

  test('UHID keyDown creates the keyboard once, then sends an 8-byte report; keyUp sends the release report', async () => {
    const { control, calls } = fakeControl()
    const engine = new ScrcpyUhidInput({ session: fakeSession(control), screenSize: () => ({ width: 1000, height: 2000 }) })
    await engine.keyDown!(KEY_A, NO_META)
    await engine.keyDown!({ code: 'KeyB' as const, hidUsage: 0x05, androidKeycode: 30 }, NO_META)
    const creates = calls.filter((c) => c.fn === 'uhidCreate')
    expect(creates.length).toBe(1)
    expect(creates[0]!.args[0]).toBe(2)
    expect((creates[0]!.args[2] as Uint8Array).length).toBe(63)
    const reports = calls.filter((c) => c.fn === 'uhidInput' && c.args[0] === 2)
    expect(Array.from(reports[0]!.args[1] as Uint8Array)).toEqual([0, 0, 4, 0, 0, 0, 0, 0])
    expect(Array.from(reports[1]!.args[1] as Uint8Array)).toEqual([0, 0, 4, 5, 0, 0, 0, 0])
    await engine.keyUp!(KEY_A, NO_META)
    const afterUp = calls.filter((c) => c.fn === 'uhidInput' && c.args[0] === 2)
    expect(Array.from(afterUp[afterUp.length - 1]!.args[1] as Uint8Array)).toEqual([0, 0, 5, 0, 0, 0, 0, 0])
  })

  test('UHID repairModifiers releases a held Shift the browser no longer reports', async () => {
    const { control, calls } = fakeControl()
    const engine = new ScrcpyUhidInput({ session: fakeSession(control), screenSize: () => ({ width: 1000, height: 2000 }) })
    await engine.keyDown!({ code: 'ShiftLeft' as const, hidUsage: 0xe1, androidKeycode: 59 }, SHIFT_META)
    // The browser now reports shift up (a lost key-up), but the state still holds it.
    await engine.keyDown!(KEY_A, NO_META)
    const reports = calls.filter((c) => c.fn === 'uhidInput' && c.args[0] === 2).map((c) => Array.from(c.args[1] as Uint8Array))
    // Somewhere in the sequence Shift's bit (0x02) must have been released before A is pressed.
    const hasRepair = reports.some((r) => r[0] === 0)
    expect(hasRepair).toBe(true)
  })

  test('UHID releaseKeys sends an all-zero report only when the keyboard exists', async () => {
    const { control, calls } = fakeControl()
    const engine = new ScrcpyUhidInput({ session: fakeSession(control), screenSize: () => ({ width: 1000, height: 2000 }) })
    await engine.releaseKeys!()
    expect(calls.filter((c) => c.fn === 'uhidInput' && c.args[0] === 2).length).toBe(0)
    await engine.keyDown!(KEY_A, NO_META)
    await engine.releaseKeys!()
    const last = calls.filter((c) => c.fn === 'uhidInput' && c.args[0] === 2).pop()!
    expect(Array.from(last.args[1] as Uint8Array)).toEqual([0, 0, 0, 0, 0, 0, 0, 0])
  })

  test('UHID touch on pointer 0 lands, sleeps 100 ms, then touches; move and up are single reports', async () => {
    const { control, calls } = fakeControl()
    const engine = new ScrcpyUhidInput({ session: fakeSession(control), screenSize: () => ({ width: 1000, height: 2000 }) })
    await engine.touch!('down', { x: 100, y: 200 }, 0)
    const downReports = calls.filter((c) => c.fn === 'uhidInput' && c.args[0] === 1)
    expect(downReports.length).toBe(2) // land, then touch
    await engine.touch!('move', { x: 150, y: 250 }, 0)
    await engine.touch!('up', { x: 150, y: 250 }, 0)
    const allReports = calls.filter((c) => c.fn === 'uhidInput' && c.args[0] === 1)
    expect(allReports.length).toBe(4) // land, down, move, up
  })

  test('UHID touch on pointer 1 falls through to INJECT_TOUCH_EVENT with pointerId 1n', async () => {
    const { control, calls } = fakeControl()
    const engine = new ScrcpyUhidInput({ session: fakeSession(control), screenSize: () => ({ width: 1000, height: 2000 }) })
    await engine.touch!('down', { x: 100, y: 200 }, 1)
    const touches = calls.filter((c) => c.fn === 'injectTouch')
    expect(touches.length).toBe(1)
    expect(touches[0]!.args[5]).toBe(1n)
  })

  test('SDK pinch sends two downs, paired moves, two ups with ids 0n and 1n', async () => {
    const { control, calls } = fakeControl()
    const engine = new ScrcpySdkInput({ session: fakeSession(control), screenSize: () => ({ width: 1000, height: 2000 }) })
    await engine.pinch!({ center: { x: 500, y: 500 }, radiusFromPx: 50, radiusToPx: 200, durationMs: 32 })
    const touches = calls.filter((c) => c.fn === 'injectTouch')
    const downs = touches.filter((c) => c.args[0] === 'down')
    const ups = touches.filter((c) => c.args[0] === 'up')
    expect(downs.length).toBe(2)
    expect(ups.length).toBe(2)
    expect(downs.map((c) => c.args[5])).toEqual([0n, 1n])
    expect(ups.map((c) => c.args[5])).toEqual([0n, 1n])
  })

  test('SDK scroll sends injectScroll with the deltas', async () => {
    const { control, calls } = fakeControl()
    const engine = new ScrcpySdkInput({ session: fakeSession(control), screenSize: () => ({ width: 1000, height: 2000 }) })
    await engine.scroll!({ x: 500, y: 500 }, 0.5, -1)
    const scrolls = calls.filter((c) => c.fn === 'injectScroll')
    expect(scrolls.length).toBe(1)
    expect(scrolls[0]!.args).toEqual([500, 500, 1000, 2000, 0.5, -1])
  })

  test('withAdbKeyFallback passes touch/scroll/pinch/keyDown/keyUp/releaseKeys through only when the primary has them', () => {
    const transport = { exec: async () => '', execOut: async () => new Uint8Array() } as unknown as Transport
    const adbPrimary = new AdbInput(transport)
    const facade = withAdbKeyFallback(adbPrimary, transport)
    expect(facade.touch).toBeUndefined()
    expect(facade.scroll).toBeUndefined()
    expect(facade.pinch).toBeUndefined()
    expect(facade.keyDown).toBeUndefined()
    expect(facade.keyUp).toBeUndefined()
    expect(facade.releaseKeys).toBeUndefined()

    const { control } = fakeControl()
    const uhidPrimary = new ScrcpyUhidInput({ session: fakeSession(control), screenSize: () => ({ width: 1000, height: 2000 }) })
    const facade2 = withAdbKeyFallback(uhidPrimary, transport)
    expect(facade2.touch).toBeDefined()
    expect(facade2.scroll).toBeDefined()
    expect(facade2.pinch).toBeDefined()
    expect(facade2.keyDown).toBeDefined()
    expect(facade2.keyUp).toBeDefined()
    expect(facade2.releaseKeys).toBeDefined()
  })
})
