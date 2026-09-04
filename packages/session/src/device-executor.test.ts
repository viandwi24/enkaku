import { describe, expect, test } from 'bun:test'
import type { GestureSample, InputSink, Point, TimingSettings } from '@enkaku/protocol'
import { createDeviceExecutor, DEFAULT_TIMING, needsInspector } from './device-executor'
import { createInputArbiter } from './input-arbiter'
import type { Logger } from './logger'
import type { DeviceCall } from './runner/ipc'
import type { DeviceSession } from './session'
import type { TransferPort } from './types'

/** Same `silentLog` pattern `orientation.test.ts`/`text-input.test.ts` already use in this package. */
function silentLog(): Logger {
  const l: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => l }
  return l
}

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
  tap: { p: Point; opts: { holdMs?: [number, number]; rng?: () => number } | undefined }[]
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
  const calls: RecordedCalls = { tap: [], swipe: [], gesture: [], text: [], typeText: [] }
  const input: Record<string, unknown> = {
    tap: async (p: Point, tapOpts?: { holdMs?: [number, number]; rng?: () => number }) => {
      calls.tap.push({ p, opts: tapOpts })
    },
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
  // Plan 91 §3.1, §3.3, §4.1 — `device-executor.ts` now calls `deps.session.arbiter.for(source)`
  // rather than `deps.session.input` directly (fixes F6/H1). Wrapping the SAME `input` object
  // here keeps every `calls.*` spy above recording exactly what it did before this plan, while
  // proving the arbiter is actually on the call path, not bypassed.
  const arbiter = createInputArbiter(input as unknown as InputSink, {
    queueWaitMs: () => 5_000,
    maxQueueDepth: () => 32,
    log: silentLog(),
  })
  const session = {
    deviceId: 'dev-1',
    inspector: null,
    transport: { exec: async () => '', execOut: async () => new Uint8Array() },
    frameSize: opts.frameSize ?? { width: 1080, height: 1920 },
    input,
    arbiter,
    // A scrcpy-family engine — `withTypeText: false` only removes the `typeText` METHOD (Plan
    // 40's own degrade path), it does not simulate the `adb-input` engine, which has neither
    // `typeText` NOR a scrcpy control socket at all (plan 90 §3.3, §4.5, §5 step 90.5).
    inputEngineId: 'scrcpy-uhid',
    clipboard: { get: async () => '', set: async () => {} },
    textInput: {
      mode: 'auto',
      agentCapabilities: null,
      imeCurrent: false,
      commitViaAgent: async () => {
        throw new Error('no guest agent client wired in this fixture')
      },
    },
  } as unknown as DeviceSession
  return { session, calls }
}

// betweenActionMs zeroed out so these tests do not pay DEFAULT_TIMING's
// real 300–900ms pause() before every call — every other field (including
// perCharMs, asserted below) stays at the schema's real default.
const NATURAL_TIMING: TimingSettings = { ...DEFAULT_TIMING, betweenActionMs: [0, 0] }
const INSTANT_TIMING: TimingSettings = { ...DEFAULT_TIMING, gestureCurvature: 0, betweenActionMs: [0, 0] }

/**
 * The regression test for the original defect: `DeviceSettings.timing.tapJitterMs`
 * was declared in the schema and rendered in Studio's Settings panel, but no
 * production code read it — the real tap-hold duration was a hardcoded
 * literal inside the scrcpy input drivers (`40 + Math.random() * 80`) that
 * happened to coincide with the schema's own default range, which is exactly
 * why nobody noticed. This asserts `timing.tapJitterMs` actually reaches
 * `session.input.tap`'s second argument — the one place downstream of
 * `createDeviceExecutor` where a silently-ignored setting would go unnoticed.
 */
