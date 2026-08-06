import { EnkakuError } from '../util/errors'

/**
 * Path normalisation and validation for the workspace (plan 64 §3.2, §4.1,
 * step 64.1) — a PURE function every later step trusts. `..` is REJECTED
 * rather than resolved: resolving it is how path-traversal bugs get written
 * (`store.ts`, `capability/fs.ts`, `scripts/build.ts` all call this before
 * touching a single row).
 *
 * Rules, all enforced here and nowhere else:
 * - a non-empty string
 * - absolute (starts with `/`)
 * - no trailing slash (except the impossible case of the bare root, which is
 *   rejected too — a workspace path always NAMES something, never the tree)
 * - no `.` or `..` segment — rejected, never resolved
 * - no empty segment (rejects `//`, a leading `//`, and so on)
 * - at most 512 UTF-8 bytes, at most 32 segments
 * - Unicode-normalised to NFC, so two byte-different-but-visually-identical
 *   paths (NFC vs NFD) always collapse to the SAME row rather than silently
 *   coexisting as two.
 */

const MAX_BYTES = 512
const MAX_SEGMENTS = 32

function badPath(raw: string, reason: string): EnkakuError {
  return new EnkakuError('E_BAD_PATH', `invalid workspace path "${raw}": ${reason}`)
}

/** Normalises and validates a raw path. Throws `EnkakuError('E_BAD_PATH', ...)` — never returns a partially-fixed path. */
export function normaliseWorkspacePath(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw badPath(String(raw), 'must be a non-empty string')
  }

  // Unicode canonicalisation happens BEFORE structural validation — two
  // encodings of the same visible path must fail or succeed identically,
  // never one and not the other.
  const nfc = raw.normalize('NFC')

  if (!nfc.startsWith('/')) {
    throw badPath(raw, 'must be absolute (start with "/")')
  }

  const byteLength = new TextEncoder().encode(nfc).length
  if (byteLength > MAX_BYTES) {
    throw badPath(raw, `exceeds the ${MAX_BYTES}-byte limit (${byteLength} bytes)`)
  }

  if (nfc.length > 1 && nfc.endsWith('/')) {
    throw badPath(raw, 'must not have a trailing slash')
  }

  // `nfc.split('/')` on an absolute path always has a leading empty element
  // for the segment before the first `/` — drop it, the rest are the real
  // path segments.
  const segments = nfc.split('/').slice(1)

  if (segments.length === 0 || (segments.length === 1 && segments[0] === '')) {
    throw badPath(raw, 'must name a file, not the root')
  }

  if (segments.length > MAX_SEGMENTS) {
    throw badPath(raw, `exceeds the ${MAX_SEGMENTS}-segment limit (${segments.length} segments)`)
  }

  for (const segment of segments) {
    if (segment.length === 0) {
      throw badPath(raw, 'contains an empty segment (a doubled "/")')
    }
    if (segment === '.' || segment === '..') {
      throw badPath(raw, `contains a "${segment}" segment — rejected rather than resolved`)
    }
  }

  return nfc
}

/** The top-level scope a path belongs to, for quota accounting and the
 * default agent grant (plan 64 §3.2, §3.3): `/agents/<slug>/...` scopes to
 * that agent's own home (§3.2's "an agent's own home"), everything else
 * scopes to its own top-level directory (`/shared/`, `/scripts/`, `/notes/`,
 * or any other top-level prefix an operator happens to use). Callers must
 * pass an already-normalised path (`normaliseWorkspacePath`'s output). */
export function scopeOfPath(path: string): string {
  const segments = path.split('/').slice(1)
  const first = segments[0] ?? ''
  if (first === 'agents' && segments.length > 1 && segments[1]) {
    return `/agents/${segments[1]}/`
  }
  return `/${first}/`
}

/** Normalises a scope PREFIX the same way a path is normalised, except a
 * prefix is always a directory: it always ends in `/`. `/` itself (the whole
 * tree) is the one legal exception to "must name a file, not the root." */
export function normaliseScopePrefix(raw: string): string {
  if (raw === '/') return '/'
  const withoutTrailingSlash = raw.endsWith('/') ? raw.slice(0, -1) : raw
  const normalised = normaliseWorkspacePath(withoutTrailingSlash)
  return `${normalised}/`
}

/** Whether `path` (already normalised) falls under `prefix` (already
 * normalised via `normaliseScopePrefix`) — used by the store's scope checks
 * (plan 64 §4.2, acceptance #6). `/` matches everything. */
export function pathWithinPrefix(path: string, prefix: string): boolean {
  if (prefix === '/') return true
  return path.startsWith(prefix)
}

/** Whether `path` falls under ANY of `prefixes` — the shape an actor's read/write grant takes. */
export function pathWithinAnyPrefix(path: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => pathWithinPrefix(path, prefix))
}
