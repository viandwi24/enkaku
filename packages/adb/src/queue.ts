/**
 * Serialisasi akses adb (spec §10.4): per-device queue + semaphore global
 * longgar — BUKAN mutex tunggal. Semua exec wajib lewat sini.
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
  /** Chain promise per serial; entry dibersihkan saat chain kosong. */
  private chains = new Map<string, { tail: Promise<unknown>; pending: number }>()

  constructor(private sem: Semaphore) {}

  run<T>(serial: string, task: () => Promise<T>): Promise<T> {
    const entry = this.chains.get(serial) ?? { tail: Promise.resolve(), pending: 0 }
    entry.pending++
    const result = entry.tail
      .catch(() => {}) // error task sebelumnya tidak menular ke task berikut
      .then(async () => {
        const release = await this.sem.acquire()
        try {
          return await task()
        } finally {
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
