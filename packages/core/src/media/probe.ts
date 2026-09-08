import { parseImageDimensions, sniffImageMediaType } from '../agent/blob/store'

/**
 * What a file IS, read from its own bytes (plan 800 wave 4).
 *
 * An upload currently lands as `kind: 'file'` whatever it holds, with no media
 * type and no dimensions — so an MP4 an operator uploaded is indistinguishable
 * from a `.bin`, and nothing can offer "videos only" or draw a grid. This reads
 * the facts that make a file library a MEDIA library.
 *
 * **Everything here is host-side and dependency-free, and that is a
 * constraint, not a preference.** There is no ffmpeg or ffprobe anywhere in
 * this repo, and `LICENSES.md` is deliberate about what may be redistributed.
 * So: container and codec-level facts that can be read from a header are read;
 * anything needing a DECODER is not attempted. Concretely, there are no
 * thumbnails here. A video's poster frame is generated in the browser, which
 * already has a decoder — Studio's own `video.tsx` presenter proves it — so
 * storing one host-side would add a dependency, a file to write, and a file for
 * retention to sweep, all to duplicate something the client can do for free.
 *
 * Type is decided by SNIFFING MAGIC BYTES, never a declared `Content-Type` or a
 * filename (the same rule `sniffImageMediaType` states for plan 70): both are
 * only ever an assertion by whoever uploaded the file.
 */

/** The media families a library groups by. `other` is everything that is not media — an APK, a log, a zip. */
export type MediaKind = 'image' | 'video' | 'audio' | 'other'

export interface MediaProbe {
  kind: MediaKind
  /** Null when the bytes match nothing known — never guessed from the filename. */
  mimeType: string | null
  /** Pixels. Null for audio, for a container this cannot read, and for anything non-media. */
  width: number | null
  height: number | null
  /** Milliseconds. Null whenever it cannot be read rather than defaulted to 0, which would render as a zero-length video. */
  durationMs: number | null
}

const NOT_MEDIA: MediaProbe = { kind: 'other', mimeType: null, width: null, height: null, durationMs: null }

const ascii = (b: Uint8Array, o: number, n: number): string =>
  String.fromCharCode(...Array.from(b.subarray(o, o + n)))

const u32be = (b: Uint8Array, o: number): number =>
  ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0

/** JS numbers hold 2^53 exactly, and no real media duration approaches it, so a 64-bit field is read as two 32-bit halves. */
const u64be = (b: Uint8Array, o: number): number => u32be(b, o) * 2 ** 32 + u32be(b, o + 4)

/**
 * ISO base media (MP4/MOV/3GP) declares itself with an `ftyp` box first, whose
 * BRAND says which dialect. `qt  ` is QuickTime; everything else in practice is
 * an MP4 variant. The brand is not used to pick a parser — the box layout is
 * shared — only to report an honest mime type.
 */
function sniffIsoBmff(b: Uint8Array): string | null {
  if (b.length < 12 || ascii(b, 4, 4) !== 'ftyp') return null
  const brand = ascii(b, 8, 4)
  if (brand === 'qt  ') return 'video/quicktime'
  if (brand.startsWith('3g')) return 'video/3gpp'
  if (brand === 'M4A ') return 'audio/mp4'
  return 'video/mp4'
}

function sniffVideoMediaType(b: Uint8Array): string | null {
  const iso = sniffIsoBmff(b)
  if (iso) return iso
  // Matroska/WebM share the EBML magic; the DocType that follows says which,
  // and it appears early enough to find in the header window without parsing
  // EBML properly.
  if (b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) {
    const head = ascii(b, 0, Math.min(b.length, 64))
    return head.includes('webm') ? 'video/webm' : 'video/x-matroska'
  }
  // AVI: "RIFF"<size>"AVI "
  if (b.length >= 12 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'AVI ') return 'video/x-msvideo'
  return null
}

/**
 * Walks the top-level box list for `type`, returning its PAYLOAD.
 *
 * Bounded on purpose: a malformed or hostile file must not spin here. A box
 * claiming a size that runs past the buffer, or a size below the 8-byte header,
 * ends the walk rather than being clamped — a file that lies about its own
 * structure is one this cannot read, and saying so is better than reading a
 * field from wherever the arithmetic landed.
 */
function findBox(b: Uint8Array, type: string, start = 0, end = b.length): Uint8Array | null {
  let offset = start
  while (offset + 8 <= end) {
    let size = u32be(b, offset)
    let header = 8
    if (size === 1) {
      if (offset + 16 > end) return null
      size = u64be(b, offset + 8)
      header = 16
    } else if (size === 0) {
      // "to end of file" — legal, and the last box by definition.
      size = end - offset
    }
    if (size < header || offset + size > end) return null
    if (ascii(b, offset + 4, 4) === type) return b.subarray(offset + header, offset + size)
    offset += size
  }
  return null
}

/**
 * Duration from `moov/mvhd`: a timescale (ticks per second) and a duration in
 * those ticks. Version 1 widens both timestamps and the duration to 64 bits,
 * which is why the field offsets differ rather than the meaning.
 *
 * A `duration` of 0 or all-ones means "unknown" in the spec (a live or
 * fragmented file), and is reported as null rather than as a zero-length video.
 */
