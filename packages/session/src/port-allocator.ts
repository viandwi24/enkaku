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

/**
 * A bind test on loopback: bind the port, close it again, and report whether
 * the bind succeeded (plan 06 §4.3; plan 109 §3.3, R5).
 *
 * **Exported because plan 109 lends it to a plugin** as `ctx.isPortFree`. The
 * core does not allocate, reserve or arbitrate a plugin's port — §3.3 is the
 * owner's ruling that collisions are the plugin's own problem — but a plugin
 * should not have to write this badly, twelve times, so it borrows the one
 * that already exists rather than getting a second implementation.
 *
 * **Read what it does and does not tell you.** It binds `127.0.0.1`, so:
 *
 * - a listener on `0.0.0.0` is detected (the loopback bind collides with it);
 * - a listener bound only to some OTHER interface is **not**, and this answers
 *   `true` for a port that is genuinely in use there;
 * - the answer is a snapshot. Between `isPortFree(p)` and your own `listen(p)`
 *   anything on the machine may take it, so a plugin still has to handle the
 *   bind throwing. This is advice, never a reservation.
 */
export async function isPortFree(port: number, proto: 'tcp' | 'udp' = 'tcp'): Promise<boolean> {
  if (proto === 'udp') {
    try {
      const socket = await Bun.udpSocket({ hostname: '127.0.0.1', port })
      socket.close()
      return true
    } catch {
      return false
    }
  }
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
