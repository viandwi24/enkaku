import { describe, expect, test } from 'bun:test'
import { MikrotikRestDriver } from './router-driver'
import { MikrotikRestError } from './errors'
import { LOCAL_EXCEPTION_COMMENT } from '../shared'

/**
 * `MikrotikRestDriver`'s `inventory()`, `listRules()` and `doctor()` against
 * a fake HTTP server — no real router, per plan 122 §5 step 122.1 / §7. The
 * fixture below stands in for a hAP ax² answering `/rest/routing/table`,
 * `/rest/ip/route`, `/rest/interface`, `/rest/ip/dhcp-server/lease`,
 * `/rest/routing/rule` and `/rest/system/resource`.
 */

const USERNAME = 'admin'
const PASSWORD = 'correct-horse-battery-staple'

interface FixtureData {
  tables?: unknown[]
  routes?: unknown[]
  interfaces?: unknown[]
  leases?: unknown[]
  /** Plan 134 (M99) — `/ip/dhcp-client`, the router's WAN side. Omitted entirely means the fixture 404s it, which is the degradation case §4.1 must survive. */
  dhcpClients?: unknown[]
  rules?: unknown[]
  systemResource?: unknown
  authRequired?: boolean
}

function startFixtureRouter(data: FixtureData): { port: number; stop: () => void } {
  const routes: Record<string, unknown[] | unknown> = {
    '/rest/routing/table': data.tables ?? [],
    '/rest/ip/route': data.routes ?? [],
    '/rest/interface': data.interfaces ?? [],
    '/rest/ip/dhcp-server/lease': data.leases ?? [],
    ...(data.dhcpClients ? { '/rest/ip/dhcp-client': data.dhcpClients } : {}),
    '/rest/routing/rule': data.rules ?? [],
    '/rest/system/resource': data.systemResource ?? { version: '7.24 (stable)' },
  }
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      if (data.authRequired !== false) {
        const header = req.headers.get('authorization')
        const decoded = header?.startsWith('Basic ') ? Buffer.from(header.slice(6), 'base64').toString('utf8') : ''
        if (decoded !== `${USERNAME}:${PASSWORD}`) return new Response('', { status: 401 })
      }
      const pathname = new URL(req.url).pathname
      if (pathname in routes) return Response.json(routes[pathname])
      return new Response('not found', { status: 404 })
    },
  })
  return { port: boundPort(server), stop: () => server.stop(true) }
}

/**
 * `@types/bun` types `Server.port` as `number | undefined` (it is `undefined`
 * for a unix-socket server) — every fixture here binds `port: 0` on TCP, so
 * it is always a real number by the time `.listen` resolves; this just
 * narrows the type rather than asserting anything new about runtime
 * behaviour.
 */
function boundPort(server: { port?: number }): number {
  if (server.port === undefined) throw new Error('fixture server has no bound port')
  return server.port
}

function driverFor(port: number, overrides: Partial<{ password: string }> = {}): MikrotikRestDriver {
  return new MikrotikRestDriver({ baseUrl: `127.0.0.1:${port}`, username: USERNAME, password: overrides.password ?? PASSWORD, tls: false, timeoutMs: 2_000 })
}

const TABLES = [
  { '.id': '*1', name: 'via-modem7-p12' },
  { '.id': '*2', name: 'via-modem2' },
]

const ROUTES = [
  { '.id': '*10', 'dst-address': '0.0.0.0/0', gateway: '192.168.30.1', 'routing-table': 'via-modem7-p12', active: true, disabled: false },
  { '.id': '*11', 'dst-address': '0.0.0.0/0', gateway: '192.168.40.1', 'routing-table': 'via-modem2', active: false, disabled: false },
]

const INTERFACES = [{ '.id': '*20', name: 'ether1', type: 'ether', running: true, disabled: false }]

const LEASES = [
  { '.id': '*30', address: '192.168.10.215', 'mac-address': 'AA:BB:CC:DD:EE:01', status: 'bound', dynamic: true },
  { '.id': '*31', address: '192.168.10.216', 'mac-address': 'AA:BB:CC:DD:EE:02', status: 'bound', dynamic: false },
]

