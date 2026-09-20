import { AdbSocket } from './socket'
import { DEFAULT_HANDSHAKE_TIMEOUT_MS, DEFAULT_TRACKER_REENUMERATION_GRACE_MS } from './timeouts'

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
  /**
   * The three descriptive `host:devices-l` fields — `product:`, `model:`,
   * `device:` — kept verbatim (owner, 2026-09-20, for the raw adb page).
   * adb itself omits all three for a transport that has not reached the
   * `device` state, so `undefined` is normal and means "adb did not say",
   * never "the phone has no model". Undefined from `host:track-devices`
   * for the same reason `usb`/`transportId` are (see `parseSnapshot`).
   */
  product?: string
  model?: string
  deviceCode?: string
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
  /**
   * `AdbClient.ensureServer` — tried once per dropped connection before the
   * backoff sleep (2026-09-17). Without it this loop reconnects against a
   * refused socket for ever and nothing in a running farm ever restarts the
   * adb server; see `ensureServer`'s own comment for the measured incident.
   * Optional so a test (and any other embedder) can leave it out.
   */
  ensureServer?: () => Promise<void>
  /**
   * How long after a RECONNECT removals are withheld — see
   * `DEFAULT_TRACKER_REENUMERATION_GRACE_MS` for why a reconnect's first
   * snapshot cannot be trusted to mean "these devices are gone". 0 restores
   * the pre-grace behaviour (every reconnect diffs immediately), which is
   * what the existing tests assert.
   */
  reenumerationGraceMs?: number
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
  /**
   * While `Date.now()` is below this, a serial missing from a snapshot is
   * treated as "not re-enumerated yet", not as "removed". Set on every
   * reconnect, never on the first connect — the initial snapshot of a server
   * that was already running IS authoritative.
   */
  private settleUntil = 0

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
    const settling = this.settleUntil > 0 && Date.now() < this.settleUntil
    let effective = next
    if (settling) {
      /*
        Carry forward every device the snapshot does not mention, at its last
        known state. Two things follow, and both are the point:

        - `diffSnapshots` sees no absentee, so it emits no `remove`.
        - `this.current` keeps the device, so when the window lapses the NEXT
          snapshot still diffs against a farm that includes it — a device that
          genuinely left is reported then, not silently forgotten.

        `add`/`change` are unaffected: a device that re-enumerates during the
        window is in `next` and diffs normally against its carried-forward
        entry, so a phone that came back `unauthorized` still says so at once.
      */
      const seen = new Set(next.map((d) => d.serial))
      const carried = this.current.filter((d) => !seen.has(d.serial))
      if (carried.length > 0) effective = [...next, ...carried]
    }
    const events = diffSnapshots(this.current, effective)
    this.current = effective
    for (const ev of events) {
      for (const cb of this.listeners) cb(ev)
    }
  }

  private async runLoop(): Promise<void> {
    let backoffMs = 1000
    /** Set by the catch below; cleared once the restart attempt has been made. */
    let serverMayBeDown = false
    /** The first connect of this loop is not a RE-connect — its snapshot is authoritative. */
    let reconnecting = false
    const graceMs = this.opts.reenumerationGraceMs ?? DEFAULT_TRACKER_REENUMERATION_GRACE_MS
    while (!this.stopped) {
      try {
        const socket = await AdbSocket.connect(this.opts.host, this.opts.port)
        this.socket = socket
        // Armed BEFORE the first snapshot of this connection is read: that
        // snapshot is the one a restarted adb server serves empty.
        this.settleUntil = reconnecting && graceMs > 0 ? Date.now() + graceMs : 0
        if (reconnecting && graceMs > 0) {
          this.opts.onLog?.(
            'debug',
            `track-devices reconnected — withholding removals for ${Math.round(graceMs / 1000)}s while adb re-enumerates`,
          )
        }
        reconnecting = true
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
        serverMayBeDown = true
      } finally {
        this.socket?.close()
        this.socket = null
      }
      if (this.stopped) return
      /*
        A dropped tracker usually means the adb server is gone, not that this
        one socket was unlucky — every other consumer is failing at the same
        moment. `ensureServer` connects first and only spawns `start-server`
        when the connection is actually refused, so this costs one socket on
        an adb that is merely busy, and repairs the farm when it is not there.

        Failure is swallowed on purpose: the backoff below is the retry, and a
        second error line per cycle would say nothing the first did not.
      */
      if (serverMayBeDown) {
        serverMayBeDown = false
        await this.opts.ensureServer?.().catch(() => {})
      }
      await Bun.sleep(backoffMs)
      backoffMs = Math.min(backoffMs * 2, 5000)
    }
  }
}
