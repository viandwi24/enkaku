import { describe, expect, test } from 'bun:test'
import { addressCount } from '@enkaku/protocol'
import {
  cidrToRange,
  emptyRangeRow,
  intToIp,
  ipToInt,
  networksToRanges,
  rangeAddressCount,
  rangeError,
  rangeRowsToNetworks,
  rangeToCidrs,
  type NetworkCidrRow,
  type RangeRow,
} from './ip-range'

describe('ipToInt / intToIp', () => {
  test('round-trips ordinary addresses', () => {
    expect(ipToInt('10.20.0.10')).toBe(10 * 2 ** 24 + 20 * 2 ** 16 + 0 * 2 ** 8 + 10)
    expect(intToIp(ipToInt('10.20.0.10')!)).toBe('10.20.0.10')
  })

  test('the extremes of the IPv4 space', () => {
    expect(ipToInt('0.0.0.0')).toBe(0)
    expect(ipToInt('255.255.255.255')).toBe(4_294_967_295)
    expect(intToIp(0)).toBe('0.0.0.0')
    expect(intToIp(4_294_967_295)).toBe('255.255.255.255')
  })

  test('rejects malformed input', () => {
    expect(ipToInt('10.20.0')).toBeNull()
    expect(ipToInt('10.20.0.10.5')).toBeNull()
    expect(ipToInt('10.20.0.256')).toBeNull()
    expect(ipToInt('10.20.0.-1')).toBeNull()
    expect(ipToInt('not.an.ip.address')).toBeNull()
    expect(ipToInt('')).toBeNull()
    expect(ipToInt('  ')).toBeNull()
  })

  test('rejects leading zeros, matching CidrSchema\'s own octet strictness', () => {
    expect(ipToInt('010.20.0.10')).toBeNull()
    expect(ipToInt('10.20.00.10')).toBeNull()
    expect(ipToInt('10.20.0.007')).toBeNull()
    // "0" alone is fine — it is the one octet allowed to be a bare zero.
    expect(ipToInt('0.20.0.10')).not.toBeNull()
  })

  test('tolerates surrounding whitespace', () => {
    expect(ipToInt('  10.20.0.10  ')).toBe(ipToInt('10.20.0.10'))
  })
})

describe('rangeError', () => {
  test('both blank: not yet an error (a fresh row)', () => {
    expect(rangeError('', '')).toBeNull()
  })

  test('one filled, one blank: must enter both', () => {
    expect(rangeError('10.20.0.10', '')).toMatch(/enter both/)
    expect(rangeError('', '10.20.0.10')).toMatch(/enter both/)
  })

  test('unparseable IP', () => {
    expect(rangeError('not-an-ip', '10.20.0.20')).toMatch(/valid IPv4/)
    expect(rangeError('10.20.0.10', 'not-an-ip')).toMatch(/valid IPv4/)
  })

  test('start after end', () => {
    expect(rangeError('10.20.0.20', '10.20.0.10')).toMatch(/must not be after/)
  })

  test('a single-address range (start === end) is valid', () => {
    expect(rangeError('10.20.0.10', '10.20.0.10')).toBeNull()
  })

  test('a valid multi-address range', () => {
    expect(rangeError('10.20.0.0', '10.20.0.255')).toBeNull()
  })
})

/**
 * The core algorithm — every claim in the task's own "must be EXACT" rule is
 * checked directly: the union of the returned blocks must contain EXACTLY
 * `[start, end]`, with no gap, no overlap, no address outside the range.
 */
function expandCidr(cidr: string): number[] {
  const span = cidrToRange(cidr)
  if (!span) throw new Error(`bad cidr in test helper: ${cidr}`)
  const out: number[] = []
  for (let i = span.start; i <= span.end; i++) out.push(i)
  return out
}

function assertExactCoverage(startIp: string, endIp: string, blocks: string[]) {
  const covered = blocks.flatMap(expandCidr)
  covered.sort((a, b) => a - b)
  const expectedStart = ipToInt(startIp)!
  const expectedEnd = ipToInt(endIp)!
  const expected: number[] = []
  for (let i = expectedStart; i <= expectedEnd; i++) expected.push(i)
  expect(covered).toEqual(expected)
}