describe('MikrotikRestDriver.inventory — §4.1, §4.5', () => {
  test('joins /routing/table with /ip/route to report each path\'s gateway and up/down health', async () => {
    const fixture = startFixtureRouter({ tables: TABLES, routes: ROUTES, interfaces: INTERFACES, leases: LEASES })
    try {
      const inventory = await driverFor(fixture.port).inventory()
      expect(inventory.paths).toEqual([
        { id: 'via-modem7-p12', table: 'via-modem7-p12', gateway: '192.168.30.1', hasDefaultRoute: true, wanInterface: null },
        { id: 'via-modem2', table: 'via-modem2', gateway: '192.168.40.1', hasDefaultRoute: true, wanInterface: null },
      ])
      expect(inventory.health).toEqual([
        { pathId: 'via-modem7-p12', up: true, checkedAt: expect.any(Number), link: 'ok', gateway: 'ok', egress: 'unknown' },
        // Plan 133 — the fixture's down route carries no `immediate-gw` field
        // at all, which degrades to the least-specific reason rather than
        // claiming a wiring fault nobody observed.
        { pathId: 'via-modem2', up: false, checkedAt: expect.any(Number), reason: 'gateway-unreachable', link: 'ok', gateway: 'fail', egress: 'unknown' },
      ])
      expect(inventory.interfaces).toEqual([{ id: '*20', name: 'ether1', type: 'ether', running: true, disabled: false }])
      expect(inventory.leases).toEqual([
        { id: '*30', address: '192.168.10.215', macAddress: 'AA:BB:CC:DD:EE:01', dynamic: true, status: 'bound' },
        { id: '*31', address: '192.168.10.216', macAddress: 'AA:BB:CC:DD:EE:02', dynamic: false, status: 'bound' },
      ])
    } finally {
      fixture.stop()
    }
  })

  test('a table with no default route in /ip/route yields a path with `hasDefaultRoute: false` and `up: false`, never a guess', async () => {
    const fixture = startFixtureRouter({ tables: [{ '.id': '*1', name: 'via-modem31' }], routes: [] })
    try {
      const inventory = await driverFor(fixture.port).inventory()
      expect(inventory.paths).toEqual([{ id: 'via-modem31', table: 'via-modem31', gateway: null, hasDefaultRoute: false, wanInterface: null }])
      // Plan 133 — and it now says WHICH kind of down: no default route at all.
      expect(inventory.health).toEqual([{ pathId: 'via-modem31', up: false, checkedAt: expect.any(Number), reason: 'no-default-route', link: 'fail', gateway: 'unknown', egress: 'unknown' }])
    } finally {
      fixture.stop()
    }
  })

  test('a response missing the identifying field fails as a NAMED parse error, never silently as an empty or garbage inventory', async () => {
    // `name` dropped from the table row — a shape a different RouterOS build could plausibly send.
    const fixture = startFixtureRouter({ tables: [{ '.id': '*1' }] })
    try {
      await expect(driverFor(fixture.port).inventory()).rejects.toThrow(MikrotikRestError)
      try {
        await driverFor(fixture.port).inventory()
        throw new Error('should have thrown')
      } catch (err) {
        expect(err).toBeInstanceOf(MikrotikRestError)
        expect((err as MikrotikRestError).kind).toBe('parse')
        expect((err as MikrotikRestError).message).toContain('/routing/table')
      }
    } finally {
      fixture.stop()
    }
  })
})

