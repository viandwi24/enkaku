import { ADB_TIMEOUTS, type AdbClient, type AdbExecOptions, type AdbTimeoutProfile } from '@enkaku/adb'
import type { Transport, TransportExecOptions } from '@enkaku/protocol'

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

  exec(cmd: string, opts?: TransportExecOptions): Promise<string> {
    return this.client.exec(this.serial, cmd, toAdbExecOptions(opts))
  }

  execOut(cmd: string, opts?: TransportExecOptions): Promise<Uint8Array> {
    return this.client.execOut(this.serial, cmd, toAdbExecOptions(opts))
  }
}

/** Transport `adb-tcp` (wireless / redroid): connect/disconnect eksplisit. */
export class AdbTcpTransport extends AdbUsbTransport {
  override readonly id = 'adb-tcp'

  override async connect(): Promise<void> {
    // serial adb-tcp = "host:port"
    await this.client.connectDevice(this.serial)
  }

  override async disconnect(): Promise<void> {
    await this.client.disconnectDevice(this.serial)
  }
}
