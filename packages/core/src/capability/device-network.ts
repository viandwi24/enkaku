import { z } from 'zod'
import { DeviceNetworkStatusResponseSchema, E_DEVICE_CONFLICT, NetworkEngineIdSchema } from '@enkaku/protocol'
import type { ActivityRegistry } from '../activity/registry'
import { evaluate, type ControlPolicySettings } from '../activity/policy'
import type { DeviceNetworkPort } from '../network/route-service'
import { pluginNameFromPrincipal } from '../plugins/principal'
import { EnkakuError } from '../util/errors'
import type { CapabilityActor } from './context'
import { defineCapability } from './types'

/**
 * `device.network.get`, `.set`, `.clear` (plan 114 §3.3, step 114.9) — **the
 * plugin boundary, and the only way anything other than an HTTP request
 * reaches a device's route.**
 *
 * ## Why this exists at all
 *
 * The owner's model is that the built-in owns the mechanism and the plugin
 * owns management at scale: *"proxy manager plugin nantinya itu meng extend
 * proxy bawaan ini, jadi proxy manager bisa override setting network proxy
 * bawaan."* Overriding what the built-in set is allowed. Writing a device
 * setting directly is not — that would be a second door with a different set of
 * checks behind it, which is how two subsystems end up disagreeing about what a
 * phone is doing.
 *
 * So a plugin sets a route the way plan 109 §4.3 already makes every other
 * privileged plugin action work:
 *
 * ```
 *   ctx.farm.call('device.network.set', { deviceId, route })
 *     │
 *     ├─ is it in the plugin's MANIFEST?  ── no ─→ E_FARM_UNDECLARED, audited, never invoked
 *     ├─ invoke(): the real ACL under `plugin:<name>` — `device.network`
 *     └─ handler → DeviceNetworkPort.set  ── which IS the body of
 *                                            `PUT /api/devices/:id/network`
 * ```
 *
 * The refusal-before-invocation half is the property this buys: a plugin that
 * did not declare `device.network.set` cannot change a phone's networking and
 * then be told it was refused, and every accepted call leaves a
 * `capability.invoke` row under the `plugin:<name>` principal. "What has this
 * plugin done to my farm" stays one query.
 *
 * ## The activity policy, and the one thing that is genuinely different here
 *
 * Every network write is evaluated against the device activity policy (plan
 * 44 §5.7, reworked by plan 205 §4.4, §5 step 205.8) — a route change on a
 * phone somebody is actively driving is exactly the change they will not
 * notice. The policy's `network-apply` row is what decides this, the SAME
 * table `route-service.ts`'s own admission and the bulk apply consult,
 * because a second implementation of "may this caller touch this device
 * right now" would drift.
 *
 * A `forbid` decision refuses naming the conflicting activity; anything else
 * runs, wrapped in a `network-apply:<uuid>` marker for the length of the
 * call, so the device's Network panel and any other viewer see the write in
 * progress the same way a job or an install already show.
 *
 * ## What it does NOT do
 *
 * It does not resolve the conflict between an operator and a plugin that both
 * set the same device at different times. That is deliberate and is plan 114
 * §3.3's ruling: **last-write-wins with attribution, never a lock.** A lock
 * between a person and a plugin produces a device nobody can fix. What makes
 * the outcome legible instead is `setBy`, stamped by the door from the
 * principal this capability runs under and rendered in the device's Network
 * panel — "set by proxy-manager, 4 minutes ago" is a fact an operator can act
 * on; a silent last-write-wins is not.
 */

/** The route body, kept LOOSE on purpose — see `RouteSetInput`. */
const RouteBodySchema = z.looseObject({
  /**
   * Optional only so an untagged body still reaches the door, which tags it as
   * `vpn-helper` by construction (`tagUntaggedRouteConfig`) exactly as it does
   * for a pre-plan-114 row on disk. Making it required here would be a second,
   * stricter validator sitting in front of the one that already decides.
   */
  engine: NetworkEngineIdSchema.optional(),
})

const RouteSetInput = z.object({
  deviceId: z.string(),
  /**
   * **Loose, and it has to be.** `NetworkRouteConfigSchema` strips unknown keys,
   * and one of the keys it would strip is `password` — which is precisely the
   * key `assertNoHttpProxyAuth` (plan 114 §3.8) exists to refuse by name on the
   * HTTP rungs. Parsing the union here would silently delete the credential and
   * then apply a route that looks clean, turning a coded refusal into a quiet
   * data loss. The door parses the union itself, against the raw body, in the
   * order it needs to.
   */
  route: RouteBodySchema.describe('A network route config: { engine: "adb-proxy" | "adb-reverse-proxy" | "vpn-helper", ... }. See GET /api/devices/:id/network for the exact shape per engine.'),
})

const DeviceOnlyInput = z.object({ deviceId: z.string() })

/**
 * The capability-facing half of `DeviceNetworkPort`: the same three operations,
 * with this caller's activity admission and principal already bound in.
 *
 * Built per invocation by `createCapabilityContext`, like every other service
 * accessor on the context.
 */
export interface DeviceNetworkCapabilityService {
  get(deviceId: string): Promise<unknown>
  set(deviceId: string, route: unknown): Promise<unknown>
  clear(deviceId: string): Promise<unknown>
}

export interface DeviceNetworkServiceDeps {
  port: DeviceNetworkPort
  activities: Pick<ActivityRegistry, 'list' | 'start' | 'end'>
  controlSettings: () => ControlPolicySettings
}

