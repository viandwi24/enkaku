/**
 * Parse and serialise the ownership marker (plan 122 §4.2) that every rule
 * this plugin writes carries in its comment:
 *
 *   enkaku:mikrotik-routing:v1:<groupId>:<endpointKey>
 *
 * e.g. `enkaku:mikrotik-routing:v1:jadwal-1:192.168.10.215`.
 *
 * Pure, no I/O — step 122.2's whole point is that this format is provably
 * right before anything writes through it.
 *
 * ## Legal characters, and why
 *
 * The marker packs three variable fields (version, groupId, endpointKey)
 * into one colon-delimited string, so round-tripping depends on the split
 * being unambiguous. The format is fixed-arity: version and groupId are
 * each read up to their OWN next colon, and endpointKey is everything left
 * over after that.  That asymmetry is deliberate:
 *
 * - **`groupId` may NOT contain `:`.** It is not the last field, so a colon
 *   inside it would be indistinguishable from the delimiter that ends it —
 *   `serialiseMarker` refuses to build a marker for such a groupId, and
 *   `parseMarker` can never observe one (any comment shaped that way was not
 *   written by `serialiseMarker` and is treated as `malformed` rather than
 *   silently mis-split).
 * - **`endpointKey` MAY contain `:`.** It is the last field and consumes
 *   everything after groupId's delimiter, so nothing downstream depends on
 *   splitting it further. This is what lets an IPv6 LAN address round-trip
 *   correctly, even though the plugin's tier-1 identity bridge (§3.4) only
 *   ever produces IPv4 addresses today.
 * - Both fields must be non-empty — an empty groupId or endpointKey is
 *   truncated input, not a legal marker for "nothing."
 * - No other restriction is imposed: dots, dashes, underscores, spaces, and
 *   non-ASCII characters are all legal in either field, because RouterOS
 *   comments are plain strings and nothing above this module assumes more
 *   structure than "split on colons."
 */

import { MANAGED_COMMENT_PREFIX } from '../shared'

/** The only marker version this build understands. A different value is a `version-mismatch`, never a guess. */
export const MARKER_VERSION = 'v1'

/** `enkaku:mikrotik-routing:` — the single definition lives in `shared.ts` (used elsewhere for the coarse prefix-only check `doctor()` runs); this module reuses it rather than declaring a second copy that could drift. */
const MARKER_PREFIX = MANAGED_COMMENT_PREFIX

export interface ParsedMarker {
  groupId: string
  endpointKey: string
}

export type MarkerParseResult =
  /** Well-formed, current-version marker. */
  | ({ kind: 'ok' } & ParsedMarker)
  /** The comment does not start with the marker prefix at all — not ours, never touched. */
  | { kind: 'foreign' }
  /** Prefix matches and a version segment was read, but it is not `MARKER_VERSION` — a later (or earlier) format, detected rather than mis-parsed as this one. */
  | { kind: 'version-mismatch'; version: string }
  /** Prefix matches but the body could not be split into version + groupId + endpointKey (truncated, or an empty field). */
  | { kind: 'malformed'; reason: string }

/**
 * Parse a router rule's `comment` field into its marker, if it has one.
 *
 * Never throws — a comment is arbitrary operator or plugin text, and every
 * shape it can take (foreign, truncated, wrong version, well-formed) is a
 * value this function returns rather than an exception a caller must guard.
 */
export function parseMarker(comment: string): MarkerParseResult {
  if (!comment.startsWith(MARKER_PREFIX)) {
    return { kind: 'foreign' }
  }

  const body = comment.slice(MARKER_PREFIX.length)

  const versionSep = body.indexOf(':')
  if (versionSep === -1) {
    return { kind: 'malformed', reason: 'no version segment found after the marker prefix' }
  }

  const version = body.slice(0, versionSep)
  const rest = body.slice(versionSep + 1)

  if (version !== MARKER_VERSION) {
    return { kind: 'version-mismatch', version }
  }

  const groupSep = rest.indexOf(':')
  if (groupSep === -1) {
    return { kind: 'malformed', reason: 'no endpointKey segment found after groupId' }
  }

  const groupId = rest.slice(0, groupSep)
  const endpointKey = rest.slice(groupSep + 1)

  if (groupId === '') {
    return { kind: 'malformed', reason: 'groupId segment is empty' }
  }
  if (endpointKey === '') {
    return { kind: 'malformed', reason: 'endpointKey segment is empty' }
  }

  return { kind: 'ok', groupId, endpointKey }
}

export type MarkerSerialiseResult = { ok: true; comment: string } | { ok: false; reason: string }

/**
 * Build the marker comment for a `(groupId, endpointKey)` pair. Returns a
 * result rather than throwing, because both inputs ultimately trace back to
 * operator-entered data (a group name, a device's LAN IP) that this module
 * has no business crashing the caller over — the caller decides what an
 * illegal group id or endpoint means for its own flow (e.g. refuse group
 * creation, refuse the write).
 */
export function serialiseMarker(groupId: string, endpointKey: string): MarkerSerialiseResult {
  if (groupId === '') {
    return { ok: false, reason: 'groupId must not be empty' }
  }
  if (endpointKey === '') {
    return { ok: false, reason: 'endpointKey must not be empty' }
  }
  if (groupId.includes(':')) {
    return { ok: false, reason: 'groupId must not contain ":" — it would be indistinguishable from the marker delimiter' }
  }

  return { ok: true, comment: `${MARKER_PREFIX}${MARKER_VERSION}:${groupId}:${endpointKey}` }
}
