import { describe, expect, test } from 'bun:test'
import { CHANNEL, decodeSnapshot, decodeVideoFrame, encodeSnapshot, encodeVideoFrame } from './binary'

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
    const videoFrame = encodeVideoFrame(1, { width: 1, height: 1, codec: 'png', seq: 0, capturedAt: 0 }, new Uint8Array([1]))
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
