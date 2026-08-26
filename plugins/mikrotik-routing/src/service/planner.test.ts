import { describe, expect, test } from 'bun:test'
import { buildPlan, type PlanDesiredEntry, type PlanRow } from './planner'
import type { PathHealth } from './router-driver'
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

const desired = (overrides: Partial<PlanDesiredEntry>): PlanDesiredEntry => ({
  groupId: 'jadwal-2',
  groupName: 'Jadwal-2',
  endpointKey: '192.168.10.215',
  deviceId: 'device-1',
  pathId: 'via-modem7-p12',
  ...overrides,
})

const up = (pathId: string): PathHealth => ({ pathId, up: true, checkedAt: 0 })
const down = (pathId: string): PathHealth => ({ pathId, up: false, checkedAt: 0 })

describe('buildPlan — create', () => {
  test('a desired entry with no existing rule at a healthy, existing path', () => {
    const d = desired({})
    const result = buildPlan({
      desired: [d],
      rules: [],
      pathIds: new Set([d.pathId]),
      health: [up(d.pathId)],
    })

    expect(result).toEqual([{ kind: 'create', endpointKey: d.endpointKey, pathId: d.pathId, groupId: d.groupId, groupName: d.groupName }])
  })
})

describe('buildPlan — update', () => {
  test('a desired entry whose existing rule points at a different table', () => {
    const d = desired({})
    const existing = rule({ '.id': '*1', comment: MARKER(d.groupId, d.endpointKey), 'src-address': d.endpointKey, table: 'via-modem2' })

    const result = buildPlan({
      desired: [d],
      rules: [existing],
      pathIds: new Set([d.pathId, 'via-modem2']),
      health: [up(d.pathId), up('via-modem2')],
    })

    expect(result).toEqual([
      { kind: 'update', endpointKey: d.endpointKey, fromPathId: 'via-modem2', toPathId: d.pathId, groupId: d.groupId, groupName: d.groupName, rule: existing },
    ])
  })

  test('a matching rule already at the desired table produces no row', () => {
    const d = desired({})
    const existing = rule({ '.id': '*1', comment: MARKER(d.groupId, d.endpointKey), 'src-address': d.endpointKey, table: d.pathId })

    const result = buildPlan({
      desired: [d],
      rules: [existing],
      pathIds: new Set([d.pathId]),
      health: [up(d.pathId)],
    })

    expect(result).toEqual([])
  })

  test('a matching rule at the desired table but DISABLED still produces an update row (step 122.8, header point 5)', () => {
    const d = desired({})
    const existing = rule({ '.id': '*1', comment: MARKER(d.groupId, d.endpointKey), 'src-address': d.endpointKey, table: d.pathId, disabled: true })

    const result = buildPlan({
      desired: [d],
      rules: [existing],
      pathIds: new Set([d.pathId]),
      health: [up(d.pathId)],
    })

    expect(result).toEqual([{ kind: 'update', endpointKey: d.endpointKey, fromPathId: d.pathId, toPathId: d.pathId, groupId: d.groupId, groupName: d.groupName, rule: existing }])
  })
})

describe('buildPlan — delete', () => {
  test('a managed rule whose endpoint is no longer in the desired set', () => {
    const stale = rule({ '.id': '*1', comment: MARKER('jadwal-1', '192.168.10.219'), 'src-address': '192.168.10.219', table: 'via-modem4' })

    const result = buildPlan({
      desired: [],
      rules: [stale],
      pathIds: new Set(['via-modem4']),
      health: [up('via-modem4')],
    })

    expect(result).toEqual([{ kind: 'delete', endpointKey: '192.168.10.219', pathId: 'via-modem4', groupId: 'jadwal-1', rule: stale }])
  })

  test('a malformed managed rule (marker does not parse) is still a delete, with groupId null', () => {
    const stale = rule({ '.id': '*1', comment: 'enkaku:mikrotik-routing:v1:only-one-segment', 'src-address': '192.168.10.219', table: 'via-modem4' })

    const result = buildPlan({
      desired: [],
      rules: [stale],
      pathIds: new Set(),
      health: [],
    })

    expect(result).toEqual([{ kind: 'delete', endpointKey: '192.168.10.219', pathId: 'via-modem4', groupId: null, rule: stale }])
  })
})

