import { CODEC_ID } from './version'

/**
 * Parser stream video scrcpy (plan 08 §4.3).
 *
 * Byte order on the video socket (tunnel_forward mode).
 * verified against v3.3.1 server/src/main/java/com/genymobile/scrcpy/device/{DesktopConnection,Streamer}.java
 * on 2026-09-03:
 *   1. 1 dummy byte (tunnel_forward only) — marks the connection as valid
 *      (`DesktopConnection.open`'s `sendDummyByte`, written once on the
 *      first socket accepted: video, then audio if enabled, then control)
 *   2. 64 byte device name (NUL-padded) — `DEVICE_NAME_FIELD_LENGTH = 64`,
 *      `DesktopConnection.sendDeviceMeta`, also sent on the first socket only
 *   3. metadata codec: u32BE codecId, u32BE width, u32BE height —
 *      `Streamer.writeVideoHeader`, a plain `ByteBuffer` (big-endian by
 *      default)
 *   4. repeating: a 12-byte frame header plus payload —
 *      `Streamer.writeFrameMeta`/`writePacket`:
 *        - u64BE ptsAndFlags: bit63 = config packet (`PACKET_FLAG_CONFIG =
 *          1L << 63`), bit62 = keyframe (`PACKET_FLAG_KEY_FRAME = 1L << 62`),
 *          the rest is the PTS in microseconds — the server's raw MediaCodec
 *          `bufferInfo.presentationTimeUs` (`SurfaceEncoder.java`), NOT
 *          rebased to any stream-start origin. It is a monotonic clock on
 *          the device's own timeline with no defined relationship to the
 *          host's clock, which is exactly why `packages/session/src` and the
 *          browser estimator (plan 203 §3.2 D4) treat it with a min-anchored
 *          offset rather than as an absolute wall-clock value.
 *        - u32BE packetSize
 *        - H.264 Annex-B payload (SPS/PPS for the config packet)
 */

export const PTS_FLAG_CONFIG = 1n << 63n
export const PTS_FLAG_KEYFRAME = 1n << 62n
const PTS_MASK = (1n << 62n) - 1n

export interface VideoMeta {
  deviceName: string
  codec: 'h264' | 'h265' | 'av1'
  width: number
  height: number
}

export type ScrcpyPacket =
  | { kind: 'config'; receivedAt: number; data: Uint8Array }
  | { kind: 'keyframe'; ptsUs: bigint; receivedAt: number; data: Uint8Array }
  | { kind: 'frame'; ptsUs: bigint; receivedAt: number; data: Uint8Array }

const codecName = (id: number): VideoMeta['codec'] => {
  if (id === CODEC_ID.H265) return 'h265'
  if (id === CODEC_ID.AV1) return 'av1'
  return 'h264'
}

/**
 * Incremental demuxer: `push()` bytes straight from the socket and the
 * callback fires once a complete unit is available. It assumes nothing about
 * TCP chunk boundaries.
 */
export class VideoDemuxer {
  private buf = new Uint8Array(0)
  private stage: 'dummy' | 'name' | 'meta' | 'frames'
  private meta: VideoMeta | null = null

  constructor(
    private opts: {
      /** tunnel_forward sends one dummy byte up front. */
      expectDummyByte: boolean
      onMeta: (meta: VideoMeta) => void
      onPacket: (packet: ScrcpyPacket) => void
      /** Clock for `receivedAt`; tests inject one. Defaults to `Date.now`. */
      now?: () => number
    },
  ) {
    this.stage = opts.expectDummyByte ? 'dummy' : 'name'
  }

  getMeta(): VideoMeta | null {
    return this.meta
  }

  push(chunk: Uint8Array): void {
    const receivedAt = (this.opts.now ?? Date.now)()
    const merged = new Uint8Array(this.buf.length + chunk.length)
    merged.set(this.buf, 0)
    merged.set(chunk, this.buf.length)
    this.buf = merged
    this.drain(receivedAt)
  }

  private take(n: number): Uint8Array | null {
    if (this.buf.length < n) return null
    const head = this.buf.subarray(0, n)
    this.buf = this.buf.subarray(n)
    return head
  }

  private drain(receivedAt: number): void {
    for (;;) {
      if (this.stage === 'dummy') {
        if (!this.take(1)) return
        this.stage = 'name'
        continue
      }
      if (this.stage === 'name') {
        const raw = this.take(64)
        if (!raw) return
        const end = raw.indexOf(0)
        const deviceName = new TextDecoder().decode(end >= 0 ? raw.subarray(0, end) : raw)
        this.meta = { deviceName, codec: 'h264', width: 0, height: 0 }
        this.stage = 'meta'
        continue
      }
      if (this.stage === 'meta') {
        const raw = this.take(12)
        if (!raw) return
        const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength)
        this.meta = {
          deviceName: this.meta?.deviceName ?? '',
          codec: codecName(dv.getUint32(0, false)),
          width: dv.getUint32(4, false),
          height: dv.getUint32(8, false),
        }
        this.opts.onMeta(this.meta)
        this.stage = 'frames'
        continue
      }
      // stage 'frames'
      if (this.buf.length < 12) return
      const header = new DataView(this.buf.buffer, this.buf.byteOffset, 12)
      const ptsAndFlags = header.getBigUint64(0, false)
      const size = header.getUint32(8, false)
      if (this.buf.length < 12 + size) return
      this.buf = this.buf.subarray(12)
      const data = this.take(size)
      if (!data) return
      const copy = new Uint8Array(data) // detach from the shared buffer
      if ((ptsAndFlags & PTS_FLAG_CONFIG) !== 0n) {
        this.opts.onPacket({ kind: 'config', receivedAt, data: copy })
      } else {
        const ptsUs = ptsAndFlags & PTS_MASK
        this.opts.onPacket({
          kind: (ptsAndFlags & PTS_FLAG_KEYFRAME) !== 0n ? 'keyframe' : 'frame',
          ptsUs,
          receivedAt,
          data: copy,
        })
      }
    }
  }
}
