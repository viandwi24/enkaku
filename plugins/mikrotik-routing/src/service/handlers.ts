import type { PluginRequest, PluginResponse } from '@enkaku/sdk'
import { DeviceInfoSchema } from '@enkaku/protocol'
import { z } from 'zod'
import { LOCAL_EXCEPTION_COMMENT, deviceNameWithNumber, type RouterConfig } from '../shared'
import { deriveCoreAddress, type CoreAddressResult } from './core-address'
import { messageOf, MikrotikRestError } from './errors'
import { buildIdentityBridge } from './identity-bridge'
import { classifyLocalException, type LocalExceptionReport, type ProtectedDevice } from './local-exception'
import { parseMarker } from './marker'
import { loadRouterConfig } from './router-config'
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

/**
 * The narrow slice of `PluginServiceContext` this file needs — so a test
 * supplies a fake `getRaw`/`onRequest`/`farm.call` rather than a whole
 * runtime, the same trade `proxy-manager`'s own `HandlerHost`/`ApplyHost`
 * makes. `farm` was added in step 122.12: the corrected local-exception
 * check is per-DEVICE (§5 step 122.12 fix 1), and `device.list` is the only
 * way this file learns a device exists — the manifest has declared it since
 * step 122.3, unused until now.
 */
export interface HandlerHost {
  storage: { global: { getRaw(key: string): Promise<unknown> } }
  farm: { call<T>(id: string, input: unknown, schema: z.ZodType<T>): Promise<T> }
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
export const ROUTER_ROUTES = { inventory: 'inventory', rules: 'rules', doctor: 'doctor', probeEgress: 'probe-egress' } as const

export const ROUTER_ROUTE_PERMISSIONS: Record<keyof typeof ROUTER_ROUTES, string> = {
  inventory: 'script.view',
  rules: 'script.view',
  doctor: 'script.view',
  /**
   * Plan 134 (M99) §4.4. `script.view`, like the other three, and the split is
   * worth stating: this route SENDS something (three ICMP packets out of one
   * uplink) but CHANGES nothing — no router record is written, no device is
   * touched, and re-running it leaves the farm exactly as it found it. The
   * `plugin.runtime` split above earns its keep for `apply`, which alters what
   * the router does; a read that costs three packets is still a read.
   */
  probeEgress: 'script.view',
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

/** `device.list`'s own output shape (`packages/core/src/capability/device-state.ts`'s `ListOutput`) — the full `DeviceInfoSchema`, not a loose subset, because `identity-bridge.ts`'s `buildIdentityBridge` takes real `DeviceInfo` values. */
const DeviceListSchema = z.object({ items: z.array(DeviceInfoSchema) })

/** Plan 134 (M99) §4.4 — a probe's input. `target` is optional; the driver's own `DEFAULT_PROBE_TARGET` is the single place that default lives. */
const ProbeEgressInputSchema = z.object({ wanInterface: z.string().min(1), target: z.string().min(1).optional() })

/**
 * Register the three routes on a live service context.
 *
 * `deps.createDriver` is injectable — tests supply a fake `RouterDriver` so
 * they never open a socket, the same seam `router-driver.test.ts` already
 * exercises the real `MikrotikRestDriver` through. Defaults to the real
 * driver, constructed fresh per request from whatever `router` KV currently
 * holds — no cached instance, no module-scope state, so a Settings save
 * takes effect on the very next read with nothing to invalidate.
 *
 * `deps.deriveCoreAddress` (step 122.12) is the same trade for the raw TCP
 * probe `core-address.ts` opens — a test supplies a fixed `CoreAddressResult`
 * rather than opening a socket, mirroring `createDriver`'s own reasoning.
 */
export function registerRouterRoutes(
  host: HandlerHost,
  deps: { createDriver?: (config: RouterConfig) => RouterDriver; deriveCoreAddress?: (config: { baseUrl: string; tls: boolean }) => Promise<CoreAddressResult> } = {},
): void {
  const createDriver = deps.createDriver ?? ((config: RouterConfig) => new MikrotikRestDriver(config))
  const resolveCoreAddress = deps.deriveCoreAddress ?? deriveCoreAddress

  /**
   * Read `router` KV fresh, build a driver, or explain exactly why there is
   * none — never a driver constructed from half a config. `loadRouterConfig`
   * (`router-config.ts`, factored out at step 122.6) is the single source of
   * both refusal messages, shared with the write path (`apply.ts`).
   */
  async function loadDriver(): Promise<{ ok: true; driver: RouterDriver; config: RouterConfig } | { ok: false; body: RouterActionRefusal }> {
    const loaded = await loadRouterConfig((key) => host.storage.global.getRaw(key))
    if (!loaded.ok) return { ok: false, body: notConfigured(loaded.message) }
    return { ok: true, driver: createDriver(loaded.config), config: loaded.config }
  }

  /**
   * The devices this plugin can currently check local-exception coverage
   * for (§5 step 122.12 fix 1) — `device.list` joined through the identity
   * bridge (`identity-bridge.ts`, §3.4), narrowed to `state: 'resolved'`
   * only: a device with no derivable address has no `src-address` to test
   * coverage against, and is never silently treated as covered OR uncovered.
   * Leases are passed as `[]` deliberately — this check only needs an
   * address, not lease-kind classification, and skipping `inventory()` saves
   * a full extra round trip to the router on every doctor run.
   *
   * Never throws: a `device.list` failure (permission not granted, farm
   * unavailable) degrades to an empty device list plus an entry in the
   * returned `errors`, the same "downgrade, do not throw" discipline
   * `MikrotikRestDriver.doctor()` itself follows.
   */
  async function knownDeviceAddresses(): Promise<{ devices: ProtectedDevice[]; errors: string[] }> {
    try {
      const result = await host.farm.call('device.list', {}, DeviceListSchema)
      const bridge = buildIdentityBridge(result.items, [])
      /**
       * The number, keyed by device id (plan 124 §4.4 Group G). The bridge's
       * `DeviceLanAddress` carries only `deviceId`/`stableId`/`label` — it is
       * an addressing record, not a naming one, and widening it would push a
       * presentation concern into `identity-bridge.ts`. The `DeviceInfo` list
       * that produced the bridge is still in hand one line above, so the
       * number is looked up from there instead.
       */
      const numbers = new Map(result.items.map((d) => [d.id, d.number]))
      const devices = bridge
        .filter((d) => d.state === 'resolved')
        // Same composition as `apply.ts`'s `protectedDevicesFrom`, and it has
        // to be: both feed `local-exception.ts`'s `describeUncovered`, whose
        // own comment records the owner's farm printing "SM-F721U1,
        // SM-F721U1, SM-F721U1" into this exact sentence. The address stays —
        // it is what a candidate rule's `src-address` must cover — and the
        // number is what tells the operator which phone that is.
        .map((d) => ({ id: d.deviceId, label: deviceNameWithNumber(numbers.get(d.deviceId) ?? null, d.label), address: d.lanIp }))
      return { devices, errors: [] }
    } catch (err) {
      return { devices: [], errors: [`could not read the device list to check local-exception coverage: ${messageOf(err)}`] }
    }
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

  /**
   * Plan 134 (M99) §4.4 — the only check in this plugin that can tell "the
   * modem answers the router" from "the modem has working internet".
   *
   * Operator-triggered, never scheduled (§2): every probe is metered LTE data
   * on somebody's SIM, and a farm of forty modems probing itself on a timer is
   * a bill nobody agreed to. The screen has a button; nothing else calls this.
   *
   * The interface, not the path, is the parameter. The router itself resolved
   * gateway → interface in `inventory()`'s `immediate-gw` (`router-driver.ts`),
   * and on this farm two ports genuinely shared a subnet, so re-deriving it
   * here from a path id would risk probing the wrong modem at exactly the
   * moment it mattered.
   */
  host.onRequest(
    ROUTER_ROUTES.probeEgress,
    async (request) => {
      const parsed = ProbeEgressInputSchema.safeParse(request.body)
      if (!parsed.success) {
        return { body: { ok: false, code: 'E_BAD_INPUT', message: 'a probe needs the uplink interface to send from' } satisfies RouterActionRefusal }
      }
      const loaded = await loadDriver()
      if (!loaded.ok) return { body: loaded.body }
      // `probeEgress` never throws by contract — it answers `unknown` for
      // anything it could not run. The try/catch is for a driver that breaks
      // that contract, and it degrades the same way rather than 500ing.
      try {
        const result = await loaded.driver.probeEgress(parsed.data.wanInterface, parsed.data.target)
        return { body: { ok: true, probe: result } }
      } catch (err) {
        return { body: toRefusal(err) }
      }
    },
    {
      methods: ['POST'],
      permission: ROUTER_ROUTE_PERMISSIONS.probeEgress,
      description:
        'Sends three ICMP packets out of one uplink and reports what came back — the difference between “the modem answers” and “the modem has internet”. Costs metered data, so it runs only when an operator asks. Never reports a path as failed when the probe itself could not run.',
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

      // Step 122.12: the local-exception check moved OUT of `doctor()` (it
      // needs `device.list`, which the driver has no access to) and is
      // composed here instead, reusing the rules `doctor()` already fetched
      // rather than a second `listRules()` round trip.
      const [{ devices, errors: deviceErrors }, coreAddress] = await Promise.all([knownDeviceAddresses(), resolveCoreAddress({ baseUrl: loaded.config.baseUrl, tls: loaded.config.tls })])
      const localException: LocalExceptionReport = classifyLocalException(report.rules, devices, coreAddress)

      return {
        body: {
          ok: true,
          reachable: report.reachable,
          authenticated: report.authenticated,
          restVersion: report.restVersion,
          managedRuleCount: report.managedRuleCount,
          foreignRuleCount: report.foreignRuleCount,
          errors: [...report.errors, ...deviceErrors],
          localException,
        },
      }
    },
    {
      methods: ['POST'],
      permission: ROUTER_ROUTE_PERMISSIONS.doctor,
      description: 'Reachability, auth, the local-exception check (§3.2, behaviour-based and per-device since step 122.12), and managed/foreign rule counts — a read-only diagnostic, never a write.',
    },
  )
}
