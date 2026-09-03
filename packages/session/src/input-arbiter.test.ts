import { describe, expect, test } from 'bun:test'
import type { GestureSample, InputSink, Point } from '@enkaku/protocol'
import { createInputArbiter, type InputSource } from './input-arbiter'
import type { Logger } from './logger'

/** Same `silentLog` pattern `farm-tag.test.ts`/`orientation.test.ts` already use in this package. */
function silentLog(): { log: Logger; debugs: string[] } {
  const debugs: string[] = []
  const log: Logger = {
    debug: (msg) => debugs.push(msg),
    info: () => {},
    warn: () => {},
    error: () => {},
    child: () => log,
  }
  return { log, debugs }
}

/**
 * A fake `InputSink` that records every write in order, with an optional
 * artificial hold so a test can force two actions to overlap in real time —
 * `x` doubles as a per-call tag (`down:1`/`up:1`) so the log can name WHICH
 * call produced which write, without needing to thread the `InputSource`
 * through the raw sink (the raw sink genuinely has no idea who is calling it
 * — that is exactly F6, the defect this file exists to prove is fixed).
 */
function fakeSink(opts?: { tapMs?: number; swipeMs?: number }): { sink: InputSink; log: string[] } {
  const log: string[] = []
  const tapMs = opts?.tapMs ?? 0
  const swipeMs = opts?.swipeMs ?? 0
  const sink: InputSink = {
    id: 'fake',
    mode: 'uhid',
    tap: async (p: Point) => {
      log.push(`down:${p.x}`)
      if (tapMs > 0) await Bun.sleep(tapMs)
      log.push(`up:${p.x}`)
    },
    swipe: async (_from: Point, _to: Point, _ms: number) => {
      log.push('swipe:start')
      if (swipeMs > 0) await Bun.sleep(swipeMs)
      log.push('swipe:end')
    },
    key: async (code: number) => {
      log.push(`key:${code}`)
    },
    text: async (s: string) => {
      log.push(`text:${s}`)
    },
  }
  return { sink, log }
}

const user = (id: string): InputSource => ({ kind: 'user', id, userId: null })
const job = (id: string): InputSource => ({ kind: 'job', id, userId: null })

describe('createInputArbiter — the pointer lane never interleaves two sources (fixes F6, tests H1)', () => {
  test('two concurrent taps from different sources run one at a time — down and up are never interleaved', async () => {
    const { sink, log } = fakeSink({ tapMs: 15 })
    const arbiter = createInputArbiter(sink, { queueWaitMs: () => 5_000, maxQueueDepth: () => 32, log: silentLog().log })
    const a = arbiter.for(user('client-a'))
    const b = arbiter.for(user('client-b'))

    // Submitted back-to-back, deliberately not awaited individually: this is
    // exactly the "two overlapping callers" shape F6 describes. `a`'s tap
    // claims the pointer lane synchronously (idle → runs immediately), so
    // `b`'s tap — submitted a tick later, lane already busy — is forced to
    // queue, whatever real-time race might otherwise occur.
    const pA = a.tap({ x: 1, y: 0 })
    const pB = b.tap({ x: 2, y: 0 })
    await Promise.all([pA, pB])

    // The property that matters most: a down from one source never lands
    // between another source's down and up.
    expect(log).toEqual(['down:1', 'up:1', 'down:2', 'up:2'])
  })

  test('a key submitted during a running swipe runs immediately — the lane split is the whole point', async () => {
    const { sink, log } = fakeSink({ swipeMs: 250 })
    const arbiter = createInputArbiter(sink, { queueWaitMs: () => 5_000, maxQueueDepth: () => 32, log: silentLog().log })
    const src = arbiter.for(job('job-1'))

    const swipeDone = src.swipe({ x: 0, y: 0 }, { x: 1, y: 1 }, 250)
    const startedAt = Date.now()
    await src.key(26) // KEYCODE_POWER, arbitrarily
    const elapsedMs = Date.now() - startedAt

    // Not queued behind the swipe (which is still running, ~250ms from now):
    // a key on its own lane costs the caller nothing.
    expect(elapsedMs).toBeLessThan(100)
    expect(log[0]).toBe('swipe:start')
    expect(log).toContain('key:26')
    // The swipe has genuinely not finished yet — proof the key ran
    // CONCURRENTLY with it, not merely "fast".
    expect(log).not.toContain('swipe:end')

    await swipeDone
    expect(log.indexOf('key:26')).toBeLessThan(log.indexOf('swipe:end'))
  })
})

