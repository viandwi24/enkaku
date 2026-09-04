import type { GestureSample, InputSink, Point } from '@enkaku/protocol'
import { SessionError } from './errors'
import type { Logger } from './logger'

/**
 * Plan 91 §3.3, §4.1 — the input arbiter. Fixes F6 (H1): the `InputSink` has
 * no serialisation of any kind, and every pointer action is a multi-write
 * sequence over one shared virtual pointer. Two overlapping callers
 * interleave on it — a down from one source between another's down and up —
 * which produces a phone that misbehaves, not a phone that is shared.
 *
 * Three independent FIFO lanes per device, not one per-device mutex: a
 * pointer gesture is stateful and must be atomic, but a keycode is not, and
 * blocking a volume-up press behind a 200-character `typeText` (16 seconds at
 * 80ms/char) would defeat the one example the owner gave for why this feature
 * exists.
 *
 * **No `onAction` callback here.** §4.1's original design sketched one — a
 * generic `{lane, source, verb, waitedMs, ranMs}` completion event, meant to
 * feed step 91.5's attribution work, a subordinate-grant mechanism plan 205
 * §3.2 item 8 deleted outright rather than renamed. `ws-handlers.ts`'s `input.*`
 * branch instead records the control marker directly, inline, at the same
 * call site that already knows the verb-specific payload (tap position,
 * swipe endpoints, redacted text) this arbiter's generic event never
 * carried. `SessionManagerDeps`/`CreateSessionDeps` briefly carried an `onAction`-style
 * field (`onInputAction`) with no production caller EVER wired to it and
 * nothing anywhere reading its output — a callback nobody produced and nobody
 * consumed, investigated and removed 2026-08-13
 * (`docs/plans/96-m61-hotfixes.md` §96.13). `stats()` below remains the one
 * real observability surface this arbiter exposes (`/api/adb/stats`'s `input`
 * block, plan 91 §4.10) — it samples `waitMs`/`depth`/`refusals` internally
 * and needs no external callback to do so.
 */
export type InputLane = 'pointer' | 'keys' | 'text'

/**
 * Who asked for this action. The `id` is the same id the activity registry
 * keys a marker on (`control:<clientId>`/`job:<jobId>`/`agent:<rootRunId>`,
 * plan 205 §4.2), so an arbiter record and an activity marker name the same
 * thing.
 */
export interface InputSource {
  kind: 'user' | 'job' | 'agent'
  id: string
  userId: string | null
}

export interface LaneStats {
  depth: number
  running: { source: InputSource; verb: string; sinceMs: number } | null
  waitMsP50: number
  waitMsP95: number
  refusals: number
}

export interface InputArbiter {
  /** An `InputSink` façade bound to one source. Every verb goes through the lane queue. */
  for(source: InputSource): InputSink
  stats(): Record<InputLane, LaneStats>
}

export interface CreateInputArbiterOpts {
  /** The bounded wait budget, in ms — read fresh on every submission, like every other farm setting. */
  queueWaitMs: () => number
  /** How many actions may be WAITING (not counting the one running) for one lane at once. */
  maxQueueDepth: () => number
  log: Logger
}

const LANES: readonly InputLane[] = ['pointer', 'keys', 'text']

/**
 * Non-preemptive priority (§3.3, §4.1, reworked by plan 205 §5 step 205.10):
 * a person (`user`) jumps every QUEUED `job`/`agent` action, but never
 * interrupts one already running — a human is there to drive, not to fight
 * something already in flight. `job` and `agent` share a priority: neither
 * preempts the other, FIFO decides between them.
 */
const PRIORITY_OF: Record<InputSource['kind'], number> = { user: 0, job: 1, agent: 1 }

/** Bounds each lane's wait-time sample buffer so `stats()` stays cheap forever on a long-lived session. */
const MAX_WAIT_SAMPLES = 500

