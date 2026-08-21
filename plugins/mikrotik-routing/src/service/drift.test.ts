import { describe, expect, test } from 'bun:test'
import { classifyDrift, type DesiredAssignment } from './drift'
import type { RouterRule } from './schemas'

/** A minimal, schema-shaped `RouterRule` fixture — every field the parsed type requires, nothing more unless overridden. */
function rule(overrides: Partial<RouterRule> & { '.id': string }): RouterRule {
  return {
    comment: '',
    disabled: false,
    inactive: false,
    ...overrides,
  }
}

const MARKER = (groupId: string, endpointKey: string) => `enkaku:mikrotik-routing:v1:${groupId}:${endpointKey}`

const desired = (overrides: Partial<DesiredAssignment>): DesiredAssignment => ({
  groupId: 'jadwal-1',
  endpointKey: '192.168.10.215',
  deviceId: 'device-1',
  pathId: 'via-modem7-p12',
  ...overrides,
})

describe('classifyDrift — the matching case reports nothing', () => {
  test('a managed rule that matches its desired assignment exactly produces no drift', () => {
    const d = desired({})
    const rules = [rule({ '.id': '*1', comment: MARKER(d.groupId, d.endpointKey), 'src-address': d.endpointKey, table: d.pathId })]

    const result = classifyDrift({
      desired: [d],
      rules,
      pathIds: new Set([d.pathId]),
      activeDeviceIds: new Set([d.deviceId]),
    })

    expect(result).toEqual([])
  })

  test('foreign rules are ignored entirely — never reported, never counted toward duplicates', () => {
    const d = desired({})
    const rules = [
      rule({ '.id': '*1', comment: MARKER(d.groupId, d.endpointKey), 'src-address': d.endpointKey, table: d.pathId }),
      rule({ '.id': '*2', comment: 'farm: local exception' }),
      rule({ '.id': '*3', comment: 'operator note, not ours' }),
    ]

    const result = classifyDrift({
      desired: [d],
      rules,
      pathIds: new Set([d.pathId]),
      activeDeviceIds: new Set([d.deviceId]),
    })

    expect(result).toEqual([])
  })
})

describe('classifyDrift — missing-rule', () => {
  test('a desired assignment with no matching rule, active device, existing path', () => {
    const d = desired({})
    const result = classifyDrift({
      desired: [d],
      rules: [],
      pathIds: new Set([d.pathId]),
      activeDeviceIds: new Set([d.deviceId]),
    })

    expect(result).toEqual([{ kind: 'missing-rule', desired: d }])
  })
})

describe('classifyDrift — unexpected-managed-rule (orphan)', () => {
  test('a well-formed managed rule with no matching KV record', () => {
    const orphan = rule({ '.id': '*9', comment: MARKER('old-group', '192.168.10.250'), 'src-address': '192.168.10.250', table: 'via-modem2' })

    const result = classifyDrift({
      desired: [],
      rules: [orphan],
      pathIds: new Set(['via-modem2']),
      activeDeviceIds: new Set(),
    })

    expect(result).toEqual([{ kind: 'unexpected-managed-rule', rule: orphan, groupId: 'old-group', endpointKey: '192.168.10.250' }])
  })

  test('a managed-prefixed rule whose marker does not parse (malformed) is still reported as an orphan, with null identity', () => {
    const badRule = rule({ '.id': '*8', comment: 'enkaku:mikrotik-routing:v1:only-one-segment' })

    const result = classifyDrift({
      desired: [],
      rules: [badRule],
      pathIds: new Set(),
      activeDeviceIds: new Set(),
    })

    expect(result).toEqual([{ kind: 'unexpected-managed-rule', rule: badRule, groupId: null, endpointKey: null }])
  })

  test('two distinct malformed managed rules each get their own orphan entry, never folded together', () => {
    const bad1 = rule({ '.id': '*8', comment: 'enkaku:mikrotik-routing:v1:only-one-segment' })
    const bad2 = rule({ '.id': '*9', comment: 'enkaku:mikrotik-routing:v1:another-truncated-one' })

    const result = classifyDrift({
      desired: [],
      rules: [bad1, bad2],
      pathIds: new Set(),
      activeDeviceIds: new Set(),
    })

    expect(result).toHaveLength(2)
    expect(result).toContainEqual({ kind: 'unexpected-managed-rule', rule: bad1, groupId: null, endpointKey: null })
    expect(result).toContainEqual({ kind: 'unexpected-managed-rule', rule: bad2, groupId: null, endpointKey: null })
  })

  test('a version-mismatched marker is also reported as an orphan, never adopted or removed automatically', () => {
    const futureRule = rule({ '.id': '*7', comment: 'enkaku:mikrotik-routing:v2:jadwal-1:192.168.10.215', 'src-address': '192.168.10.215' })
    const d = desired({})

    const result = classifyDrift({
      desired: [d],
      rules: [futureRule],
      pathIds: new Set([d.pathId]),
      activeDeviceIds: new Set([d.deviceId]),
    })

    // The desired assignment has no v1 rule at all (the only rule present is
    // unreadable v2), so BOTH a missing-rule and an orphan are reported —
    // this module never assumes an unreadable rule satisfies a desired entry.
    expect(result).toContainEqual({ kind: 'missing-rule', desired: d })
    expect(result).toContainEqual({ kind: 'unexpected-managed-rule', rule: futureRule, groupId: null, endpointKey: null })
    expect(result).toHaveLength(2)
  })
})

