import type { DisplaySource, FrameMeta } from '@enkaku/protocol'
import type { ScrcpySession } from '@enkaku/scrcpy'

/**
 * DisplaySource `scrcpy` (spec §7.1): H.264 di-encode DI HP oleh MediaCodec,
 * host hanya relay — jauh lebih efisien dan rendah latency dibanding
 * screencap-loop (PNG per frame).
 *
 * Config packet (SPS/PPS) di-cache: dibutuhkan untuk init decoder browser
 * dan re-init saat rotasi.
 */
export class ScrcpyDisplay implements DisplaySource {
  readonly id = 'scrcpy'
  private cb: ((chunk: Uint8Array, meta: FrameMeta) => void) | null = null
  private seq = 0
  private lastConfig: Uint8Array | null = null
  private width = 0
  private height = 0
  private started = false

  constructor(private session: ScrcpySession) {}

  /** Config packet terakhir — dikirim ulang ke viewer baru sebelum keyframe. */
  get configPacket(): Uint8Array | null {
    return this.lastConfig
  }

  get size(): { width: number; height: number } {
    return { width: this.width, height: this.height }
  }

  onFrame(cb: (chunk: Uint8Array, meta: FrameMeta) => void): void {
    this.cb = cb
  }

  async start(): Promise<void> {
    if (this.started) return
    this.started = true
    const meta = this.session.meta
    if (meta) {
      this.width = meta.width
      this.height = meta.height
    }
    this.session.onMetaChange((m) => {
      // Rotasi/resize: dimensi baru + decoder browser wajib re-init.
      this.width = m.width
      this.height = m.height
    })
    this.session.onPacket((packet) => {
      if (packet.kind === 'config') {
        this.lastConfig = packet.data
      }
      this.cb?.(packet.data, {
        width: this.width,
        height: this.height,
        codec: 'h264',
        seq: this.seq++,
        capturedAt: Date.now(),
      })
    })
  }

  async stop(): Promise<void> {
    this.started = false
    await this.session.close()
  }
}
