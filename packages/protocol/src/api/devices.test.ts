import { describe, expect, test } from 'bun:test'
import {
  AgentProvisionReportSchema,
  classifyDeviceNetworkApply,
  DeviceHttpProxyNetworkConfigSchema,
  DeviceNetworkApplyBodySchema,
  DeviceNetworkApplyResponseSchema,
  DeviceNetworkApplyResultSchema,
  DeviceNetworkConfigSchema,
  DeviceNetworkStatusResponseSchema,
  DeviceRefSchema,
  DeviceRefsResponseSchema,
  DeviceReverseProxyNetworkConfigSchema,
  DeviceVpnNetworkConfigSchema,
  GuestAgentStatusResponseSchema,
  GuestAgentSummaryResponseSchema,
  StoredDeviceNetworkConfigSchema,
  type DeviceNetworkApplyResult,
} from './devices'

/**
 * Plan 90 §5 step 90.6 — the one thing this step MUST do: widen
 * `GuestAgentStatusResponseSchema.state` to carry `outdated`/`failed`
 * (the states `AgentProvisioner` already computes, F10/F11) without breaking
 * the pre-plan-90 five values Studio's `AgentStateBadge`/`NetworkPanel`
 * already parse and render branches against. Both halves — the schema and
 * every Studio branch — are exercised together: this file proves the
 * schema PARSES; `AgentPanel.test.tsx` proves it RENDERS.
 */
describe('GuestAgentStatusResponseSchema — widened for plan 90 §3.8 (F10, F11)', () => {
  test('every pre-plan-90 state still parses (no regression)', () => {
    for (const state of ['not-installed', 'installed', 'ready', 'unreachable', 'unsupported'] as const) {
      expect(GuestAgentStatusResponseSchema.parse({ state })).toEqual({ state })
    }
  })

  test('a response carrying "outdated" parses', () => {
    const body = {
      state: 'outdated',
      appVersion: '1.0.0',
      androidSdkInt: 33,
      capabilities: ['socks5-route'],
      reason: 'installed build does not match the pinned manifest artefact',
    }
    expect(GuestAgentStatusResponseSchema.parse(body)).toMatchObject(body)
  })

  test('a response carrying "failed" parses', () => {
    const body = { state: 'failed', reason: 'E_CHECKSUM_MISSING: no sha256 pinned for this build' }
    expect(GuestAgentStatusResponseSchema.parse(body)).toMatchObject(body)
  })

  test('an unrecognised state is still rejected — this is a widen, not an open string', () => {
    expect(GuestAgentStatusResponseSchema.safeParse({ state: 'something-else' }).success).toBe(false)
  })

  test('the §4.7 extension fields (versionCode/checkedAt/attempts/nextAttemptAt) are optional — no producer on this endpoint yet', () => {
    const parsed = GuestAgentStatusResponseSchema.parse({ state: 'ready' })
    expect(parsed.versionCode).toBeUndefined()
    expect(parsed.checkedAt).toBeUndefined()
    // When a future wiring DOES send them, they parse too.
    const withExtension = GuestAgentStatusResponseSchema.parse({
      state: 'outdated',
      versionCode: 12,
      checkedAt: 1_700_000_000,
      attempts: 1,
      nextAttemptAt: 1_700_000_060,
    })
    expect(withExtension.versionCode).toBe(12)
    expect(withExtension.nextAttemptAt).toBe(1_700_000_060)
  })
})

describe('DeviceNetworkStatusResponseSchema.recovery — plan 90 §3.7 rule 5 (fixes F20)', () => {
  const base = {
    engine: 'vpn-helper' as const,
    config: null,
    enabled: false,
    observed: null,
    drift: false,
    sessionId: null,
    failClosed: true,
    health: 'unknown' as const,
    checks: [],
    lastError: null,
    exitHistory: [],
  }

  test('null recovery parses — no automatic recovery has ever run for this route', () => {
    expect(DeviceNetworkStatusResponseSchema.parse({ ...base, recovery: null }).recovery).toBeNull()
  })

  test('a mid-backoff recovery block parses', () => {
    const recovery = { attempts: 2, maxAttempts: 3, nextAttemptAt: 1_700_000_014, exhausted: false, reconnectCycles: 1 }
    expect(DeviceNetworkStatusResponseSchema.parse({ ...base, recovery }).recovery).toEqual(recovery)
  })

  test('an exhausted recovery block parses', () => {
    const recovery = { attempts: 3, maxAttempts: 3, nextAttemptAt: 1_700_000_480, exhausted: true, reconnectCycles: 0 }
    expect(DeviceNetworkStatusResponseSchema.parse({ ...base, recovery }).recovery).toEqual(recovery)
  })
})