describe('classifyDrift — wrong-path', () => {
  test('a matching rule whose table differs from the desired path', () => {
    const d = desired({})
    const wrongTableRule = rule({ '.id': '*1', comment: MARKER(d.groupId, d.endpointKey), 'src-address': d.endpointKey, table: 'via-modem2' })

    const result = classifyDrift({
      desired: [d],
      rules: [wrongTableRule],
      pathIds: new Set([d.pathId, 'via-modem2']),
      activeDeviceIds: new Set([d.deviceId]),
    })

    expect(result).toEqual([{ kind: 'wrong-path', desired: d, rule: wrongTableRule, actualTable: 'via-modem2' }])
  })
})

describe('classifyDrift — duplicate', () => {
  test('two managed rules sharing one endpoint are flagged, and neither is separately classified', () => {
    const d = desired({})
    const rule1 = rule({ '.id': '*1', comment: MARKER(d.groupId, d.endpointKey), 'src-address': d.endpointKey, table: d.pathId })
    const rule2 = rule({ '.id': '*2', comment: MARKER(d.groupId, d.endpointKey), 'src-address': d.endpointKey, table: d.pathId })

    const result = classifyDrift({
      desired: [d],
      rules: [rule1, rule2],
      pathIds: new Set([d.pathId]),
      activeDeviceIds: new Set([d.deviceId]),
    })

    expect(result).toEqual([{ kind: 'duplicate', endpointKey: d.endpointKey, rules: [rule1, rule2] }])
  })

  test('a duplicate is flagged even when the endpoint is not in the desired set at all', () => {
    const rule1 = rule({ '.id': '*1', comment: MARKER('g', '10.0.0.5'), 'src-address': '10.0.0.5', table: 'via-modem1' })
    const rule2 = rule({ '.id': '*2', comment: MARKER('g', '10.0.0.5'), 'src-address': '10.0.0.5', table: 'via-modem1' })

    const result = classifyDrift({
      desired: [],
      rules: [rule1, rule2],
      pathIds: new Set(['via-modem1']),
      activeDeviceIds: new Set(),
    })

    expect(result).toEqual([{ kind: 'duplicate', endpointKey: '10.0.0.5', rules: [rule1, rule2] }])
  })

  test('three managed rules for one endpoint are still one duplicate entry naming all three', () => {
    const d = desired({})
    const rules = [
      rule({ '.id': '*1', comment: MARKER(d.groupId, d.endpointKey), 'src-address': d.endpointKey, table: d.pathId }),
      rule({ '.id': '*2', comment: MARKER(d.groupId, d.endpointKey), 'src-address': d.endpointKey, table: d.pathId }),
      rule({ '.id': '*3', comment: MARKER(d.groupId, d.endpointKey), 'src-address': d.endpointKey, table: 'via-modem-other' }),
    ]

    const result = classifyDrift({
      desired: [d],
      rules,
      pathIds: new Set([d.pathId, 'via-modem-other']),
      activeDeviceIds: new Set([d.deviceId]),
    })

    expect(result).toEqual([{ kind: 'duplicate', endpointKey: d.endpointKey, rules }])
  })
})

describe('classifyDrift — path-missing', () => {
  test('a matching rule whose desired path no longer exists on the router', () => {
    const d = desired({})
    const matchingRule = rule({ '.id': '*1', comment: MARKER(d.groupId, d.endpointKey), 'src-address': d.endpointKey, table: d.pathId })

    const result = classifyDrift({
      desired: [d],
      rules: [matchingRule],
      pathIds: new Set(), // d.pathId no longer exists
      activeDeviceIds: new Set([d.deviceId]),
    })

    expect(result).toEqual([{ kind: 'path-missing', desired: d }])
  })

  test('no rule at all, and the desired path itself is gone — path-missing, not missing-rule', () => {
    const d = desired({})

    const result = classifyDrift({
      desired: [d],
      rules: [],
      pathIds: new Set(),
      activeDeviceIds: new Set([d.deviceId]),
    })

    expect(result).toEqual([{ kind: 'path-missing', desired: d }])
  })
})