describe('MikrotikRestDriver.listRules — every rule, managed and foreign, unfiltered', () => {
  test('returns all rows verbatim; classification is a later step\'s job, not this one\'s', async () => {
    const rules = [
      { '.id': '*1', comment: LOCAL_EXCEPTION_COMMENT, 'src-address': '10.0.0.0/24', 'dst-address': '192.168.0.0/16', table: 'main', disabled: false, inactive: false },
      { '.id': '*2', comment: 'enkaku:mikrotik-routing:v1:jadwal-1:192.168.10.215', 'src-address': '192.168.10.215/32', table: 'via-modem7-p12', disabled: false, inactive: false },
      { '.id': '*3', comment: 'hand-added by an operator', 'src-address': '192.168.10.220/32', table: 'via-modem9', disabled: false, inactive: false },
    ]
    const fixture = startFixtureRouter({ rules })
    try {
      const result = await driverFor(fixture.port).listRules()
      expect(result).toHaveLength(3)
      expect(result.map((r) => r['.id'])).toEqual(['*1', '*2', '*3'])
    } finally {
      fixture.stop()
    }
  })
})

describe('MikrotikRestDriver.doctor — reachability/auth/version/rule counts; the local-exception CHECK itself moved to local-exception.ts (§5 step 122.12)', () => {
  test('reachable and authenticated: rules handed back unfiltered (so a caller can classify local-exception coverage itself), counts and version populated', async () => {
    const rules = [
      { '.id': '*1', comment: LOCAL_EXCEPTION_COMMENT, table: 'main', disabled: false, inactive: false },
      { '.id': '*2', comment: 'enkaku:mikrotik-routing:v1:g:1', table: 'via-modem7-p12', disabled: false, inactive: false },
      { '.id': '*3', comment: 'hand-added', table: 'via-modem9', disabled: false, inactive: false },
    ]
    const fixture = startFixtureRouter({ rules, systemResource: { version: '7.24 (stable)' } })
    try {
      const report = await driverFor(fixture.port).doctor()
      expect(report.reachable).toBe(true)
      expect(report.authenticated).toBe(true)
      expect(report.rules.map((r) => r['.id'])).toEqual(['*1', '*2', '*3'])
      expect(report.managedRuleCount).toBe(1)
      expect(report.foreignRuleCount).toBe(2)
      expect(report.restVersion).toBe('7.24 (stable)')
      expect(report.errors).toEqual([])
    } finally {
      fixture.stop()
    }
  })

  test('wrong credentials: reachable but not authenticated, and the refusal is recorded in `errors` with no credential in it', async () => {
    const fixture = startFixtureRouter({ rules: [] })
    try {
      const report = await driverFor(fixture.port, { password: 'wrong-password' }).doctor()
      expect(report.reachable).toBe(true)
      expect(report.authenticated).toBe(false)
      expect(report.restVersion).toBeNull()
      expect(report.managedRuleCount).toBe(0)
      expect(report.foreignRuleCount).toBe(0)
      expect(report.errors.length).toBeGreaterThan(0)
      expect(report.errors.join(' ')).not.toContain(PASSWORD)
    } finally {
      fixture.stop()
    }
  })

  test('an unreachable router: neither reachable nor authenticated, and the report still comes back (empty rules) rather than throwing', async () => {
    const probe = Bun.serve({ port: 0, fetch: () => new Response('') })
    const deadPort = boundPort(probe)
    probe.stop(true)
    const report = await driverFor(deadPort).doctor()
    expect(report.reachable).toBe(false)
    expect(report.authenticated).toBe(false)
    expect(report.rules).toEqual([])
    expect(report.errors.length).toBeGreaterThan(0)
  })
})

