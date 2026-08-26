import { describe, expect, test } from 'bun:test'
import { DEVICE_CALL_ARGS } from '@enkaku/protocol'
import type { DeviceCall } from './ipc'
import {
  ARG_REDACTION,
  createNoopTraceTee,
  createTraceTee,
  MAX_ARG_BYTES,
  redactArgs,
  resolveFramePolicy,
  type TraceCaptureRequest,
  type TraceCaptureResult,
  type TraceEventInput,
  type TraceTee,
} from './trace'

/**
 * The pure tee (plan 128 §3.1, §3.2, §3.4, §4.4 — step 128.3). No device, no
 * disk, no database: `emit`, `capture` and `engineId` are all injected, which
 * is the whole reason this file can assert the capture policy and the
 * single-slot gate without an Android phone in the room.
 */

interface Harness {
  tee: TraceTee
  events: TraceEventInput[]
  captures: TraceCaptureRequest[]
  /** Advances the injected clock — durations are measured, never slept for. */
  advance(ms: number): void
}

function harness(opts: {
  engineId?: string | null
  /** Undefined installs no `capture` at all, which forces the policy to `'none'`. */
  capture?: (req: TraceCaptureRequest) => Promise<TraceCaptureResult>
  attempt?: number
  nodeId?: string | null
} = {}): Harness {
  const events: TraceEventInput[] = []
  const captures: TraceCaptureRequest[] = []
  let clock = 1_756_000_000_000
  const capture = opts.capture
  const tee = createTraceTee({
    jobId: 'job-1',
    ...(opts.nodeId !== undefined ? { nodeId: opts.nodeId } : {}),
    attempt: () => opts.attempt ?? 1,
    engineId: () => (opts.engineId === undefined ? 'ui-server' : opts.engineId),
    emit: (e) => events.push(e),
    ...(capture
      ? {
          capture: (req: TraceCaptureRequest) => {
            captures.push(req)
            return capture(req)
          },
        }
      : {}),
    now: () => clock,
  })
  return {
    tee,
    events,
    captures,
    advance: (ms) => {
      clock += ms
    },
  }
}

const tap = (x = 1, y = 2): DeviceCall => ({ method: 'tap', args: { target: { point: { x, y } } } }) as DeviceCall

/** Lets every already-settled capture promise (and the `.then` chain behind it) run. */
async function drain(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve()
}

describe('createTraceTee — ordering and measurement (plan 128 §3.1, §3.3)', () => {
  test('events are emitted in call order and carry NO seq of their own — numbering belongs to the recorder', async () => {
    const h = harness({ engineId: null })
    h.tee.phase('run')
    for (const method of ['tap', 'swipe', 'key'] as const) {
      const token = h.tee.begin({ method, args: {} } as unknown as DeviceCall)
      h.advance(5)
      h.tee.end(token, { ok: true, value: null })
    }
    await drain()

    expect(h.events.map((e) => `${e.kind}:${e.name}`)).toEqual(['phase:start', 'action:tap', 'action:swipe', 'action:key'])
    // The tee's contract is ORDER; a `seq` here would restart at 1 on a
    // rebound job and collide with attempt 1 on `uniqueIndex(jobId, seq)`.
    for (const e of h.events) expect('seq' in e).toBe(false)
    for (const e of h.events) expect('id' in e).toBe(false)
  })

  test('an action carries the duration it actually took, and lands at the instant it STARTED', async () => {
    const h = harness({ engineId: null })
    const token = h.tee.begin(tap())
    const startedAt = h.events.length
    h.advance(180)
    h.tee.end(token, { ok: true, value: null })
    await drain()

    const action = h.events[startedAt]
    expect(action?.kind).toBe('action')
    expect(action?.durationMs).toBe(180)
    expect(action?.atMs).toBe(1_756_000_000_000)
    expect(action?.ok).toBe(true)
    expect(action?.errorCode).toBeNull()
  })

  test('a failing action carries its code and its message', async () => {
    const h = harness({ engineId: null })
    const token = h.tee.begin(tap())
    h.advance(3)
    h.tee.end(token, { ok: false, code: 'E_ADB_TIMEOUT', message: 'device did not answer' })
    await drain()

    const action = h.events.at(-1)
    expect(action?.ok).toBe(false)
    expect(action?.errorCode).toBe('E_ADB_TIMEOUT')
    expect(action?.meta?.message).toBe('device did not answer')
  })

  test('a second end() on the same token records nothing extra', async () => {
    const h = harness({ engineId: null })
    const token = h.tee.begin(tap())
    h.tee.end(token, { ok: true, value: null })
    h.tee.end(token, { ok: true, value: null })
    await drain()
    expect(h.events.filter((e) => e.kind === 'action')).toHaveLength(1)
  })

  test('every event carries the live attempt and the workflow node axis', async () => {
    const h = harness({ engineId: null, attempt: 3, nodeId: 'scroll-fyp' })
    h.tee.end(h.tee.begin(tap()), { ok: true, value: null })
    await drain()
    expect(h.events[0]?.attempt).toBe(3)
    expect(h.events[0]?.nodeId).toBe('scroll-fyp')
  })
})

