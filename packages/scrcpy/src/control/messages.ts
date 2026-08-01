import { CONTROL_MSG, KEY_ACTION, MOTION_ACTION, POINTER_ID_MOUSE } from '../version'

/**
 * Encoder control message host→device (plan 08 §4.2).
 * Layout byte TODO-verify terhadap source versi pinned.
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
 * Touch absolut: koordinat dikirim bersama ukuran layar saat itu supaya
 * device bisa memetakan ulang kalau resolusi berubah (rotasi).
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
  dv.setBigUint64(2, BigInt.asUintN(64, opts.pointerId ?? POINTER_ID_MOUSE), false)
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

export function encodeUhidCreate(id: number, name: string, reportDesc: Uint8Array): Uint8Array {
  const nameBytes = enc.encode(name).subarray(0, 255)
  const buf = new Uint8Array(1 + 2 + 2 + 1 + nameBytes.length + 2 + reportDesc.length)
  const dv = new DataView(buf.buffer)
  let off = 0
  dv.setUint8(off, CONTROL_MSG.UHID_CREATE)
  off += 1
  dv.setUint16(off, id, false)
  off += 2
  // vendorId & productId (0 = tidak spesifik) — TODO-verify field ini ada di versi pinned.
  dv.setUint16(off, 0, false)
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
