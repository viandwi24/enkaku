import type { FrameMeta } from './driver'

/**
 * Binary framing WS (plan 03 §4.8) — berlaku untuk SEMUA stream binary,
 * termasuk scrcpy Plan 08. Byte 0–1 TIDAK PERNAH berubah artinya:
 *
 *   byte 0    : u8  channel  — 0x01 VIDEO, 0x02 AUDIO (P08), 0x03 CONTROL (P08)
 *   byte 1    : u8  streamId — dialokasikan core saat stream.started
 *   byte 2..  : payload per (channel, codec)
 *
 * Payload VIDEO codec PNG (M2):
 *   byte 2    : u8 codec (0x01 PNG; 0x02 H264 dipakai Plan 08)
 *   byte 3..4 : u16BE width
 *   byte 5..6 : u16BE height
 *   byte 7..10: u32BE seq
 *   byte 11.. : data PNG utuh
 */
export const CHANNEL = { VIDEO: 0x01, AUDIO: 0x02, CONTROL: 0x03 } as const
export const VIDEO_CODEC = { PNG: 0x01, H264: 0x02 } as const

const VIDEO_HEADER_LEN = 11

export function encodeVideoFrame(streamId: number, meta: FrameMeta, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(VIDEO_HEADER_LEN + data.length)
  const dv = new DataView(out.buffer)
  dv.setUint8(0, CHANNEL.VIDEO)
  dv.setUint8(1, streamId & 0xff)
  dv.setUint8(2, meta.codec === 'png' ? VIDEO_CODEC.PNG : VIDEO_CODEC.H264)
  dv.setUint16(3, meta.width, false)
  dv.setUint16(5, meta.height, false)
  dv.setUint32(7, meta.seq >>> 0, false)
  out.set(data, VIDEO_HEADER_LEN)
  return out
}

export interface DecodedVideoFrame {
  channel: number
  streamId: number
  codec: number
  width: number
  height: number
  seq: number
  data: Uint8Array
}

export function decodeVideoFrame(buf: Uint8Array): DecodedVideoFrame {
  if (buf.length < VIDEO_HEADER_LEN) throw new Error(`frame terlalu pendek: ${buf.length} byte`)
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const channel = dv.getUint8(0)
  if (channel !== CHANNEL.VIDEO) throw new Error(`channel bukan VIDEO: 0x${channel.toString(16)}`)
  const codec = dv.getUint8(2)
  if (codec !== VIDEO_CODEC.PNG && codec !== VIDEO_CODEC.H264) {
    throw new Error(`codec tidak dikenal: 0x${codec.toString(16)}`)
  }
  return {
    channel,
    streamId: dv.getUint8(1),
    codec,
    width: dv.getUint16(3, false),
    height: dv.getUint16(5, false),
    seq: dv.getUint32(7, false),
    data: buf.subarray(VIDEO_HEADER_LEN),
  }
}
