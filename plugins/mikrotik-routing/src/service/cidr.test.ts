import { describe, expect, test } from 'bun:test'
import { RFC1918_BLOCKS, intToIp, ipToInt, parseAddressSpec, rfc1918BlockContaining, sameAddressSpec, smallestCoveringCidr, specContains, specCoversBlock } from './cidr'

/**
 * IPv4 arithmetic — plan 122 §5 step 122.12. Pure, no I/O. This is the
 * module `local-exception.ts` leans on to answer "does this router rule's
 * address field actually cover that IP", which is exactly the question the
 * old comment-text match got wrong (defect B: a false positive here would
 * permit an apply that cuts ADB to every device it touches), so it earns
 * its own exhaustive coverage independent of any router or device fixture.
 */

/** `ipToInt`, asserted non-null — every literal used with this below is a valid dotted-quad, so this only exists to keep the test file's own expected-value construction out of `number | null`. */
function int(ip: string): number {
  const n = ipToInt(ip)
  if (n === null) throw new Error(`test fixture bug: "${ip}" is not a valid IPv4 address`)
  return n
}

describe('ipToInt / intToIp', () => {
  test('round-trips a valid dotted-quad', () => {
    expect(intToIp(int('192.168.10.221'))).toBe('192.168.10.221')
    expect(intToIp(int('0.0.0.0'))).toBe('0.0.0.0')
    expect(intToIp(int('255.255.255.255'))).toBe('255.255.255.255')
  })

  test('addresses past 128.0.0.0 stay exact — the int32-overflow trap this file avoids by never using bitwise ops', () => {
    expect(ipToInt('200.1.2.3')).not.toBeNull()
    expect(intToIp(int('200.1.2.3'))).toBe('200.1.2.3')
  })

  test('rejects malformed input rather than guessing', () => {
    expect(ipToInt('not-an-ip')).toBeNull()
    expect(ipToInt('1.2.3')).toBeNull()
    expect(ipToInt('1.2.3.4.5')).toBeNull()
    expect(ipToInt('1.2.3.256')).toBeNull()
    expect(ipToInt('1.2.3.007')).toBeNull()
  })
})

describe('parseAddressSpec — a router rule\'s src-address/dst-address field', () => {
  test('a bare host is an implicit /32', () => {
    expect(parseAddressSpec('192.168.10.221')).toEqual({ start: int('192.168.10.221'), end: int('192.168.10.221') })
  })

  test('a CIDR block masks down to its span, even when not pre-aligned (a hand-typed rule may not be)', () => {
    expect(parseAddressSpec('192.168.10.5/24')).toEqual({ start: int('192.168.10.0'), end: int('192.168.10.255') })
    expect(parseAddressSpec('192.168.0.0/16')).toEqual({ start: int('192.168.0.0'), end: int('192.168.255.255') })
    expect(parseAddressSpec('10.0.0.0/8')).toEqual({ start: int('10.0.0.0'), end: int('10.255.255.255') })
  })

  test('/32 and /0 are the two edges', () => {
    expect(parseAddressSpec('1.2.3.4/32')).toEqual({ start: int('1.2.3.4'), end: int('1.2.3.4') })
    expect(parseAddressSpec('1.2.3.4/0')).toEqual({ start: 0, end: 4_294_967_295 })
  })

  test('null for an address-list name, a negated value, or a malformed prefix — never a guess', () => {
    expect(parseAddressSpec('some-address-list')).toBeNull()
    expect(parseAddressSpec('!192.168.10.0/24')).toBeNull()
    expect(parseAddressSpec('192.168.10.0/33')).toBeNull()
    expect(parseAddressSpec('192.168.10.0/-1')).toBeNull()
    expect(parseAddressSpec('')).toBeNull()
  })
})

describe('specContains', () => {
  test('true inside the block, false outside it, false on an unparseable spec', () => {
    expect(specContains('192.168.10.0/24', int('192.168.10.221'))).toBe(true)
    expect(specContains('192.168.10.0/24', int('192.168.11.1'))).toBe(false)
    expect(specContains('192.168.10.221', int('192.168.10.221'))).toBe(true)
    expect(specContains('192.168.10.221', int('192.168.10.222'))).toBe(false)
    expect(specContains('not-a-spec', int('192.168.10.1'))).toBe(false)
  })

  // This is exactly the owner's own router, reproduced directly: their real
  // rule protects the SERVER's own subnet, not the farm devices behind it.
  test('the owner\'s real rule (src=192.168.50.0/24) does not cover a farm device on 192.168.10.x — defect B, reproduced at the arithmetic layer', () => {
    expect(specContains('192.168.50.0/24', int('192.168.10.215'))).toBe(false)
    expect(specContains('192.168.50.0/24', int('192.168.50.11'))).toBe(true)
  })
})

