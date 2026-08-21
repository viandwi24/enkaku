/**
 * IPv4 parsing and CIDR containment — plan 122 §5 step 122.12, fix (2)/(4).
 *
 * Pure, no I/O, and deliberately its own module: the local-exception check
 * (`local-exception.ts`) is the one place in this plugin that has to answer
 * "does this router rule's address field actually cover that IP" correctly,
 * and getting it wrong is exactly the class of bug 122.12 exists to fix (a
 * false negative merely nags; a false positive permits an apply that cuts
 * ADB to every device it touches). Testing the arithmetic on its own, with no
 * router or device fixtures involved, is what makes it trustworthy.
 *
 * IPv4 only — MikroTik `src-address`/`dst-address` on a farm's LAN side is
 * always IPv4 in every fixture this plan has seen (the marker's own `v1`
 * format is the one place in this plugin that already reserves room for
 * IPv6, `marker.ts`'s header notes, but nothing produces one yet).
 *
 * No bitwise operators (`<<`, `&`, `>>>`) — they coerce a JS number to a
 * signed Int32, which corrupts any address at or past `128.0.0.0`
 * (`packages/studio/src/lib/ip-range.ts`'s header documents the same trap for
 * the same reason). Every address here is a plain `number` in
 * `[0, 4294967295]`, combined with `+`/`-`/`*`/`Math.floor`, which stay exact
 * across the whole range.
 */

/** A single octet: `0`-`255`, no leading zeros. */
function isValidOctet(s: string): boolean {
  if (!/^\d{1,3}$/.test(s)) return false
  if (s.length > 1 && s[0] === '0') return false
  const n = Number(s)
  return n >= 0 && n <= 255
}

/** `null` for anything not a plain, valid IPv4 dotted-quad — never throws. */
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

/**
 * A router address field, which MikroTik accepts either as a bare host
 * (`a.b.c.d`, an implicit `/32`) or a CIDR block (`a.b.c.d/n`) — parsed to
 * the inclusive integer span it covers. `null` for anything else (an
 * address-list name, a `!`-negated value, a malformed string): callers must
 * treat that as "coverage of this field cannot be determined," never guess
 * at it. Unlike `rangeToCidrs`'s own alignment requirement in
 * `packages/studio/src/lib/ip-range.ts`, this does NOT require the address to
 * already be the network address of its own block — a router's own
 * `192.168.10.221/32` (a bare host) or a hand-typed `192.168.10.5/24` both
 * mask down to their real span, the way a real routing table would.
 */
export function parseAddressSpec(spec: string): { start: number; end: number } | null {
  const trimmed = spec.trim()
  const slash = trimmed.indexOf('/')
  const ipPart = slash === -1 ? trimmed : trimmed.slice(0, slash)
  const ip = ipToInt(ipPart)
  if (ip === null) return null
  if (slash === -1) return { start: ip, end: ip }

  const prefixPart = trimmed.slice(slash + 1)
  if (!/^\d{1,2}$/.test(prefixPart)) return null
  const prefix = Number(prefixPart)
  if (prefix < 0 || prefix > 32) return null

  const size = 2 ** (32 - prefix)
  const start = Math.floor(ip / size) * size
  return { start, end: start + size - 1 }
}

/** Whether a router address field (`spec`) covers a given address. `false` — never a guess — when `spec` does not parse. */
export function specContains(spec: string, ipInt: number): boolean {
  const range = parseAddressSpec(spec)
  if (range === null) return false
  return ipInt >= range.start && ipInt <= range.end
}

/**
 * Whether two router address fields denote the EXACT same address span —
 * e.g. a bare host (`192.168.10.215`) and its `/32` spelling
 * (`192.168.10.215/32`), which are two spellings of one identical single-host
 * range. This is the primitive plan 122's step 122.6 correction (the
 * duplicate-rule bug found by review right after that step landed) needs:
 * matching a router rule's `src-address` to an endpoint by RAW STRING
 * EQUALITY breaks the moment RouterOS normalises what we write (a bare
 * address in) into CIDR form on the way back out (a real router, not a
 * hypothesis — see `resolve.ts`'s header) — the resolve-before-write check
 * (§4.3) would then never find its own rule and create a second one on every
 * apply. Comparing by parsed address RANGE instead makes any two equivalent
 * spellings of one host compare equal, regardless of which form either side
 * happens to be written in.
 *
 * Deliberately NOT "does `a` cover `b`" (`specContains`) — a `/24` block
 * containing a `/32` host is a DIFFERENT, broader rule, not another spelling
 * of the same one, and must not be treated as a match here.
 *
 * `false` — never a guess, per this file's own discipline — when either side
 * fails to parse.
 */
export function sameAddressSpec(a: string, b: string): boolean {
  const rangeA = parseAddressSpec(a)
  const rangeB = parseAddressSpec(b)
  if (rangeA === null || rangeB === null) return false
  return rangeA.start === rangeB.start && rangeA.end === rangeB.end
}

/** Whether `spec`'s own covered span fully contains `blockCidr`'s span — used to check a fallback dst-address covers a whole RFC1918 block, not just one address in it. `false` when either fails to parse. */
export function specCoversBlock(spec: string, blockCidr: string): boolean {
  const outer = parseAddressSpec(spec)
  const inner = parseAddressSpec(blockCidr)
  if (outer === null || inner === null) return false
  return outer.start <= inner.start && outer.end >= inner.end
}

/**
 * The three private-use ranges RFC 1918 reserves — a standard, not a site's
 * own topology, so this is not the "no `192.168.x` constants" rule §5 step
 * 122.12 asks this plugin to honour (that rule is about ONE operator's own
 * subnet, never a well-known IANA reservation every network stack agrees on).
 * Used only as the fallback when the core's own address could not be derived
 * (fix 2): since the plugin cannot say WHICH private range the core lives on,
 * it requires a candidate rule to cover all three rather than assume one.
 */
export const RFC1918_BLOCKS = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'] as const

/** The one RFC1918 block containing `ip`, or `null` if `ip` is not a private-use address at all (an unusual topology this plugin does not assume). */
export function rfc1918BlockContaining(ip: string): string | null {
  const ipInt = ipToInt(ip)
  if (ipInt === null) return null
  for (const block of RFC1918_BLOCKS) {
    if (specContains(block, ipInt)) return block
  }
  return null
}

/**
 * The smallest single CIDR block containing every address in `ips` — what
 * §5 step 122.12 fix (4) means by "build [the suggested `src-address`] from
 * the device addresses the plugin knows." `null` for an empty or entirely
 * unparseable list, since there is nothing to derive a subnet from.
 *
 * Standard "smallest block covering `[min, max]`" construction: walk the
 * prefix from `/32` down to `/0`, and take the first one whose
 * naturally-aligned block (starting at or before `min`) also reaches `max`.
 */
export function smallestCoveringCidr(ips: readonly string[]): string | null {
  const ints = ips.map(ipToInt).filter((n): n is number => n !== null)
  if (ints.length === 0) return null
  const min = Math.min(...ints)
  const max = Math.max(...ints)

  for (let prefix = 32; prefix >= 0; prefix--) {
    const size = 2 ** (32 - prefix)
    const start = Math.floor(min / size) * size
    if (start + size - 1 >= max) return `${intToIp(start)}/${prefix}`
  }
  // Unreachable: prefix 0 (the whole address space) always satisfies the
  // check above. Kept only so the function has a total return type.
  return '0.0.0.0/0'
}
