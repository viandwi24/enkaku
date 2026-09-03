import { describe, expect, test } from 'bun:test'
import { CHANNEL, decodeSnapshot, decodeVideoFrame, encodeSnapshot, encodeVideoFrame } from './binary'

describe('encodeVideoFrame / decodeVideoFrame — the 27-byte header (plan 203 §4.2, §5 step 203.4)', () => {
  test('round-trips ptsUs and hostReceivedAt through the 27-byte header', () => {
    const payload = new Uint8Array([1, 2, 3, 4, 5])
    const frame = encodeVideoFrame(
      3,
      {
        codec: 'h264',
        keyframe: true,
        width: 1080,
        height: 2400,
        seq: 7,
        ptsUs: 123_456_789_012n,
        hostReceivedAt: 1_756_900_000_123,
      },
      payload,
    )
    expect(frame.length).toBe(32)
    const decoded = decodeVideoFrame(frame)
    expect(decoded.channel).toBe(CHANNEL.VIDEO)
    expect(decoded.streamId).toBe(3)
    expect(decoded.width).toBe(1080)
    expect(decoded.height).toBe(2400)
    expect(decoded.seq).toBe(7)
    expect(decoded.keyframe).toBe(true)
    expect(decoded.ptsUs).toBe(123_456_789_012n)
    expect(decoded.hostReceivedAt).toBe(1_756_900_000_123)
    expect([...decoded.data]).toEqual([...payload])
  })

  test('a frame of exactly 27 bytes decodes with an empty payload; 26 throws', () => {
    const frame = encodeVideoFrame(
      1,
      { codec: 'png', width: 1, height: 1, seq: 0, ptsUs: 0n, hostReceivedAt: 0 },
      new Uint8Array(0),
    )
    expect(frame.length).toBe(27)
    const decoded = decodeVideoFrame(frame)
    expect(decoded.data.length).toBe(0)
    expect(() => decodeVideoFrame(frame.subarray(0, 26))).toThrow()
  })

  test('a PNG frame with ptsUs 0n decodes to 0n', () => {
    const frame = encodeVideoFrame(
      1,
      { codec: 'png', width: 2, height: 2, seq: 0, ptsUs: 0n, hostReceivedAt: 500 },
      new Uint8Array([9]),
    )
    const decoded = decodeVideoFrame(frame)
    expect(decoded.ptsUs).toBe(0n)
    expect(decoded.keyframe).toBe(true)
  })
})

describe('CHANNEL (plan 03 §4.8, plan 56 §3.8)', () => {
  test('SNAPSHOT never collides with VIDEO/AUDIO/CONTROL', () => {
    const values = Object.values(CHANNEL)
    expect(new Set(values).size).toBe(values.length)
    expect(CHANNEL.SNAPSHOT).toBe(0x04)
  })
})

describe('encodeSnapshot / decodeSnapshot (plan 56 §5.1)', () => {
  test('round-trips a requestId and PNG payload', () => {
    const data = new Uint8Array([137, 80, 78, 71, 1, 2, 3])
    const frame = encodeSnapshot(42, data)
    expect(frame[0]).toBe(CHANNEL.SNAPSHOT)
    const decoded = decodeSnapshot(frame)
    expect(decoded.requestId).toBe(42)
    expect([...decoded.data]).toEqual([...data])
  })

  test('a requestId is masked to one byte (0..255)', () => {
    const frame = encodeSnapshot(0x1ff, new Uint8Array([1]))
    expect(decodeSnapshot(frame).requestId).toBe(0xff)
  })

  test('decoding a non-SNAPSHOT frame throws', () => {
    const videoFrame = encodeVideoFrame(
      1,
      { width: 1, height: 1, codec: 'png', seq: 0, ptsUs: 0n, hostReceivedAt: 0 },
      new Uint8Array([1]),
    )
    expect(() => decodeSnapshot(videoFrame)).toThrow()
  })

  test('a frame shorter than the header throws', () => {
    expect(() => decodeSnapshot(new Uint8Array([CHANNEL.SNAPSHOT]))).toThrow()
  })

  test('decoding a SNAPSHOT frame as VIDEO throws (channel byte is still respected)', () => {
    const frame = encodeSnapshot(1, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]))
    expect(() => decodeVideoFrame(frame)).toThrow()
  })
})
