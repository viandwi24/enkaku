import { z } from 'zod'
import { MANAGED_COMMENT_PREFIX } from '../shared'
import { messageOf, MikrotikRestError } from './errors'
import { deriveFleetFaults, deriveHealth, summarisePing, type EgressProbeResult, type PathDownReason, type Probe } from './health'
import { MikrotikRestClient, type MikrotikRestConfig } from './rest-client'
import {
  DhcpClientListSchema,
  DhcpLeaseListSchema,
  InterfaceListSchema,
  IpRouteListSchema,
  RoutingTableListSchema,
  RouterRuleListSchema,
  SystemResourceSchema,
  type RouterRule,
} from './schemas'

// Plan 134 (M99): re-exported so every existing `import type { PathDownReason } from './router-driver'` keeps working — the derivation moved to `health.ts`, the public surface did not.
export type { EgressProbeResult, PathDownReason, Probe } from './health'

/**
 * `RouterDriver` — the seam plan 122 §4.1 draws so a second vendor or the
 * binary API can slot in without touching the group engine or the UI.
 * `MikrotikRestDriver` below is the only implementation, and (with
 * `rest-client.ts`) the only file in this plugin that knows the words
 * `src-address`, `lookup-only-in-table`, or `/rest/`.
 *
 * **`createRule`/`updateRule`/`deleteRule` are built as of step 122.6.** Every
 * write is a thin REST call — `PUT`, `PATCH .../*<id>`, `DELETE .../*<id>` —
 * and this driver itself never decides WHICH of the three to use for a given
 * endpoint: that is §4.3's resolve-before-write (`resolve.ts`), and it is the
 * caller's job (`service/apply.ts`, via `planner.ts`'s `buildPlan`) to call
 * `resolveTarget` against freshly-fetched rules before choosing which method
 * to call, and to gate every call on §3.2's local-exception check first. No
 * router `.id` is ever persisted to KV anywhere in this plugin (§3.3) — the
 * `id` a caller passes to `updateRule`/`deleteRule` always comes from a
 * `RouterRule` that was fetched fresh in the same request, never a remembered
 * one.
 */
export interface RouterDriver {
  inventory(): Promise<RouterInventory>
  /** ALL rules — managed and foreign alike. Classification is step 122.2's job (marker parse). */
  listRules(): Promise<RouterRule[]>
  createRule(rule: DesiredRule): Promise<{ id: string }>
  updateRule(id: string, patch: Partial<DesiredRule>): Promise<void>
  deleteRule(id: string): Promise<void>
  doctor(): Promise<DoctorReport>
  /**
   * Plan 134 (M99) §4.4 — send a handful of ICMP packets to `target` OUT OF a
   * specific uplink, and report what came back. The one check in this plugin
   * that can tell "the modem answers the router" from "the modem has working
   * internet" — the distinction that reported device #20 healthy with no data
   * plan at all (§0.1).
   *
   * Never throws. A router that cannot run the probe yields `unknown`, never
   * `fail`: failing to measure and measuring a failure are different facts,
   * and only one of them is about the modem.
   */
  probeEgress(wanInterface: string, target?: string): Promise<EgressProbeResult>
}

/** Plan 134 §4.4 — where a probe goes when the operator names nothing. A plain IP, deliberately: resolving a hostname would make a DNS failure look like an egress failure. */
export const DEFAULT_PROBE_TARGET = '8.8.8.8'

/** How many ICMP packets one probe sends. Small on purpose — §2: every packet is metered LTE data on someone's SIM. */
const PROBE_PACKET_COUNT = 3

/** One egress path — a RouterOS routing table, identified by its own name (there is no other stable id RouterOS gives a table). */
export interface Path {
  id: string
  table: string
  /** The gateway of this table's own default route, or `null` if it has none. */
  gateway: string | null
  /** Whether a default route (`0.0.0.0/0`) exists in this table at all. */
  hasDefaultRoute: boolean
  /**
   * Plan 134 (M99) — the uplink RouterOS itself resolved this path's gateway
   * to, from the route's `immediate-gw`. `null` when it could not resolve one,
   * which is precisely the plan 133 fault (`immediate-gw=""`).
   *
   * Taken from the router's own answer rather than matched by subnet: on this
   * farm two ports genuinely shared a subnet (plan 133 §0.3), so a hand-rolled
   * match would have picked the wrong modem at the one moment it mattered.
   * It is also what §4.4's probe is addressed to.
   */
  wanInterface: string | null
}

