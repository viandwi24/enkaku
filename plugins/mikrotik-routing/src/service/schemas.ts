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
 * `DhcpLeaseSchema` were **not** exercised against a real router when they
 * were written — there was no hardware available. Their field names follow
 * RouterOS's well-documented REST convention (the JSON key is the same
 * hyphenated name the CLI's `print` output uses), but that was inference
 * from public documentation, not a verified fact the way the rule shape is.
 *
 * **That inference has since been tested, and it was wrong.** Pointed at the
 * owner's real lab router (RouterOS 7.24, 46 routing tables, 2026-08-21),
 * `/routing/table` returned `fib` in a string spelling the boolean
 * preprocessor did not recognise, and the ORIGINAL design — where any
 * declared field could reject the row — failed all 46 rows and rendered the
 * Paths tab as nothing but a wall of `invalid_type`. For a field this plugin
 * has never read. Two rules came out of that and both are now enforced
 * below:
 *
 * 1. **Only a field this plugin actually READS belongs in the object body.**
 *    `fib` and `host-name` were declared, never read, and removed;
 *    `.passthrough()` still carries their values for anything that ever
 *    needs them. A field nobody reads must never get a vote on whether the
 *    response parses.
 * 2. **An unrecognised boolean spelling falls back to a per-field SAFE
 *    value, never a throw** — see `boolish` below for each field's chosen
 *    direction and why. An unreadable answer degrades one field toward
 *    caution instead of taking down the whole endpoint.
 *
 * A genuinely different SHAPE — a missing `.id`, a renamed identifying field
 * — still fails loudly rather than being coerced into something
 * plausible-looking. That distinction is the point: identity must be right,
 * decoration must not be load-bearing. `/rest/ip/route`, `/rest/interface`
 * and `/rest/ip/dhcp-server/lease` are still unproven against hardware —
 * the `/routing/table` failure happened first and stopped inventory before
 * they were ever reached. The `ENKAKU_TEST_DEVICE=1`-gated integration test
 * (plan 122 §7) is still where a real disagreement is meant to surface.
 */

/**
 * RouterOS's REST API renders boolean-valued properties inconsistently —
 * native JSON booleans on some endpoints, `"true"`/`"false"` strings on
 * others, and (measured on the owner's own RouterOS 7.24 lab router,
 * 2026-08-21) at least one property in some **other** string spelling
 * entirely: `/routing/table`'s `fib` rejected all 46 rows with
 * `expected boolean, received string`, which took the Paths tab down
 * completely.
 *
 * **So an unrecognised spelling must not be able to reject the response.**
 * The original version returned the raw value through to `z.boolean()`,
 * which threw — one unknown string on a field nobody reads killed the whole
 * endpoint. This version falls back to an explicit, per-field `safe` value
 * instead, and the caller has to choose that value deliberately.
 *
 * **`absent` and `unreadable` are two different questions and must not share
 * one answer.** A first version of this collapsed them and immediately broke
 * the common case: RouterOS OMITS a false-valued flag rather than sending
 * `false`, so on the owner's own router only the two genuinely-disabled
 * rules carried `disabled: "true"` and the five live ones carried no
 * `disabled` key at all. Treating "absent" as the cautious value made every
 * live rule read as disabled — which would have made the §3.2
 * local-exception check reject a rule that was working fine. Caught by this
 * file's own test against that captured router output, not by inspection.
 *
 * - **absent** means the router is telling us the flag is not set. That is
 *   an answer, not a gap, and it takes the field's ordinary default.
 * - **unreadable** means the router said something we could not parse. That
 *   is a gap, and it takes the direction that fails toward caution:
 *   - `active` (is this path up?) → `false`. Reporting a dead path as
 *     healthy is the one outcome §4.5 exists to prevent.
 *   - `disabled`/`inactive` → `true`. We cannot confirm the rule or route
 *     is live, so the local-exception check refuses rather than crediting a
 *     rule that may do nothing (§3.2).
 *   - `dynamic` (DHCP lease) → `true`, so §3.4's stale-IP warning fires when
 *     we cannot prove the lease is static — a moving IP silently steers the
 *     wrong device.
 *   - `running` (interface) → `false`. Decorative; nothing routes on it.
 */
function boolish(opts: { absent: boolean; unreadable: boolean }) {
  return z.preprocess((v) => {
    if (v === undefined || v === null) return opts.absent
    if (typeof v === 'boolean') return v
    if (v === 'true' || v === 'yes' || v === '1') return true
    if (v === 'false' || v === 'no' || v === '0') return false
    return opts.unreadable
  }, z.boolean())
}

/** `GET /rest/routing/rule` — hardware-verified field set (plan 122 §0, §4.1). */
export const RouterRuleSchema = z
  .object({
    '.id': z.string(),
    'src-address': z.string().optional(),
    'dst-address': z.string().optional(),
    action: z.string().optional(),
    table: z.string().optional(),
    comment: z.string().default(''),
    disabled: boolish({ absent: false, unreadable: true }),
    inactive: boolish({ absent: false, unreadable: true }),
  })
  .passthrough()