describe('buildPlan — a down path is applied, not skipped (plan 132 / M97)', () => {
  test('a down path still produces a create — the assignment is a hard constraint, not a preference', () => {
    const d = desired({ pathId: 'via-modem31', endpointKey: '192.168.10.222' })
    const result = buildPlan({
      desired: [d],
      rules: [],
      pathIds: new Set([d.pathId]),
      health: [down(d.pathId)],
    })

    expect(result).toEqual([{ kind: 'create', endpointKey: d.endpointKey, pathId: d.pathId, groupId: d.groupId, groupName: d.groupName, overDownPath: true }])
  })

  test('a down path with an existing rule at a different table still produces an update, flagged', () => {
    const d = desired({ pathId: 'via-modem31', endpointKey: '192.168.10.222' })
    const existing = rule({ '.id': '*1', comment: MARKER(d.groupId, d.endpointKey), 'src-address': d.endpointKey, table: 'via-modem-old' })

    const result = buildPlan({
      desired: [d],
      rules: [existing],
      pathIds: new Set([d.pathId, 'via-modem-old']),
      health: [down(d.pathId), up('via-modem-old')],
    })

    expect(result).toEqual([
      { kind: 'update', endpointKey: d.endpointKey, fromPathId: 'via-modem-old', toPathId: d.pathId, groupId: d.groupId, groupName: d.groupName, rule: existing, overDownPath: true },
    ])
  })

  test('a healthy path yields no flag at all — `overDownPath` is absent, not `false`', () => {
    const d = desired({})
    const result = buildPlan({
      desired: [d],
      rules: [],
      pathIds: new Set([d.pathId]),
      health: [up(d.pathId)],
    })

    expect(result).toEqual([{ kind: 'create', endpointKey: d.endpointKey, pathId: d.pathId, groupId: d.groupId, groupName: d.groupName }])
    expect(result[0]).not.toHaveProperty('overDownPath')
  })

  test('a pathId present but with no health entry at all is treated as down (fail-safe) and still applied, flagged', () => {
    const d = desired({})
    const result = buildPlan({
      desired: [d],
      rules: [],
      pathIds: new Set([d.pathId]),
      health: [], // no health entry for d.pathId
    })

    expect(result).toEqual([{ kind: 'create', endpointKey: d.endpointKey, pathId: d.pathId, groupId: d.groupId, groupName: d.groupName, overDownPath: true }])
  })

  test('no plan row anywhere carries reason "path-down" — the value cannot be produced any more', () => {
    // Exhaustive over every branch buildPlan can take (create/update flagged
    // overDownPath, path-missing skip, duplicate skip) — none of them ever
    // sets `reason: 'path-down'`, because SkipReason no longer has that
    // member at the type level (a re-addition would fail `bun run
    // typecheck`, which is the other half of this guard).
    const flaggedCreate = desired({ pathId: 'via-modem31', endpointKey: '192.168.10.222' })
    const missing = desired({ pathId: 'via-modem-deleted', endpointKey: '192.168.10.223' })
    const d1 = desired({ endpointKey: '192.168.10.224' })
    const dupRule1 = rule({ '.id': '*1', comment: MARKER(d1.groupId, d1.endpointKey), 'src-address': d1.endpointKey, table: 'via-modem2' })
    const dupRule2 = rule({ '.id': '*2', comment: MARKER(d1.groupId, d1.endpointKey), 'src-address': d1.endpointKey, table: 'via-modem3' })

    const result = buildPlan({
      desired: [flaggedCreate, missing, d1],
      rules: [dupRule1, dupRule2],
      pathIds: new Set([flaggedCreate.pathId, d1.pathId, 'via-modem2', 'via-modem3']),
      health: [down(flaggedCreate.pathId), up(d1.pathId), up('via-modem2'), up('via-modem3')],
    })

    for (const row of result) {
      if (row.kind === 'skip') expect(row.reason).not.toBe('path-down')
    }
    expect(result.some((r) => r.kind === 'skip' && r.reason === 'path-missing')).toBe(true)
    expect(result.some((r) => r.kind === 'skip' && r.reason === 'duplicate')).toBe(true)
    expect(result.some((r) => r.kind === 'create' && 'overDownPath' in r && r.overDownPath === true)).toBe(true)
  })
})

