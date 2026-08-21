import { z } from 'zod'

/**
 * Zod shapes for RouterOS 7's REST responses (spec: everything crossing a
 * boundary is parsed, never `as`-cast — 00-overview.md §4.2 — and a router on
 * a different RouterOS version returning a different shape must fail as a
 * named parse error, not silently produce garbage).
 *
 * ## What is hardware-verified here, and what is not — read this before trusting a field name
 *
 * Plan 122 §0/§4.1 records ONE endpoint as actually tested against real
 * hardware (RouterOS 7.24, hAP ax²): `/rest/routing/rule` — its field names
 * (`.id`/`src-address`/`table`/`comment`/`disabled`/`inactive`) and its verb
 * behaviour (`GET` array, `PUT` returns the created object, `PATCH` returns
 * the updated object, `DELETE` returns empty). `RouterRuleSchema` below
 * reflects exactly that.
 *
 * `RoutingTableSchema`, `IpRouteSchema`, `InterfaceSchema` and
 * `DhcpLeaseSchema` were **not** exercised against a real router in this
 * change — there was no hardware available. Their field names follow
 * RouterOS's well-documented REST convention (the JSON key is the same
 * hyphenated name the CLI's `print` output uses), but that is inference from
 * public documentation, not a verified fact the way the rule shape is. Every
 * one of them is `.passthrough()` (unknown fields are kept, never rejected)
 * and treats booleans defensively (`boolish`, below) precisely because of
 * that gap — a field arriving as `"true"`/`"yes"` instead of a native JSON
 * `true` should still parse, while a genuinely different SHAPE (a missing
 * `.id`, a renamed identifying field) still fails loudly rather than being
 * coerced into something plausible-looking. The end-to-end integration test
 * gated behind `ENKAKU_TEST_DEVICE=1` (plan 122 §7) is where a real
 * disagreement with a live router is meant to surface.
 */

/**
 * RouterOS's REST API is known to render some boolean-valued properties as
 * native JSON booleans and others as the strings `"true"`/`"false"` depending
 * on version and endpoint — not verified against hardware in this change, so
 * this accepts either spelling (plus `"yes"`/`"no"`, the CLI's own boolean
 * vocabulary) rather than assuming one and failing on the other.
 */
const boolish = z.preprocess((v) => {
  if (typeof v === 'boolean') return v
  if (v === 'true' || v === 'yes') return true
  if (v === 'false' || v === 'no') return false
  return v
}, z.boolean())

/** `GET /rest/routing/rule` — hardware-verified field set (plan 122 §0, §4.1). */
export const RouterRuleSchema = z
  .object({
    '.id': z.string(),
    'src-address': z.string().optional(),
    'dst-address': z.string().optional(),
    action: z.string().optional(),
    table: z.string().optional(),
    comment: z.string().default(''),
    disabled: boolish.default(false),
    inactive: boolish.default(false),
  })
  .passthrough()

export type RouterRule = z.infer<typeof RouterRuleSchema>

export const RouterRuleListSchema = z.array(RouterRuleSchema)

/**
 * `GET /rest/routing/table` — one row per user-defined routing table, which
 * this plugin treats as one row per egress path (§4.1, §4.5). Not
 * hardware-verified in this change (see this file's header).
 */
export const RoutingTableSchema = z
  .object({
    '.id': z.string(),
    name: z.string(),
    fib: boolish.optional(),
    disabled: boolish.default(false),
  })
  .passthrough()

export type RoutingTable = z.infer<typeof RoutingTableSchema>

export const RoutingTableListSchema = z.array(RoutingTableSchema)

/**
 * `GET /rest/ip/route` — used to find each table's default route, its
 * gateway, and its `active` flag, which is what "path is up" means (§4.5).
 * Not hardware-verified in this change (see this file's header).
 *
 * The routing-table membership field was renamed between RouterOS major
 * versions (`table` on v6, `routing-table` on v7) — both are accepted here,
 * preferring `routing-table` when both are present, rather than picking one
 * spelling and failing silently against the other.
 */
export const IpRouteSchema = z
  .object({
    '.id': z.string(),
    'dst-address': z.string().optional(),
    gateway: z.string().optional(),
    'routing-table': z.string().optional(),
    table: z.string().optional(),
    active: boolish.default(false),
    disabled: boolish.default(false),
  })
  .passthrough()

export type IpRoute = z.infer<typeof IpRouteSchema>

export const IpRouteListSchema = z.array(IpRouteSchema)

/** `GET /rest/interface` — not hardware-verified in this change (see this file's header). */
export const InterfaceSchema = z
  .object({
    '.id': z.string(),
    name: z.string(),
    type: z.string().optional(),
    running: boolish.default(false),
    disabled: boolish.default(false),
  })
  .passthrough()

export type RouterInterface = z.infer<typeof InterfaceSchema>

export const InterfaceListSchema = z.array(InterfaceSchema)

/**
 * `GET /rest/ip/dhcp-server/lease` — `dynamic` is the field §3.4's
 * `leaseKind` check reads: RouterOS sets it `true` for a lease the DHCP
 * server created itself from a client request, `false` for one an operator
 * added as a static entry. Not hardware-verified in this change (see this
 * file's header).
 */
export const DhcpLeaseSchema = z
  .object({
    '.id': z.string(),
    address: z.string().optional(),
    'mac-address': z.string().optional(),
    'host-name': z.string().optional(),
    status: z.string().optional(),
    dynamic: boolish.default(true),
    disabled: boolish.default(false),
  })
  .passthrough()

export type DhcpLease = z.infer<typeof DhcpLeaseSchema>

export const DhcpLeaseListSchema = z.array(DhcpLeaseSchema)

/**
 * `GET /rest/system/resource` — used only for `doctor()`'s best-effort
 * `restVersion` field. Not hardware-verified in this change; failing to
 * parse this is treated as "version unknown," never as a reachability or
 * auth failure, since every other check has already succeeded by the time
 * this one runs.
 */
export const SystemResourceSchema = z
  .object({
    version: z.string().optional(),
  })
  .passthrough()