describe('classifyDrift — stale-owner', () => {
  test('a matching rule for a device that is blocked or gone from the fleet', () => {
    const d = desired({})
    const matchingRule = rule({ '.id': '*1', comment: MARKER(d.groupId, d.endpointKey), 'src-address': d.endpointKey, table: d.pathId })

    const result = classifyDrift({
      desired: [d],
      rules: [matchingRule],
      pathIds: new Set([d.pathId]),
      activeDeviceIds: new Set(), // device-1 is not active
    })

    expect(result).toEqual([{ kind: 'stale-owner', desired: d, rule: matchingRule }])
  })

  test('no rule at all for a blocked/gone device is NOT drift — nothing is expected there', () => {
    const d = desired({})

    const result = classifyDrift({
      desired: [d],
      rules: [],
      pathIds: new Set([d.pathId]),
      activeDeviceIds: new Set(), // device-1 is not active
    })

    expect(result).toEqual([])
  })

  test('stale-owner takes priority over wrong-path when both would otherwise apply', () => {
    const d = desired({})
    const wrongTableRule = rule({ '.id': '*1', comment: MARKER(d.groupId, d.endpointKey), 'src-address': d.endpointKey, table: 'via-modem2' })

    const result = classifyDrift({
      desired: [d],
      rules: [wrongTableRule],
      pathIds: new Set([d.pathId, 'via-modem2']),
      activeDeviceIds: new Set(), // device-1 is not active
    })

    expect(result).toEqual([{ kind: 'stale-owner', desired: d, rule: wrongTableRule }])
  })
})

describe('classifyDrift — a realistic mixed fleet reports every class at once', () => {
  test('one router state producing one of each drift kind', () => {
    const okDesired = desired({ groupId: 'jadwal-1', endpointKey: '192.168.10.215', deviceId: 'device-ok', pathId: 'via-modem1' })
    const missingDesired = desired({ groupId: 'jadwal-1', endpointKey: '192.168.10.216', deviceId: 'device-missing', pathId: 'via-modem1' })
    const wrongPathDesired = desired({ groupId: 'jadwal-1', endpointKey: '192.168.10.217', deviceId: 'device-wrong-path', pathId: 'via-modem1' })
    const pathMissingDesired = desired({ groupId: 'jadwal-1', endpointKey: '192.168.10.218', deviceId: 'device-path-missing', pathId: 'via-modem-gone' })
    const staleOwnerDesired = desired({ groupId: 'jadwal-1', endpointKey: '192.168.10.219', deviceId: 'device-blocked', pathId: 'via-modem1' })

    const okRule = rule({ '.id': '*1', comment: MARKER(okDesired.groupId, okDesired.endpointKey), 'src-address': okDesired.endpointKey, table: 'via-modem1' })
    const wrongPathRule = rule({
      '.id': '*2',
      comment: MARKER(wrongPathDesired.groupId, wrongPathDesired.endpointKey),
      'src-address': wrongPathDesired.endpointKey,
      table: 'via-modem2',
    })
    const pathMissingRule = rule({
      '.id': '*3',
      comment: MARKER(pathMissingDesired.groupId, pathMissingDesired.endpointKey),
      'src-address': pathMissingDesired.endpointKey,
      table: 'via-modem-gone',
    })
    const staleOwnerRule = rule({
      '.id': '*4',
      comment: MARKER(staleOwnerDesired.groupId, staleOwnerDesired.endpointKey),
      'src-address': staleOwnerDesired.endpointKey,
      table: 'via-modem1',
    })
    const orphanRule = rule({ '.id': '*5', comment: MARKER('other-group', '192.168.10.230'), 'src-address': '192.168.10.230', table: 'via-modem1' })
    const dup1 = rule({ '.id': '*6', comment: MARKER('dup-group', '192.168.10.240'), 'src-address': '192.168.10.240', table: 'via-modem1' })
    const dup2 = rule({ '.id': '*7', comment: MARKER('dup-group', '192.168.10.240'), 'src-address': '192.168.10.240', table: 'via-modem1' })
    const foreignRule = rule({ '.id': '*8', comment: 'farm: local exception' })

    const result = classifyDrift({
      desired: [okDesired, missingDesired, wrongPathDesired, pathMissingDesired, staleOwnerDesired],
      rules: [okRule, wrongPathRule, pathMissingRule, staleOwnerRule, orphanRule, dup1, dup2, foreignRule],
      pathIds: new Set(['via-modem1', 'via-modem2']),
      activeDeviceIds: new Set(['device-ok', 'device-missing', 'device-wrong-path', 'device-path-missing']),
    })

    const kinds = result.map((r) => r.kind).sort()
    expect(kinds).toEqual(['duplicate', 'missing-rule', 'path-missing', 'stale-owner', 'unexpected-managed-rule', 'wrong-path'])
    expect(result).toHaveLength(6)
  })
})
