import { describe, expect, test } from 'bun:test'
import { CONTROL_MSG } from '../version'
import { encodeResetVideo, encodeSetDisplayPower } from './messages'

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
