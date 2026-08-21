import { describe, expect, test } from 'bun:test'
import { MARKER_VERSION, parseMarker, serialiseMarker } from './marker'
import { MANAGED_COMMENT_PREFIX } from '../shared'

describe('parseMarker — well-formed markers', () => {
  test('parses the exact example from plan 122 §4.2', () => {
    const result = parseMarker('enkaku:mikrotik-routing:v1:jadwal-1:192.168.10.215')
    expect(result).toEqual({ kind: 'ok', groupId: 'jadwal-1', endpointKey: '192.168.10.215' })
  })

  test('parses a groupId with dashes, dots, and underscores', () => {
    const result = parseMarker('enkaku:mikrotik-routing:v1:jadwal_2.rotation-a:192.168.10.216')
    expect(result).toEqual({ kind: 'ok', groupId: 'jadwal_2.rotation-a', endpointKey: '192.168.10.216' })
  })

  test('parses an endpointKey containing colons (IPv6)', () => {
    const result = parseMarker('enkaku:mikrotik-routing:v1:jadwal-1:fe80::1a2b:3c4d')
    expect(result).toEqual({ kind: 'ok', groupId: 'jadwal-1', endpointKey: 'fe80::1a2b:3c4d' })
  })
})

describe('parseMarker — foreign comments', () => {
  test('a comment with no prefix at all is foreign', () => {
    expect(parseMarker('farm: local exception')).toEqual({ kind: 'foreign' })
  })

  test('an empty comment is foreign', () => {
    expect(parseMarker('')).toEqual({ kind: 'foreign' })
  })

  test('a comment that merely contains the prefix, not starting with it, is foreign', () => {
    expect(parseMarker('note: enkaku:mikrotik-routing:v1:jadwal-1:192.168.10.215')).toEqual({ kind: 'foreign' })
  })

  test('a prefix-like string missing the trailing colon is foreign', () => {
    expect(parseMarker('enkaku:mikrotik-routingv1:jadwal-1:192.168.10.215')).toEqual({ kind: 'foreign' })
  })
})

describe('parseMarker — version mismatch, detected rather than mis-parsed', () => {
  test('a future version is reported as version-mismatch, not parsed as v1', () => {
    const result = parseMarker('enkaku:mikrotik-routing:v2:jadwal-1:192.168.10.215')
    expect(result).toEqual({ kind: 'version-mismatch', version: 'v2' })
  })

  test('a non-numeric or malformed version segment is still version-mismatch, not a crash', () => {
    const result = parseMarker('enkaku:mikrotik-routing:beta:jadwal-1:192.168.10.215')
    expect(result).toEqual({ kind: 'version-mismatch', version: 'beta' })
  })

  test('an empty version segment is version-mismatch, not malformed — the delimiter was found', () => {
    const result = parseMarker('enkaku:mikrotik-routing::jadwal-1:192.168.10.215')
    expect(result).toEqual({ kind: 'version-mismatch', version: '' })
  })

  test('version-mismatch never inspects the body for groupId/endpointKey shape', () => {
    // Only two segments follow "v9" — a v1 body would be malformed (no
    // endpointKey), but since the version itself already disagrees, this
    // must be reported as version-mismatch, not malformed.
    const result = parseMarker('enkaku:mikrotik-routing:v9:onlyonesegment')
    expect(result).toEqual({ kind: 'version-mismatch', version: 'v9' })
  })
})

describe('parseMarker — malformed and truncated markers', () => {
  test('the prefix with nothing after it is malformed', () => {
    const result = parseMarker(MANAGED_COMMENT_PREFIX)
    expect(result.kind).toBe('malformed')
  })

  test('prefix plus only the version, no colon after it, is malformed', () => {
    const result = parseMarker('enkaku:mikrotik-routing:v1')
    expect(result.kind).toBe('malformed')
  })

  test('prefix plus version and groupId but no endpointKey segment is malformed', () => {
    const result = parseMarker('enkaku:mikrotik-routing:v1:jadwal-1')
    expect(result.kind).toBe('malformed')
  })

  test('an empty groupId segment is malformed', () => {
    const result = parseMarker('enkaku:mikrotik-routing:v1::192.168.10.215')
    expect(result.kind).toBe('malformed')
  })

  test('an empty endpointKey segment is malformed', () => {
    const result = parseMarker('enkaku:mikrotik-routing:v1:jadwal-1:')
    expect(result.kind).toBe('malformed')
  })

  test('every malformed case carries a human-readable reason', () => {
    const result = parseMarker('enkaku:mikrotik-routing:v1:jadwal-1:')
    if (result.kind !== 'malformed') throw new Error('expected malformed')
    expect(typeof result.reason).toBe('string')
    expect(result.reason.length).toBeGreaterThan(0)
  })
})

describe('serialiseMarker', () => {
  test('builds the exact example from plan 122 §4.2', () => {
    const result = serialiseMarker('jadwal-1', '192.168.10.215')
    expect(result).toEqual({ ok: true, comment: 'enkaku:mikrotik-routing:v1:jadwal-1:192.168.10.215' })
  })

  test('refuses an empty groupId', () => {
    const result = serialiseMarker('', '192.168.10.215')
    expect(result.ok).toBe(false)
  })

  test('refuses an empty endpointKey', () => {
    const result = serialiseMarker('jadwal-1', '')
    expect(result.ok).toBe(false)
  })

  test('refuses a groupId containing a colon', () => {
    const result = serialiseMarker('jadwal:1', '192.168.10.215')
    expect(result.ok).toBe(false)
  })

  test('allows an endpointKey containing a colon (IPv6)', () => {
    const result = serialiseMarker('jadwal-1', 'fe80::1')
    expect(result).toEqual({ ok: true, comment: 'enkaku:mikrotik-routing:v1:jadwal-1:fe80::1' })
  })
})

describe('round-trip — serialise then parse must reproduce every legal input exactly', () => {
  const legalPairs: Array<[groupId: string, endpointKey: string]> = [
    ['jadwal-1', '192.168.10.215'],
    ['jadwal_2.rotation-a', '10.0.0.1'],
    ['default', '192.168.100.230'],
    ['jadwal-1', 'fe80::1a2b:3c4d'],
    ['g', '1.2.3.4'],
    ['grup operasional', '192.168.10.99'], // spaces are legal — comments are free text
    ['grup-müsim-2', '192.168.10.100'], // non-ASCII is legal
    ['jadwal-1', 'endpoint:with:many:colons:in:it'], // endpointKey is the last segment — colons are safe there
  ]

  for (const [groupId, endpointKey] of legalPairs) {
    test(`round-trips groupId=${JSON.stringify(groupId)} endpointKey=${JSON.stringify(endpointKey)}`, () => {
      const serialised = serialiseMarker(groupId, endpointKey)
      expect(serialised.ok).toBe(true)
      if (!serialised.ok) throw new Error('unreachable')

      const parsed = parseMarker(serialised.comment)
      expect(parsed.kind).toBe('ok')
      if (parsed.kind !== 'ok') throw new Error('unreachable')
      expect(parsed.groupId).toBe(groupId)
      expect(parsed.endpointKey).toBe(endpointKey)
    })
  }
})

describe('MARKER_VERSION', () => {
  test('is v1, matching plan 122 §4.2', () => {
    expect(MARKER_VERSION).toBe('v1')
  })
})
