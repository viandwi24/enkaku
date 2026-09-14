import { describe, expect, test } from 'bun:test'
import { deflateSync } from 'node:zlib'
import { compareShots, decodePng, pngSize, sameRegion } from './screen-pixels'

/**
 * `screen-pixels` against PNGs built here: every scanline filter PNG defines,
 * so a real `screencap -p` (which may use any of them) decodes the same.
 */

describe('pngSize — the orientation of a screenshot without decoding it (0.31.0)', () => {
  test('reads width and height from the header', () => {
    expect(pngSize(encodeRgba(3, 2, new Uint8Array(3 * 2 * 4)))).toEqual({ width: 3, height: 2 })
    expect(pngSize(encodeRgba(2, 5, new Uint8Array(2 * 5 * 4)))).toEqual({ width: 2, height: 5 })
  })

  test('anything that is not a PNG has no size', () => {
    expect(pngSize(new Uint8Array(40))).toBeNull()
    expect(pngSize(new Uint8Array([137, 80, 78, 71]))).toBeNull()
  })
})

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (const b of bytes) {
    c ^= b
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  }
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + body.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, body.length)
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i)
  out.set(body, 8)
  view.setUint32(8 + body.length, crc32(out.subarray(4, 8 + body.length)))
  return out
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

/** An 8-bit RGBA PNG of `pixels`, row `y` written with filter `y % 5`. */
function encodeRgba(width: number, height: number, pixels: Uint8Array): Uint8Array {
  const stride = width * 4
  const raw = new Uint8Array(height * (stride + 1))
  for (let y = 0; y < height; y++) {
    const filter = y % 5
    raw[y * (stride + 1)] = filter
    for (let x = 0; x < stride; x++) {
      const v = pixels[y * stride + x] as number
      const a = x >= 4 ? (pixels[y * stride + x - 4] as number) : 0
      const b = y > 0 ? (pixels[(y - 1) * stride + x] as number) : 0
      const c = x >= 4 && y > 0 ? (pixels[(y - 1) * stride + x - 4] as number) : 0
      const predicted = [0, a, b, (a + b) >> 1, paeth(a, b, c)][filter] as number
      raw[y * (stride + 1) + 1 + x] = (v - predicted) & 0xff
    }
  }
  const header = new Uint8Array(13)
  new DataView(header.buffer).setUint32(0, width)
  new DataView(header.buffer).setUint32(4, height)
  header.set([8, 6, 0, 0, 0], 8)
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', new Uint8Array())]
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

/** A 20x40 frame of varied pixels, so every filter has something to predict. */
function frame(): Uint8Array {
  const px = new Uint8Array(20 * 40 * 4)
  for (let i = 0; i < px.length; i++) px[i] = (i * 37 + (i >> 3) * 11) & 0xff
  return px
}

const BAND = { top: 0.9, bottom: 1, left: 0, right: 1 }

describe('decodePng', () => {
  test('decodes every scanline filter back to the exact pixels', () => {
    const px = frame()
    const raster = decodePng(encodeRgba(20, 40, px))
    expect(raster?.width).toBe(20)
    expect(raster?.height).toBe(40)
    expect(raster?.channels).toBe(4)
    expect(raster?.data).toEqual(px)
  })

  test('anything that is not a decodable PNG is null, never a guess', () => {
    expect(decodePng(new Uint8Array([1, 2, 3]))).toBeNull()
    expect(decodePng(new TextEncoder().encode('not a png at all, just some text bytes here'))).toBeNull()
  })
})

describe('comparing part of two screenshots', () => {
  test('a change inside the band is seen there and nowhere else', () => {
    const a = frame()
    const b = frame()
    b[(38 * 20 + 3) * 4] = (b[(38 * 20 + 3) * 4] as number) ^ 0xff // row 38 of 40: inside the bottom 10%
    const ra = decodePng(encodeRgba(20, 40, a))
    const rb = decodePng(encodeRgba(20, 40, b))
    if (!ra || !rb) throw new Error('fixture PNG did not decode')
    expect(sameRegion(ra, rb, BAND)).toBe(false)
    expect(sameRegion(ra, rb, { top: 0, bottom: 0.9, left: 0, right: 1 })).toBe(true)
  })

  test('compareShots: identical files are same, a changed band is different, garbage is unreadable', () => {
    const a = encodeRgba(20, 40, frame())
    const changedTop = frame()
    changedTop[0] = (changedTop[0] as number) ^ 0xff // row 0: the status bar, outside the band
    const changedBottom = frame()
    changedBottom[(39 * 20 + 10) * 4 + 1] = (changedBottom[(39 * 20 + 10) * 4 + 1] as number) ^ 0xff
    expect(compareShots(a, a, BAND)).toBe('same')
    expect(compareShots(a, encodeRgba(20, 40, changedTop), BAND)).toBe('same')
    expect(compareShots(a, encodeRgba(20, 40, changedBottom), BAND)).toBe('different')
    expect(compareShots(a, new Uint8Array([9, 9, 9]), BAND)).toBe('unreadable')
  })

  test('frames of different sizes are never the same', () => {
    const ra = decodePng(encodeRgba(20, 40, frame()))
    const rb = decodePng(encodeRgba(20, 40, frame()).slice())
    const small = decodePng(encodeRgba(10, 20, new Uint8Array(10 * 20 * 4)))
    if (!ra || !rb || !small) throw new Error('fixture PNG did not decode')
    expect(sameRegion(ra, rb, BAND)).toBe(true)
    expect(sameRegion(ra, small, BAND)).toBe(false)
  })
})
