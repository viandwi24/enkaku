import { describe, expect, test } from 'bun:test'
import { createZipStream, estimateArchiveBytes, sanitizeEntryName, ZipTooLargeError, type ZipEntryInput } from './zip-stream'

/**
 * An INDEPENDENT minimal zip reader, written for this test file only. It
 * shares no code with `zip-stream.ts` beyond the public functions under test
 * (`createZipStream`, `sanitizeEntryName`) — it walks the EOCD → central
 * directory → local headers exactly the way a third-party unzipper would,
 * re-deriving offsets and CRC-32s from scratch rather than trusting the
 * writer's own bookkeeping. This is what catches an off-by-one in a header
 * or a central directory that points at the wrong place — reading a zip back
 * with the SAME code that wrote it only proves the two agree with each
 * other, not that the file is a valid zip.
 */

const LOCAL_HEADER_SIGNATURE = 0x04034b50
const DATA_DESCRIPTOR_SIGNATURE = 0x08074b50
const CENTRAL_HEADER_SIGNATURE = 0x02014b50
const EOCD_SIGNATURE = 0x06054b50

/** A from-scratch, table-free CRC-32 — deliberately NOT the writer's table-based implementation. */
function independentCrc32(data: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of data) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

interface ReadEntry {
  name: string
  crc: number
  size: number
  localHeaderOffset: number
  data: Uint8Array
}

async function collectStream(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  const reader = stream.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
  }
  const total = chunks.reduce((n, c) => n + c.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.length
  }
  return out
}

/** Walks the archive independently: EOCD (scanned from the tail) → central directory → each local header + data + data descriptor, cross-checked at every step. */
function readZipIndependently(buf: Uint8Array): { entries: ReadEntry[]; eocd: { entryCount: number; centralDirSize: number; centralDirOffset: number } } {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)

  // Find the EOCD by scanning backward from the end — a real reader does not
  // assume a fixed offset from the tail (there could be a comment, though
  // this writer never sets one).
  let eocdPos = -1
  for (let i = buf.length - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === EOCD_SIGNATURE) {
      eocdPos = i
      break
    }
  }
  expect(eocdPos).toBeGreaterThanOrEqual(0)

  const entryCount = view.getUint16(eocdPos + 10, true)
  const centralDirSize = view.getUint32(eocdPos + 12, true)
  const centralDirOffset = view.getUint32(eocdPos + 16, true)

  // The central directory must end exactly where the EOCD begins — an
  // independent arithmetic check the writer's own offset bookkeeping never
  // performs on itself.
  expect(centralDirOffset + centralDirSize).toBe(eocdPos)

  const entries: ReadEntry[] = []
  let pos = centralDirOffset
  for (let i = 0; i < entryCount; i++) {
    expect(view.getUint32(pos, true)).toBe(CENTRAL_HEADER_SIGNATURE)
    const crc = view.getUint32(pos + 16, true)
    const compressedSize = view.getUint32(pos + 20, true)
    const uncompressedSize = view.getUint32(pos + 24, true)
    expect(compressedSize).toBe(uncompressedSize) // stored, never deflated
    const nameLen = view.getUint16(pos + 28, true)
    const extraLen = view.getUint16(pos + 30, true)
    const commentLen = view.getUint16(pos + 32, true)
    const localHeaderOffset = view.getUint32(pos + 42, true)
    const nameBytes = buf.subarray(pos + 46, pos + 46 + nameLen)
    const name = new TextDecoder().decode(nameBytes)
    pos += 46 + nameLen + extraLen + commentLen

    // Cross-check against the LOCAL header this central record points at.
    expect(view.getUint32(localHeaderOffset, true)).toBe(LOCAL_HEADER_SIGNATURE)
    const localNameLen = view.getUint16(localHeaderOffset + 26, true)
    const localExtraLen = view.getUint16(localHeaderOffset + 28, true)
    expect(localNameLen).toBe(nameLen)
    const localName = new TextDecoder().decode(buf.subarray(localHeaderOffset + 30, localHeaderOffset + 30 + localNameLen))
    expect(localName).toBe(name)

    const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen
    const data = buf.subarray(dataStart, dataStart + uncompressedSize)
    expect(data.length).toBe(uncompressedSize)

    // The data descriptor immediately follows the data.
    const descStart = dataStart + uncompressedSize
    expect(view.getUint32(descStart, true)).toBe(DATA_DESCRIPTOR_SIGNATURE)
    const descCrc = view.getUint32(descStart + 4, true)
    const descCompressedSize = view.getUint32(descStart + 8, true)
    const descUncompressedSize = view.getUint32(descStart + 12, true)
    expect(descCrc).toBe(crc)
    expect(descCompressedSize).toBe(compressedSize)
    expect(descUncompressedSize).toBe(uncompressedSize)

    // The real content-integrity check: an INDEPENDENT CRC-32 over the bytes
    // actually embedded in the archive must match what the central
    // directory (and the data descriptor) both claim.
    expect(independentCrc32(data)).toBe(crc)

    entries.push({ name, crc, size: uncompressedSize, localHeaderOffset, data })
  }

  return { entries, eocd: { entryCount, centralDirSize, centralDirOffset } }
}