describe('createDeviceExecutor — tap honours tapJitterMs (the setting reaches the driver, not just the schema)', () => {
  test('a configured tapJitterMs range is handed to session.input.tap as opts.holdMs', async () => {
    const { session, calls } = fakeGestureSession({})
    const timing: TimingSettings = { ...DEFAULT_TIMING, betweenActionMs: [0, 0], tapJitterMs: [500, 900] }
    const execute = createDeviceExecutor({ session, timing })
    await execute(call('tap', { target: { point: { x: 10, y: 20 } } }))
    expect(calls.tap).toHaveLength(1)
    expect(calls.tap[0]!.opts?.holdMs).toEqual([500, 900])
  })

  test('a different tapJitterMs range produces a different opts.holdMs — proof it is read fresh, not a stale default', async () => {
    const { session, calls } = fakeGestureSession({})
    const timingA: TimingSettings = { ...DEFAULT_TIMING, betweenActionMs: [0, 0], tapJitterMs: [10, 20] }
    await createDeviceExecutor({ session, timing: timingA })(call('tap', { target: { point: { x: 0, y: 0 } } }))

    const timingB: TimingSettings = { ...DEFAULT_TIMING, betweenActionMs: [0, 0], tapJitterMs: [3000, 4000] }
    await createDeviceExecutor({ session, timing: timingB })(call('tap', { target: { point: { x: 0, y: 0 } } }))

    expect(calls.tap).toHaveLength(2)
    expect(calls.tap[0]!.opts?.holdMs).toEqual([10, 20])
    expect(calls.tap[1]!.opts?.holdMs).toEqual([3000, 4000])
    expect(calls.tap[0]!.opts?.holdMs).not.toEqual(calls.tap[1]!.opts?.holdMs)
  })

  test('with no timing supplied at all, DEFAULT_TIMING.tapJitterMs ([40, 120] — the old hardcoded literal\'s exact bounds) still reaches opts.holdMs', async () => {
    const { session, calls } = fakeGestureSession({})
    const execute = createDeviceExecutor({ session })
    await execute(call('tap', { target: { point: { x: 10, y: 20 } } }))
    expect(DEFAULT_TIMING.tapJitterMs).toEqual([40, 120])
    expect(calls.tap[0]!.opts?.holdMs).toEqual([40, 120])
  })
})

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

/**
 * `dump` (plan 60 §3.2, §4.2): `Inspector.dump()` has existed since M4.5 and
 * is what the Inspect panel renders — the executor simply never exposed it,
 * so the loop the inspector exists to serve (look at the tree, learn the
 * structure, write the script) stopped at the last step.
 */
describe('createDeviceExecutor — dump (plan 60 §4.2)', () => {
  const tree = {
    resourceId: '',
    text: '',
    desc: '',
    className: 'android.widget.FrameLayout',
    packageName: 'com.android.chrome',
    bounds: { left: 0, top: 0, right: 720, bottom: 1640 },
    clickable: false,
    enabled: true,
    focused: false,
    index: 0,
    children: [],
  }

  test('it returns the session inspector’s own tree, untouched', async () => {
    let dumps = 0
    const session = {
      deviceId: 'dev-1',
      inspector: {
        id: 'ui-server',
        dump: async () => {
          dumps += 1
          return tree
        },
        find: async () => null,
        screenshot: async () => new Uint8Array(),
      },
      transport: { exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }), execOut: async () => new Uint8Array() },
    } as unknown as DeviceSession

    const execute = createDeviceExecutor({ session })
    expect(await execute(call('dump', {}))).toEqual(tree)
    expect(dumps).toBe(1)
  })
})

/**
 * `find`/`waitFor` produce a `FindOutcome` (plan 74 §3.4, §4.3): not-found /
 * rejected-oversized / ambiguous travel BESIDE the node, and the executor
 * is where that shape is assembled — from `inspector.findDetailed` when the
 * engine has it, else a plain not-found/ok fallback built from `find()`.
 */
