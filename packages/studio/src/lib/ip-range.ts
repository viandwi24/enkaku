import { addressCount } from '@enkaku/protocol'

/**
 * IPv4 start/end-range ↔ CIDR conversion — the presentation-layer bridge the
 * owner asked for directly (plan 88 §5, superseding step 88.12's navigate-
 * away shortcut): "harusnya scan network -> muncul modals ada input dinamis
 * untuk range ip dan port: [ip start] - [ip end]... bisa dinamis gitu dan
 * kesimpan".
 *
 * Every address-enumeration/ordering/cost-ceiling function in
 * `packages/core/src/registry/sweep.ts` and `packages/protocol/src/settings.ts`
 * (`discovery.networks[]`, `CidrSchema`, `addressCount()`) is CIDR-native and
 * stays that way — rewriting the sweep to natively understand a start/end
 * pair would touch address enumeration, priority-host ordering, and the
 * cost-ceiling math all at once, for no real gain. This file is the ONLY
 * place a start/end pair is ever translated to or from a CIDR block; nothing
 * downstream of `discovery.networks[]` ever sees an IP range.
 *
 * IPv4 only, matching `CidrSchema`'s own scope (`packages/protocol/src/
 * settings.ts`'s own comment: "every example and every cost-model number in
 * the plan is IPv4 ... a farm chassis switch does not hand out IPv6 leases
 * in practice"). No bitwise operators anywhere below — `x << n`/`x & y`
 * coerce JS numbers to signed Int32, which corrupts anything past
 * 0x7FFFFFFF (i.e. the top half of the IPv4 space, 128.0.0.0 and up). Every
 * address here is instead carried as a plain `number` (0..4294967295, exact
 * in a float64) and combined with `+`/`-`/`*`/`/`/`Math.floor`, which stay
 * exact across the whole range.
 */

/** A single octet, matching `CidrSchema`'s own strictness: 0-255, no leading zeros (so "007" is rejected, exactly like "007.0.0.0/24" already is). */
function isValidOctet(s: string): boolean {
  if (!/^\d{1,3}$/.test(s)) return false
  if (s.length > 1 && s[0] === '0') return false
  const n = Number(s)
  return n >= 0 && n <= 255
}

/** `null` for anything not a plain, valid IPv4 dotted-quad — never throws, so a keystroke-driven validator can call it directly. */
export function ipToInt(ip: string): number | null {
  const parts = ip.trim().split('.')
  if (parts.length !== 4) return null
  let result = 0
  for (const part of parts) {
    if (!isValidOctet(part)) return null
    result = result * 256 + Number(part)
  }
  return result
}

/** The inverse of `ipToInt` — `n` must be an integer in `[0, 4294967295]`. */
export function intToIp(n: number): string {
  const a = Math.floor(n / 16_777_216) % 256
  const b = Math.floor(n / 65_536) % 256
  const c = Math.floor(n / 256) % 256
  const d = n % 256
  return `${a}.${b}.${c}.${d}`
}

/** How many trailing zero bits `n` has in its 32-bit binary form, capped at 32 for `n === 0` (the whole address space can start at 0.0.0.0). Division-based, not `n & -n` — see this file's header comment on why bitwise ops are avoided here. */
function trailingZeroBits(n: number): number {
  if (n === 0) return 32
  let count = 0
  let x = n
  while (x % 2 === 0) {
    x /= 2
    count++
  }
  return count
}

/**
 * The user-facing validation message for a range's two IP fields — `null`
 * when both are blank (a fresh row, nothing to say yet, mirroring
 * `FarmNetworksEditor.tsx`'s pre-existing `cidrError`'s same "blank is not
 * yet an error" rule) or when the range is valid. Never throws.
 */
export function rangeError(startIp: string, endIp: string): string | null {
  const s = startIp.trim()
  const e = endIp.trim()
  if (!s && !e) return null
  if (!s || !e) return 'enter both a start and end IP'
  const si = ipToInt(s)
  const ei = ipToInt(e)
  if (si === null || ei === null) return 'must be a valid IPv4 address, like 10.20.0.10'
  if (si > ei) return 'the start IP must not be after the end IP'
  return null
}

/**
 * The user-facing validation message for a range's own port override (plan
 * 88 §9 Q7, resolved) — `null` when the field is empty (no override, the
 * range inherits the farm-wide `discovery.tcpPort`) or holds a valid port.
 * Mirrors `rangeError`'s own "blank is not yet an error" rule, and uses the
 * SAME bounds `ScanNetworkDialog.tsx`'s farm-wide port field already
 * enforces (1024–65535, `discovery.tcpPort`'s own schema bounds in
 * `packages/protocol/src/settings.ts`), so a range override and the farm
 * default are never validated to different rules. Never throws.
 */
