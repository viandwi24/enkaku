import type { DisplaySource, FrameMeta, Transport } from '@enkaku/protocol'
import { isPng, parsePngSize } from './png'

export interface ScreencapLoopConfig {
  /** Default 400ms → ~2,5 fps (rentang "~2–3 fps" spec §7.1). */
  intervalMs?: number
  onError?: (err: unknown) => void
  onLog?: (level: 'debug' | 'warn', msg: string) => void
}

/**
 * The `screencap-loop` DisplaySource — MVP and fallback (spec §7.1), superseded
 * scrcpy as the default in Plan 08. A serial loop per device: a capture
 * the next capture never starts before the previous one finishes (no
 * piling commands up in the adb queue). A conscious trade-off: ~2–3 fps, high
 * latency, large PNGs, device CPU per capture, and no audio.
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
          this.config.onLog?.('warn', `corrupt frame from ${this.transport.serial} (${png.length} bytes) — skipping`)
        } else {
          const { width, height } = parsePngSize(png)
          this.cb?.(png, { width, height, codec: 'png', seq: this.seq++, capturedAt: t0 })
        }
      } catch (err) {
        consecutiveFailures++
        if (consecutiveFailures >= 3) {
          this.config.onLog?.('warn', `screencap on ${this.transport.serial} failed ${consecutiveFailures}× — stopping the loop`)
          this.running = false
          this.config.onError?.(err)
          return
        }
        const backoff = backoffs[consecutiveFailures - 1] ?? 5000
        this.config.onLog?.('debug', `screencap failed (${consecutiveFailures}×), retrying in ${backoff}ms`)
        await Bun.sleep(backoff)
        continue
      }
      const elapsed = Date.now() - t0
      const wait = Math.max(0, intervalMs - elapsed)
      if (wait > 0) await Bun.sleep(wait)
    }
  }
}
