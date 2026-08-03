import { describe, expect, test } from 'bun:test'
import { CONTROL_MSG } from '../version'
import { encodeGetClipboard, encodeResetVideo, encodeSetClipboard, encodeSetDisplayPower } from './messages'

describe('encodeSetDisplayPower (Plan 17 §3.5) — control type 10, one boolean byte', () => {
  test('on → [10, 1]', () => {
    expect([...encodeSetDisplayPower(true)]).toEqual([CONTROL_MSG.SET_DISPLAY_POWER, 1])
  })

  test('off → [10, 0]', () => {
    expect([...encodeSetDisplayPower(false)]).toEqual([CONTROL_MSG.SET_DISPLAY_POWER, 0])
  })

  test('exactly 2 bytes — no extra payload', () => {
    expect(encodeSetDisplayPower(true).length).toBe(2)
  })
})

describe('encodeResetVideo (Plan 17 §3.6) — control type 17, no payload', () => {
  test('→ [17]', () => {
    expect([...encodeResetVideo()]).toEqual([CONTROL_MSG.RESET_VIDEO])
  })

  test('exactly 1 byte', () => {
    expect(encodeResetVideo().length).toBe(1)
  })
})

describe('encodeGetClipboard (Plan 38 §4.1) — control type 8, one copyKey byte', () => {
  test('default (no arg) → none → [8, 0]', () => {
    expect([...encodeGetClipboard()]).toEqual([CONTROL_MSG.GET_CLIPBOARD, 0])
  })

  test('none → [8, 0]', () => {
    expect([...encodeGetClipboard('none')]).toEqual([CONTROL_MSG.GET_CLIPBOARD, 0])
  })

  test('copy → [8, 1]', () => {
    expect([...encodeGetClipboard('copy')]).toEqual([CONTROL_MSG.GET_CLIPBOARD, 1])
  })

  test('cut → [8, 2]', () => {
    expect([...encodeGetClipboard('cut')]).toEqual([CONTROL_MSG.GET_CLIPBOARD, 2])
  })

  test('exactly 2 bytes — no extra payload', () => {
    expect(encodeGetClipboard('cut').length).toBe(2)
  })
})

describe('encodeSetClipboard (Plan 38 §4.1) — control type 9: [type][seq u64BE][paste u8][len u32BE][utf8]', () => {
  test('ASCII text, paste defaulted to false', () => {
    const bytes = encodeSetClipboard(7n, 'hi', undefined)
    expect(bytes.length).toBe(1 + 8 + 1 + 4 + 2)
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    expect(dv.getUint8(0)).toBe(CONTROL_MSG.SET_CLIPBOARD)
    expect(dv.getBigUint64(1, false)).toBe(7n)
    expect(dv.getUint8(9)).toBe(0) // paste: false
    expect(dv.getUint32(10, false)).toBe(2) // byte length of "hi"
    expect(new TextDecoder().decode(bytes.subarray(14))).toBe('hi')
  })

  test('paste: true sets the paste byte to 1', () => {
    const bytes = encodeSetClipboard(1n, 'x', true)
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    expect(dv.getUint8(9)).toBe(1)
  })

  test('a large sequence round-trips through the u64BE field intact', () => {
    const seq = 0x1122334455667788n
    const bytes = encodeSetClipboard(seq, '', false)
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    expect(dv.getBigUint64(1, false)).toBe(seq)
  })

  test('multi-byte UTF-8 payload: the length prefix is a BYTE length, not a character count', () => {
    // "héllo 世界" — 6 ASCII/Latin-1-range chars (é is 2 bytes) plus two
    // 3-byte CJK characters: 5 plain ASCII (1B) + é (2B) + space (1B) + 世(3B) + 界(3B).
    const text = 'héllo 世界'
    const bytes = encodeSetClipboard(1n, text, false)
    const expectedByteLen = new TextEncoder().encode(text).length
    // The JS string's .length (UTF-16 code units) differs from the byte
    // length — proving this would catch a `text.length` bug in the encoder.
    expect(text.length).not.toBe(expectedByteLen)
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    expect(dv.getUint32(10, false)).toBe(expectedByteLen)
    expect(bytes.length).toBe(1 + 8 + 1 + 4 + expectedByteLen)
    expect(new TextDecoder().decode(bytes.subarray(14))).toBe(text)
  })
})
