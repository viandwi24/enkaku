import { describe, expect, test } from 'bun:test'
import type { RecordingDoc } from '@enkaku/protocol'
import { defineRecording } from './define-recording'
import type { ArtifactApi, DeviceApi, JobsApi, KvApi, ScriptContext, ScriptLogger } from './types'

/**
 * plan 94 §5, step 94.1's verifiable result: "a hand-written `RecordingDoc`
 * fixture drives `defineRecording` and produces a `ScriptDefinition` whose
 * `run` issues the expected `DeviceCall` sequence against a fake device, with
 * the expected sleeps — with no device and no core." Everything below runs
 * with neither.
 */

type Call = { method: string; args: unknown[] }

function fakeDevice(): { device: DeviceApi; calls: Call[] } {
  const calls: Call[] = []
  const record =
    (method: string) =>
    async (...args: unknown[]) => {
      calls.push({ method, args })
    }
  const device = {
    tap: record('tap'),
    longPress: record('longPress'),
    tapNorm: record('tapNorm'),
    swipeNorm: record('swipeNorm'),
    gesture: record('gesture'),
    swipe: record('swipe'),
    scroll: record('scroll'),
    fling: record('fling'),
    type: record('type'),
    key: record('key'),
    find: async () => null,
    findDetailed: async () => ({ kind: 'not-found' }) as never,
    dump: async () => ({}) as never,
    waitFor: async () => ({}) as never,
    screenshot: async () => new Uint8Array(),
    app: { launch: record('app.launch'), forceStop: record('app.forceStop') },
    clipboard: { get: async () => '', set: record('clipboard.set') },
    install: async () => ({ package: null, durationMs: 0, output: '' }),
    push: async () => ({ artifactId: '', bytes: 0, mediaScanResult: null }) as never,
    pull: async () => ({ artifactId: '', bytes: 0 }),
  } as unknown as DeviceApi
  return { device, calls }
}

function fakeLog(): { log: ScriptLogger; lines: string[] } {
  const lines: string[] = []
  const push = (msg: string) => lines.push(msg)
  return { log: { debug: push, info: push, warn: push, error: push }, lines }
}

const unused = new Proxy(
  {},
  {
    get() {
      throw new Error('this step of the interpreter never touches kv/jobs/artifact')
    },
  },
)

function fakeCtx(params: Record<string, string>): { ctx: ScriptContext<Record<string, string>>; device: DeviceApi; calls: Call[]; sleeps: number[]; lines: string[] } {
  const { device, calls } = fakeDevice()
  const { log, lines } = fakeLog()
  const sleeps: number[] = []
  const ctx: ScriptContext<Record<string, string>> = {
    device,
    params,
    artifact: unused as ArtifactApi,
    log,
    job: { id: 'job-1', attempt: 1, deviceId: 'device-1' },
    kv: { device: unused as KvApi, global: unused as KvApi },
    jobs: unused as JobsApi,
    progress: () => {},
  }
  return { ctx, device, calls, sleeps, lines }
}

function baseDoc(overrides: Partial<RecordingDoc> = {}): RecordingDoc {
  return {
    schema: 1,
    name: 'checkout',
    version: '1.0.0',
    description: '',
    recordedAt: 1_700_000_000,
    recordedOn: { stableId: 'abc123', model: 'moto g06 power', width: 1080, height: 2400 },
    speed: 1,
    maxGapMs: 15_000,
    cleanup: 'force-stop',
    packages: [],
    steps: [],
    ...overrides,
  }
}

async function runWithSleepLog(doc: RecordingDoc, params: Record<string, string> = {}) {
  const sleeps: number[] = []
  const def = defineRecording(doc, { sleep: async (ms) => void sleeps.push(ms) })
  const { ctx, calls, lines } = fakeCtx(params)
  const result = await def.run(ctx)
  return { def, calls, sleeps, lines, result }
}

describe('defineRecording — the document drives the interpreter', () => {
  test('id/version/reset/timing are derived from the document', () => {
    const def = defineRecording(baseDoc({ packages: ['com.example.app'] }))
    expect(def.id).toBe('checkout')
    expect(def.version).toBe('1.0.0')
    expect(def.reset).toEqual({ packages: ['com.example.app'] })
    // `ScriptDefinition.timing` (plan 94 §4.5, F10) — on the canonical type
    // since step 94.2, read directly rather than through a structural cast.
    expect(def.timing).toEqual({ betweenActionMs: [0, 0] })
  })

  test('the produced definition is frozen, the same as any hand-written script (acceptance criterion 2)', () => {
    const def = defineRecording(baseDoc())
    expect(Object.isFrozen(def)).toBe(true)
  })

  test('a document with no { param } text steps gets an empty params object', () => {
    const def = defineRecording(baseDoc())
    expect(def.params.safeParse({}).success).toBe(true)
  })

  test('rejects a document that fails schema validation (e.g. bad version) — the SAME validation `defineScript` would reject', () => {
    expect(() => defineRecording(baseDoc({ version: 'v1' }))).toThrow()
  })
})

