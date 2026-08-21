import { describe, expect, test } from 'bun:test'
import { resolveTarget } from './resolve'
import { RouterRuleListSchema, type RouterRule } from './schemas'

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

describe('resolveTarget — CIDR-form normalisation (correctness bug found by review right after step 122.6 landed)', () => {
  // 122.6 wrote src-address as a bare address specifically so this
  // comparison would line up as an exact string match. The owner's real
  // router echoes src-address back in CIDR form regardless of what was
  // written, so the exact-string version of this function never found its
  // own rule on the second apply and created a duplicate instead of
  // updating it. These pin the fix: matching by parsed address range makes
  // every spelling of the same host agree.

  test('the rule says /32, the endpoint is bare — still a match', () => {
    const match = rule({ '.id': '*3', comment: MANAGED, 'src-address': '192.168.10.215/32', table: 'via-modem7-p12' })

    expect(resolveTarget([match], '192.168.10.215')).toEqual({ action: 'update', rule: match })
  })

  test('and vice versa — the rule is bare, matched against a /32-spelled endpoint', () => {
    const match = rule({ '.id': '*3', comment: MANAGED, 'src-address': '192.168.10.215', table: 'via-modem7-p12' })

    expect(resolveTarget([match], '192.168.10.215/32')).toEqual({ action: 'update', rule: match })
  })

  test('both spelled the same way — bare/bare and /32//32 — still match', () => {
    const bare = rule({ '.id': '*1', comment: MANAGED, 'src-address': '192.168.10.215' })
    expect(resolveTarget([bare], '192.168.10.215')).toEqual({ action: 'update', rule: bare })

    const cidr = rule({ '.id': '*2', comment: MANAGED, 'src-address': '192.168.10.215/32' })
    expect(resolveTarget([cidr], '192.168.10.215/32')).toEqual({ action: 'update', rule: cidr })
  })

  test('a malformed/unparseable src-address never matches, and never throws', () => {
    const malformed = rule({ '.id': '*1', comment: MANAGED, 'src-address': 'not-an-ip-or-cidr' })

    expect(() => resolveTarget([malformed], '192.168.10.215')).not.toThrow()
    expect(resolveTarget([malformed], '192.168.10.215')).toEqual({ action: 'create' })
  })

  test('a broader block (e.g. /24) covering the endpoint is NOT treated as the same rule — this is address-equality, not containment', () => {
    const block = rule({ '.id': '*1', comment: MANAGED, 'src-address': '192.168.10.0/24' })

    expect(resolveTarget([block], '192.168.10.215')).toEqual({ action: 'create' })
  })

  test('REGRESSION: resolving the same endpoint twice, with the router echoing the created rule back in CIDR form, must be create then update — never create twice', () => {
    const endpoint = '192.168.10.215'

    // First apply: no rule exists on the router yet.
    const first = resolveTarget([], endpoint)
    expect(first.action).toBe('create')

    // We create the rule (router-driver.ts writes an explicit /32, see its
    // own header) and the router's very next listRules() echoes it back —
    // exactly the CIDR-form shape the owner's real router returns for every
    // rule (192.168.10.221/32, 192.168.50.11/32, 192.168.100.230/32,
    // 192.168.50.0/24, from their own curl).
    const echoed: RouterRule[] = RouterRuleListSchema.parse([
      { '.id': '*10', action: 'lookup-only-in-table', table: 'via-modem7-p12', comment: 'enkaku:mikrotik-routing:v1:default:192.168.10.215', 'src-address': '192.168.10.215/32' },
    ])

    // Second apply of the SAME assignment: must resolve to update, not a
    // second create — that duplication is exactly the bug this fix exists
    // to prevent.
    const second = resolveTarget(echoed, endpoint)
    expect(second.action).toBe('update')
    if (second.action === 'update') {
      expect(second.rule['.id']).toBe('*10')
    }
  })
})
