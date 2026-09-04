import { describe, expect, test } from 'bun:test'
import { CODEC_ID } from './version'
import { VideoDemuxer, PTS_FLAG_CONFIG, PTS_FLAG_KEYFRAME, MAX_PACKET_BYTES, type ScrcpyPacket, type VideoMeta } from './demuxer'

/** One dummy byte (tunnel_forward), a 64-byte NUL-padded device name. */
function header(deviceName = 'fake-device'): Uint8Array {
  const out = new Uint8Array(1 + 64)
  const nameBytes = new TextEncoder().encode(deviceName)
  out.set(nameBytes, 1)
  return out
}

/** The 12-byte codec metadata block: u32BE codecId, u32BE width, u32BE height. */
function meta(codecId: number, width: number, height: number): Uint8Array {
  const buf = new Uint8Array(12)
  const dv = new DataView(buf.buffer)
  dv.setUint32(0, codecId, false)
  dv.setUint32(4, width, false)
  dv.setUint32(8, height, false)
  return buf
}

/** One frame: 12-byte header (u64BE ptsAndFlags, u32BE size) plus payload. */
function frame(ptsAndFlags: bigint, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length)
  const dv = new DataView(out.buffer)
  dv.setBigUint64(0, ptsAndFlags, false)
  dv.setUint32(8, data.length, false)
  out.set(data, 12)
  return out
}

function createHarness(clock: { now: number }, opts: { onError?: (err: Error) => void } = {}) {
  const metas: VideoMeta[] = []
  const packets: ScrcpyPacket[] = []
  const demuxer = new VideoDemuxer({
    expectDummyByte: true,
    onMeta: (m) => metas.push(m),
    onPacket: (p) => packets.push(p),
    now: () => clock.now,
    onError: opts.onError,
  })
  return { demuxer, metas, packets }
}

