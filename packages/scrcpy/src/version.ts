/**
 * SATU-SATUNYA sumber versi scrcpy-server yang didukung client ini.
 *
 * Protokol client↔server scrcpy bersifat internal dan **berubah antar versi
 * tanpa jaminan kompatibilitas** (dokumentasi Genymobile). Karena itu:
 * - versi jar di-pin ke konstanta ini (Toolchain: `swappable: false`),
 * - menaikkan versi = pekerjaan rilis core, bukan sekadar ganti angka:
 *   seluruh asumsi ber-tanda TODO-verify di package ini wajib dicek ulang
 *   terhadap source rilis yang baru.
 */
export const SCRCPY_VERSION = '3.3.1'

/** Path jar di device (konvensi scrcpy). */
export const DEVICE_JAR_PATH = '/data/local/tmp/scrcpy-server.jar'

/**
 * API level minimum untuk UHID (virtual HID lewat kernel UHID).
 * TODO-verify terhadap batasan versi pinned saat uji device.
 */
export const UHID_MIN_API = 29

/** Codec id 4-char di metadata video scrcpy. */
export const CODEC_ID = {
  H264: 0x68323634, // 'h264'
  H265: 0x68323635, // 'h265'
  AV1: 0x00617631, // 'av1'
} as const

/** Tipe control message host→device (TODO-verify urutan terhadap versi pinned). */
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

/** Pointer id khusus untuk "mouse" virtual (scrcpy memakai -1 sbg pointer mouse). */
export const POINTER_ID_MOUSE = -1n
export const POINTER_ID_GENERIC_FINGER = -2n
