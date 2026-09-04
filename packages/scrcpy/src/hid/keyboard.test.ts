import { describe, expect, test } from 'bun:test'
import { KEYBOARD_REPORT_DESCRIPTOR, KeyboardState } from './keyboard'

describe('UHID boot keyboard (plan 209 §4.3, §5 step 209.2)', () => {
  test('the descriptor is 63 bytes and starts with the Generic Desktop keyboard usage', () => {
    expect(KEYBOARD_REPORT_DESCRIPTOR.length).toBe(63)
    expect(Array.from(KEYBOARD_REPORT_DESCRIPTOR.subarray(0, 4))).toEqual([0x05, 0x01, 0x09, 0x06])
  })

  test('press then release of KeyA yields [0,0,4,0,0,0,0,0] then all zeros', () => {
    const kb = new KeyboardState()
    const down = kb.press(0x04)
    expect(down ? Array.from(down) : null).toEqual([0, 0, 4, 0, 0, 0, 0, 0])
    const up = kb.release(0x04)
    expect(up ? Array.from(up) : null).toEqual([0, 0, 0, 0, 0, 0, 0, 0])
  })

  test('a modifier sets its bit in byte 0 (ShiftLeft → 0x02)', () => {
    const kb = new KeyboardState()
    const report = kb.press(0xe1) // ShiftLeft
    expect(report?.[0]).toBe(0x02)
  })

  test('a seventh key fills all six slots with 0x01', () => {
    const kb = new KeyboardState()
    let last: Uint8Array | null = null
    for (const usage of [0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a]) {
      last = kb.press(usage)
    }
    expect(last ? Array.from(last.subarray(2)) : null).toEqual([1, 1, 1, 1, 1, 1])
  })

  test('releaseAll returns an all-zero report and forgets everything', () => {
    const kb = new KeyboardState()
    kb.press(0x04)
    kb.press(0xe1)
    const report = kb.releaseAll()
    expect(Array.from(report)).toEqual([0, 0, 0, 0, 0, 0, 0, 0])
    expect(kb.isDown(0x04)).toBe(false)
    expect(kb.isDown(0xe1)).toBe(false)
  })
})
