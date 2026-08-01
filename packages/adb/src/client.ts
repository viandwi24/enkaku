import { AdbError } from './errors'
import { PerDeviceQueue, Semaphore } from './queue'
import { AdbSocket } from './socket'
import { DeviceTracker } from './tracker'

export interface AdbClientOptions {
  /** Path binary adb — dari resolveToolPath('adb'); client TIDAK baca env sendiri. */
  adbPath: string
  host?: string
  port?: number
  /** Semaphore global (spec §10.4: "longgar 6–8"). Default 6, clamp 1..8. */
  maxConcurrent?: number
  onLog?: (level: 'debug' | 'warn', msg: string) => void
}

/**
 * Client tipis ke adb server via smartsocket (127.0.0.1:5037).
 * Satu-satunya spawn CLI yang diizinkan: `adb start-server` saat koneksi
 * ditolak. `adb kill-server` DILARANG di seluruh codebase (spec §10.4) —
 * satu-satunya pengecualian kelak: Toolchain Manager saat swap versi adb.
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

  /** Connect ke adb server; kalau belum jalan → spawn `adb start-server` + retry. */
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
            `adb server tidak bisa dihubungi di ${this.host}:${this.port} setelah ${maxAttempts} percobaan`,
            err,
          )
        }
        this.onLog?.('debug', `adb server belum jalan, mencoba start-server (attempt ${attempt})`)
        const proc = Bun.spawn([this.adbPath, 'start-server'], { stdout: 'ignore', stderr: 'ignore' })
        await proc.exited
        await Bun.sleep(500 * attempt)
      }
    }
  }

  /** host:version → string versi (hex) dari adb server. */
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
   * Shell one-shot per device: koneksi baru → host:transport:<serial> →
   * shell:<cmd> → baca sampai socket ditutup. Selalu lewat per-device queue
   * + semaphore — tidak ada jalur pintas.
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

  /** Jumlah task antri untuk satu serial (debugging). */
  pending(serial: string): number {
    return this.queue.pending(serial)
  }

  /**
   * Dipakai Toolchain Manager saat swap versi adb (plan 02 §4.11):
   * pause → waitIdle (drain) → [kill/start-server di core] → resume.
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

  /** Ganti binary adb setelah swap versi (path baru dari Toolchain Manager). */
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