describe('sameAddressSpec — plan 122 step 122.6 correction: matching a router-echoed src-address by range, not raw string', () => {
  test('a bare host and its /32 spelling are the same address', () => {
    expect(sameAddressSpec('192.168.10.215', '192.168.10.215/32')).toBe(true)
    expect(sameAddressSpec('192.168.10.215/32', '192.168.10.215')).toBe(true)
  })

  test('two bare hosts, or two /32s, agree the normal way', () => {
    expect(sameAddressSpec('192.168.10.215', '192.168.10.215')).toBe(true)
    expect(sameAddressSpec('192.168.10.215/32', '192.168.10.215/32')).toBe(true)
  })

  test('different addresses are never the same, whatever form either is spelled in', () => {
    expect(sameAddressSpec('192.168.10.215', '192.168.10.216')).toBe(false)
    expect(sameAddressSpec('192.168.10.215/32', '192.168.10.216/32')).toBe(false)
    expect(sameAddressSpec('192.168.10.215', '192.168.10.216/32')).toBe(false)
  })

  test('a broader block is NOT "the same address" as a single host it happens to contain — this is not specContains', () => {
    expect(sameAddressSpec('192.168.10.0/24', '192.168.10.215')).toBe(false)
    expect(sameAddressSpec('192.168.10.215', '192.168.10.0/24')).toBe(false)
  })

  test('false — never a guess — when either side fails to parse', () => {
    expect(sameAddressSpec('not-a-spec', '192.168.10.215')).toBe(false)
    expect(sameAddressSpec('192.168.10.215', 'not-a-spec')).toBe(false)
    expect(sameAddressSpec('not-a-spec', 'also-not-a-spec')).toBe(false)
  })
})

describe('specCoversBlock', () => {
  test('true when the outer spec fully contains the inner block', () => {
    expect(specCoversBlock('192.168.0.0/16', '192.168.10.0/24')).toBe(true)
    expect(specCoversBlock('0.0.0.0/0', '10.0.0.0/8')).toBe(true)
  })

  test('false when the outer spec only partially or does not overlap the inner block', () => {
    expect(specCoversBlock('192.168.10.0/24', '192.168.0.0/16')).toBe(false)
    expect(specCoversBlock('10.0.0.0/8', '192.168.0.0/16')).toBe(false)
  })

  test('false on an unparseable spec on either side', () => {
    expect(specCoversBlock('not-a-spec', '10.0.0.0/8')).toBe(false)
    expect(specCoversBlock('10.0.0.0/8', 'not-a-spec')).toBe(false)
  })
})

describe('RFC1918_BLOCKS / rfc1918BlockContaining', () => {
  test('the three standard private-use blocks, in the conventional order', () => {
    expect(RFC1918_BLOCKS).toEqual(['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'])
  })

  test('finds the containing block for an address in each of the three', () => {
    expect(rfc1918BlockContaining('10.20.30.40')).toBe('10.0.0.0/8')
    expect(rfc1918BlockContaining('172.20.1.1')).toBe('172.16.0.0/12')
    expect(rfc1918BlockContaining('192.168.50.10')).toBe('192.168.0.0/16')
  })

  test('null for a public address — an unusual topology this plugin does not assume', () => {
    expect(rfc1918BlockContaining('8.8.8.8')).toBeNull()
  })

  test('null for an unparseable address', () => {
    expect(rfc1918BlockContaining('not-an-ip')).toBeNull()
  })
})

describe('smallestCoveringCidr — §5 step 122.12 fix 4: derive, never hardcode, the suggested src-address', () => {
  test('a spread of addresses within one octet\'s farm subnet collapses to that /24 — the owner\'s own worked example', () => {
    // Stands in for "40 farm devices on 192.168.10.x" — a wide-enough spread
    // that the smallest block containing every address IS the /24, exactly
    // the plan's own stated expectation for the owner's farm.
    const devices = ['192.168.10.5', '192.168.10.87', 'ignored-not-an-ip', '192.168.10.154', '192.168.10.231']
    expect(smallestCoveringCidr(devices)).toBe('192.168.10.0/24')
  })

  test('two addresses close together yield the smallest block that actually contains both, not a padded-out guess', () => {
    // 192.168.10.10 and 192.168.10.12 both fit inside a /29 (.8-.15) — a
    // correct implementation must not round up to /24 just because that is
    // a "normal-looking" subnet size.
    expect(smallestCoveringCidr(['192.168.10.10', '192.168.10.12'])).toBe('192.168.10.8/29')
  })

  test('a single address yields its own /32', () => {
    expect(smallestCoveringCidr(['192.168.10.221'])).toBe('192.168.10.221/32')
  })

  test('null for an empty or entirely-unparseable list — nothing to derive a subnet from', () => {
    expect(smallestCoveringCidr([])).toBeNull()
    expect(smallestCoveringCidr(['not-an-ip', 'also-not'])).toBeNull()
  })

  test('addresses spanning across an octet boundary still yield the correct minimal block', () => {
    expect(smallestCoveringCidr(['10.0.0.1', '10.0.1.1'])).toBe('10.0.0.0/23')
  })
})
