import { SessionError } from './errors'

export interface PortAllocatorOptions {
  /** Default 27100–27299 (env ENKAKU_UI_SERVER_PORT_RANGE). */
  rangeStart: number
  rangeEnd: number
}

/**
 * Alokasi port host untuk `adb forward` per device (plan 06 §4.3).
 * Satu instance singleton di core; claim/release hanya dari session manager.
 */
export class PortAllocator {
  private inUse = new Map<number, string>()

  constructor(private opts: PortAllocatorOptions) {}

  /** Port bebas di registry DAN benar-benar bebas di OS (bind-test). */
  async claim(deviceId: string): Promise<number> {
    for (let port = this.opts.rangeStart; port <= this.opts.rangeEnd; port++) {
      if (this.inUse.has(port)) continue
      if (!(await isPortFree(port))) continue
      this.inUse.set(port, deviceId)
      return port
    }
    throw new SessionError(
      'port_range_exhausted',
      `tidak ada port bebas di ${this.opts.rangeStart}–${this.opts.rangeEnd}`,
    )
  }

  /** Idempotent — dipanggil saat session release & crash-recovery boot. */
  release(port: number): void {
    this.inUse.delete(port)
  }

  releaseDevice(deviceId: string): void {
    for (const [port, owner] of [...this.inUse]) {
      if (owner === deviceId) this.inUse.delete(port)
    }
  }

  snapshot(): ReadonlyMap<number, string> {
    return new Map(this.inUse)
  }
}

async function isPortFree(port: number): Promise<boolean> {
  try {
    const server = Bun.listen({
      hostname: '127.0.0.1',
      port,
      socket: { data() {} },
    })
    server.stop(true)
    return true
  } catch {
    return false
  }
}

export function parsePortRange(raw: string | undefined): { rangeStart: number; rangeEnd: number } {
  const fallback = { rangeStart: 27100, rangeEnd: 27299 }
  if (!raw) return fallback
  const m = /^(\d+)-(\d+)$/.exec(raw.trim())
  if (!m) return fallback
  const start = Number.parseInt(m[1]!, 10)
  const end = Number.parseInt(m[2]!, 10)
  return end > start ? { rangeStart: start, rangeEnd: end } : fallback
}