describe('createTraceTee — redaction (plan 128 §4.4, §8 R6)', () => {
  test('`type` args are redacted to { length: n } — the text never appears', async () => {
    const h = harness({ engineId: null })
    const token = h.tee.begin({ method: 'type', args: { text: 'hunter2-is-a-password' } } as unknown as DeviceCall)
    h.tee.end(token, { ok: true, value: null })
    await drain()

    expect(h.events[0]?.meta?.args).toEqual({ length: 21 })
    expect(JSON.stringify(h.events[0])).not.toContain('hunter2')
  })

  test('`clipboard.set` args are redacted the same way — a paste is how a careful script moves a secret', async () => {
    const h = harness({ engineId: null })
    const token = h.tee.begin({ method: 'clipboard.set', args: { text: 'sk-live-abc', paste: true } } as unknown as DeviceCall)
    h.tee.end(token, { ok: true, value: null })
    await drain()

    expect(h.events[0]?.meta?.args).toEqual({ length: 11 })
    expect(JSON.stringify(h.events[0])).not.toContain('sk-live')
  })

  test('an oversized arg VALUE is replaced by an explicit truncation marker, and its siblings survive', async () => {
    const h = harness({ engineId: null })
    const huge = 'x'.repeat(MAX_ARG_BYTES + 100)
    const token = h.tee.begin({ method: 'find', args: { sel: { text: huge }, timeout: 5_000 } } as unknown as DeviceCall)
    h.tee.end(token, { ok: true, value: null })
    await drain()

    const args = h.events[0]?.meta?.args as Record<string, unknown>
    expect(args.sel).toMatchObject({ truncated: true })
    expect((args.sel as { bytes: number }).bytes).toBeGreaterThan(MAX_ARG_BYTES)
    // The selector is gone, but the rest of the call is still readable.
    expect(args.timeout).toBe(5_000)
    expect(JSON.stringify(h.events[0])).not.toContain('xxxxxxxxxx')
  })

  test('a small arg is kept verbatim — a `find` with no selector is useless to a debugger', () => {
    expect(redactArgs('find', { sel: { text: 'Post' } })).toEqual({ sel: { text: 'Post' } })
  })

  /**
   * Plan 128 §8 R6 — the guard the risk table asks for: a new device verb
   * added to `DEVICE_CALL_ARGS` without a redaction decision must fail HERE,
   * not silently ship its arguments onto a timeline.
   */
  test('every method in DEVICE_CALL_ARGS has a redaction decision', () => {
    const missing = Object.keys(DEVICE_CALL_ARGS).filter((method) => ARG_REDACTION[method as keyof typeof ARG_REDACTION] === undefined)
    expect(missing).toEqual([])
    // And nothing has drifted the other way, either.
    expect(Object.keys(ARG_REDACTION).sort()).toEqual(Object.keys(DEVICE_CALL_ARGS).sort())
  })

  test('the two secret-bearing verbs are the ones marked `length`', () => {
    const redacted = Object.entries(ARG_REDACTION)
      .filter(([, decision]) => decision === 'length')
      .map(([method]) => method)
      .sort()
    expect(redacted).toEqual(['clipboard.set', 'type'])
  })
})

