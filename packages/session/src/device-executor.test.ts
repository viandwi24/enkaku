import { describe, expect, test } from 'bun:test'
import type { GestureSample, Point, TimingSettings } from '@enkaku/protocol'
import { createDeviceExecutor, DEFAULT_TIMING } from './device-executor'
import type { DeviceCall } from './runner/ipc'
import type { DeviceSession } from './session'

/**
 * `app.launch`/`app.forceStop` shell-injection safety (plan 34 §3.4, §4.3):
 * before this plan `call.args.pkg`/`call.args.activity` were interpolated
 * unquoted into `am start -n <pkg>/<activity>` and `monkey -p <pkg> ...` — a
 * value containing `;`, `` ` ``, or `$(...)` became a second command on the
 * device. `packages/session/src/runner/ipc.ts`'s regex is the first line of
 * defence, but these tests exercise `device-executor.ts` directly (bypassing
 * that schema, the way a future caller of `createDeviceExecutor` might), so
 * they prove the quoting itself — not just the regex — is what makes this safe.
 */

function fakeSession(execImpl: (cmd: string) => Promise<string>): DeviceSession {
  return {
    deviceId: 'dev-1',
    inspector: null,
    transport: { exec: execImpl, execOut: async () => new Uint8Array() },
  } as unknown as DeviceSession
}

const call = (method: string, args: unknown): DeviceCall => ({ method, args }) as unknown as DeviceCall

describe('createDeviceExecutor — app.launch/app.forceStop quote every interpolated value (plan 34 §3.4, §4.3)', () => {
  test('app.launch with an activity builds a quoted "am start -n pkg/activity"', async () => {
    const cmds: string[] = []
    const execute = createDeviceExecutor({ session: fakeSession(async (cmd) => { cmds.push(cmd); return '' }) })
    await execute(call('app.launch', { pkg: 'com.example.app', activity: '.MainActivity' }))
    expect(cmds).toEqual([`am start -n 'com.example.app/.MainActivity'`])
  })

  test('app.launch without an activity builds a quoted "monkey -p pkg ..."', async () => {
    const cmds: string[] = []
    const execute = createDeviceExecutor({ session: fakeSession(async (cmd) => { cmds.push(cmd); return '' }) })
    await execute(call('app.launch', { pkg: 'com.example.app' }))
    expect(cmds).toEqual([`monkey -p 'com.example.app' -c android.intent.category.LAUNCHER 1`])
  })

  test('app.forceStop builds a quoted "am force-stop pkg"', async () => {
    const cmds: string[] = []
    const execute = createDeviceExecutor({ session: fakeSession(async (cmd) => { cmds.push(cmd); return '' }) })
    await execute(call('app.forceStop', { pkg: 'com.example.app' }))
    expect(cmds).toEqual([`am force-stop 'com.example.app'`])
  })

  test('a pkg containing a semicolon cannot run a second command via app.launch', async () => {
    const cmds: string[] = []
    const execute = createDeviceExecutor({ session: fakeSession(async (cmd) => { cmds.push(cmd); return '' }) })
    const malicious = 'com.x; touch /data/local/tmp/pwned'
    await execute(call('app.launch', { pkg: malicious }))
    const cmd = cmds[0] ?? ''
    // The whole payload — semicolon included — sits INSIDE the quotes, so a
    // shell reading this string sees one argument, not two statements.
    expect(cmd).toBe(`monkey -p 'com.x; touch /data/local/tmp/pwned' -c android.intent.category.LAUNCHER 1`)
    expect(cmd.indexOf(';')).toBeGreaterThan(cmd.indexOf(`'`))
  })

  test('a pkg containing $(...) command substitution cannot execute via app.forceStop', async () => {
    const cmds: string[] = []
    const execute = createDeviceExecutor({ session: fakeSession(async (cmd) => { cmds.push(cmd); return '' }) })
    const malicious = 'com.x$(touch /data/local/tmp/pwned)'
    await execute(call('app.forceStop', { pkg: malicious }))
    expect(cmds).toEqual([`am force-stop 'com.x$(touch /data/local/tmp/pwned)'`])
  })

  test('an activity containing backticks cannot execute via app.launch', async () => {
    const cmds: string[] = []
    const execute = createDeviceExecutor({ session: fakeSession(async (cmd) => { cmds.push(cmd); return '' }) })
    await execute(call('app.launch', { pkg: 'com.example.app', activity: '`id`' }))
    expect(cmds).toEqual([`am start -n 'com.example.app/\`id\`'`])
  })
})