function streamOf(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text)
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
}

describe('createZipStream — independently-read round trip', () => {
  test('offsets, sizes, and CRCs all check out for several entries of different sizes', async () => {
    const contents = {
      'pixel-abc123/screenshot.png': 'a'.repeat(5000),
      'pixel-abc123/logcat.txt': 'line one\nline two\n',
      'note20-def456/screenshot.png': 'b'.repeat(37), // deliberately a DIFFERENT name-colliding leaf under a different directory
    }
    const entries: ZipEntryInput[] = Object.entries(contents).map(([name, text]) => ({
      name,
      size: new TextEncoder().encode(text).length,
      open: () => streamOf(text),
    }))

    const stream = createZipStream(entries)
    const buf = await collectStream(stream)
    const { entries: read } = readZipIndependently(buf)

    expect(read.length).toBe(3)
    const byName = new Map(read.map((e) => [e.name, e]))
    for (const [name, text] of Object.entries(contents)) {
      const entry = byName.get(name)
      expect(entry).toBeDefined()
      expect(new TextDecoder().decode(entry!.data)).toBe(text)
    }
  })

  test('two devices whose pulled files share a filename land in different directories, not colliding', async () => {
    const entries: ZipEntryInput[] = [
      { name: 'pixel-abc123/screenshot.png', size: 3, open: () => streamOf('AAA') },
      { name: 'note20-def456/screenshot.png', size: 3, open: () => streamOf('BBB') },
    ]
    const buf = await collectStream(createZipStream(entries))
    const { entries: read } = readZipIndependently(buf)
    const names = read.map((e) => e.name).sort()
    expect(names).toEqual(['note20-def456/screenshot.png', 'pixel-abc123/screenshot.png'])
    expect(new TextDecoder().decode(read.find((e) => e.name === 'pixel-abc123/screenshot.png')!.data)).toBe('AAA')
    expect(new TextDecoder().decode(read.find((e) => e.name === 'note20-def456/screenshot.png')!.data)).toBe('BBB')
  })

  test('an exact duplicate entry name is suffixed " (2)" rather than overwriting the first', async () => {
    const entries: ZipEntryInput[] = [
      { name: 'pixel-abc123/dump.log', size: 3, open: () => streamOf('AAA') },
      { name: 'pixel-abc123/dump.log', size: 3, open: () => streamOf('BBB') },
      { name: 'pixel-abc123/dump.log', size: 3, open: () => streamOf('CCC') },
    ]
    const buf = await collectStream(createZipStream(entries))
    const { entries: read } = readZipIndependently(buf)
    const names = read.map((e) => e.name).sort()
    expect(names).toEqual(['pixel-abc123/dump (2).log', 'pixel-abc123/dump (3).log', 'pixel-abc123/dump.log'])
    expect(new TextDecoder().decode(read.find((e) => e.name === 'pixel-abc123/dump.log')!.data)).toBe('AAA')
    expect(new TextDecoder().decode(read.find((e) => e.name === 'pixel-abc123/dump (2).log')!.data)).toBe('BBB')
    expect(new TextDecoder().decode(read.find((e) => e.name === 'pixel-abc123/dump (3).log')!.data)).toBe('CCC')
  })

  test('a ".." escape attempt never produces an entry outside the archive root', async () => {
    const hostile = ['../../../etc/passwd', '/etc/passwd', 'pixel-abc123/../../evil.sh', '..\\..\\windows\\system32\\evil.exe']
    const entries: ZipEntryInput[] = hostile.map((name, i) => ({ name, size: 1, open: () => streamOf(String(i)) }))
    const buf = await collectStream(createZipStream(entries))
    const { entries: read } = readZipIndependently(buf)
    expect(read.length).toBe(hostile.length)
    for (const entry of read) {
      expect(entry.name.startsWith('/')).toBe(false)
      expect(entry.name.split('/')).not.toContain('..')
      expect(entry.name.split('/')).not.toContain('.')
      expect(entry.name.includes('\\')).toBe(false)
    }
    // The two "etc/passwd" attempts (`../../../etc/passwd` and `/etc/passwd`)
    // collapse to the SAME sanitised name and therefore get de-duplicated,
    // exactly like any other exact collision — never silently overwritten.
    expect(read.some((e) => e.name === 'etc/passwd')).toBe(true)
    expect(read.some((e) => e.name === 'etc/passwd (2)')).toBe(true)
  })

  test('sanitizeEntryName never leaves a leading ".." segment or an absolute path, whatever the input', () => {
    expect(sanitizeEntryName('../../secret')).toBe('secret')
    expect(sanitizeEntryName('/abs/path')).toBe('abs/path')
    expect(sanitizeEntryName('a/../../b')).toBe('a/b')
    expect(sanitizeEntryName('back\\slash\\path')).toBe('back/slash/path')
    expect(sanitizeEntryName('')).toBe('_')
    expect(sanitizeEntryName('..')).toBe('_')
  })

  test('an empty archive (zero entries) still produces a structurally valid EOCD', async () => {
    const buf = await collectStream(createZipStream([]))
    const { entries: read, eocd } = readZipIndependently(buf)
    expect(read.length).toBe(0)
    expect(eocd.entryCount).toBe(0)
    expect(eocd.centralDirSize).toBe(0)
  })
})

