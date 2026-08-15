import { describe, expect, test } from 'bun:test'
import type { RecordingSettings, UiNode } from '@enkaku/protocol'
import { createBlobStore, sniffImageMediaType } from '../agent/blob/store'
import { openDb, runMigrations, type Db } from '../db'
import { createLogger } from '../util/logger'
import { createRecordingSession, type RecordingSessionDeps } from './session'

/**
 * `RecordingSession` (plan 94 §4.6, step 94.3) — the recorder's core state
 * machine, exercised entirely with a fake clock/timer queue and no device,
 * per this step's own verifiable result ("fully provable with a fake input
 * path"). The `input.tap`-through-`ws-handlers.ts` integration lives in
 * `../server/ws-handlers-recording.test.ts`; this file proves the session
 * logic in isolation.
 */

function db(): Db {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  return opened.db
}

function leaf(overrides: Partial<UiNode> = {}): UiNode {
  return {
    resourceId: '',
    text: '',
    desc: '',
    className: 'android.widget.TextView',
    packageName: 'com.example',
    bounds: { left: 0, top: 0, right: 10, bottom: 10 },
    clickable: false,
    enabled: true,
    focused: false,
    index: 0,
    children: [],
    ...overrides,
  }
}

/** 1x1 PNG-shaped bytes — enough for `sniffImageMediaType` to say "image/png"; `store.ts`'s own `parseImageDimensions` degrading to `null` on a header this short is fine, the recorder never reads width/height back. */
function pngBytes(): Uint8Array {
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8])
}

const DEFAULT_SETTINGS: RecordingSettings = {
  anchorQuietMs: 400,
  anchorMinIntervalMs: 1_500,
  longPressMs: 400,
  maxSteps: 500,
  maxDurationSec: 900,
  captureScreenshots: true,
}

/** A synchronous fake timer queue — `advance(ms)` fires every timer whose due time has arrived, including ones scheduled by a firing timer itself. */
function fakeClock() {
  let now = 0
  let nextId = 1
  const timers = new Map<number, { dueAt: number; fn: () => void }>()
  return {
    now: () => now,
    setTimer: (fn: () => void, ms: number) => {
      const id = nextId++
      timers.set(id, { dueAt: now + ms, fn })
      return id as unknown as ReturnType<typeof setTimeout>
    },
    clearTimer: (h: unknown) => {
      timers.delete(h as number)
    },
    advance: (ms: number) => {
      now += ms
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.dueAt <= now).sort((a, b) => a[1].dueAt - b[1].dueAt)[0]
        if (!due) break
        timers.delete(due[0])
        due[1].fn()
      }
    },
  }
}