describe('createDeviceExecutor — find produces a FindOutcome (plan 74 §3.4, §4.3, §4.4)', () => {
  const foundNode = {
    resourceId: 'com.example:id/button',
    text: 'OK',
    desc: '',
    className: 'android.widget.Button',
    packageName: 'com.example',
    bounds: { left: 10, top: 10, right: 100, bottom: 60 },
    clickable: true,
    enabled: true,
    focused: false,
    index: 0,
    children: [],
  }

  function sessionWithInspector(inspector: Record<string, unknown>): DeviceSession {
    return {
      deviceId: 'dev-1',
      inspector,
      inspectorPollIntervalMs: 5,
      transport: { exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }), execOut: async () => new Uint8Array() },
    } as unknown as DeviceSession
  }

  test('an engine with no findDetailed: a match becomes { ok: true, node }', async () => {
    const session = sessionWithInspector({ id: 'dump', find: async () => foundNode, dump: async () => foundNode, screenshot: async () => new Uint8Array() })
    const execute = createDeviceExecutor({ session })
    expect(await execute(call('find', { sel: { id: 'button' } }))).toEqual({ ok: true, node: foundNode })
  })

  test('an engine with no findDetailed: a miss becomes { ok: false, reason: "not-found", matches: 0 } — never a bare null', async () => {
    const session = sessionWithInspector({ id: 'dump', find: async () => null, dump: async () => foundNode, screenshot: async () => new Uint8Array() })
    const execute = createDeviceExecutor({ session })
    expect(await execute(call('find', { sel: { id: 'button' } }))).toEqual({ ok: false, reason: 'not-found', matches: 0 })
  })

  test('an engine with findDetailed: rejected-oversized passes through untouched', async () => {
    const session = sessionWithInspector({
      id: 'ui-server',
      find: async () => null,
      findDetailed: async () => ({ ok: false, reason: 'rejected-oversized', matches: 1 }),
      dump: async () => foundNode,
      screenshot: async () => new Uint8Array(),
    })
    const execute = createDeviceExecutor({ session })
    expect(await execute(call('find', { sel: { id: 'url_bar' } }))).toEqual({ ok: false, reason: 'rejected-oversized', matches: 1 })
  })

  test('an engine with findDetailed: ambiguous passes through with the match count', async () => {
    const session = sessionWithInspector({
      id: 'dump',
      find: async () => foundNode,
      findDetailed: async () => ({ ok: false, reason: 'ambiguous', matches: 4 }),
      dump: async () => foundNode,
      screenshot: async () => new Uint8Array(),
    })
    const execute = createDeviceExecutor({ session })
    expect(await execute(call('find', { sel: { text: 'OK' } }))).toEqual({ ok: false, reason: 'ambiguous', matches: 4 })
  })
})

describe('createDeviceExecutor — waitFor carries the last outcome into its timeout (plan 74 §3.5, §4.3, criterion 9)', () => {
  function sessionWithInspector(inspector: Record<string, unknown>): DeviceSession {
    return {
      deviceId: 'dev-1',
      inspector,
      inspectorPollIntervalMs: 5,
      transport: { exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }), execOut: async () => new Uint8Array() },
    } as unknown as DeviceSession
  }

  test('every poll refused as rejected-oversized — the timeout error names that reason, not a bare timeout', async () => {
    const session = sessionWithInspector({
      id: 'ui-server',
      find: async () => null,
      findDetailed: async () => ({ ok: false, reason: 'rejected-oversized', matches: 1 }),
      dump: async () => {
        throw new Error('unused')
      },
      screenshot: async () => new Uint8Array(),
    })
    const execute = createDeviceExecutor({ session })
    let caught: unknown
    try {
      await execute(call('waitFor', { sel: { id: 'url_bar' }, timeout: 20, intervalMs: 5 }))
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(Error)
    const err = caught as { code?: string; message?: string; details?: { reason?: string; matches?: number } }
    expect(err.code).toBe('waitfor_timeout')
    expect(err.message).toContain('rejected-oversized')
    expect(err.details).toEqual({ reason: 'rejected-oversized', matches: 1 })
  })

  test('a match arriving before the deadline resolves normally, exactly as before this plan', async () => {
    let calls = 0
    const session = sessionWithInspector({
      id: 'ui-server',
      find: async () => null,
      findDetailed: async () => {
        calls += 1
        return calls < 3 ? { ok: false, reason: 'not-found', matches: 0 } : { ok: true, node: { resourceId: 'x', text: '', desc: '', className: '', packageName: '', bounds: { left: 0, top: 0, right: 1, bottom: 1 }, clickable: false, enabled: true, focused: false, index: 0, children: [] } }
      },
      dump: async () => {
        throw new Error('unused')
      },
      screenshot: async () => new Uint8Array(),
    })
    const execute = createDeviceExecutor({ session })
    const result = await execute(call('waitFor', { sel: { id: 'x' }, timeout: 2_000, intervalMs: 5 }))
    expect((result as { resourceId: string }).resourceId).toBe('x')
  })
})

