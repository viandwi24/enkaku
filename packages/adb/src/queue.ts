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
  /** Gate pause: task baru menunggu di sini saat queue di-pause (adb swap). */
  private gate: Promise<void> = Promise.resolve()
  private openGate: (() => void) | null = null
  /** Jumlah task yang benar-benar sedang eksekusi (untuk drain). */
  private inFlight = 0
  private idleWaiters: Array<() => void> = []

  constructor(private sem: Semaphore) {}

  /** Stop menerima eksekusi task baru (task antri tetap antri). */
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

  /** Resolve saat tidak ada task in-flight (dipanggil setelah pause()). */
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
      .catch(() => {}) // error task sebelumnya tidak menular ke task berikut
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
