const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

export function isPng(buf: Uint8Array): boolean {
  if (buf.length < 24) return false
  return PNG_SIGNATURE.every((b, i) => buf[i] === b)
}

/** Parse IHDR: width = u32BE offset 16, height = u32BE offset 20. */
export function parsePngSize(buf: Uint8Array): { width: number; height: number } {
  if (!isPng(buf)) throw new Error('not a valid PNG (bad signature or too short)')
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  return { width: dv.getUint32(16, false), height: dv.getUint32(20, false) }
}
