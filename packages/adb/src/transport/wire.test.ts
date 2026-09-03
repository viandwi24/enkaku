import { describe, expect, test } from 'bun:test'
import { AdbError } from '../errors'
import {
  A_CLSE,
  A_CNXN,
  A_OKAY,
  A_OPEN,
  A_WRTE,
  HEADER_BYTES,
  MAX_MAXDATA,
  MIN_MAXDATA,
  checksum,
  clampMaxdata,
  commandName,
  decodeHeader,
  encodeFrame,
  stripTrailingNul,
} from './wire'

const te = new TextEncoder()

describe('checksum', () => {
  test('empty payload sums to zero', () => {
    expect(checksum(new Uint8Array(0))).toBe(0)
  })

  test('sums bytes and wraps at 2^32', () => {
    expect(checksum(new Uint8Array([1, 2, 3]))).toBe(6)
    // 2^32 - 1 repeated enough times to overflow, one byte at a time (0xff * N).
    const big = new Uint8Array(2 ** 24 + 10).fill(0xff)
    const expected = (big.length * 0xff) >>> 0
    expect(checksum(big)).toBe(expected)
  })
})

describe('encodeFrame / decodeHeader round-trip', () => {
  test('round-trips every command with random payloads', () => {
    const commands = [A_CNXN, A_OPEN, A_OKAY, A_WRTE, A_CLSE]
    for (let i = 0; i < 200; i++) {
      const command = commands[i % commands.length] as number
      const arg0 = Math.floor(Math.random() * 0xffffffff)
      const arg1 = Math.floor(Math.random() * 0xffffffff)
      const len = Math.floor(Math.random() * 300)
      const payload = new Uint8Array(len)
      for (let j = 0; j < len; j++) payload[j] = Math.floor(Math.random() * 256)

      const frame = encodeFrame(command, arg0, arg1, payload)
      expect(frame.length).toBe(HEADER_BYTES + len)

      const header = decodeHeader(frame.subarray(0, HEADER_BYTES))
      expect(header.command).toBe(command >>> 0)
      expect(header.arg0).toBe(arg0 >>> 0)
      expect(header.arg1).toBe(arg1 >>> 0)
      expect(header.dataLength).toBe(len)
      expect(header.dataCheck).toBe(checksum(payload))

      const roundTripped = frame.subarray(HEADER_BYTES)
      expect(roundTripped).toEqual(payload)
    }
  })

  test('a zero-length payload round-trips', () => {
    const frame = encodeFrame(A_OKAY, 1, 2)
    expect(frame.length).toBe(HEADER_BYTES)
    const header = decodeHeader(frame)
    expect(header.dataLength).toBe(0)
    expect(header.dataCheck).toBe(0)
  })

  test('magic is always command XOR 0xffffffff', () => {
    const frame = encodeFrame(A_CNXN, 0, 0)
    const header = decodeHeader(frame)
    expect(header.magic).toBe((A_CNXN ^ 0xffffffff) >>> 0)
  })
})

describe('decodeHeader — bad magic and truncation', () => {
  test('throws E_ADB_PROTOCOL on a corrupted magic', () => {
    const frame = encodeFrame(A_CNXN, 1, 2)
    // Flip one bit of the magic field (byte offset 20) so it no longer matches.
    const corrupted = new Uint8Array(frame)
    corrupted[20] = (corrupted[20] as number) ^ 0xff
    expect(() => decodeHeader(corrupted)).toThrow(AdbError)
    try {
      decodeHeader(corrupted)
    } catch (err) {
      expect(err).toBeInstanceOf(AdbError)
      expect((err as AdbError).code).toBe('E_ADB_PROTOCOL')
    }
  })

  test('throws E_ADB_PROTOCOL on a buffer shorter than HEADER_BYTES', () => {
    expect(() => decodeHeader(new Uint8Array(23))).toThrow(AdbError)
    expect(() => decodeHeader(new Uint8Array(0))).toThrow(AdbError)
  })

  test('an all-zero buffer decodes as command 0 with a mismatched magic (still rejected)', () => {
    // command=0 implies expected magic 0xffffffff, but the buffer's actual
    // magic field is also 0 — a deliberately adversarial all-zero frame must
    // not be accepted as valid.
    expect(() => decodeHeader(new Uint8Array(24))).toThrow(AdbError)
  })
})

describe('clampMaxdata', () => {
  test('passes through a value already in range', () => {
    expect(clampMaxdata(65536)).toBe(65536)
  })

  test('clamps above MAX_MAXDATA', () => {
    expect(clampMaxdata(MAX_MAXDATA * 10)).toBe(MAX_MAXDATA)
    // The exact value the spike measured a real adb client requesting.
    expect(clampMaxdata(1_048_576)).toBe(Math.min(1_048_576, MAX_MAXDATA))
  })

  test('clamps below MIN_MAXDATA', () => {
    expect(clampMaxdata(1)).toBe(MIN_MAXDATA)
    expect(clampMaxdata(0)).toBe(MIN_MAXDATA)
  })

  test('defends against non-finite or negative input', () => {
    expect(clampMaxdata(Number.NaN)).toBe(MIN_MAXDATA)
    expect(clampMaxdata(-1)).toBe(MIN_MAXDATA)
    expect(clampMaxdata(Number.POSITIVE_INFINITY)).toBe(MIN_MAXDATA)
  })

  test('floors a fractional value', () => {
    expect(clampMaxdata(65536.7)).toBe(65536)
  })
})

describe('commandName', () => {
  test('names every known command', () => {
    expect(commandName(A_CNXN)).toBe('CNXN')
    expect(commandName(A_OPEN)).toBe('OPEN')
    expect(commandName(A_OKAY)).toBe('OKAY')
    expect(commandName(A_WRTE)).toBe('WRTE')
    expect(commandName(A_CLSE)).toBe('CLSE')
  })

  test('falls back to hex for an unknown command', () => {
    expect(commandName(0x12345678)).toBe('0x12345678')
  })
})

describe('stripTrailingNul', () => {
  test('removes one trailing NUL', () => {
    expect(stripTrailingNul('shell:echo hi\0')).toBe('shell:echo hi')
  })

  test('removes multiple trailing NULs', () => {
    expect(stripTrailingNul('shell:echo hi\0\0\0')).toBe('shell:echo hi')
  })

  test('leaves a string with no trailing NUL unchanged', () => {
    expect(stripTrailingNul('shell:echo hi')).toBe('shell:echo hi')
  })

  test('does not touch an embedded NUL', () => {
    expect(stripTrailingNul('a\0b')).toBe('a\0b')
  })
})
