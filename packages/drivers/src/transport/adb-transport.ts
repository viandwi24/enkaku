import { ADB_TIMEOUTS, type AdbClient, type AdbExecOptions, type AdbTimeoutProfile } from '@enkaku/adb'
import type { ShellResult, Transport, TransportExecOptions } from '@enkaku/protocol'

export interface AdbTransportOpts {
  client: AdbClient
  serial: string
  stableId: string
}

/** A profile is only forwarded to AdbClient when it names one of ADB_TIMEOUTS's own keys. */
function toAdbProfile(profile: string | undefined): AdbTimeoutProfile | undefined {
  if (profile === undefined) return undefined
  return profile in ADB_TIMEOUTS ? (profile as AdbTimeoutProfile) : undefined
}

function toAdbExecOptions(opts: TransportExecOptions | undefined): AdbExecOptions | undefined {
  if (!opts) return undefined
  return {
    profile: toAdbProfile(opts.profile),
    timeoutMs: opts.timeoutMs,
    queueTimeoutMs: opts.queueTimeoutMs,
    maxOutputBytes: opts.maxOutputBytes,
    signal: opts.signal,
  }
}

/**
 * The `adb-usb` transport: a thin wrapper over @enkaku/adb — every command
 * goes through the Plan 01 per-device queue and semaphore, with the adb binary
 * coming from the Toolchain.
 * It NEVER calls `adb kill-server` (spec §10.4).
 */
export class AdbUsbTransport implements Transport {
  readonly id: string = 'adb-usb'
  readonly serial: string
  readonly stableId: string
  protected client: AdbClient

  constructor(opts: AdbTransportOpts) {
    this.client = opts.client
    this.serial = opts.serial
    this.stableId = opts.stableId
  }

  async connect(): Promise<void> {
    // no-op: keberadaan device diverifikasi track-devices (registry).
  }

  async disconnect(): Promise<void> {
    // no-op for USB.
  }

  exec(cmd: string, opts?: TransportExecOptions): Promise<ShellResult> {
    return this.client.exec(this.serial, cmd, toAdbExecOptions(opts))
  }

  execOut(cmd: string, opts?: TransportExecOptions): Promise<Uint8Array> {
    return this.client.execOut(this.serial, cmd, toAdbExecOptions(opts))
  }
}

/** Transport `adb-tcp` (wireless / OTG / redroid) — see the two methods below for what changed under plan 88 §3.7 and why. */
export class AdbTcpTransport extends AdbUsbTransport {
  override readonly id = 'adb-tcp'

  /**
   * Ensure-connected, not connect (plan 88 §3.7, §5 step 88.1). A session
   * starting on a device adb already lists as `device` must not re-dial —
   * `host:connect` on an address that is already up is at best redundant
   * and, on a queued device, unnecessary contention. Only when adb does NOT
   * already have it does this fall back to a direct dial, exactly as
   * `connect()` always did. Step 88.2 replaces that fallback with the full
   * reconnect ladder (remembered addresses, then an optional sweep,
   * `packages/core/src/registry/reconnect.ts`) — this ensure-connected shape
   * is the seam it slots into; nothing here needs to change again for that.
   */
  override async connect(): Promise<void> {
    const known = await this.client.listDevices()
    const alreadyUp = known.some((d) => d.serial === this.serial && d.state === 'device')
    if (alreadyUp) return
    // serial adb-tcp = "host:port"
    await this.client.connectDevice(this.serial)
  }

  /**
   * A documented no-op (plan 88 §3.7, fixes F12/H6). This used to issue
   * `host:disconnect`, which drops the device's adb transport for the WHOLE
   * farm, not just the caller's session — closing one Studio wall tile
   * silently kicked a wireless (or OTG) phone off adb entirely, and it was
   * not always recoverable from Studio afterwards (H6). Transport lifetime
   * is the registry's and the operator's explicit action now (plan 88 §4.6),
   * never a session's — a session ending must never mean "the farm loses
   * this device". `DeviceSession.close()` still calls this
   * (`packages/session/src/session.ts`) for interface symmetry with a
   * future transport that DOES have session-scoped state to release; adb-tcp
   * itself has none, so the call lands here and does nothing.
   */
  override async disconnect(): Promise<void> {
    // Intentionally empty — see the doc comment above.
  }
}
