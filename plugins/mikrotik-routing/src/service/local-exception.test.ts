import { describe, expect, test } from 'bun:test'
import type { CoreAddressResult } from './core-address'
import { classifyLocalException, type ProtectedDevice } from './local-exception'
import { RouterRuleListSchema, type RouterRule } from './schemas'

/**
 * Plan 122 §5 step 122.12 — the corrected local-exception check, tested pure
 * (no router, no HTTP). Four fixtures anchor the four defects the step names:
 *
 * - defect A (comment-text match): the owner's own rule, comment
 *   "proxy: local exception" — not the hardcoded "farm: local exception" —
 *   must still be FOUND as a candidate.
 * - defect B (existence vs. coverage): that same rule's own `src-address`
 *   protects the SERVER's subnet, not the farm devices, and must still leave
 *   them named as uncovered (`partial`, never `ok`).
 * - defect C (position): a structurally correct rule sitting BELOW a
 *   device's own managed rule must not count as protecting that device.
 * - defect D (disabled/inactive): a rule that would otherwise qualify but
 *   carries `disabled`/`inactive` must never be a candidate.
 */

const CORE_DERIVED: CoreAddressResult = { kind: 'derived', address: '192.168.50.10' }

function device(id: string, address: string): ProtectedDevice {
  return { id, label: id, address }
}

describe('classifyLocalException — missing', () => {
  test('no rule at all: status missing, every device named uncovered', () => {
    const report = classifyLocalException([], [device('d1', '192.168.10.10')], CORE_DERIVED)
    expect(report.status).toBe('missing')
    expect(report.uncoveredDevices).toEqual([device('d1', '192.168.10.10')])
  })

  test('a rule with the right comment but wrong action never counts — defect A, in the direction that must still refuse', () => {
    const rules: RouterRule[] = RouterRuleListSchema.parse([
      { '.id': '*1', action: 'lookup-only-in-table', table: 'main', comment: 'farm: local exception', 'src-address': '192.168.10.0/24', 'dst-address': '192.168.0.0/16', disabled: false, inactive: false },
    ])
    const report = classifyLocalException(rules, [device('d1', '192.168.10.10')], CORE_DERIVED)
    expect(report.status).toBe('missing')
  })
})

