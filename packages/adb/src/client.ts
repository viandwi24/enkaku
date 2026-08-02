import { AdbError } from './errors'
import { PerDeviceQueue, Semaphore } from './queue'
import { AdbSocket } from './socket'
import { DeviceTracker } from './tracker'

export interface AdbClientOptions {
  /** Path to the adb binary — from resolveToolPath('adb'); the client NEVER reads env itself. */
  adbPath: string
  host?: string
  port?: number
  /** Semaphore global (spec §10.4: "longgar 6–8"). Default 6, clamp 1..8. */
  maxConcurrent?: number
  onLog?: (level: 'debug' | 'warn', msg: string) => void
}

/**
 * A thin client for the adb server over its smartsocket (127.0.0.1:5037).
 * The only CLI spawn allowed here is `adb start-server` when the connection
 * is refused. `adb kill-server` is FORBIDDEN across the codebase (spec §10.4)
 * — the single exception is the Toolchain Manager swapping adb versions.
 */
export class AdbClient {
  private host: string
  private port: number
  private adbPath: string
  private queue: PerDeviceQueue
  private tracker: DeviceTracker | null = null
  private onLog?: (level: 'debug' | 'warn', msg: string) => void

  constructor(opts: AdbClientOptions) {
    this.adbPath = opts.adbPath
    this.host = opts.host ?? '127.0.0.1'
    this.port = opts.port ?? 5037
    const max = Math.min(8, Math.max(1, opts.maxConcurrent ?? 6))
    this.queue = new PerDeviceQueue(new Semaphore(max))
    this.onLog = opts.onLog
  }

  /** Connect to the adb server; if it is not running, spawn `adb start-server` and retry. */
  async ensureServer(): Promise<void> {
    const maxAttempts = 3
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const socket = await AdbSocket.connect(this.host, this.port)
        socket.close()
        return
      } catch (err) {
        if (attempt === maxAttempts) {
          throw new AdbError(
            'E_ADB_UNAVAILABLE',
            `could not reach the adb server at ${this.host}:${this.port} after ${maxAttempts} attempts`,
            err,
          )
        }
        this.onLog?.('debug', `adb server is not running, trying start-server (attempt ${attempt})`)
        const proc = Bun.spawn([this.adbPath, 'start-server'], { stdout: 'ignore', stderr: 'ignore' })
        await proc.exited
        await Bun.sleep(500 * attempt)
      }
    }
  }

  /** host:version → the adb server's version string (hex). */
  async version(): Promise<string> {
    const socket = await AdbSocket.connect(this.host, this.port)
    try {
      socket.send('host:version')
      await socket.readStatus()
      return await socket.readBlock()
    } finally {
      socket.close()
    }
  }

  /**
   * One-shot shell per device: new connection → host:transport:<serial> →
   * shell:<cmd> → read until the socket closes. Always through the per-device queue
   * plus the semaphore — there is no shortcut around it.
   */
  exec(serial: string, cmd: string): Promise<string> {
    return this.queue.run(serial, async () => {
      const socket = await AdbSocket.connect(this.host, this.port)
      try {
        socket.send(`host:transport:${serial}`)
        await socket.readStatus()
        socket.send(`shell:${cmd}`)
        await socket.readStatus()
        const raw = await socket.readUntilClose()
        return new TextDecoder().decode(raw).trim()
      } finally {
        socket.close()
      }
    })
  }

  /** Like exec, but returns raw binary stdout (screencap and friends) via exec-out. */
  execOut(serial: string, cmd: string): Promise<Uint8Array> {
    return this.queue.run(serial, async () => {
      const socket = await AdbSocket.connect(this.host, this.port)
      try {
        socket.send(`host:transport:${serial}`)
        await socket.readStatus()
        socket.send(`exec:${cmd}`)
        await socket.readStatus()
        return await socket.readUntilClose()
      } finally {
        socket.close()
      }
    })
  }

  /** `adb connect <host:port>` via host service (wireless / adb-tcp). */
  async connectDevice(hostPort: string): Promise<string> {
    const socket = await AdbSocket.connect(this.host, this.port)
    try {
      socket.send(`host:connect:${hostPort}`)
      await socket.readStatus()
      return await socket.readBlock()
    } finally {
      socket.close()
    }
  }

  /** `adb disconnect <host:port>` via host service. */
  async disconnectDevice(hostPort: string): Promise<string> {
    const socket = await AdbSocket.connect(this.host, this.port)
    try {
      socket.send(`host:disconnect:${hostPort}`)
      await socket.readStatus()
      return await socket.readBlock()
    } finally {
      socket.close()
    }
  }

  /** Path to the active adb binary (for the few CLI spawns needed, e.g. `adb pair`). */
  get binaryPath(): string {
    return this.adbPath
  }

  /** Number of queued tasks for one serial (debugging aid). */
  pending(serial: string): number {
    return this.queue.pending(serial)
  }

  /**
   * Used by the Toolchain Manager when swapping adb versions (plan 02 §4.11):
   * pause → waitIdle (drain) → [kill/start-server in the core] → resume.
   */
  pauseQueue(): void {
    this.queue.pause()
  }

  resumeQueue(): void {
    this.queue.resume()
  }

  waitQueueIdle(timeoutMs: number): Promise<boolean> {
    return this.queue.waitIdle(timeoutMs)
  }

  /** Point at a new adb binary after a version swap (path from the Toolchain Manager). */
  setAdbPath(path: string): void {
    this.adbPath = path
  }

  trackDevices(): DeviceTracker {
    if (!this.tracker) {
      this.tracker = new DeviceTracker({ host: this.host, port: this.port, onLog: this.onLog })
    }
    return this.tracker
  }

  async dispose(): Promise<void> {
    await this.tracker?.stop()
    this.tracker = null
  }
}
