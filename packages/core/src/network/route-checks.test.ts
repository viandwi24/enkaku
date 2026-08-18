import { describe, expect, test } from 'bun:test'
import { deriveHealth, type GeoObservation, type NetworkObservation, type RouteCheck } from '@enkaku/protocol'
import { ADVISORY_EGRESS_DETAIL, buildAdvisoryChecks, buildChecks, parseEgressAddress, redactObservationForResponse, safeCheckDetail, type AdvisoryChecksInput, type ChecksInput } from './route-checks'

/**
 * Plan 114 step 114.3's check tables, tested where they are pure (plan 114 §3.5,
 * acceptance criteria 3 and 4).
 *
 * Two halves, and the split matters:
 *
 * - `buildAdvisoryChecks` is new, and every assertion about it is about a
 *   promise the product makes on screen: `egress` is `skip` for every input,
 *   `health` can therefore never be `ok` on ANY permutation (criterion 3 — the
 *   cross-product below is exhaustive, not sampled), and no `detail` may read
 *   `routed`/`ok`/`success`/a bare `enabled` (criterion 4).
 * - `buildChecks` is `vpn-helper`'s and was only MOVED by 114.3
 *   (`api/guest-agent.ts` → `network/route-checks.ts`). Its assertions are
 *   ported from the pre-114 HTTP-level tests in
 *   `packages/core/src/api/guest-agent.test.ts` ("checks and health derivation",
 *   "geo / dns / leak checks", "plan 54 §4.3 — a held route reads as
 *   fail-closed"), run directly against the pure function here: the regression
 *   risk of an extraction lives exactly in whether the moved table still answers
 *   the same thing for the same input.
 */

const byId = (checks: RouteCheck[]): Record<string, RouteCheck> => Object.fromEntries(checks.map((c) => [c.id, c]))

// ---------------------------------------------------------------------------
// buildChecks — vpn-helper (ported, verbatim in intent, from the pre-114 tests)
// ---------------------------------------------------------------------------

function vpnInput(overrides: Partial<ChecksInput> = {}): ChecksInput {
  return {
    observed: null,
    observedAt: null,
    lastError: null,
    probe: null,
    probeAt: null,
    probeError: null,
    probeUrl: null,
    agentCapabilities: null,
    secrets: [],
    expect: undefined,
    geoProviderConfigured: false,
    geoObservation: null,
    geoError: null,
    probeDnsZoneConfigured: false,
    dnsResult: null,
    ipv6Blocked: undefined,
    ...overrides,
  }
}

const upObservation: NetworkObservation = { prepared: true, up: true, upstream: 'proxy.example:1080' }