/**
 * Why a path is down (plan 133 §3.1) — derived entirely from the route object
 * this driver already fetches, never guessed. The three fixes are unrelated,
 * which is the whole reason they are three values and not one:
 *
 * - `no-default-route` — the table has no `0.0.0.0/0` route. Nothing can
 *   egress through it at all.
 * - `no-route-to-gateway` — a default route exists, but `immediate-gw` is
 *   EMPTY: the router holds no address in the gateway's subnet, so it cannot
 *   reach the gateway to begin with. A wiring / VLAN / DHCP-client fault on
 *   the router, not a modem fault. This is the one an operator would never
 *   guess from the word "down".
 * - `gateway-unreachable` — the route resolves, but the gateway did not
 *   answer `check-gateway`. The modem is off, unplugged, or silent.
 */

/** A path's health, per §4.5: up iff its default route carries the `active` flag. Kept as its own array (matching the `RouterDriver` interface's own shape), not folded into `Path`, because reconcile (§4.7, a later step) refreshes this independently of the path list itself. */
export interface PathHealth {
  pathId: string
  up: boolean
  checkedAt: number
  /** Absent when `up` — a healthy path has nothing to explain (plan 133 §4). */
  reason?: PathDownReason
  /**
   * Plan 134 (M99) §3.1 — three independent facts, because one boolean was
   * answering a different question than the one everybody read it as. See
   * `health.ts`'s header for the incident. `up` above is unchanged and stays
   * the field every existing consumer reads.
   */
  link: Probe
  gateway: Probe
  /**
   * `unknown` until something actually probed (§3.2: a probe costs LTE data on
   * a metered SIM, so nothing probes on its own). NEVER `ok` by inference —
   * that inference is exactly what reported #20 healthy with no data plan.
   */
  egress: Probe
  /** The public IP last observed egressing through this path. Absent until measured — no per-path public IP is assumed from the router side (§0.4). */
  publicIp?: string
  egressCheckedAt?: number
  /** Plan 134 §3.4 — other paths whose uplink holds the same address. The plan 133 fault, named. */
  duplicateAddressWith?: string[]
  /** Plan 134 §3.4 — other PROBED paths egressing from the same public IP. Plan 132 §0's ban risk, made visible. */
  duplicatePublicIpWith?: string[]
}

/**
 * `192.168.124.1%wan-modem24-s2p6` → `wan-modem24-s2p6`.
 *
 * RouterOS resolves a route's gateway to an interface itself and prints both,
 * separated by `%`. Taking its answer rather than matching subnets by hand is
 * the point: the router knows which port it would actually send through, and
 * on this farm two ports genuinely shared a subnet (plan 133 §0.3), so subnet
 * matching would have picked the wrong one at exactly the moment it mattered.
 *
 * `null` for an absent or unresolved value — `immediate-gw=""` IS the plan 133
 * fault, and a path whose interface is unknown takes part in no duplicate
 * group rather than being guessed into one.
 */
