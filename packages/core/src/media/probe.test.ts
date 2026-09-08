import { describe, expect, test } from 'bun:test'
import { artifactKindFor, probeMedia } from './probe'

/**
 * The MP4 offsets in `probe.ts` are the risky part — a wrong one reads a
 * plausible number from the wrong place, which is worse than reading nothing.
 * So the fixtures here are BUILT as real boxes rather than hand-written byte
 * arrays: the test states the structure the spec describes, and the parser has
 * to agree with it.
 */

function box(type: string, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + payload.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, out.length)
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i)
  out.set(payload, 8)
  return out
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

function ftyp(brand = 'isom'): Uint8Array {
  const payload = new Uint8Array(8)
  for (let i = 0; i < 4; i++) payload[i] = brand.charCodeAt(i)
  return box('ftyp', payload)
}

/** `mvhd` v0: version+flags(4), creation(4), modification(4), timescale(4), duration(4). */
function mvhdV0(timescale: number, duration: number): Uint8Array {
  const p = new Uint8Array(100)
  const v = new DataView(p.buffer)
  v.setUint32(12, timescale)
  v.setUint32(16, duration)
  return box('mvhd', p)
}

/** `mvhd` v1 widens the two timestamps and the duration to 64 bits. */
function mvhdV1(timescale: number, duration: number): Uint8Array {
  const p = new Uint8Array(112)
  const v = new DataView(p.buffer)
  p[0] = 1
  v.setUint32(20, timescale)
  v.setUint32(24, 0)
  v.setUint32(28, duration)
  return box('mvhd', p)
}

/** `tkhd` — width/height are 16.16 fixed point, after the 36-byte matrix. */
function tkhd(width: number, height: number, version: 0 | 1 = 0): Uint8Array {
  const dimsAt = version === 1 ? 88 : 76
  const p = new Uint8Array(dimsAt + 8)
  const v = new DataView(p.buffer)
  p[0] = version
  v.setUint32(dimsAt, width << 16)
  v.setUint32(dimsAt + 4, height << 16)
  return box('tkhd', p)
}

const trak = (...inner: Uint8Array[]) => box('trak', concat(...inner))
const moov = (...inner: Uint8Array[]) => box('moov', concat(...inner))

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0x02, 0x80, 0, 0, 0x01, 0xe0])

describe('images', () => {
  test('a PNG is an image, with its declared dimensions', () => {
    expect(probeMedia(PNG)).toEqual({ kind: 'image', mimeType: 'image/png', width: 640, height: 480, durationMs: null })
  })

  test('an image never claims a duration, even a GIF that may animate', () => {
    const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x40, 0x00, 0x20, 0x00])
    const probe = probeMedia(gif)
    expect(probe.kind).toBe('image')
    expect(probe.durationMs).toBeNull()
  })
})

describe('video containers', () => {
  test('an MP4 reports its brand-derived type, duration and display size', () => {
    const file = concat(ftyp('isom'), moov(mvhdV0(1000, 15_000), trak(tkhd(1080, 1920))))
    expect(probeMedia(file)).toEqual({ kind: 'video', mimeType: 'video/mp4', width: 1080, height: 1920, durationMs: 15_000 })
  })

  test('a version-1 mvhd and tkhd read from their wider offsets', () => {
    const file = concat(ftyp('isom'), moov(mvhdV1(600, 12_000), trak(tkhd(720, 1280, 1))))
    expect(probeMedia(file)).toMatchObject({ width: 720, height: 1280, durationMs: 20_000 })
  })

  test('a non-integer timescale ratio is rounded to whole milliseconds', () => {
    // 90 kHz, the MPEG transport clock — 1 001 000 ticks is 11.12 s.
    const file = concat(ftyp('isom'), moov(mvhdV0(90_000, 1_001_000)))
    expect(probeMedia(file).durationMs).toBe(11_122)
  })

  /** An audio track carries 0x0, so the search must continue rather than stop at the first trak. */
  test('the first track with real dimensions wins, not the first track', () => {
    const file = concat(ftyp('isom'), moov(mvhdV0(1000, 1000), trak(tkhd(0, 0)), trak(tkhd(1920, 1080))))
    expect(probeMedia(file)).toMatchObject({ width: 1920, height: 1080 })
  })

  test('brands are reported honestly rather than all called mp4', () => {
    expect(probeMedia(concat(ftyp('qt  '), moov(mvhdV0(1, 1)))).mimeType).toBe('video/quicktime')
    expect(probeMedia(concat(ftyp('3gp4'), moov(mvhdV0(1, 1)))).mimeType).toBe('video/3gpp')
  })

  test('an M4A is audio, and audio is never given dimensions', () => {
    const probe = probeMedia(concat(ftyp('M4A '), moov(mvhdV0(1000, 5000), trak(tkhd(100, 100)))))
    expect(probe).toEqual({ kind: 'audio', mimeType: 'audio/mp4', width: null, height: null, durationMs: 5000 })
  })

  test('webm and matroska are identified but not walked — nothing is invented', () => {
    const webm = new Uint8Array(64)
    webm.set([0x1a, 0x45, 0xdf, 0xa3])
    webm.set([0x77, 0x65, 0x62, 0x6d], 24) // "webm" DocType, in the header window
    expect(probeMedia(webm)).toEqual({ kind: 'video', mimeType: 'video/webm', width: null, height: null, durationMs: null })
  })

  test('AVI is distinguished from a WebP, which shares the RIFF magic', () => {
    const avi = new Uint8Array(16)
    avi.set([0x52, 0x49, 0x46, 0x46])
    avi.set([0x41, 0x56, 0x49, 0x20], 8)
    expect(probeMedia(avi).mimeType).toBe('video/x-msvideo')

    const webp = new Uint8Array(16)
    webp.set([0x52, 0x49, 0x46, 0x46])
    webp.set([0x57, 0x45, 0x42, 0x50], 8)
    expect(probeMedia(webp).kind).toBe('image')
  })
})

