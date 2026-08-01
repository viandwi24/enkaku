import type { DisplaySource, FrameMeta, Transport } from '@enkaku/protocol'
import { isPng, parsePngSize } from './png'

export interface ScreencapLoopConfig {
  /** Default 400ms → ~2,5 fps (rentang "~2–3 fps" spec §7.1). */
  intervalMs?: number
  onError?: (err: unknown) => void
  onLog?: (level: 'debug' | 'warn', msg: string) => void
}

/**
 * DisplaySource `screencap-loop` — MVP/fallback (spec §7.1), digantikan
 * scrcpy sebagai default di Plan 08. Loop serial per device: capture
 * berikutnya tidak dimulai sebelum yang sebelumnya selesai (tidak
 * menumpuk perintah di adb queue). Trade-off sadar: ~2–3 fps, latency
 * tinggi, PNG besar, CPU device per capture, tanpa audio.
 */
export class ScreencapLoop implements DisplaySource {
  readonly id = 'screencap-loop'
  private running = false
  private loopPromise: Promise<void> | null = null
  private cb: ((chunk: Uint8Array, meta: FrameMeta) => void) | null = null
  private seq = 0

  constructor(
    private transport: Transport,
    private config: ScreencapLoopConfig = {},
  ) {}

  onFrame(cb: (chunk: Uint8Array, meta: FrameMeta) => void): void {
    this.cb = cb
  }

  async start(): Promise<void> {
    if (this.running) return
    this.running = true
    this.loopPromise = this.runLoop()
  }

  async stop(): Promise<void> {
    this.running = false
    await this.loopPromise?.catch(() => {})
    this.loopPromise = null
  }

  private async runLoop(): Promise<void> {
    const intervalMs = this.config.intervalMs ?? 400
    const backoffs = [1000, 2000, 5000]
    let consecutiveFailures = 0

    while (this.running) {
      const t0 = Date.now()
      try {
        const png = await this.transport.execOut('screencap -p')
        consecutiveFailures = 0
        if (!isPng(png)) {
          this.config.onLog?.('warn', `frame korup dari ${this.transport.serial} (${png.length} byte) — skip`)
        } else {
          const { width, height } = parsePngSize(png)
          this.cb?.(png, { width, height, codec: 'png', seq: this.seq++, capturedAt: t0 })
        }
      } catch (err) {
        consecutiveFailures++
        if (consecutiveFailures >= 3) {
          this.config.onLog?.('warn', `screencap ${this.transport.serial} gagal ${consecutiveFailures}x — loop berhenti`)
          this.running = false
          this.config.onError?.(err)
          return
        }
        const backoff = backoffs[consecutiveFailures - 1] ?? 5000
        this.config.onLog?.('debug', `screencap gagal (${consecutiveFailures}x), retry dalam ${backoff}ms`)
        await Bun.sleep(backoff)
        continue
      }
      const elapsed = Date.now() - t0
      const wait = Math.max(0, intervalMs - elapsed)
      if (wait > 0) await Bun.sleep(wait)
    }
  }
}
