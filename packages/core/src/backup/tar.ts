/**
 * A minimal, dependency-free POSIX ustar writer/reader, gzip-wrapped via
 * `Bun.gzipSync`/`Bun.gunzipSync`.
 *
 * Why hand-roll this instead of shelling out to the system `tar`: the core
 * ships as one self-contained compiled binary per platform (see
 * `docs/guide/install.md` §0 — "nothing else is needed"), including on
 * Windows, where a bundled `tar.exe` cannot be assumed reliably across every
 * supported version. `Bun.spawn(['tar', ...])` would quietly reintroduce
 * exactly the external-tool dependency the release binary otherwise avoids.
 * The format only ever needs to hold a handful of small, known files (a
 * database snapshot, a 32-byte key file, a text manifest), so a full tar
 * implementation (long names, sparse files, hard links, ...) is unnecessary
 * — this covers only the USTAR subset `createTar`'s callers actually use.
 */

const BLOCK_SIZE = 512

/** Concrete, `ArrayBuffer`-backed bytes — what `Bun.gzipSync`/`gunzipSync` require (they reject the broader `ArrayBufferLike`, which also admits `SharedArrayBuffer`). */
type Bytes = Uint8Array<ArrayBuffer>

export interface TarEntry {
  name: string
  data: Bytes
}

function concatBytes(parts: Bytes[]): Bytes {
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

function padLength(size: number): number {
  return (BLOCK_SIZE - (size % BLOCK_SIZE)) % BLOCK_SIZE
}

/** One 512-byte USTAR header for a regular file. */
function ustarHeader(name: string, size: number, mtimeSec: number): Bytes {
  const enc = new TextEncoder()
  const nameBytes = enc.encode(name)
  if (nameBytes.length > 100) {
    throw new Error(`tar entry name too long for a plain USTAR header (max 100 bytes): ${name}`)
  }

  const h = new Uint8Array(BLOCK_SIZE) // zero-initialised — doubles as NUL padding for every field below
  const setStr = (offset: number, s: string, max: number) => h.set(enc.encode(s).subarray(0, max), offset)
  const setOctal = (offset: number, value: number, digits: number) => setStr(offset, value.toString(8).padStart(digits, '0'), digits)

  setStr(0, name, 100) // name
  setOctal(100, 0o644, 7) // mode
  setOctal(108, 0, 7) // uid
  setOctal(116, 0, 7) // gid
  setOctal(124, size, 11) // size
  setOctal(136, mtimeSec, 11) // mtime
  h.fill(0x20, 148, 156) // chksum placeholder: 8 ASCII spaces while summing
  h[156] = 0x30 // typeflag '0' — regular file (POSIX ustar)
  setStr(257, 'ustar', 5) // magic "ustar\0" — byte 262 stays NUL from the zero-init
  setStr(263, '00', 2) // ustar version
  setStr(265, 'enkaku', 6) // uname
  setStr(297, 'enkaku', 6) // gname

  let sum = 0
  for (let i = 0; i < BLOCK_SIZE; i++) sum += h[i] ?? 0
  // POSIX chksum convention: six octal digits, a NUL, then a space.
  setStr(148, sum.toString(8).padStart(6, '0'), 6)
  h[154] = 0
  h[155] = 0x20
  return h
}

/** Builds an uncompressed USTAR archive from `entries`, in order. */
export function createTar(entries: TarEntry[], mtimeSec = Math.floor(Date.now() / 1000)): Bytes {
  const parts: Bytes[] = []
  for (const entry of entries) {
    parts.push(ustarHeader(entry.name, entry.data.length, mtimeSec))
    parts.push(entry.data)
    const pad = padLength(entry.data.length)
    if (pad > 0) parts.push(new Uint8Array(pad))
  }
  parts.push(new Uint8Array(BLOCK_SIZE * 2)) // two all-zero blocks mark end-of-archive
  return concatBytes(parts)
}

/** `createTar` + gzip, in one call. */
export function createTarGz(entries: TarEntry[], mtimeSec?: number): Bytes {
  return Bun.gzipSync(createTar(entries, mtimeSec))
}

/** Reads back a `createTar` archive. Only understands the subset `ustarHeader` writes — not a general-purpose tar reader. */
export function readTar(tar: Bytes): TarEntry[] {
  const dec = new TextDecoder()
  const entries: TarEntry[] = []
  let offset = 0
  while (offset + BLOCK_SIZE <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK_SIZE)
    if (header.every((b) => b === 0)) break // end-of-archive marker
    const name = dec.decode(header.subarray(0, 100)).replace(/\0[\s\S]*$/, '')
    const sizeField = dec.decode(header.subarray(124, 136)).replace(/\0[\s\S]*$/, '').trim()
    const size = sizeField.length > 0 ? Number.parseInt(sizeField, 8) : 0
    offset += BLOCK_SIZE
    entries.push({ name, data: tar.slice(offset, offset + size) })
    offset += size + padLength(size)
  }
  return entries
}

/** gunzip + `readTar`, in one call. */
export function readTarGz(archive: Bytes): TarEntry[] {
  return readTar(Bun.gunzipSync(archive))
}