function mp4DurationMs(moov: Uint8Array): number | null {
  const mvhd = findBox(moov, 'mvhd')
  if (!mvhd || mvhd.length < 4) return null
  const version = mvhd[0]!
  let timescale: number
  let duration: number
  if (version === 1) {
    if (mvhd.length < 32) return null
    timescale = u32be(mvhd, 20)
    duration = u64be(mvhd, 24)
  } else {
    if (mvhd.length < 20) return null
    timescale = u32be(mvhd, 12)
    duration = u32be(mvhd, 16)
  }
  if (timescale <= 0 || duration <= 0 || duration === 0xffff_ffff) return null
  return Math.round((duration / timescale) * 1000)
}

/**
 * Display dimensions from a track header, in the first `trak` that has any.
 *
 * `tkhd`'s width/height are 16.16 FIXED POINT — the DISPLAY size after the
 * track's matrix, which is what a viewer sees and therefore what a gallery
 * should show. An audio track carries 0×0, which is exactly why the search
 * continues to the next `trak` instead of stopping at the first.
 *
 * The rotation matrix is not applied: a portrait phone video is often stored
 * landscape with a 90° matrix. Reporting the stored size is honest and
 * cheap; claiming a rotated size without implementing the transform would be
 * a guess. Studio's own `<video>` element applies the matrix when it plays.
 */
function mp4Dimensions(moov: Uint8Array): { width: number; height: number } | null {
  let offset = 0
  while (offset + 8 <= moov.length) {
    let size = u32be(moov, offset)
    let header = 8
    if (size === 1) {
      if (offset + 16 > moov.length) return null
      size = u64be(moov, offset + 8)
      header = 16
    } else if (size === 0) {
      size = moov.length - offset
    }
    if (size < header || offset + size > moov.length) return null

    if (ascii(moov, offset + 4, 4) === 'trak') {
      const tkhd = findBox(moov.subarray(offset + header, offset + size), 'tkhd')
      if (tkhd && tkhd.length >= 4) {
        const version = tkhd[0]!
        // Both layouts end with matrix(36) then width(4) then height(4); the
        // fields before the matrix are what version widens.
        const dimsAt = version === 1 ? 88 : 76
        if (tkhd.length >= dimsAt + 8) {
          // 16.16 fixed point — the integer part is the whole pixel count.
          const width = u32be(tkhd, dimsAt) >>> 16
          const height = u32be(tkhd, dimsAt + 4) >>> 16
          if (width > 0 && height > 0) return { width, height }
        }
      }
    }
    offset += size
  }
  return null
}

/**
 * Everything readable about a file, from its bytes alone.
 *
 * Never throws: a truncated, malformed or hostile file yields `other` with
 * nulls. A probe is a best-effort enrichment of a file that has already been
 * accepted and stored, so failing it must never fail the upload — the file is
 * still perfectly usable as an opaque one.
 */
export function probeMedia(bytes: Uint8Array): MediaProbe {
  try {
    const image = sniffImageMediaType(bytes)
    if (image) {
      const dims = parseImageDimensions(bytes, image)
      return {
        kind: 'image',
        mimeType: image,
        width: dims?.width ?? null,
        height: dims?.height ?? null,
        // An animated GIF or WebP has a duration, but reading it means decoding
        // the frame stream. Not attempted rather than half-read.
        durationMs: null,
      }
    }

    const video = sniffVideoMediaType(bytes)
    if (!video) return NOT_MEDIA

    const kind: MediaKind = video.startsWith('audio/') ? 'audio' : 'video'
    // Only ISO base media is parsed further. WebM, Matroska and AVI are
    // identified but not walked: each needs its own container parser, and a
    // wrong offset reads a plausible number from the wrong place, which is
    // worse than reporting nothing.
    const moov = sniffIsoBmff(bytes) ? findBox(bytes, 'moov') : null
    if (!moov) return { kind, mimeType: video, width: null, height: null, durationMs: null }

    const dims = kind === 'video' ? mp4Dimensions(moov) : null
    return {
      kind,
      mimeType: video,
      width: dims?.width ?? null,
      height: dims?.height ?? null,
      durationMs: mp4DurationMs(moov),
    }
  } catch {
    return NOT_MEDIA
  }
}

/**
 * The `artifacts.kind` value a probe implies.
 *
 * That column's enum predates this and is `screenshot | log | file | video`, so
 * an image maps to `screenshot` — the value the enum already has for "this is a
 * picture". Renaming it would touch every producer and every reader for a word,
 * so the mapping is stated here once instead.
 *
 * Audio has no member of its own and stays `file`. It is not media this product
 * shows anywhere, and inventing an enum value nothing renders would be the
 * "declared, never read" class this repo keeps paying for.
 */
export function artifactKindFor(probe: MediaProbe): 'screenshot' | 'video' | 'file' {
  if (probe.kind === 'image') return 'screenshot'
  if (probe.kind === 'video') return 'video'
  return 'file'
}