export type RouterRule = z.infer<typeof RouterRuleSchema>

export const RouterRuleListSchema = z.array(RouterRuleSchema)

/**
 * `GET /rest/routing/table` — one row per user-defined routing table, which
 * this plugin treats as one row per egress path (§4.1, §4.5).
 *
 * **`fib` was declared here and is not any more, and the reason is a rule
 * worth keeping: a field this plugin never reads must not be able to reject
 * the whole response.** It was declared `fib: boolish.optional()` on the
 * inference that RouterOS renders it as a boolean or one of the `"true"`/
 * `"yes"`/`"false"`/`"no"` spellings `boolish` accepts. Pointed at the
 * owner's real lab router (2026-08-21, RouterOS 7.24, 46 routing tables) it
 * came back as some OTHER string, so every single row failed
 * `invalid_type: expected boolean, received string` and the Paths tab
 * rendered nothing at all — for a field no code path in this plugin has ever
 * looked at. `.passthrough()` keeps the raw value available to anything that
 * ever needs it, without giving it a vote on whether the response parses.
 *
 * The general form of the rule, for whoever extends these schemas next:
 * only a field this plugin actually READS belongs in the object body.
 * Identity fields (`.id`, `name`) should fail loudly when absent, because a
 * row we cannot identify is useless. Everything else rides `.passthrough()`.
 */
export const RoutingTableSchema = z
  .object({
    '.id': z.string(),
    name: z.string(),
    disabled: boolish({ absent: false, unreadable: true }),
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
    /**
     * The interface/address RouterOS actually resolved the `gateway` to
     * (plan 133 §0.2). It has always arrived through `.passthrough()`; typing
     * it is what makes it readable.
     *
     * **Empty means the router cannot reach the gateway at all** — it holds no
     * address in that gateway's subnet, so there is no interface to send
     * through. That is a wiring/VLAN/DHCP fault on the router, and it is
     * nothing like "the modem stopped answering", which is what an operator
     * assumes when a path merely reads "down".
     */
    'immediate-gw': z.string().optional(),
    active: boolish({ absent: false, unreadable: false }),
    disabled: boolish({ absent: false, unreadable: true }),
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
    running: boolish({ absent: false, unreadable: false }),
    disabled: boolish({ absent: false, unreadable: true }),
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
    // `host-name` was declared here and never read by any code path — the
    // same latent defect `fib` turned into a real outage above. Removed for
    // the same reason; `.passthrough()` still carries it.
    status: z.string().optional(),
    dynamic: boolish({ absent: true, unreadable: true }),
    disabled: boolish({ absent: false, unreadable: true }),
  })
  .passthrough()

export type DhcpLease = z.infer<typeof DhcpLeaseSchema>

export const DhcpLeaseListSchema = z.array(DhcpLeaseSchema)

/**
 * `GET /rest/ip/dhcp-client` — the router's **WAN** side, one row per uplink
 * port, and the exact opposite of {@link DhcpLeaseSchema} above (which is the
 * LAN side: addresses this router HANDS OUT). This is the address the router
 * RECEIVED from each modem.
 *
 * Plan 134 (M99) §0.3 — added because the fault behind plan 133 was legible
 * here in one line and nowhere else without inference. Two Orbits left on the
 * factory-default subnet printed:
 *
 * ```
 * client5 wan-modem25-s2p7  192.168.8.100/24
 * client7 wan-modem27-s2p9  192.168.8.100/24
 * ```
 *
 * Two uplinks holding the identical address. Plan 133 reached the same
 * conclusion from `immediate-gw=""` — correct, but one step downstream of the
 * cause, and the operator still had to know what to look at.
 *
 * Declared per this file's header rule: only fields something actually reads,
 * every one optional, `.passthrough()` for the rest. Nothing here may reject a
 * row — a router with an uplink shape this build has never seen must still
 * render its Paths tab.
 */
export const DhcpClientSchema = z
  .object({
    '.id': z.string(),
    /** The uplink interface, e.g. `wan-modem25-s2p7`. The join key to a path's gateway subnet. */
    interface: z.string().optional(),
    /** As RouterOS prints it, WITH the prefix: `192.168.124.100/24`. Never assumed to be a bare address. */
    address: z.string().optional(),
    /** `bound` on a healthy uplink; `searching...`/`error` otherwise. Free-text — read for display, never branched on as an enum. */
    status: z.string().optional(),
    disabled: boolish({ absent: false, unreadable: true }),
  })
  .passthrough()

export type DhcpClient = z.infer<typeof DhcpClientSchema>

export const DhcpClientListSchema = z.array(DhcpClientSchema)

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