export function createDeviceNetworkService(deps: DeviceNetworkServiceDeps, actor: CapabilityActor | null): DeviceNetworkCapabilityService {
  /**
   * The principal every write is attributed to. `null` would mean "the core
   * acting on its own", which stamps NO `setBy` at all (a reconnect re-apply
   * must not claim somebody touched the device) — so an actor-less caller is
   * refused here rather than quietly writing an unattributed route.
   */
  const principal = (): string => {
    if (!actor) throw new EnkakuError('E_FORBIDDEN', 'a network route can only be set by a named actor — this call has none')
    return actor.id
  }

  /**
   * Evaluate the `network-apply` row of the activity policy, refuse on
   * `forbid`, and wrap `fn()` in a `network-apply:<uuid>` marker for the
   * length of the write (plan 205 §4.4, §5 step 205.8) — visible to any
   * other viewer of the device exactly the way a job or an install already
   * are. The plugin name (`plugin:<name>`), when this is a plugin principal,
   * is what the marker's actor names; a person's own id otherwise.
   */
  async function withDevice<T>(deviceId: string, fn: () => Promise<T>): Promise<T> {
    const clientId = principal()
    const pluginName = pluginNameFromPrincipal(clientId)
    const decision = evaluate('network-apply', deps.activities.list(deviceId), deps.controlSettings())
    if (decision.decision === 'forbid') throw new EnkakuError(E_DEVICE_CONFLICT, decision.message)
    const id = `network-apply:${crypto.randomUUID()}`
    deps.activities.start(deviceId, {
      id,
      kind: 'network-apply',
      label: 'Applying network route',
      actor: pluginName ? { kind: 'plugin', id: clientId, label: pluginName } : { kind: 'user', id: clientId, label: clientId },
    })
    try {
      return await fn()
    } finally {
      deps.activities.end(deviceId, id)
    }
  }

  return {
    // A read takes no activity: `GET /api/devices/:id/network` does not either, and
    // reading what a phone is set to must work while somebody else is driving it.
    get: (deviceId) => deps.port.get(deviceId),
    set: (deviceId, route) => withDevice(deviceId, () => deps.port.set(deviceId, route, principal())),
    clear: (deviceId) => withDevice(deviceId, () => deps.port.clear(deviceId, principal())),
  }
}

/** `null` in orchestrator mode, where there is no local device to have a route at all. */
function mustNetwork(network: DeviceNetworkCapabilityService | undefined): DeviceNetworkCapabilityService {
  if (!network) throw new EnkakuError('E_NOT_SUPPORTED', 'device networking is not available on this host (orchestrator mode)')
  return network
}

/**
 * No `activity` field on any of the three, deliberately — not an oversight.
 *
 * `invoke`'s own activity-policy step refuses a capability that declares one
 * unless the DEVICE is online, which a route must not require: a route is a
 * property of the DEVICE and survives it being offline (plan 114 F14), so a
 * config saved against a phone that is away applies when it returns, and a
 * `clear` against an unreachable phone must still be accepted (the same
 * disarm-direction rule `DELETE /api/devices/:id/network` follows). The
 * admission is not skipped; it moves into `withDevice` above, which
 * evaluates the SAME `network-apply` policy row `invoke` would have, without
 * `invoke`'s blanket online requirement, and wraps the write in its own
 * marker for as long as it runs.
 */
export const deviceNetworkGet = defineCapability({
  id: 'device.network.get',
  input: DeviceOnlyInput,
  output: DeviceNetworkStatusResponseSchema,
  permission: 'device.network',
  deadline: 15_000,
  effect: 'read',
  description: "Read a device's network route: which engine is applied, what was declared, the named checks behind its health, and who set it.",
  handler: (ctx, { deviceId }) => mustNetwork(ctx.network).get(deviceId) as Promise<z.infer<typeof DeviceNetworkStatusResponseSchema>>,
})

export const deviceNetworkSet = defineCapability({
  id: 'device.network.set',
  input: RouteSetInput,
  output: DeviceNetworkStatusResponseSchema,
  permission: 'device.network',
  // A `vpn-helper` apply walks an install/grant/bootstrap/forward/handshake/start
  // chain and settles against the device; an advisory write is sub-second. The
  // budget is the slow one, because refusing the slow case would make VPN mode
  // unreachable from a plugin while looking like a timeout.
  deadline: 120_000,
  effect: 'write',
  description:
    "Apply a network route to a device, through the same door PUT /api/devices/:id/network uses — same activity admission, same credential refusal, same one-route-per-device lock. The route is recorded as set by this plugin, and the device's Network panel says so. Refused, naming the conflicting activity, while someone else is controlling the device.",
  handler: (ctx, { deviceId, route }) => mustNetwork(ctx.network).set(deviceId, route) as Promise<z.infer<typeof DeviceNetworkStatusResponseSchema>>,
})

export const deviceNetworkClear = defineCapability({
  id: 'device.network.clear',
  input: DeviceOnlyInput,
  output: DeviceNetworkStatusResponseSchema,
  permission: 'device.network',
  deadline: 120_000,
  effect: 'write',
  description:
    "Turn a device's network route off and forget it, restoring the proxy settings the farm found on the phone before it ever wrote one. Idempotent: a device with no route is left alone rather than reported as an error. Allowed for an offline or quarantined device — the same disarm-direction rule DELETE /api/devices/:id/network follows — in which case the teardown is recorded against the device as owed and settled the next time it is admitted, and the answer says so rather than claiming an off that did not happen.",
  handler: (ctx, { deviceId }) => mustNetwork(ctx.network).clear(deviceId) as Promise<z.infer<typeof DeviceNetworkStatusResponseSchema>>,
})

export const DEVICE_NETWORK_CAPABILITIES = [deviceNetworkGet, deviceNetworkSet, deviceNetworkClear]
