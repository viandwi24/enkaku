import { CONTROL_MSG, KEY_ACTION, MOTION_ACTION, POINTER_ID_GENERIC_FINGER } from '../version'

/**
 * Encoder control message host→device (plan 08 §4.2).
 * verified against v3.3.1 server/src/main/java/com/genymobile/scrcpy/control/ControlMessageReader.java
 * on 2026-09-03: every encoder below matches its `parse*` counterpart field
 * for field and byte width for byte width — `parseInjectKeycode` (action,
 * keycode, repeat, metaState), `parseInjectText` (u32 length + UTF-8),
 * `parseInjectTouchEvent` (action, pointerId u64, position, u16 pressure,
 * actionButton, buttons), `parseUhidCreate` (id/vendorId/productId u16 each,
 * a 1-byte-length-prefixed name, a 2-byte-length-prefixed report),
 * `parseUhidInput`/`parseUhidDestroy`, `RESET_VIDEO` (type byte only, no
 * payload — `ControlMessageReader.read()`'s `createEmpty` branch),
 * `parseGetClipboard`/`parseSetClipboard`, and `parseSetDisplayPower`.
 */

const enc = new TextEncoder()

export function encodeInjectKeycode(action: 'down' | 'up', keycode: number, metaState = 0, repeat = 0): Uint8Array {
  const buf = new Uint8Array(14)
  const dv = new DataView(buf.buffer)
  dv.setUint8(0, CONTROL_MSG.INJECT_KEYCODE)
  dv.setUint8(1, action === 'down' ? KEY_ACTION.DOWN : KEY_ACTION.UP)
  dv.setUint32(2, keycode, false)
  dv.setUint32(6, repeat, false)
  dv.setUint32(10, metaState, false)
  return buf
}

export function encodeInjectText(text: string): Uint8Array {
  const body = enc.encode(text)
  const buf = new Uint8Array(5 + body.length)
  const dv = new DataView(buf.buffer)
  dv.setUint8(0, CONTROL_MSG.INJECT_TEXT)
  dv.setUint32(1, body.length, false)
  buf.set(body, 5)
  return buf
}

/**
 * Absolute touch: coordinates travel with the screen size at that moment, so
 * the device can remap them if the resolution changes (rotation).
 *
 * The pointer id decides what kind of input device Android thinks this is. The
 * default used to be POINTER_ID_MOUSE (-1), which makes the server build a
 * SOURCE_MOUSE event — and a mouse event with no button held is a hover, so
 * every tap was delivered and every tap did nothing. A finger id gives
 * SOURCE_TOUCHSCREEN, which is what a device farm actually wants to simulate.
 */
export function encodeInjectTouch(opts: {
  action: 'down' | 'up' | 'move'
  x: number
  y: number
  screenWidth: number
  screenHeight: number
  pointerId?: bigint
  pressure?: number
  actionButton?: number
  buttons?: number
}): Uint8Array {
  const buf = new Uint8Array(32)
  const dv = new DataView(buf.buffer)
  const action =
    opts.action === 'down' ? MOTION_ACTION.DOWN : opts.action === 'up' ? MOTION_ACTION.UP : MOTION_ACTION.MOVE
  dv.setUint8(0, CONTROL_MSG.INJECT_TOUCH_EVENT)
  dv.setUint8(1, action)
  dv.setBigUint64(2, BigInt.asUintN(64, opts.pointerId ?? POINTER_ID_GENERIC_FINGER), false)
  dv.setUint32(10, Math.round(opts.x), false)
  dv.setUint32(14, Math.round(opts.y), false)
  dv.setUint16(18, opts.screenWidth, false)
  dv.setUint16(20, opts.screenHeight, false)
  // pressure: u16 fixed-point 0..1 (0xffff = 1.0)
  const pressure = opts.pressure ?? (opts.action === 'up' ? 0 : 1)
  dv.setUint16(22, Math.round(Math.min(1, Math.max(0, pressure)) * 0xffff), false)
  dv.setUint32(24, opts.actionButton ?? 0, false)
  dv.setUint32(28, opts.buttons ?? 0, false)
  return buf
}

/**
 * `INJECT_SCROLL_EVENT` (plan 209 §4.3): [type u8][x i32][y i32][w u16][h u16]
 * [hscroll i16 fixed-point][vscroll i16 fixed-point][buttons u32] = 21 bytes.
 * `ControlMessageReader.parseInjectScrollEvent` decodes each i16 with
 * `Binary.i16FixedPointToFloat` (range -1..1) and then MULTIPLIES the result
 * by 16 — its own comment reads "the actual range is [-16, 16]" — so a caller
 * that wants one notch (`hscroll`/`vscroll` in -1..1, one notch = 1, matching
 * this package's own `injectScroll` contract) must pre-divide by 16 before
 * packing the fixed-point value, or the device sees 16x the requested scroll.
 * verified against v3.3.1 control/ControlMessageReader.java on 2026-09-04 (step 209.2).
 */