describe('defineRecording — the DeviceCall sequence', () => {
  test('a point tap dispatches to tapNorm, not the pixel-space Selector tap', async () => {
    const doc = baseDoc({ steps: [{ kind: 'tap', gapMs: 10, target: { kind: 'point', pos: { x: 0.5, y: 0.5 } } }] })
    const { calls } = await runWithSleepLog(doc)
    expect(calls).toEqual([{ method: 'tapNorm', args: [{ x: 0.5, y: 0.5 }, undefined] }])
  })

  test('a point tap carrying holdMs still goes through tapNorm, with holdMs in the opts', async () => {
    const doc = baseDoc({ steps: [{ kind: 'tap', gapMs: 10, target: { kind: 'point', pos: { x: 0.3, y: 0.4 } }, holdMs: 80 }] })
    const { calls } = await runWithSleepLog(doc)
    expect(calls).toEqual([{ method: 'tapNorm', args: [{ x: 0.3, y: 0.4 }, { holdMs: 80 }] }])
  })

  test('a promoted selector tap dispatches to the ordinary Selector-based tap', async () => {
    const target = { kind: 'selector' as const, selector: { id: 'checkout_button' }, fallback: { x: 0.5, y: 0.9 } }
    const doc = baseDoc({ steps: [{ kind: 'tap', gapMs: 10, target }] })
    const { calls } = await runWithSleepLog(doc)
    expect(calls).toEqual([{ method: 'tap', args: [{ id: 'checkout_button' }] }])
  })

  test('a longPress on a point dispatches to tapNorm with holdMs set (F4: a long-press replays as a long-press)', async () => {
    const doc = baseDoc({ steps: [{ kind: 'longPress', gapMs: 10, target: { kind: 'point', pos: { x: 0.5, y: 0.5 } }, holdMs: 600 }] })
    const { calls } = await runWithSleepLog(doc)
    expect(calls).toEqual([{ method: 'tapNorm', args: [{ x: 0.5, y: 0.5 }, { holdMs: 600 }] }])
  })

  test('a longPress on a promoted selector dispatches to the new longPress verb', async () => {
    const target = { kind: 'selector' as const, selector: { desc: 'menu' }, fallback: { x: 0.1, y: 0.1 } }
    const doc = baseDoc({ steps: [{ kind: 'longPress', gapMs: 10, target, holdMs: 700 }] })
    const { calls } = await runWithSleepLog(doc)
    expect(calls).toEqual([{ method: 'longPress', args: [{ desc: 'menu' }, 700] }])
  })

  test('a gesture step plays the operator\'s own sampled path verbatim — not a synthesised curve (F3, F7)', async () => {
    const samples = [
      { x: 0.1, y: 0.1, atMs: 0 },
      { x: 0.3, y: 0.2, atMs: 16 },
      { x: 0.5, y: 0.4, atMs: 32 },
    ]
    const doc = baseDoc({ steps: [{ kind: 'gesture', gapMs: 10, samples }] })
    const { calls } = await runWithSleepLog(doc)
    expect(calls).toEqual([{ method: 'gesture', args: [samples] }])
  })

  test('a swipe step dispatches to the normalised swipe verb', async () => {
    const doc = baseDoc({ steps: [{ kind: 'swipe', gapMs: 10, from: { x: 0.2, y: 0.8 }, to: { x: 0.2, y: 0.2 }, durationMs: 300 }] })
    const { calls } = await runWithSleepLog(doc)
    expect(calls).toEqual([{ method: 'swipeNorm', args: [{ x: 0.2, y: 0.8 }, { x: 0.2, y: 0.2 }, 300] }])
  })

  test('a key step passes the bare keycode through', async () => {
    const doc = baseDoc({ steps: [{ kind: 'key', gapMs: 10, keycode: 4 }] })
    const { calls } = await runWithSleepLog(doc)
    expect(calls).toEqual([{ method: 'key', args: [4] }])
  })

  test('a text step with a literal value types the literal', async () => {
    const doc = baseDoc({ steps: [{ kind: 'text', gapMs: 10, value: 'hello@example.com' }] })
    const { calls } = await runWithSleepLog(doc)
    expect(calls).toEqual([{ method: 'type', args: ['hello@example.com'] }])
  })

  test('a text step with a { param } reference types the run\'s own param value', async () => {
    const doc = baseDoc({ steps: [{ kind: 'text', gapMs: 10, value: { param: 'caption' } }] })
    const { calls } = await runWithSleepLog(doc, { caption: 'look at this' })
    expect(calls).toEqual([{ method: 'type', args: ['look at this'] }])
  })

  test('a full mixed sequence dispatches every step, in order', async () => {
    const doc = baseDoc({
      steps: [
        { kind: 'tap', gapMs: 5, target: { kind: 'point', pos: { x: 0.1, y: 0.1 } } },
        { kind: 'key', gapMs: 5, keycode: 4 },
        { kind: 'text', gapMs: 5, value: 'x' },
      ],
    })
    const { calls } = await runWithSleepLog(doc)
    expect(calls.map((c) => c.method)).toEqual(['tapNorm', 'key', 'type'])
  })

  test('every step is logged at debug, i/N', async () => {
    const doc = baseDoc({
      steps: [
        { kind: 'key', gapMs: 0, keycode: 3 },
        { kind: 'key', gapMs: 0, keycode: 4 },
      ],
    })
    const { lines } = await runWithSleepLog(doc)
    expect(lines).toEqual(['step 1/2: key', 'step 2/2: key'])
  })
})