export function rowPortError(port: number | undefined): string | null {
  if (port === undefined) return null
  if (!Number.isInteger(port) || port < 1024 || port > 65535) return 'must be a whole number between 1024 and 65535'
  return null
}

/**
 * The minimal set of CIDR blocks that EXACTLY covers `[startIp, endIp]`
 * (inclusive) — the standard "peel off the largest properly-aligned block
 * from the front of the remaining range" algorithm. `null` when either IP is
 * unparseable or `startIp` is after `endIp` (call `rangeError` first for a
 * message; this function only ever returns a result or `null`).
 *
 * EXACT by construction: every returned block starts exactly where the
 * previous one ends, so the union is contiguous with no gap and no overlap,
 * and the last block ends exactly at `endIp` — never rounds up (scans more
 * than asked) and never rounds down (silently skips addresses typed in).
 */
export function rangeToCidrs(startIp: string, endIp: string): string[] | null {
  const start0 = ipToInt(startIp)
  const end0 = ipToInt(endIp)
  if (start0 === null || end0 === null || start0 > end0) return null

  const blocks: string[] = []
  let start = start0
  while (start <= end0) {
    const remaining = end0 - start + 1
    const maxAlignBits = trailingZeroBits(start) // how large a block CAN start here
    // the largest power-of-two block size that still fits inside `remaining`
    let sizeBits = 0
    while (sizeBits < 32 && 2 ** (sizeBits + 1) <= remaining) sizeBits++
    const bits = Math.min(maxAlignBits, sizeBits)
    const prefix = 32 - bits
    blocks.push(`${intToIp(start)}/${prefix}`)
    start += 2 ** bits
  }
  return blocks
}

/**
 * The inverse direction: the `[start, end]` integer span a single CIDR block
 * covers. `null` for anything not shaped like `a.b.c.d/n`. Unlike
 * `rangeToCidrs`, this does NOT require the address to be the network
 * address of its own block — `10.20.0.5/24` is masked down to
 * `10.20.0.0/24`'s span, the same way a real network stack would treat it,
 * because `CidrSchema` validates the dotted-quad/prefix SHAPE only and does
 * not require host bits to be zero (a hand-typed row in Settings, from
 * before this change, may not be aligned).
 */
export function cidrToRange(cidr: string): { start: number; end: number } | null {
  const match = /^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\/(\d{1,2})$/.exec(cidr.trim())
  if (!match) return null
  const ipPart = match[1]
  const prefixPart = match[2]
  if (!ipPart || !prefixPart) return null
  const ip = ipToInt(ipPart)
  if (ip === null) return null
  const prefix = Number(prefixPart)
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return null
  const size = 2 ** (32 - prefix)
  const start = Math.floor(ip / size) * size
  return { start, end: start + size - 1 }
}

export type NetworkMedium = 'wired' | 'wireless'

/**
 * One `discovery.networks[]` row (plan 88 §3.6, §4.2) — kept structurally
 * compatible rather than importing `FarmSettings` here, so this file has no
 * dependency on the settings schema's own shape beyond these fields.
 *
 * `port` (plan 88 §9 Q7, resolved; `docs/plans/96-m61-hotfixes.md` §96.44's
 * follow-up) — an optional per-range override of the farm-wide
 * `discovery.tcpPort`. `undefined` means "no override, inherit the farm
 * default", exactly like `packages/protocol/src/settings.ts`'s own schema
 * field.
 */
export interface NetworkCidrRow {
  cidr: string
  label: string
  medium: NetworkMedium
  scan: boolean
  port?: number
}

/** One editable row in the range-based UI — the owner's own shape: "[ip start] - [ip end] [port]... bisa ditambah". `port` is now real (plan 88 §9 Q7, resolved) — `undefined`/blank means "inherit the farm default", never a silently-ignored value. */
export interface RangeRow {
  startIp: string
  endIp: string
  label: string
  medium: NetworkMedium
  scan: boolean
  port?: number
}

export function emptyRangeRow(): RangeRow {
  return { startIp: '', endIp: '', label: '', medium: 'wired', scan: true, port: undefined }
}

