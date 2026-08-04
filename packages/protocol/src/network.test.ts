import { describe, expect, test } from 'bun:test'
import {
  deriveHealth,
  EXIT_HISTORY_LIMIT,
  GeoExpectationSchema,
  GeoObservationSchema,
  GeoProviderResponseSchema,
  matchGeoExpectation,
  NetworkObservationSchema,
  PersistedNetworkRouteSchema,
  pushExitHistory,
  renderStickyUsername,
  RouteCheckSchema,
  RouteLifecycleStateSchema,
  Socks5RouteConfigSchema,
  type GeoObservation,
  type RouteCheck,
} from './network'

function check(id: RouteCheck['id'], state: RouteCheck['state'], extra: Partial<RouteCheck> = {}): RouteCheck {
  return { id, state, at: null, ...extra }
}

describe('RouteCheckSchema (plan 51 §4.1)', () => {
  test('a passing check with no detail parses', () => {
    const parsed = RouteCheckSchema.parse({ id: 'tunnel', state: 'pass', at: 1_700_000_000 })
    expect(parsed.state).toBe('pass')
  })

  test('detail is optional and, when present, is just a string — the schema does not forbid any particular content, safety is the host\'s job', () => {
    const parsed = RouteCheckSchema.parse({ id: 'egress', state: 'fail', detail: 'timed out', at: null })
    expect(parsed.detail).toBe('timed out')
  })

  test('an unknown check id is rejected', () => {
    expect(() => RouteCheckSchema.parse({ id: 'bogus', state: 'pass', at: null })).toThrow()
  })

  test('an unknown state is rejected', () => {
    expect(() => RouteCheckSchema.parse({ id: 'tunnel', state: 'maybe', at: null })).toThrow()
  })
})

describe('deriveHealth (plan 51 §4.1) — health is derived from checks, never stored', () => {
  test('no checks at all → unknown', () => {
    expect(deriveHealth([])).toBe('unknown')
  })

  test('every check still unknown → unknown', () => {
    const checks = [check('tunnel', 'unknown'), check('upstream', 'unknown'), check('egress', 'unknown')]
    expect(deriveHealth(checks)).toBe('unknown')
  })

  test('all-skip (no probe endpoint configured, no geo expectation, no dns/leak detection) → unverified, NEVER ok', () => {
    const checks = [
      check('tunnel', 'pass'),
      check('upstream', 'unknown'),
      check('egress', 'skip'),
      check('geo', 'skip'),
      check('dns', 'skip'),
      check('leak', 'skip'),
    ]
    expect(deriveHealth(checks)).toBe('unverified')
    expect(deriveHealth(checks)).not.toBe('ok')
  })

  test('every non-skipped check passes, egress among them → ok', () => {
    const checks = [
      check('tunnel', 'pass'),
      check('upstream', 'pass'),
      check('egress', 'pass'),
      check('geo', 'skip'),
      check('dns', 'skip'),
      check('leak', 'skip'),
    ]
    expect(deriveHealth(checks)).toBe('ok')
  })

  test('a single failing check anywhere → degraded, even with egress passing', () => {
    const checks = [check('tunnel', 'pass'), check('upstream', 'pass'), check('egress', 'pass'), check('leak', 'fail')]
    expect(deriveHealth(checks)).toBe('degraded')
  })

  test('a fail beats "egress never ran" — degraded, not unverified', () => {
    const checks = [check('tunnel', 'fail'), check('upstream', 'unknown'), check('egress', 'unknown')]
    expect(deriveHealth(checks)).toBe('degraded')
  })

  test('egress explicitly failing → degraded', () => {
    const checks = [check('tunnel', 'pass'), check('upstream', 'pass'), check('egress', 'fail')]
    expect(deriveHealth(checks)).toBe('degraded')
  })

  test('egress passing but nothing else has run yet → still ok, since nothing else failed (no non-skipped check other than egress ran, but none FAILED either)', () => {
    // Deliberately exercises the literal rule ("ok when every non-skipped check passes") rather
    // than a stronger "every check must have run" rule the plan does not state.
    const checks = [check('tunnel', 'unknown'), check('egress', 'pass')]
    expect(deriveHealth(checks)).toBe('ok')
  })

  test('a route with no egress check present at all → unverified, never ok', () => {
    const checks = [check('tunnel', 'pass'), check('upstream', 'pass')]
    expect(deriveHealth(checks)).toBe('unverified')
  })
})

