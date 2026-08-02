import { SessionError } from './errors'

export interface PortAllocatorOptions {
  /** Default 27100–27299 (env ENKAKU_UI_SERVER_PORT_RANGE). */
  rangeStart: number
  rangeEnd: number
}

/**
 * Allocates host ports for per-device `adb forward` (plan 06 §4.3).
 * A single instance in the core; only the session manager claims and releases.
 */
export class PortAllocator {
  private inUse = new Map<number, string>()

  constructor(private opts: PortAllocatorOptions) {}

  /** Free in the registry AND genuinely free on the OS (bind-tested). */
  async claim(deviceId: string): Promise<number> {
    for (let port = this.opts.rangeStart; port <= this.opts.rangeEnd; port++) {
      if (this.inUse.has(port)) continue
      if (!(await isPortFree(port))) continue
      this.inUse.set(port, deviceId)
      return port
    }
    throw new SessionError(
      'port_range_exhausted',
      `no free port in ${this.opts.rangeStart}–${this.opts.rangeEnd}`,
    )
  }

  /** Idempotent — called on session release and during crash-recovery boot. */
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
