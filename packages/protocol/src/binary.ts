import type { FrameMeta } from './driver'

/**
 * WS binary framing (plan 03 §4.8) — applies to EVERY binary stream,
 * scrcpy in Plan 08 included. Bytes 0–1 NEVER change meaning:
 *
 *   byte 0    : u8  channel  — 0x01 VIDEO, 0x02 AUDIO (P08), 0x03 CONTROL (P08), 0x04 SNAPSHOT (P56)
 *   byte 1    : u8  streamId — allocated by the core at stream.started (VIDEO/AUDIO/CONTROL)
 *   byte 2..  : payload per (channel, codec)
 *
 * Payload VIDEO codec PNG (M2), extended by plan 203 §4.2:
 *   byte 2    : u8 codec (0x01 PNG; 0x02 H264 from Plan 08)
 *   byte 3..4 : u16BE width
 *   byte 5..6 : u16BE height
 *   byte 7..10: u32BE seq
 *   byte 11..18: u64BE ptsUs          device PTS, microseconds; 0 = no device clock
 *   byte 19..26: u64BE hostReceivedAt unix milliseconds at host parse time
 *   byte 27.. : data PNG utuh (or the H.264 Annex-B access unit)
 *
 * Byte 2 carries the codec in its low bits and VIDEO_FLAG_KEYFRAME (0x80) in
 * its high bit. A decoder must be handed a keyframe first — WebCodecs rejects
 * anything else right after `configure()` — so the receiver has to be able to
 * tell one from the other. PNG frames are all keyframes and set it too.
 *
 * Payload SNAPSHOT (plan 56 §3.8) — the Inspect tab's dump screenshot,
 * always PNG. Byte 1 here is NOT a `stream.started` streamId; it carries the
 * `requestId` from the `inspect.dump` message this frame answers, so the
 * client can pair it with the `inspect.tree` reply that names `snapshot: true`.
 *
 *   byte 1    : u8 requestId (`inspect.dump`'s payload.requestId)
 *   byte 2..  : data PNG utuh
 */
export const CHANNEL = { VIDEO: 0x01, AUDIO: 0x02, CONTROL: 0x03, SNAPSHOT: 0x04 } as const
export const VIDEO_CODEC = { PNG: 0x01, H264: 0x02 } as const
export const VIDEO_FLAG_KEYFRAME = 0x80

const VIDEO_HEADER_LEN = 27

export function encodeVideoFrame(streamId: number, meta: FrameMeta, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(VIDEO_HEADER_LEN + data.length)
  const dv = new DataView(out.buffer)
  dv.setUint8(0, CHANNEL.VIDEO)
  dv.setUint8(1, streamId & 0xff)
  const codec = meta.codec === 'png' ? VIDEO_CODEC.PNG : VIDEO_CODEC.H264
  const isKeyframe = meta.keyframe ?? meta.codec === 'png'
  dv.setUint8(2, codec | (isKeyframe ? VIDEO_FLAG_KEYFRAME : 0))
  dv.setUint16(3, meta.width, false)
  dv.setUint16(5, meta.height, false)
  dv.setUint32(7, meta.seq >>> 0, false)
  dv.setBigUint64(11, meta.ptsUs, false)
  dv.setBigUint64(19, BigInt(Math.max(0, Math.floor(meta.hostReceivedAt))), false)
  out.set(data, VIDEO_HEADER_LEN)
  return out
}

/**
 * Whether an Annex-B H.264 chunk can start a decode, judged from the bitstream.
 *
 * Frames relayed from a node arrive as bare bytes — the tunnel carries no
 * frame metadata — so the flag has to be recovered here rather than trusted.
 * An SPS (type 7) or IDR (type 5) is a valid entry point; anything else is a
 * delta.
 */
export function isH264Keyframe(buf: Uint8Array): boolean {
  for (let i = 0; i + 4 < buf.length; i++) {
    const startCode3 = buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 1
    const startCode4 = buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 0 && buf[i + 3] === 1
    if (!startCode3 && !startCode4) continue
    const type = (buf[i + (startCode4 ? 4 : 3)] ?? 0) & 0x1f
    if (type === 5 || type === 7) return true
    i += startCode4 ? 4 : 3
  }
  return false
}

const SNAPSHOT_HEADER_LEN = 2

/** Encodes a dump screenshot for `CHANNEL.SNAPSHOT` (plan 56 §3.8) — always PNG, no width/height/seq: `inspect.tree`'s own `frameSize` already carries the geometry. */
export function encodeSnapshot(requestId: number, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(SNAPSHOT_HEADER_LEN + data.length)
  out[0] = CHANNEL.SNAPSHOT
  out[1] = requestId & 0xff
  out.set(data, SNAPSHOT_HEADER_LEN)
  return out
}

export interface DecodedSnapshot {
  requestId: number
  data: Uint8Array
}

export function decodeSnapshot(buf: Uint8Array): DecodedSnapshot {
  if (buf.length < SNAPSHOT_HEADER_LEN) throw new Error(`snapshot frame too short: ${buf.length} bytes`)
  const channel = buf[0]
  if (channel !== CHANNEL.SNAPSHOT) throw new Error(`channel is not SNAPSHOT: 0x${(channel ?? 0).toString(16)}`)
  return { requestId: buf[1] ?? 0, data: buf.subarray(SNAPSHOT_HEADER_LEN) }
}

export interface DecodedVideoFrame {
  channel: number
  streamId: number
  codec: number
  width: number
  height: number
  seq: number
  /** True for a PNG frame, an H.264 config packet (SPS/PPS), or an IDR. */
  keyframe: boolean
  /** Device PTS in microseconds; `0n` when the source had no device clock (see `FrameMeta.ptsUs`). */
  ptsUs: bigint
  /** Unix milliseconds at host parse time (see `FrameMeta.hostReceivedAt`). */
  hostReceivedAt: number
  data: Uint8Array
}

export function decodeVideoFrame(buf: Uint8Array): DecodedVideoFrame {
  if (buf.length < VIDEO_HEADER_LEN) throw new Error(`frame too short: ${buf.length} bytes`)
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const channel = dv.getUint8(0)
  if (channel !== CHANNEL.VIDEO) throw new Error(`channel is not VIDEO: 0x${channel.toString(16)}`)
  const codecByte = dv.getUint8(2)
  const codec = codecByte & ~VIDEO_FLAG_KEYFRAME
  if (codec !== VIDEO_CODEC.PNG && codec !== VIDEO_CODEC.H264) {
    throw new Error(`unknown codec: 0x${codec.toString(16)}`)
  }
  return {
    channel,
    streamId: dv.getUint8(1),
    codec,
    width: dv.getUint16(3, false),
    height: dv.getUint16(5, false),
    seq: dv.getUint32(7, false),
    keyframe: (codecByte & VIDEO_FLAG_KEYFRAME) !== 0,
    ptsUs: dv.getBigUint64(11, false),
    hostReceivedAt: Number(dv.getBigUint64(19, false)),
    data: buf.subarray(VIDEO_HEADER_LEN),
  }
}