describe('AgentProvisionReportSchema / GuestAgentSummaryResponseSchema — plan 90 §4.7', () => {
  test('a fleet-wide provision report parses, including outdated/failed results', () => {
    const report = {
      total: 3,
      results: [
        { deviceId: 'dev-1', state: 'ready' as const, reason: null },
        { deviceId: 'dev-2', state: 'outdated' as const, reason: 'version mismatch' },
        { deviceId: 'dev-3', state: 'failed' as const, reason: 'install failed' },
      ],
    }
    expect(AgentProvisionReportSchema.parse(report)).toEqual(report)
  })

  test('the summary parses byState/byVersion as open string-keyed counts', () => {
    const summary = { total: 20, byState: { ready: 18, outdated: 2 }, byVersion: { '1.2.0': 18, '1.1.0': 2 } }
    expect(GuestAgentSummaryResponseSchema.parse(summary)).toEqual(summary)
  })
})

// ---------------------------------------------------------------------------
// Plan 114 §4.1 / steps 114.6, 114.8, 114.9 — the RESPONSE side of the config
// union. The invariant this whole block defends is acceptance criterion 8's
// half that lives here: the response union is deliberately NARROWER than the
// protocol's own `NetworkRouteConfigSchema`, because a response must never be
// able to carry a `username` or a `password`.
// ---------------------------------------------------------------------------

/** A verbatim `GET /api/devices/:id/network` body from a core that predates plan 114 — no `engine`, no `setBy`. */
const PRE_114_BODY = {
  engine: 'vpn-helper',
  config: { host: 'proxy.example', port: 1080, credentialRef: 'soax-jp', udpMode: 'udp', onGeoFail: 'report' },
  enabled: true,
  observed: { up: true, state: 'up', upstream: 'proxy.example:1080', stats: [1, 2, 3, 4] },
  drift: false,
  sessionId: 'sess-1',
  failClosed: true,
  health: 'unverified',
  checks: [{ id: 'tunnel', state: 'pass', at: 1_700_000_000 }],
  lastError: null,
  exitHistory: [],
  recovery: null,
}

describe('DeviceNetworkStatusResponseSchema.config — the read-time migration on the wire (plan 114 §4.1, step 114.6)', () => {
  test('a verbatim pre-114 body parses, and its untagged config reads as vpn-helper', () => {
    const parsed = DeviceNetworkStatusResponseSchema.parse(PRE_114_BODY)
    expect(parsed.config).not.toBeNull()
    expect(parsed.config?.engine).toBe('vpn-helper')
    if (parsed.config?.engine !== 'vpn-helper') throw new Error('expected the vpn-helper arm')
    expect(parsed.config.credentialRef).toBe('soax-jp')
    expect(parsed.config.host).toBe('proxy.example')
  })

  test('config: null parses — the nullability sits OUTSIDE the preprocess, so null never reaches the union', () => {
    expect(DeviceNetworkStatusResponseSchema.parse({ ...PRE_114_BODY, config: null }).config).toBeNull()
  })

  test('an adb-proxy config parses', () => {
    const body = { ...PRE_114_BODY, engine: 'adb-proxy', config: { engine: 'adb-proxy', host: '10.0.0.2', port: 8899, exclusions: ['localhost'] } }
    const parsed = DeviceNetworkStatusResponseSchema.parse(body)
    expect(parsed.config?.engine).toBe('adb-proxy')
    if (parsed.config?.engine !== 'adb-proxy') throw new Error('expected the adb-proxy arm')
    expect(parsed.config.exclusions).toEqual(['localhost'])
  })

  test('a reverse config parses WITH a devicePort', () => {
    const body = { ...PRE_114_BODY, engine: 'adb-reverse-proxy', config: { engine: 'adb-reverse-proxy', hostPort: 8888, devicePort: 28100 } }
    const parsed = DeviceNetworkStatusResponseSchema.parse(body)
    if (parsed.config?.engine !== 'adb-reverse-proxy') throw new Error('expected the reverse arm')
    expect(parsed.config.devicePort).toBe(28100)
  })

  test('a reverse config parses with devicePort: NULL — the regression step 114.8 fixed', () => {
    // The core emits this key unconditionally and emits `null` until a reverse has actually been
    // established. Declared `z.number().optional()` alone, every GET in that window failed the
    // parse outright — the exact window acceptance criterion 10 says must be REPORTED.
    const body = { ...PRE_114_BODY, engine: 'adb-reverse-proxy', config: { engine: 'adb-reverse-proxy', hostPort: 8888, devicePort: null } }
    const parsed = DeviceNetworkStatusResponseSchema.parse(body)
    if (parsed.config?.engine !== 'adb-reverse-proxy') throw new Error('expected the reverse arm')
    expect(parsed.config.devicePort).toBeNull()
  })

  test('a reverse config parses with devicePort ABSENT as well', () => {
    const body = { ...PRE_114_BODY, engine: 'adb-reverse-proxy', config: { engine: 'adb-reverse-proxy', hostPort: 8888 } }
    const parsed = DeviceNetworkStatusResponseSchema.parse(body)
    if (parsed.config?.engine !== 'adb-reverse-proxy') throw new Error('expected the reverse arm')
    expect(parsed.config.devicePort).toBeUndefined()
  })

  test('the same two devicePort readings hold on the bare arm schema', () => {
    expect(DeviceReverseProxyNetworkConfigSchema.parse({ engine: 'adb-reverse-proxy', hostPort: 8888, devicePort: null }).devicePort).toBeNull()
    expect(DeviceReverseProxyNetworkConfigSchema.parse({ engine: 'adb-reverse-proxy', hostPort: 8888 }).devicePort).toBeUndefined()
  })

  test('StoredDeviceNetworkConfigSchema rejects an array and null on its own, exactly as the protocol-side one does', () => {
    expect(StoredDeviceNetworkConfigSchema.safeParse([{ host: 'h', port: 1080, udpMode: 'udp', onGeoFail: 'report' }]).success).toBe(false)
    expect(StoredDeviceNetworkConfigSchema.safeParse(null).success).toBe(false)
  })

  test('DeviceNetworkConfigSchema (the BARE union) refuses an untagged config — an untagged PUT body from a post-114 client is a client bug', () => {
    expect(DeviceNetworkConfigSchema.safeParse({ host: 'h', port: 1080, udpMode: 'udp', onGeoFail: 'report' }).success).toBe(false)
  })
})

