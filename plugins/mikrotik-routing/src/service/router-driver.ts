import type { z } from 'zod'
import { LOCAL_EXCEPTION_COMMENT, LOCAL_EXCEPTION_FIX_COMMANDS, MANAGED_COMMENT_PREFIX } from '../shared'
import { messageOf, MikrotikRestError } from './errors'
import { MikrotikRestClient, type MikrotikRestConfig } from './rest-client'
import {
  DhcpLeaseListSchema,
  InterfaceListSchema,
  IpRouteListSchema,
  RoutingTableListSchema,
  RouterRuleListSchema,
  SystemResourceSchema,
  type RouterRule,
} from './schemas'

/**
 * `RouterDriver` — the seam plan 122 §4.1 draws so a second vendor or the
 * binary API can slot in without touching the group engine or the UI.
 * `MikrotikRestDriver` below is the only implementation, and (with
 * `rest-client.ts`) the only file in this plugin that knows the words
 * `src-address`, `lookup-only-in-table`, or `/rest/`.
 *
 * **`createRule`/`updateRule`/`deleteRule` are declared here but NOT built in
 * this step.** Step 122.1 (this file) is stage 1 of plan 122 §5 — read-only —
 * and ships "with zero write capability existing yet." Step 122.6 owns their
 * bodies, behind §4.3's resolve-before-write and §3.2's local-exception
 * block. Declaring them now, throwing rather than existing nowhere, is what
 * lets the interface be reviewed and the driver be a real, complete seam
 * before anything is wired to write through it.
 */
export interface RouterDriver {
  inventory(): Promise<RouterInventory>
  /** ALL rules — managed and foreign alike. Classification is step 122.2's job (marker parse). */
  listRules(): Promise<RouterRule[]>
  createRule(rule: DesiredRule): Promise<{ id: string }>
  updateRule(id: string, patch: Partial<DesiredRule>): Promise<void>
  deleteRule(id: string): Promise<void>
  doctor(): Promise<DoctorReport>
}

/** One egress path — a RouterOS routing table, identified by its own name (there is no other stable id RouterOS gives a table). */
export interface Path {
  id: string
  table: string
  /** The gateway of this table's own default route, or `null` if it has none. */
  gateway: string | null
  /** Whether a default route (`0.0.0.0/0`) exists in this table at all. */
  hasDefaultRoute: boolean
}

/** A path's health, per §4.5: up iff its default route carries the `active` flag. Kept as its own array (matching the `RouterDriver` interface's own shape), not folded into `Path`, because reconcile (§4.7, a later step) refreshes this independently of the path list itself. */
export interface PathHealth {
  pathId: string
  up: boolean
  checkedAt: number
}

export interface Iface {
  id: string
  name: string
  type: string | null
  running: boolean
  disabled: boolean
}

/** A DHCP lease, read by IP (never by MAC — §0.3 item 3) to answer §3.4's "is this a static or dynamic address" question. */
export interface Lease {
  id: string
  address: string | null
  macAddress: string | null
  /** RouterOS's own `dynamic` flag: `true` for a lease the server created itself from a client request, `false` for a static entry an operator added. */
  dynamic: boolean
  status: string | null
}

export interface RouterInventory {
  paths: Path[]
  interfaces: Iface[]
  health: PathHealth[]
  leases: Lease[]
}

/** What a write would create or become — the shape §4.3's resolve-before-write and §4.4's planner both work against. Not exercised by any write in this step. */
export interface DesiredRule {
  srcAddress: string
  table: string
  comment: string
  disabled?: boolean
}

export interface DoctorReport {
  reachable: boolean
  authenticated: boolean
  /** Best-effort, from `/system/resource`. `null` when unreachable, unauthenticated, or the field could not be read — never a guess. */
  restVersion: string | null
  localException: {
    present: boolean
    rule: RouterRule | null
  }
  /** A coarse comment-prefix count (§4.2) — not the full marker parser, which is step 122.2's job. */
  managedRuleCount: number
  foreignRuleCount: number
  /** Always populated, even when `localException.present` is true, so a caller never has to know the commands itself. */
  fixCommands: readonly string[]
  /** Human-readable, scrubbed of the router password, describing anything that went wrong while gathering this report. */
  errors: string[]
}

function parseOrThrow<T>(schema: z.ZodType<T>, raw: unknown, path: string): T {
  const result = schema.safeParse(raw)
  if (!result.success) {
    throw new MikrotikRestError('parse', `the router's response to GET ${path} did not match the expected shape: ${result.error.message}`)
  }
  return result.data
}

const NOT_IMPLEMENTED = (method: string): Error =>
  new Error(`MikrotikRestDriver.${method} is not implemented yet — writes are step 122.6's job (plan 122 §5); this build ships with zero write capability`)

export class MikrotikRestDriver implements RouterDriver {
  private readonly client: MikrotikRestClient

  constructor(config: MikrotikRestConfig) {
    this.client = new MikrotikRestClient(config)
  }

  async listRules(): Promise<RouterRule[]> {
    const raw = await this.client.get('/routing/rule')
    return parseOrThrow(RouterRuleListSchema, raw, '/routing/rule')
  }