describe('PersistedNetworkRouteSchema.failClosed (plan 51 §4.4 plumbing, made real by plan 54 §4.2, §5.6)', () => {
  test('omitting failClosed still parses — every pre-existing persisted route lacks it', () => {
    const parsed = PersistedNetworkRouteSchema.parse({
      config: { host: 'proxy.example', port: 1080, udpMode: 'udp' },
      enabled: true,
    })
    expect(parsed.failClosed).toBeUndefined()
  })

  test('failClosed true round-trips', () => {
    const parsed = PersistedNetworkRouteSchema.parse({
      config: { host: 'proxy.example', port: 1080, udpMode: 'udp' },
      enabled: true,
      failClosed: true,
    })
    expect(parsed.failClosed).toBe(true)
  })

  test('failClosed false round-trips — the explicit opt-out for debugging by hand', () => {
    const parsed = PersistedNetworkRouteSchema.parse({
      config: { host: 'proxy.example', port: 1080, udpMode: 'udp' },
      enabled: true,
      failClosed: false,
    })
    expect(parsed.failClosed).toBe(false)
  })
})

describe('Socks5RouteConfigSchema.failClosed (plan 54 §4.2, §5.6) — carried on the RESOLVED wire object only', () => {
  test('omitting failClosed still parses', () => {
    const parsed = Socks5RouteConfigSchema.parse({ host: 'proxy.example', port: 1080, udpMode: 'udp' })
    expect(parsed.failClosed).toBeUndefined()
  })

  test('failClosed round-trips alongside a resolved username/password', () => {
    const parsed = Socks5RouteConfigSchema.parse({
      host: 'proxy.example',
      port: 1080,
      username: 'sam',
      password: 'hunter2',
      udpMode: 'udp',
      failClosed: true,
    })
    expect(parsed.failClosed).toBe(true)
  })
})

describe('RouteLifecycleStateSchema / NetworkObservationSchema.state (plan 54 §4.1)', () => {
  test('the three states parse', () => {
    for (const s of ['up', 'held', 'down'] as const) {
      expect(RouteLifecycleStateSchema.parse(s)).toBe(s)
    }
  })

  test('an unrecognised state is rejected', () => {
    expect(() => RouteLifecycleStateSchema.parse('paused')).toThrow()
  })

  test('a held observation parses with up:false and state:"held" together — the whole point of the field', () => {
    const parsed = NetworkObservationSchema.parse({
      prepared: true,
      up: false,
      state: 'held',
      upstream: 'proxy.example:1080',
      lastError: 'no contact from the farm for 91000ms',
    })
    expect(parsed.up).toBe(false)
    expect(parsed.state).toBe('held')
  })

  test('omitting state still parses — an older agent build, or a cold read that never populated it', () => {
    const parsed = NetworkObservationSchema.parse({ prepared: true, up: true })
    expect(parsed.state).toBeUndefined()
  })
})

describe('Socks5RouteConfigSchema.credentialRef (plan 52 §4.2)', () => {
  test('a request naming a stored credential, with no inline username/password, parses', () => {
    const parsed = Socks5RouteConfigSchema.parse({ host: 'proxy.example', port: 1080, credentialRef: 'soax-jp', udpMode: 'udp' })
    expect(parsed.credentialRef).toBe('soax-jp')
    expect(parsed.username).toBeUndefined()
    expect(parsed.password).toBeUndefined()
  })

  test('the resolved wire object (built host-side right before route.apply()) carries username/password and no credentialRef', () => {
    const resolved = Socks5RouteConfigSchema.parse({ host: 'proxy.example', port: 1080, username: 'sam', password: 'hunter2', udpMode: 'udp' })
    expect(resolved.username).toBe('sam')
    expect(resolved.password).toBe('hunter2')
    expect(resolved.credentialRef).toBeUndefined()
  })
})