describe('DeviceNetworkStatusResponseSchema.setBy (plan 114 §3.3, step 114.9)', () => {
  test('a response with NO setBy key parses to null — an older core’s silence reads as "nobody claimed it"', () => {
    expect(DeviceNetworkStatusResponseSchema.parse(PRE_114_BODY).setBy).toBeNull()
  })

  test('an explicit null parses to null', () => {
    expect(DeviceNetworkStatusResponseSchema.parse({ ...PRE_114_BODY, setBy: null }).setBy).toBeNull()
  })

  test('both kinds parse', () => {
    for (const kind of ['user', 'plugin'] as const) {
      const setBy = { kind, id: 'sam', at: 1_700_000_000 }
      expect(DeviceNetworkStatusResponseSchema.parse({ ...PRE_114_BODY, setBy }).setBy).toEqual(setBy)
    }
  })

  test('an unknown kind is rejected — not coerced, not folded into "user"', () => {
    for (const kind of ['system', 'farm', 'script', '']) {
      expect(DeviceNetworkStatusResponseSchema.safeParse({ ...PRE_114_BODY, setBy: { kind, id: 'x', at: 1 } }).success).toBe(false)
    }
  })
})

describe('DeviceVpnNetworkConfigSchema is NARROWER than the protocol union — plan 114 acceptance criterion 8', () => {
  /**
   * A structural assertion, deliberately, and it guards against one specific
   * future edit: "the response union duplicates `NetworkRouteConfigSchema`, just
   * import that one instead". Doing so would re-admit `username`/`password` to a
   * RESPONSE shape, which the API has never returned since plan 44 §4.5. The
   * comment on the schema says so; this makes the comment enforceable.
   */
  test('the schema has no username and no password key at all', () => {
    const keys = Object.keys(DeviceVpnNetworkConfigSchema.shape)
    expect(keys).not.toContain('username')
    expect(keys).not.toContain('password')
    // `credentialUsername` is deliberately NOT a relaxation of the two lines above, and its name is
    // half the reason: it is resolved by the core from `network_credentials` and reports WHICH
    // upstream identity a route uses, which is the fact an operator reads a route by. `username` on
    // this shape would be the write field coming back — a different thing, and the one this guard
    // exists to keep out. The password has no arm here at all; it crosses the wire only on
    // `DeviceNetworkCredentialRevealResponseSchema`, in answer to a deliberate, audited request.
    expect(keys).toContain('credentialUsername')
    expect(keys.sort()).toEqual(['credentialRef', 'credentialUsername', 'engine', 'expect', 'host', 'onGeoFail', 'port', 'udpMode'])
  })

  test('a body carrying them is STRIPPED, so nothing downstream can read a secret back off a parsed response', () => {
    const parsed = DeviceVpnNetworkConfigSchema.parse({
      host: 'proxy.example',
      port: 1080,
      udpMode: 'udp',
      onGeoFail: 'report',
      username: 'sam',
      password: 'hunter2',
    })
    expect(parsed).not.toHaveProperty('username')
    expect(parsed).not.toHaveProperty('password')
    expect(JSON.stringify(parsed)).not.toContain('hunter2')
    expect(parsed.engine).toBe('vpn-helper')
  })

  test('neither HTTP arm has one either — §3.8: no credential is ever written into a device setting', () => {
    for (const shape of [DeviceHttpProxyNetworkConfigSchema.shape, DeviceReverseProxyNetworkConfigSchema.shape]) {
      expect(Object.keys(shape)).not.toContain('username')
      expect(Object.keys(shape)).not.toContain('password')
    }
  })
})