describe('buildPlan — skip', () => {
  test('path-missing is the only skip reason for a path that does not exist on the router at all', () => {
    const d = desired({ pathId: 'via-modem-deleted' })
    const result = buildPlan({
      desired: [d],
      rules: [],
      pathIds: new Set(), // via-modem-deleted does not exist
      health: [],
    })

    expect(result).toEqual([{ kind: 'skip', endpointKey: d.endpointKey, pathId: d.pathId, groupId: d.groupId, groupName: d.groupName, reason: 'path-missing' }])
  })

  test('path-missing outranks a healthy path too — a missing table cannot be written to regardless of health', () => {
    const d = desired({ pathId: 'via-modem-deleted' })
    const result = buildPlan({
      desired: [d],
      rules: [],
      pathIds: new Set(),
      health: [up('via-modem-deleted')],
    })

    expect(result).toEqual([{ kind: 'skip', endpointKey: d.endpointKey, pathId: d.pathId, groupId: d.groupId, groupName: d.groupName, reason: 'path-missing' }])
  })

  test('duplicate managed rules for one endpoint outrank both create and update — never guess which to keep', () => {
    const d = desired({})
    const rule1 = rule({ '.id': '*1', comment: MARKER(d.groupId, d.endpointKey), 'src-address': d.endpointKey, table: 'via-modem2' })
    const rule2 = rule({ '.id': '*2', comment: MARKER(d.groupId, d.endpointKey), 'src-address': d.endpointKey, table: 'via-modem3' })

    const result = buildPlan({
      desired: [d],
      rules: [rule1, rule2],
      pathIds: new Set([d.pathId, 'via-modem2', 'via-modem3']),
      health: [up(d.pathId), up('via-modem2'), up('via-modem3')],
    })

    expect(result).toEqual([{ kind: 'skip', endpointKey: d.endpointKey, pathId: d.pathId, groupId: d.groupId, groupName: d.groupName, reason: 'duplicate' }])
  })
})

describe('buildPlan — foreign', () => {
  test('a rule with no marker prefix passes through untouched', () => {
    const foreign = rule({ '.id': '*1', comment: 'farm: local exception', 'src-address': '192.168.100.230', table: 'via-modem1' })

    const result = buildPlan({
      desired: [],
      rules: [foreign],
      pathIds: new Set(['via-modem1']),
      health: [up('via-modem1')],
    })

    expect(result).toEqual([{ kind: 'foreign', endpointKey: '192.168.100.230', pathId: 'via-modem1', rule: foreign }])
  })

  test('a foreign rule whose src-address collides with a managed, desired endpoint stays foreign — never adopted, never deleted', () => {
    const d = desired({ endpointKey: '192.168.10.215' })
    const managed = rule({ '.id': '*1', comment: MARKER(d.groupId, d.endpointKey), 'src-address': d.endpointKey, table: d.pathId })
    const collidingForeign = rule({ '.id': '*2', comment: 'hand-added by an operator', 'src-address': d.endpointKey, table: 'via-modem-other' })

    const result = buildPlan({
      desired: [d],
      rules: [managed, collidingForeign],
      pathIds: new Set([d.pathId, 'via-modem-other']),
      health: [up(d.pathId), up('via-modem-other')],
    })

    // The managed rule already matches — no row for it. The colliding rule is foreign, full stop.
    expect(result).toEqual([{ kind: 'foreign', endpointKey: d.endpointKey, pathId: 'via-modem-other', rule: collidingForeign }])
  })
})

