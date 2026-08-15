import { AdbSocket } from './socket'
import { DEFAULT_HANDSHAKE_TIMEOUT_MS } from './timeouts'

export type AdbDeviceState = 'device' | 'offline' | 'unauthorized' | 'authorizing' | (string & {})

export interface TrackedDevice {
  serial: string
  state: AdbDeviceState
  /**
   * The `usb:` field `host:devices-l` carries for a USB transport (plan 88
   * §3.1, fixes F6) — e.g. `3-1.4.3`. Undefined for a TCP transport and for
   * every `host:track-devices` snapshot (`parseSnapshot` below does not
   * carry it — see that function's own comment).
   */
  usb?: string
  /** The `transport_id:` field `host:devices-l` carries (plan 88 §3.1, fixes F6). Undefined from `host:track-devices` (see `parseSnapshot`). */
  transportId?: number
}

export type TrackerEvent =
  | { kind: 'add'; serial: string; state: AdbDeviceState }
  | { kind: 'remove'; serial: string }
  | { kind: 'change'; serial: string; state: AdbDeviceState }

/**
 * Parse a `host:track-devices` snapshot: lines of "<serial>\t<state>\n".
 *
 * Deliberately untouched by plan 88 §3.1/§5 step 88.1: unlike `host:devices-l`
 * (`client.ts`'s `parseDevicesLongBlock`), this format carries no `usb:` or
 * `transport_id:` field to keep — it is two tab-separated columns, full stop.
 * `TrackedDevice.usb`/`.transportId` are always undefined on anything this
 * function produces.
 */
export function parseSnapshot(raw: string): TrackedDevice[] {
  const out: TrackedDevice[] = []
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const [serial, state] = trimmed.split('\t')
    if (!serial || !state) continue
    out.push({ serial, state })
  }
  return out
}

/** Diff the old snapshot against the new one → add/change/remove events. */
export function diffSnapshots(prev: TrackedDevice[], next: TrackedDevice[]): TrackerEvent[] {
  const events: TrackerEvent[] = []
  const prevMap = new Map(prev.map((d) => [d.serial, d.state]))
  const nextMap = new Map(next.map((d) => [d.serial, d.state]))
  for (const [serial, state] of nextMap) {
    const old = prevMap.get(serial)
    if (old === undefined) events.push({ kind: 'add', serial, state })
    else if (old !== state) events.push({ kind: 'change', serial, state })
  }
  for (const serial of prevMap.keys()) {
    if (!nextMap.has(serial)) events.push({ kind: 'remove', serial })
  }
  return events
}

export interface DeviceTrackerOptions {
  host: string
  port: number
  /** Called for internal logging (reconnects and so on) — injected by the core. */
  onLog?: (level: 'debug' | 'warn', msg: string) => void
}

/**
 * A dedicated `host:track-devices` connection — the adb server pushes a snapshot on
 * on every change (realtime, no polling). Auto-reconnects with backoff when
 * the socket drops; after reconnecting the new snapshot is diffed against the
 * old one, so a device lost during the outage still produces a `remove`.
 */
export class DeviceTracker {
  private listeners = new Set<(ev: TrackerEvent) => void>()
  private current: TrackedDevice[] = []
  private socket: AdbSocket | null = null
  private stopped = true
  private loopPromise: Promise<void> | null = null

  constructor(private opts: DeviceTrackerOptions) {}

  on(cb: (ev: TrackerEvent) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  snapshot(): TrackedDevice[] {
    return [...this.current]
  }

  async start(): Promise<void> {
    if (!this.stopped) return
    this.stopped = false
    this.loopPromise = this.runLoop()
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.socket?.close()
    this.socket = null
    await this.loopPromise?.catch(() => {})
    this.loopPromise = null
  }

  private emitFromSnapshot(next: TrackedDevice[]): void {
    const events = diffSnapshots(this.current, next)
    this.current = next
    for (const ev of events) {
      for (const cb of this.listeners) cb(ev)
    }
  }

  private async runLoop(): Promise<void> {
    let backoffMs = 1000
    while (!this.stopped) {
      try {
        const socket = await AdbSocket.connect(this.opts.host, this.opts.port)
        this.socket = socket
        socket.send('host:track-devices')
        // A real handshake — the adb server should ack this immediately.
        await socket.readStatus({ timeoutMs: DEFAULT_HANDSHAKE_TIMEOUT_MS })
        backoffMs = 1000
        // An endless stream: every change arrives as one snapshot block, and
        // there can legitimately be no change for a long time. Deliberately
        // no timeoutMs here — this loop is bounded by stop() calling
        // socket.close(), not by a deadline (plan 22.1 is about one-shot
        // exec(); this pre-existing long-lived connection is out of scope).
        while (!this.stopped) {
          const raw = await socket.readBlock()
          this.emitFromSnapshot(parseSnapshot(raw))
        }
      } catch (err) {
        if (this.stopped) return
        this.opts.onLog?.('warn', `track-devices dropped, reconnecting in ${backoffMs}ms: ${String(err)}`)
      } finally {
        this.socket?.close()
        this.socket = null
      }
      if (this.stopped) return
      await Bun.sleep(backoffMs)
      backoffMs = Math.min(backoffMs * 2, 5000)
    }
  }
}
