import { describe, expect, test } from 'bun:test'
import { DhcpLeaseListSchema, IpRouteListSchema, RouterRuleListSchema, RoutingTableListSchema } from './schemas'

/**
 * Regression tests for the parse failure that took the Paths tab down on the
 * owner's real lab router (RouterOS 7.24, 46 routing tables, 2026-08-21).
 *
 * The original schemas declared `fib` (and `host-name`) as fields nobody
 * reads, and any unrecognised boolean spelling threw. The router answered
 * `/routing/table` with a `fib` spelling the preprocessor did not know, so
 * every row failed `invalid_type: expected boolean, received string` and the
 * screen rendered nothing but errors.
 *
 * These tests pin the two rules that came out of that (see `schemas.ts`'s
 * header): a field nobody reads cannot reject a row, and an unrecognised
 * boolean degrades to a documented safe value rather than throwing.
 */

describe('RoutingTableListSchema — the /routing/table failure measured on real hardware', () => {
  test('a row whose `fib` is an unrecognised string still parses — the exact shape that broke the Paths tab', () => {
    // `fib` is deliberately something the boolean preprocessor cannot read.
    // The real router's exact spelling is unknown (zod's invalid_type error
    // does not echo the received value); what matters is that ANY unreadable
    // spelling is survivable, so this uses a value no branch recognises.
    const parsed = RoutingTableListSchema.parse([{ '.id': '*1', name: 'via-modem7-p12', fib: 'something-unreadable' }])
    expect(parsed[0]?.name).toBe('via-modem7-p12')
  })

  test('46 rows all carrying the unreadable `fib` parse — the owner had 46 routing tables and lost all of them', () => {
    const rows = Array.from({ length: 46 }, (_, i) => ({ '.id': `*${i}`, name: `via-modem${i}`, fib: 'something-unreadable' }))
    expect(RoutingTableListSchema.parse(rows)).toHaveLength(46)
  })

  test('`fib` is not surfaced as a typed field, but passthrough still carries its raw value', () => {
    const parsed = RoutingTableListSchema.parse([{ '.id': '*1', name: 'main', fib: 'true' }])
    expect(parsed[0]).not.toHaveProperty('fib', true)
    expect((parsed[0] as Record<string, unknown>).fib).toBe('true')
  })

  test('a missing identifying field still fails loudly — decoration is lenient, identity is not', () => {
    expect(() => RoutingTableListSchema.parse([{ '.id': '*1' }])).toThrow()
    expect(() => RoutingTableListSchema.parse([{ name: 'via-modem1' }])).toThrow()
  })
})

