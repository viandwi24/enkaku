import { describe, expect, test } from 'bun:test'
import { openDb, runMigrations, type Db } from '../../db'
import { blobIdFor, createBlobStore, parseImageDimensions, sha256Hex, sniffImageMediaType } from './store'

function db(): Db {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  return opened.db
}

// --- minimal, valid headers for each format, built by hand from the spec ---

function pngHeader(width: number, height: number): Uint8Array {
  const b = new Uint8Array(33)
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0) // signature
  b.set([0, 0, 0, 13], 8) // IHDR length = 13
  b.set([0x49, 0x48, 0x44, 0x52], 12) // "IHDR"
  const dv = new DataView(b.buffer)
  dv.setUint32(16, width, false)
  dv.setUint32(20, height, false)
  b[24] = 8 // bit depth
  return b
}

function gifHeader(width: number, height: number): Uint8Array {
  const b = new Uint8Array(13)
  b.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61], 0) // "GIF89a"
  const dv = new DataView(b.buffer)
  dv.setUint16(6, width, true)
  dv.setUint16(8, height, true)
  return b
}

/** SOI, one APP0 segment, one minimal SOF0 segment. */
function jpegHeader(width: number, height: number): Uint8Array {
  const b = new Uint8Array(30)
  b.set([0xff, 0xd8], 0) // SOI
  b.set([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00], 2) // APP0, length 16
  const sof = 20
  b[sof] = 0xff
  b[sof + 1] = 0xc0 // SOF0
  const dv = new DataView(b.buffer)
  dv.setUint16(sof + 2, 11, false) // segment length
  b[sof + 4] = 8 // precision
  dv.setUint16(sof + 5, height, false)
  dv.setUint16(sof + 7, width, false)
  b[sof + 9] = 1 // one component
  return b
}

function webpVp8x(width: number, height: number): Uint8Array {
  const b = new Uint8Array(30)
  b.set([0x52, 0x49, 0x46, 0x46], 0) // "RIFF"
  b.set([0, 0, 0, 0], 4) // size — unused by the parser
  b.set([0x57, 0x45, 0x42, 0x50], 8) // "WEBP"
  b.set([0x56, 0x50, 0x38, 0x58], 12) // "VP8X"
  b.set([10, 0, 0, 0], 16) // chunk size (LE) = 10
  b[20] = 0 // flags
  const w1 = width - 1
  const h1 = height - 1
  b[24] = w1 & 0xff
  b[25] = (w1 >> 8) & 0xff
  b[26] = (w1 >> 16) & 0xff
  b[27] = h1 & 0xff
  b[28] = (h1 >> 8) & 0xff
  b[29] = (h1 >> 16) & 0xff
  return b
}

function webpVp8Lossy(width: number, height: number): Uint8Array {
  const b = new Uint8Array(30)
  b.set([0x52, 0x49, 0x46, 0x46], 0)
  b.set([0, 0, 0, 0], 4)
  b.set([0x57, 0x45, 0x42, 0x50], 8)
  b.set([0x56, 0x50, 0x38, 0x20], 12) // "VP8 "
  b.set([0, 0, 0, 0], 16)
  b.set([0, 0, 0], 20) // frame tag (key frame)
  b.set([0x9d, 0x01, 0x2a], 23) // start code
  const dv = new DataView(b.buffer)
  dv.setUint16(26, width & 0x3fff, true)
  dv.setUint16(28, height & 0x3fff, true)
  return b
}

describe('sniffImageMediaType', () => {
  test('recognises PNG, JPEG, GIF, WebP by magic bytes', () => {
    expect(sniffImageMediaType(pngHeader(1, 1))).toBe('image/png')
    expect(sniffImageMediaType(jpegHeader(1, 1))).toBe('image/jpeg')
    expect(sniffImageMediaType(gifHeader(1, 1))).toBe('image/gif')
    expect(sniffImageMediaType(webpVp8x(1, 1))).toBe('image/webp')
  })

  test('a mismatch (bytes that are none of the four) is null', () => {
    expect(sniffImageMediaType(new TextEncoder().encode('%PDF-1.4 not an image'))).toBeNull()
    expect(sniffImageMediaType(new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]))).toBeNull()
  })

  test('a truncated header (fewer bytes than the signature) is null, not a false positive', () => {
    expect(sniffImageMediaType(pngHeader(1, 1).slice(0, 4))).toBeNull()
    expect(sniffImageMediaType(new Uint8Array([0xff, 0xd8]))).toBeNull() // JPEG SOI alone
    expect(sniffImageMediaType(new Uint8Array([0x47, 0x49]))).toBeNull() // "GI" alone
  })

  test('a zero-byte body is null', () => {
    expect(sniffImageMediaType(new Uint8Array(0))).toBeNull()
  })
})