/**
 * Plan 40 — input realism. `fakeGestureSession` records every input call so
 * a test can assert which path (`gesture` vs plain `swipe`/`text`) was
 * taken, without a real scrcpy socket or adb transport.
 */
interface RecordedCalls {
  swipe: { from: Point; to: Point; ms: number }[]
  gesture: GestureSample[][]
  text: string[]
  typeText: { text: string; perCharMs: [number, number] }[]
}

function fakeGestureSession(opts: {
  frameSize?: { width: number; height: number }
  withGesture?: boolean
  withTypeText?: boolean
}): { session: DeviceSession; calls: RecordedCalls } {
  const calls: RecordedCalls = { swipe: [], gesture: [], text: [], typeText: [] }
  const input: Record<string, unknown> = {
    tap: async () => {},
    swipe: async (from: Point, to: Point, ms: number) => {
      calls.swipe.push({ from, to, ms })
    },
    key: async () => {},
    text: async (text: string) => {
      calls.text.push(text)
    },
  }
  if (opts.withGesture !== false) {
    input.gesture = async (samples: GestureSample[]) => {
      calls.gesture.push(samples)
    }
  }
  if (opts.withTypeText !== false) {
    input.typeText = async (text: string, o: { perCharMs: [number, number] }) => {
      calls.typeText.push({ text, perCharMs: o.perCharMs })
    }
  }
  const session = {
    deviceId: 'dev-1',
    inspector: null,
    transport: { exec: async () => '', execOut: async () => new Uint8Array() },
    frameSize: opts.frameSize ?? { width: 1080, height: 1920 },
    input,
  } as unknown as DeviceSession
  return { session, calls }
}

// betweenActionMs zeroed out so these tests do not pay DEFAULT_TIMING's
// real 300–900ms pause() before every call — every other field (including
// perCharMs, asserted below) stays at the schema's real default.
const NATURAL_TIMING: TimingSettings = { ...DEFAULT_TIMING, betweenActionMs: [0, 0] }
const INSTANT_TIMING: TimingSettings = { ...DEFAULT_TIMING, profile: 'instant', betweenActionMs: [0, 0] }

describe('createDeviceExecutor — swipe under profile natural vs instant (plan 40 §4.4, acceptance #7)', () => {
  test('natural: an engine with gesture() gets a curved path whose endpoints match the call exactly', async () => {
    const { session, calls } = fakeGestureSession({})
    const execute = createDeviceExecutor({ session, timing: NATURAL_TIMING })
    await execute(call('swipe', { from: { x: 100, y: 200 }, to: { x: 900, y: 1400 }, ms: 300 }))
    expect(calls.swipe.length).toBe(0)
    expect(calls.gesture.length).toBe(1)
    const samples = calls.gesture[0]!
    expect(samples[0]!.atMs).toBe(0)
    expect(samples[samples.length - 1]!.atMs).toBe(300)
  })

  test('instant: the call goes straight to a plain linear swipe — byte-for-byte the pre-plan-40 behaviour', async () => {
    const { session, calls } = fakeGestureSession({})
    const execute = createDeviceExecutor({ session, timing: INSTANT_TIMING })
    await execute(call('swipe', { from: { x: 100, y: 200 }, to: { x: 900, y: 1400 }, ms: 300 }))
    expect(calls.gesture.length).toBe(0)
    expect(calls.swipe.length).toBe(1)
    expect(calls.swipe[0]!.ms).toBe(300)
  })

  test('an engine with no gesture() falls back to a plain swipe even under the natural profile (AdbInput\'s degrade path, acceptance #8)', async () => {
    const { session, calls } = fakeGestureSession({ withGesture: false })
    const execute = createDeviceExecutor({ session, timing: NATURAL_TIMING })
    await execute(call('swipe', { from: { x: 0, y: 0 }, to: { x: 500, y: 500 }, ms: 300 }))
    expect(calls.gesture.length).toBe(0)
    expect(calls.swipe.length).toBe(1)
  })
})