describe('classifyDeviceNetworkApply (plan 114 §3.9, step 114.8)', () => {
  const result = (over: Partial<DeviceNetworkApplyResult>): DeviceNetworkApplyResult => ({
    deviceId: 'dev-1',
    status: null,
    skip: null,
    error: null,
    ...over,
  })

  test('a clean row with a status is "applied"', () => {
    const status = DeviceNetworkStatusResponseSchema.parse(PRE_114_BODY)
    expect(classifyDeviceNetworkApply(result({ status }))).toBe('applied')
  })

  test('an unverified status is still APPLIED — it is the normal terminal state of both HTTP rungs (§3.5)', () => {
    const status = DeviceNetworkStatusResponseSchema.parse({
      ...PRE_114_BODY,
      engine: 'adb-proxy',
      config: { engine: 'adb-proxy', host: '10.0.0.2', port: 8899 },
      health: 'unverified',
      checks: [
        { id: 'setting', state: 'pass', at: 1 },
        { id: 'egress', state: 'skip', at: null },
      ],
    })
    expect(status.health).toBe('unverified')
    expect(classifyDeviceNetworkApply(result({ status }))).toBe('applied')
  })

  test('an error alone is "failed"', () => {
    expect(classifyDeviceNetworkApply(result({ error: { code: 'E_SETTING_NOT_ACCEPTED', message: 'declined' } }))).toBe('failed')
  })

  test('a skip alone is "skipped"', () => {
    expect(classifyDeviceNetworkApply(result({ skip: { code: 'E_DEVICE_OFFLINE', message: 'not reachable' } }))).toBe('skipped')
  })

  test('SKIP WINS OVER ERROR — a skipped device may legally carry neither a status nor an error, and the check order says so', () => {
    const row = result({
      skip: { code: 'E_DEVICE_CONFLICT', message: 'somebody else is driving it' },
      error: { code: 'E_REVERSE_FAILED', message: 'adb reverse did not establish' },
    })
    expect(classifyDeviceNetworkApply(row)).toBe('skipped')
  })

  test('ERROR WINS OVER APPLIED — a route persisted and then failing to apply produces BOTH a status and an error', () => {
    const status = DeviceNetworkStatusResponseSchema.parse(PRE_114_BODY)
    const row = result({ status, error: { code: 'E_SETTING_NOT_ACCEPTED', message: 'the device reports ""' } })
    expect(classifyDeviceNetworkApply(row)).toBe('failed')
  })

  test('a skip on a row that also has a status still classifies as skipped', () => {
    const status = DeviceNetworkStatusResponseSchema.parse(PRE_114_BODY)
    expect(classifyDeviceNetworkApply(result({ status, skip: { code: 'E_UNSUPPORTED', message: 'old phone' } }))).toBe('skipped')
  })
})

