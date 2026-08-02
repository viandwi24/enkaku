/**
 * The ONLY source of the scrcpy-server version this client supports.
 *
 * The scrcpy client↔server protocol is internal and **changes between
 * versions with no compatibility guarantee** (Genymobile's own docs). Therefore:
 * - the jar version is pinned to this constant (Toolchain: `swappable: false`),
 * - raising the version is core-release work, not just editing a number:
 *   every TODO-verify assumption in this package must be re-checked against
 *   the new release's source.
 */
export const SCRCPY_VERSION = '3.3.1'

/** Path of the jar on the device (scrcpy convention). */
export const DEVICE_JAR_PATH = '/data/local/tmp/scrcpy-server.jar'

/**
 * Minimum API level for UHID (virtual HID through the kernel's UHID).
 * TODO-verify against the pinned version's limits during device testing.
 */
export const UHID_MIN_API = 29

/** The 4-character codec id in scrcpy's video metadata. */
export const CODEC_ID = {
  H264: 0x68323634, // 'h264'
  H265: 0x68323635, // 'h265'
  AV1: 0x00617631, // 'av1'
} as const

/** host→device control message types (TODO-verify the ordering against the pinned version). */
export const CONTROL_MSG = {
  INJECT_KEYCODE: 0,
  INJECT_TEXT: 1,
  INJECT_TOUCH_EVENT: 2,
  INJECT_SCROLL_EVENT: 3,
  BACK_OR_SCREEN_ON: 4,
  EXPAND_NOTIFICATION_PANEL: 5,
  EXPAND_SETTINGS_PANEL: 6,
  COLLAPSE_PANELS: 7,
  GET_CLIPBOARD: 8,
  SET_CLIPBOARD: 9,
  SET_DISPLAY_POWER: 10,
  ROTATE_DEVICE: 11,
  UHID_CREATE: 12,
  UHID_INPUT: 13,
  UHID_DESTROY: 14,
  OPEN_HARD_KEYBOARD_SETTINGS: 15,
  START_APP: 16,
  RESET_VIDEO: 17,
} as const

/** MotionEvent action Android. */
export const MOTION_ACTION = { DOWN: 0, UP: 1, MOVE: 2 } as const
/** KeyEvent action Android. */
export const KEY_ACTION = { DOWN: 0, UP: 1 } as const

/** The special pointer id for the virtual "mouse" (scrcpy uses -1 for it). */
export const POINTER_ID_MOUSE = -1n
export const POINTER_ID_GENERIC_FINGER = -2n
