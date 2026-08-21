import { describe, expect, test } from 'bun:test'
import { resolveTarget } from './resolve'
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

const MANAGED = 'enkaku:mikrotik-routing:v1:jadwal-1:192.168.10.215'

describe('resolveTarget — §4.3 resolve-before-write', () => {
  test('0 matches → create', () => {
    const rules = [rule({ '.id': '*1', comment: 'farm: local exception' }), rule({ '.id': '*2', comment: MANAGED, 'src-address': '192.168.10.216' })]

    expect(resolveTarget(rules, '192.168.10.215')).toEqual({ action: 'create' })
  })

  test('an empty rule list → create', () => {
    expect(resolveTarget([], '192.168.10.215')).toEqual({ action: 'create' })
  })

  test('1 match → update, carrying the matched rule', () => {
    const match = rule({ '.id': '*3', comment: MANAGED, 'src-address': '192.168.10.215', table: 'via-modem7-p12' })
    const rules = [rule({ '.id': '*1', comment: 'farm: local exception' }), match]

    expect(resolveTarget(rules, '192.168.10.215')).toEqual({ action: 'update', rule: match })
  })

  test('2+ matches → refuse-duplicate, naming every match', () => {
    const match1 = rule({ '.id': '*3', comment: MANAGED, 'src-address': '192.168.10.215', table: 'via-modem7-p12' })
    const match2 = rule({ '.id': '*4', comment: MANAGED, 'src-address': '192.168.10.215', table: 'via-modem2' })
    const rules = [match1, match2]

    expect(resolveTarget(rules, '192.168.10.215')).toEqual({ action: 'refuse-duplicate', rules: [match1, match2] })
  })

  test('a foreign rule at the same src-address is never counted as a match', () => {
    const foreign = rule({ '.id': '*1', comment: 'operator: static route for the printer', 'src-address': '192.168.10.215' })

    expect(resolveTarget([foreign], '192.168.10.215')).toEqual({ action: 'create' })
  })

  test('a managed rule for a different endpoint is never counted as a match', () => {
    const other = rule({ '.id': '*1', comment: MANAGED, 'src-address': '192.168.10.999' })

    expect(resolveTarget([other], '192.168.10.215')).toEqual({ action: 'create' })
  })

  test('matches on the coarse write-scope prefix, not a fully well-formed marker — a malformed managed comment still counts', () => {
    const malformed = rule({ '.id': '*1', comment: 'enkaku:mikrotik-routing:truncated', 'src-address': '192.168.10.215' })

    expect(resolveTarget([malformed], '192.168.10.215')).toEqual({ action: 'update', rule: malformed })
  })

  test('a rule with no src-address at all is never a match', () => {
    const noAddress = rule({ '.id': '*1', comment: MANAGED })

    expect(resolveTarget([noAddress], '192.168.10.215')).toEqual({ action: 'create' })
  })
})
