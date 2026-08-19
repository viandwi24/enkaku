import { z } from 'zod'
import { DeviceNetworkStatusResponseSchema, NetworkEngineIdSchema } from '@enkaku/protocol'
import { admitMember } from '../command-console/runner'
import type { LeaseManager } from '../lease/lease-manager'
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
 * ## The lease, and the one thing that is genuinely different here
 *
 * Every network write takes a lease admission check (plan 44 §5.7) — a route
 * change on a phone somebody is actively driving is exactly the change they
 * will not notice. An operator at the device page already holds that lease; a
 * plugin never holds one and never will.
 *
 * So this uses `admitMember` — the command console's own three-branch policy
 * (plan 93 §3.8), imported rather than re-derived, because a second
 * implementation of "may this caller touch this device right now" would drift:
 *
 * | the device is | what happens |
 * |---|---|
 * | already held by this caller | run, hold nothing new, release nothing |
 * | idle | acquire a manual lease, run, release it in `finally` |
 * | held by someone else | refused `not_lease_holder`, naming them |
 * | running a job / offline / quarantined | refused with that verbatim reason |
 *
 * That is plan 114 §3.9's own answer for the bulk path (*"a transient lease per
 * device, serially, released immediately"*) and §9 Q2's ruling (*"skip and
 * name"* — never take over from a person), applied to the one-device case.
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
 * with this caller's lease admission and principal already bound in.
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
  leases: LeaseManager
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
   * Take the device for the length of one write, or refuse naming who has it.
   *
   * `userId` is the actor's own id for a person and `null` for a plugin: a
   * `plugin:<name>` principal is not a row in `users`, and writing one into
   * `lease.holderUserId` would make "who is holding this device" resolve to a
   * user that does not exist. The `clientId` carries the full principal either
   * way, so the hold is still attributable.
   */
  async function withDevice<T>(deviceId: string, fn: () => Promise<T>, opts: { disarm?: boolean } = {}): Promise<T> {
    const clientId = principal()
    const userId = pluginNameFromPrincipal(clientId) === null ? clientId : null
    const admitted = admitMember(deps.leases, deviceId, clientId, userId)
    /**
     * **The disarm direction, and the one code it lets through** — the same
     * widening `requireDisarmAdmission` (`network/route-service.ts`) applies to
     * `DELETE /api/devices/:id/network`, applied here so the capability and the
     * HTTP endpoint agree about when a route may be turned OFF.
     *
     * That file carries the whole argument and it is not restated. The short
     * form: a lease on an `offline` or `quarantined` device is not merely
     * unheld, it is UNOBTAINABLE, so `device_unavailable` on the off switch does
     * not mean "take control first", it means "you may never turn this off" —
     * and offline is the case where turning a route off matters most. The
     * machinery for a teardown that cannot reach the phone already exists and
     * predates this: `revertNetwork` records the debt as `pendingClear` and the
     * device's next admission settles it, with a real teardown. The gate was
     * refusing the request before the machinery built for it could run.
     *
     * `device_busy` and `not_lease_holder` are still refused, unchanged. A job
     * driving the phone right now, or a person holding it, is a collision and
     * not a disarm.
     *
     * **This narrows nothing that was previously wide, and widens nothing but
     * `clear`.** `set` still takes a full admission — applying a route to a
     * phone you cannot reach is a promise you cannot keep. The route-service
     * comment that used to read *"the plugin path into this function is NOT
     * widened by this"* was true when written and is superseded here; the
     * reason it is superseded is Reset data, where a plugin's stored assignments
     * are the only record of which phones carry its routes, and the phones that
     * most need un-routing are exactly the ones that are away.
     */
    if (!admitted.ok && !(opts.disarm === true && admitted.code === 'device_unavailable')) {
      throw new EnkakuError(admitted.code, admitted.message)
    }
    try {
      return await fn()
    } finally {
      if (admitted.ok && admitted.acquiredHere) deps.leases.releaseManual(deviceId, clientId)
    }
  }

  return {
    // A read takes no lease: `GET /api/devices/:id/network` does not either, and
    // reading what a phone is set to must work while somebody else is driving it.
    get: (deviceId) => deps.port.get(deviceId),
    set: (deviceId, route) => withDevice(deviceId, () => deps.port.set(deviceId, route, principal())),
    clear: (deviceId) => withDevice(deviceId, () => deps.port.clear(deviceId, principal()), { disarm: true }),
  }
}