describe('MikrotikRestDriver write methods — step 122.6', () => {
  test('createRule PUTs src-address as an explicit /32 and returns the router\'s own .id', async () => {
    let capturedMethod = ''
    let capturedPath = ''
    let capturedBody: unknown = null
    const server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        capturedMethod = req.method
        capturedPath = new URL(req.url).pathname
        capturedBody = await req.json().catch(() => null)
        return Response.json({ '.id': '*99', ...(capturedBody as object) })
      },
    })
    try {
      const result = await driverFor(boundPort(server)).createRule({ srcAddress: '192.168.10.215', table: 'via-modem7-p12', comment: 'enkaku:mikrotik-routing:v1:default:192.168.10.215' })
      expect(capturedMethod).toBe('PUT')
      expect(capturedPath).toBe('/rest/routing/rule')
      // Corrected after a review found the original bare-address write
      // (betting the router would echo it back unchanged) broke the very
      // next apply's match against the real router's CIDR-form response —
      // see this method's own header comment. `resolve.ts`/`planner.ts` now
      // match by parsed address range, so either spelling matches; `/32` is
      // written because it matches what hand-made rules already look like.
      expect(capturedBody).toMatchObject({
        'src-address': '192.168.10.215/32',
        table: 'via-modem7-p12',
        action: 'lookup-only-in-table',
        comment: 'enkaku:mikrotik-routing:v1:default:192.168.10.215',
      })
      expect(result).toEqual({ id: '*99' })
    } finally {
      server.stop(true)
    }
  })

  test('updateRule PATCHes a patched src-address as an explicit /32 too', async () => {
    let capturedBody: unknown = null
    const server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        capturedBody = await req.json().catch(() => null)
        return Response.json({})
      },
    })
    try {
      await driverFor(boundPort(server)).updateRule('*6', { srcAddress: '192.168.10.216' })
      expect(capturedBody).toEqual({ 'src-address': '192.168.10.216/32' })
    } finally {
      server.stop(true)
    }
  })

  test('createRule includes disabled only when the caller passed it', async () => {
    let capturedBody: unknown = null
    const server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        capturedBody = await req.json().catch(() => null)
        return Response.json({ '.id': '*1' })
      },
    })
    try {
      await driverFor(boundPort(server)).createRule({ srcAddress: '192.168.10.215', table: 'via-modem1', comment: 'x' })
      expect(capturedBody).not.toHaveProperty('disabled')
    } finally {
      server.stop(true)
    }
  })

  test('createRule throws a named parse error when the router\'s response carries no .id', async () => {
    const server = Bun.serve({ port: 0, fetch: () => Response.json({ ok: true }) })
    try {
      const driver = driverFor(boundPort(server))
      await expect(driver.createRule({ srcAddress: '192.168.10.215', table: 'via-modem1', comment: 'x' })).rejects.toThrow(MikrotikRestError)
      try {
        await driver.createRule({ srcAddress: '192.168.10.215', table: 'via-modem1', comment: 'x' })
        throw new Error('should have thrown')
      } catch (err) {
        expect(err).toBeInstanceOf(MikrotikRestError)
        expect((err as MikrotikRestError).kind).toBe('parse')
      }
    } finally {
      server.stop(true)
    }
  })

  test('updateRule PATCHes only the given fields to /routing/rule/<id>, with the leading * unescaped', async () => {
    let capturedMethod = ''
    let capturedPath = ''
    let capturedBody: unknown = null
    const server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        capturedMethod = req.method
        capturedPath = new URL(req.url).pathname
        capturedBody = await req.json().catch(() => null)
        return new Response('{}')
      },
    })
    try {
      await driverFor(boundPort(server)).updateRule('*6', { table: 'via-modem9' })
      expect(capturedMethod).toBe('PATCH')
      expect(capturedPath).toBe('/rest/routing/rule/*6')
      expect(capturedBody).toEqual({ table: 'via-modem9' })
    } finally {
      server.stop(true)
    }
  })

  test('updateRule sends every provided field, including comment (a group change re-derives the marker)', async () => {
    let capturedBody: unknown = null
    const server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        capturedBody = await req.json().catch(() => null)
        return new Response('{}')
      },
    })
    try {
      await driverFor(boundPort(server)).updateRule('*6', { table: 'via-modem9', comment: 'enkaku:mikrotik-routing:v1:jadwal-2:192.168.10.215' })
      expect(capturedBody).toEqual({ table: 'via-modem9', comment: 'enkaku:mikrotik-routing:v1:jadwal-2:192.168.10.215' })
    } finally {
      server.stop(true)
    }
  })

  test('deleteRule DELETEs /routing/rule/<id>', async () => {
    let capturedMethod = ''
    let capturedPath = ''
    const server = Bun.serve({
      port: 0,
      fetch: (req) => {
        capturedMethod = req.method
        capturedPath = new URL(req.url).pathname
        return new Response('')
      },
    })
    try {
      await driverFor(boundPort(server)).deleteRule('*6')
      expect(capturedMethod).toBe('DELETE')
      expect(capturedPath).toBe('/rest/routing/rule/*6')
    } finally {
      server.stop(true)
    }
  })

  test('a write against an unreachable router throws a MikrotikRestError("network"), never silently doing nothing', async () => {
    const probe = Bun.serve({ port: 0, fetch: () => new Response('') })
    const deadPort = boundPort(probe)
    probe.stop(true)
    await expect(driverFor(deadPort).deleteRule('*6')).rejects.toThrow(MikrotikRestError)
  })
})