describe('createInputArbiter — non-preemptive priority (user > job = agent, §3.3, §4.1, plan 205 §5 step 205.10)', () => {
  test('a user tap jumps a QUEUED job tap, but never interrupts a RUNNING one', async () => {
    const { sink, log } = fakeSink({ tapMs: 20 })
    const arbiter = createInputArbiter(sink, { queueWaitMs: () => 5_000, maxQueueDepth: () => 32, log: silentLog().log })
    const jobSrc = arbiter.for(job('job-1'))
    const userSrc = arbiter.for(user('op-1'))

    // job tap #1 claims the lane (idle → runs immediately).
    const jobTap1 = jobSrc.tap({ x: 1, y: 0 })
    // job tap #2 queues behind it.
    const jobTap2 = jobSrc.tap({ x: 2, y: 0 })
    // The user tap arrives after both are already submitted, while job
    // tap #1 is RUNNING — it must wait for job tap #1 to finish (never
    // preempt), but then jump ahead of the already-QUEUED job tap #2.
    const userTap = userSrc.tap({ x: 3, y: 0 })

    await Promise.all([jobTap1, jobTap2, userTap])

    // job #1 completes as an atomic down/up pair before the user tap starts
    // at all (non-preemptive); the user tap then completes atomically
    // before job #2 runs (priority jump over a queued, lower-priority action).
    expect(log).toEqual(['down:1', 'up:1', 'down:3', 'up:3', 'down:2', 'up:2'])
  })
})

