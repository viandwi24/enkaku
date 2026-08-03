import type { DeviceInfo } from '@enkaku/protocol'
import { coreBase } from './ws'

interface ItemsPage<T> {
  items: T[]
  nextCursor: string | null
}

/**
 * Every row of a paginated list endpoint, across as many pages as it takes
 * (plan 30 §4.2 — every list paginates now). For the handful of callers that
 * genuinely want the whole thing at once — a picker dropdown, an id → label
 * lookup — rather than a "load more" table. Walks the cursor internally so
 * no call site re-invents that loop, capped generously so a runaway server
 * response can never hang the tab.
 */
export async function fetchAllPages<T>(path: string, extraQuery?: Record<string, string>): Promise<T[]> {
  const all: T[] = []
  let cursor: string | null = null
  for (let page = 0; page < 25; page++) {
    const qs = new URLSearchParams({ limit: '200', ...extraQuery, ...(cursor ? { cursor } : {}) })
    const res = await fetch(`${coreBase()}${path}?${qs.toString()}`)
    if (!res.ok) throw new Error(`GET ${path} → ${res.status}`)
    const body = (await res.json()) as ItemsPage<T>
    all.push(...body.items)
    if (!body.nextCursor) break
    cursor = body.nextCursor
  }
  return all
}

export async function fetchDevices(): Promise<DeviceInfo[]> {
  return fetchAllPages<DeviceInfo>('/api/devices')
}

/**
 * A device reference resolved for rendering (plan 47 §3.4, §4.5): a job,
 * batch member, or event log keeps a plain `deviceId` after the device it
 * points at is forgotten — `deleted: true` is what turns that into
 * "deleted device (<stableId>)" instead of a blank id.
 */
export interface DeviceRef {
  id: string
  label: string | null
  stableId: string
  deleted: boolean
}

/**
 * Resolve a batch of device ids in one call — live devices AND forgotten
 * ones (from `deletedDevices`), whichever each id turns out to be. An id
 * neither table has is simply absent from the returned map; callers fall
 * back to the raw id in that (should not happen in practice) case.
 */
export async function fetchDeviceRefs(ids: string[]): Promise<Record<string, DeviceRef>> {
  const unique = [...new Set(ids)].filter(Boolean)
  if (unique.length === 0) return {}
  const res = await fetch(`${coreBase()}/api/devices/refs?ids=${encodeURIComponent(unique.join(','))}`)
  if (!res.ok) throw new Error(`GET /api/devices/refs → ${res.status}`)
  const body = (await res.json()) as { refs: Record<string, DeviceRef> }
  return body.refs
}

/** The label a UI should show for a device reference — the one place this formatting rule lives (plan 47 §3.4). */
export function deviceRefLabel(ref: DeviceRef | undefined, fallbackId: string): string {
  if (!ref) return fallbackId.slice(0, 8)
  if (ref.deleted) return `deleted device (${ref.stableId})`
  return ref.label ?? ref.stableId
}

export interface HealthResponse {
  ok: boolean
  version: string
  adb: { state: string; serverVersion: string | null }
  deviceCount: number
  uptimeMs: number
}

export async function fetchHealth(): Promise<HealthResponse> {
  const res = await fetch(`${coreBase()}/api/health`)
  return (await res.json()) as HealthResponse
}

/** One section of the fleet map (plan 32 §4.1) — a device may appear in several. */
export interface TopologyCluster {
  id: string
  name: string
  deviceIds: string[]
}

/** The currently running job on one device (plan 32 §4.1) — one at a time, the per-device queue guarantees it. */
export interface TopologyActiveJob {
  deviceId: string
  jobId: string
  scriptName: string | null
  startedAt: number | null
}

export interface TopologyResponse {
  clusters: TopologyCluster[]
  devices: DeviceInfo[]
  ungroupedDeviceIds: string[]
  activeJobs: TopologyActiveJob[]
}

/**
 * The whole farm in one call (plan 32 §4.1) — deliberately not paginated: a
 * map needs the whole farm at once or it stops being a map.
 */
export async function fetchTopology(): Promise<TopologyResponse> {
  const res = await fetch(`${coreBase()}/api/topology`)
  if (!res.ok) throw new Error(`GET /api/topology → ${res.status}`)
  return (await res.json()) as TopologyResponse
}