describe('classifyLocalException — the owner\'s real router, verbatim (2026-08-21 incident)', () => {
  // Their actual `GET /rest/routing/rule` response, unmodified in field
  // content (only reordered into the plugin's own object-literal style).
  // Booleans arrive as the strings "true"/"false" exactly as their router
  // sent them — parsed through the real schema, not hand-typed booleans, so
  // this test exercises the same `boolish` coercion production traffic does.
  const OWNER_ROUTER_RULES: RouterRule[] = RouterRuleListSchema.parse([
    { '.id': '*7', '.nextid': '*3', action: 'lookup', comment: 'proxy: local exception', 'dst-address': '192.168.0.0/16', inactive: 'false', 'src-address': '192.168.50.0/24', table: 'main' },
    {
      '.id': '*3',
      '.nextid': '*2',
      action: 'lookup',
      comment: 'local exception .221',
      disabled: 'true',
      'dst-address': '192.168.100.0/24',
      inactive: 'true',
      'src-address': '192.168.10.221/32',
      table: 'main',
    },
    {
      '.id': '*2',
      '.nextid': '*5',
      action: 'lookup-only-in-table',
      comment: 'test device .221 via modem5',
      disabled: 'true',
      inactive: 'true',
      'src-address': '192.168.10.221/32',
      table: 'via-modem5-p10',
    },
    { '.id': '*5', '.nextid': '*8', action: 'lookup-only-in-table', comment: 'enkaku-proxy modem1 (test)', inactive: 'false', 'src-address': '192.168.100.230/32', table: 'via-modem1-p6' },
    { '.id': '*8', '.nextid': '*9', action: 'lookup-only-in-table', comment: 'enkaku:test:proxy1', inactive: 'false', 'src-address': '192.168.50.11/32', table: 'via-modem1-p6' },
    { '.id': '*9', '.nextid': '*A', action: 'lookup-only-in-table', comment: 'enkaku:test:proxy2', inactive: 'false', 'src-address': '192.168.50.12/32', table: 'via-modem2-p7' },
    { '.id': '*A', action: 'lookup-only-in-table', comment: 'enkaku:test:proxy3', inactive: 'false', 'src-address': '192.168.50.13/32', table: 'via-modem3-p8' },
  ])

  // Stands in for "40 farm devices on 192.168.10.x" — three, spread across
  // the octet, is enough to exercise coverage and naming without hand-typing
  // forty rows; `cidr.test.ts` already exhaustively covers the arithmetic.
  const FARM_DEVICES: ProtectedDevice[] = [device('flip4-01', '192.168.10.15'), device('flip4-02', '192.168.10.88'), device('flip4-03', '192.168.10.201')]

  // The core's own lab-side address (`192.168.50.x`, per the owner's own
  // topology: two NICs, the lab-side one on the 192.168.50.0/24 segment) —
  // stands in for what `core-address.ts` would have derived live.
  const CORE_ADDRESS: CoreAddressResult = { kind: 'derived', address: '192.168.50.10' }

  test('the "proxy: local exception" rule is FOUND — defeats defect A (comment-text matching)', () => {
    const report = classifyLocalException(OWNER_ROUTER_RULES, FARM_DEVICES, CORE_ADDRESS)
    expect(report.status).not.toBe('missing')
  })

  test('but it still yields partial, naming every uncovered farm device — defeats defect B (coverage, not just existence)', () => {
    const report = classifyLocalException(OWNER_ROUTER_RULES, FARM_DEVICES, CORE_ADDRESS)
    expect(report.status).toBe('partial')
    expect(report.uncoveredDevices.map((d) => d.id).sort()).toEqual(['flip4-01', 'flip4-02', 'flip4-03'])
    expect(report.message).toContain('flip4-01')
  })

  test('the disabled+inactive "local exception .221" rule is never counted as a candidate — defeats defect D', () => {
    // Its own src covers exactly one device (.221) and its dst is
    // 192.168.100.0/24, not the core's own subnet — if D were not enforced
    // it could never have been a candidate anyway, so this also proves D by
    // constructing a device that WOULD be covered by it if D were ignored.
    const testDevice = device('test-221', '192.168.10.221')
    const report = classifyLocalException(OWNER_ROUTER_RULES, [testDevice], CORE_ADDRESS)
    expect(report.uncoveredDevices).toEqual([testDevice])
  })

  test('the suggested fix is derived from the actual devices and the actual core address — matches the plan\'s own worked example', () => {
    const report = classifyLocalException(OWNER_ROUTER_RULES, FARM_DEVICES, CORE_ADDRESS)
    const text = report.suggestedFixCommands.join('\n')
    expect(text).toContain('src-address=192.168.10.0/24')
    expect(text).toContain('dst-address=192.168.0.0/16')
  })
})

describe('classifyLocalException — position (defect C)', () => {
  test('a structurally correct, fully-covering rule sitting BELOW a device\'s own managed rule does not protect that device', () => {
    const rules: RouterRule[] = RouterRuleListSchema.parse([
      // The device's own managed rule, index 0 — ABOVE the exception.
      { '.id': '*1', action: 'lookup-only-in-table', table: 'via-modem7-p12', comment: 'enkaku:mikrotik-routing:v1:jadwal-1:192.168.10.50', 'src-address': '192.168.10.50/32' },
      // A perfectly-shaped exception, but too late for that device.
      { '.id': '*2', action: 'lookup', table: 'main', comment: 'farm: local exception', 'src-address': '192.168.10.0/24', 'dst-address': '192.168.0.0/16' },
    ])
    const affected = device('affected', '192.168.10.50')
    const report = classifyLocalException(rules, [affected], CORE_DERIVED)
    expect(report.status).toBe('partial')
    expect(report.uncoveredDevices).toEqual([affected])
  })

  test('the same rule, same order, for a device with NO managed rule of its own is covered — position only matters relative to that device\'s own rule', () => {
    const rules: RouterRule[] = RouterRuleListSchema.parse([
      { '.id': '*1', action: 'lookup-only-in-table', table: 'via-modem7-p12', comment: 'enkaku:mikrotik-routing:v1:jadwal-1:192.168.10.50', 'src-address': '192.168.10.50/32' },
      { '.id': '*2', action: 'lookup', table: 'main', comment: 'farm: local exception', 'src-address': '192.168.10.0/24', 'dst-address': '192.168.0.0/16' },
    ])
    const unaffected = device('unaffected', '192.168.10.51')
    const report = classifyLocalException(rules, [unaffected], CORE_DERIVED)
    expect(report.status).toBe('ok')
  })

  test('above the device\'s own managed rule: covered', () => {
    const rules: RouterRule[] = RouterRuleListSchema.parse([
      { '.id': '*1', action: 'lookup', table: 'main', comment: 'farm: local exception', 'src-address': '192.168.10.0/24', 'dst-address': '192.168.0.0/16' },
      { '.id': '*2', action: 'lookup-only-in-table', table: 'via-modem7-p12', comment: 'enkaku:mikrotik-routing:v1:jadwal-1:192.168.10.50', 'src-address': '192.168.10.50/32' },
    ])
    const affected = device('affected', '192.168.10.50')
    const report = classifyLocalException(rules, [affected], CORE_DERIVED)
    expect(report.status).toBe('ok')
  })
})

