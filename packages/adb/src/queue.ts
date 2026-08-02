/**
 * Serialising adb access (spec §10.4): a per-device queue plus a loose global
 * cap — NOT a single mutex. Every exec must pass through here.
 */
export class Semaphore {
  private inFlight = 0
  private waiters: Array<() => void> = []

  constructor(private max: number) {
    if (max < 1) throw new Error('Semaphore max must be >= 1')
  }

  async acquire(): Promise<() => void> {
    if (this.inFlight < this.max) {
      this.inFlight++
      return this.releaser()
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve))
    this.inFlight++
    return this.releaser()
  }

  private releaser(): () => void {
    let released = false
    return () => {
      if (released) return
      released = true
      this.inFlight--
      const next = this.waiters.shift()
      if (next) next()
    }
  }
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

  run<T>(serial: string, task: () => Promise<T>): Promise<T> {
    const entry = this.chains.get(serial) ?? { tail: Promise.resolve(), pending: 0 }
    entry.pending++
    const result = entry.tail
      .catch(() => {}) // a failed task must not poison the next one
      .then(async () => {
        await this.gate
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
    entry.tail = result.catch(() => {}).then(() => {
      entry.pending--
      if (entry.pending === 0) this.chains.delete(serial)
    })
    this.chains.set(serial, entry)
    return result
  }

  pending(serial: string): number {
    return this.chains.get(serial)?.pending ?? 0
  }
}
