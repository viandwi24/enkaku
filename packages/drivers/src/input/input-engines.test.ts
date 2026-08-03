import { describe, expect, test } from 'bun:test'
import type { ScrcpySession } from '@enkaku/scrcpy'
import type { Transport } from '@enkaku/protocol'
import { AdbInput } from './adb-input'
import { ScrcpySdkInput, ScrcpyUhidInput } from './scrcpy-input'
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