describe('boolish — an unreadable spelling degrades toward caution, never throws', () => {
  test('both known spellings and native booleans still work', () => {
    const [a, b, c] = IpRouteListSchema.parse([
      { '.id': '*1', active: true, disabled: false },
      { '.id': '*2', active: 'true', disabled: 'false' },
      { '.id': '*3', active: 'yes', disabled: 'no' },
    ])
    for (const row of [a, b, c]) {
      expect(row?.active).toBe(true)
      expect(row?.disabled).toBe(false)
    }
  })

  test('an unreadable `active` reads as DOWN, never as a healthy path', () => {
    // §4.5: reporting a dead path as up is the outcome the health check
    // exists to prevent, so "cannot tell" must not become "up".
    const [route] = IpRouteListSchema.parse([{ '.id': '*1', active: 'huh' }])
    expect(route?.active).toBe(false)
  })

  test('an unreadable `disabled` reads as DISABLED, so a rule that may do nothing is never counted as protection', () => {
    // §3.2: the local-exception check must refuse rather than credit a rule
    // it cannot confirm is live.
    const [rule] = RouterRuleListSchema.parse([{ '.id': '*1', disabled: 'huh', inactive: 'huh' }])
    expect(rule?.disabled).toBe(true)
    expect(rule?.inactive).toBe(true)
  })

  test('an unreadable `dynamic` lease reads as DYNAMIC, so the stale-IP warning fires', () => {
    // §3.4: a moving IP silently steers the wrong device, so "cannot tell"
    // must raise the warning rather than suppress it.
    const [lease] = DhcpLeaseListSchema.parse([{ '.id': '*1', address: '192.168.10.221', dynamic: 'huh' }])
    expect(lease?.dynamic).toBe(true)
  })

  test('ABSENT and UNREADABLE are different answers — absent is the router saying "not set", not a gap', () => {
    // This is the distinction a first version of `boolish` collapsed, which
    // made every live rule read as disabled: RouterOS OMITS a false-valued
    // flag rather than sending `false`, so "no `disabled` key" is the normal
    // state of a working rule, while "a `disabled` value we cannot parse" is
    // genuinely unknown and takes the cautious direction.
    const [absent] = RouterRuleListSchema.parse([{ '.id': '*1' }])
    expect(absent?.disabled).toBe(false)
    expect(absent?.inactive).toBe(false)

    const [unreadable] = RouterRuleListSchema.parse([{ '.id': '*1', disabled: 'huh', inactive: 'huh' }])
    expect(unreadable?.disabled).toBe(true)
    expect(unreadable?.inactive).toBe(true)

    // `active` is the one field where both answers agree, and deliberately
    // so — neither absence nor an unreadable value is evidence a path is up.
    const [route] = IpRouteListSchema.parse([{ '.id': '*1' }])
    expect(route?.active).toBe(false)
    expect(IpRouteListSchema.parse([{ '.id': '*1', active: 'huh' }])[0]?.active).toBe(false)
  })
})

describe('the owner\'s real router output parses end to end', () => {
  test('all seven rules from the live lab router, verbatim', () => {
    // Captured from `curl -u api:... http://192.168.50.1/rest/routing/rule`
    // on 2026-08-21. The rule endpoint was the one shape already verified
    // against hardware, so this is a guard against regressing it.
    const parsed = RouterRuleListSchema.parse([
      { '.id': '*7', '.nextid': '*3', action: 'lookup', comment: 'proxy: local exception', 'dst-address': '192.168.0.0/16', inactive: 'false', 'src-address': '192.168.50.0/24', table: 'main' },
      { '.id': '*3', '.nextid': '*2', action: 'lookup', comment: 'local exception .221', disabled: 'true', 'dst-address': '192.168.100.0/24', inactive: 'true', 'src-address': '192.168.10.221/32', table: 'main' },
      { '.id': '*2', '.nextid': '*5', action: 'lookup-only-in-table', comment: 'test device .221 via modem5', disabled: 'true', inactive: 'true', 'src-address': '192.168.10.221/32', table: 'via-modem5-p10' },
      { '.id': '*5', '.nextid': '*8', action: 'lookup-only-in-table', comment: 'enkaku-proxy modem1 (test)', inactive: 'false', 'src-address': '192.168.100.230/32', table: 'via-modem1-p6' },
      { '.id': '*8', '.nextid': '*9', action: 'lookup-only-in-table', comment: 'enkaku:test:proxy1', inactive: 'false', 'src-address': '192.168.50.11/32', table: 'via-modem1-p6' },
      { '.id': '*9', '.nextid': '*A', action: 'lookup-only-in-table', comment: 'enkaku:test:proxy2', inactive: 'false', 'src-address': '192.168.50.12/32', table: 'via-modem2-p7' },
      { '.id': '*A', action: 'lookup-only-in-table', comment: 'enkaku:test:proxy3', inactive: 'false', 'src-address': '192.168.50.13/32', table: 'via-modem3-p8' },
    ])
    expect(parsed).toHaveLength(7)
    // The rule with no `disabled` key at all is live, not defaulted to disabled:
    // absence of the key is RouterOS's own way of saying "not disabled", which
    // is different from a value we could not read.
    expect(parsed[0]?.disabled).toBe(false)
    expect(parsed[1]?.disabled).toBe(true)
    // `.nextid` survives passthrough — rule ORDER is what §3.2's position
    // check needs, and it must not be parsed away.
    expect((parsed[0] as Record<string, unknown>)['.nextid']).toBe('*3')
  })
})