describe('rangeToCidrs — exactness (never rounds up, never rounds down)', () => {
  test('a single address', () => {
    const blocks = rangeToCidrs('10.20.0.10', '10.20.0.10')!
    expect(blocks).toEqual(['10.20.0.10/32'])
    assertExactCoverage('10.20.0.10', '10.20.0.10', blocks)
  })

  test('a range that is already an exact CIDR block', () => {
    const blocks = rangeToCidrs('10.20.0.0', '10.20.0.255')!
    expect(blocks).toEqual(['10.20.0.0/24'])
    assertExactCoverage('10.20.0.0', '10.20.0.255', blocks)
  })

  test('a range that is exactly a /16', () => {
    const blocks = rangeToCidrs('10.20.0.0', '10.20.255.255')!
    expect(blocks).toEqual(['10.20.0.0/16'])
  })

  test('a range spanning multiple blocks within one /24 (unaligned start)', () => {
    const blocks = rangeToCidrs('10.20.0.10', '10.20.0.20')!
    assertExactCoverage('10.20.0.10', '10.20.0.20', blocks)
    // Every block must be a real, minimal CIDR set — more than one block
    // since 10.20.0.10 is not aligned to any block containing .20 alone.
    expect(blocks.length).toBeGreaterThan(1)
  })

  test('a range crossing an octet boundary (spans two /24s)', () => {
    // The prompt's own worked example, using a valid octet range:
    // 10.20.0.10 - 10.20.1.44 crosses from the .0 octet into the .1 octet.
    const blocks = rangeToCidrs('10.20.0.10', '10.20.1.44')!
    assertExactCoverage('10.20.0.10', '10.20.1.44', blocks)
    expect(blocks.length).toBeGreaterThan(1)
  })

  test('the whole farm range crossing octet boundaries (10.0.0.0 - 10.20.0.0)', () => {
    const blocks = rangeToCidrs('10.0.0.0', '10.20.0.0')!
    assertExactCoverage('10.0.0.0', '10.20.0.0', blocks)
  })

  test('the entire IPv4 space', () => {
    const blocks = rangeToCidrs('0.0.0.0', '255.255.255.255')!
    expect(blocks).toEqual(['0.0.0.0/0'])
  })

  test('start === 0.0.0.0 with an unaligned end', () => {
    const blocks = rangeToCidrs('0.0.0.0', '0.0.0.5')!
    assertExactCoverage('0.0.0.0', '0.0.0.5', blocks)
  })

  test('a range ending at the top of the address space', () => {
    const blocks = rangeToCidrs('255.255.255.250', '255.255.255.255')!
    assertExactCoverage('255.255.255.250', '255.255.255.255', blocks)
  })

  test('adjacent single addresses each get their own /32 when not power-of-two aligned', () => {
    // 10.20.0.1 - 10.20.0.2: neither address alone forms a >1-address block
    // with the other under strict CIDR alignment (a /31 needs an even start).
    const blocks = rangeToCidrs('10.20.0.1', '10.20.0.2')!
    assertExactCoverage('10.20.0.1', '10.20.0.2', blocks)
  })

  test('a /31-alignable pair collapses to one block', () => {
    const blocks = rangeToCidrs('10.20.0.2', '10.20.0.3')!
    expect(blocks).toEqual(['10.20.0.2/31'])
  })

  test('invalid: start after end', () => {
    expect(rangeToCidrs('10.20.0.20', '10.20.0.10')).toBeNull()
  })

  test('invalid: unparseable IP', () => {
    expect(rangeToCidrs('not-an-ip', '10.20.0.10')).toBeNull()
  })

  test('never produces a block outside [start, end] — fuzz over small ranges', () => {
    // A compact deterministic sweep, not a full fuzzer: every (start, end)
    // pair in a small octet window, asserting exact coverage each time.
    for (let s = 0; s < 20; s++) {
      for (let e = s; e < 20; e++) {
        const startIp = `10.20.0.${s}`
        const endIp = `10.20.0.${e}`
        const blocks = rangeToCidrs(startIp, endIp)!
        assertExactCoverage(startIp, endIp, blocks)
      }
    }
  })
})