describe('createDeviceExecutor — type under profile natural vs instant (plan 40 §4.4, acceptance #5, #7)', () => {
  test('natural: typeText receives the whole string with the configured per-character delay range', async () => {
    const { session, calls } = fakeGestureSession({})
    const execute = createDeviceExecutor({ session, timing: NATURAL_TIMING })
    await execute(call('type', { text: 'hello' }))
    expect(calls.text.length).toBe(0)
    expect(calls.typeText).toEqual([{ text: 'hello', perCharMs: NATURAL_TIMING.perCharMs }])
  })

  test('instant: the call goes straight to bulk text() — byte-for-byte the pre-plan-40 behaviour', async () => {
    const { session, calls } = fakeGestureSession({})
    const execute = createDeviceExecutor({ session, timing: INSTANT_TIMING })
    await execute(call('type', { text: 'hello' }))
    expect(calls.typeText.length).toBe(0)
    expect(calls.text).toEqual(['hello'])
  })

  test('a per-call instant:true forces bulk text() even under the natural profile (a long token, a paste target)', async () => {
    const { session, calls } = fakeGestureSession({})
    const execute = createDeviceExecutor({ session, timing: NATURAL_TIMING })
    await execute(call('type', { text: 'hello', instant: true }))
    expect(calls.typeText.length).toBe(0)
    expect(calls.text).toEqual(['hello'])
  })

  test('an engine with no typeText() falls back to bulk text() even under the natural profile', async () => {
    const { session, calls } = fakeGestureSession({ withTypeText: false })
    const execute = createDeviceExecutor({ session, timing: NATURAL_TIMING })
    await execute(call('type', { text: 'hello' }))
    expect(calls.typeText.length).toBe(0)
    expect(calls.text).toEqual(['hello'])
  })
})

describe('createDeviceExecutor — scroll and fling geometry (plan 40 §4.4, acceptance #2)', () => {
  test('scroll(down, 800) moves the list approximately 800px, via the gesture path (not a fling)', async () => {
    const { session, calls } = fakeGestureSession({ frameSize: { width: 1080, height: 1920 } })
    const execute = createDeviceExecutor({ session, timing: NATURAL_TIMING })
    await execute(call('scroll', { direction: 'down', distance: 800 }))
    expect(calls.gesture.length).toBe(1)
    const samples = calls.gesture[0]!
    const from = samples[0]!
    const to = samples[samples.length - 1]!
    // "down" reveals content further down the list, which is a finger swipe UP.
    expect(from.y).toBeGreaterThan(to.y)
    expect(Math.abs(from.y - to.y)).toBeCloseTo(800, 5)
    expect(from.x).toBeCloseTo(to.x, 5)
  })

  test('scroll direction "up" swipes down (the opposite sign from "down")', async () => {
    const { session, calls } = fakeGestureSession({ frameSize: { width: 1080, height: 1920 } })
    const execute = createDeviceExecutor({ session, timing: NATURAL_TIMING })
    await execute(call('scroll', { direction: 'up', distance: 600 }))
    const samples = calls.gesture[0]!
    const from = samples[0]!
    const to = samples[samples.length - 1]!
    expect(to.y).toBeGreaterThan(from.y)
  })

  test('scroll defaults distance to 60% of the relevant viewport axis when omitted', async () => {
    const { session, calls } = fakeGestureSession({ frameSize: { width: 1080, height: 1920 } })
    const execute = createDeviceExecutor({ session, timing: NATURAL_TIMING })
    await execute(call('scroll', { direction: 'left' }))
    const samples = calls.gesture[0]!
    const from = samples[0]!
    const to = samples[samples.length - 1]!
    expect(Math.abs(from.x - to.x)).toBeCloseTo(Math.round(1080 * 0.6), 5)
  })

  test('fling uses a shorter duration than scroll, for the same axis (a flick, not a controlled drag)', async () => {
    const { session: scrollSession, calls: scrollCalls } = fakeGestureSession({ frameSize: { width: 1080, height: 1920 } })
    await createDeviceExecutor({ session: scrollSession, timing: NATURAL_TIMING })(
      call('scroll', { direction: 'down', distance: 400 }),
    )
    const { session: flingSession, calls: flingCalls } = fakeGestureSession({ frameSize: { width: 1080, height: 1920 } })
    await createDeviceExecutor({ session: flingSession, timing: NATURAL_TIMING })(
      call('fling', { direction: 'down', strength: 'hard' }),
    )
    const scrollDuration = scrollCalls.gesture[0]!.at(-1)!.atMs
    const flingDuration = flingCalls.gesture[0]!.at(-1)!.atMs
    expect(flingDuration).toBeLessThan(scrollDuration)
  })

  test('fling(down) under profile instant collapses to a single linear swipe (the A/B control arm, acceptance #1/#7)', async () => {
    const { session, calls } = fakeGestureSession({ frameSize: { width: 1080, height: 1920 } })
    const execute = createDeviceExecutor({ session, timing: INSTANT_TIMING })
    await execute(call('fling', { direction: 'down' }))
    expect(calls.gesture.length).toBe(0)
    expect(calls.swipe.length).toBe(1)
  })
})