describe('resolveFramePolicy (plan 128 §3.4)', () => {
  test('ui-server captures per action; every other engine only on failure; no inspector captures nothing', () => {
    expect(resolveFramePolicy('ui-server')).toBe('per-action')
    expect(resolveFramePolicy('uiautomator-dump')).toBe('on-failure')
    // An engine nobody has measured is assumed to contend with the script.
    expect(resolveFramePolicy('appium')).toBe('on-failure')
    expect(resolveFramePolicy('starting')).toBe('on-failure')
    expect(resolveFramePolicy(null)).toBe('none')
  })
})

describe('createTraceTee — the capture policy (plan 128 §3.4)', () => {
  test('ui-server: every action gets a frame, with no sampling and no cap', async () => {
    const h = harness({ engineId: 'ui-server', capture: async () => ({ frameHash: 'aa', uiHash: null }) })
    for (let i = 0; i < 4; i += 1) {
      h.tee.end(h.tee.begin(tap()), { ok: true, value: null })
      await drain()
    }
    expect(h.events).toHaveLength(4)
    for (const e of h.events) {
      expect(e.frameStatus).toBe('ok')
      expect(e.frameHash).toBe('aa')
    }
  })

  test('uiautomator-dump: skipped-policy for a successful action, ok for a failing one', async () => {
    const h = harness({ engineId: 'uiautomator-dump', capture: async () => ({ frameHash: 'bb', uiHash: 'cc' }) })

    h.tee.end(h.tee.begin(tap()), { ok: true, value: null })
    await drain()
    expect(h.events[0]?.frameStatus).toBe('skipped-policy')
    expect(h.events[0]?.frameHash).toBeNull()
    // Nothing was ever asked of the device — that is the whole point (§0.3).
    expect(h.captures).toHaveLength(0)

    h.tee.end(h.tee.begin(tap()), { ok: false, code: 'E_ADB_TIMEOUT', message: 'nope' })
    await drain()
    expect(h.events[1]?.frameStatus).toBe('ok')
    expect(h.events[1]?.frameHash).toBe('bb')
    // §3.4 — the failing action gets its UI tree too, on every engine.
    expect(h.captures[0]?.uiTree).toBe('capture')
    expect(h.events[1]?.uiHash).toBe('cc')
  })

  test('no inspector: nothing is captured and every action still says so in words', async () => {
    const h = harness({ engineId: null, capture: async () => ({ frameHash: 'zz' }) })
    h.tee.end(h.tee.begin(tap()), { ok: false, code: 'X', message: 'y' })
    await drain()
    expect(h.captures).toHaveLength(0)
    expect(h.events[0]?.frameStatus).toBe('skipped-policy')
  })

  test('no trace store wired: the policy is none, but the phase event still names the real engine', async () => {
    const h = harness({ engineId: 'ui-server' }) // no `capture`
    h.tee.phase('run')
    h.tee.end(h.tee.begin(tap()), { ok: true, value: null })
    await drain()

    expect(h.events[0]?.meta).toEqual({ inspectorEngineId: 'ui-server', framePolicy: 'none' })
    expect(h.events[1]?.frameStatus).toBe('skipped-policy')
  })

  test('the UI tree of a `dump` is reused, never re-dumped', async () => {
    const h = harness({ engineId: 'ui-server', capture: async () => ({ frameHash: 'aa', uiHash: 'dd' }) })
    const tree = { id: 'root', children: [] }
    h.tee.end(h.tee.begin({ method: 'dump', args: {} } as unknown as DeviceCall), { ok: true, value: tree })
    await drain()

    expect(h.captures[0]).toMatchObject({ method: 'dump', frame: 'capture', uiTree: 'reuse', treeValue: tree })
    expect(h.events[0]?.uiHash).toBe('dd')
  })

  test('a `screenshot` reuses the script\'s own bytes rather than taking a second picture (§3.2)', async () => {
    const h = harness({ engineId: 'ui-server', capture: async () => ({ frameHash: 'ee' }) })
    h.tee.end(h.tee.begin({ method: 'screenshot', args: {} } as unknown as DeviceCall), { ok: true, value: 'iVBORw0=' })
    await drain()

    expect(h.captures[0]).toMatchObject({ method: 'screenshot', frame: 'reuse', frameValue: 'iVBORw0=' })
    expect(h.events[0]?.frameStatus).toBe('ok')
  })

  test('a screenshot artifact reuses the artifact\'s own bytes too (§3.2)', async () => {
    const h = harness({ engineId: 'ui-server', capture: async () => ({ frameHash: 'ff' }) })
    const bytes = new Uint8Array([1, 2, 3])
    h.tee.artifact({ kind: 'screenshot', label: 'before-post', sizeBytes: 3, frameBytes: bytes })
    await drain()

    expect(h.captures[0]).toMatchObject({ method: 'artifact', frame: 'reuse', uiTree: 'none', frameValue: bytes })
    expect(h.events[0]).toMatchObject({ kind: 'artifact', name: 'before-post', frameHash: 'ff', frameStatus: 'ok' })
  })
})