// ---- Guest agent (plan 44 §4.6, §5.8) ----

/**
 * The on-device guest agent's install/reachability state, from
 * `GET /api/devices/:id/guest-agent`.
 *
 * `installed` and `ready` are kept as distinct states on purpose, the same
 * reason `declared` and `observed` stay distinct on the network side (plan
 * 44 §4.6): a package being present on the device says nothing about
 * whether its control socket actually answers, and collapsing the two would
 * report a broken device as healthy.
 */
export type GuestAgentState = 'not-installed' | 'installed' | 'ready' | 'unreachable' | 'unsupported'

export interface GuestAgentStatus {
  state: GuestAgentState
  appVersion?: string
  androidSdkInt?: number
  capabilities?: string[]
  /** Why the device cannot run the agent at all — only meaningful when `state` is `unsupported`. */
  reason?: string
}

export async function fetchGuestAgentStatus(deviceId: string): Promise<GuestAgentStatus> {
  const res = await fetch(`${coreBase()}/api/devices/${encodeURIComponent(deviceId)}/guest-agent`)
  if (!res.ok) throw new Error(`GET /api/devices/${deviceId}/guest-agent → ${res.status}`)
  return (await res.json()) as GuestAgentStatus
}

// ---- Network route (plan 44 §4.6, §5.8) ----

export type NetworkEngineId = 'none' | 'vpn-helper'
export type NetworkUdpMode = 'udp' | 'tcp'
export type NetworkHealth = 'ok' | 'unverified' | 'degraded' | 'unknown'

/** What was saved. Never carries a password — the API never returns one (plan 44 §4.5, acceptance criterion 8). */
export interface NetworkConfig {
  host: string
  port: number
  username?: string
  udpMode: NetworkUdpMode
}

/** What the device itself reported back, from its own `route.status` — not what was asked for. */
export interface NetworkObserved {
  up: boolean
  upstream?: string
  stats?: number[]
}

export interface NetworkStatus {
  engine: NetworkEngineId
  config: NetworkConfig | null
  /**
   * Whether the route is switched on. Independent of `config` — a route can
   * be saved (`config !== null`) and switched off (`enabled: false`) without
   * losing the credentials, which is the whole point of persisting them
   * separately from the on/off state.
   */
  enabled: boolean
  observed: NetworkObserved | null
  /** True when the saved config and the device's own observation disagree — the whole point of keeping both. */
  drift: boolean
  health: NetworkHealth
  lastError: { code: string; message: string } | null
}

export async function fetchNetworkStatus(deviceId: string): Promise<NetworkStatus> {
  const res = await fetch(`${coreBase()}/api/devices/${encodeURIComponent(deviceId)}/network`)
  if (!res.ok) throw new Error(`GET /api/devices/${deviceId}/network → ${res.status}`)
  return (await res.json()) as NetworkStatus
}

async function postNetworkAction(deviceId: string, action: 'enable' | 'disable'): Promise<NetworkStatus> {
  const res = await fetch(`${coreBase()}/api/devices/${encodeURIComponent(deviceId)}/network/${action}`, {
    method: 'POST',
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: { code: string; message?: string } } | null
    // The `enable` route 409s with `E_NO_ROUTE_CONFIG` and no `message` when
    // there is nothing saved to turn on — the UI already disables the
    // toggle for that case, so this is a backstop, not the primary guard.
    throw Object.assign(
      new Error(body?.error?.message ?? `POST /api/devices/${deviceId}/network/${action} → ${res.status}`),
      { code: body?.error?.code },
    )
  }
  return (await res.json()) as NetworkStatus
}

/** Switch an already-saved route on, without retyping credentials. 409s with `E_NO_ROUTE_CONFIG` when nothing is saved. */
export function enableNetworkRoute(deviceId: string): Promise<NetworkStatus> {
  return postNetworkAction(deviceId, 'enable')
}

/** Switch a route off. The saved config is kept — distinct from removing it entirely. */
export function disableNetworkRoute(deviceId: string): Promise<NetworkStatus> {
  return postNetworkAction(deviceId, 'disable')
}
