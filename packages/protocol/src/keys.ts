import { z } from 'zod'

/** `KeyboardEvent.code` values the wire accepts (plan 209 §3.2 D3). Physical keys; the device applies its own layout (R2). */
export const DOM_CODES = [
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
] as const
export type DomCode = (typeof DOM_CODES)[number]
export const DomCodeSchema = z.enum(DOM_CODES)

export interface KeyEntry {
  /** HID usage id, page 0x07. */
  hid: number
  /** Android `KeyEvent.KEYCODE_*`. */
  android: number
  /** True when the key produces a character on a US layout (redacted in the event log like typed text, D9). */
  printable: boolean
}

/** One table for both engines. HID column: USB HID Usage Tables 1.12 §10; Android column: `android.view.KeyEvent`. */
export const KEY_TABLE: Record<DomCode, KeyEntry> = {
  KeyA: { hid: 0x04, android: 29, printable: true }, KeyB: { hid: 0x05, android: 30, printable: true }, KeyC: { hid: 0x06, android: 31, printable: true },
  KeyD: { hid: 0x07, android: 32, printable: true }, KeyE: { hid: 0x08, android: 33, printable: true }, KeyF: { hid: 0x09, android: 34, printable: true },
  KeyG: { hid: 0x0a, android: 35, printable: true }, KeyH: { hid: 0x0b, android: 36, printable: true }, KeyI: { hid: 0x0c, android: 37, printable: true },
  KeyJ: { hid: 0x0d, android: 38, printable: true }, KeyK: { hid: 0x0e, android: 39, printable: true }, KeyL: { hid: 0x0f, android: 40, printable: true },
  KeyM: { hid: 0x10, android: 41, printable: true }, KeyN: { hid: 0x11, android: 42, printable: true }, KeyO: { hid: 0x12, android: 43, printable: true },
  KeyP: { hid: 0x13, android: 44, printable: true }, KeyQ: { hid: 0x14, android: 45, printable: true }, KeyR: { hid: 0x15, android: 46, printable: true },
  KeyS: { hid: 0x16, android: 47, printable: true }, KeyT: { hid: 0x17, android: 48, printable: true }, KeyU: { hid: 0x18, android: 49, printable: true },
  KeyV: { hid: 0x19, android: 50, printable: true }, KeyW: { hid: 0x1a, android: 51, printable: true }, KeyX: { hid: 0x1b, android: 52, printable: true },
  KeyY: { hid: 0x1c, android: 53, printable: true }, KeyZ: { hid: 0x1d, android: 54, printable: true },
  Digit1: { hid: 0x1e, android: 8, printable: true }, Digit2: { hid: 0x1f, android: 9, printable: true }, Digit3: { hid: 0x20, android: 10, printable: true },
  Digit4: { hid: 0x21, android: 11, printable: true }, Digit5: { hid: 0x22, android: 12, printable: true }, Digit6: { hid: 0x23, android: 13, printable: true },
  Digit7: { hid: 0x24, android: 14, printable: true }, Digit8: { hid: 0x25, android: 15, printable: true }, Digit9: { hid: 0x26, android: 16, printable: true },
  Digit0: { hid: 0x27, android: 7, printable: true },
  Enter: { hid: 0x28, android: 66, printable: false }, Escape: { hid: 0x29, android: 111, printable: false }, Backspace: { hid: 0x2a, android: 67, printable: false },
  Tab: { hid: 0x2b, android: 61, printable: false }, Space: { hid: 0x2c, android: 62, printable: true }, Minus: { hid: 0x2d, android: 69, printable: true },
  Equal: { hid: 0x2e, android: 70, printable: true }, BracketLeft: { hid: 0x2f, android: 71, printable: true }, BracketRight: { hid: 0x30, android: 72, printable: true },
  Backslash: { hid: 0x31, android: 73, printable: true }, Semicolon: { hid: 0x33, android: 74, printable: true }, Quote: { hid: 0x34, android: 75, printable: true },
  Backquote: { hid: 0x35, android: 68, printable: true }, Comma: { hid: 0x36, android: 55, printable: true }, Period: { hid: 0x37, android: 56, printable: true },
  Slash: { hid: 0x38, android: 76, printable: true }, CapsLock: { hid: 0x39, android: 115, printable: false },
  F1: { hid: 0x3a, android: 131, printable: false }, F2: { hid: 0x3b, android: 132, printable: false }, F3: { hid: 0x3c, android: 133, printable: false },
  F4: { hid: 0x3d, android: 134, printable: false }, F5: { hid: 0x3e, android: 135, printable: false }, F6: { hid: 0x3f, android: 136, printable: false },
  F7: { hid: 0x40, android: 137, printable: false }, F8: { hid: 0x41, android: 138, printable: false }, F9: { hid: 0x42, android: 139, printable: false },
  F10: { hid: 0x43, android: 140, printable: false }, F11: { hid: 0x44, android: 141, printable: false }, F12: { hid: 0x45, android: 142, printable: false },
  PrintScreen: { hid: 0x46, android: 120, printable: false }, ScrollLock: { hid: 0x47, android: 116, printable: false }, Pause: { hid: 0x48, android: 121, printable: false },
  Insert: { hid: 0x49, android: 124, printable: false }, Home: { hid: 0x4a, android: 122, printable: false }, PageUp: { hid: 0x4b, android: 92, printable: false },
  Delete: { hid: 0x4c, android: 112, printable: false }, End: { hid: 0x4d, android: 123, printable: false }, PageDown: { hid: 0x4e, android: 93, printable: false },
  ArrowRight: { hid: 0x4f, android: 22, printable: false }, ArrowLeft: { hid: 0x50, android: 21, printable: false }, ArrowDown: { hid: 0x51, android: 20, printable: false },
  ArrowUp: { hid: 0x52, android: 19, printable: false },
  NumLock: { hid: 0x53, android: 143, printable: false }, NumpadDivide: { hid: 0x54, android: 154, printable: true }, NumpadMultiply: { hid: 0x55, android: 155, printable: true },
  NumpadSubtract: { hid: 0x56, android: 156, printable: true }, NumpadAdd: { hid: 0x57, android: 157, printable: true }, NumpadEnter: { hid: 0x58, android: 160, printable: false },
  Numpad1: { hid: 0x59, android: 145, printable: true }, Numpad2: { hid: 0x5a, android: 146, printable: true }, Numpad3: { hid: 0x5b, android: 147, printable: true },
  Numpad4: { hid: 0x5c, android: 148, printable: true }, Numpad5: { hid: 0x5d, android: 149, printable: true }, Numpad6: { hid: 0x5e, android: 150, printable: true },
  Numpad7: { hid: 0x5f, android: 151, printable: true }, Numpad8: { hid: 0x60, android: 152, printable: true }, Numpad9: { hid: 0x61, android: 153, printable: true },
  Numpad0: { hid: 0x62, android: 144, printable: true }, NumpadDecimal: { hid: 0x63, android: 158, printable: true },
  IntlBackslash: { hid: 0x64, android: 73, printable: true }, ContextMenu: { hid: 0x65, android: 82, printable: false },
  ControlLeft: { hid: 0xe0, android: 113, printable: false }, ShiftLeft: { hid: 0xe1, android: 59, printable: false }, AltLeft: { hid: 0xe2, android: 57, printable: false },
  MetaLeft: { hid: 0xe3, android: 117, printable: false }, ControlRight: { hid: 0xe4, android: 114, printable: false }, ShiftRight: { hid: 0xe5, android: 60, printable: false },
  AltRight: { hid: 0xe6, android: 58, printable: false }, MetaRight: { hid: 0xe7, android: 118, printable: false },
}