describe('cidrToRange', () => {
  test('a well-formed, aligned CIDR', () => {
    expect(cidrToRange('10.20.0.0/24')).toEqual({ start: ipToInt('10.20.0.0'), end: ipToInt('10.20.0.255') })
  })

  test('a /32 is a single address', () => {
    const r = cidrToRange('10.20.0.10/32')!
    expect(r.start).toBe(r.end)
    expect(r.start).toBe(ipToInt('10.20.0.10'))
  })

  test('a /0 is the entire space', () => {
    expect(cidrToRange('0.0.0.0/0')).toEqual({ start: 0, end: 4_294_967_295 })
  })

  test('an UNALIGNED CIDR (host bits set) is masked down to its real block — a hand-typed row from before this change', () => {
    expect(cidrToRange('10.20.0.5/24')).toEqual({ start: ipToInt('10.20.0.0'), end: ipToInt('10.20.0.255') })
  })

  test('malformed input', () => {
    expect(cidrToRange('not-a-cidr')).toBeNull()
    expect(cidrToRange('10.20.0.0')).toBeNull()
    expect(cidrToRange('10.20.0.0/33')).toBeNull()
    expect(cidrToRange('10.20.0.0/-1')).toBeNull()
  })
})

describe('rangeAddressCount — equals the sum of addressCount() over the derived CIDR set', () => {
  test('matches end - start + 1 exactly, via addressCount() summed over the minimal block set', () => {
    const cases: Array<[string, string]> = [
      ['10.20.0.10', '10.20.0.10'],
      ['10.20.0.0', '10.20.0.255'],
      ['10.20.0.10', '10.20.1.44'],
      ['0.0.0.0', '0.0.0.5'],
    ]
    for (const [s, e] of cases) {
      const direct = ipToInt(e)! - ipToInt(s)! + 1
      const viaBlocks = rangeToCidrs(s, e)!.reduce((sum, c) => sum + addressCount(c), 0)
      expect(rangeAddressCount(s, e)).toBe(direct)
      expect(rangeAddressCount(s, e)).toBe(viaBlocks)
    }
  })

  test('an invalid range counts as 0, never throws', () => {
    expect(rangeAddressCount('bad', '10.20.0.10')).toBe(0)
    expect(rangeAddressCount('10.20.0.20', '10.20.0.10')).toBe(0)
  })
})

/**
 * The round-trip: CIDR set → range rows → the SAME CIDR set. This is the
 * part flagged as trickiest in the task — a single typed range may produce
 * several stored CIDR rows, and editing it must not orphan or duplicate any
 * of them.
 */