describe('buildPlan — boundary cases', () => {
  test('empty desired against a router with managed rules — everything becomes delete', () => {
    const rule1 = rule({ '.id': '*1', comment: MARKER('jadwal-1', '192.168.10.219'), 'src-address': '192.168.10.219', table: 'via-modem4' })
    const rule2 = rule({ '.id': '*2', comment: MARKER('jadwal-1', '192.168.10.220'), 'src-address': '192.168.10.220', table: 'via-modem5' })

    const result = buildPlan({
      desired: [],
      rules: [rule1, rule2],
      pathIds: new Set(['via-modem4', 'via-modem5']),
      health: [up('via-modem4'), up('via-modem5')],
    })

    expect(result.every((r) => r.kind === 'delete')).toBe(true)
    expect(result).toHaveLength(2)
  })

  test('empty router against a non-empty desired set — everything becomes create', () => {
    const d1 = desired({ endpointKey: '192.168.10.215', deviceId: 'device-1' })
    const d2 = desired({ endpointKey: '192.168.10.216', deviceId: 'device-2' })

    const result = buildPlan({
      desired: [d1, d2],
      rules: [],
      pathIds: new Set([d1.pathId]),
      health: [up(d1.pathId)],
    })

    expect(result.every((r) => r.kind === 'create')).toBe(true)
    expect(result).toHaveLength(2)
  })

  test('both empty produces an empty plan', () => {
    const result = buildPlan({ desired: [], rules: [], pathIds: new Set(), health: [] })
    expect(result).toEqual([])
  })
})

describe('buildPlan — determinism', () => {
  test('the same inputs always produce the same row order, sorted (kind, endpointKey, rule id)', () => {
    const createEntry = desired({ endpointKey: '192.168.10.230', deviceId: 'device-create' })
    const updateEntry = desired({ endpointKey: '192.168.10.210', deviceId: 'device-update', pathId: 'via-modem9' })
    const updateRule = rule({ '.id': '*1', comment: MARKER(updateEntry.groupId, updateEntry.endpointKey), 'src-address': updateEntry.endpointKey, table: 'via-modem2' })
    const staleRule = rule({ '.id': '*2', comment: MARKER('jadwal-1', '192.168.10.219'), 'src-address': '192.168.10.219', table: 'via-modem4' })
    const skipEntry = desired({ endpointKey: '192.168.10.222', deviceId: 'device-skip', pathId: 'via-modem31' })
    const foreignRule = rule({ '.id': '*3', comment: 'operator note', 'src-address': '192.168.100.230', table: 'via-modem1' })

    const input = {
      desired: [skipEntry, updateEntry, createEntry],
      rules: [foreignRule, staleRule, updateRule],
      pathIds: new Set([createEntry.pathId, updateEntry.pathId, 'via-modem2', 'via-modem4', 'via-modem1']),
      health: [up(createEntry.pathId), up(updateEntry.pathId), up('via-modem2'), up('via-modem4'), up('via-modem1'), down(skipEntry.pathId)],
    }

    const first = buildPlan(input)
    const second = buildPlan(input)
    expect(first).toEqual(second)

    const kinds = first.map((r) => r.kind)
    expect(kinds).toEqual(['create', 'update', 'delete', 'skip', 'foreign'])
  })

  test('two delete candidates sharing one endpointKey are ordered by rule id as the final tiebreaker', () => {
    const ruleA = rule({ '.id': '*2', comment: MARKER('jadwal-1', '10.0.0.5'), 'src-address': '10.0.0.5', table: 'via-modem1' })
    const ruleB = rule({ '.id': '*1', comment: MARKER('jadwal-1', '10.0.0.5'), 'src-address': '10.0.0.5', table: 'via-modem1' })

    const result = buildPlan({
      desired: [],
      rules: [ruleA, ruleB],
      pathIds: new Set(['via-modem1']),
      health: [up('via-modem1')],
    })

    expect(result).toHaveLength(2)
    const ids = result.map((r) => (r as Extract<PlanRow, { kind: 'delete' }>).rule['.id'])
    expect(ids).toEqual(['*1', '*2'])
  })
})