describe('VideoDemuxer (plan 203 §4.3, §5 step 203.3)', () => {
  test('parses the meta header and reports codec, width and height', () => {
    const clock = { now: 1000 }
    const { demuxer, metas } = createHarness(clock)
    demuxer.push(header())
    demuxer.push(meta(CODEC_ID.H264, 1080, 2400))
    expect(metas).toHaveLength(1)
    expect(metas[0]).toMatchObject({ codec: 'h264', width: 1080, height: 2400 })
  })

  test('a config packet carries receivedAt and no ptsUs', () => {
    const clock = { now: 5000 }
    const { demuxer, packets } = createHarness(clock)
    demuxer.push(header())
    demuxer.push(meta(CODEC_ID.H264, 1080, 2400))
    const payload = new Uint8Array([1, 2, 3])
    demuxer.push(frame(PTS_FLAG_CONFIG, payload))
    expect(packets).toHaveLength(1)
    const packet = packets[0]
    expect(packet?.kind).toBe('config')
    expect('ptsUs' in (packet ?? {})).toBe(false)
    expect(packet?.receivedAt).toBe(5000)
  })

  test('a keyframe and a delta carry ptsUs and the receivedAt of the push that completed them', () => {
    const clock = { now: 1000 }
    const { demuxer, packets } = createHarness(clock)
    demuxer.push(header())
    demuxer.push(meta(CODEC_ID.H264, 1080, 2400))

    const keyframePayload = new Uint8Array([9, 9, 9])
    const keyframeBytes = frame(PTS_FLAG_KEYFRAME | 33_333n, keyframePayload)
    // Split the frame across two pushes: header in the first, payload in the
    // second, with the clock advanced in between. receivedAt must be the
    // clock value at the push that COMPLETED the frame.
    clock.now = 2000
    demuxer.push(keyframeBytes.subarray(0, 12))
    clock.now = 3000
    demuxer.push(keyframeBytes.subarray(12))

    expect(packets).toHaveLength(1)
    const kf = packets[0]
    expect(kf?.kind).toBe('keyframe')
    expect(kf && 'ptsUs' in kf ? kf.ptsUs : null).toBe(33_333n)
    expect(kf?.receivedAt).toBe(3000)

    const deltaPayload = new Uint8Array([1])
    clock.now = 4000
    demuxer.push(frame(66_666n, deltaPayload))
    expect(packets).toHaveLength(2)
    const delta = packets[1]
    expect(delta?.kind).toBe('frame')
    expect(delta && 'ptsUs' in delta ? delta.ptsUs : null).toBe(66_666n)
    expect(delta?.receivedAt).toBe(4000)
  })

  test('frames split across three chunks are reassembled unchanged', () => {
    const clock = { now: 42 }
    const { demuxer, packets } = createHarness(clock)
    demuxer.push(header())
    demuxer.push(meta(CODEC_ID.H264, 1080, 2400))

    const payload = new Uint8Array([10, 20, 30, 40, 50])
    const bytes = frame(1_000n, payload)
    demuxer.push(bytes.subarray(0, 4))
    demuxer.push(bytes.subarray(4, 12))
    demuxer.push(bytes.subarray(12))

    expect(packets).toHaveLength(1)
    expect(packets[0]?.data).toEqual(payload)
  })

  test('push copies exactly chunk.length bytes per chunk and never reallocates for frames under the initial capacity', () => {
    const clock = { now: 1 }
    const { demuxer, packets } = createHarness(clock)
    demuxer.push(header())
    demuxer.push(meta(CODEC_ID.H264, 1080, 2400))

    const CHUNK = 4096
    const FRAME_PAYLOAD = 40 * 1024
    let pushedChunks = 0
    for (let f = 0; f < 20; f++) {
      const payload = new Uint8Array(FRAME_PAYLOAD).fill(f % 256)
      const bytes = frame(BigInt(f), payload)
      for (let off = 0; off < bytes.length; off += CHUNK) {
        demuxer.push(bytes.subarray(off, Math.min(off + CHUNK, bytes.length)))
        pushedChunks++
      }
    }
    expect(packets).toHaveLength(20)
    const stats = demuxer.ringStats()
    expect(stats.pushCopiedBytes).toBe(stats.pushedBytes)
    expect(stats.grows).toBe(0)
    expect(stats.compactionCopiedBytes).toBeLessThan(stats.pushCopiedBytes / 4)
  })

  test('a frame larger than the capacity grows the ring once, then no more', () => {
    const clock = { now: 1 }
    const { demuxer, packets } = createHarness(clock)
    demuxer.push(header())
    demuxer.push(meta(CODEC_ID.H264, 1080, 2400))

    const CHUNK = 4096
    const payload = new Uint8Array(300 * 1024).fill(7)
    const bytes = frame(1n, payload)
    for (let off = 0; off < bytes.length; off += CHUNK) {
      demuxer.push(bytes.subarray(off, Math.min(off + CHUNK, bytes.length)))
    }
    expect(packets).toHaveLength(1)
    expect(demuxer.ringStats().grows).toBe(1)
  })

  test('a header declaring more than MAX_PACKET_BYTES stops the demuxer and reports onError once', () => {
    const clock = { now: 1 }
    const errors: Error[] = []
    const { demuxer, packets } = createHarness(clock, { onError: (e) => errors.push(e) })
    demuxer.push(header())
    demuxer.push(meta(CODEC_ID.H264, 1080, 2400))

    const badHeader = new Uint8Array(12)
    const dv = new DataView(badHeader.buffer)
    dv.setBigUint64(0, 1n, false)
    dv.setUint32(8, MAX_PACKET_BYTES + 1, false)
    demuxer.push(badHeader)
    expect(errors).toHaveLength(1)
    // further pushes are ignored once stopped
    demuxer.push(new Uint8Array([1, 2, 3]))
    expect(errors).toHaveLength(1)
    expect(packets).toHaveLength(0)
  })
})
