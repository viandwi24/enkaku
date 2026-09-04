/**
 * UHID boot keyboard (plan 209 §3.2 D5, MVP 08 §1.2). Report: 8 bytes,
 * [modifiers][reserved 0][key1..key6], HID usage page 0x07. Copied from
 * scrcpy's own client (`app/src/hid/hid_keyboard.c`), which is what scrcpy
 * uses for physical-keyboard passthrough (R2).
 * verified against v3.3.1 app/src/hid/hid_keyboard.c on 2026-09-04 (step 209.2).
 */
export const UHID_KEYBOARD_ID = 2
export const KEYBOARD_REPORT_BYTES = 8
export const KEYBOARD_MAX_KEYS = 6
/** HID "ErrorRollOver": every slot reads this when more than six keys are down. */
export const HID_ERROR_ROLLOVER = 0x01
export const HID_MODIFIER_FIRST = 0xe0
export const HID_MODIFIER_LAST = 0xe7

// prettier-ignore
export const KEYBOARD_REPORT_DESCRIPTOR = new Uint8Array([
  0x05, 0x01,       // Usage Page (Generic Desktop)
  0x09, 0x06,       // Usage (Keyboard)
  0xa1, 0x01,       // Collection (Application)
  0x05, 0x07,       //   Usage Page (Key Codes)
  0x19, 0xe0,       //   Usage Minimum (224)
  0x29, 0xe7,       //   Usage Maximum (231)
  0x15, 0x00,       //   Logical Minimum (0)
  0x25, 0x01,       //   Logical Maximum (1)
  0x75, 0x01,       //   Report Size (1)
  0x95, 0x08,       //   Report Count (8)
  0x81, 0x02,       //   Input (Data, Variable, Absolute): modifier byte
  0x75, 0x08,       //   Report Size (8)
  0x95, 0x01,       //   Report Count (1)
  0x81, 0x01,       //   Input (Constant): reserved byte
  0x05, 0x08,       //   Usage Page (LEDs)
  0x19, 0x01,       //   Usage Minimum (1)
  0x29, 0x05,       //   Usage Maximum (5)
  0x75, 0x01,       //   Report Size (1)
  0x95, 0x05,       //   Report Count (5)
  0x91, 0x02,       //   Output (Data, Variable, Absolute): LED report
  0x75, 0x03,       //   Report Size (3)
  0x95, 0x01,       //   Report Count (1)
  0x91, 0x01,       //   Output (Constant): LED padding
  0x05, 0x07,       //   Usage Page (Key Codes)
  0x19, 0x00,       //   Usage Minimum (0)
  0x29, 0x65,       //   Usage Maximum (101)
  0x15, 0x00,       //   Logical Minimum (0)
  0x25, 0x65,       //   Logical Maximum (101)
  0x75, 0x08,       //   Report Size (8)
  0x95, 0x06,       //   Report Count (6)
  0x81, 0x00,       //   Input (Data, Array): keys
  0xc0,             // End Collection
])

/** Tracks which usages are down and renders the 8-byte report scrcpy's descriptor describes. */
export class KeyboardState {
  private modifiers = 0
  private readonly keys: number[] = []

  /** Returns the report to send, or null when nothing changed (a repeated down of a held key). */
  press(usage: number): Uint8Array | null {
    if (usage >= HID_MODIFIER_FIRST && usage <= HID_MODIFIER_LAST) {
      const bit = 1 << (usage - HID_MODIFIER_FIRST)
      if (this.modifiers & bit) return null
      this.modifiers |= bit
      return this.report()
    }
    if (this.keys.includes(usage)) return null
    this.keys.push(usage)
    return this.report()
  }

  release(usage: number): Uint8Array | null {
    if (usage >= HID_MODIFIER_FIRST && usage <= HID_MODIFIER_LAST) {
      const bit = 1 << (usage - HID_MODIFIER_FIRST)
      if (!(this.modifiers & bit)) return null
      this.modifiers &= ~bit
      return this.report()
    }
    const idx = this.keys.indexOf(usage)
    if (idx === -1) return null
    this.keys.splice(idx, 1)
    return this.report()
  }

  isDown(usage: number): boolean {
    if (usage >= HID_MODIFIER_FIRST && usage <= HID_MODIFIER_LAST) return (this.modifiers & (1 << (usage - HID_MODIFIER_FIRST))) !== 0
    return this.keys.includes(usage)
  }

  /** Everything up: the report LiveView's blur and the session's close send. */
  releaseAll(): Uint8Array {
    this.modifiers = 0
    this.keys.length = 0
    return this.report()
  }

  report(): Uint8Array {
    const out = new Uint8Array(KEYBOARD_REPORT_BYTES)
    out[0] = this.modifiers
    if (this.keys.length > KEYBOARD_MAX_KEYS) {
      out.fill(HID_ERROR_ROLLOVER, 2)
    } else {
      for (let i = 0; i < this.keys.length; i++) out[2 + i] = this.keys[i]!
    }
    return out
  }
}
