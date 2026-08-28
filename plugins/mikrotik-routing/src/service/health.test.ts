import { describe, expect, test } from 'bun:test'
import { bareAddress, deriveFleetFaults, deriveHealth, downReason, summarisePing } from './health'
import type { DhcpClient, IpRoute } from './schemas'

const route = (overrides: Partial<IpRoute>): IpRoute =>
  ({ '.id': '*1', 'dst-address': '0.0.0.0/0', active: true, disabled: false, dynamic: false, ...overrides }) as IpRoute

const client = (iface: string, address: string): DhcpClient => ({ '.id': `*${iface}`, interface: iface, address, status: 'bound', disabled: false }) as DhcpClient

describe('deriveHealth — three facts, and `up` unchanged (plan 134 §4.2/§4.3)', () => {
  test('a healthy path: link ok, gateway ok, and egress UNKNOWN — nothing measured it', () => {
    // The whole point of plan 134. #20's modem answered every ping and had no
    // data plan; `egress: 'ok'` here would be that same false claim, restated
    // in a field that promises more.
    expect(deriveHealth(route({ active: true }))).toEqual({ up: true, link: 'ok', gateway: 'ok' })
  })

  test('gateway silent: link ok (the router could reach the port), gateway fail', () => {
    const h = deriveHealth(route({ active: false, 'immediate-gw': '192.168.126.1%wan-modem26-s2p8' }))
    expect(h).toEqual({ up: false, reason: 'gateway-unreachable', link: 'ok', gateway: 'fail' })
  })

  test('no address in the subnet: link FAIL, and gateway UNKNOWN — not fail', () => {
    // The plan 133 fault. Reporting `gateway: 'fail'` would blame a modem that
    // was never asked anything: the router had no address to ask FROM. That is
    // the same category of lie as #20's false Up, pointed the other way.
    const h = deriveHealth(route({ active: false, 'immediate-gw': '' }))
    expect(h).toEqual({ up: false, reason: 'no-route-to-gateway', link: 'fail', gateway: 'unknown' })
  })

  test('no default route at all: link fail, gateway unknown', () => {
    expect(deriveHealth(undefined)).toEqual({ up: false, reason: 'no-default-route', link: 'fail', gateway: 'unknown' })
  })

  test('`up` is byte-identical to the old one-boolean rule for every case (§8 R4)', () => {
    // The planner and plan 132's `overDownPath` read this field and nothing
    // else. If this drifts, the router gets written differently.
    for (const r of [route({ active: true }), route({ active: false }), undefined]) {
      expect(deriveHealth(r).up).toBe(r?.active ?? false)
    }
  })

  test('downReason is unchanged from plan 133 and still exported', () => {
    expect(downReason(undefined)).toBe('no-default-route')
    expect(downReason({ 'immediate-gw': '   ' })).toBe('no-route-to-gateway')
    expect(downReason({})).toBe('gateway-unreachable')
  })
})

describe('bareAddress', () => {
  test('strips the prefix RouterOS prints on a WAN address', () => {
    expect(bareAddress('192.168.8.100/24')).toBe('192.168.8.100')
  })

  test('an address with no prefix is returned as-is; absent and blank are null', () => {
    expect(bareAddress('10.0.0.1')).toBe('10.0.0.1')
    expect(bareAddress(undefined)).toBeNull()
    expect(bareAddress('  ')).toBeNull()
  })
})

