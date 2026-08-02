import { AdbError } from './errors'
import { DEFAULT_MAX_QUEUE_DEPTH, DEFAULT_QUEUE_TIMEOUT_MS } from './timeouts'

/**
 * Serialising adb access (spec §10.4): a per-device queue plus a loose global
 * cap — NOT a single mutex. Every exec must pass through here.
 */
export class Semaphore {
  private inFlight_ = 0
  private waiters: Array<() => void> = []
  private maxValue: number

  constructor(max: number) {
    if (max < 1) throw new Error('Semaphore max must be >= 1')
    this.maxValue = max
  }

  async acquire(): Promise<() => void> {
    if (this.inFlight_ < this.maxValue) {
      this.inFlight_++
      return this.releaser()
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve))
    this.inFlight_++
    return this.releaser()
  }

  private releaser(): () => void {
    let released = false
    return () => {
      if (released) return
      released = true
      this.inFlight_--
      const next = this.waiters.shift()
      if (next) next()
    }
  }

  /**
   * Resize the cap at runtime (plan 23 §4.2 — the autoscaler and the
   * `adb.maxConcurrent` farm setting both go through this):
   *
   * - Raising it wakes queued waiters immediately, up to the new capacity.
   *   Waking a waiter here does not touch `inFlight_` itself — that still
   *   happens in the waiter's own `acquire()` continuation once its promise
   *   resolves (a later microtask), exactly like a normal `release()`
   *   hand-off. So capacity during this loop is tracked with a local
   *   counter rather than re-reading `inFlight_`, which will not reflect
   *   these wake-ups until each continuation actually runs.
   * - Lowering it never revokes a slot already held — a holder keeps
   *   running to completion; the smaller cap only constrains the NEXT
   *   `acquire()` onward.
   */
  resize(max: number): void {
    if (max < 1) throw new Error('Semaphore max must be >= 1')
    this.maxValue = max
    let projected = this.inFlight_
    while (projected < this.maxValue && this.waiters.length > 0) {
      projected++
      const next = this.waiters.shift()
      next?.()
    }
  }

  get max(): number {
    return this.maxValue
  }

  get inFlight(): number {
    return this.inFlight_
  }

  get waiting(): number {
    return this.waiters.length
  }
}

export interface QueueRunOptions {
  /** How long the task may wait for its turn before E_ADB_BUSY. Default 30_000ms. */
  queueTimeoutMs?: number
  signal?: AbortSignal
  /** Rejects with E_ADB_BUSY when the chain for this serial is already this deep. Default 32. */
  maxDepth?: number
}

export class PerDeviceQueue {
  /** One promise chain per serial; the entry is cleared when its chain empties. */
  private chains = new Map<string, { tail: Promise<unknown>; pending: number }>()
  /** Pause gate: new tasks wait here while the queue is paused (adb swap). */
  private gate: Promise<void> = Promise.resolve()
  private openGate: (() => void) | null = null
  /** How many tasks are actually executing (used by drain). */
  private inFlight = 0
  private idleWaiters: Array<() => void> = []

  constructor(private sem: Semaphore) {}

  /** Stop starting new tasks (queued ones stay queued). */
  pause(): void {
    if (this.openGate) return
    this.gate = new Promise((resolve) => {
      this.openGate = resolve
    })
  }

  resume(): void {
    this.openGate?.()
    this.openGate = null
  }

  /** Resolves once nothing is in flight (called after pause()). */
  waitIdle(timeoutMs: number): Promise<boolean> {
    if (this.inFlight === 0) return Promise.resolve(true)
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs)
      this.idleWaiters.push(() => {
        clearTimeout(timer)
        resolve(true)
      })
    })
  }

  run<T>(serial: string, task: () => Promise<T>, opts?: QueueRunOptions): Promise<T> {
    const maxDepth = opts?.maxDepth ?? DEFAULT_MAX_QUEUE_DEPTH
    const entry = this.chains.get(serial) ?? { tail: Promise.resolve(), pending: 0 }
    if (entry.pending >= maxDepth) {
      // Reject before ever touching the chain: nothing is accepted that we
      // do not intend to run (plan 22.1 §4.5.1).
      return Promise.reject(
        new AdbError('E_ADB_BUSY', `the queue for ${serial} is already at its depth cap (${maxDepth})`),
      )
    }
    entry.pending++
    this.chains.set(serial, entry)

    const queueTimeoutMs = opts?.queueTimeoutMs ?? DEFAULT_QUEUE_TIMEOUT_MS
    const signal = opts?.signal

    // The wait budget starts NOW, at enqueue — not when this task's turn in
    // the chain comes up. A task stuck behind many others must be able to
    // time out WHILE it waits, so the caller-facing promise below races an
    // early "give up" signal against the chain itself, instead of only being
    // checked once the chain's `.then()` continuation finally runs (plan
    // 22.1 §4.5.2).
    let started = false
    let gaveUpWith: unknown = null
    let notifyGiveUp: ((err: unknown) => void) | null = null
    const giveUpPromise = new Promise<never>((_, reject) => {
      notifyGiveUp = reject
    })
    // Only observed by Promise.race below when it fires before the task
    // starts; otherwise it is left pending and must not surface as an
    // unhandled rejection.
    giveUpPromise.catch(() => {})
    const giveUp = (err: unknown) => {
      if (started || gaveUpWith !== null) return
      gaveUpWith = err
      notifyGiveUp?.(err)
    }

    const queueTimer = setTimeout(() => {
      giveUp(new AdbError('E_ADB_BUSY', `queued longer than ${queueTimeoutMs}ms on ${serial}`))
    }, queueTimeoutMs)
    const onAbort = () => giveUp(new AdbError('E_ADB_ABORTED', 'aborted while queued'))
    if (signal) {
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }
    const clearQueueWatchers = () => {
      clearTimeout(queueTimer)
      if (signal) signal.removeEventListener('abort', onAbort)
    }

    const chainRun = entry.tail
      .catch(() => {}) // a failed task must not poison the next one
      .then(async () => {
        await this.gate // paused queues hold everyone here, timed-out or not
        if (gaveUpWith !== null) {
          clearQueueWatchers()
          throw gaveUpWith
        }
        started = true
        clearQueueWatchers()

        const release = await this.sem.acquire()
        this.inFlight++
        try {
          return await task()
        } finally {
          this.inFlight--
          if (this.inFlight === 0) {
            for (const w of this.idleWaiters.splice(0)) w()
          }
          release()
        }
      })
    entry.tail = chainRun.catch(() => {}).then(() => {
      entry.pending--
      if (entry.pending === 0) this.chains.delete(serial)
    })
    // Whichever settles first wins: the queued task itself, or giving up on
    // it before it ever got its turn. `entry.tail` above always follows
    // `chainRun`, not this race, so FIFO ordering for later tasks on the
    // same serial is unaffected by an early give-up.
    return Promise.race([giveUpPromise, chainRun]) as Promise<T>
  }

  pending(serial: string): number {
    return this.chains.get(serial)?.pending ?? 0
  }
}
