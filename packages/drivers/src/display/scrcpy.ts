import type { DisplaySource, FrameMeta } from '@enkaku/protocol'
import type { ScrcpySession } from '@enkaku/scrcpy'

/**
 * The `scrcpy` DisplaySource (spec §7.1): H.264 is encoded ON THE PHONE by MediaCodec,
 * the host only relays — far more efficient and far lower latency than
 * screencap-loop (PNG per frame).
 *
 * The config packet (SPS/PPS) is cached: the browser decoder needs it to
 * initialise, and again to re-initialise on rotation.
 */
export class ScrcpyDisplay implements DisplaySource {
  readonly id = 'scrcpy'
  private cb: ((chunk: Uint8Array, meta: FrameMeta) => void) | null = null
  private seq = 0
  private lastConfig: Uint8Array | null = null
  private lastKeyframe: Uint8Array | null = null
  private width = 0
  private height = 0
  private started = false

  constructor(private session: ScrcpySession) {}

  /** The last config packet — resent to a new viewer ahead of the keyframe. */
  get configPacket(): Uint8Array | null {
    return this.lastConfig
  }

  /**
   * The most recent IDR frame.
   *
   * A viewer that joins between two keyframes has nothing to decode: the config
   * packet alone only configures, it does not paint. The encoder's IDR interval
   * is measured in seconds, so without this the screen stays black for that long
   * — the exact symptom of a stream that looks live but shows nothing.
   */
  get keyframePacket(): Uint8Array | null {
    return this.lastKeyframe
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
      // Rotation or resize: new dimensions, and the browser decoder must re-init.
      this.width = m.width
      this.height = m.height
    })
    this.session.onPacket((packet) => {
      if (packet.kind === 'config') {
        this.lastConfig = packet.data
      } else if (packet.kind === 'keyframe') {
        this.lastKeyframe = packet.data
      }
      this.cb?.(packet.data, {
        width: this.width,
        height: this.height,
        codec: 'h264',
        seq: this.seq++,
        ptsUs: packet.kind === 'config' ? 0n : packet.ptsUs,
        hostReceivedAt: packet.receivedAt,
        // Config (SPS/PPS) and IDR frames are the only points a decoder can
        // join at; everything else is a delta it cannot make sense of alone.
        keyframe: packet.kind !== 'frame',
      })
    })
  }

  async stop(): Promise<void> {
    this.started = false
    await this.session.close()
  }
}