describe('parseImageDimensions', () => {
  test('PNG', () => {
    expect(parseImageDimensions(pngHeader(1080, 2400), 'image/png')).toEqual({ width: 1080, height: 2400 })
  })
  test('GIF', () => {
    expect(parseImageDimensions(gifHeader(320, 240), 'image/gif')).toEqual({ width: 320, height: 240 })
  })
  test('JPEG', () => {
    expect(parseImageDimensions(jpegHeader(640, 480), 'image/jpeg')).toEqual({ width: 640, height: 480 })
  })
  test('WebP (VP8X, extended)', () => {
    expect(parseImageDimensions(webpVp8x(800, 600), 'image/webp')).toEqual({ width: 800, height: 600 })
  })
  test('WebP (VP8, lossy)', () => {
    expect(parseImageDimensions(webpVp8Lossy(400, 300), 'image/webp')).toEqual({ width: 400, height: 300 })
  })
  test('a truncated header yields null rather than throwing', () => {
    expect(parseImageDimensions(pngHeader(10, 10).slice(0, 10), 'image/png')).toBeNull()
    expect(parseImageDimensions(new Uint8Array(0), 'image/jpeg')).toBeNull()
  })
})

describe('blobIdFor / sha256Hex', () => {
  test('is a deterministic sha256 of the bytes, prefixed', () => {
    const bytes = new TextEncoder().encode('hello world')
    expect(blobIdFor(bytes)).toBe(`sha256:${sha256Hex(bytes)}`)
    expect(sha256Hex(bytes)).toMatch(/^[0-9a-f]{64}$/)
    expect(sha256Hex(bytes)).toBe(sha256Hex(new TextEncoder().encode('hello world'))) // deterministic
    expect(sha256Hex(bytes)).not.toBe(sha256Hex(new TextEncoder().encode('hello world!')))
  })
})

describe('createBlobStore', () => {
  test('put/get round-trips the exact bytes and metadata', () => {
    const store = createBlobStore(db())
    const bytes = pngHeader(1080, 2400)
    const stored = store.put(bytes, 'image/png')
    expect(stored.mediaType).toBe('image/png')
    expect(stored.bytes).toBe(bytes.byteLength)
    expect(stored.width).toBe(1080)
    expect(stored.height).toBe(2400)

    const fetched = store.get(stored.id)
    expect(fetched).not.toBeNull()
    expect(fetched!.data).toEqual(bytes)
    expect(fetched!.id).toBe(stored.id)
  })

  test('two identical screenshots store ONE row — the second put reuses the first id (criterion 2)', () => {
    const store = createBlobStore(db())
    const bytes = pngHeader(1, 1)
    const first = store.put(bytes, 'image/png')
    const second = store.put(new Uint8Array(bytes), 'image/png') // a fresh copy, byte-identical
    expect(second.id).toBe(first.id)
  })

  test('different bytes produce different ids', () => {
    const store = createBlobStore(db())
    const a = store.put(pngHeader(1, 1), 'image/png')
    const b = store.put(pngHeader(2, 2), 'image/png')
    expect(a.id).not.toBe(b.id)
  })

  test('get on an unknown id is null', () => {
    const store = createBlobStore(db())
    expect(store.get('sha256:doesnotexist')).toBeNull()
    expect(store.info('sha256:doesnotexist')).toBeNull()
  })

  test('a zero-byte body still stores (dimensions null)', () => {
    const store = createBlobStore(db())
    const stored = store.put(new Uint8Array(0), 'image/png')
    expect(stored.bytes).toBe(0)
    expect(stored.width).toBeNull()
    expect(stored.height).toBeNull()
  })
})
