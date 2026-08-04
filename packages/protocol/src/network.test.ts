import { describe, expect, test } from 'bun:test'
import {
  deriveHealth,
  PersistedNetworkRouteSchema,
  renderStickyUsername,
  RouteCheckSchema,
  Socks5RouteConfigSchema,
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

describe('PersistedNetworkRouteSchema.failClosed (plan 51 §4.4, §5.6 — plumbing only, not enforced)', () => {
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