describe('createTraceTee — the bounded capture ceiling (plan 128 §3.4, revised on the owner\'s correction)', () => {
  test('four captures run concurrently — a script quicker than a screenshot still gets a frame per action', async () => {
    const releases: Array<(r: TraceCaptureResult) => void> = []
    const h = harness({
      engineId: 'ui-server',
      capture: () => new Promise<TraceCaptureResult>((resolve) => { releases.push(resolve) }),
    })

    // Four actions in a row, none of whose captures have settled. Under the
    // old single slot, three of these got no frame at all — which is what the
    // owner rejected: a late frame is fine, a missing one is not.
    for (let i = 0; i < 4; i++) h.tee.end(h.tee.begin(tap()), { ok: true, value: null })
    await drain()
    expect(h.captures).toHaveLength(4)
    expect(h.events).toHaveLength(0) // all four still held, awaiting their frames

    releases.forEach((r, i) => r({ frameHash: `f${i}` }))
    await drain()
    expect(h.events).toHaveLength(4)
    expect(h.events.every((e) => e.frameStatus === 'ok')).toBe(true)
  })

  test('the fifth concurrent action drops its FRAME — fail-drop, never a queue', async () => {
    const h = harness({
      engineId: 'ui-server',
      capture: () => new Promise<TraceCaptureResult>(() => {}),
    })

    for (let i = 0; i < 4; i++) h.tee.end(h.tee.begin(tap()), { ok: true, value: null })
    await drain()
    expect(h.captures).toHaveLength(4)

    h.tee.end(h.tee.begin(tap()), { ok: true, value: null })
    await drain()
    expect(h.captures).toHaveLength(4) // no fifth capture was ever started
    expect(h.events).toHaveLength(1)
    expect(h.events[0]?.frameStatus).toBe('skipped-busy')
    expect(h.events[0]?.frameHash).toBeNull()
  })

  test('a saturated ceiling drops the frame but NEVER the free tree', async () => {
    // The owner's own point: a `dump`/`find`/`waitFor` already returned its
    // tree, so storing it costs the device nothing. Dropping it because a
    // SCREENSHOT slot was busy is the one thing this must not do — and it is
    // exactly what the single-slot early return used to do.
    const h = harness({
      engineId: 'ui-server',
      capture: (req) => (req.frame === 'none' ? Promise.resolve({ uiHash: 'tree-1' }) : new Promise<TraceCaptureResult>(() => {})),
    })

    for (let i = 0; i < 4; i++) h.tee.end(h.tee.begin(tap()), { ok: true, value: null })
    await drain()
    expect(h.captures).toHaveLength(4)

    // A dump arriving while the ceiling is saturated.
    h.tee.end(h.tee.begin({ method: 'dump', args: {} }), { ok: true, value: { id: 'root' } })
    await drain()

    const dumpCapture = h.captures.find((c) => c.method === 'dump')
    expect(dumpCapture).toMatchObject({ frame: 'none', uiTree: 'reuse', treeValue: { id: 'root' } })
    const dumpEvent = h.events.find((e) => e.name === 'dump')
    expect(dumpEvent?.uiHash).toBe('tree-1')
    expect(dumpEvent?.frameHash).toBeNull()
    expect((dumpEvent?.meta as { frameDropped?: string } | null)?.frameDropped).toBe('busy')
    // Reported as BUSY, never as policy: the engine was going to take a
    // picture and could not, which is a different fact from "this engine
    // takes none" and leads a debugger to a different conclusion.
    expect(dumpEvent?.frameStatus).toBe('skipped-busy')
  })

  test('a reuse-only capture is not blocked by the slot — nothing goes to the device', async () => {
    const h = harness({
      engineId: 'ui-server',
      capture: (req) => (req.frame === 'reuse' ? Promise.resolve({ frameHash: 'reused' }) : new Promise<TraceCaptureResult>(() => {})),
    })
    h.tee.end(h.tee.begin(tap()), { ok: true, value: null }) // takes the slot, never settles
    await drain()

    h.tee.artifact({ kind: 'screenshot', label: 'x', sizeBytes: 1, frameBytes: new Uint8Array([1]) })
    await drain()
    expect(h.events.at(-1)).toMatchObject({ kind: 'artifact', frameHash: 'reused', frameStatus: 'ok' })
  })
})