describe('the bulk apply envelope round-trips (plan 114 §3.9, step 114.8)', () => {
  test('a mixed four-device response parses and re-classifies to four distinct outcomes', () => {
    const status = DeviceNetworkStatusResponseSchema.parse(PRE_114_BODY)
    const body = {
      total: 4,
      results: [
        { deviceId: 'ok-1', status, skip: null, error: null },
        { deviceId: 'offline-1', status: null, skip: { code: 'E_DEVICE_OFFLINE', message: 'not reachable' }, error: null },
        { deviceId: 'held-1', status: null, skip: { code: 'E_DEVICE_CONFLICT', message: 'in use' }, error: null },
        { deviceId: 'broken-1', status: null, skip: null, error: { code: 'E_SETTING_NOT_ACCEPTED', message: 'declined' } },
      ],
    }
    const parsed = DeviceNetworkApplyResponseSchema.parse(body)
    expect(parsed.total).toBe(4)
    expect(parsed.results.map(classifyDeviceNetworkApply)).toEqual(['applied', 'skipped', 'skipped', 'failed'])
    // Round-trip: re-parsing what we parsed changes nothing.
    expect(DeviceNetworkApplyResponseSchema.parse(parsed)).toEqual(parsed)
  })

  test('a single result round-trips through its own schema', () => {
    const row = { deviceId: 'dev-1', status: null, skip: null, error: { code: 'E_REVERSE_FAILED', message: 'no' } }
    expect(DeviceNetworkApplyResultSchema.parse(row)).toEqual(row)
  })

  test('the request body keeps `route` UNPARSED — a username survives to the core’s own door rather than being silently stripped', () => {
    // This is the single most load-bearing decision in the envelope: a Zod object strips unknown
    // keys, so declaring `route: DeviceNetworkConfigSchema` here would drop a `password` before
    // `assertNoHttpProxyAuth` ever saw it, and the operator would be told an authenticated proxy
    // had been applied to forty phones when an anonymous one was written.
    const parsed = DeviceNetworkApplyBodySchema.parse({
      deviceIds: ['a', 'b'],
      route: { engine: 'adb-proxy', host: 'h', port: 8080, username: 'sam', password: 'hunter2' },
    })
    expect(parsed.route.username).toBe('sam')
    expect(parsed.route.password).toBe('hunter2')
  })

  test('`route` still has to BE an object — a string, an array and null are all refused', () => {
    for (const route of ['nope', [{ engine: 'adb-proxy' }], null]) {
      expect(DeviceNetworkApplyBodySchema.safeParse({ deviceIds: ['a'], route }).success).toBe(false)
    }
  })

  test('an empty deviceIds list is refused', () => {
    expect(DeviceNetworkApplyBodySchema.safeParse({ deviceIds: [], route: {} }).success).toBe(false)
  })
})

/**
 * Plan 124 §3.7, §3.1 — `GET /api/devices/refs` is the highest-value of the
 * five payloads that named a device and carried no number, because Studio's
 * `deviceRefLabel` (`packages/studio/src/lib/api.ts`) is by its own comment
 * "the one place this formatting rule lives" and every dangling reference in
 * the product is named through it.
 *
 * This is also the first Zod home the route's response has had: it answered
 * with a hand-written inline TS shape before this step, which is exactly how
 * a field like `number` goes missing without anything failing.
 */
describe('DeviceRefSchema / DeviceRefsResponseSchema (plan 47 §4.5, plan 124 §3.7)', () => {
  test('a live ref carries the number as its own field — never `#7` pre-composed into label', () => {
    const parsed = DeviceRefSchema.parse({ id: 'd1', label: 'Galaxy A15', stableId: 'R5CW', deleted: false, number: 7 })
    expect(parsed.number).toBe(7)
    expect(parsed.label).toBe('Galaxy A15')
  })

  test('`number` is required and nullable: an unnumbered device states `null`, an omitted field is refused', () => {
    const base = { id: 'd1', label: 'Galaxy A15', stableId: 'R5CW', deleted: false }
    expect(DeviceRefSchema.safeParse({ ...base, number: null }).success).toBe(true)
    expect(DeviceRefSchema.safeParse(base).success).toBe(false)
    expect(DeviceRefSchema.safeParse({ ...base, number: 7.5 }).success).toBe(false)
  })

  test('`label` stays nullable — a device row can genuinely have no label, and that is not the same as having no number', () => {
    expect(DeviceRefSchema.safeParse({ id: 'd1', label: null, stableId: 'R5CW', deleted: true, number: 7 }).success).toBe(true)
  })

  test('the response is a MAP keyed by requested id — an id neither table knows is simply absent, never a null entry', () => {
    const parsed = DeviceRefsResponseSchema.parse({
      refs: { d1: { id: 'd1', label: 'Galaxy A15', stableId: 'R5CW', deleted: false, number: 7 } },
    })
    expect(Object.keys(parsed.refs)).toEqual(['d1'])
    expect(DeviceRefsResponseSchema.safeParse({ refs: {} }).success).toBe(true)
    expect(DeviceRefsResponseSchema.safeParse({ refs: { d1: null } }).success).toBe(false)
  })
})