/**
 * `push` (plan 90 §4.6, step 90.7) — a script's `ctx.device.push(...)` must
 * reach the same extended result the API response gets (`mediaScan`), not
 * `undefined`: the codebase's own repeated defect is a value computed
 * correctly whose last connection to a caller was never made.
 */
describe('createDeviceExecutor — push (plan 90 §4.6): the mediaScan result reaches the script', () => {
  function fakeTransfer(impl?: Partial<TransferPort>): { transfer: TransferPort; calls: Array<{ deviceId: string; opts: unknown }> } {
    const calls: Array<{ deviceId: string; opts: unknown }> = []
    const transfer: TransferPort = {
      install: async () => ({ package: null, durationMs: 0, output: '' }),
      push: async (deviceId, opts) => {
        calls.push({ deviceId, opts })
        return { mediaScan: { ran: true, method: 'scan_file', ms: 5 } }
      },
      pull: async () => ({ artifactId: 'a', bytes: 0 }),
      ...impl,
    }
    return { transfer, calls }
  }

  test('the full result — including mediaScan — is returned, not undefined', async () => {
    const { transfer } = fakeTransfer()
    const execute = createDeviceExecutor({ session: fakeSession(async () => ''), transfer })
    const result = await execute(call('push', { artifactId: 'art1', remotePath: '/sdcard/Pictures/x.jpg', mediaScan: 'auto' }))
    expect(result).toEqual({ mediaScan: { ran: true, method: 'scan_file', ms: 5 } })
  })

  test('mediaScan is forwarded to the TransferPort exactly as the script set it', async () => {
    const { transfer, calls } = fakeTransfer()
    const execute = createDeviceExecutor({ session: fakeSession(async () => ''), transfer })
    await execute(call('push', { artifactId: 'art1', remotePath: '/data/local/tmp/x.bin', mediaScan: 'never' }))
    expect(calls).toEqual([
      { deviceId: 'dev-1', opts: { artifactId: 'art1', remotePath: '/data/local/tmp/x.bin', mediaScan: 'never' } },
    ])
  })

  test('with no file transfer wired, push refuses with E_TRANSFER_UNAVAILABLE rather than silently no-op', async () => {
    const execute = createDeviceExecutor({ session: fakeSession(async () => '') })
    let caught: unknown
    try {
      await execute(call('push', { artifactId: 'a', remotePath: '/sdcard/x', mediaScan: 'auto' }))
    } catch (err) {
      caught = err
    }
    expect((caught as { code?: string } | undefined)?.code).toBe('E_TRANSFER_UNAVAILABLE')
  })
})

/**
 * The replay's own verbs (plan 94 §4.4, F6, F7, step 94.2): `tapNorm`,
 * `longPress`, `gesture`, `swipeNorm`. `NormPointSchema`/`NormGestureSampleSchema`
 * bound their inputs 0..1 (`@enkaku/protocol`), so `fakeGestureSession`'s real
 * 1080×1920 `frameSize` is what proves the mapping actually happened — a bug
 * that forgot to map would show up as a point outside 0..1080 or a fraction
 * left untouched, not a crash.
 */