describe('createTraceTee — a capture that fails (plan 128 §3.4, criterion 5)', () => {
  test('a capture that REJECTS records frameStatus failed and never throws out of end()', async () => {
    const h = harness({ engineId: 'ui-server', capture: async () => { throw new Error('ui-server watchdog: dead') } })
    const token = h.tee.begin(tap())
    expect(() => h.tee.end(token, { ok: true, value: null })).not.toThrow()
    await drain()

    expect(h.events[0]?.frameStatus).toBe('failed')
    expect(h.events[0]?.frameHash).toBeNull()
    expect(h.events[0]?.meta?.captureError).toBe('ui-server watchdog: dead')
    // The action itself is still recorded, in full — the timeline never omits.
    expect(h.events[0]?.ok).toBe(true)
    expect(h.events[0]?.name).toBe('tap')
  })

  test('a capture that throws SYNCHRONOUSLY is the same failure, and frees the slot', async () => {
    let calls = 0
    const h = harness({
      engineId: 'ui-server',
      capture: () => {
        calls += 1
        throw new Error('boom')
      },
    })
    h.tee.end(h.tee.begin(tap()), { ok: true, value: null })
    await drain()
    expect(h.events[0]?.frameStatus).toBe('failed')

    h.tee.end(h.tee.begin(tap()), { ok: true, value: null })
    await drain()
    expect(calls).toBe(2)
    expect(h.events[1]?.frameStatus).toBe('failed')
  })

  test('a capture that resolves with no frame hash is a failure, not a silent gap', async () => {
    const h = harness({ engineId: 'ui-server', capture: async () => ({ frameHash: null, uiHash: null }) })
    h.tee.end(h.tee.begin(tap()), { ok: true, value: null })
    await drain()
    expect(h.events[0]?.frameStatus).toBe('failed')
  })

  test('an emit that throws does not take the job with it', async () => {
    const events: TraceEventInput[] = []
    const tee = createTraceTee({
      jobId: 'job-1',
      attempt: () => 1,
      engineId: () => null,
      emit: (e) => {
        events.push(e)
        throw new Error('the host recorder blew up')
      },
    })
    expect(() => tee.end(tee.begin(tap()), { ok: true, value: null })).not.toThrow()
    expect(() => tee.phase('run')).not.toThrow()
    expect(events.length).toBeGreaterThan(0)
  })
})

