import { Hono } from 'hono'
import { eq, inArray } from 'drizzle-orm'
import type { ConnectionMedium, DeviceInfo, DeviceReadiness, LeaseHolder } from '@enkaku/protocol'
import type { Db } from '../db'
import type { DeviceRow } from '../db/schema'
import { clusters, jobs, scripts } from '../db/schema'
import { resolveCluster } from '../clusters/resolve'
import { listDevicesWithTags, type FarmNetwork } from '../registry/device-registry'

export interface TopologyCluster {
  id: string
  name: string
  deviceIds: string[]
}

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
 * Everything the fleet map needs, joined server-side in one call (plan 32
 * §4.1) — the join needs cluster resolution, which is server-side logic, and
 * the whole point is one request instead of the client stitching four.
 * Deliberately NOT paginated (plan 30 §4.1 note carried into plan 32): a map
 * needs the whole farm at once or it is not a map.
 */
export function buildTopology(
  db: Db,
  /** Readiness badge (plan 43 §4.6) — the same live accessor `/api/devices` uses; omitted call sites fall back per-row. */
  readinessOf?: (deviceId: string, row: DeviceRow) => DeviceReadiness,
  /** Lease holder (plan 71 §4.4) — the same live accessor `/api/devices` uses; omitted call sites fall back to `null`. */
  heldByOf?: (deviceId: string) => LeaseHolder | null,
  /**
   * Farm networks (plan 88 §3.6, §4.1, §5 step 88.5) — the same live
   * accessor `/api/devices` uses; omitted call sites match no network,
   * exactly as before this parameter existed. Without this the topology map
   * would badge every TCP device `TCP`, never `OTG`/`WI-FI`, disagreeing
   * with the fleet list right next to it.
   */
  networks: FarmNetwork[] = [],
  /** The address book's declared media (plan 88 §3.1, §3.2, §4.3, §5 step 88.5) — same accessor `/api/devices` uses. */
  declaredMedia?: Map<string, ConnectionMedium | null>,
  /**
   * Who is currently assisting a device (plan 91 §3.4 item 4, §4.4; producer
   * gap closed by docs/plans/96-m61-hotfixes.md's continuation of §96.5–96.9
   * — `api/devices.ts` got this in step 91.4, this router did not). The same
   * `heldByOf`-shaped accessor, resolved from the co-control manager
   * (`lease/co-control.ts`'s `assistedBy`). Appended as the LAST positional
   * parameter (rather than beside `heldByOf`, where it conceptually belongs)
   * so every existing positional call — `buildTopology(db)` throughout
   * `topology.test.ts` — keeps compiling unedited. `listDevicesWithTags`
   * (`registry/device-registry.ts`) has no `assistedByOf` parameter of its
   * own (deliberately not threaded there — that file is outside this
   * change's scope), so this maps over its result and OVERRIDES the
   * `assistedBy` field `DeviceInfoSchema`'s own default (`[]`) already
   * produced — the exact override-after-build shape `api/devices.ts`
   * established for the same field. Omitted (or no grant) falls back to
   * `[]` — an unknown assist state is "nobody is assisting", never a guess.
   */
  assistedByOf?: (deviceId: string) => LeaseHolder[],
): TopologyResponse {
  const deviceInfos = listDevicesWithTags(db, readinessOf, heldByOf, networks, declaredMedia).map((info) => ({
    ...info,
    assistedBy: assistedByOf?.(info.id) ?? [],
  }))
  const knownIds = new Set(deviceInfos.map((d) => d.id))

  // Membership is resolved with the SAME function a batch dispatch uses
  // (plan 20 §4.3; a plain `devices.cluster_id` lookup since plan 22.0
  // §3.5) — the map can never disagree with what a batch would actually
  // target. Unlike a batch dispatch, the map is a display of set
  // membership, not a runnability check: an offline or quarantined member
  // still belongs on that cluster's section (as an offline tile), so both
  // `usable` AND `skipped` are folded in here. A device now belongs to at
  // most one cluster (plan 22.0 §1), so these sections no longer overlap.
  const clusterRows = db.select().from(clusters).all()
  const topologyClusters: TopologyCluster[] = clusterRows.map((row) => {
    const resolved = resolveCluster(db, row)
    const ids = [...resolved.usable.map((u) => u.deviceId), ...resolved.skipped.map((s) => s.deviceId)].filter((id) =>
      knownIds.has(id),
    )
    return { id: row.id, name: row.name, deviceIds: [...new Set(ids)] }
  })

  const grouped = new Set(topologyClusters.flatMap((c) => c.deviceIds))
  const ungroupedDeviceIds = deviceInfos.filter((d) => !grouped.has(d.id)).map((d) => d.id)

  // The currently running job per device (one at a time — the per-device
  // queue guarantees it), with the script name resolved in one extra query
  // rather than one per job (same pattern as `jobStore.scriptNames`).
  const runningRows = db.select().from(jobs).where(eq(jobs.status, 'running')).all()
  const scriptIds = [...new Set(runningRows.map((r) => r.scriptId))]
  const scriptRows = scriptIds.length > 0 ? db.select().from(scripts).where(inArray(scripts.id, scriptIds)).all() : []
  const nameById = new Map(scriptRows.map((r) => [r.id, r.name]))
  const activeJobs: TopologyActiveJob[] = runningRows.map((r) => ({
    deviceId: r.deviceId,
    jobId: r.id,
    scriptName: nameById.get(r.scriptId) ?? null,
    startedAt: r.startedAt ? Math.floor(r.startedAt.getTime() / 1000) : null,
  }))

  return { clusters: topologyClusters, devices: deviceInfos, ungroupedDeviceIds, activeJobs }
}

/** `GET /api/topology` (plan 32 §4.1) — the whole farm, grouped, in one call. */
export function createTopologyRoutes(deps: {
  db: Db
  readinessOf?: (deviceId: string, row: DeviceRow) => DeviceReadiness
  heldByOf?: (deviceId: string) => LeaseHolder | null
  /** Plan 88 §3.6, §4.1, §5 step 88.5 — read fresh per request, same as `/api/devices`. */
  networks?: () => FarmNetwork[]
  declaredMedia?: () => Map<string, ConnectionMedium | null> | undefined
  /**
   * Who is currently assisting a device (plan 91 §3.4 item 4, §4.4) — see
   * `buildTopology`'s own comment on its last parameter for the full
   * rationale. Optional so every existing test (`topology.test.ts`) that
   * predates this field keeps compiling unedited; omitted means every
   * device's `assistedBy` reads `[]`, same as before this field existed.
   */
  assistedByOf?: (deviceId: string) => LeaseHolder[]
}): Hono {
  const app = new Hono()

  app.get('/', (c) =>
    c.json(buildTopology(deps.db, deps.readinessOf, deps.heldByOf, deps.networks?.() ?? [], deps.declaredMedia?.(), deps.assistedByOf)),
  )

  return app
}
