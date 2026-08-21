import type { PluginRequest, PluginResponse } from '@enkaku/sdk'
import { LOCAL_EXCEPTION_COMMENT, ROUTER_KEY, isRouterConfigured, readRouterConfig, type RouterConfig } from '../shared'
import { messageOf, MikrotikRestError } from './errors'
import { parseMarker } from './marker'
import { MikrotikRestDriver, type RouterDriver } from './router-driver'
import type { RouterRule } from './schemas'

/**
 * The three read-only routes step 122.3's screen calls (`GET .../http/inventory`,
 * `GET .../http/rules`, `POST .../http/doctor`) — a door onto the
 * `RouterDriver` step 122.1 built, never a second lifecycle. Mirrors
 * `plugins/proxy-manager/src/service/handlers.ts`'s own shape: a narrow
 * `HandlerHost` a test can fake, one `onRequest` per verb (never one
 * registration for all three — see that file's own comment on why a shared
 * handler id would collapse the audit log's `target` into one indistinguishable
 * row), and every refusal answered `200`-shaped `{ ok: false, code, message }`
 * rather than thrown, because "no router saved yet" and "the router refused
 * our credentials" are ordinary product outcomes this screen has to render,
 * not faults.
 *
 * **No write route exists here, and none may until step 122.6.** These three
 * only ever call `inventory()`/`listRules()`/`doctor()` — the plan's own
 * stage-1 scope (§5): "Nothing in this step may apply anything to the
 * router."
 */

/** The narrow slice of `PluginServiceContext` this file needs — so a test supplies a fake `getRaw` and a fake `onRequest` rather than a whole runtime, the same trade `proxy-manager`'s own `HandlerHost` makes. */
export interface HandlerHost {
  storage: { global: { getRaw(key: string): Promise<unknown> } }
  onRequest(
    id: string,
    handler: (request: PluginRequest, signal: AbortSignal) => PluginResponse | void | Promise<PluginResponse | void>,
    opts?: { permission?: string; methods?: readonly ('GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE')[]; timeoutMs?: number; description?: string },
  ): void
}

/**
 * The three handler ids and the permission each is registered with — exported
 * so a test asserts the table rather than the implementation's memory of it,
 * the same discipline `plugins/proxy-manager/src/service/handlers.ts`'s own
 * `PROXY_ROUTE_PERMISSIONS` follows.
 *
 * All three are `script.view` — the permission that already had to be true
 * for an operator to open this screen at all (`onRequest`'s own default,
 * plan 109 §3.7) — because all three only ever READ the router. There is no
 * `plugin.runtime` verb here yet: that permission split only earns its keep
 * once an action changes something, and step 122.3 changes nothing.
 */
export const ROUTER_ROUTES = { inventory: 'inventory', rules: 'rules', doctor: 'doctor' } as const

export const ROUTER_ROUTE_PERMISSIONS: Record<keyof typeof ROUTER_ROUTES, string> = {
  inventory: 'script.view',
  rules: 'script.view',
  doctor: 'script.view',
}

/** What every route answers with when it cannot even reach a driver, or when the driver's own call throws. Always `200`-shaped — see this file's header. */
export interface RouterActionRefusal {
  ok: false
  code: string
  message: string
}

const E_ROUTER_NOT_CONFIGURED = 'E_ROUTER_NOT_CONFIGURED'

function notConfigured(reason: string): RouterActionRefusal {
  return { ok: false, code: E_ROUTER_NOT_CONFIGURED, message: reason }
}

/**
 * A thrown value from the driver → the same `{ ok: false, code, message }`
 * shape a missing connection answers with, so the screen has exactly one
 * refusal shape to render regardless of which of the two failed. A
 * `MikrotikRestError` already carries a `kind` (`network`/`auth`/`http`/
 * `parse`) that names what actually went wrong (§4.1); anything else is a
 * genuine bug in this file or its dependencies and is reported as `unknown`
 * rather than hidden.
 */
function toRefusal(err: unknown): RouterActionRefusal {
  if (err instanceof MikrotikRestError) {
    return { ok: false, code: `E_ROUTER_${err.kind.toUpperCase()}`, message: err.message }
  }
  return { ok: false, code: 'E_ROUTER_UNKNOWN', message: messageOf(err) }
}

/** One router rule, narrowed and classified for the Rules tab (§4.2, §4.3) — never persisted, computed fresh on every read. */
export interface RuleRow {
  id: string
  comment: string
  srcAddress: string | null
  table: string | null
  disabled: boolean
  inactive: boolean
  /** `true` for anything whose comment starts with the marker prefix — well-formed or not. A malformed/version-mismatched managed rule is still `managed: true` (§4.2's own orphan handling — never reclassified as foreign just because it could not be parsed). */
  managed: boolean
  /** The parsed `(groupId, endpointKey)` when the marker is well-formed and current-version. `null` for a foreign rule OR a managed rule this build cannot parse — see `markerIssue` for which. */
  marker: { groupId: string; endpointKey: string } | null
  /** Set only for a MANAGED rule whose marker did not parse cleanly (a future version, or truncated input) — the operator-facing reason `marker` is `null` even though `managed` is `true`. */
  markerIssue: string | null
  /** `true` for exactly the one rule §3.2 requires and this plugin will never touch — surfaced so the Rules tab can point it out rather than leaving it an anonymous foreign row. */
  isLocalException: boolean
}

