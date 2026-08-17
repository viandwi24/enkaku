import { z } from 'zod'
import { SURFACE_LIMITS } from '@enkaku/protocol'
import { createTarGz, readTarGz, type TarEntry } from '../backup/tar'
import { EnkakuError } from '../util/errors'

/**
 * The `.enkaku` package (plan 108 §3.8, step 108.2) — one file that carries a
 * plugin's manifest, its script bundle, and (tier B) its `ui/` assets.
 *
 * ```
 * <plugin>.enkaku   (tar.gz)
 *   plugin.json        the manifest
 *   scripts.mjs        the script bundle
 *   ui/                iframe assets (tier B only)
 * ```
 *
 * gzipped USTAR, written and read through `../backup/tar.ts` — the
 * dependency-free writer/reader that already exists precisely so the release
 * binary needs no system `tar` on any platform (plan 108 G10). No new
 * dependency, no base64 bloat, and no second archive implementation.
 *
 * **The entry allowlist is the security property**, not a convenience: an
 * entry that is not exactly `plugin.json`, exactly `scripts.mjs`, or a file
 * under `ui/` is refused by NAME, quoting the offending entry (§3.8's "closes
 * path traversal by construction rather than by sanitising"). Nothing here
 * rewrites, normalises, or cleans a path — a bad name is rejected, never
 * repaired, because a repaired name is a name whose safety depends on the
 * repair being right.
 *
 * Two notes on what this module deliberately does NOT do:
 *
 * - **It never touches the filesystem.** `readPluginPackage` returns bytes in
 *   memory; extraction, if a caller ever wants one, is that caller's problem
 *   and its own allowlist check. That is also why a symlink entry authored by
 *   a foreign archiver is harmless here: `readTar` understands only the
 *   regular-file subset `createTar` writes and reads such an entry back as a
 *   plain named file, at which point the same name allowlist below refuses it
 *   unless its name is one this format permits.
 * - **It does not enforce the plugin's own semantics.** Whether `scripts.mjs`
 *   is a valid bundle, and whether the surface it declares is valid, is the
 *   verification child's job (`verify-child.ts`), in a child process, exactly
 *   as for a bundle that arrived as JSON.
 */

/** Concrete, `ArrayBuffer`-backed bytes — what `Bun.gzipSync`/`gunzipSync` (and therefore `../backup/tar.ts`) require. */
type Bytes = Uint8Array<ArrayBuffer>

export const PACKAGE_MANIFEST_ENTRY = 'plugin.json'
export const PACKAGE_SCRIPTS_ENTRY = 'scripts.mjs'
export const PACKAGE_UI_PREFIX = 'ui/'

/**
 * The one content type `POST /api/plugins` reads as a package rather than as
 * JSON. `application/gzip` is accepted alongside it because that is what a
 * `curl --data-binary @plugin.enkaku` with content sniffing, or a browser
 * `File` drop of a `.gz`-typed blob, tends to send — the same bytes either
 * way.
 */
const PACKAGE_CONTENT_TYPES = new Set(['application/octet-stream', 'application/gzip'])

