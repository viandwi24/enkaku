/**
 * The farm's virtual finger: an absolute, single-contact TOUCH SCREEN registered over UHID.
 *
 * A farm needs "tap at (x,y)", while scrcpy's built-in UHID mouse is relative
 * (deltas). UHID_CREATE accepts an arbitrary report descriptor, so we register
 * a digitizer with absolute X/Y axes over logical 0..32767.
 *
 * ## Why a finger and not a pen
 *
 * This used to declare `Digitizer / Pen / Stylus` (plan 08 asked for a
 * "digitizer/touchscreen descriptor"; the pen was never a decision). Android
 * reads a pen as a STYLUS, and on the owner's production Samsung SM-A075F
 * fleet (2026-09-14) that showed as a mouse-style arrow left on the screen:
 * every tap first lands its position with the tip up, which to Android is a
 * stylus hovering, and Android 14+ draws a pointer for a hovering stylus
 * (`dumpsys input` → `PointerChoreographer: stylus pointer icon enabled: true`,
 * measured on the Android 15 emulator). Every touch also reached apps as
 * `TOOL_TYPE_STYLUS`, which is not what a person's thumb produces.
 *
 * A `Touch Screen` application whose contact is a `Finger` with a `Contact
 * Identifier` is what the kernel's `hid-multitouch` driver binds to (the HID
 * core puts such a descriptor in the multitouch group; `CONFIG_HID_MULTITOUCH`
 * is in the Android GKI config). That driver marks the device
 * `INPUT_PROP_DIRECT` and reports `BTN_TOOL_FINGER`, so Android maps it as a
 * touch screen with finger tool type: no hover, no pointer icon.
 *
 * Deliberately NO `In Range` usage (so a tip-up report is "no contact", never
 * a hovering finger) and NO Feature report (`Contact Count Maximum`): the
 * driver would ask for it with UHID_GET_REPORT, which scrcpy's server never
 * answers, and the probe would stall on the timeout. Without it the driver
 * uses its default maximum, and we only ever report one contact.
 */
export const POINTER_LOGICAL_MAX = 32767

// prettier-ignore
export const ABSOLUTE_POINTER_DESCRIPTOR = new Uint8Array([
  0x05, 0x0d,       // Usage Page (Digitizer)
  0x09, 0x04,       // Usage (Touch Screen)
  0xa1, 0x01,       // Collection (Application)
  0x09, 0x22,       //   Usage (Finger)
  0xa1, 0x02,       //   Collection (Logical)
  0x09, 0x42,       //     Usage (Tip Switch)
  0x15, 0x00,       //     Logical Minimum (0)
  0x25, 0x01,       //     Logical Maximum (1)
  0x75, 0x01,       //     Report Size (1)
  0x95, 0x01,       //     Report Count (1)
  0x81, 0x02,       //     Input (Data,Var,Abs)
  0x95, 0x07,       //     Report Count (7) — padding
  0x81, 0x03,       //     Input (Cnst,Var,Abs)
  0x09, 0x51,       //     Usage (Contact Identifier)
  0x25, 0x7f,       //     Logical Maximum (127)
  0x75, 0x08,       //     Report Size (8)
  0x95, 0x01,       //     Report Count (1)
  0x81, 0x02,       //     Input (Data,Var,Abs)
  0x05, 0x01,       //     Usage Page (Generic Desktop)
  0x09, 0x30,       //     Usage (X)
  0x09, 0x31,       //     Usage (Y)
  0x16, 0x00, 0x00, //     Logical Minimum (0)
  0x26, 0xff, 0x7f, //     Logical Maximum (32767)
  0x75, 0x10,       //     Report Size (16)
  0x95, 0x02,       //     Report Count (2)
  0x81, 0x02,       //     Input (Data,Var,Abs)
  0xc0,             //   End Collection
  0x05, 0x0d,       //   Usage Page (Digitizer)
  0x09, 0x54,       //   Usage (Contact Count)
  0x15, 0x00,       //   Logical Minimum (0)
  0x25, 0x01,       //   Logical Maximum (1)
  0x75, 0x08,       //   Report Size (8)
  0x95, 0x01,       //   Report Count (1)
  0x81, 0x02,       //   Input (Data,Var,Abs)
  0xc0,             // End Collection
])

/**
 * Report: [tip(1 bit) + padding] [contact id] [xLo xHi] [yLo yHi] [contact count] — coordinates normalised 0..1.
 *
 * The contact is always id 0 and the count always 1: a tip-up report is that same contact lifting, which releases the
 * slot, rather than a report with no contacts (which some driver quirks read as "nothing changed").
 */
export function buildPointerReport(opts: { touching: boolean; xNorm: number; yNorm: number }): Uint8Array {
  const clamp = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * POINTER_LOGICAL_MAX)
  const buf = new Uint8Array(7)
  const dv = new DataView(buf.buffer)
  dv.setUint8(0, opts.touching ? 1 : 0)
  dv.setUint8(1, 0)
  dv.setUint16(2, clamp(opts.xNorm), true) // HID = little-endian
  dv.setUint16(4, clamp(opts.yNorm), true)
  dv.setUint8(6, 1)
  return buf
}