/** A handful of microtask ticks — enough for a chained `.then().catch().finally()` off a fake timer callback to settle before the next assertion. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

interface Harness {
  session: ReturnType<typeof createRecordingSession>
  clock: ReturnType<typeof fakeClock>
  anchorCalls: number
  screenshotCalls: number
  setAnchor: (tree: UiNode | null, packageName?: string) => void
  boundCalls: ('max-steps' | 'max-duration')[]
  stepPushes: { index: number; kind: string; hasCandidate: boolean }[]
}

function harness(overrides: Partial<RecordingSettings> = {}, extra: Partial<RecordingSessionDeps> = {}): Harness {
  const clock = fakeClock()
  const blobs = createBlobStore(db())
  const settings: RecordingSettings = { ...DEFAULT_SETTINGS, ...overrides }
  let anchorTree: UiNode | null = null
  let anchorPackage = 'com.example'
  let anchorCalls = 0
  let screenshotCalls = 0
  const boundCalls: ('max-steps' | 'max-duration')[] = []
  const stepPushes: { index: number; kind: string; hasCandidate: boolean }[] = []

  const session = createRecordingSession({
    deviceId: 'dev-1',
    startedAtMs: 0,
    recordedOn: { stableId: 'stable-1', model: 'Pixel Test', width: 1080, height: 2400 },
    settings: () => settings,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    captureAnchor: async () => {
      anchorCalls++
      return anchorTree ? { root: anchorTree, packageName: anchorPackage } : null
    },
    captureScreenshot: async () => {
      screenshotCalls++
      return pngBytes()
    },
    blobs,
    onStep: (index, kind, hasCandidate) => stepPushes.push({ index, kind, hasCandidate }),
    onBound: (reason) => boundCalls.push(reason),
    log: createLogger('test'),
    ...extra,
  })

  return {
    session,
    clock,
    get anchorCalls() {
      return anchorCalls
    },
    get screenshotCalls() {
      return screenshotCalls
    },
    setAnchor: (tree, packageName = 'com.example') => {
      anchorTree = tree
      anchorPackage = packageName
    },
    boundCalls,
    stepPushes,
  }
}

describe('createRecordingSession — steps, gaps, and classification', () => {
  test('gapMs is the wall-clock delta since the previous step (or since start, for the first one)', async () => {
    const h = harness()
    h.clock.advance(120)
    h.session.observe({ kind: 'tap', pos: { x: 0.5, y: 0.5 } })
    h.clock.advance(340)
    h.session.observe({ kind: 'tap', pos: { x: 0.5, y: 0.5 } })

    const doc = await h.session.finishAndBuild()
    expect(doc.steps.map((s) => s.gapMs)).toEqual([120, 340])
  })

  test('a tap with no holdMs stays a tap; one at or above longPressMs becomes longPress', async () => {
    const h = harness({ longPressMs: 400 })
    h.session.observe({ kind: 'tap', pos: { x: 0.1, y: 0.1 } })
    h.session.observe({ kind: 'tap', pos: { x: 0.1, y: 0.1 }, holdMs: 399 })
    h.session.observe({ kind: 'tap', pos: { x: 0.1, y: 0.1 }, holdMs: 400 })
    h.session.observe({ kind: 'tap', pos: { x: 0.1, y: 0.1 }, holdMs: 900 })

    const doc = await h.session.finishAndBuild()
    expect(doc.steps.map((s) => s.kind)).toEqual(['tap', 'tap', 'longPress', 'longPress'])
    expect(doc.steps[2]).toMatchObject({ kind: 'longPress', holdMs: 400 })
  })

  test('swipe, gesture, key, and text pass their fields through verbatim', async () => {
    const h = harness()
    const samples = [
      { x: 0.2, y: 0.8, atMs: 0 },
      { x: 0.5, y: 0.4, atMs: 120 },
    ]
    h.session.observe({ kind: 'swipe', from: { x: 0.1, y: 0.1 }, to: { x: 0.9, y: 0.9 }, durationMs: 250 })
    h.session.observe({ kind: 'gesture', samples })
    h.session.observe({ kind: 'key', keycode: 4 })
    h.session.observe({ kind: 'text', text: 'hello world' })

    const doc = await h.session.finishAndBuild()
    expect(doc.steps[0]).toMatchObject({ kind: 'swipe', from: { x: 0.1, y: 0.1 }, to: { x: 0.9, y: 0.9 }, durationMs: 250 })
    expect(doc.steps[1]).toMatchObject({ kind: 'gesture', samples })
    expect(doc.steps[2]).toMatchObject({ kind: 'key', keycode: 4 })
    expect(doc.steps[3]).toMatchObject({ kind: 'text', value: 'hello world' })
  })

  test('the verifiable result\'s own arithmetic: 30 taps and 2 drags produce 32 steps', async () => {
    const h = harness()
    for (let i = 0; i < 30; i++) {
      h.clock.advance(50)
      h.session.observe({ kind: 'tap', pos: { x: 0.1, y: 0.1 } })
    }
    for (let i = 0; i < 2; i++) {
      h.clock.advance(50)
      h.session.observe({
        kind: 'gesture',
        samples: [
          { x: 0.2, y: 0.8, atMs: 0 },
          { x: 0.4, y: 0.4, atMs: 100 },
          { x: 0.6, y: 0.2, atMs: 200 },
        ],
      })
    }
    const doc = await h.session.finishAndBuild()
    expect(doc.steps).toHaveLength(32)
    expect(doc.steps.every((s) => s.gapMs > 0)).toBe(true)
    expect(doc.steps.filter((s) => s.kind === 'gesture')).toHaveLength(2)
  })
})

describe('createRecordingSession — anchors and candidates (plan 94 §3.3)', () => {
  test('a step observed with no anchor captured yet has no candidate', async () => {
    const h = harness()
    h.session.observe({ kind: 'tap', pos: { x: 0.5, y: 0.5 } })
    const doc = await h.session.finishAndBuild()
    expect(doc.steps[0]).not.toHaveProperty('candidate')
  })

  test('quiet period triggers an anchor dump, which the NEXT tap is hit-tested against', async () => {
    const h = harness({ anchorQuietMs: 400, anchorMinIntervalMs: 1_500 })
    h.setAnchor(
      leaf({
        resourceId: 'root',
        bounds: { left: 0, top: 0, right: 1080, bottom: 2400 },
        children: [leaf({ resourceId: 'com.app:id/go', clickable: true, bounds: { left: 0, top: 0, right: 540, bottom: 200 } })],
      }),
      'com.app',
    )

    h.session.observe({ kind: 'key', keycode: 4 }) // arms the quiet timer
    h.clock.advance(400) // fires it — takeAnchor() starts
    await flush()
    expect(h.anchorCalls).toBe(1)

    h.session.observe({ kind: 'tap', pos: { x: 0.1, y: 0.02 } }) // inside `go`'s bounds, normalised
    const doc = await h.session.finishAndBuild()
    const tap = doc.steps[1]
    expect(tap?.kind).toBe('tap')
    expect(tap && 'candidate' in tap ? tap.candidate : undefined).toEqual({
      selector: { id: 'go' },
      count: 1,
      anchorAgeMs: 0,
      anchorStepsSince: 0,
      anchorPackage: 'com.app',
    })
  })

  test('anchorMinIntervalMs throttles a second dump — a fast operator does not flood the blob store', async () => {
    const h = harness({ anchorQuietMs: 100, anchorMinIntervalMs: 1_500 })
    h.setAnchor(leaf({ bounds: { left: 0, top: 0, right: 1080, bottom: 2400 } }))

    h.session.observe({ kind: 'tap', pos: { x: 0.1, y: 0.1 } })
    h.clock.advance(100)
    await flush()
    expect(h.anchorCalls).toBe(1)

    h.session.observe({ kind: 'tap', pos: { x: 0.1, y: 0.1 } })
    h.clock.advance(100) // only 100ms after the previous dump — well under 1500ms
    await flush()
    expect(h.anchorCalls).toBe(1) // still one — throttled

    h.session.observe({ kind: 'tap', pos: { x: 0.1, y: 0.1 } })
    h.clock.advance(1_500)
    await flush()
    expect(h.anchorCalls).toBe(2) // now due again
  })

  test('an anchor dump failure is skipped, never a failed recording', async () => {
    const h = harness({ anchorQuietMs: 100 }, { captureAnchor: async () => Promise.reject(new Error('dump timed out')) })
    h.session.observe({ kind: 'tap', pos: { x: 0.1, y: 0.1 } })
    h.clock.advance(100)
    await flush()
    h.session.observe({ kind: 'tap', pos: { x: 0.1, y: 0.1 } })
    const doc = await h.session.finishAndBuild()
    expect(doc.steps).toHaveLength(2)
    expect(doc.steps[1]).not.toHaveProperty('candidate')
  })
})

describe('createRecordingSession — screenshots through the blob store (F16)', () => {
  test('a tap gets a screenshotBlobId when captureScreenshots is on', async () => {
    const h = harness({ captureScreenshots: true })
    h.session.observe({ kind: 'tap', pos: { x: 0.5, y: 0.5 } })
    const doc = await h.session.finishAndBuild()
    const step = doc.steps[0]
    expect(step && 'screenshotBlobId' in step ? step.screenshotBlobId : undefined).toMatch(/^sha256:/)
  })

  test('captureScreenshots: false takes no screenshot at all', async () => {
    const h = harness({ captureScreenshots: false })
    h.session.observe({ kind: 'tap', pos: { x: 0.5, y: 0.5 } })
    await h.session.finishAndBuild()
    expect(h.screenshotCalls).toBe(0)
  })

  test('key and text steps never get a screenshot — RecordingStepSchema carries no such field for them', async () => {
    const h = harness({ captureScreenshots: true })
    h.session.observe({ kind: 'key', keycode: 4 })
    h.session.observe({ kind: 'text', text: 'hi' })
    await h.session.finishAndBuild()
    expect(h.screenshotCalls).toBe(0)
  })

  test('an identical screenshot across two steps dedupes to one blob row (content-addressed)', async () => {
    const h = harness({ captureScreenshots: true }) // the fake always returns the same pngBytes()
    h.session.observe({ kind: 'tap', pos: { x: 0.1, y: 0.1 } })
    h.session.observe({ kind: 'tap', pos: { x: 0.2, y: 0.2 } })
    const doc = await h.session.finishAndBuild()
    const ids = doc.steps.map((s) => ('screenshotBlobId' in s ? s.screenshotBlobId : undefined))
    expect(ids[0]).toBeDefined()
    expect(ids[0]).toBe(ids[1])
  })
})

describe('createRecordingSession — bounds (plan 94\'s property 3: bounded, always)', () => {
  test('maxSteps ends the recording cleanly at the cap — never more, never a silent truncation with no reason', async () => {
    const h = harness({ maxSteps: 5 })
    for (let i = 0; i < 8; i++) h.session.observe({ kind: 'key', keycode: i })

    const doc = await h.session.finishAndBuild()
    expect(doc.steps).toHaveLength(5)
    expect(h.boundCalls).toEqual(['max-steps'])
    expect(h.session.stoppedReason).toBe('max-steps')
  })

  test('maxDurationSec ends the recording on its own, even with no further input at all', async () => {
    const h = harness({ maxDurationSec: 10 })
    h.session.observe({ kind: 'key', keycode: 1 })
    expect(h.boundCalls).toEqual([])

    h.clock.advance(10_000) // no observe() call in between — the duration timer alone must fire
    expect(h.boundCalls).toEqual(['max-duration'])
    expect(h.session.stoppedReason).toBe('max-duration')

    // Further input after a bound is a no-op — the step count never grows past the bound.
    h.session.observe({ kind: 'key', keycode: 2 })
    const doc = await h.session.finishAndBuild()
    expect(doc.steps).toHaveLength(1)
  })

  test('onBound fires exactly once even if both bounds could apply', async () => {
    const h = harness({ maxSteps: 1, maxDurationSec: 1 })
    h.session.observe({ kind: 'key', keycode: 1 }) // hits maxSteps immediately
    h.clock.advance(1_000) // would also hit maxDurationSec, but the session is already stopped
    expect(h.boundCalls).toEqual(['max-steps'])
  })
})

describe('createRecordingSession — finishAndBuild and cancel', () => {
  test('finishAndBuild is idempotent — a second call returns the SAME document', async () => {
    const h = harness()
    h.session.observe({ kind: 'key', keycode: 1 })
    const first = await h.session.finishAndBuild()
    const second = await h.session.finishAndBuild()
    expect(second).toBe(first)
  })

  test('observe() after finishAndBuild() is a no-op', async () => {
    const h = harness()
    h.session.observe({ kind: 'key', keycode: 1 })
    await h.session.finishAndBuild()
    h.session.observe({ kind: 'key', keycode: 2 })
    expect(h.session.stepCount).toBe(1)
  })

  test('cancel discards — stepCount drops to 0 and observe() no-ops afterward', () => {
    const h = harness()
    h.session.observe({ kind: 'key', keycode: 1 })
    h.session.observe({ kind: 'key', keycode: 2 })
    h.session.cancel()
    expect(h.session.stepCount).toBe(0)
    expect(h.session.stoppedReason).toBeNull() // cancel is never reported as a bound reason
    h.session.observe({ kind: 'key', keycode: 3 })
    expect(h.session.stepCount).toBe(0)
  })

  test('startedAt is unix SECONDS, matching RecordingDoc.recordedAt', async () => {
    const h = harness()
    h.session.observe({ kind: 'key', keycode: 1 })
    const doc = await h.session.finishAndBuild()
    expect(h.session.startedAt).toBe(0)
    expect(doc.recordedAt).toBe(h.session.startedAt)
  })

  test('sniffImageMediaType recognises the fixture PNG used throughout this file (sanity check on the fixture itself)', () => {
    expect(sniffImageMediaType(pngBytes())).toBe('image/png')
  })
})