describe('honest nulls', () => {
  test('a duration of zero is unknown, not a zero-length video', () => {
    expect(probeMedia(concat(ftyp(), moov(mvhdV0(1000, 0)))).durationMs).toBeNull()
  })

  test('the all-ones sentinel is unknown too — a live or fragmented file', () => {
    expect(probeMedia(concat(ftyp(), moov(mvhdV0(1000, 0xffff_ffff)))).durationMs).toBeNull()
  })

  test('an MP4 with no moov is still a video, with nothing claimed about it', () => {
    expect(probeMedia(ftyp())).toEqual({ kind: 'video', mimeType: 'video/mp4', width: null, height: null, durationMs: null })
  })

  test('a non-media file is other, with no type guessed from anything', () => {
    expect(probeMedia(new TextEncoder().encode('PK\\x03\\x04 not media'))).toEqual({
      kind: 'other',
      mimeType: null,
      width: null,
      height: null,
      durationMs: null,
    })
  })

  test('an empty buffer is other rather than a throw', () => {
    expect(probeMedia(new Uint8Array(0)).kind).toBe('other')
  })
})

describe('malformed input never throws or spins', () => {
  /** A box claiming a size past the buffer must end the walk, not be clamped and read anyway. */
  test('a box whose size runs past the end is refused', () => {
    const file = concat(ftyp(), new Uint8Array([0xff, 0xff, 0xff, 0xff, 0x6d, 0x6f, 0x6f, 0x76]))
    expect(probeMedia(file).durationMs).toBeNull()
  })

  /** A zero-length box header would otherwise advance the cursor by nothing, forever. */
  test('a box declaring a size below its own header does not loop', () => {
    const file = concat(ftyp(), new Uint8Array([0, 0, 0, 2, 0x6d, 0x6f, 0x6f, 0x76]))
    expect(probeMedia(file).durationMs).toBeNull()
  })

  test('a truncated moov yields nulls, not a partial read', () => {
    const file = concat(ftyp(), box('moov', new Uint8Array(4)))
    expect(probeMedia(file)).toMatchObject({ kind: 'video', width: null, durationMs: null })
  })
})

describe('artifactKindFor', () => {
  /** The column's enum predates this and has no `image`; `screenshot` is its word for a picture. */
  test('an image maps to the enum value that already means picture', () => {
    expect(artifactKindFor({ kind: 'image', mimeType: 'image/png', width: 1, height: 1, durationMs: null })).toBe('screenshot')
  })

  test('a video maps to video', () => {
    expect(artifactKindFor({ kind: 'video', mimeType: 'video/mp4', width: 1, height: 1, durationMs: 1 })).toBe('video')
  })

  /** Audio has no member of its own — inventing one nothing renders is the "declared, never read" class. */
  test('audio and everything else stay file', () => {
    expect(artifactKindFor({ kind: 'audio', mimeType: 'audio/mp4', width: null, height: null, durationMs: 1 })).toBe('file')
    expect(artifactKindFor({ kind: 'other', mimeType: null, width: null, height: null, durationMs: null })).toBe('file')
  })
})