/**
 * Groups `discovery.networks[]` CIDR rows back into the start/end ranges an
 * operator typed — the reverse of `rangeRowsToNetworks` below, so a farm's
 * EXISTING stored CIDRs (hand-typed in Settings, or written by this file on
 * a previous save) render as editable ranges, never as raw CIDR the owner
 * never asked to see.
 *
 * A single typed range can produce several CIDR blocks (plan 88 §5's own
 * example: a range spanning two `/24`s). To merge those back into ONE row,
 * this groups CONSECUTIVE-BY-ADDRESS entries that share the same
 * `label`/`medium`/`scan` AND are exactly adjacent (the next block's start is
 * the previous block's `end + 1`, no gap, no overlap) — which is exactly the
 * shape `rangeToCidrs` always produces, so a range this file wrote always
 * round-trips to one row. Two CIDR rows that happen to share a label but are
 * NOT adjacent (e.g. two separate racks, coincidentally labelled the same)
 * are deliberately kept as two separate rows rather than merged across a gap
 * — merging them would silently claim a range that includes addresses
 * nobody configured.
 */
export function networksToRanges(networks: NetworkCidrRow[]): RangeRow[] {
  const parsed = networks
    .map((n) => {
      const span = cidrToRange(n.cidr)
      return span ? { start: span.start, end: span.end, label: n.label, medium: n.medium, scan: n.scan, port: n.port } : null
    })
    .filter((x): x is { start: number; end: number; label: string; medium: NetworkMedium; scan: boolean; port: number | undefined } => x !== null)

  parsed.sort((a, b) => a.start - b.start)

  // `port` joins `label`/`medium`/`scan` in the merge key (plan 88 §9 Q7,
  // resolved): two adjacent CIDR blocks with DIFFERING port overrides are
  // two genuinely different ranges, not one — merging them would silently
  // drop one block's own port. `undefined === undefined` is `true`, so two
  // adjacent blocks that both inherit the farm default still merge, exactly
  // as before this field existed.
  const merged: { start: number; end: number; label: string; medium: NetworkMedium; scan: boolean; port: number | undefined }[] = []
  for (const item of parsed) {
    const last = merged[merged.length - 1]
    if (last && last.label === item.label && last.medium === item.medium && last.scan === item.scan && last.port === item.port && last.end + 1 === item.start) {
      last.end = item.end
    } else {
      merged.push({ ...item })
    }
  }

  return merged.map((m) => ({ startIp: intToIp(m.start), endIp: intToIp(m.end), label: m.label, medium: m.medium, scan: m.scan, port: m.port }))
}

/**
 * The write side: regenerates the WHOLE `discovery.networks[]` array from
 * the current row list, rather than diffing against what was previously
 * saved. This is deliberate and is what makes editing a merged row safe —
 * there is no "which of the N old CIDR rows does this edited row own"
 * question to get wrong (the trickiest part per plan 88 §5's own framing):
 * every Save simply throws away the old array and rebuilds it from the rows
 * on screen, so an edited range can never orphan a stale CIDR entry or leave
 * a duplicate behind.
 *
 * `null` if any row is invalid (blank or `rangeError` fails) — callers must
 * gate Save on `rows.every(r => rangeError(r.startIp, r.endIp) === null)`
 * first, exactly as `FarmNetworksEditor.tsx` already gates Save on
 * `hasInvalidRow`.
 */
export function rangeRowsToNetworks(rows: RangeRow[]): NetworkCidrRow[] | null {
  const out: NetworkCidrRow[] = []
  for (const row of rows) {
    const cidrs = rangeToCidrs(row.startIp.trim(), row.endIp.trim())
    if (!cidrs) return null
    // `port` written only when the row actually overrides it (plan 88 §9
    // Q7, resolved) — an absent key round-trips through `.optional()` on
    // the server exactly like every other unset field in this file, rather
    // than sending an explicit `port: undefined` that carries no signal.
    for (const cidr of cidrs) out.push({ cidr, label: row.label.trim(), medium: row.medium, scan: row.scan, ...(row.port !== undefined ? { port: row.port } : {}) })
  }
  return out
}

/**
 * Total addresses a range contributes to the sweep budget — computed via
 * `addressCount()` (the SAME function `discovery.scan.maxAddresses`'s own
 * cross-field ceiling in `packages/protocol/src/settings.ts` uses) summed
 * over the range's own derived CIDR set, not a shortcut `end - start + 1`
 * — so this can never silently disagree with the real ceiling math even if
 * `addressCount`'s definition ever changes. (The two are mathematically
 * equal today: the derived blocks partition `[start, end]` exactly, with no
 * gap and no overlap — asserted directly in `ip-range.test.ts`.)
 */
export function rangeAddressCount(startIp: string, endIp: string): number {
  const cidrs = rangeToCidrs(startIp.trim(), endIp.trim())
  if (!cidrs) return 0
  return cidrs.reduce((sum, cidr) => sum + addressCount(cidr), 0)
}