describe('networksToRanges / rangeRowsToNetworks — the round-trip', () => {
  test('a single already-exact CIDR round-trips to one row and back to the same CIDR', () => {
    const networks: NetworkCidrRow[] = [{ cidr: '10.20.0.0/24', label: 'Chassis A', medium: 'wired', scan: true }]
    const rows = networksToRanges(networks)
    expect(rows).toEqual([{ startIp: '10.20.0.0', endIp: '10.20.0.255', label: 'Chassis A', medium: 'wired', scan: true }])
    expect(rangeRowsToNetworks(rows)).toEqual(networks)
  })

  test('a range spanning multiple blocks (rangeToCidrs\' own multi-block case) merges into ONE row', () => {
    const blocks = rangeToCidrs('10.20.0.10', '10.20.1.44')!
    expect(blocks.length).toBeGreaterThan(1)
    const networks: NetworkCidrRow[] = blocks.map((cidr) => ({ cidr, label: 'Chassis B', medium: 'wireless', scan: true }))

    const rows = networksToRanges(networks)
    expect(rows).toEqual([{ startIp: '10.20.0.10', endIp: '10.20.1.44', label: 'Chassis B', medium: 'wireless', scan: true }])

    // Editing the merged row (relabelling it) and writing it back must
    // reproduce the identical CIDR set — not orphan or duplicate any block.
    const edited: RangeRow[] = [{ ...rows[0]!, label: 'Chassis B (relabelled)' }]
    const rewritten = rangeRowsToNetworks(edited)!
    expect(rewritten.map((n) => n.cidr).sort()).toEqual(blocks.slice().sort())
    expect(rewritten.every((n) => n.label === 'Chassis B (relabelled)')).toBe(true)
    expect(rewritten).toHaveLength(blocks.length)
  })

  test('two unrelated, non-adjacent CIDRs with the same label stay as two separate rows (not silently merged across a gap)', () => {
    const networks: NetworkCidrRow[] = [
      { cidr: '10.20.0.0/24', label: 'Rack', medium: 'wired', scan: true },
      { cidr: '10.20.5.0/24', label: 'Rack', medium: 'wired', scan: true },
    ]
    const rows = networksToRanges(networks)
    expect(rows).toHaveLength(2)
  })

  test('adjacent CIDRs with DIFFERING attributes (medium, scan, label) are kept separate', () => {
    const networks: NetworkCidrRow[] = [
      { cidr: '10.20.0.0/25', label: 'A', medium: 'wired', scan: true },
      { cidr: '10.20.0.128/25', label: 'A', medium: 'wireless', scan: true }, // different medium — same label, adjacent
    ]
    expect(networksToRanges(networks)).toHaveLength(2)

    const networks2: NetworkCidrRow[] = [
      { cidr: '10.20.0.0/25', label: 'A', medium: 'wired', scan: true },
      { cidr: '10.20.0.128/25', label: 'A', medium: 'wired', scan: false }, // different scan flag
    ]
    expect(networksToRanges(networks2)).toHaveLength(2)
  })

  test('a stored config predating this change (multiple hand-typed CIDRs, out of address order) still merges correctly', () => {
    // Deliberately supplied out of ascending order, as a hand-edited
    // settings file might be — `networksToRanges` sorts before merging.
    const networks: NetworkCidrRow[] = [
      { cidr: '10.20.1.0/25', label: 'Chassis C', medium: 'wired', scan: false },
      { cidr: '10.20.0.0/25', label: 'Chassis C', medium: 'wired', scan: false },
      { cidr: '10.20.0.128/25', label: 'Chassis C', medium: 'wired', scan: false },
    ]
    const rows = networksToRanges(networks)
    expect(rows).toEqual([{ startIp: '10.20.0.0', endIp: '10.20.1.127', label: 'Chassis C', medium: 'wired', scan: false }])
  })

  test('empty input round-trips to empty', () => {
    expect(networksToRanges([])).toEqual([])
    expect(rangeRowsToNetworks([])).toEqual([])
  })

  test('rangeRowsToNetworks trims label whitespace', () => {
    const rows: RangeRow[] = [{ startIp: '10.20.0.10', endIp: '10.20.0.10', label: '  Chassis A  ', medium: 'wired', scan: true }]
    expect(rangeRowsToNetworks(rows)).toEqual([{ cidr: '10.20.0.10/32', label: 'Chassis A', medium: 'wired', scan: true }])
  })

  test('rangeRowsToNetworks returns null when any row is invalid — callers must gate Save on this', () => {
    const rows: RangeRow[] = [
      { startIp: '10.20.0.0', endIp: '10.20.0.10', label: 'Ok', medium: 'wired', scan: true },
      { startIp: '10.20.0.20', endIp: '10.20.0.10', label: 'Backwards', medium: 'wired', scan: true },
    ]
    expect(rangeRowsToNetworks(rows)).toBeNull()
  })

  test('a malformed stored CIDR is skipped by networksToRanges rather than throwing (defensive; CidrSchema should prevent this server-side)', () => {
    const networks = [{ cidr: 'not-a-cidr', label: 'Bad', medium: 'wired' as const, scan: true }]
    expect(networksToRanges(networks)).toEqual([])
  })
})

/**
 * `port` — the per-range override (plan 88 §9 Q7, resolved; `docs/plans/
 * 96-m61-hotfixes.md` §96.44's follow-up) — must carry through the same
 * round-trip rigor already proven above for start/end IP: created, edited,
 * and re-derived without ever being lost or bleeding into an unrelated row.
 */
