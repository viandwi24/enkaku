import { eq } from 'drizzle-orm'
import type { AgentImageMediaType } from '@enkaku/protocol'
import type { Db } from '../../db'
import { agentBlobs, type AgentBlobRow } from '../../db/schema'

/**
 * The blob store (plan 70 §4.1, step 70.1) — hashing, dedupe, magic-byte
 * sniffing, and PNG/JPEG/WebP/GIF dimension parsing from a few dozen header
 * bytes, no decoding and no image-codec dependency (§3.3, §9.1). Pure and
 * fully tested first; everything else (the loop, the blob API) trusts it.
 *
 * A blob's id IS its content hash (`sha256:<hex>`), so it is immutable by
 * construction and two identical screenshots dedupe for free (criterion 2):
 * `put` is a plain "insert if this hash is not already a row" — there is no
 * update path at all.
 */

export const IMAGE_MEDIA_TYPES: readonly AgentImageMediaType[] = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']

export interface BlobInfo {
  id: string
  mediaType: string
  bytes: number
  width: number | null
  height: number | null
}

export interface StoredBlob extends BlobInfo {
  data: Uint8Array
}

export interface BlobStore {
  /**
   * Hashes `bytes`, parses its dimensions from the header, and stores it
   * under its content address — a second call with identical bytes reuses
   * the same row rather than writing a duplicate (criterion 2). `mediaType`
   * is the caller's OWN sniffed result (`sniffImageMediaType`); this
   * function does not re-sniff — sniffing decides ACCEPTANCE, this function
   * only ever stores.
   */
  put(bytes: Uint8Array, mediaType: AgentImageMediaType): BlobInfo
  /** The full stored bytes plus metadata, or null when no such blob exists (a 404 upstream). */
  get(id: string): StoredBlob | null
  /** Metadata only, no bytes — cheaper when a caller only needs to know a blob exists. */
  info(id: string): BlobInfo | null
}

export function sha256Hex(bytes: Uint8Array): string {
  const hasher = new Bun.CryptoHasher('sha256')
  hasher.update(bytes)
  return hasher.digest('hex')
}

/** `sha256:<hex>` — the id IS the hash (plan 70 §4.1). */
export function blobIdFor(bytes: Uint8Array): string {
  return `sha256:${sha256Hex(bytes)}`
}

/**
 * Media type decided by SNIFFING MAGIC BYTES (plan 70 §3.5) — never a
 * declared `Content-Type` or a filename, because a client-declared type is
 * only ever an assertion and the store must not hold an executable that a
 * browser will later be asked to render. Null when the bytes match none of
 * the four accepted image types (including a body too short to tell).
 */
export function sniffImageMediaType(bytes: Uint8Array): AgentImageMediaType | null {
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) {
    return 'image/png'
  }
  // JPEG: FF D8 FF
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg'
  }
  // GIF: "GIF87a" or "GIF89a"
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38 && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61) {
    return 'image/gif'
  }
  // WebP: "RIFF"<4-byte size>"WEBP"
  if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    return 'image/webp'
  }
  return null
}

function u16be(b: Uint8Array, o: number): number {
  return (b[o]! << 8) | b[o + 1]!
}

function u32be(b: Uint8Array, o: number): number {
  return ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0
}

function u16le(b: Uint8Array, o: number): number {
  return b[o]! | (b[o + 1]! << 8)
}

function u24le(b: Uint8Array, o: number): number {
  return b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16)
}

function parsePngDimensions(b: Uint8Array): { width: number; height: number } | null {
  // 8-byte signature, then the first chunk (always IHDR): length(4) type(4) width(4) height(4) ...
  if (b.length < 24) return null
  const width = u32be(b, 16)
  const height = u32be(b, 20)
  return width > 0 && height > 0 ? { width, height } : null
}

function parseGifDimensions(b: Uint8Array): { width: number; height: number } | null {
  if (b.length < 10) return null
  const width = u16le(b, 6)
  const height = u16le(b, 8)
  return width > 0 && height > 0 ? { width, height } : null
}