describe('createDeviceExecutor — tapNorm (plan 94 §3.3, §4.4): normalised in, device pixels out', () => {
  test('maps a normalised point to device pixels using the session frameSize', async () => {
    const { session, calls } = fakeGestureSession({ frameSize: { width: 1000, height: 2000 } })
    const timing: TimingSettings = { ...DEFAULT_TIMING, betweenActionMs: [0, 0], coordJitterPx: 0 }
    const execute = createDeviceExecutor({ session, timing })
    await execute(call('tapNorm', { pos: { x: 0.5, y: 0.25 } }))
    expect(calls.tap).toHaveLength(1)
    expect(calls.tap[0]!.p).toEqual({ x: 500, y: 500 })
  })

  test('an explicit holdMs becomes an EXACT [holdMs, holdMs] range — not sampled from tapJitterMs', async () => {
    const { session, calls } = fakeGestureSession({})
    const timing: TimingSettings = { ...DEFAULT_TIMING, betweenActionMs: [0, 0], coordJitterPx: 0, tapJitterMs: [10, 20] }
    const execute = createDeviceExecutor({ session, timing })
    await execute(call('tapNorm', { pos: { x: 0.1, y: 0.1 }, holdMs: 777 }))
    expect(calls.tap[0]!.opts?.holdMs).toEqual([777, 777])
  })

  test('with no holdMs, falls back to the device tapJitterMs range — identical to plain tap', async () => {
    const { session, calls } = fakeGestureSession({})
    const timing: TimingSettings = { ...DEFAULT_TIMING, betweenActionMs: [0, 0], coordJitterPx: 0, tapJitterMs: [50, 60] }
    const execute = createDeviceExecutor({ session, timing })
    await execute(call('tapNorm', { pos: { x: 0.1, y: 0.1 } }))
    expect(calls.tap[0]!.opts?.holdMs).toEqual([50, 60])
  })
})

describe('createDeviceExecutor — longPress (plan 94 §3.4, §4.4, F4): a named duration, jittered around', () => {
  test('a Selector point target resolves without a dump, and holdMs is centred on ms', async () => {
    const { session, calls } = fakeGestureSession({})
    const timing: TimingSettings = { ...DEFAULT_TIMING, betweenActionMs: [0, 0], coordJitterPx: 0, tapJitterMs: [40, 120] }
    const execute = createDeviceExecutor({ session, timing })
    await execute(call('longPress', { target: { point: { x: 10, y: 20 } }, ms: 800 }))
    expect(calls.tap).toHaveLength(1)
    expect(calls.tap[0]!.p).toEqual({ x: 10, y: 20 })
    // tapJitterMs width is 80 (120-40); centred on 800 → [760, 840].
    expect(calls.tap[0]!.opts?.holdMs).toEqual([760, 840])
  })

  test('a zero-width tapJitterMs range produces an exact [ms, ms] hold', async () => {
    const { session, calls } = fakeGestureSession({})
    const timing: TimingSettings = { ...DEFAULT_TIMING, betweenActionMs: [0, 0], coordJitterPx: 0, tapJitterMs: [40, 40] }
    const execute = createDeviceExecutor({ session, timing })
    await execute(call('longPress', { target: { point: { x: 0, y: 0 } }, ms: 500 }))
    expect(calls.tap[0]!.opts?.holdMs).toEqual([500, 500])
  })
})

