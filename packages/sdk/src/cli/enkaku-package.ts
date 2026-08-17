import { SURFACE_LIMITS } from '@enkaku/protocol'

/**
 * Writes the `.enkaku` package (plan 108 §3.8) the CLI sends to
 * `POST /api/plugins` and — since plan 111 §4.4 — to `POST /api/plugins/dev`:
 *
 * ```
 * <plugin>.enkaku   (tar.gz)
 *   plugin.json        { name, version, source? }
 *   scripts.mjs        the script bundle
 *   ui/**              the built React entries and their static files
 * ```
 *
 * **Why this is not `packages/core/src/plugins/package.ts`.** That module is
 * the authority on this format — it holds the reader, the entry allowlist and
 * the budget the farm enforces — but `enkaku-core` DEPENDS on `@enkaku/sdk`
 * (`packages/core/package.json`), so the SDK importing core back would close a
 * cycle. The writer therefore lives here, and the two are kept honest by a
 * round-trip test on the core side (`plugins/package.test.ts`) that feeds this
 * function's output straight into `readPluginPackage` — drift fails a test
 * rather than an author's publish.
 *
 * Everything below is deliberately a *writer only*, over the same three entry
 * shapes core's reader allows, refusing by NAME rather than repairing a path
 * for exactly the reason §3.8 gives: a repaired name is a name whose safety
 * depends on the repair being right.
 */

/** Concrete, `ArrayBuffer`-backed bytes — what `Bun.gzipSync` requires and what a `fetch` body takes. */
type Bytes = Uint8Array<ArrayBuffer>

export const PACKAGE_MANIFEST_ENTRY = 'plugin.json'
export const PACKAGE_SCRIPTS_ENTRY = 'scripts.mjs'
export const PACKAGE_UI_PREFIX = 'ui/'

/** The content type `POST /api/plugins` and `POST /api/plugins/dev` read as a package rather than as JSON. */
export const PACKAGE_CONTENT_TYPE = 'application/octet-stream'

/** One file destined for `ui/`, its path RELATIVE to `ui/` — `ui/index.js` is `{ path: 'index.js' }`. */
export interface UiAsset {
  path: string
  data: Bytes
}

export interface EnkakuPackageInput {
  name: string
  version: string
  source?: string
  scripts: string
  ui?: readonly UiAsset[]
}

/** The same `ui/` segment grammar `isUiAssetPath` enforces on the farm — copied, not approximated, so a package this writes is never one the reader refuses. */
const UI_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const MAX_ENTRY_NAME_BYTES = 100
const BLOCK_SIZE = 512

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

/** One 512-byte USTAR header for a regular file — byte-for-byte what `backup/tar.ts`'s `ustarHeader` writes, which is the only header shape the farm's reader understands. */
function ustarHeader(name: string, size: number, mtimeSec: number): Bytes {
  const enc = new TextEncoder()
  const h = new Uint8Array(BLOCK_SIZE)
  const setStr = (offset: number, s: string, max: number) => h.set(enc.encode(s).subarray(0, max), offset)
  const setOctal = (offset: number, value: number, digits: number) => setStr(offset, value.toString(8).padStart(digits, '0'), digits)

  setStr(0, name, 100)
  setOctal(100, 0o644, 7)
  setOctal(108, 0, 7)
  setOctal(116, 0, 7)
  setOctal(124, size, 11)
  setOctal(136, mtimeSec, 11)
  h.fill(0x20, 148, 156)
  h[156] = 0x30
  setStr(257, 'ustar', 5)
  setStr(263, '00', 2)
  setStr(265, 'enkaku', 6)
  setStr(297, 'enkaku', 6)

  let sum = 0
  for (let i = 0; i < BLOCK_SIZE; i++) sum += h[i] ?? 0
  setStr(148, sum.toString(8).padStart(6, '0'), 6)
  h[154] = 0
  h[155] = 0x20
  return h
}

interface Entry {
  name: string
  data: Bytes
}

function createTarGz(entries: Entry[], mtimeSec: number): Bytes {
  const parts: Bytes[] = []
  for (const entry of entries) {
    parts.push(ustarHeader(entry.name, entry.data.length, mtimeSec))
    parts.push(entry.data)
    const pad = (BLOCK_SIZE - (entry.data.length % BLOCK_SIZE)) % BLOCK_SIZE
    if (pad > 0) parts.push(new Uint8Array(pad))
  }
  parts.push(new Uint8Array(BLOCK_SIZE * 2))
  return Bun.gzipSync(concatBytes(parts))
}

/**
 * Refuses a `ui/` path the farm would refuse, in the author's own terminal and
 * before a byte is sent. The message names the file, because the author's next
 * move is to rename or move it.
 */
export function checkUiAssetPath(path: string): void {
  const name = `${PACKAGE_UI_PREFIX}${path}`
  if (new TextEncoder().encode(name).length > MAX_ENTRY_NAME_BYTES) {
    throw new Error(`"${name}" is longer than ${MAX_ENTRY_NAME_BYTES} bytes, which a .enkaku package's plain USTAR header cannot hold — shorten the path`)
  }
  for (const segment of path.split('/')) {
    if (!UI_SEGMENT.test(segment)) {
      throw new Error(
        `"${name}" has an unusable path segment "${segment}" — a plugin's ui/ path may use only letters, digits, ".", "_" and "-", and each segment must start with a letter or a digit`,
      )
    }
  }
}

/**
 * Builds the archive. Deterministic for identical inputs: entries are sorted
 * and the archive mtime is fixed at 0, so an unchanged project produces
 * identical bytes and a dev-slot re-push is comparable build to build.
 */
export function writeEnkakuPackage(input: EnkakuPackageInput): Bytes {
  const enc = new TextEncoder()
  const manifest = { name: input.name, version: input.version, ...(input.source !== undefined ? { source: input.source } : {}) }
  const entries: Entry[] = [
    { name: PACKAGE_MANIFEST_ENTRY, data: enc.encode(`${JSON.stringify(manifest, null, 2)}\n`) },
    { name: PACKAGE_SCRIPTS_ENTRY, data: enc.encode(input.scripts) },
  ]

  const seen = new Set<string>()
  let uiBytes = 0
  for (const asset of [...(input.ui ?? [])].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    checkUiAssetPath(asset.path)
    const name = `${PACKAGE_UI_PREFIX}${asset.path}`
    if (seen.has(name)) throw new Error(`"${name}" was given twice — a .enkaku package may not declare the same path more than once`)
    seen.add(name)
    uiBytes += asset.data.length
    entries.push({ name, data: asset.data })
  }
  if (uiBytes > SURFACE_LIMITS.maxUiBytes) {
    throw new Error(`the plugin's ui/ output is ${uiBytes} bytes, over the farm's limit of ${SURFACE_LIMITS.maxUiBytes} (maxUiBytes) — nothing was published`)
  }

  return createTarGz(entries, 0)
}
