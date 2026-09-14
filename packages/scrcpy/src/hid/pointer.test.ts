import { describe, expect, test } from 'bun:test'
import { ABSOLUTE_POINTER_DESCRIPTOR, POINTER_LOGICAL_MAX, buildPointerReport } from './pointer'

/** Every (usage page, usage) pair the descriptor declares, in order — enough to tell a finger from a pen. */
function usages(desc: Uint8Array): string[] {
  const out: string[] = []
  let page = 0
  for (let i = 0; i < desc.length; ) {
    const prefix = desc[i]!
    const size = [0, 1, 2, 4][prefix & 0x03]!
    const value = size === 1 ? desc[i + 1]! : size === 2 ? desc[i + 1]! | (desc[i + 2]! << 8) : 0
    if ((prefix & 0xfc) === 0x04) page = value // Usage Page
    if ((prefix & 0xfc) === 0x08) out.push(`${page.toString(16)}:${value.toString(16)}`) // Usage
    i += 1 + size
  }
  return out
}

describe('UHID touch screen pointer', () => {
  test('declares a Touch Screen with a Finger contact — never a Pen or Stylus, which Android draws a hover pointer for', () => {
    const declared = usages(ABSOLUTE_POINTER_DESCRIPTOR)
    expect(declared.slice(0, 2)).toEqual(['d:4', 'd:22']) // Digitizer: Touch Screen, Finger
    expect(declared).toContain('d:51') // Contact Identifier — what puts it in hid-multitouch's group
    expect(declared).toContain('d:54') // Contact Count
    expect(declared).not.toContain('d:2') // Pen
    expect(declared).not.toContain('d:20') // Stylus
    expect(declared).not.toContain('d:32') // In Range — would make a tip-up report a hovering finger
  })

  test('declares no Feature report, which the driver would request through a GET_REPORT scrcpy never answers', () => {
    const items = Array.from(ABSOLUTE_POINTER_DESCRIPTOR)
    expect(items.includes(0xb1)).toBe(false) // Feature (…)
  })

  test('a report is tip, contact id 0, little-endian X and Y, and a contact count of 1', () => {
    expect(Array.from(buildPointerReport({ touching: true, xNorm: 1, yNorm: 0 }))).toEqual([1, 0, 0xff, 0x7f, 0, 0, 1])
    expect(Array.from(buildPointerReport({ touching: false, xNorm: 0.5, yNorm: 1 }))).toEqual([0, 0, 0x00, 0x40, 0xff, 0x7f, 1])
  })

  test('coordinates outside 0..1 are clamped to the logical range', () => {
    const r = buildPointerReport({ touching: true, xNorm: -3, yNorm: 9 })
    const dv = new DataView(r.buffer)
    expect(dv.getUint16(2, true)).toBe(0)
    expect(dv.getUint16(4, true)).toBe(POINTER_LOGICAL_MAX)
  })

  test('the input bits add up to the 7-byte report buildPointerReport writes', () => {
    // 1 tip + 7 padding + 8 contact id + 16 X + 16 Y + 8 contact count
    expect(1 + 7 + 8 + 16 + 16 + 8).toBe(buildPointerReport({ touching: false, xNorm: 0, yNorm: 0 }).length * 8)
  })
})