/** Walks JPEG markers from byte 2 until a Start-Of-Frame segment (SOF0–SOF15, excluding the DHT/JPG/DAC marker values), reading its embedded height/width. */
function parseJpegDimensions(b: Uint8Array): { width: number; height: number } | null {
  let offset = 2
  while (offset + 4 <= b.length) {
    if (b[offset] !== 0xff) {
      offset++
      continue
    }
    const marker = b[offset + 1]!
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2
      continue
    }
    if (marker === 0xd9 || marker === 0xda) return null // EOI or start-of-scan — no SOF found first
    const segLen = u16be(b, offset + 2)
    const isSOF = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    if (isSOF) {
      if (offset + 9 > b.length) return null
      const height = u16be(b, offset + 5)
      const width = u16be(b, offset + 7)
      return width > 0 && height > 0 ? { width, height } : null
    }
    if (segLen < 2) return null // malformed — refuse to loop forever
    offset += 2 + segLen
  }
  return null
}

/** VP8 (lossy), VP8L (lossless), and VP8X (extended) — the three WebP chunk shapes libwebp defines; each packs width/height differently right after the 20-byte RIFF/WEBP/chunk header. */
function parseWebpDimensions(b: Uint8Array): { width: number; height: number } | null {
  if (b.length < 21) return null
  const fourcc = String.fromCharCode(b[12]!, b[13]!, b[14]!, b[15]!)
  if (fourcc === 'VP8X') {
    if (b.length < 30) return null
    const width = 1 + u24le(b, 24)
    const height = 1 + u24le(b, 27)
    return { width, height }
  }
  if (fourcc === 'VP8L') {
    if (b.length < 25 || b[20] !== 0x2f) return null
    const bits = b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24)
    const width = (bits & 0x3fff) + 1
    const height = ((bits >>> 14) & 0x3fff) + 1
    return { width, height }
  }
  if (fourcc === 'VP8 ') {
    if (b.length < 30) return null
    // 3-byte uncompressed frame tag (offset 20), then the 3-byte start code 9d 01 2a.
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null
    const width = u16le(b, 26) & 0x3fff
    const height = u16le(b, 28) & 0x3fff
    return width > 0 && height > 0 ? { width, height } : null
  }
  return null
}

/** Dimensions from the header alone — no decoding (plan 70 §4.1). Null on a truncated or unrecognised header; a blob is still stored without dimensions rather than refused (the budget in §3.6 degrades to "unknown", never a hard failure). */
export function parseImageDimensions(bytes: Uint8Array, mediaType: AgentImageMediaType): { width: number; height: number } | null {
  try {
    if (mediaType === 'image/png') return parsePngDimensions(bytes)
    if (mediaType === 'image/gif') return parseGifDimensions(bytes)
    if (mediaType === 'image/jpeg') return parseJpegDimensions(bytes)
    if (mediaType === 'image/webp') return parseWebpDimensions(bytes)
  } catch {
    return null
  }
  return null
}

function rowToInfo(row: AgentBlobRow): BlobInfo {
  return { id: row.id, mediaType: row.mediaType, bytes: row.bytes, width: row.width ?? null, height: row.height ?? null }
}

export function createBlobStore(db: Db): BlobStore {
  function getRow(id: string): AgentBlobRow | null {
    return db.select().from(agentBlobs).where(eq(agentBlobs.id, id)).get() ?? null
  }

  return {
    put(bytes, mediaType) {
      const id = blobIdFor(bytes)
      const existing = getRow(id)
      if (existing) return rowToInfo(existing) // dedupe — criterion 2, the common case (an unchanged screen)

      const dims = parseImageDimensions(bytes, mediaType)
      const row: AgentBlobRow = {
        id,
        mediaType,
        bytes: bytes.byteLength,
        width: dims?.width ?? null,
        height: dims?.height ?? null,
        data: Buffer.from(bytes),
        createdAt: new Date(),
      }
      try {
        db.insert(agentBlobs).values(row).run()
      } catch (err) {
        // A genuine race (two calls storing the same hash at once) loses to whichever won —
        // reuse its row rather than surfacing a transient error to a caller that did nothing wrong.
        const msg = err instanceof Error ? err.message : String(err)
        if (!msg.includes('UNIQUE constraint failed')) throw err
        const raced = getRow(id)
        if (raced) return rowToInfo(raced)
        throw err
      }
      return rowToInfo(row)
    },

    get(id) {
      const row = getRow(id)
      if (!row) return null
      return { ...rowToInfo(row), data: new Uint8Array(row.data) }
    },

    info(id) {
      const row = getRow(id)
      return row ? rowToInfo(row) : null
    },
  }
}
