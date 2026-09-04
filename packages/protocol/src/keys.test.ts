import { describe, expect, test } from 'bun:test'
import { KEY_TABLE, DOM_CODES, androidMetaState, type DomCode } from './keys'

/**
 * A second, hand-written literal list of the DOM codes this wire is meant to
 * support (plan 209 §4.4), so this test cannot pass merely by reading the
 * table it checks. NOTE (plan 209 §11 discrepancy): the plan's own §4.4 prose
 * says "101"; its own code block for `DOM_CODES` enumerates 105 distinct
 * names (26 letters + 10 digits + 17 punctuation/editing keys + 12 function
 * keys + 9 navigation keys + 4 arrows + 6 numpad-control keys + 11 numpad
 * digits/decimal + 2 (IntlBackslash, ContextMenu) + 8 modifiers = 105). The
 * file (the code block) wins for facts; this list matches it.
 */
const REQUIRED_DOM_CODES: DomCode[] = [
  'KeyA','KeyB','KeyC','KeyD','KeyE','KeyF','KeyG','KeyH','KeyI','KeyJ','KeyK','KeyL','KeyM','KeyN','KeyO','KeyP','KeyQ','KeyR','KeyS','KeyT','KeyU','KeyV','KeyW','KeyX','KeyY','KeyZ',
  'Digit1','Digit2','Digit3','Digit4','Digit5','Digit6','Digit7','Digit8','Digit9','Digit0',
  'Enter','Escape','Backspace','Tab','Space','Minus','Equal','BracketLeft','BracketRight','Backslash','Semicolon','Quote','Backquote','Comma','Period','Slash','CapsLock',
  'F1','F2','F3','F4','F5','F6','F7','F8','F9','F10','F11','F12',
  'PrintScreen','ScrollLock','Pause','Insert','Home','PageUp','Delete','End','PageDown',
  'ArrowRight','ArrowLeft','ArrowDown','ArrowUp',
  'NumLock','NumpadDivide','NumpadMultiply','NumpadSubtract','NumpadAdd','NumpadEnter',
  'Numpad1','Numpad2','Numpad3','Numpad4','Numpad5','Numpad6','Numpad7','Numpad8','Numpad9','Numpad0','NumpadDecimal',
  'IntlBackslash','ContextMenu',
  'ControlLeft','ShiftLeft','AltLeft','MetaLeft','ControlRight','ShiftRight','AltRight','MetaRight',
]

describe('key mapping (plan 209 §4.4, §5 step 209.3)', () => {
  test('every required DOM code maps', () => {
    expect(REQUIRED_DOM_CODES.length).toBe(105)
    for (const code of REQUIRED_DOM_CODES) {
      const entry = KEY_TABLE[code]
      expect(entry).toBeDefined()
      expect(entry.hid).toBeGreaterThanOrEqual(0x04)
      expect(entry.hid).toBeLessThanOrEqual(0xe7)
      expect(entry.android).toBeGreaterThanOrEqual(1)
      expect(entry.android).toBeLessThanOrEqual(320)
    }
  })

  test('DOM_CODES has exactly the required names and no others', () => {
    const a = [...DOM_CODES].sort()
    const b = [...REQUIRED_DOM_CODES].sort()
    expect(a).toEqual(b)
  })

  test('non-modifier HID usages are unique', () => {
    const seen = new Map<number, string>()
    for (const [code, entry] of Object.entries(KEY_TABLE)) {
      if (entry.hid >= 0xe0 && entry.hid <= 0xe7) continue // modifiers, deliberately not unique across left/right pairing checks
      const prior = seen.get(entry.hid)
      if (prior) {
        // Backslash and IntlBackslash may share an Android keycode, never a HID usage.
        throw new Error(`HID usage 0x${entry.hid.toString(16)} shared by ${prior} and ${code}`)
      }
      seen.set(entry.hid, code)
    }
  })

  test('androidMetaState composes the left-hand bits', () => {
    expect(androidMetaState({ shift: true, ctrl: true, alt: false, meta: false })).toBe(0x3041)
  })
})