interface QueueItem<T = unknown> {
  source: InputSource
  verb: string
  priority: number
  enqueuedAt: number
  run: () => Promise<T>
  resolve: (v: T) => void
  reject: (err: unknown) => void
  timer: ReturnType<typeof setTimeout> | null
}

interface LaneState {
  running: { source: InputSource; verb: string; sinceMs: number } | null
  queue: QueueItem[]
  waitSamples: number[]
  refusals: number
}

function percentile(samples: number[], p: number): number {
  if (samples.length === 0) return 0
  const sorted = [...samples].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length))
  return sorted[idx] ?? 0
}

function createLaneState(): LaneState {
  return { running: null, queue: [], waitSamples: [], refusals: 0 }
}

export function createInputArbiter(sink: InputSink, opts: CreateInputArbiterOpts): InputArbiter {
  const lanes: Record<InputLane, LaneState> = {
    pointer: createLaneState(),
    keys: createLaneState(),
    text: createLaneState(),
  }

  function recordWait(state: LaneState, ms: number): void {
    state.waitSamples.push(ms)
    if (state.waitSamples.length > MAX_WAIT_SAMPLES) state.waitSamples.shift()
  }

  /** Names the blocking action, for both the depth-cap refusal and the wait-budget refusal (step 91.1's own requirement: neither refusal may be anonymous). */
  function describeBlocker(state: LaneState): string {
    const r = state.running
    if (!r) return 'another action on this device'
    return `the ${r.source.kind}'s ${r.verb} is still running`
  }

  function runNow(lane: InputLane, item: QueueItem): void {
    const state = lanes[lane]
    const waitedMs = Date.now() - item.enqueuedAt
    recordWait(state, waitedMs)
    state.running = { source: item.source, verb: item.verb, sinceMs: Date.now() }
    item
      .run()
      .then(
        (result) => {
          state.running = null
          item.resolve(result)
        },
        (err: unknown) => {
          state.running = null
          item.reject(err)
        },
      )
      .finally(() => advance(lane))
  }

  function advance(lane: InputLane): void {
    const state = lanes[lane]
    if (state.running) return
    const next = state.queue.shift()
    if (!next) return
    if (next.timer) clearTimeout(next.timer)
    next.timer = null
    runNow(lane, next)
  }

  /** Stable priority insert: ahead of every already-queued item with a strictly lower priority number, behind everything else — so equal-priority items stay FIFO. */
  function insertSorted(queue: QueueItem[], item: QueueItem): void {
    const idx = queue.findIndex((q) => q.priority > item.priority)
    if (idx === -1) queue.push(item)
    else queue.splice(idx, 0, item)
  }

  function submit<T>(lane: InputLane, source: InputSource, verb: string, action: () => Promise<T>): Promise<T> {
    const state = lanes[lane]
    return new Promise<T>((resolve, reject) => {
      const item: QueueItem<T> = {
        source,
        verb,
        priority: PRIORITY_OF[source.kind],
        enqueuedAt: Date.now(),
        run: action,
        resolve,
        reject,
        timer: null,
      }
      if (!state.running) {
        runNow(lane, item as QueueItem)
        return
      }
      // Bounded, and it says so (§3.3): `maxQueueDepth` caps how many actions
      // may be WAITING, not the one currently running — the depth check is
      // therefore only ever reached while `state.running` is set, so the
      // refusal can always name it.
      if (state.queue.length >= opts.maxQueueDepth()) {
        state.refusals++
        const message = `${describeBlocker(state)}, and the queue for this device is already full (${state.queue.length} action${state.queue.length === 1 ? '' : 's'} waiting)`
        opts.log.debug(`input arbiter: refusing ${verb} on ${lane} lane — ${message}`)
        reject(new SessionError('E_INPUT_BUSY', message))
        return
      }
      insertSorted(state.queue, item as QueueItem)
      const budgetMs = opts.queueWaitMs()
      item.timer = setTimeout(() => {
        const idx = state.queue.indexOf(item as QueueItem)
        if (idx === -1) return // already dequeued to run — the timer lost the race harmlessly
        state.queue.splice(idx, 1)
        state.refusals++
        const waitedS = ((Date.now() - item.enqueuedAt) / 1000).toFixed(1)
        const message = `${describeBlocker(state)} (waited ${waitedS} s)`
        opts.log.debug(`input arbiter: refusing ${verb} on ${lane} lane — ${message}`)
        item.reject(new SessionError('E_INPUT_BUSY', message))
      }, budgetMs)
    })
  }

  function forSource(source: InputSource): InputSink {
    const facade: InputSink = {
      id: sink.id,
      mode: sink.mode,
      tap: (p: Point, tapOpts) => submit('pointer', source, 'tap', () => sink.tap(p, tapOpts)),
      swipe: (from: Point, to: Point, ms: number) => submit('pointer', source, 'swipe', () => sink.swipe(from, to, ms)),
      key: (code: number) => submit('keys', source, 'key', () => sink.key(code)),
      text: (s: string) => submit('text', source, 'text', () => sink.text(s)),
    }
    // Honest-absence contract (matches `InputSink.gesture`/`typeText` themselves):
    // the façade exposes these ONLY when the underlying engine does, so a
    // caller's existing `if (session.input.gesture)` check keeps working
    // unchanged against `session.arbiter.for(source)`.
    if (sink.gesture) {
      const gestureFn = sink.gesture.bind(sink)
      facade.gesture = (samples: GestureSample[]) => submit('pointer', source, 'gesture', () => gestureFn(samples))
    }
    if (sink.typeText) {
      const typeTextFn = sink.typeText.bind(sink)
      facade.typeText = (text: string, textOpts) => submit('text', source, 'typeText', () => typeTextFn(text, textOpts))
    }
    // Plan 209 §4.8: key events on the `keys` lane (they must not queue
    // behind a pointer drag's landing sleep); scroll, pinch and touch on
    // `pointer` (the same lane a tap/swipe/gesture already uses, so a touch
    // stream and a scripted swipe never interleave on one contact).
    if (sink.touch) {
      const f = sink.touch.bind(sink)
      facade.touch = (a, p, id) => submit('pointer', source, 'touch', () => f(a, p, id))
    }
    if (sink.scroll) {
      const f = sink.scroll.bind(sink)
      facade.scroll = (p, h, v) => submit('pointer', source, 'scroll', () => f(p, h, v))
    }
    if (sink.pinch) {
      const f = sink.pinch.bind(sink)
      facade.pinch = (o) => submit('pointer', source, 'pinch', () => f(o))
    }
    if (sink.keyDown) {
      const f = sink.keyDown.bind(sink)
      facade.keyDown = (k, m) => submit('keys', source, 'keyDown', () => f(k, m))
    }
    if (sink.keyUp) {
      const f = sink.keyUp.bind(sink)
      facade.keyUp = (k, m) => submit('keys', source, 'keyUp', () => f(k, m))
    }
    if (sink.releaseKeys) {
      const f = sink.releaseKeys.bind(sink)
      facade.releaseKeys = () => submit('keys', source, 'releaseKeys', () => f())
    }
    if (sink.prepareKeyboard) {
      const f = sink.prepareKeyboard.bind(sink)
      facade.prepareKeyboard = () => submit('keys', source, 'prepareKeyboard', () => f())
    }
    return facade
  }

  function stats(): Record<InputLane, LaneStats> {
    const result = {} as Record<InputLane, LaneStats>
    for (const lane of LANES) {
      const state = lanes[lane]
      result[lane] = {
        depth: state.queue.length,
        running: state.running,
        waitMsP50: percentile(state.waitSamples, 0.5),
        waitMsP95: percentile(state.waitSamples, 0.95),
        refusals: state.refusals,
      }
    }
    return result
  }

  return { for: forSource, stats }
}