describe('createTraceTee — the other lanes (plan 128 §4.1)', () => {
  test('a phase start carries the resolved policy, and the previous phase is closed with its duration', async () => {
    const h = harness({ engineId: 'ui-server', capture: async () => ({ frameHash: 'aa' }) })
    h.tee.phase('prepare')
    h.advance(400)
    h.tee.phase('run')
    h.advance(50)
    h.tee.closePhase()

    expect(h.events.map((e) => `${e.name}:${e.phase}`)).toEqual(['start:prepare', 'end:prepare', 'start:run', 'end:run'])
    expect(h.events[0]?.meta).toEqual({ inspectorEngineId: 'ui-server', framePolicy: 'per-action' })
    expect(h.events[1]?.durationMs).toBe(400)
    expect(h.events[3]?.durationMs).toBe(50)
  })

  test('the policy line is per PHASE, so a mid-run engine fallback is visible where it happened', async () => {
    let engine = 'ui-server'
    const events: TraceEventInput[] = []
    const tee = createTraceTee({
      jobId: 'job-1',
      attempt: () => 1,
      engineId: () => engine,
      emit: (e) => events.push(e),
      capture: async () => ({ frameHash: 'aa' }),
    })
    tee.phase('run')
    engine = 'uiautomator-dump' // the ui-server watchdog declared it dead
    tee.phase('finish')

    expect(events.filter((e) => e.name === 'start').map((e) => e.meta)).toEqual([
      { inspectorEngineId: 'ui-server', framePolicy: 'per-action' },
      { inspectorEngineId: 'uiautomator-dump', framePolicy: 'on-failure' },
    ])
  })

  test('closePhase is a no-op when no phase is open', () => {
    const h = harness({ engineId: null })
    h.tee.closePhase()
    expect(h.events).toEqual([])
  })

  test('events outside any phase carry a null phase — the pre-script acquire window', async () => {
    const h = harness({ engineId: null })
    h.tee.log({ ts: 1, level: 'info', source: 'runner', msg: 'attempt 1 starting' })
    expect(h.events[0]).toMatchObject({ kind: 'log', name: 'info', phase: null, atMs: 1 })
    expect(h.events[0]?.meta).toEqual({ source: 'runner', msg: 'attempt 1 starting' })
  })

  test('a log line lands at its OWN timestamp, not at the moment the tee saw it', () => {
    const h = harness({ engineId: null })
    h.tee.phase('run')
    h.tee.log({ ts: 42, level: 'warn', source: 'script', msg: 'slow', fields: { ms: 900 } })
    expect(h.events.at(-1)).toMatchObject({ kind: 'log', name: 'warn', atMs: 42, phase: 'run' })
    expect((h.events.at(-1)?.meta as { fields: unknown }).fields).toEqual({ ms: 900 })
  })

  test('progress and assist land on the same axis as everything else', () => {
    const h = harness({ engineId: null })
    h.tee.progress({ done: 3, total: 10 })
    h.tee.assist({ at: 99, actor: 'operator-1' })
    expect(h.events[0]).toMatchObject({ kind: 'progress', name: 'progress' })
    expect(h.events[0]?.meta).toEqual({ value: { done: 3, total: 10 } })
    expect(h.events[1]).toMatchObject({ kind: 'assist', name: 'assist', atMs: 99 })
    expect(h.events[1]?.meta).toEqual({ actor: 'operator-1' })
  })

  test('an oversized progress value is truncated by the same rule the args use', () => {
    const h = harness({ engineId: null })
    h.tee.progress({ blob: 'y'.repeat(MAX_ARG_BYTES * 2) })
    expect(h.events[0]?.meta?.value).toMatchObject({ truncated: true })
  })

  test('a non-screenshot artifact is recorded with no capture at all', async () => {
    const h = harness({ engineId: 'ui-server', capture: async () => ({ frameHash: 'aa' }) })
    h.tee.artifact({ kind: 'log', label: 'job', sizeBytes: 1_024 })
    await drain()
    expect(h.captures).toHaveLength(0)
    expect(h.events[0]).toMatchObject({ kind: 'artifact', name: 'job', frameStatus: null })
    expect(h.events[0]?.meta).toEqual({ artifactKind: 'log', sizeBytes: 1_024 })
  })
})

describe('createNoopTraceTee (plan 128 step 128.4)', () => {
  test('every method is safe to call and nothing is recorded', () => {
    const tee = createNoopTraceTee()
    expect(() => {
      tee.end(tee.begin(tap()), { ok: true, value: null })
      tee.phase('run')
      tee.closePhase()
      tee.log({ ts: 1, level: 'info', source: 'runner', msg: 'x' })
      tee.artifact({ kind: 'screenshot', label: 'x', sizeBytes: 1, frameBytes: new Uint8Array([1]) })
      tee.progress(1)
      tee.assist({ at: 1, actor: null })
    }).not.toThrow()
  })
})