describe('createDeviceExecutor — gesture (plan 94 §3.4, §4.4, F3, F6, F7): the sampled trace, verbatim', () => {
  test('maps every sample to device pixels and carries atMs through untouched', async () => {
    const { session, calls } = fakeGestureSession({ frameSize: { width: 1000, height: 2000 } })
    const execute = createDeviceExecutor({ session, timing: NATURAL_TIMING })
    const samples = [
      { x: 0.1, y: 0.1, atMs: 0 },
      { x: 0.5, y: 0.5, atMs: 16 },
      { x: 0.9, y: 0.9, atMs: 32 },
    ]
    await execute(call('gesture', { samples }))
    expect(calls.gesture).toHaveLength(1)
    expect(calls.gesture[0]).toEqual([
      { x: 100, y: 200, atMs: 0 },
      { x: 500, y: 1000, atMs: 16 },
      { x: 900, y: 1800, atMs: 32 },
    ])
  })

  test('an engine with no gesture() rejects with E_GESTURE_UNSUPPORTED — never silently degrades to a two-point swipe', async () => {
    const { session, calls } = fakeGestureSession({ withGesture: false })
    const execute = createDeviceExecutor({ session, timing: NATURAL_TIMING })
    let caught: unknown
    try {
      await execute(call('gesture', { samples: [{ x: 0, y: 0, atMs: 0 }, { x: 1, y: 1, atMs: 10 }] }))
    } catch (err) {
      caught = err
    }
    expect((caught as { code?: string } | undefined)?.code).toBe('E_GESTURE_UNSUPPORTED')
    expect(calls.swipe).toHaveLength(0)
  })
})

describe('createDeviceExecutor — swipeNorm (plan 94 §3.4, §4.4, F6, F7): the two-point drag fallback, normalised', () => {
  test('maps both endpoints to device pixels and plays a straight line over ms — never curved', async () => {
    const { session, calls } = fakeGestureSession({ frameSize: { width: 1000, height: 2000 } })
    const timing: TimingSettings = { ...DEFAULT_TIMING, betweenActionMs: [0, 0], coordJitterPx: 0 }
    const execute = createDeviceExecutor({ session, timing })
    await execute(call('swipeNorm', { from: { x: 0.2, y: 0.8 }, to: { x: 0.2, y: 0.2 }, ms: 300 }))
    expect(calls.gesture).toHaveLength(0)
    expect(calls.swipe).toEqual([{ from: { x: 200, y: 1600 }, to: { x: 200, y: 400 }, ms: 300 }])
  })
})

/**
 * The freshness fix itself (plan 94 §4.5, F10, step 94.2): "why a getter
 * read per call matters" — a farm/device setting changed WHILE a script is
 * still running must reach its very next device call, on the SAME executor
 * instance, not merely a future one. This is the exact class of defect the
 * brief calls out by name: an input-arbiter queue budget read once at
 * construction and never again.
 */
describe('createDeviceExecutor — timing is a getter, read fresh on every call (plan 94 §4.5, F10)', () => {
  test('a plain (non-function) TimingSettings value still works — every pre-plan-94 caller is unaffected', async () => {
    const { session, calls } = fakeGestureSession({})
    const timing: TimingSettings = { ...DEFAULT_TIMING, betweenActionMs: [0, 0], tapJitterMs: [123, 456] }
    const execute = createDeviceExecutor({ session, timing })
    await execute(call('tap', { target: { point: { x: 0, y: 0 } } }))
    expect(calls.tap[0]!.opts?.holdMs).toEqual([123, 456])
  })

  test('a getter is called fresh on every device call — a mid-run change reaches the very next call on the SAME executor', async () => {
    const { session, calls } = fakeGestureSession({})
    let current: TimingSettings = { ...DEFAULT_TIMING, betweenActionMs: [0, 0], tapJitterMs: [10, 20] }
    // ONE executor, built ONCE — exactly like `job-runner.ts` builds one per
    // attempt and then issues every device.call of that attempt through it.
    const execute = createDeviceExecutor({ session, timing: () => current })

    await execute(call('tap', { target: { point: { x: 0, y: 0 } } }))
    expect(calls.tap[0]!.opts?.holdMs).toEqual([10, 20])

    // The setting changes WHILE this same executor is still in use — the
    // shape of an operator editing Settings mid-script.
    current = { ...current, tapJitterMs: [900, 900] }

    await execute(call('tap', { target: { point: { x: 0, y: 0 } } }))
    expect(calls.tap[1]!.opts?.holdMs).toEqual([900, 900])
    // Proof it is not a coincidence of construction order: the two calls
    // genuinely disagree, on the one executor instance.
    expect(calls.tap[0]!.opts?.holdMs).not.toEqual(calls.tap[1]!.opts?.holdMs)
  })

  test('a getter\'s value change also reaches coordJitterPx mid-run (not just tapJitterMs)', async () => {
    const { session, calls } = fakeGestureSession({})
    let current: TimingSettings = { ...DEFAULT_TIMING, betweenActionMs: [0, 0], coordJitterPx: 0 }
    const execute = createDeviceExecutor({ session, timing: () => current })

    await execute(call('tap', { target: { point: { x: 500, y: 500 } } }))
    expect(calls.tap[0]!.p).toEqual({ x: 500, y: 500 }) // zero jitter — exact

    current = { ...current, coordJitterPx: 1_000_000 }
    await execute(call('tap', { target: { point: { x: 500, y: 500 } } }))
    // A jitter this large cannot land back on the exact same pixel.
    expect(calls.tap[1]!.p).not.toEqual({ x: 500, y: 500 })
  })
})

