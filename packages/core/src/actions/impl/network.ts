import type { DeviceNetworkStatusResponse } from '@enkaku/protocol'
import { NetworkRouteConfigSchema, tagUntaggedRouteConfig } from '@enkaku/protocol'
import { assertNoHttpProxyAuth } from '../../network/route-service'
import { EnkakuError } from '../../util/errors'

export interface NetworkActionsDoor {
  set: (deviceId: string, raw: unknown, actor: string | null, opts?: { admission?: 'checked' | 'precleared' }) => Promise<DeviceNetworkStatusResponse>
  clear: (deviceId: string, actor: string | null) => Promise<DeviceNetworkStatusResponse>
  enable: (deviceId: string, actor: string | null) => Promise<DeviceNetworkStatusResponse>
  disable: (deviceId: string, actor: string | null) => Promise<DeviceNetworkStatusResponse>
  retry: (deviceId: string, actor: string | null) => Promise<DeviceNetworkStatusResponse>
}

/**
 * `set-network` (plan 207 §4.2) — `op: 'set'` validates the route once for
 * the whole request (a malformed route or a credential is a bad request,
 * not one failure per device), exactly as `route-service.ts`'s bulk apply
 * used to. The per-device call is always `'checked'` admission: the router
 * evaluated `network-apply` itself before dispatch (plan 205), so this is
 * NOT `'precleared'` the way the deleted bulk endpoint's online branch was.
 */
export function validateNetworkRoute(raw: unknown): void {
  const parsed = NetworkRouteConfigSchema.safeParse(tagUntaggedRouteConfig(raw))
  if (!parsed.success) {
    throw new EnkakuError('E_BAD_REQUEST', parsed.error.issues.map((i) => `route.${i.path.join('.')}: ${i.message}`).join('; '))
  }
  assertNoHttpProxyAuth(raw, parsed.data.engine)
}

export async function applyNetworkAction(
  door: NetworkActionsDoor,
  deviceId: string,
  op: 'set' | 'enable' | 'disable' | 'retry' | 'clear',
  actor: string | null,
  route?: unknown,
): Promise<DeviceNetworkStatusResponse> {
  if (op === 'set') return door.set(deviceId, route, actor)
  return door[op](deviceId, actor)
}