describe('networksToRanges / rangeRowsToNetworks — port override round-trip (plan 88 §9 Q7, resolved)', () => {
  test('a row with a port override round-trips through both directions unchanged', () => {
    const networks: NetworkCidrRow[] = [{ cidr: '10.20.0.0/24', label: 'Chassis A', medium: 'wired', scan: true, port: 7000 }]
    const rows = networksToRanges(networks)
    expect(rows).toEqual([{ startIp: '10.20.0.0', endIp: '10.20.0.255', label: 'Chassis A', medium: 'wired', scan: true, port: 7000 }])
    expect(rangeRowsToNetworks(rows)).toEqual(networks)
  })

  test('a row with NO port override round-trips with no `port` key at all — never a stray `port: undefined` masquerading as a real override', () => {
    const networks: NetworkCidrRow[] = [{ cidr: '10.20.0.0/24', label: 'Chassis A', medium: 'wired', scan: true }]
    const rows = networksToRanges(networks)
    expect(rows[0]!.port).toBeUndefined()
    const rewritten = rangeRowsToNetworks(rows)!
    expect('port' in rewritten[0]!).toBe(false)
    expect(rewritten).toEqual(networks)
  })

  test('editing an existing row to ADD a port override writes it, without disturbing the row\'s own CIDR set', () => {
    const blocks = rangeToCidrs('10.20.0.10', '10.20.1.44')!
    const networks: NetworkCidrRow[] = blocks.map((cidr) => ({ cidr, label: 'Chassis B', medium: 'wireless', scan: true }))
    const rows = networksToRanges(networks)
    expect(rows).toHaveLength(1)

    const edited: RangeRow[] = [{ ...rows[0]!, port: 6001 }]
    const rewritten = rangeRowsToNetworks(edited)!
    expect(rewritten.map((n) => n.cidr).sort()).toEqual(blocks.slice().sort())
    expect(rewritten.every((n) => n.port === 6001)).toBe(true)
  })

  test('editing an existing row to REMOVE a port override (back to inheriting the farm default) clears it, not just sets it to 0/blank', () => {
    const networks: NetworkCidrRow[] = [{ cidr: '10.20.0.0/24', label: 'Chassis A', medium: 'wired', scan: true, port: 7000 }]
    const rows = networksToRanges(networks)
    const edited: RangeRow[] = [{ ...rows[0]!, port: undefined }]
    const rewritten = rangeRowsToNetworks(edited)!
    expect('port' in rewritten[0]!).toBe(false)
  })

  test('adjacent CIDRs with DIFFERING port overrides are kept as separate rows, not merged across a port boundary', () => {
    const networks: NetworkCidrRow[] = [
      { cidr: '10.20.0.0/25', label: 'A', medium: 'wired', scan: true, port: 7000 },
      { cidr: '10.20.0.128/25', label: 'A', medium: 'wired', scan: true, port: 7001 },
    ]
    expect(networksToRanges(networks)).toHaveLength(2)
  })

  test('adjacent CIDRs that both inherit the farm default (no port set on either) still merge into one row, exactly as before this field existed', () => {
    const networks: NetworkCidrRow[] = [
      { cidr: '10.20.0.0/25', label: 'A', medium: 'wired', scan: true },
      { cidr: '10.20.0.128/25', label: 'A', medium: 'wired', scan: true },
    ]
    expect(networksToRanges(networks)).toHaveLength(1)
  })

  test('a port override on one row never bleeds into a second, unrelated row edited in the same save', () => {
    const rows: RangeRow[] = [
      { startIp: '10.20.0.0', endIp: '10.20.0.10', label: 'Overridden', medium: 'wired', scan: true, port: 7000 },
      { startIp: '10.20.1.0', endIp: '10.20.1.10', label: 'Default', medium: 'wired', scan: true },
    ]
    const rewritten = rangeRowsToNetworks(rows)!
    expect(rewritten.every((n) => n.label !== 'Overridden' || n.port === 7000)).toBe(true)
    expect(rewritten.every((n) => n.label !== 'Default' || !('port' in n))).toBe(true)
  })
})

describe('emptyRangeRow', () => {
  test('a fresh row has no validation error yet', () => {
    const row = emptyRangeRow()
    expect(rangeError(row.startIp, row.endIp)).toBeNull()
    expect(row.scan).toBe(true)
    expect(row.medium).toBe('wired')
  })
})