function interfaceOfImmediateGw(immediateGw: string | undefined): string | null {
  if (!immediateGw) return null
  const percent = immediateGw.indexOf('%')
  if (percent === -1) return null
  const iface = immediateGw.slice(percent + 1).trim()
  return iface === '' ? null : iface
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
  /**
   * Every rule on the router, unfiltered (empty when `reachable` is false) —
   * this driver already fetched them to answer `reachable`/`authenticated`,
   * and handing them back here is what lets a caller with device knowledge
   * (`service/handlers.ts`, which alone can reach `device.list`) run the
   * corrected local-exception check (`local-exception.ts`,
   * `classifyLocalException`, plan 122 §5 step 122.12) without a second
   * `listRules()` round trip. `MikrotikRestDriver` deliberately does NOT
   * compute local-exception coverage itself any more — that check is
   * per-device, and this driver has no device list to be per-device against
   * (§4.1: this file is the vendor seam, not the place identity or fleet
   * knowledge belongs).
   */
  rules: RouterRule[]
  /** A coarse comment-prefix count (§4.2) — not the full marker parser, which is step 122.2's job. */
  managedRuleCount: number
  foreignRuleCount: number
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

/**
 * The `action` every rule this plugin creates carries — §0.1's own worked
 * example (`action=lookup-only-in-table`). Fixed, not a `DesiredRule` field:
 * nothing above this driver has a reason to ever ask for a different action,
 * and a device rule that used plain `lookup` would fall through to the
 * routing table's own default rather than being confined to the assigned
 * path's table.
 */
const MANAGED_RULE_ACTION = 'lookup-only-in-table'

/**
 * `PUT /rest/routing/rule`'s response, narrowed to the one field a write
 * needs back (§4.1: "PUT returns the created object incl. `.id`"). `.passthrough()`
 * keeps every other field the router echoes without giving any of them a
 * vote on whether the write succeeded — the same discipline `schemas.ts`'s
 * own header lays out for every read shape in this plugin.
 */
const CreatedRuleSchema = z.object({ '.id': z.string() }).passthrough()

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
    const [tablesRaw, routesRaw, interfacesRaw, leasesRaw, clientsRaw] = await Promise.all([
      this.client.get('/routing/table'),
      this.client.get('/ip/route'),
      this.client.get('/interface'),
      this.client.get('/ip/dhcp-server/lease'),
      // Plan 134 (M99) §4.1 — the router's WAN side. One GET, and it is where
      // the plan 133 fault was legible in a single line (§0.3).
      //
      // BEST-EFFORT, and that is not caution for its own sake: this endpoint
      // is additive — it powers a duplicate-address warning and nothing else —
      // while `inventory()` is what renders the entire Paths tab and feeds
      // every apply. A router whose API user cannot read `/ip/dhcp-client`, or
      // a RouterOS that does not serve it, must lose the warning, not the
      // screen. Caught here rather than around the whole `Promise.all` so a
      // genuine failure of any OTHER endpoint still throws exactly as before.
      this.client.get('/ip/dhcp-client').catch(() => null),
    ])

    const tables = parseOrThrow(RoutingTableListSchema, tablesRaw, '/routing/table')
    const routes = parseOrThrow(IpRouteListSchema, routesRaw, '/ip/route')
    const interfaces = parseOrThrow(InterfaceListSchema, interfacesRaw, '/interface')
    const leases = parseOrThrow(DhcpLeaseListSchema, leasesRaw, '/ip/dhcp-server/lease')
    // Same reasoning as the fetch above, one step later: an unparseable WAN
    // list costs the warning, never the screen. No data means no duplicate
    // claim — never a claim that there are none.
    const dhcpClients = clientsRaw === null ? [] : (DhcpClientListSchema.safeParse(clientsRaw).data ?? [])

    const checkedAt = Math.floor(Date.now() / 1000)
    const paths: Path[] = []
    const health: PathHealth[] = []
    const wanInterfaceByPath: { pathId: string; wanInterface: string | null }[] = []
    for (const table of tables) {
      // `routing-table` (v7) preferred over `table` (v6) — see schemas.ts's
      // header on why both are accepted. A route with neither field, or one
      // naming a different table, does not belong to this path.
      const defaultRoute = routes.find((r) => (r['routing-table'] ?? r.table) === table.name && r['dst-address'] === '0.0.0.0/0' && !r.disabled)
      const wanInterface = interfaceOfImmediateGw(defaultRoute?.['immediate-gw'])
      paths.push({ id: table.name, table: table.name, gateway: defaultRoute?.gateway ?? null, hasDefaultRoute: defaultRoute !== undefined, wanInterface })
      const derived = deriveHealth(defaultRoute)
      // Plan 134 §3.2 — `egress` starts `unknown` on every path, every time.
      // It is only ever raised by something that actually sent a request
      // through this table, and a refetch of the inventory is not that.
      health.push({ pathId: table.name, checkedAt, egress: 'unknown', ...derived })
      // §3.4's join key: the interface the router would actually send through.
      // `immediate-gw` is RouterOS's own resolution of gateway → interface and
      // reads `192.168.124.1%wan-modem24-s2p6`, so the interface is the half
      // after `%`. Absent or unresolved (the plan 133 fault!) yields null, and
      // a path with no interface simply takes part in no duplicate group.
      wanInterfaceByPath.push({ pathId: table.name, wanInterface })
    }

    const faults = deriveFleetFaults(wanInterfaceByPath, dhcpClients)
    for (const entry of health) {
      const fault = faults.get(entry.pathId)
      if (fault && fault.duplicateAddressWith.length > 0) entry.duplicateAddressWith = fault.duplicateAddressWith
    }

    return {
      paths,
      interfaces: interfaces.map((i) => ({ id: i['.id'], name: i.name, type: i.type ?? null, running: i.running, disabled: i.disabled })),
      health,
      leases: leases.map((l) => ({ id: l['.id'], address: l.address ?? null, macAddress: l['mac-address'] ?? null, dynamic: l.dynamic, status: l.status ?? null })),
    }
  }

  /**
   * `PUT /routing/rule` — §4.1's verified behaviour: returns the created
   * object including its `.id`. `action` is always {@link MANAGED_RULE_ACTION};
   * `src-address` is written as `${rule.srcAddress}/32` — an explicit `/32`,
   * not a bare address.
   *
   * **Corrected by review immediately after step 122.6 landed, before it
   * shipped.** 122.6 originally wrote a bare address specifically so
   * `resolve.ts`'s then-exact-string match would line up. That bet on which
   * form the router hands back was wrong: the owner's real router echoes
   * every `src-address` in CIDR form regardless of what was written
   * (`192.168.10.221/32`, `192.168.50.11/32`, `192.168.100.230/32`,
   * `192.168.50.0/24` — a real `curl`, not a guess), so a bare write was
   * silently becoming a `/32` on the router's own side anyway, and the next
   * apply's exact-string match against the bare form it had just written
   * would fail regardless — creating a duplicate rule on every apply.
   * `resolve.ts`/`planner.ts` now match `src-address` by parsed address
   * RANGE (`cidr.ts`'s `sameAddressSpec`), not by raw string equality, so a
   * bare write and a `/32` write are both matched correctly either way — the
   * written form is no longer load-bearing for correctness, only for how it
   * reads. `/32` is chosen because it is what an operator already sees for
   * every hand-made rule in Winbox (the owner's own farm's existing rules
   * all carry an explicit prefix); a managed rule spelled differently from a
   * hand-made one for no functional reason is its own small, avoidable
   * confusion.
   */
  /**
   * §4.4. `POST /rest/ping` with `interface=` — chosen over `routing-table=`
   * because the owner's RouterOS 7.24 **rejected** `routing-table` on `/ping`
   * during the plan 133 session, as a bad parameter. `interface` forces the
   * packets out of one uplink, which is the same question asked a way this
   * router actually answers.
   *
   * Every failure to RUN the probe becomes `unknown`, and the message says
   * which failure it was. That is the point of the whole plan: a router that
   * cannot be asked must not be reported as a modem that failed.
   */
  async probeEgress(wanInterface: string, target: string = DEFAULT_PROBE_TARGET): Promise<EgressProbeResult> {
    try {
      const raw = await this.client.post('/ping', { address: target, interface: wanInterface, count: PROBE_PACKET_COUNT })
      return summarisePing(raw, target, wanInterface)
    } catch (err) {
      if (err instanceof MikrotikRestError) {
        // A 400 here is RouterOS rejecting the request itself — an unknown
        // parameter, or an interface name it does not have. Either way the
        // probe never left the router, so nothing was learned about the modem.
        if (err.status === 400) {
          return { status: 'unknown', message: `This router refused the probe request for ${wanInterface} — it may not support selecting an interface for /ping on this RouterOS version. Egress is unmeasured.` }
        }
        if (err.status === 404) {
          return { status: 'unknown', message: 'This router does not serve /rest/ping, so egress cannot be probed from the router side. Egress is unmeasured.' }
        }
        return { status: 'unknown', message: `The probe could not be run: ${err.message}` }
      }
      return { status: 'unknown', message: `The probe could not be run: ${messageOf(err)}` }
    }
  }

  async createRule(rule: DesiredRule): Promise<{ id: string }> {
    const body: Record<string, unknown> = {
      'src-address': `${rule.srcAddress}/32`,
      table: rule.table,
      action: MANAGED_RULE_ACTION,
      comment: rule.comment,
    }
    if (rule.disabled !== undefined) body.disabled = rule.disabled

    const raw = await this.client.put('/routing/rule', body)
    const parsed = CreatedRuleSchema.safeParse(raw)
    if (!parsed.success) {
      throw new MikrotikRestError('parse', `the router's response to PUT /routing/rule did not include a rule .id: ${parsed.error.message}`)
    }
    return { id: parsed.data['.id'] }
  }

  /**
   * `PATCH /routing/rule/<id>` — §4.1's verified behaviour: takes effect
   * immediately, and the leading `*` in a RouterOS `.id` needs no
   * URL-encoding (`rest-client.ts`'s own `urlFor`). Only the fields present on
   * `patch` are sent, so a caller updating just `table` never touches
   * `src-address`/`comment` it did not mean to change. When `src-address` IS
   * patched, it is written as `${patch.srcAddress}/32`, for the same reason
   * and to the same explicit form as `createRule` above.
   */
  async updateRule(id: string, patch: Partial<DesiredRule>): Promise<void> {
    const body: Record<string, unknown> = {}
    if (patch.srcAddress !== undefined) body['src-address'] = `${patch.srcAddress}/32`
    if (patch.table !== undefined) body.table = patch.table
    if (patch.comment !== undefined) body.comment = patch.comment
    if (patch.disabled !== undefined) body.disabled = patch.disabled
    await this.client.patch(`/routing/rule/${id}`, body)
  }

  /** `DELETE /routing/rule/<id>` — §4.1's verified behaviour: empty response. */
  async deleteRule(id: string): Promise<void> {
    await this.client.delete(`/routing/rule/${id}`)
  }

  /**
   * Reachability, auth, REST version, every rule (unfiltered — see
   * `DoctorReport.rules`'s own doc comment for why the local-exception check
   * itself moved out of this method) and managed-vs-foreign rule counts.
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
      rules,
      managedRuleCount,
      foreignRuleCount,
      errors,
    }
  }
}
