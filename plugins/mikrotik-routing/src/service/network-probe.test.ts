import { describe, expect, test } from 'bun:test'
import { decideVerifyOutcome, extractLanIp, extractPublicIp, ipv4TokensIn } from './network-probe'
import type { StoredAssignment } from '../shared'

/**
 * Pure extraction and decision logic for `verify-egress`/`discover-lan-ip`
 * (plan 122 §4.8, step 122.10) — no device, no network, no fake `Ctx`. See
 * `browser-probe.test.ts` for the async polling/dismiss-dialog half.
 */

function assignment(overrides: Partial<StoredAssignment> = {}): StoredAssignment {
  return { pathId: '', groupId: '', lanIp: '', lanIpSource: '', leaseKind: '', since: 0, lastVerifiedAt: 0, lastPublicIp: '', ...overrides }
}

describe('ipv4TokensIn', () => {
  test('finds every valid dotted-quad in a string', () => {
    expect(ipv4TokensIn('My IP: 103.186.169.250 (ISP: Example)')).toEqual(['103.186.169.250'])
    expect(ipv4TokensIn('10.0.0.1 and 192.168.10.215 both here')).toEqual(['10.0.0.1', '192.168.10.215'])
  })

  test('rejects an out-of-range octet — never a plausible-looking wrong answer', () => {
    expect(ipv4TokensIn('999.1.1.1')).toEqual([])
    expect(ipv4TokensIn('256.256.256.256')).toEqual([])
  })

  test('rejects a leading-zero octet, the same strict discipline cidr.ts already applies', () => {
    expect(ipv4TokensIn('192.168.010.5')).toEqual([])
  })

  test('a version-number-shaped string never matches (needs exactly four dot-separated groups)', () => {
    expect(ipv4TokensIn('Chrome 128.0.6613.1')).toEqual([])
  })

  test('empty string yields no tokens', () => {
    expect(ipv4TokensIn('')).toEqual([])
  })
})

describe('extractPublicIp', () => {
  test('finds a bare public IP — the ipify.org page shape (the whole page IS the answer)', () => {
    expect(extractPublicIp(['103.186.169.250'])).toBe('103.186.169.250')
  })

  test('skips a private/RFC1918 address and keeps looking', () => {
    expect(extractPublicIp(['192.168.10.215', 'ISP:', '103.186.169.250'])).toBe('103.186.169.250')
  })

  test('skips 0.0.0.0 and 127.0.0.1 — never real answers', () => {
    expect(extractPublicIp(['0.0.0.0'])).toBeNull()
    expect(extractPublicIp(['127.0.0.1'])).toBeNull()
  })

  test('null when the page has nothing plausible yet — the caller’s cue to keep polling, never a guess', () => {
    expect(extractPublicIp([])).toBeNull()
    expect(extractPublicIp(['Loading…', '192.168.1.1'])).toBeNull()
  })

  test('scans every node, not only the first', () => {
    expect(extractPublicIp(['', 'nothing here', '10.0.0.5', '8.8.8.8'])).toBe('8.8.8.8')
  })
})

describe('extractLanIp', () => {
  test('found — exactly one distinct private-range candidate', () => {
    expect(extractLanIp(['Local IP Address', '192.168.10.221'])).toEqual({ state: 'found', ip: '192.168.10.221' })
  })

  test('not-found — nothing private-range on the page yet', () => {
    expect(extractLanIp([])).toEqual({ state: 'not-found' })
    expect(extractLanIp(['still loading', '103.186.169.250'])).toEqual({ state: 'not-found' })
  })

  test('ambiguous — more than one DISTINCT private-range candidate refuses rather than guessing', () => {
    const result = extractLanIp(['192.168.10.221', '10.0.0.5'])
    expect(result.state).toBe('ambiguous')
    expect(result).toMatchObject({ candidates: ['10.0.0.5', '192.168.10.221'] })
  })

  test('the SAME candidate repeated is not ambiguous — it is one distinct address, found twice', () => {
    expect(extractLanIp(['192.168.10.221', 'again: 192.168.10.221'])).toEqual({ state: 'found', ip: '192.168.10.221' })
  })

  test('0.0.0.0 and 127.0.0.1 never count as a candidate', () => {
    expect(extractLanIp(['0.0.0.0', '127.0.0.1'])).toEqual({ state: 'not-found' })
  })

  test('a public address on the page is not a LAN candidate', () => {
    expect(extractLanIp(['Public IP Address', '103.186.169.250'])).toEqual({ state: 'not-found' })
  })
})

describe('decideVerifyOutcome', () => {
  test('null — no path assigned at all, nothing to verify against', () => {
    expect(decideVerifyOutcome(assignment({ pathId: '' }), '1.2.3.4')).toEqual({ expectedPath: '', matches: null })
  })

  test('null — a path IS assigned but this is the first-ever observation (no stored baseline)', () => {
    expect(decideVerifyOutcome(assignment({ pathId: 'via-modem1', lastPublicIp: '' }), '1.2.3.4')).toEqual({ expectedPath: 'via-modem1', matches: null })
  })

  test('true — the observed IP matches the stored baseline exactly', () => {
    expect(decideVerifyOutcome(assignment({ pathId: 'via-modem1', lastPublicIp: '1.2.3.4' }), '1.2.3.4')).toEqual({ expectedPath: 'via-modem1', matches: true })
  })

  test('false — a real mismatch, the whole point of this check', () => {
    expect(decideVerifyOutcome(assignment({ pathId: 'via-modem1', lastPublicIp: '1.2.3.4' }), '9.9.9.9')).toEqual({ expectedPath: 'via-modem1', matches: false })
  })

  test('never fabricates a pass: a fresh assignment with no history always reads null, never true', () => {
    const outcome = decideVerifyOutcome(assignment({ pathId: 'via-modem31' }), '203.0.113.7')
    expect(outcome.matches).toBeNull()
    expect(outcome.matches).not.toBe(true)
  })
})