/** True when a request's `content-type` header names a `.enkaku` package (parameters like `; charset=` ignored). */
export function isPluginPackageContentType(header: string | undefined): boolean {
  const base = (header ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
  return PACKAGE_CONTENT_TYPES.has(base)
}

/**
 * `plugin.json`. Exactly what staging a plugin needs and nothing else —
 * `name`, `version`, and the optional `source` `POST /api/plugins`'s JSON body
 * already accepts, so the two transports stage identical rows. Everything
 * else a plugin declares (its title, its description, its members, its
 * surface) is read from the BUNDLE by the verification child, which is the
 * only reader that has actually executed nothing and imported everything;
 * duplicating any of it here would create a second, unverified copy that
 * could disagree with the bundle.
 *
 * `.strict()` because a mistyped key in a hand-written manifest should be a
 * named refusal, not a silently ignored field.
 */
export const PluginPackageManifestSchema = z
  .object({
    /** The plugin name — the same `[a-z0-9][a-z0-9-]*` shape `PluginRuntime.stage` re-checks. */
    name: z.string().min(1).max(64),
    /** Semver, matching `POST /api/plugins`'s own `StageBody`. */
    version: z.string().regex(/^\d+\.\d+\.\d+(?:[-+].+)?$/),
    source: z.string().optional(),
  })
  .strict()
export type PluginPackageManifest = z.infer<typeof PluginPackageManifestSchema>

/** One file under `ui/`, its path RELATIVE to `ui/` — `ui/app/index.html` is `{ path: 'app/index.html' }`, which is exactly what a view's `frame.entry` names (§4.2). */
export interface PluginPackageAsset {
  path: string
  data: Bytes
}

export interface PluginPackage {
  manifest: PluginPackageManifest
  /** `scripts.mjs`, decoded as UTF-8 — the same single-file ESM bundle the JSON transport sends as a string. */
  scripts: string
  ui: PluginPackageAsset[]
}

export interface WritePluginPackageInput {
  manifest: PluginPackageManifest
  scripts: string
  ui?: PluginPackageAsset[]
  /** Fixed archive mtime, so a build can be byte-reproducible. Defaults to now, matching `createTar`. */
  mtimeSec?: number
}

function refuse(message: string): never {
  throw new EnkakuError('E_PLUGIN_PACKAGE_INVALID', message)
}

/** A `ui/` path segment. Deliberately narrow: a package's assets are files an author checked in, not arbitrary bytes, and every character outside this set is either meaningless on some target filesystem or a way to make two different names look the same. */
const UI_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/** USTAR's plain header field. `createTar` throws on a longer name; refusing here names the entry instead. */
const MAX_ENTRY_NAME_BYTES = 100

/**
 * The checks every entry passes before the allowlist even looks at it, so a
 * hostile name is refused for what it IS (absolute, escaping, a directory)
 * rather than for the incidental fact that it also failed to match one of the
 * three permitted shapes.
 */
function checkEntryName(name: string): void {
  if (name.length === 0) refuse('the package contains an entry with an empty name')
  if (new TextEncoder().encode(name).length > MAX_ENTRY_NAME_BYTES) {
    refuse(`package entry "${name}" has a name longer than ${MAX_ENTRY_NAME_BYTES} bytes, which a plain USTAR header cannot hold`)
  }
  if (name.startsWith('/') || /^[A-Za-z]:[\\/]/.test(name)) {
    refuse(`package entry "${name}" is an absolute path — every entry in a .enkaku package is relative to the package root`)
  }
  if (name.includes('\\')) {
    refuse(`package entry "${name}" contains a backslash — a .enkaku package uses "/" as its only path separator`)
  }
  if (name.includes('\0')) {
    refuse('the package contains an entry whose name holds a NUL byte')
  }
  if (name.endsWith('/')) {
    refuse(`package entry "${name}" is a directory entry — a .enkaku package holds files only, and directories are implied by their files' paths`)
  }
  for (const segment of name.split('/')) {
    if (segment === '') refuse(`package entry "${name}" has an empty path segment`)
    if (segment === '.' || segment === '..') {
      refuse(`package entry "${name}" contains a "${segment}" segment — a .enkaku package may not name a path outside itself`)
    }
  }
}

/**
 * True when `path` — a `ui/` path RELATIVE to `ui/`, the shape
 * `PluginPackageAsset.path` and a view's `frame.entry` both use — is one this
 * format permits. Exactly the grammar `classifyEntry` below enforces, exported
 * rather than duplicated so `asset-store.ts` can re-check a path it read back
 * off disk (plan 108 §5 step 108.10) against the SAME rule the archive reader
 * applied on the way in. A second copy of this rule is how the two halves
 * would come to disagree about what a legal asset path is.
 *
 * `UI_SEGMENT` is what closes traversal: `..`, `.`, an empty segment, a
 * leading dot and a backslash all fail it, so a path that passes here cannot
 * name anything outside `ui/` even before the caller declines to join it onto
 * a filesystem path.
 */
export function isUiAssetPath(path: string): boolean {
  if (path.length === 0) return false
  if (new TextEncoder().encode(`${PACKAGE_UI_PREFIX}${path}`).length > MAX_ENTRY_NAME_BYTES) return false
  return path.split('/').every((segment) => UI_SEGMENT.test(segment))
}

/** The allowlist of §3.8, applied to an already-name-checked entry. Returns which of the three shapes it is. */
function classifyEntry(name: string): 'manifest' | 'scripts' | 'ui' {
  if (name === PACKAGE_MANIFEST_ENTRY) return 'manifest'
  if (name === PACKAGE_SCRIPTS_ENTRY) return 'scripts'
  if (name.startsWith(PACKAGE_UI_PREFIX)) {
    const relative = name.slice(PACKAGE_UI_PREFIX.length)
    if (relative.length === 0) refuse(`package entry "${name}" names the "ui/" directory itself rather than a file inside it`)
    for (const segment of relative.split('/')) {
      if (!UI_SEGMENT.test(segment)) {
        refuse(`package entry "${name}" has an unusable path segment "${segment}" — a "ui/" path may use only letters, digits, ".", "_" and "-", and each segment must start with a letter or a digit`)
      }
    }
    return 'ui'
  }
  refuse(
    `package entry "${name}" is outside the .enkaku allowlist — a package holds "${PACKAGE_MANIFEST_ENTRY}", "${PACKAGE_SCRIPTS_ENTRY}", and files under "${PACKAGE_UI_PREFIX}", and nothing else`,
  )
}

/** The `ui/` budget of §4.2, over the WHOLE directory rather than per file, because eight thousand 1 KiB files cost a browser exactly what one 8 MiB file does. */
function checkUiBudget(totalBytes: number): void {
  if (totalBytes > SURFACE_LIMITS.maxUiBytes) {
    refuse(`the package's "${PACKAGE_UI_PREFIX}" directory holds ${totalBytes} bytes, over the limit of ${SURFACE_LIMITS.maxUiBytes} (maxUiBytes)`)
  }
}

function issuesOf(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.map((p) => String(p)).join('.') || '(root)'}: ${i.message}`).join('; ')
}

/**
 * Builds a `.enkaku` package. Validates exactly what the reader validates —
 * the same manifest schema, the same name allowlist, the same `ui/` budget —
 * so a package this function produced can never be one `readPluginPackage`
 * refuses.
 */
export function writePluginPackage(input: WritePluginPackageInput): Bytes {
  const manifest = PluginPackageManifestSchema.safeParse(input.manifest)
  if (!manifest.success) refuse(`the package manifest is malformed: ${issuesOf(manifest.error)}`)

  const entries: TarEntry[] = [
    { name: PACKAGE_MANIFEST_ENTRY, data: new TextEncoder().encode(`${JSON.stringify(manifest.data, null, 2)}\n`) },
    { name: PACKAGE_SCRIPTS_ENTRY, data: new TextEncoder().encode(input.scripts) },
  ]

  const seen = new Set<string>()
  let uiBytes = 0
  // Sorted, so the same inputs always produce the same archive.
  for (const asset of [...(input.ui ?? [])].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    const name = `${PACKAGE_UI_PREFIX}${asset.path}`
    checkEntryName(name)
    if (classifyEntry(name) !== 'ui') refuse(`package entry "${name}" is not a "${PACKAGE_UI_PREFIX}" asset`)
    if (seen.has(name)) refuse(`package entry "${name}" was given twice`)
    seen.add(name)
    uiBytes += asset.data.length
    entries.push({ name, data: asset.data })
  }
  checkUiBudget(uiBytes)

  return createTarGz(entries, input.mtimeSec)
}

/**
 * Reads a `.enkaku` package. Throws `EnkakuError('E_PLUGIN_PACKAGE_INVALID')`
 * — naming the offending entry, or the limit it hit — for anything that is
 * not a well-formed package: unreadable bytes, a missing required entry, a
 * duplicate entry, an entry outside the allowlist, an oversized `ui/`, or a
 * `plugin.json` that is not the manifest it claims to be.
 */
export function readPluginPackage(bytes: Bytes): PluginPackage {
  let entries: TarEntry[]
  try {
    entries = readTarGz(bytes)
  } catch (err) {
    refuse(`the package is not a readable .enkaku archive (gzip over USTAR): ${err instanceof Error ? err.message : String(err)}`)
  }

  let manifestBytes: Uint8Array | null = null
  let scriptsBytes: Uint8Array | null = null
  const ui: PluginPackageAsset[] = []
  const seen = new Set<string>()
  let uiBytes = 0

  for (const entry of entries) {
    checkEntryName(entry.name)
    if (seen.has(entry.name)) refuse(`package entry "${entry.name}" appears twice — a package may not declare the same path more than once`)
    seen.add(entry.name)
    switch (classifyEntry(entry.name)) {
      case 'manifest':
        manifestBytes = entry.data
        break
      case 'scripts':
        scriptsBytes = entry.data
        break
      case 'ui':
        uiBytes += entry.data.length
        // Checked inside the loop as well as after it, so a package whose
        // `ui/` is enormous is refused before the rest of it is accumulated.
        checkUiBudget(uiBytes)
        ui.push({ path: entry.name.slice(PACKAGE_UI_PREFIX.length), data: entry.data })
        break
    }
  }

  if (!manifestBytes) refuse(`the package has no "${PACKAGE_MANIFEST_ENTRY}" — it is required`)
  if (!scriptsBytes) refuse(`the package has no "${PACKAGE_SCRIPTS_ENTRY}" — it is required`)

  let raw: unknown
  try {
    raw = JSON.parse(new TextDecoder().decode(manifestBytes)) as unknown
  } catch (err) {
    refuse(`the package's "${PACKAGE_MANIFEST_ENTRY}" is not valid JSON: ${err instanceof Error ? err.message : String(err)}`)
  }
  const manifest = PluginPackageManifestSchema.safeParse(raw)
  if (!manifest.success) refuse(`the package's "${PACKAGE_MANIFEST_ENTRY}" is malformed: ${issuesOf(manifest.error)}`)

  return { manifest: manifest.data, scripts: new TextDecoder().decode(scriptsBytes), ui }
}