describe('buildPlan — REGRESSION: applying the same assignment twice against a router that echoes src-address in CIDR form (step 122.6 correction)', () => {
  // 122.6 wrote a bare src-address betting the router would echo it back
  // unchanged; the owner's real router echoes CIDR form regardless. Before
  // this fix, the SECOND buildPlan call below would produce a second
  // `create` for the same endpoint (resolveTarget never found its own rule)
  // AND would also flag that same rule as `delete` (the desired-set
  // membership check in the delete/foreign loop had the identical raw
  // string-equality bug) — i.e. one router rule showing up as both created
  // again and marked for deletion in the same plan.

  test('same device, same path: create, then nothing (already correct) — never a second create, never a spurious delete', () => {
    const d = desired({ endpointKey: '192.168.10.215', pathId: 'via-modem7-p12' })
    const pathIds = new Set([d.pathId])
    const health = [up(d.pathId)]

    const firstPlan = buildPlan({ desired: [d], rules: [], pathIds, health })
    expect(firstPlan).toEqual([{ kind: 'create', endpointKey: d.endpointKey, pathId: d.pathId, groupId: d.groupId, groupName: d.groupName }])

    // The router now holds the rule we just created, echoed back with
    // src-address in CIDR form — exactly the owner's real router's shape.
    const routerRuleAfterApply = rule({ '.id': '*10', comment: MARKER(d.groupId, d.endpointKey), 'src-address': `${d.endpointKey}/32`, table: d.pathId })

    const secondPlan = buildPlan({ desired: [d], rules: [routerRuleAfterApply], pathIds, health })
    expect(secondPlan).toEqual([])
  })

  test('same device, path changed on the second apply: create, then update — never create twice', () => {
    const first = desired({ endpointKey: '192.168.10.215', pathId: 'via-modem7-p12' })
    const pathIds = new Set(['via-modem7-p12', 'via-modem9'])
    const health = [up('via-modem7-p12'), up('via-modem9')]

    const firstPlan = buildPlan({ desired: [first], rules: [], pathIds, health })
    expect(firstPlan).toEqual([{ kind: 'create', endpointKey: first.endpointKey, pathId: first.pathId, groupId: first.groupId, groupName: first.groupName }])

    const routerRuleAfterApply = rule({ '.id': '*10', comment: MARKER(first.groupId, first.endpointKey), 'src-address': `${first.endpointKey}/32`, table: 'via-modem7-p12' })

    const second = desired({ endpointKey: '192.168.10.215', pathId: 'via-modem9' })
    const secondPlan = buildPlan({ desired: [second], rules: [routerRuleAfterApply], pathIds, health })

    expect(secondPlan).toEqual([
      { kind: 'update', endpointKey: second.endpointKey, fromPathId: 'via-modem7-p12', toPathId: 'via-modem9', groupId: second.groupId, groupName: second.groupName, rule: routerRuleAfterApply },
    ])
  })
})

/**
 * Plan 132 (M97) §4.2 — plan 131 §3.4's override collapses into the default.
 * There is nothing left to force: every desired entry is now applied
 * regardless of health, so `forceDownPaths` is gone from `BuildPlanInput`
 * entirely rather than kept as an inert parameter.
 */
describe('buildPlan — path-missing stays unforceable, by construction (there is no forcing left)', () => {
  test('a missing path is still a skip no matter how the desired entry is shaped — nothing can make it a write', () => {
    const d = desired({ pathId: 'via-modem-gone', endpointKey: '192.168.10.222' })
    const result = buildPlan({
      desired: [d],
      rules: [],
      pathIds: new Set(),
      health: [],
    })

    expect(result).toEqual([{ kind: 'skip', endpointKey: d.endpointKey, pathId: d.pathId, groupId: d.groupId, groupName: d.groupName, reason: 'path-missing' }])
  })
})