describe('PersistedNetworkRouteSchema.sessionId (plan 52 §4.3)', () => {
  test('omitting sessionId still parses — every pre-existing persisted route lacks it', () => {
    const parsed = PersistedNetworkRouteSchema.parse({
      config: { host: 'proxy.example', port: 1080, credentialRef: 'soax-jp', udpMode: 'udp' },
      enabled: true,
    })
    expect(parsed.sessionId).toBeUndefined()
  })

  test('sessionId round-trips once generated', () => {
    const parsed = PersistedNetworkRouteSchema.parse({
      config: { host: 'proxy.example', port: 1080, credentialRef: 'soax-jp', udpMode: 'udp' },
      enabled: true,
      sessionId: 'abc123',
    })
    expect(parsed.sessionId).toBe('abc123')
  })
})

describe('renderStickyUsername (plan 52 §3.3, §4.3)', () => {
  test('no template configured (the default) → username unchanged, no stickiness', () => {
    expect(renderStickyUsername('sam', 'abc123', '')).toBe('sam')
  })

  test('a template containing {id} is appended, with {id} substituted', () => {
    expect(renderStickyUsername('sam', 'abc123', '-sessionid-{id}')).toBe('sam-sessionid-abc123')
  })

  test('a template with no {id} placeholder at all is still appended verbatim, not rejected', () => {
    expect(renderStickyUsername('sam', 'abc123', '-sticky')).toBe('sam-sticky')
  })

  test('multiple {id} occurrences are all substituted', () => {
    expect(renderStickyUsername('sam', 'xyz', '-{id}-{id}')).toBe('sam-xyz-xyz')
  })
})

describe('Socks5RouteConfigSchema.expect / onGeoFail (plan 55 §4.1)', () => {
  test('both are absent by default — omitting them still parses', () => {
    const parsed = Socks5RouteConfigSchema.parse({ host: 'proxy.example', port: 1080, udpMode: 'udp' })
    expect(parsed.expect).toBeUndefined()
    expect(parsed.onGeoFail).toBeUndefined()
  })

  test('expect requires a 2-letter country code', () => {
    expect(() =>
      Socks5RouteConfigSchema.parse({ host: 'proxy.example', port: 1080, udpMode: 'udp', expect: { country: 'JPN' } }),
    ).toThrow()
    const parsed = Socks5RouteConfigSchema.parse({ host: 'proxy.example', port: 1080, udpMode: 'udp', expect: { country: 'JP' } })
    expect(parsed.expect).toEqual({ country: 'JP' })
  })

  test('expect carries region/city/asn/isp alongside country', () => {
    const parsed = Socks5RouteConfigSchema.parse({
      host: 'proxy.example',
      port: 1080,
      udpMode: 'udp',
      expect: { country: 'JP', region: 'Tokyo', city: 'Shibuya', asn: 4713, isp: 'NTT' },
    })
    expect(parsed.expect).toEqual({ country: 'JP', region: 'Tokyo', city: 'Shibuya', asn: 4713, isp: 'NTT' })
  })

  test('onGeoFail only accepts report/hold', () => {
    expect(() =>
      Socks5RouteConfigSchema.parse({ host: 'proxy.example', port: 1080, udpMode: 'udp', onGeoFail: 'ignore' }),
    ).toThrow()
    expect(Socks5RouteConfigSchema.parse({ host: 'proxy.example', port: 1080, udpMode: 'udp', onGeoFail: 'hold' }).onGeoFail).toBe('hold')
  })
})

function geoObservation(overrides: Partial<GeoObservation> = {}): GeoObservation {
  return { address: '1.2.3.4', country: 'JP', region: 'Tokyo', city: 'Shibuya', asn: 4713, isp: 'NTT', at: 1_700_000_000, ...overrides }
}

