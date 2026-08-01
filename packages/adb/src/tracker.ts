import { AdbSocket } from './socket'

export type AdbDeviceState = 'device' | 'offline' | 'unauthorized' | 'authorizing' | (string & {})

export interface TrackedDevice {
  serial: string
  state: AdbDeviceState
}

export type TrackerEvent =
  | { kind: 'add'; serial: string; state: AdbDeviceState }
  | { kind: 'remove'; serial: string }
  | { kind: 'change'; serial: string; state: AdbDeviceState }

/** Parse snapshot `host:track-devices`: baris "<serial>\t<state>\n". */
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

/** Diff snapshot lama vs baru → events add/change/remove. */
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
  /** Dipanggil untuk log internal (reconnect dsb) — injeksi dari core. */
  onLog?: (level: 'debug' | 'warn', msg: string) => void
}

/**
 * Koneksi dedicated `host:track-devices` — adb server push snapshot tiap
 * perubahan (realtime, tanpa polling). Auto-reconnect dengan backoff saat
 * socket putus; setelah reconnect, snapshot baru di-diff terhadap snapshot
 * lama sehingga device yang hilang selama putus tetap menghasilkan `remove`.
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
        await socket.readStatus()
        backoffMs = 1000
        // Stream tanpa akhir: tiap perubahan = satu blok snapshot.
        while (!this.stopped) {
          const raw = await socket.readBlock()
          this.emitFromSnapshot(parseSnapshot(raw))
        }
      } catch (err) {
        if (this.stopped) return
        this.opts.onLog?.('warn', `track-devices putus, reconnect dalam ${backoffMs}ms: ${String(err)}`)
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
