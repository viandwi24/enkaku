import { AdbError } from '../errors'

/**
 * The adb transport wire format (plan 27 §3.2, §4.1) — the same 24-byte
 * framing `adbd` speaks over TCP/USB to the host's adb server. This module
 * is pure: no sockets, no state, just encode/decode/validate, so it can be
 * exhaustively property-tested without a peer of any kind (plan 27 §27.2).
 *
 * Command constants and the header layout come from AOSP's
 * `system/core/adb/protocol.txt`. All fields are little-endian, matching
 * every host platform adb ships on (ARM/x86, never big-endian).
 */

const A_SYNC = 0x434e5953
export const A_CNXN = 0x4e584e43
export const A_OPEN = 0x4e45504f
export const A_OKAY = 0x59414b4f
export const A_CLSE = 0x45534c43
export const A_WRTE = 0x45545257
export const A_AUTH = 0x48545541

const COMMAND_NAMES: Record<number, string> = {
  [A_SYNC]: 'SYNC',
  [A_CNXN]: 'CNXN',
  [A_OPEN]: 'OPEN',
  [A_OKAY]: 'OKAY',
  [A_CLSE]: 'CLSE',
  [A_WRTE]: 'WRTE',
  [A_AUTH]: 'AUTH',
}

/** A human label for logging — falls back to the raw hex value for an unknown command. */
export function commandName(command: number): string {
  return COMMAND_NAMES[command] ?? `0x${(command >>> 0).toString(16)}`
}

export const HEADER_BYTES = 24

/**
 * The connect version this shim speaks (plan 27 §27.1 spike measurement): a
 * real `adb` client (platform-tools 36.0.0, adb protocol as of 2024) sent
 * exactly `CNXN` `arg0=0x01000001` — `A_VERSION_SKIP_CHECKSUM` in AOSP's
 * `adb/transport.h`. From this version on, `data_check` is not verified by
 * either side, so `checksum()` below is what this shim WRITES into
 * `data_check`; nothing verifies an inbound one.
 */
export const CONNECT_VERSION = 0x01000001

/**
 * The ceiling this shim ever advertises or accepts, regardless of what a
 * peer proposes — matches the 1 MiB (`1_048_576`) the spike measured a real
 * adb client requesting as its own `maxdata`. `clampMaxdata` never lets
 * either side exceed this, so a single WRTE payload never has to be
 * fragmented across more than one frame at this ceiling.
 */
export const MAX_MAXDATA = 1024 * 1024

/** Below this, a peer's proposed `maxdata` is almost certainly corrupt, not "conservative" — adbd's own historical floor. */
export const MIN_MAXDATA = 4096

export interface AdbdHeader {
  command: number
  arg0: number
  arg1: number
  dataLength: number
  dataCheck: number
  magic: number
}

/**
 * The classic adb "checksum" — a plain sum of the payload's bytes mod 2^32,
 * NOT a real CRC32 despite `protocol.txt`'s wording (AOSP's own
 * `adb/transport.cpp:calculate_apacket_checksum` is exactly this). Kept only
 * for symmetry with an older peer; the spike confirmed a
 * current adb client neither sends nor checks a meaningful value here.
 */
export function checksum(data: Uint8Array): number {
  let sum = 0
  for (const b of data) sum = (sum + b) >>> 0
  return sum >>> 0
}

/** Encode a full frame (24-byte header + payload) ready to write to the wire. */
export function encodeFrame(command: number, arg0: number, arg1: number, data?: Uint8Array): Uint8Array {
  const payload = data ?? new Uint8Array(0)
  const magic = (command ^ 0xffffffff) >>> 0
  const out = new Uint8Array(HEADER_BYTES + payload.length)
  const view = new DataView(out.buffer, out.byteOffset, HEADER_BYTES)
  view.setUint32(0, command >>> 0, true)
  view.setUint32(4, arg0 >>> 0, true)
  view.setUint32(8, arg1 >>> 0, true)
  view.setUint32(12, payload.length >>> 0, true)
  view.setUint32(16, checksum(payload), true)
  view.setUint32(20, magic, true)
  out.set(payload, HEADER_BYTES)
  return out
}

/**
 * Decode exactly `HEADER_BYTES` into a header, validating the magic
 * (`command ^ 0xffffffff`) — the one cheap integrity check every adb peer
 * performs before trusting `data_length` enough to read that many more
 * bytes. Throws `E_ADB_PROTOCOL` on a short buffer or a bad magic; never
 * partially decodes.
 */
export function decodeHeader(bytes: Uint8Array): AdbdHeader {
  if (bytes.length < HEADER_BYTES) {
    throw new AdbError('E_ADB_PROTOCOL', `adb header truncated: got ${bytes.length} of ${HEADER_BYTES} bytes`)
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, HEADER_BYTES)
  const command = view.getUint32(0, true)
  const arg0 = view.getUint32(4, true)
  const arg1 = view.getUint32(8, true)
  const dataLength = view.getUint32(12, true)
  const dataCheck = view.getUint32(16, true)
  const magic = view.getUint32(20, true)
  const expectedMagic = (command ^ 0xffffffff) >>> 0
  if (magic !== expectedMagic) {
    throw new AdbError(
      'E_ADB_PROTOCOL',
      `bad adb frame magic: command=${commandName(command)} magic=0x${magic.toString(16)} expected=0x${expectedMagic.toString(16)}`,
    )
  }
  return { command, arg0, arg1, dataLength, dataCheck, magic }
}

/**
 * Clamp a proposed `maxdata` into `[MIN_MAXDATA, MAX_MAXDATA]`. Defensive
 * against a hostile or malformed peer (NaN, negative, absurdly large) as
 * much as against a merely small one — this shim's own ceiling always wins.
 */
export function clampMaxdata(requested: number): number {
  if (!Number.isFinite(requested) || requested <= 0) return MIN_MAXDATA
  return Math.min(MAX_MAXDATA, Math.max(MIN_MAXDATA, Math.floor(requested)))
}

/** Strip the adb wire protocol's NUL terminator(s) from a service/banner string, e.g. `"shell:echo hi\0"` → `"shell:echo hi"`. */
export function stripTrailingNul(text: string): string {
  return text.replace(/\0+$/, '')
}