describe('createZipStream — refuses before the first byte', () => {
  test('an archive over maxTotalBytes throws synchronously, before any stream exists', () => {
    const entries: ZipEntryInput[] = [
      { name: 'a.bin', size: 10_000_000, open: () => streamOf('x') },
      { name: 'b.bin', size: 10_000_000, open: () => streamOf('x') },
    ]
    let thrown: unknown
    let stream: ReadableStream<Uint8Array> | undefined
    try {
      stream = createZipStream(entries, { maxTotalBytes: 1000 })
    } catch (err) {
      thrown = err
    }
    // No stream was ever handed back — nothing could have been written to a
    // response by a caller that checks the return value before writing.
    expect(stream).toBeUndefined()
    expect(thrown).toBeInstanceOf(ZipTooLargeError)
    expect((thrown as ZipTooLargeError).code).toBe('E_TRANSFER_TOO_LARGE')
  })

  test('an archive at or under maxTotalBytes is accepted', () => {
    const entries: ZipEntryInput[] = [{ name: 'a.bin', size: 10, open: () => streamOf('x') }]
    const estimate = estimateArchiveBytes(entries)
    expect(() => createZipStream(entries, { maxTotalBytes: estimate })).not.toThrow()
  })

  test('estimateArchiveBytes grows with entry count and declared size, independent of the writer', () => {
    const one = estimateArchiveBytes([{ name: 'a', size: 100 }])
    const two = estimateArchiveBytes([
      { name: 'a', size: 100 },
      { name: 'b', size: 100 },
    ])
    expect(two).toBeGreaterThan(one)
    const bigger = estimateArchiveBytes([{ name: 'a', size: 100_000 }])
    expect(bigger).toBeGreaterThan(one)
  })
})