describe('buildChecks (vpn-helper) — unchanged by the 114.3 extraction', () => {
  test('with no probe endpoint configured, egress/dns/geo are skip and health stays unverified even with a healthy tunnel', () => {
    const checks = buildChecks(vpnInput({ observed: upObservation, observedAt: 100 }))
    const c = byId(checks)
    expect(c.tunnel?.state).toBe('pass')
    expect(c.egress?.state).toBe('skip')
    expect(c.egress?.detail).toContain('ENKAKU_NETWORK_PROBE_URL')
    expect(c.dns?.state).toBe('skip')
    expect(c.geo?.state).toBe('skip')
    expect(c.leak?.state).toBe('skip')
    expect(deriveHealth(checks)).toBe('unverified')
  })

  test('a working route with a probe endpoint and an agent advertising egress-probe reaches health: ok', () => {
    const checks = buildChecks(
      vpnInput({
        observed: upObservation,
        observedAt: 100,
        probeUrl: 'https://probe.internal/x',
        agentCapabilities: ['socks5-route', 'vpn-status', 'egress-probe'],
        probe: { tunnelled: { ok: true, status: 200, body: 'nonce=abc', ms: 210 }, direct: { ok: true, status: 200, body: 'nonce=abc', ms: 30 } },
        probeAt: 101,
      }),
    )
    const c = byId(checks)
    expect(c.tunnel?.state).toBe('pass')
    expect(c.upstream?.state).toBe('pass')
    expect(c.egress?.state).toBe('pass')
    expect(deriveHealth(checks)).toBe('ok')
  })

  test('upstream fails when the tunnelled leg dies at the SOCKS5 connect stage, distinct from a healthy tunnel check', () => {
    const checks = buildChecks(
      vpnInput({
        observed: upObservation,
        observedAt: 100,
        probeUrl: 'https://probe.internal/x',
        agentCapabilities: ['egress-probe'],
        probe: {
          tunnelled: { ok: false, ms: 8000, error: 'SOCKS5 CONNECT failed (reply code 5)', stage: 'connect' },
          direct: { ok: true, status: 200, body: 'nonce=xyz', ms: 40 },
        },
        probeAt: 101,
      }),
    )
    const c = byId(checks)
    expect(c.tunnel?.state).toBe('pass')
    expect(c.upstream?.state).toBe('fail')
    expect(c.egress?.state).toBe('fail')
    expect(deriveHealth(checks)).toBe('degraded')
  })

  test('a probe target that fails to answer (SOCKS5 connect succeeded) reports upstream: pass, egress: fail — the two are not conflated', () => {
    const checks = buildChecks(
      vpnInput({
        observed: upObservation,
        observedAt: 100,
        probeUrl: 'https://probe.internal/x',
        agentCapabilities: ['egress-probe'],
        probe: {
          tunnelled: { ok: false, status: 503, ms: 210, error: 'probe target responded 503', stage: 'fetch' },
          direct: { ok: true, status: 200, body: 'nonce=xyz', ms: 40 },
        },
        probeAt: 101,
      }),
    )
    const c = byId(checks)
    expect(c.upstream?.state).toBe('pass')
    expect(c.egress?.state).toBe('fail')
  })

  test('an agent build that does not advertise egress-probe leaves egress: skip even with a probe endpoint configured', () => {
    const checks = buildChecks(
      vpnInput({
        observed: upObservation,
        observedAt: 100,
        probeUrl: 'https://probe.internal/x',
        agentCapabilities: ['socks5-route', 'vpn-status'],
      }),
    )
    const c = byId(checks)
    expect(c.egress?.state).toBe('skip')
    expect(c.egress?.detail).toContain('does not advertise')
    expect(deriveHealth(checks)).toBe('unverified')
  })

  test('capabilities not yet known (null) leaves egress unknown rather than skip — it has not been asked, not refused', () => {
    const checks = buildChecks(vpnInput({ observed: upObservation, observedAt: 100, probeUrl: 'https://probe.internal/x', agentCapabilities: null }))
    expect(byId(checks).egress?.state).toBe('unknown')
  })

  test("no check detail ever carries the route's username or password (plan 51 acceptance criterion 8)", () => {
    const checks = buildChecks(
      vpnInput({
        observed: { prepared: true, up: false, lastError: 'auth failed for hunter2' },
        observedAt: 100,
        probeUrl: 'https://probe.internal/x',
        agentCapabilities: ['egress-probe'],
        probe: { tunnelled: { ok: false, ms: 10, error: 'proxy rejected sam:hunter2', stage: 'connect' }, direct: { ok: true, status: 200, ms: 12 } },
        probeAt: 101,
        secrets: ['sam', 'hunter2'],
      }),
    )
    expect(JSON.stringify(checks)).not.toContain('hunter2')
    expect(byId(checks).tunnel?.detail).toContain('<redacted>')
  })

  test('an apply/observe failure outranks a stale observation: tunnel is fail, not a leftover pass', () => {
    const checks = buildChecks(vpnInput({ observed: upObservation, observedAt: 100, lastError: { code: 'E_TIMEOUT', message: 'the agent did not answer' } }))
    const c = byId(checks)
    expect(c.tunnel?.state).toBe('fail')
    expect(c.tunnel?.detail).toBe('the agent did not answer')
    expect(deriveHealth(checks)).toBe('degraded')
  })

  test('nothing observed yet leaves tunnel unknown and health unknown', () => {
    const checks = buildChecks(vpnInput({ observed: null, probeUrl: null }))
    expect(byId(checks).tunnel?.state).toBe('unknown')
    // egress/dns/geo/leak are skip or unknown here, so `health` is whatever deriveHealth says —
    // never `ok`, which is the only property this case has to hold.
    expect(deriveHealth(checks)).not.toBe('ok')
  })

  test('a device reporting the route down is tunnel: fail, carrying the device’s own account', () => {
    const checks = buildChecks(vpnInput({ observed: { prepared: true, up: false }, observedAt: 100 }))
    const c = byId(checks)
    expect(c.tunnel?.state).toBe('fail')
    expect(c.tunnel?.detail).toBe('device reports the route is not up')
  })

  test('plan 54 §4.3 — a held route reads as fail-closed, never as healthy: tunnel pass, upstream/egress fail', () => {
    const checks = buildChecks(
      vpnInput({
        observed: { prepared: true, up: false, state: 'held', lastError: 'upstream unreachable' },
        observedAt: 100,
        probeUrl: 'https://probe.internal/x',
        agentCapabilities: ['egress-probe'],
        probe: { tunnelled: { ok: true, status: 200, body: '1.2.3.4', ms: 10 }, direct: { ok: true, status: 200, ms: 10 } },
        probeAt: 101,
      }),
    )
    const c = byId(checks)
    expect(c.tunnel?.state).toBe('pass')
    expect(c.upstream?.state).toBe('fail')
    expect(c.egress?.state).toBe('fail')
    expect(deriveHealth(checks)).toBe('degraded')
  })

  test('geo stays skip forever without a declared expectation, and skip (naming the setting) without a provider', () => {
    expect(byId(buildChecks(vpnInput({ observed: upObservation, observedAt: 1 }))).geo).toMatchObject({
      state: 'skip',
      detail: 'no expected region was configured for this upstream',
    })
    const noProvider = byId(buildChecks(vpnInput({ observed: upObservation, observedAt: 1, expect: { country: 'JP' }, geoProviderConfigured: false })))
    expect(noProvider.geo?.state).toBe('skip')
    expect(noProvider.geo?.detail).toContain('geo lookup provider')
  })

  test('geo pass/fail/unknown follow the observation, and a failed lookup is unknown rather than pass', () => {
    const observation: GeoObservation = { address: '1.2.3.4', country: 'JP', region: 'Tokyo', city: 'Tokyo', asn: 64500, isp: 'Example', at: 50 }
    const pass = byId(buildChecks(vpnInput({ observed: upObservation, observedAt: 1, expect: { country: 'JP' }, geoProviderConfigured: true, geoObservation: observation })))
    expect(pass.geo?.state).toBe('pass')
    const fail = byId(buildChecks(vpnInput({ observed: upObservation, observedAt: 1, expect: { country: 'US' }, geoProviderConfigured: true, geoObservation: observation })))
    expect(fail.geo?.state).toBe('fail')
    expect(fail.geo?.detail).toContain('expected US')
    const errored = byId(
      buildChecks(vpnInput({ observed: upObservation, observedAt: 1, expect: { country: 'JP' }, geoProviderConfigured: true, geoError: { code: 'E_X', message: 'provider down' } })),
    )
    expect(errored.geo?.state).toBe('unknown')
    expect(errored.geo?.detail).toBe('provider down')
  })

  test('dns skips without a delegated zone or a geo provider, and passes its own result through once it has one', () => {
    const noZone = byId(buildChecks(vpnInput({ observed: upObservation, observedAt: 1, probeUrl: 'https://probe.internal/x' })))
    expect(noZone.dns?.state).toBe('skip')
    expect(noZone.dns?.detail).toContain('ENKAKU_NETWORK_PROBE_DNS_ZONE')
    const noGeo = byId(buildChecks(vpnInput({ observed: upObservation, observedAt: 1, probeUrl: 'https://probe.internal/x', probeDnsZoneConfigured: true })))
    expect(noGeo.dns?.state).toBe('skip')
    expect(noGeo.dns?.detail).toContain('geo lookup provider')
    const resolved = byId(
      buildChecks(
        vpnInput({
          observed: upObservation,
          observedAt: 1,
          probeUrl: 'https://probe.internal/x',
          probeDnsZoneConfigured: true,
          geoProviderConfigured: true,
          agentCapabilities: ['egress-probe'],
          dnsResult: { state: 'fail', detail: 'resolved by someone else', at: 7 },
        }),
      ),
    )
    expect(resolved.dns).toMatchObject({ state: 'fail', detail: 'resolved by someone else', at: 7 })
  })

  test('leak is pass/fail/skip from the device’s own ipv6Blocked, and unknown before any observation', () => {
    expect(byId(buildChecks(vpnInput({ observed: upObservation, observedAt: 1, ipv6Blocked: true }))).leak?.state).toBe('pass')
    const leaking = byId(buildChecks(vpnInput({ observed: upObservation, observedAt: 1, ipv6Blocked: false })))
    expect(leaking.leak?.state).toBe('fail')
    expect(leaking.leak?.detail).toContain('IPv6')
    expect(byId(buildChecks(vpnInput({ observed: upObservation, observedAt: 1, ipv6Blocked: undefined }))).leak?.state).toBe('skip')
    expect(byId(buildChecks(vpnInput({ observed: null }))).leak?.state).toBe('unknown')
  })

  test('a probe WIRE failure (never reached a result) is upstream/egress fail, distinct from a leg reporting its own failure', () => {
    const checks = byId(
      buildChecks(
        vpnInput({
          observed: upObservation,
          observedAt: 1,
          probeUrl: 'https://probe.internal/x',
          agentCapabilities: ['egress-probe'],
          probe: null,
          probeError: { code: 'E_TIMEOUT', message: 'the agent did not answer the probe' },
          probeAt: 2,
        }),
      ),
    )
    expect(checks.upstream?.state).toBe('fail')
    expect(checks.egress?.state).toBe('fail')
    expect(checks.egress?.detail).toBe('the agent did not answer the probe')
  })
})