/** `null` in orchestrator mode, where there is no local device to have a route at all. */
function mustNetwork(network: DeviceNetworkCapabilityService | undefined): DeviceNetworkCapabilityService {
  if (!network) throw new EnkakuError('E_NOT_SUPPORTED', 'device networking is not available on this host (orchestrator mode)')
  return network
}

/**
 * `lease: 'none'` on all three, and it is not a loophole.
 *
 * `invoke`'s own lease step refuses unless the CALLER already holds the manual
 * lease — which a plugin never does, so declaring `'control'` here would make
 * this capability permanently unreachable by the only caller it exists for.
 * The admission is not skipped; it moves into the handler, where `admitMember`
 * can take a transient hold and give it back, and where the refusals name the
 * real reason (`device_busy`, `device_unavailable`, `not_lease_holder`) instead
 * of `invoke`'s generic `E_NEEDS_LEASE`. This is the same reasoning
 * `device.wake`/`.sleep` already record for `readiness.set`.
 *
 * It also means `invoke` runs no readiness check, which is correct rather than
 * convenient: a route is a property of the DEVICE and survives it being offline
 * (plan 114 F14), so a config saved against a phone that is away applies when it
 * returns. `admitMember` still reports an unreachable device as
 * `device_unavailable`.
 */
export const deviceNetworkGet = defineCapability({
  id: 'device.network.get',
  input: DeviceOnlyInput,
  output: DeviceNetworkStatusResponseSchema,
  permission: 'device.network',
  lease: 'none',
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
  lease: 'none',
  // A `vpn-helper` apply walks an install/grant/bootstrap/forward/handshake/start
  // chain and settles against the device; an advisory write is sub-second. The
  // budget is the slow one, because refusing the slow case would make VPN mode
  // unreachable from a plugin while looking like a timeout.
  deadline: 120_000,
  effect: 'write',
  description:
    "Apply a network route to a device, through the same door PUT /api/devices/:id/network uses — same lease admission, same credential refusal, same one-route-per-device lock. The route is recorded as set by this plugin, and the device's Network panel says so. Refused, naming the holder, while someone else is controlling the device.",
  handler: (ctx, { deviceId, route }) => mustNetwork(ctx.network).set(deviceId, route) as Promise<z.infer<typeof DeviceNetworkStatusResponseSchema>>,
})

export const deviceNetworkClear = defineCapability({
  id: 'device.network.clear',
  input: DeviceOnlyInput,
  output: DeviceNetworkStatusResponseSchema,
  permission: 'device.network',
  lease: 'none',
  deadline: 120_000,
  effect: 'write',
  description:
    "Turn a device's network route off and forget it, restoring the proxy settings the farm found on the phone before it ever wrote one. Idempotent: a device with no route is left alone rather than reported as an error. Allowed for an offline or quarantined device — the same disarm-direction rule DELETE /api/devices/:id/network follows — in which case the teardown is recorded against the device as owed and settled the next time it is admitted, and the answer says so rather than claiming an off that did not happen.",
  handler: (ctx, { deviceId }) => mustNetwork(ctx.network).clear(deviceId) as Promise<z.infer<typeof DeviceNetworkStatusResponseSchema>>,
})

export const DEVICE_NETWORK_CAPABILITIES = [deviceNetworkGet, deviceNetworkSet, deviceNetworkClear]
