import type { AdbClient } from '@enkaku/adb'
import type { Transport } from '@enkaku/protocol'

export interface AdbTransportOpts {
  client: AdbClient
  serial: string
  stableId: string
}

/**
 * Transport `adb-usb`: wrapper tipis di atas @enkaku/adb — semua perintah
 * lewat per-device queue + semaphore Plan 01, binary adb dari Toolchain.
 * TIDAK pernah memanggil `adb kill-server` (spec §10.4).
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
    // no-op untuk USB.
  }

  exec(cmd: string): Promise<string> {
    return this.client.exec(this.serial, cmd)
  }

  execOut(cmd: string): Promise<Uint8Array> {
    return this.client.execOut(this.serial, cmd)
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