describe('GeoObservationSchema / GeoProviderResponseSchema (plan 55 §4.1, §5.2)', () => {
  test('a full observation parses', () => {
    expect(GeoObservationSchema.parse(geoObservation())).toEqual(geoObservation())
  })

  test('every field but address/at is nullable — an honest "unknown" per field', () => {
    const parsed = GeoObservationSchema.parse({ address: '1.2.3.4', country: null, region: null, city: null, asn: null, isp: null, at: 1 })
    expect(parsed.country).toBeNull()
  })

  test('GeoProviderResponseSchema is the observation minus address/at — what a geo provider endpoint actually answers', () => {
    const parsed = GeoProviderResponseSchema.parse({ country: 'JP', region: null, city: null, asn: null, isp: null })
    expect(parsed).toEqual({ country: 'JP', region: null, city: null, asn: null, isp: null })
  })
})

describe('matchGeoExpectation (plan 55 §4.2, §3.3) — matches at the narrowest level declared', () => {
  test('every declared field matches → matches: true', () => {
    const result = matchGeoExpectation({ country: 'JP', city: 'Shibuya' }, geoObservation())
    expect(result).toEqual({ matches: true })
  })

  test('a bare country-only expectation is not failed by a city difference', () => {
    const result = matchGeoExpectation({ country: 'JP' }, geoObservation({ city: 'Osaka' }))
    expect(result.matches).toBe(true)
  })

  test('a country mismatch fails and names the field', () => {
    const result = matchGeoExpectation({ country: 'JP' }, geoObservation({ country: 'ID' }))
    expect(result).toEqual({ matches: false, field: 'country', expected: 'JP', observed: 'ID' })
  })

  test('country matches case-insensitively and trimmed', () => {
    expect(matchGeoExpectation({ country: 'jp ' }, geoObservation({ country: ' JP' })).matches).toBe(true)
  })

  test('the broadest mismatched field wins — country checked before city', () => {
    const result = matchGeoExpectation(
      { country: 'JP', city: 'Shibuya' },
      geoObservation({ country: 'ID', city: 'Surabaya' }),
    )
    expect(result.field).toBe('country')
  })

  test('a declared ASN mismatch fails on exact numeric comparison', () => {
    const result = matchGeoExpectation({ country: 'JP', asn: 4713 }, geoObservation({ asn: 9999 }))
    expect(result).toEqual({ matches: false, field: 'asn', expected: '4713', observed: '9999' })
  })

  test('a declared field the observation could not attribute (null) is a mismatch, not a free pass', () => {
    const result = matchGeoExpectation({ country: 'JP', isp: 'NTT' }, geoObservation({ isp: null }))
    expect(result).toEqual({ matches: false, field: 'isp', expected: 'NTT', observed: 'unknown' })
  })

  test('an expectation with only country and no other field never inspects region/city/asn/isp at all', () => {
    const result = matchGeoExpectation({ country: 'JP' }, geoObservation({ region: null, city: null, asn: null, isp: null }))
    expect(result.matches).toBe(true)
  })
})

describe('pushExitHistory / EXIT_HISTORY_LIMIT (plan 55 §4.3, §5.5)', () => {
  test('an empty/undefined history plus one observation is a one-element ring, newest first', () => {
    const obs = geoObservation()
    expect(pushExitHistory(undefined, obs)).toEqual([obs])
    expect(pushExitHistory([], obs)).toEqual([obs])
  })

  test('a fresh observation is prepended — newest first', () => {
    const older = geoObservation({ address: '1.1.1.1', at: 1 })
    const newer = geoObservation({ address: '2.2.2.2', at: 2 })
    expect(pushExitHistory([older], newer)).toEqual([newer, older])
  })

  test('the ring is capped at EXIT_HISTORY_LIMIT, dropping the oldest', () => {
    const full = Array.from({ length: EXIT_HISTORY_LIMIT }, (_, i) => geoObservation({ address: `1.1.1.${i}`, at: i }))
    const fresh = geoObservation({ address: '9.9.9.9', at: 999 })
    const result = pushExitHistory(full, fresh)
    expect(result).toHaveLength(EXIT_HISTORY_LIMIT)
    expect(result[0]).toEqual(fresh)
    // The oldest entry (index EXIT_HISTORY_LIMIT - 1 of `full`) fell off the end.
    expect(result.some((o) => o.address === `1.1.1.${EXIT_HISTORY_LIMIT - 1}`)).toBe(false)
  })
})