/**
 * Plan 208 §3.5, §4.10 — `find`/`dump`/`waitFor`/`screenshot` are the only
 * methods that need the session's inspector; a `null` inspector (the
 * session's prewarm has not settled yet) is now `E_INSPECTOR_STARTING`,
 * never a substitute ad-hoc dump engine.
 */
function fakeStartingSession(): DeviceSession {
  const input: InputSink = { tap: async () => {} } as unknown as InputSink
  const arbiter = createInputArbiter(input, { queueWaitMs: () => 5_000, maxQueueDepth: () => 32, log: silentLog() })
  return {
    deviceId: 'dev-1',
    inspector: null,
    inspectorEngineId: 'starting',
    inspectorPollIntervalMs: 200,
    arbiter,
    frameSize: { width: 1080, height: 1920 },
    transport: { exec: async () => '', execOut: async () => new Uint8Array() },
  } as unknown as DeviceSession
}

describe('createDeviceExecutor — E_INSPECTOR_STARTING while the session has no inspector (plan 208 §3.5, §4.10)', () => {
  test('find, dump, waitFor, screenshot throw E_INSPECTOR_STARTING', async () => {
    const session = fakeStartingSession()
    const execute = createDeviceExecutor({ session })

    const calls: DeviceCall[] = [
      call('find', { sel: { text: 'x' } }),
      call('dump', {}),
      call('waitFor', { sel: { text: 'x' }, timeout: 100, intervalMs: 50 }),
      call('screenshot', {}),
    ]
    for (const c of calls) {
      let caught: unknown
      try {
        await execute(c)
      } catch (err) {
        caught = err
      }
      expect(caught, `${c.method} should have thrown`).toBeDefined()
      expect((caught as { code?: string }).code).toBe('E_INSPECTOR_STARTING')
    }
  })

  test('tap does not need the inspector — the existing inspector: null fixtures above keep passing unchanged', async () => {
    const session = fakeStartingSession()
    const execute = createDeviceExecutor({ session })
    // A point target never touches the inspector at all.
    await expect(execute(call('tap', { target: { point: { x: 1, y: 1 } } }))).resolves.toBeUndefined()
  })

  test('needsInspector is true for exactly the four inspector methods', () => {
    expect(needsInspector({ method: 'find' })).toBe(true)
    expect(needsInspector({ method: 'dump' })).toBe(true)
    expect(needsInspector({ method: 'waitFor' })).toBe(true)
    expect(needsInspector({ method: 'screenshot' })).toBe(true)
    expect(needsInspector({ method: 'tap' })).toBe(false)
    expect(needsInspector({ method: 'type' })).toBe(false)
    expect(needsInspector({ method: 'app.launch' })).toBe(false)
  })
})
