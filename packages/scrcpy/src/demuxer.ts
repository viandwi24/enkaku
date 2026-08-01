import { CODEC_ID } from './version'

/**
 * Parser stream video scrcpy (plan 08 §4.3).
 *
 * Urutan byte pada socket video (mode tunnel_forward, TODO-verify terhadap
 * source versi pinned):
 *   1. 1 byte dummy (hanya saat tunnel_forward) — penanda koneksi valid
 *   2. 64 byte device name (NUL-padded)
 *   3. metadata codec: u32BE codecId, u32BE width, u32BE height
 *   4. berulang: frame header 12 byte + payload
 *        - u64BE ptsAndFlags: bit63 = config packet, bit62 = keyframe,
 *          sisanya PTS mikrodetik
 *        - u32BE packetSize
 *        - payload H.264 Annex-B (SPS/PPS untuk config packet)
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
  | { kind: 'config'; data: Uint8Array }
  | { kind: 'keyframe'; ptsUs: bigint; data: Uint8Array }
  | { kind: 'frame'; ptsUs: bigint; data: Uint8Array }

const codecName = (id: number): VideoMeta['codec'] => {
  if (id === CODEC_ID.H265) return 'h265'
  if (id === CODEC_ID.AV1) return 'av1'
  return 'h264'
}

/**
 * Demuxer inkremental: `push()` byte apa adanya dari socket, callback
 * dipanggil saat unit lengkap tersedia. Tidak mengasumsikan batas chunk TCP.
 */
export class VideoDemuxer {
  private buf = new Uint8Array(0)
  private stage: 'dummy' | 'name' | 'meta' | 'frames'
  private meta: VideoMeta | null = null

  constructor(
    private opts: {
      /** tunnel_forward mengirim 1 byte dummy di awal. */
      expectDummyByte: boolean
      onMeta: (meta: VideoMeta) => void
      onPacket: (packet: ScrcpyPacket) => void
    },
  ) {
    this.stage = opts.expectDummyByte ? 'dummy' : 'name'
  }

  getMeta(): VideoMeta | null {
    return this.meta
  }

  push(chunk: Uint8Array): void {
    const merged = new Uint8Array(this.buf.length + chunk.length)
    merged.set(this.buf, 0)
    merged.set(chunk, this.buf.length)
    this.buf = merged
    this.drain()
  }

  private take(n: number): Uint8Array | null {
    if (this.buf.length < n) return null
    const head = this.buf.subarray(0, n)
    this.buf = this.buf.subarray(n)
    return head
  }

  private drain(): void {
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
      const copy = new Uint8Array(data) // lepas dari buffer bersama
      if ((ptsAndFlags & PTS_FLAG_CONFIG) !== 0n) {
        this.opts.onPacket({ kind: 'config', data: copy })
      } else {
        const ptsUs = ptsAndFlags & PTS_MASK
        this.opts.onPacket({
          kind: (ptsAndFlags & PTS_FLAG_KEYFRAME) !== 0n ? 'keyframe' : 'frame',
          ptsUs,
          data: copy,
        })
      }
    }
  }
}
