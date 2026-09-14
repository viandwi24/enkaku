import { inflateSync } from 'node:zlib'

/**
 * Just enough PNG to compare one part of two screenshots (0.30.0).
 *
 * YouTube's details screen is hidden from the farm's reader (see
 * `post-video.ts`'s header), so the only way to know what it looks like is its
 * screenshot. Two questions `post-video` has to answer there need only PART of
 * the frame to be compared, not the whole file:
 *
 * - is the keyboard gone from where Upload is? — the Upload button's band;
 * - did the Upload tap change anything? — everything but the status bar, whose
 *   clock would otherwise make two frames a minute apart differ.
 *
 * `ctx.device.screenshot()` is a raw PNG (`screencap -p`: 8-bit RGBA, not
 * interlaced). Only 8-bit, non-interlaced greyscale/RGB/RGBA is decoded; any
 * other file is `null`, and the caller treats that as "cannot be compared" —
 * never as "the same".
 */

export type Raster = { width: number; height: number; channels: number; data: Uint8Array }

/** A rectangle as fractions of the frame, so another resolution scales. */
export type Region = { top: number; bottom: number; left: number; right: number }

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10]
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 4: 2, 6: 4 }

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

/** A PNG's size from its IHDR alone, without decoding (0.31.0 — the details screen's orientation). `null` for anything that is not a PNG. */
export function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 24) return null
  for (let i = 0; i < SIGNATURE.length; i++) if (bytes[i] !== SIGNATURE[i]) return null
  if (String.fromCharCode(bytes[12] as number, bytes[13] as number, bytes[14] as number, bytes[15] as number) !== 'IHDR') return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return { width: view.getUint32(16), height: view.getUint32(20) }
}

export function decodePng(bytes: Uint8Array): Raster | null {
  try {
    if (bytes.length < 33) return null
    for (let i = 0; i < SIGNATURE.length; i++) if (bytes[i] !== SIGNATURE[i]) return null
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    let offset = 8
    let width = 0
    let height = 0
    let channels = 0
    const parts: Uint8Array[] = []
    while (offset + 8 <= bytes.length) {
      const length = view.getUint32(offset)
      const type = String.fromCharCode(bytes[offset + 4] as number, bytes[offset + 5] as number, bytes[offset + 6] as number, bytes[offset + 7] as number)
      const body = bytes.subarray(offset + 8, offset + 8 + length)
      if (type === 'IHDR') {
        width = view.getUint32(offset + 8)
        height = view.getUint32(offset + 12)
        const depth = body[8]
        const colour = body[9] as number
        const interlace = body[12]
        if (depth !== 8 || interlace !== 0 || CHANNELS[colour] === undefined) return null
        channels = CHANNELS[colour] as number
      } else if (type === 'IDAT') {
        parts.push(body)
      } else if (type === 'IEND') {
        break
      }
      offset += 12 + length
    }
    if (width === 0 || height === 0 || channels === 0 || parts.length === 0) return null
    const joined = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
    let at = 0
    for (const p of parts) {
      joined.set(p, at)
      at += p.length
    }
    const inflated = inflateSync(joined)
    const stride = width * channels
    if (inflated.length < height * (stride + 1)) return null
    const data = new Uint8Array(stride * height)
    for (let y = 0; y < height; y++) {
      const src = y * (stride + 1)
      const filter = inflated[src]
      const row = y * stride
      const prev = row - stride
      for (let x = 0; x < stride; x++) {
        const raw = inflated[src + 1 + x] as number
        const a = x >= channels ? (data[row + x - channels] as number) : 0
        const b = y > 0 ? (data[prev + x] as number) : 0
        const c = x >= channels && y > 0 ? (data[prev + x - channels] as number) : 0
        switch (filter) {
          case 0: data[row + x] = raw; break
          case 1: data[row + x] = raw + a; break
          case 2: data[row + x] = raw + b; break
          case 3: data[row + x] = raw + ((a + b) >> 1); break
          case 4: data[row + x] = raw + paeth(a, b, c); break
          default: return null
        }
      }
    }
    return { width, height, channels, data }
  } catch {
    return null
  }
}

/** True when `region` holds exactly the same pixels in both frames. Frames of different sizes are never the same. */
export function sameRegion(a: Raster, b: Raster, region: Region): boolean {
  if (a.width !== b.width || a.height !== b.height || a.channels !== b.channels) return false
  const clamp = (v: number, max: number): number => Math.max(0, Math.min(max, v))
  const top = clamp(Math.floor(region.top * a.height), a.height)
  const bottom = clamp(Math.ceil(region.bottom * a.height), a.height)
  const left = clamp(Math.floor(region.left * a.width), a.width)
  const right = clamp(Math.ceil(region.right * a.width), a.width)
  for (let y = top; y < bottom; y++) {
    const base = y * a.width
    for (let i = (base + left) * a.channels, end = (base + right) * a.channels; i < end; i++) {
      if (a.data[i] !== b.data[i]) return false
    }
  }
  return true
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/**
 * Compare `region` of two screenshots. Identical files are `same` without
 * decoding; files that cannot be decoded are `unreadable`, which a caller must
 * never read as `same`.
 */
export function compareShots(a: Uint8Array, b: Uint8Array, region: Region): 'same' | 'different' | 'unreadable' {
  if (bytesEqual(a, b)) return 'same'
  const ra = decodePng(a)
  const rb = decodePng(b)
  if (!ra || !rb) return 'unreadable'
  return sameRegion(ra, rb, region) ? 'same' : 'different'
}