describe('createInputArbiter — bounded, and it says so (§3.3)', () => {
  test('the depth cap refuses immediately, naming the blocking action', async () => {
    const { sink } = fakeSink({ tapMs: 40 })
    const arbiter = createInputArbiter(sink, { queueWaitMs: () => 5_000, maxQueueDepth: () => 1, log: silentLog().log })
    const src = arbiter.for(job('job-1'))

    const blocker = src.tap({ x: 1, y: 0 }) // runs immediately, occupies the lane
    const queued = src.tap({ x: 2, y: 0 }) // fills the ONE allowed queue slot

    const startedAt = Date.now()
    let caught: unknown
    try {
      await src.tap({ x: 3, y: 0 }) // depth cap already full — must refuse right away
    } catch (err) {
      caught = err
    }
    const elapsedMs = Date.now() - startedAt

    expect(caught).toBeInstanceOf(Error)
    const err = caught as { code?: string; message?: string }
    expect(err.code).toBe('E_INPUT_BUSY')
    // Names the blocker — never an anonymous refusal.
    expect(err.message).toContain("job's tap is still running")
    // Refused right away, not after waiting out the (generous) wait budget.
    expect(elapsedMs).toBeLessThan(30)

    await Promise.all([blocker, queued])
  })

  test('the wait budget refuses once exceeded, naming the blocker and how long it waited', async () => {
    const { sink } = fakeSink({ tapMs: 200 })
    const arbiter = createInputArbiter(sink, { queueWaitMs: () => 30, maxQueueDepth: () => 32, log: silentLog().log })
    const src = arbiter.for(job('job-1'))

    const blocker = src.tap({ x: 1, y: 0 }) // holds the lane for 200ms

    let caught: unknown
    try {
      await src.tap({ x: 2, y: 0 }) // waits 30ms, blocker still running → refused
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(Error)
    const err = caught as { code?: string; message?: string }
    expect(err.code).toBe('E_INPUT_BUSY')
    expect(err.message).toContain("job's tap is still running")
    expect(err.message).toMatch(/waited [\d.]+ s/)

    await blocker
  })
})

describe('createInputArbiter — stats()', () => {
  test('reports per-lane depth, running, refusals, and wait percentiles', async () => {
    const { sink } = fakeSink({ tapMs: 10 })
    const arbiter = createInputArbiter(sink, { queueWaitMs: () => 5_000, maxQueueDepth: () => 32, log: silentLog().log })
    const src = arbiter.for(job('job-1'))

    // Five taps fired together: the first runs with ~0 wait, each
    // subsequent one waits a little longer for its predecessors — a real
    // spread for p50/p95 to be computed over, not a single sample.
    await Promise.all([1, 2, 3, 4, 5].map((x) => src.tap({ x, y: 0 })))

    const stats = arbiter.stats()
    expect(stats.pointer.refusals).toBe(0)
    expect(stats.pointer.depth).toBe(0) // the queue drained once every tap settled
    expect(stats.pointer.running).toBeNull() // nothing left running
    expect(stats.pointer.waitMsP50).toBeGreaterThanOrEqual(0)
    expect(stats.pointer.waitMsP95).toBeGreaterThanOrEqual(stats.pointer.waitMsP50)
    // The five queued/serialised taps produced measurable wait for the
    // later ones — proof `waitMsP95` is reading real samples, not a
    // hardcoded 0.
    expect(stats.pointer.waitMsP95).toBeGreaterThan(0)

    // Untouched lanes report cleanly rather than throwing on missing data.
    expect(stats.keys).toEqual({ depth: 0, running: null, waitMsP50: 0, waitMsP95: 0, refusals: 0 })
    expect(stats.text).toEqual({ depth: 0, running: null, waitMsP50: 0, waitMsP95: 0, refusals: 0 })
  })

  test('a refusal counts, on the lane it happened on, and no other', async () => {
    const { sink } = fakeSink({ tapMs: 40 })
    const arbiter = createInputArbiter(sink, { queueWaitMs: () => 5_000, maxQueueDepth: () => 0, log: silentLog().log })
    const src = arbiter.for(job('job-1'))

    const blocker = src.tap({ x: 1, y: 0 })
    await expect(src.tap({ x: 2, y: 0 })).rejects.toMatchObject({ code: 'E_INPUT_BUSY' })

    const stats = arbiter.stats()
    expect(stats.pointer.refusals).toBe(1)
    expect(stats.keys.refusals).toBe(0)
    expect(stats.text.refusals).toBe(0)

    await blocker
  })
})

describe('createInputArbiter — the façade only exposes gesture/typeText when the underlying engine does (honest absence)', () => {
  test('gesture and typeText are present on the façade only when present on the raw sink', () => {
    const { sink } = fakeSink()
    const arbiter = createInputArbiter(sink, { queueWaitMs: () => 5_000, maxQueueDepth: () => 32, log: silentLog().log })
    const facade = arbiter.for(job('job-1'))
    expect(facade.gesture).toBeUndefined()
    expect(facade.typeText).toBeUndefined()

    const richSink: InputSink = {
      ...sink,
      gesture: async (_samples: GestureSample[]) => {},
      typeText: async (_text: string, _opts: { perCharMs: [number, number] }) => {},
    }
    const richArbiter = createInputArbiter(richSink, { queueWaitMs: () => 5_000, maxQueueDepth: () => 32, log: silentLog().log })
    const richFacade = richArbiter.for(job('job-1'))
    expect(richFacade.gesture).toBeInstanceOf(Function)
    expect(richFacade.typeText).toBeInstanceOf(Function)
  })
})

/**
 * `onAction` (a generic `{lane, source, verb, waitedMs, ranMs}` completion
 * event) used to exist here, sketched by §4.1 to feed step 91.5's attribution
 * work. 91.5 shipped a different mechanism instead — `ws-handlers.ts`'s
 * `input.*` branch records attribution directly, inline, at the call site
 * that already knows the verb-specific payload this arbiter's generic event
 * never carried — and nothing else ever wired a producer or a consumer to
 * `onAction`. Removed 2026-08-13 as dead code (`docs/plans/96-m61-hotfixes.md`
 * §96.13); this comment stays so nobody re-adds an unconsumed seam under the
 * same name without reading why it was cut.
 */