describe('the pure helpers buildChecks shares with the route service', () => {
  test('safeCheckDetail strips URL userinfo and any literal secret of 3+ characters', () => {
    expect(safeCheckDetail('socks5://sam:hunter2@proxy:1080 refused')).toBe('socks5://<redacted>@proxy:1080 refused')
    expect(safeCheckDetail('auth failed for hunter2', ['hunter2'])).toBe('auth failed for <redacted>')
    // Too short to distinguish from ordinary text — deliberately left alone.
    expect(safeCheckDetail('ab is fine', ['ab'])).toBe('ab is fine')
    expect(safeCheckDetail(undefined)).toBeUndefined()
  })

  test('redactObservationForResponse scrubs the device’s own lastError and leaves everything else', () => {
    const observed: NetworkObservation = { prepared: true, up: false, lastError: 'auth failed for hunter2' }
    expect(redactObservationForResponse(observed, ['hunter2'])).toEqual({ prepared: true, up: false, lastError: 'auth failed for <redacted>' })
    expect(redactObservationForResponse(null, ['hunter2'])).toBeNull()
  })

  test('parseEgressAddress reads the shapes a probe endpoint actually answers with, and nothing it cannot recognise', () => {
    expect(parseEgressAddress('{"ip":"1.2.3.4"}')).toBe('1.2.3.4')
    expect(parseEgressAddress('{"address":"1.2.3.4"}')).toBe('1.2.3.4')
    expect(parseEgressAddress(' 1.2.3.4 ')).toBe('1.2.3.4')
    expect(parseEgressAddress('<html>nope</html>')).toBeUndefined()
    expect(parseEgressAddress(undefined)).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// buildAdvisoryChecks — plan 114 §3.5
// ---------------------------------------------------------------------------

function advisoryInput(overrides: Partial<AdvisoryChecksInput> = {}): AdvisoryChecksInput {
  return {
    engine: 'adb-proxy',
    declaredValue: '10.0.0.9:8080',
    observed: null,
    observedAt: null,
    lastError: null,
    upstream: null,
    reverse: null,
    ...overrides,
  }
}

const observedProxy = (value: string): NetworkObservation => ({ prepared: true, up: value !== '', state: value !== '' ? 'up' : 'down', ...(value !== '' ? { upstream: value } : {}) })

describe('buildAdvisoryChecks — health can never be ok (plan 114 acceptance criterion 3)', () => {
  test('egress is skip and health is never ok across the FULL cross-product of every input that varies', () => {
    const engines: AdvisoryChecksInput['engine'][] = ['adb-proxy', 'adb-reverse-proxy']
    const observations: Array<[string, NetworkObservation | null]> = [
      ['none', null],
      ['matching', observedProxy('10.0.0.9:8080')],
      ['mismatching', observedProxy('somewhere.else:3128')],
    ]
    const upstreams: Array<[string, AdvisoryChecksInput['upstream']]> = [
      ['null', null],
      ['pass', { ok: true, detail: 'this machine opened a TCP connection', at: 5 }],
      ['fail', { ok: false, detail: 'this machine could not reach it', at: 5 }],
    ]
    const reverses: Array<[string, AdvisoryChecksInput['reverse']]> = [
      ['null', null],
      ['pass', { ok: true, detail: 'the adb server lists a reverse', at: 5 }],
      ['fail', { ok: false, detail: 'the adb server lists no reverse', at: 5 }],
    ]
    const lastErrors: Array<[string, AdvisoryChecksInput['lastError']]> = [
      ['null', null],
      ['set', { code: 'E_SETTING_NOT_ACCEPTED', message: 'the device did not accept the proxy setting' }],
    ]

    let permutations = 0
    for (const engine of engines) {
      for (const [oName, observed] of observations) {
        for (const [uName, upstream] of upstreams) {
          for (const [rName, reverse] of reverses) {
            for (const [eName, lastError] of lastErrors) {
              permutations++
              const where = `${engine}/observed:${oName}/upstream:${uName}/reverse:${rName}/lastError:${eName}`
              const checks = buildAdvisoryChecks(advisoryInput({ engine, observed, observedAt: observed ? 5 : null, upstream, reverse, lastError }))
              const c = byId(checks)
              expect(c.egress?.state, where).toBe('skip')
              expect(c.egress?.detail, where).toBe(ADVISORY_EGRESS_DETAIL)
              expect(deriveHealth(checks), where).not.toBe('ok')
            }
          }
        }
      }
    }
    // 2 engines × 3 observations × 3 upstreams × 3 reverses × 2 lastErrors.
    expect(permutations).toBe(108)
  })

  test('health can never be ok for adb-reverse-proxy on any permutation, including everything passing at once', () => {
    const checks = buildAdvisoryChecks(
      advisoryInput({
        engine: 'adb-reverse-proxy',
        declaredValue: '127.0.0.1:28100',
        observed: observedProxy('127.0.0.1:28100'),
        observedAt: 5,
        upstream: { ok: true, detail: 'listening', at: 5 },
        reverse: { ok: true, detail: 'listed', at: 5 },
      }),
    )
    const c = byId(checks)
    expect(c.setting?.state).toBe('pass')
    expect(c.reverse?.state).toBe('pass')
    expect(c.upstream?.state).toBe('pass')
    expect(deriveHealth(checks)).toBe('unverified')
  })
})

describe('buildAdvisoryChecks — the setting check', () => {
  test('pass only when the device reports EXACTLY the declared value', () => {
    const c = byId(buildAdvisoryChecks(advisoryInput({ observed: observedProxy('10.0.0.9:8080'), observedAt: 9 })))
    expect(c.setting?.state).toBe('pass')
    expect(c.setting?.at).toBe(9)
    expect(c.setting?.detail).toBe('the device reports http_proxy 10.0.0.9:8080')
  })

  test('fail names both values — what the device says and what this farm wrote', () => {
    const c = byId(buildAdvisoryChecks(advisoryInput({ observed: observedProxy('other.host:3128'), observedAt: 9 })))
    expect(c.setting?.state).toBe('fail')
    expect(c.setting?.detail).toContain('other.host:3128')
    expect(c.setting?.detail).toContain('10.0.0.9:8080')
  })

  test('a device that reports no proxy at all fails, worded as (unset) rather than as an empty string', () => {
    const c = byId(buildAdvisoryChecks(advisoryInput({ observed: observedProxy(''), observedAt: 9 })))
    expect(c.setting?.state).toBe('fail')
    expect(c.setting?.detail).toContain('(unset)')
  })

  test('unknown before any observation has been made', () => {
    const c = byId(buildAdvisoryChecks(advisoryInput({ observed: null })))
    expect(c.setting?.state).toBe('unknown')
    expect(c.setting?.at).toBeNull()
  })

  test('a lastError outranks a stale MATCHING observation — "we could not ask" is fail, not a leftover pass', () => {
    const c = byId(
      buildAdvisoryChecks(
        advisoryInput({
          observed: observedProxy('10.0.0.9:8080'),
          observedAt: 9,
          lastError: { code: 'E_SETTING_READ_FAILED', message: 'settings get global http_proxy exited 1' },
        }),
      ),
    )
    expect(c.setting?.state).toBe('fail')
    expect(c.setting?.detail).toBe('settings get global http_proxy exited 1')
  })

  /**
   * The defect step 114.5 found and fixed, kept as a test because it is the
   * exact shape a "pass" must never take: the route declared `''` (no device
   * port allocated yet), the phone's `http_proxy` was unset, and two absences
   * compared equal.
   */
  test('an enabled rung-2 route with no allocated device port is unknown, NEVER pass — a pass built from two absences', () => {
    const c = byId(buildAdvisoryChecks(advisoryInput({ engine: 'adb-reverse-proxy', declaredValue: '', observed: observedProxy(''), observedAt: 9 })))
    expect(c.setting?.state).toBe('unknown')
    expect(c.setting?.state).not.toBe('pass')
    expect(c.setting?.detail).toContain('no device-side address yet')
    expect(c.setting?.at).toBeNull()
  })
})

describe('buildAdvisoryChecks — reverse, and the checks that are permanently skip', () => {
  test('reverse is skip for adb-proxy, naming why rather than leaving a bare skip', () => {
    const c = byId(buildAdvisoryChecks(advisoryInput({ engine: 'adb-proxy' })))
    expect(c.reverse?.state).toBe('skip')
    expect(c.reverse?.detail).toContain('no adb reverse to check')
  })

  test('reverse is unknown → pass → fail for adb-reverse-proxy, carrying the check’s own detail and timestamp', () => {
    const never = byId(buildAdvisoryChecks(advisoryInput({ engine: 'adb-reverse-proxy', declaredValue: '127.0.0.1:28100', reverse: null })))
    expect(never.reverse?.state).toBe('unknown')
    const live = byId(
      buildAdvisoryChecks(advisoryInput({ engine: 'adb-reverse-proxy', declaredValue: '127.0.0.1:28100', reverse: { ok: true, detail: 'the adb server lists it', at: 11 } })),
    )
    expect(live.reverse).toMatchObject({ state: 'pass', detail: 'the adb server lists it', at: 11 })
    const dead = byId(
      buildAdvisoryChecks(advisoryInput({ engine: 'adb-reverse-proxy', declaredValue: '127.0.0.1:28100', reverse: { ok: false, detail: 'not live', at: 11 } })),
    )
    expect(dead.reverse).toMatchObject({ state: 'fail', detail: 'not live', at: 11 })
  })

  test('upstream is unknown before its first dial — it CAN run, it just has not yet — then pass/fail verbatim', () => {
    expect(byId(buildAdvisoryChecks(advisoryInput({ upstream: null }))).upstream?.state).toBe('unknown')
    expect(byId(buildAdvisoryChecks(advisoryInput({ upstream: { ok: true, detail: 'dialled', at: 3 } }))).upstream).toMatchObject({ state: 'pass', detail: 'dialled', at: 3 })
    expect(byId(buildAdvisoryChecks(advisoryInput({ upstream: { ok: false, detail: 'refused', at: 3 } }))).upstream).toMatchObject({ state: 'fail', detail: 'refused', at: 3 })
  })

  test('tunnel/geo/dns/leak are skip WITH a reason for both advisory engines — never a bare skip', () => {
    for (const engine of ['adb-proxy', 'adb-reverse-proxy'] as const) {
      const c = byId(buildAdvisoryChecks(advisoryInput({ engine, declaredValue: engine === 'adb-proxy' ? '10.0.0.9:8080' : '127.0.0.1:28100' })))
      for (const id of ['tunnel', 'geo', 'dns', 'leak'] as const) {
        expect(c[id]?.state, `${engine}/${id}`).toBe('skip')
        expect((c[id]?.detail ?? '').length, `${engine}/${id}`).toBeGreaterThan(0)
        expect(c[id]?.at, `${engine}/${id}`).toBeNull()
      }
    }
  })
})

describe('buildAdvisoryChecks — the forbidden words (plan 114 acceptance criterion 4)', () => {
  /**
   * Criterion 4's grep, applied to the core's own strings: `routed`, `ok`,
   * `success` and a bare `enabled` are the four words that would turn "the
   * device has been asked to use this proxy" into a claim about the traffic
   * this rung structurally cannot make. Whole words only — "looking" and
   * "unlocked" are not claims.
   */
  const FORBIDDEN = /\b(routed|ok|success|successful|successfully|enabled)\b/i

  test('no advisory check detail, on any permutation, reads routed / ok / success / a bare enabled', () => {
    const details: string[] = []
    for (const engine of ['adb-proxy', 'adb-reverse-proxy'] as const) {
      for (const declaredValue of ['10.0.0.9:8080', '']) {
        for (const observed of [null, observedProxy(''), observedProxy('10.0.0.9:8080'), observedProxy('elsewhere:1')]) {
          for (const lastError of [null, { code: 'E_SETTING_NOT_ACCEPTED', message: 'the device did not accept the proxy setting' }]) {
            for (const check of buildAdvisoryChecks(advisoryInput({ engine, declaredValue, observed, observedAt: observed ? 1 : null, lastError }))) {
              if (check.detail) details.push(check.detail)
            }
          }
        }
      }
    }
    expect(details.length).toBeGreaterThan(0)
    for (const detail of details) expect(detail, detail).not.toMatch(FORBIDDEN)
  })

  test('the permanent egress sentence says which fact is missing, and never implies one that is not', () => {
    expect(ADVISORY_EGRESS_DETAIL).not.toMatch(FORBIDDEN)
    expect(ADVISORY_EGRESS_DETAIL).toContain('advisory')
    expect(ADVISORY_EGRESS_DETAIL).toContain('VPN mode')
  })
})