  /**
   * Paths from `/routing/table` joined with `/ip/route` to find each table's
   * own default route, its gateway, and its `active` flag (§4.5, §5 step
   * 122.1); interfaces from `/interface`; DHCP leases from
   * `/ip/dhcp-server/lease`, returned now even though nothing in this step
   * consumes them yet — §3.4's lease-kind check (a later step) needs them.
   */
  async inventory(): Promise<RouterInventory> {
    const [tablesRaw, routesRaw, interfacesRaw, leasesRaw] = await Promise.all([
      this.client.get('/routing/table'),
      this.client.get('/ip/route'),
      this.client.get('/interface'),
      this.client.get('/ip/dhcp-server/lease'),
    ])

    const tables = parseOrThrow(RoutingTableListSchema, tablesRaw, '/routing/table')
    const routes = parseOrThrow(IpRouteListSchema, routesRaw, '/ip/route')
    const interfaces = parseOrThrow(InterfaceListSchema, interfacesRaw, '/interface')
    const leases = parseOrThrow(DhcpLeaseListSchema, leasesRaw, '/ip/dhcp-server/lease')

    const checkedAt = Math.floor(Date.now() / 1000)
    const paths: Path[] = []
    const health: PathHealth[] = []
    for (const table of tables) {
      // `routing-table` (v7) preferred over `table` (v6) — see schemas.ts's
      // header on why both are accepted. A route with neither field, or one
      // naming a different table, does not belong to this path.
      const defaultRoute = routes.find((r) => (r['routing-table'] ?? r.table) === table.name && r['dst-address'] === '0.0.0.0/0' && !r.disabled)
      paths.push({ id: table.name, table: table.name, gateway: defaultRoute?.gateway ?? null, hasDefaultRoute: defaultRoute !== undefined })
      health.push({ pathId: table.name, up: defaultRoute?.active ?? false, checkedAt })
    }

    return {
      paths,
      interfaces: interfaces.map((i) => ({ id: i['.id'], name: i.name, type: i.type ?? null, running: i.running, disabled: i.disabled })),
      health,
      leases: leases.map((l) => ({ id: l['.id'], address: l.address ?? null, macAddress: l['mac-address'] ?? null, dynamic: l.dynamic, status: l.status ?? null })),
    }
  }

  // `async` here is load-bearing, not stylistic: it turns the synchronous
  // `throw` below into a REJECTED PROMISE, matching the interface's
  // `Promise<...>` return type — a bare (non-async) `throw` would instead
  // throw synchronously out of the call itself, which every caller written
  // against `RouterDriver`'s promise-returning contract (including a plain
  // `await driver.createRule(...)`) would still catch correctly, but which
  // `expect(driver.createRule(...)).rejects` in a test would not.
  async createRule(_rule: DesiredRule): Promise<{ id: string }> {
    throw NOT_IMPLEMENTED('createRule')
  }

  async updateRule(_id: string, _patch: Partial<DesiredRule>): Promise<void> {
    throw NOT_IMPLEMENTED('updateRule')
  }

  async deleteRule(_id: string): Promise<void> {
    throw NOT_IMPLEMENTED('deleteRule')
  }

  /**
   * Reachability, auth, REST version, presence of the local-exception rule
   * (§3.2 — the single most important safety check in the plugin, and
   * acceptance criterion 1) and managed-vs-foreign rule counts.
   *
   * Never throws: every failure downgrades the report rather than raising,
   * because a caller two steps from now (122.6's apply gate) needs a value
   * to read and branch on, not an exception to catch around the one call
   * that decides whether an apply is safe.
   */
  async doctor(): Promise<DoctorReport> {
    const errors: string[] = []
    let rules: RouterRule[] = []
    let reachable = false
    let authenticated = false

    try {
      rules = await this.listRules()
      reachable = true
      authenticated = true
    } catch (err) {
      if (err instanceof MikrotikRestError) {
        reachable = err.kind !== 'network'
        authenticated = err.kind !== 'network' && err.kind !== 'auth'
        errors.push(err.message)
      } else {
        errors.push(messageOf(err))
      }
    }

    const exceptionRule = rules.find((r) => r.comment === LOCAL_EXCEPTION_COMMENT) ?? null
    const managedRuleCount = rules.filter((r) => r.comment.startsWith(MANAGED_COMMENT_PREFIX)).length
    const foreignRuleCount = rules.length - managedRuleCount

    let restVersion: string | null = null
    if (reachable && authenticated) {
      try {
        const raw = await this.client.get('/system/resource')
        const parsed = SystemResourceSchema.safeParse(raw)
        restVersion = parsed.success ? (parsed.data.version ?? null) : null
      } catch (err) {
        errors.push(`could not read the router's REST version: ${err instanceof MikrotikRestError ? err.message : messageOf(err)}`)
      }
    }

    return {
      reachable,
      authenticated,
      restVersion,
      localException: { present: exceptionRule !== null, rule: exceptionRule },
      managedRuleCount,
      foreignRuleCount,
      fixCommands: LOCAL_EXCEPTION_FIX_COMMANDS,
      errors,
    }
  }
}