export function encodeInjectScroll(opts: { x: number; y: number; screenWidth: number; screenHeight: number; hscroll: number; vscroll: number; buttons?: number }): Uint8Array {
  const fp = (v: number) => Math.round((Math.min(1, Math.max(-1, v)) / 16) * 0x7fff)
  const buf = new Uint8Array(21)
  const dv = new DataView(buf.buffer)
  dv.setUint8(0, CONTROL_MSG.INJECT_SCROLL_EVENT)
  dv.setInt32(1, Math.round(opts.x), false)
  dv.setInt32(5, Math.round(opts.y), false)
  dv.setUint16(9, opts.screenWidth, false)
  dv.setUint16(11, opts.screenHeight, false)
  dv.setInt16(13, fp(opts.hscroll), false)
  dv.setInt16(15, fp(opts.vscroll), false)
  dv.setUint32(17, opts.buttons ?? 0, false)
  return buf
}

/**
 * Register a virtual HID device.
 *
 * `vendorId` and `productId` are two separate u16 fields. Sending one u16 for
 * the pair left every following field off by two bytes: the server read the
 * name length from the wrong offset, the create was rejected, and — because
 * the message is fire-and-forget — nothing surfaced. Input simply did nothing,
 * with no virtual pointer ever appearing in `dumpsys input`.
 */
export function encodeUhidCreate(id: number, name: string, reportDesc: Uint8Array): Uint8Array {
  const nameBytes = enc.encode(name).subarray(0, 255)
  const buf = new Uint8Array(1 + 2 + 2 + 2 + 1 + nameBytes.length + 2 + reportDesc.length)
  const dv = new DataView(buf.buffer)
  let off = 0
  dv.setUint8(off, CONTROL_MSG.UHID_CREATE)
  off += 1
  dv.setUint16(off, id, false)
  off += 2
  dv.setUint16(off, 0, false) // vendorId — 0 = unspecified
  off += 2
  dv.setUint16(off, 0, false) // productId — 0 = unspecified
  off += 2
  dv.setUint8(off, nameBytes.length)
  off += 1
  buf.set(nameBytes, off)
  off += nameBytes.length
  dv.setUint16(off, reportDesc.length, false)
  off += 2
  buf.set(reportDesc, off)
  return buf
}

export function encodeUhidInput(id: number, report: Uint8Array): Uint8Array {
  const buf = new Uint8Array(1 + 2 + 2 + report.length)
  const dv = new DataView(buf.buffer)
  dv.setUint8(0, CONTROL_MSG.UHID_INPUT)
  dv.setUint16(1, id, false)
  dv.setUint16(3, report.length, false)
  buf.set(report, 5)
  return buf
}

export function encodeUhidDestroy(id: number): Uint8Array {
  const buf = new Uint8Array(3)
  const dv = new DataView(buf.buffer)
  dv.setUint8(0, CONTROL_MSG.UHID_DESTROY)
  dv.setUint16(1, id, false)
  return buf
}

export function encodeResetVideo(): Uint8Array {
  return new Uint8Array([CONTROL_MSG.RESET_VIDEO])
}

/** `copyKey` → the byte the server's `ControlMessageReader` expects (plan 38 §4.1). */
const COPY_KEY = { none: 0, copy: 1, cut: 2 } as const

/**
 * Ask the server to reply with a `CLIPBOARD` device message (plan 38 §3.3,
 * §4.1). `copyKey` asks it to send a copy/cut keystroke FIRST so the current
 * *selection* becomes the clipboard; `none` (the default) reads the
 * clipboard as it already stands.
 */
export function encodeGetClipboard(copyKey: 'none' | 'copy' | 'cut' = 'none'): Uint8Array {
  return new Uint8Array([CONTROL_MSG.GET_CLIPBOARD, COPY_KEY[copyKey]])
}

/**
 * `[type u8][sequence u64BE][paste u8][len u32BE][utf8 text]` (plan 38 §3.4).
 * `sequence` is echoed back in the device's `ACK_CLIPBOARD` message, which is
 * how a caller knows the write actually landed rather than merely having been
 * sent — the control socket is fire-and-forget UDP-in-spirit-if-not-in-fact,
 * so nothing else confirms delivery. `paste` defaults to false: it makes the
 * device immediately paste into the focused field, which is useful but also
 * genuinely surprising if triggered by accident (plan 38 §3.4).
 */
export function encodeSetClipboard(sequence: bigint, text: string, paste = false): Uint8Array {
  const body = enc.encode(text)
  const buf = new Uint8Array(1 + 8 + 1 + 4 + body.length)
  const dv = new DataView(buf.buffer)
  dv.setUint8(0, CONTROL_MSG.SET_CLIPBOARD)
  dv.setBigUint64(1, BigInt.asUintN(64, sequence), false)
  dv.setUint8(9, paste ? 1 : 0)
  dv.setUint32(10, body.length, false)
  buf.set(body, 14)
  return buf
}

/**
 * Blank or restore the device's physical panel while the encoder keeps
 * producing frames (Plan 17 §3.5, §4.4). Verified against scrcpy 3.3.1's
 * `ControlMessageReader`: type 10 followed by exactly one boolean byte.
 */
export function encodeSetDisplayPower(on: boolean): Uint8Array {
  return new Uint8Array([CONTROL_MSG.SET_DISPLAY_POWER, on ? 1 : 0])
}