/** One `RouterRule` (`service/schemas.ts`) → one `RuleRow`, via `parseMarker` (`service/marker.ts`, read here, not edited — step 122.2 owns that file). */
export function toRuleRow(rule: RouterRule): RuleRow {
  const parsed = parseMarker(rule.comment)
  return {
    id: rule['.id'],
    comment: rule.comment,
    srcAddress: rule['src-address'] ?? null,
    table: rule.table ?? null,
    disabled: rule.disabled,
    inactive: rule.inactive,
    managed: parsed.kind !== 'foreign',
    marker: parsed.kind === 'ok' ? { groupId: parsed.groupId, endpointKey: parsed.endpointKey } : null,
    markerIssue:
      parsed.kind === 'version-mismatch'
        ? `marker version "${parsed.version}" is not v1 — this build does not understand it`
        : parsed.kind === 'malformed'
          ? `marker prefix present but could not be parsed: ${parsed.reason}`
          : null,
    isLocalException: rule.comment === LOCAL_EXCEPTION_COMMENT,
  }
}

/**
 * Register the three routes on a live service context.
 *
 * `deps.createDriver` is injectable — tests supply a fake `RouterDriver` so
 * they never open a socket, the same seam `router-driver.test.ts` already
 * exercises the real `MikrotikRestDriver` through. Defaults to the real
 * driver, constructed fresh per request from whatever `router` KV currently
 * holds — no cached instance, no module-scope state, so a Settings save
 * takes effect on the very next read with nothing to invalidate.
 */
export function registerRouterRoutes(host: HandlerHost, deps: { createDriver?: (config: RouterConfig) => RouterDriver } = {}): void {
  const createDriver = deps.createDriver ?? ((config: RouterConfig) => new MikrotikRestDriver(config))

  /** Read `router` KV fresh, build a driver, or explain exactly why there is none — never a driver constructed from half a config. */
  async function loadDriver(): Promise<{ ok: true; driver: RouterDriver } | { ok: false; body: RouterActionRefusal }> {
    const raw = await host.storage.global.getRaw(ROUTER_KEY)
    if (raw === null || raw === undefined) {
      return { ok: false, body: notConfigured('No router connection has been saved yet. Open the Settings tab and save one.') }
    }
    const config = readRouterConfig(raw)
    if (!isRouterConfigured(config)) {
      return { ok: false, body: notConfigured('The saved router connection is missing an address, a username, or a password. Open the Settings tab and save a complete connection.') }
    }
    return { ok: true, driver: createDriver(config) }
  }

  host.onRequest(
    ROUTER_ROUTES.inventory,
    async () => {
      const loaded = await loadDriver()
      if (!loaded.ok) return { body: loaded.body }
      try {
        const inventory = await loaded.driver.inventory()
        return { body: { ok: true, inventory } }
      } catch (err) {
        return { body: toRefusal(err) }
      }
    },
    {
      methods: ['GET'],
      permission: ROUTER_ROUTE_PERMISSIONS.inventory,
      description: 'Every egress path on the router — its routing table, its default route’s gateway, and whether that route is active (§4.5) — read live from the router, never cached.',
    },
  )

  host.onRequest(
    ROUTER_ROUTES.rules,
    async () => {
      const loaded = await loadDriver()
      if (!loaded.ok) return { body: loaded.body }
      try {
        const rules = await loaded.driver.listRules()
        return { body: { ok: true, items: rules.map(toRuleRow) } }
      } catch (err) {
        return { body: toRefusal(err) }
      }
    },
    {
      methods: ['GET'],
      permission: ROUTER_ROUTE_PERMISSIONS.rules,
      description: 'Every policy routing rule on the router, split managed vs. foreign by its comment marker (§4.2) — read live, never filtered or hidden server-side.',
    },
  )

  host.onRequest(
    ROUTER_ROUTES.doctor,
    async () => {
      const loaded = await loadDriver()
      if (!loaded.ok) return { body: loaded.body }
      // `doctor()` never throws (`router-driver.ts`'s own doc comment) — it
      // downgrades every failure into the report itself, so there is no
      // `catch` needed here the way the other two routes have.
      const report = await loaded.driver.doctor()
      return { body: { ok: true, ...report } }
    },
    {
      methods: ['POST'],
      permission: ROUTER_ROUTE_PERMISSIONS.doctor,
      description: 'Reachability, auth, the local-exception rule’s presence (§3.2), and managed/foreign rule counts — a read-only diagnostic, never a write.',
    },
  )
}