export function isDomCode(code: string): code is DomCode {
  return Object.hasOwn(KEY_TABLE, code)
}

/** What the driver receives (resolved by the core from `KEY_TABLE`; the driver holds no table). */
export interface KeyDescriptor {
  code: DomCode
  hidUsage: number
  androidKeycode: number
}
export function describeKey(code: DomCode): KeyDescriptor {
  const e = KEY_TABLE[code]
  return { code, hidUsage: e.hid, androidKeycode: e.android }
}

/** Modifier flags as the browser reports them (`KeyboardEvent.shiftKey` and friends). */
export const KeyMetaSchema = z.object({ shift: z.boolean(), ctrl: z.boolean(), alt: z.boolean(), meta: z.boolean() })
export type KeyMeta = z.infer<typeof KeyMetaSchema>

/** `android.view.KeyEvent.META_*` bits the `INJECT_KEYCODE` fallback sends (left-hand variants, the way a physical keyboard reports them). */
export const ANDROID_META = {
  SHIFT_ON: 0x1, SHIFT_LEFT_ON: 0x40,
  ALT_ON: 0x2, ALT_LEFT_ON: 0x10,
  CTRL_ON: 0x1000, CTRL_LEFT_ON: 0x2000,
  META_ON: 0x10000, META_LEFT_ON: 0x20000,
} as const
export function androidMetaState(meta: KeyMeta): number {
  let state = 0
  if (meta.shift) state |= ANDROID_META.SHIFT_ON | ANDROID_META.SHIFT_LEFT_ON
  if (meta.ctrl) state |= ANDROID_META.CTRL_ON | ANDROID_META.CTRL_LEFT_ON
  if (meta.alt) state |= ANDROID_META.ALT_ON | ANDROID_META.ALT_LEFT_ON
  if (meta.meta) state |= ANDROID_META.META_ON | ANDROID_META.META_LEFT_ON
  return state
}
