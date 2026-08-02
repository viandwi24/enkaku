/**
 * HID descriptor pointer ABSOLUT (digitizer) — bukan mouse relatif.
 *
 * A farm needs "tap at (x,y)", while scrcpy's built-in UHID mouse is relative
 * (deltas). UHID_CREATE accepts an arbitrary report descriptor, so we register
 * a digitizer with absolute X/Y axes over logical 0..32767. Whether a given
 * kernel or ROM supports it is verified during device testing.
 */
export const POINTER_LOGICAL_MAX = 32767

// prettier-ignore
export const ABSOLUTE_POINTER_DESCRIPTOR = new Uint8Array([
  0x05, 0x0d,       // Usage Page (Digitizer)
  0x09, 0x02,       // Usage (Pen)
  0xa1, 0x01,       // Collection (Application)
  0x09, 0x20,       //   Usage (Stylus)
  0xa1, 0x00,       //   Collection (Physical)
  0x09, 0x42,       //     Usage (Tip Switch)
  0x15, 0x00,       //     Logical Minimum (0)
  0x25, 0x01,       //     Logical Maximum (1)
  0x75, 0x01,       //     Report Size (1)
  0x95, 0x01,       //     Report Count (1)
  0x81, 0x02,       //     Input (Data,Var,Abs)
  0x95, 0x07,       //     Report Count (7) — padding
  0x81, 0x03,       //     Input (Cnst,Var,Abs)
  0x05, 0x01,       //     Usage Page (Generic Desktop)
  0x09, 0x30,       //     Usage (X)
  0x09, 0x31,       //     Usage (Y)
  0x16, 0x00, 0x00, //     Logical Minimum (0)
  0x26, 0xff, 0x7f, //     Logical Maximum (32767)
  0x75, 0x10,       //     Report Size (16)
  0x95, 0x02,       //     Report Count (2)
  0x81, 0x02,       //     Input (Data,Var,Abs)
  0xc0,             //   End Collection
  0xc0,             // End Collection
])

/** Report: [buttons(1)] [xLo xHi] [yLo yHi] — koordinat dinormalisasi 0..1. */
export function buildPointerReport(opts: { touching: boolean; xNorm: number; yNorm: number }): Uint8Array {
  const clamp = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * POINTER_LOGICAL_MAX)
  const buf = new Uint8Array(5)
  const dv = new DataView(buf.buffer)
  dv.setUint8(0, opts.touching ? 1 : 0)
  dv.setUint16(1, clamp(opts.xNorm), true) // HID = little-endian
  dv.setUint16(3, clamp(opts.yNorm), true)
  return buf
}