/**
 * Plan 133 (M98). Three devices on the owner's farm had no internet for three
 * unrelated reasons and Studio said the same thing about all of them; the
 * router had known the difference the whole time. The decisive one, printed on
 * the real router:
 *
 *   0 Is  dst-address=0.0.0.0/0 routing-table=via-modem25-s2p7
 *         gateway=192.168.125.1 immediate-gw="" check-gateway=ping
 *
 * `immediate-gw=""` means the router holds no address in that gateway's
 * subnet, so it cannot reach the modem at all — a VLAN/DHCP fault on a switch
 * port, not a modem that stopped answering. An operator would never guess that
 * from the word "down", and it cost a CLI session to find.
 */
describe('MikrotikRestDriver.inventory — why a path is down (plan 133 §3.1)', () => {
  const table = (name: string) => ({ '.id': `*t-${name}`, name })
  const route = (name: string, over: Record<string, unknown> = {}) => ({
    '.id': `*r-${name}`,
    'dst-address': '0.0.0.0/0',
    'routing-table': name,
    gateway: '192.168.125.1',
    active: false,
    disabled: false,
    ...over,
  })

  async function healthOf(data: { tables: unknown[]; routes: unknown[] }) {
    const fixture = startFixtureRouter(data)
    try {
      return (await driverFor(fixture.port).inventory()).health
    } finally {
      fixture.stop()
    }
  }

  test('an empty immediate-gw is no-route-to-gateway — the router cannot reach the modem at all', async () => {
    const health = await healthOf({ tables: [table('via-modem25-s2p7')], routes: [route('via-modem25-s2p7', { 'immediate-gw': '' })] })
    expect(health[0]).toMatchObject({ pathId: 'via-modem25-s2p7', up: false, reason: 'no-route-to-gateway' })
  })

  test('a resolved immediate-gw that is simply not active is gateway-unreachable — the modem is off or silent', async () => {
    const health = await healthOf({ tables: [table('via-modem26')], routes: [route('via-modem26', { 'immediate-gw': '192.168.126.1%ether7' })] })
    expect(health[0]).toMatchObject({ up: false, reason: 'gateway-unreachable' })
  })

  test('a table with no default route at all is no-default-route', async () => {
    const health = await healthOf({ tables: [table('via-modem99')], routes: [] })
    expect(health[0]).toMatchObject({ up: false, reason: 'no-default-route' })
  })

  test('a healthy path carries no reason — there is nothing to explain', async () => {
    const health = await healthOf({ tables: [table('via-modem21')], routes: [route('via-modem21', { active: true, 'immediate-gw': '192.168.121.1%ether3' })] })
    expect(health[0]).toEqual({ pathId: 'via-modem21', up: true, checkedAt: expect.any(Number), link: 'ok', gateway: 'ok', egress: 'unknown' })
    expect('reason' in health[0]!).toBe(false)
  })

  test('an ABSENT immediate-gw field degrades to gateway-unreachable, never to a wiring fault nobody observed', async () => {
    // §8 R1 — a future RouterOS that stops sending the field must not be read
    // as "the router has no address on that subnet".
    const health = await healthOf({ tables: [table('via-modem30')], routes: [route('via-modem30')] })
    expect(health[0]).toMatchObject({ up: false, reason: 'gateway-unreachable' })
  })
})