describe('deriveFleetFaults — the plan 133 fault, named directly (§3.4)', () => {
  /** Verbatim from the owner's router during the plan 133 session. */
  const farm: DhcpClient[] = [
    client('wan-modem24-s2p6', '192.168.124.100/24'),
    client('wan-modem25-s2p7', '192.168.8.100/24'),
    client('wan-modem26-s2p8', '192.168.126.101/24'),
    client('wan-modem27-s2p9', '192.168.8.100/24'),
  ]
  const rows = [
    { pathId: 'via-modem24-s2p6', wanInterface: 'wan-modem24-s2p6' },
    { pathId: 'via-modem25-s2p7', wanInterface: 'wan-modem25-s2p7' },
    { pathId: 'via-modem26-s2p8', wanInterface: 'wan-modem26-s2p8' },
    { pathId: 'via-modem27-s2p9', wanInterface: 'wan-modem27-s2p9' },
  ]

  test('the two uplinks holding 192.168.8.100 name each other, and the healthy two are clean', () => {
    const faults = deriveFleetFaults(rows, farm)
    expect(faults.get('via-modem25-s2p7')?.duplicateAddressWith).toEqual(['via-modem27-s2p9'])
    expect(faults.get('via-modem27-s2p9')?.duplicateAddressWith).toEqual(['via-modem25-s2p7'])
    expect(faults.get('via-modem24-s2p6')?.duplicateAddressWith).toEqual([])
    expect(faults.get('via-modem26-s2p8')?.duplicateAddressWith).toEqual([])
  })

  test('the prefix is not part of the identity — the same address on different masks is still a duplicate', () => {
    const faults = deriveFleetFaults(rows.slice(0, 2), [client('wan-modem24-s2p6', '192.168.8.100/24'), client('wan-modem25-s2p7', '192.168.8.100/16')])
    expect(faults.get('via-modem24-s2p6')?.duplicateAddressWith).toEqual(['via-modem25-s2p7'])
  })

  test('paths whose interface could not be resolved are never grouped together', () => {
    // `immediate-gw=""` — the plan 133 fault itself — yields a null interface.
    // Grouping every unresolved path into one giant "duplicate" set is the
    // obvious way to write this and is worse than reporting nothing at all.
    const faults = deriveFleetFaults(
      [
        { pathId: 'a', wanInterface: null },
        { pathId: 'b', wanInterface: null },
      ],
      farm,
    )
    expect(faults.get('a')?.duplicateAddressWith).toEqual([])
    expect(faults.get('b')?.duplicateAddressWith).toEqual([])
  })

  test('an interface with no DHCP client row is not a duplicate of another such interface', () => {
    const faults = deriveFleetFaults(
      [
        { pathId: 'a', wanInterface: 'ether1' },
        { pathId: 'b', wanInterface: 'ether2' },
      ],
      farm,
    )
    expect(faults.get('a')?.duplicateAddressWith).toEqual([])
  })

  test('a shared public IP is flagged — plan 132 §0\'s ban risk, made visible', () => {
    const faults = deriveFleetFaults(
      [
        { pathId: 'a', wanInterface: 'wan-modem24-s2p6', publicIp: '203.0.113.9' },
        { pathId: 'b', wanInterface: 'wan-modem26-s2p8', publicIp: '203.0.113.9' },
        { pathId: 'c', wanInterface: 'wan-modem25-s2p7', publicIp: '203.0.113.10' },
      ],
      farm,
    )
    expect(faults.get('a')?.duplicatePublicIpWith).toEqual(['b'])
    expect(faults.get('c')?.duplicatePublicIpWith).toEqual([])
  })

  test('UNPROBED paths never become duplicates of each other — absent is not a value', () => {
    // Forty paths nobody has probed all share "no public IP". Reporting that
    // as forty duplicates would bury the one real one under noise.
    const faults = deriveFleetFaults(
      [
        { pathId: 'a', wanInterface: 'ether1' },
        { pathId: 'b', wanInterface: 'ether2' },
        { pathId: 'c', wanInterface: 'ether3', publicIp: null },
      ],
      farm,
    )
    for (const id of ['a', 'b', 'c']) expect(faults.get(id)?.duplicatePublicIpWith).toEqual([])
  })
})

/**
 * Plan 134 (M99) §4.4 — reading the router's own `/ping` reply.
 *
 * The response SHAPE here is inference from RouterOS documentation, not a
 * verified fact (the header on `summarisePing` says so). Every test below is
 * therefore about the two properties that hold regardless of shape: a reply
 * that cannot be read is `unknown`, and only an actually-empty result set is
 * `fail`.
 */
describe('summarisePing (plan 134 §4.4)', () => {
  test('every packet back: ok, with the count in the message', () => {
    const r = summarisePing([{ seq: 0, time: '12ms' }, { seq: 1, time: '11ms' }, { seq: 2, time: '13ms' }], '8.8.8.8', 'wan-modem24-s2p6')
    expect(r.status).toBe('ok')
    expect(r.packetLoss).toBe(0)
    expect(r.message).toContain('3/3')
  })

  test('nothing back: fail, and the message points at the SIM, not the router — this is the #20 case', () => {
    const r = summarisePing([{ seq: 0, status: 'timeout' }, { seq: 1, status: 'timeout' }, { seq: 2, status: 'timeout' }], '8.8.8.8', 'wan-modem40-s2p22')
    expect(r.status).toBe('fail')
    expect(r.packetLoss).toBe(100)
    expect(r.message).toMatch(/data plan|carrier/i)
    // The whole point: it must NOT send the operator back to the router
    // config, which is where the plan 133 sentences send them.
    expect(r.message).toMatch(/not the router/i)
  })

  test('partial loss is still ok — one reply proves the path reaches the internet', () => {
    const r = summarisePing([{ seq: 0, status: 'timeout' }, { seq: 1, time: '90ms' }, { seq: 2, status: 'timeout' }], '8.8.8.8', 'wan1')
    expect(r.status).toBe('ok')
    expect(r.packetLoss).toBe(67)
  })

  test('a reply this build cannot read is UNKNOWN, never fail', () => {
    // The honesty rule, tested against every shape that could plausibly come
    // back from a RouterOS whose response format differs from the assumption.
    for (const raw of [null, undefined, [], {}, 'pong', 42]) {
      expect(summarisePing(raw, '8.8.8.8', 'wan1').status).toBe('unknown')
    }
  })

  test('rows that are not objects are ignored rather than counted as replies', () => {
    expect(summarisePing([null, 'x', { seq: 0, time: '9ms' }], '8.8.8.8', 'wan1')).toMatchObject({ status: 'ok', packetLoss: 67 })
  })
})
