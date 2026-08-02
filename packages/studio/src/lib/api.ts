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