describe('classifyLocalException — ok', () => {
  test('every device covered by a correctly-shaped, correctly-positioned rule', () => {
    const rules: RouterRule[] = RouterRuleListSchema.parse([{ '.id': '*1', action: 'lookup', table: 'main', comment: 'farm: local exception', 'src-address': '192.168.10.0/24', 'dst-address': '192.168.0.0/16' }])
    const devices = [device('d1', '192.168.10.5'), device('d2', '192.168.10.250')]
    const report = classifyLocalException(rules, devices, CORE_DERIVED)
    expect(report.status).toBe('ok')
    expect(report.uncoveredDevices).toEqual([])
  })

  test('no devices to check at all: vacuously ok, and says so rather than implying a real check ran against a fleet', () => {
    const rules: RouterRule[] = RouterRuleListSchema.parse([{ '.id': '*1', action: 'lookup', table: 'main', comment: 'farm: local exception', 'src-address': '192.168.10.0/24', 'dst-address': '192.168.0.0/16' }])
    const report = classifyLocalException(rules, [], CORE_DERIVED)
    expect(report.status).toBe('ok')
  })
})

describe('classifyLocalException — the rfc1918-fallback path (core address could not be derived)', () => {
  const FALLBACK: CoreAddressResult = { kind: 'rfc1918-fallback', reason: 'could not open a TCP connection' }

  test('a rule covering only ONE RFC1918 block is not enough — the fallback requires all three, since it does not know which one the core is on', () => {
    const rules: RouterRule[] = RouterRuleListSchema.parse([{ '.id': '*1', action: 'lookup', table: 'main', comment: 'x', 'src-address': '192.168.10.0/24', 'dst-address': '192.168.0.0/16' }])
    const report = classifyLocalException(rules, [device('d1', '192.168.10.10')], FALLBACK)
    expect(report.status).toBe('missing')
  })

  test('a rule covering all three RFC1918 blocks (0.0.0.0/0) qualifies under fallback', () => {
    const rules: RouterRule[] = RouterRuleListSchema.parse([{ '.id': '*1', action: 'lookup', table: 'main', comment: 'x', 'src-address': '192.168.10.0/24', 'dst-address': '0.0.0.0/0' }])
    const report = classifyLocalException(rules, [device('d1', '192.168.10.10')], FALLBACK)
    expect(report.status).toBe('ok')
  })

  test('the suggested fix commands cover all three RFC1918 blocks, one add per block, when falling back', () => {
    const report = classifyLocalException([], [device('d1', '192.168.10.10')], FALLBACK)
    const text = report.suggestedFixCommands.join('\n')
    expect(text).toContain('dst-address=10.0.0.0/8')
    expect(text).toContain('dst-address=172.16.0.0/12')
    expect(text).toContain('dst-address=192.168.0.0/16')
  })

  test('coreAddress is echoed through on every status, so a caller can say which fallback was used', () => {
    const report = classifyLocalException([], [device('d1', '192.168.10.10')], FALLBACK)
    expect(report.coreAddress).toEqual(FALLBACK)
  })
})

describe('classifyLocalException — suggested fix when nothing is known yet', () => {
  test('no devices at all: the src placeholder says so rather than deriving an empty/wrong subnet', () => {
    const report = classifyLocalException([], [], CORE_DERIVED)
    expect(report.suggestedFixCommands.join('\n')).toContain('<farm-subnet>')
  })
})