describe('defineRecording — the sleeps', () => {
  test('one sleep per step, equal to gapMs at speed 1', async () => {
    const doc = baseDoc({
      steps: [
        { kind: 'key', gapMs: 100, keycode: 3 },
        { kind: 'key', gapMs: 250, keycode: 3 },
      ],
    })
    const { sleeps } = await runWithSleepLog(doc)
    expect(sleeps).toEqual([100, 250])
  })

  test('speed multiplies every gap', async () => {
    const doc = baseDoc({ speed: 2, steps: [{ kind: 'key', gapMs: 100, keycode: 3 }] })
    const { sleeps } = await runWithSleepLog(doc)
    expect(sleeps).toEqual([200])
  })

  test('maxGapMs caps a single gap, even after speed is applied', async () => {
    const doc = baseDoc({ speed: 1, maxGapMs: 500, steps: [{ kind: 'key', gapMs: 240_000, keycode: 3 }] })
    const { sleeps } = await runWithSleepLog(doc)
    expect(sleeps).toEqual([500])
  })

  test('a zero gap sleeps nothing (no call at all)', async () => {
    const doc = baseDoc({ steps: [{ kind: 'key', gapMs: 0, keycode: 3 }] })
    const { sleeps } = await runWithSleepLog(doc)
    expect(sleeps).toEqual([])
  })

  test('the default (uninjected) sleep really waits — measured against a small gap', async () => {
    const doc = baseDoc({ steps: [{ kind: 'key', gapMs: 30, keycode: 3 }] })
    const def = defineRecording(doc)
    const { ctx } = fakeCtx({})
    const start = Date.now()
    await def.run(ctx)
    expect(Date.now() - start).toBeGreaterThanOrEqual(25)
  })
})

describe('defineRecording — params (§4.2)', () => {
  test('every distinct { param } name becomes a required string field', () => {
    const doc = baseDoc({
      steps: [
        { kind: 'text', gapMs: 0, value: { param: 'caption' } },
        { kind: 'text', gapMs: 0, value: { param: 'hashtag' } },
        { kind: 'text', gapMs: 0, value: { param: 'caption' } }, // repeated — collapses to one field
      ],
    })
    const def = defineRecording(doc)
    expect(def.params.safeParse({ caption: 'a', hashtag: 'b' }).success).toBe(true)
    expect(def.params.safeParse({ caption: 'a' }).success).toBe(false) // hashtag missing
    expect(def.params.safeParse({}).success).toBe(false)
  })
})

describe('defineRecording — finish() (F19: stateless and idempotent)', () => {
  test('force-stops every declared package when cleanup is force-stop (the default)', async () => {
    const doc = baseDoc({ packages: ['com.example.app', 'com.example.helper'] })
    const def = defineRecording(doc)
    const { ctx, calls } = fakeCtx({})
    await def.finish?.(ctx)
    expect(calls).toEqual([
      { method: 'app.forceStop', args: ['com.example.app'] },
      { method: 'app.forceStop', args: ['com.example.helper'] },
    ])
  })

  test('does nothing when cleanup is none', async () => {
    const doc = baseDoc({ packages: ['com.example.app'], cleanup: 'none' })
    const def = defineRecording(doc)
    const { ctx, calls } = fakeCtx({})
    await def.finish?.(ctx)
    expect(calls).toEqual([])
  })

  test('running finish() twice produces the identical call sequence both times — a fresh child re-running it (F19) sees no difference', async () => {
    const doc = baseDoc({ packages: ['com.example.app'] })
    const def = defineRecording(doc)
    const first = fakeCtx({})
    const second = fakeCtx({})
    await def.finish?.(first.ctx)
    await def.finish?.(second.ctx)
    expect(first.calls).toEqual(second.calls)
  })

  test('an empty package list is a genuine no-op', async () => {
    const def = defineRecording(baseDoc({ packages: [] }))
    const { ctx, calls } = fakeCtx({})
    await def.finish?.(ctx)
    expect(calls).toEqual([])
  })
})