/**
 * Plan 134 (M99) §3.4 / §4.1 — the fleet fault reaches the health array, and
 * the new endpoint cannot take the screen down with it.
 */
describe('MikrotikRestDriver.inventory — duplicate WAN addresses (plan 134 §3.4)', () => {
  /** Verbatim from the owner's router during the plan 133 session: two Orbits left on the factory-default subnet. */
  const DUP_TABLES = [
    { '.id': '*1', name: 'via-modem25-s2p7' },
    { '.id': '*2', name: 'via-modem27-s2p9' },
    { '.id': '*3', name: 'via-modem24-s2p6' },
  ]
  const DUP_ROUTES = [
    { '.id': '*10', 'dst-address': '0.0.0.0/0', gateway: '192.168.125.1', 'routing-table': 'via-modem25-s2p7', active: true, disabled: false, 'immediate-gw': '192.168.125.1%wan-modem25-s2p7' },
    { '.id': '*11', 'dst-address': '0.0.0.0/0', gateway: '192.168.127.1', 'routing-table': 'via-modem27-s2p9', active: true, disabled: false, 'immediate-gw': '192.168.127.1%wan-modem27-s2p9' },
    { '.id': '*12', 'dst-address': '0.0.0.0/0', gateway: '192.168.124.1', 'routing-table': 'via-modem24-s2p6', active: true, disabled: false, 'immediate-gw': '192.168.124.1%wan-modem24-s2p6' },
  ]
  const DUP_CLIENTS = [
    { '.id': '*40', interface: 'wan-modem25-s2p7', address: '192.168.8.100/24', status: 'bound', disabled: false },
    { '.id': '*41', interface: 'wan-modem27-s2p9', address: '192.168.8.100/24', status: 'bound', disabled: false },
    { '.id': '*42', interface: 'wan-modem24-s2p6', address: '192.168.124.100/24', status: 'bound', disabled: false },
  ]

  test('two uplinks holding one address are both flagged, naming each other; the third is clean', async () => {
    const fixture = startFixtureRouter({ tables: DUP_TABLES, routes: DUP_ROUTES, dhcpClients: DUP_CLIENTS })
    try {
      const health = await driverFor(fixture.port).inventory().then((i) => i.health)
      expect(health.find((h) => h.pathId === 'via-modem25-s2p7')?.duplicateAddressWith).toEqual(['via-modem27-s2p9'])
      expect(health.find((h) => h.pathId === 'via-modem27-s2p9')?.duplicateAddressWith).toEqual(['via-modem25-s2p7'])
      expect(health.find((h) => h.pathId === 'via-modem24-s2p6')).not.toHaveProperty('duplicateAddressWith')
    } finally {
      fixture.stop()
    }
  })

  test('a router that does not serve /ip/dhcp-client still returns a full inventory — the warning is lost, never the screen', async () => {
    // This is not a hypothetical: every pre-existing test in this file 404s
    // the endpoint, and before it was made best-effort they ALL threw. A
    // read-restricted API user on a real farm would have hit exactly that.
    const fixture = startFixtureRouter({ tables: DUP_TABLES, routes: DUP_ROUTES })
    try {
      const inventory = await driverFor(fixture.port).inventory()
      expect(inventory.paths).toHaveLength(3)
      expect(inventory.health.every((h) => h.up)).toBe(true)
      expect(inventory.health.some((h) => h.duplicateAddressWith !== undefined)).toBe(false)
    } finally {
      fixture.stop()
    }
  })

  test('a WAN list in a shape this build has never seen degrades the same way, rather than throwing', async () => {
    const fixture = startFixtureRouter({ tables: DUP_TABLES, routes: DUP_ROUTES, dhcpClients: [{ unexpected: true }] as unknown[] })
    try {
      expect((await driverFor(fixture.port).inventory()).paths).toHaveLength(3)
    } finally {
      fixture.stop()
    }
  })
})
