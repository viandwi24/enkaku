import { describe, expect, test } from 'bun:test'
import {
  deriveHealth,
  EXIT_HISTORY_LIMIT,
  GeoExpectationSchema,
  GeoObservationSchema,
  GeoProviderResponseSchema,
  HttpProxyRouteConfigSchema,
  matchGeoExpectation,
  NetworkEngineIdSchema,
  NetworkObservationSchema,
  NetworkRouteConfigSchema,
  PersistedNetworkRouteSchema,
  pushExitHistory,
  redactRouteConfig,
  renderStickyUsername,
  ReverseProxyRouteConfigSchema,
  RouteCheckIdSchema,
  RouteCheckSchema,
  RouteLifecycleStateSchema,
  Socks5RouteConfigSchema,
  StoredNetworkRouteConfigSchema,
  tagUntaggedRouteConfig,
  type GeoObservation,
  type HttpProxyRouteConfig,
  type ReverseProxyRouteConfig,
  type RouteCheck,
  type Socks5RouteConfig,
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

// ---------------------------------------------------------------------------
// Plan 114 §4.1 — the route config becomes a discriminated union.
//
// Everything below this line is the end-of-run test pass for plan 114's
// protocol layer. The through-line of the whole block is that the union is a
// WIDENING and not a break: every value written before plan 114 existed still
// parses, and it parses as `vpn-helper` by construction rather than by guess.
// ---------------------------------------------------------------------------

describe('PersistedNetworkRouteSchema.config — a pre-plan-114 row still parses (plan 114 §4.1)', () => {
  test('a raw pre-114 row with no engine key parses as vpn-helper, keeping credentialRef', () => {
    const parsed = PersistedNetworkRouteSchema.parse({
      config: { host: 'proxy.example', port: 1080, credentialRef: 'soax-jp', udpMode: 'tcp' },
      enabled: true,
      sessionId: 'sess-1',
      failClosed: true,
    })
    expect(parsed.config.engine).toBe('vpn-helper')
    // Narrow the way every downstream reader now has to.
    if (parsed.config.engine !== 'vpn-helper') throw new Error('expected the vpn-helper arm')
    expect(parsed.config.credentialRef).toBe('soax-jp')
    expect(parsed.config.host).toBe('proxy.example')
    expect(parsed.config.udpMode).toBe('tcp')
    expect(parsed.enabled).toBe(true)
    expect(parsed.sessionId).toBe('sess-1')
    expect(parsed.failClosed).toBe(true)
    // The two plan-114 fields are absent on a row that predates them — never defaulted.
    expect(parsed.captured).toBeUndefined()
    expect(parsed.setBy).toBeUndefined()
  })

  test('a pre-plan-52 row carrying INLINE username/password still parses, and is still vpn-helper', () => {
    const parsed = PersistedNetworkRouteSchema.parse({
      config: { host: 'proxy.example', port: 1080, username: 'sam', password: 'hunter2', udpMode: 'udp' },
      enabled: true,
    })
    expect(parsed.config.engine).toBe('vpn-helper')
    if (parsed.config.engine !== 'vpn-helper') throw new Error('expected the vpn-helper arm')
    expect(parsed.config.username).toBe('sam')
    expect(parsed.config.password).toBe('hunter2')
  })

  test('an adb-proxy row parses — what step 114.3 flipped this field for', () => {
    const parsed = PersistedNetworkRouteSchema.parse({
      config: { engine: 'adb-proxy', host: '10.0.0.2', port: 8899, exclusions: ['localhost'] },
      enabled: true,
    })
    expect(parsed.config.engine).toBe('adb-proxy')
  })

  test('an adb-reverse-proxy row parses alongside its farm-side allocation', () => {
    const parsed = PersistedNetworkRouteSchema.parse({
      config: { engine: 'adb-reverse-proxy', hostPort: 8888 },
      enabled: true,
      reverse: { devicePort: 28100, hostPort: 8888, at: 1_700_000_000 },
    })
    expect(parsed.config.engine).toBe('adb-reverse-proxy')
    expect(parsed.reverse).toEqual({ devicePort: 28100, hostPort: 8888, at: 1_700_000_000 })
  })
})

describe('NetworkRouteConfigSchema — discriminated on engine (plan 114 §4.1)', () => {
  test('all three tags parse to their own arm', () => {
    expect(NetworkRouteConfigSchema.parse({ engine: 'adb-proxy', host: 'h', port: 8080 }).engine).toBe('adb-proxy')
    expect(NetworkRouteConfigSchema.parse({ engine: 'adb-reverse-proxy', hostPort: 8888 }).engine).toBe('adb-reverse-proxy')
    expect(NetworkRouteConfigSchema.parse({ engine: 'vpn-helper', host: 'h', port: 1080 }).engine).toBe('vpn-helper')
  })

  test('an UNTAGGED object is rejected — a Zod .default() on the literal does not make the union accept it', () => {
    expect(NetworkRouteConfigSchema.safeParse({ host: 'proxy.example', port: 1080, udpMode: 'udp' }).success).toBe(false)
  })

  test('{ engine: "none" } is rejected — `none` is an engine id, never a config shape', () => {
    expect(NetworkRouteConfigSchema.safeParse({ engine: 'none' }).success).toBe(false)
  })

  test('a cross-shape is rejected: the adb-proxy tag with the reverse rung’s fields', () => {
    expect(NetworkRouteConfigSchema.safeParse({ engine: 'adb-proxy', hostPort: 9902 }).success).toBe(false)
  })

  test('an ARRAY of a valid config is rejected — plan 108 §4.2’s list-keyed-by-index failure cannot recur here', () => {
    expect(NetworkRouteConfigSchema.safeParse([{ engine: 'adb-proxy', host: 'h', port: 8080 }]).success).toBe(false)
  })

  test('an unknown tag is rejected', () => {
    expect(NetworkRouteConfigSchema.safeParse({ engine: 'wireguard', host: 'h', port: 51820 }).success).toBe(false)
  })
})

describe('StoredNetworkRouteConfigSchema — the read-time migration (plan 114 §4.1)', () => {
  test('an untagged object is tagged vpn-helper and parses', () => {
    const parsed = StoredNetworkRouteConfigSchema.parse({ host: 'proxy.example', port: 1080, udpMode: 'udp' })
    expect((parsed as Socks5RouteConfig).engine).toBe('vpn-helper')
  })

  test('an already-tagged object is left alone', () => {
    const parsed = StoredNetworkRouteConfigSchema.parse({ engine: 'adb-proxy', host: 'h', port: 8080 })
    expect((parsed as HttpProxyRouteConfig).engine).toBe('adb-proxy')
  })

  test('an ARRAY is NOT tagged and is rejected — spreading one into an object literal is exactly plan 108 §4.2’s bug', () => {
    expect(StoredNetworkRouteConfigSchema.safeParse([{ host: 'proxy.example', port: 1080, udpMode: 'udp' }]).success).toBe(false)
  })

  test('null is rejected rather than silently tagged — a device with no route carries config: null, and the nullability belongs OUTSIDE this schema', () => {
    expect(StoredNetworkRouteConfigSchema.safeParse(null).success).toBe(false)
  })

  test('a primitive is rejected', () => {
    expect(StoredNetworkRouteConfigSchema.safeParse('vpn-helper').success).toBe(false)
    expect(StoredNetworkRouteConfigSchema.safeParse(7).success).toBe(false)
  })
})

describe('tagUntaggedRouteConfig in isolation (plan 114 §4.1)', () => {
  test('a plain untagged object gains engine: "vpn-helper" and the original is not mutated', () => {
    const original = { host: 'proxy.example', port: 1080 }
    const tagged = tagUntaggedRouteConfig(original) as Record<string, unknown>
    expect(tagged.engine).toBe('vpn-helper')
    expect(tagged.host).toBe('proxy.example')
    expect(original).not.toHaveProperty('engine')
  })

  test('an ARRAY passes through untouched — by identity, not merely by value', () => {
    const arr = [{ host: 'proxy.example', port: 1080 }]
    expect(tagUntaggedRouteConfig(arr)).toBe(arr)
  })

  test('an already-tagged object passes through untouched, by identity', () => {
    const tagged = { engine: 'adb-proxy', host: 'h', port: 8080 }
    expect(tagUntaggedRouteConfig(tagged)).toBe(tagged)
  })

  test('an object whose engine is undefined still counts as tagged — `in` is the test, not truthiness', () => {
    const weird = { engine: undefined, host: 'h' }
    expect(tagUntaggedRouteConfig(weird)).toBe(weird)
  })

  test('null, undefined and primitives pass through untouched', () => {
    expect(tagUntaggedRouteConfig(null)).toBeNull()
    expect(tagUntaggedRouteConfig(undefined)).toBeUndefined()
    expect(tagUntaggedRouteConfig('nope')).toBe('nope')
    expect(tagUntaggedRouteConfig(7)).toBe(7)
    expect(tagUntaggedRouteConfig(false)).toBe(false)
  })
})

describe('Socks5RouteConfigSchema.engine — .default(), never a bare required literal (plan 114 §4.1)', () => {
  test('a bare {host,port,udpMode} with NO engine key still parses — PUT /:id/network and scripts/smoke-guest-agent.ts both send exactly this', () => {
    const parsed = Socks5RouteConfigSchema.parse({ host: 'proxy.example', port: 1080, udpMode: 'udp' })
    expect(parsed.engine).toBe('vpn-helper')
  })

  test('the OUTPUT type is required, so a consumer switching on config.engine has no undefined arm', () => {
    const parsed = Socks5RouteConfigSchema.parse({ host: 'proxy.example', port: 1080 })
    // Not `toBeDefined()`: the point is the concrete literal, not merely presence.
    expect(parsed.engine).toBe('vpn-helper')
    expect(parsed.udpMode).toBe('udp')
  })

  test('an explicit vpn-helper tag round-trips, and a wrong tag is refused', () => {
    expect(Socks5RouteConfigSchema.parse({ engine: 'vpn-helper', host: 'h', port: 1080 }).engine).toBe('vpn-helper')
    expect(Socks5RouteConfigSchema.safeParse({ engine: 'adb-proxy', host: 'h', port: 1080 }).success).toBe(false)
  })
})

describe('deriveHealth is UNCHANGED by plan 114 (§3.5, §4.1) — its five classes, restated', () => {
  test('1. nothing has run → unknown', () => {
    expect(deriveHealth([])).toBe('unknown')
    expect(deriveHealth([check('tunnel', 'unknown'), check('egress', 'unknown')])).toBe('unknown')
  })

  test('2. any genuine failure → degraded', () => {
    expect(deriveHealth([check('setting', 'fail'), check('egress', 'skip')])).toBe('degraded')
  })

  test('3. a fail beats "egress has not run" → degraded, never unverified', () => {
    expect(deriveHealth([check('tunnel', 'fail'), check('egress', 'unknown')])).toBe('degraded')
  })

  test('4. no failures but egress did not pass → unverified', () => {
    expect(deriveHealth([check('setting', 'pass'), check('egress', 'skip')])).toBe('unverified')
    expect(deriveHealth([check('setting', 'pass')])).toBe('unverified')
  })

  test('5. every non-skipped check passed, egress among them → ok', () => {
    expect(deriveHealth([check('tunnel', 'pass'), check('egress', 'pass'), check('geo', 'skip')])).toBe('ok')
  })
})

describe('deriveHealth can NEVER return "ok" for the HTTP rungs (plan 114 acceptance criterion 3)', () => {
  /**
   * Acceptance criterion 3 says it in those words: *"A test asserts `health` can
   * never be `'ok'` for either HTTP engine, on any combination of check states."*
   * So this is exhaustive rather than sampled — all 4^7 = 16384 assignments of
   * the seven non-`egress` check ids, with `egress` pinned to `skip` (which is
   * what both HTTP engines report, permanently, per §3.5).
   */
  const OTHER_IDS = ['tunnel', 'setting', 'reverse', 'upstream', 'geo', 'dns', 'leak'] as const
  const STATES = ['pass', 'fail', 'skip', 'unknown'] as const

  test(`all ${STATES.length ** OTHER_IDS.length} permutations with egress: skip → never ok`, () => {
    const total = STATES.length ** OTHER_IDS.length
    let seen = 0
    const observed = new Set<string>()
    for (let n = 0; n < total; n++) {
      let rest = n
      const checks: RouteCheck[] = []
      for (const id of OTHER_IDS) {
        checks.push(check(id, STATES[rest % STATES.length]!))
        rest = Math.floor(rest / STATES.length)
      }
      checks.push(check('egress', 'skip'))
      const health = deriveHealth(checks)
      observed.add(health)
      if (health === 'ok') throw new Error(`deriveHealth returned "ok" for ${JSON.stringify(checks)}`)
      seen++
    }
    expect(seen).toBe(total)
    expect(seen).toBe(16384)
    // The only two answers reachable with egress pinned to skip. `unknown` is not among them:
    // the skipped egress check itself is not `unknown`, so the all-unknown branch never fires.
    expect([...observed].sort()).toEqual(['degraded', 'unverified'])
  })

  test('the same holds for the exact check set an HTTP rung actually reports', () => {
    // §3.5's table, rung 1: tunnel/reverse/geo/dns/leak skip, egress skip permanently, setting and
    // upstream the only two that can say anything.
    for (const setting of ['pass', 'fail', 'skip', 'unknown'] as const) {
      for (const upstream of ['pass', 'fail', 'skip', 'unknown'] as const) {
        const checks = [
          check('tunnel', 'skip'),
          check('setting', setting),
          check('reverse', 'skip'),
          check('upstream', upstream),
          check('egress', 'skip'),
          check('geo', 'skip'),
          check('dns', 'skip'),
          check('leak', 'skip'),
        ]
        expect(deriveHealth(checks)).not.toBe('ok')
      }
    }
  })
})

describe('the two vocabularies plan 114 widened (§3.5, §4.1)', () => {
  test('RouteCheckIdSchema.options is exactly the eight ids, in order — `setting` and `reverse` are additions, not replacements', () => {
    expect(RouteCheckIdSchema.options).toEqual(['tunnel', 'setting', 'reverse', 'upstream', 'egress', 'geo', 'dns', 'leak'])
  })

  test('NetworkEngineIdSchema.options is exactly the four engine ids, in order', () => {
    expect(NetworkEngineIdSchema.options).toEqual(['none', 'adb-proxy', 'adb-reverse-proxy', 'vpn-helper'])
  })
})

describe('redactRouteConfig across the union (plan 114 §4.1, plan 44 §4.5)', () => {
  test('a vpn-helper password is masked and the input object is not mutated', () => {
    const config = Socks5RouteConfigSchema.parse({ host: 'proxy.example', port: 1080, username: 'sam', password: 'hunter2' })
    const redacted = redactRouteConfig(config)
    expect(redacted.password).not.toBe('hunter2')
    expect(redacted.password).toBe('••••••••')
    expect(redacted.username).toBe('sam')
    expect(config.password).toBe('hunter2')
  })

  test('a vpn-helper config with no password passes through by identity — nothing to mask', () => {
    const config = Socks5RouteConfigSchema.parse({ host: 'proxy.example', port: 1080, credentialRef: 'soax-jp' })
    expect(redactRouteConfig(config)).toBe(config)
  })

  test('an adb-proxy config is returned BY IDENTITY — §3.8: it carries no secret to redact', () => {
    const config = HttpProxyRouteConfigSchema.parse({ engine: 'adb-proxy', host: '10.0.0.2', port: 8899 })
    expect(redactRouteConfig(config)).toBe(config)
  })

  test('an adb-reverse-proxy config is returned by identity too', () => {
    const config = ReverseProxyRouteConfigSchema.parse({ engine: 'adb-reverse-proxy', hostPort: 8888 })
    expect(redactRouteConfig(config)).toBe(config)
  })

  test('the caller’s NARROW type survives the call — the generic, not a plain union parameter', () => {
    const socks: Socks5RouteConfig = Socks5RouteConfigSchema.parse({ host: 'h', port: 1080, password: 'p' })
    // These three annotations are the assertion: if `redactRouteConfig` returned the union,
    // none of them would compile, and `bash scripts/typecheck.sh` is part of this test's verdict.
    const redactedSocks: Socks5RouteConfig = redactRouteConfig(socks)
    const http: HttpProxyRouteConfig = HttpProxyRouteConfigSchema.parse({ engine: 'adb-proxy', host: 'h', port: 8080 })
    const redactedHttp: HttpProxyRouteConfig = redactRouteConfig(http)
    const rev: ReverseProxyRouteConfig = ReverseProxyRouteConfigSchema.parse({ engine: 'adb-reverse-proxy', hostPort: 8888 })
    const redactedRev: ReverseProxyRouteConfig = redactRouteConfig(rev)
    // Reading a field that only exists on the narrow type is the run-time half of the same point.
    expect(redactedSocks.udpMode).toBe('udp')
    expect(redactedHttp.host).toBe('h')
    expect(redactedRev.hostPort).toBe(8888)
  })
})

describe('PersistedNetworkRouteSchema.captured / .setBy (plan 114 §3.3, §3.6, §4.1)', () => {
  const base = { config: { engine: 'adb-proxy' as const, host: '10.0.0.2', port: 8899 }, enabled: true }

  test('a capture round-trips, empty strings included — an EMPTY capture is a real capture, not a missing one', () => {
    const captured = { httpProxy: '', host: '', port: '', exclusionList: '', at: 1_700_000_000 }
    expect(PersistedNetworkRouteSchema.parse({ ...base, captured }).captured).toEqual(captured)
  })

  test('a non-empty capture round-trips verbatim', () => {
    const captured = { httpProxy: '10.9.9.9:3128', host: '10.9.9.9', port: '3128', exclusionList: 'localhost,127.0.0.1', at: 5 }
    expect(PersistedNetworkRouteSchema.parse({ ...base, captured }).captured).toEqual(captured)
  })

  test('a partial capture is rejected — all four keys are required together', () => {
    expect(PersistedNetworkRouteSchema.safeParse({ ...base, captured: { httpProxy: '', at: 1 } }).success).toBe(false)
  })

  test('setBy parses for both kinds', () => {
    for (const kind of ['user', 'plugin'] as const) {
      const setBy = { kind, id: 'someone', at: 1_700_000_000 }
      expect(PersistedNetworkRouteSchema.parse({ ...base, setBy }).setBy).toEqual(setBy)
    }
  })

  test('setBy.kind rejects anything outside user|plugin', () => {
    for (const kind of ['system', 'farm', 'admin', '']) {
      expect(PersistedNetworkRouteSchema.safeParse({ ...base, setBy: { kind, id: 'x', at: 1 } }).success).toBe(false)
    }
  })

  test('an absent setBy stays undefined on the PERSISTED shape — never defaulted to a fabricated actor', () => {
    expect(PersistedNetworkRouteSchema.parse(base).setBy).toBeUndefined()
  })
})
