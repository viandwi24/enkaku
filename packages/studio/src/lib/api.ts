import { z } from 'zod'
import type { DeviceInfo, JobNodeInfo, WorkflowDoc, WorkflowFinding } from '@enkaku/protocol'
import { BadResponseError } from '@enkaku/ui'
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
 *
 * `parser` is optional (plan 95 §5 step 95.5, fixes F8): omitted, this
 * behaves exactly as before — a bare cast to the caller's own type
 * parameter, unchanged for every existing call site. Passed, EVERY item is
 * validated through it rather than trusted — an author-controlled blob
 * (a script's `paramsSchema`, F7) reaching a `fetchAllPages<ScriptRow>`
 * call used to cross this boundary with no check at all. A row that fails
 * throws `BadResponseError`, the SAME "this build of Studio does not
 * understand the response" failure `api()` already raises for a single
 * fetch — a bad row is not swallowed or skipped, because a caller silently
 * missing an item it asked for is worse than a visible failure.
 */
export async function fetchAllPages<T>(path: string, extraQuery?: Record<string, string>): Promise<T[]>
export async function fetchAllPages<S extends z.ZodType>(path: string, extraQuery: Record<string, string> | undefined, parser: S): Promise<z.output<S>[]>
export async function fetchAllPages(path: string, extraQuery?: Record<string, string>, parser?: z.ZodType): Promise<unknown[]> {
  const all: unknown[] = []
  let cursor: string | null = null
  for (let page = 0; page < 25; page++) {
    const qs = new URLSearchParams({ limit: '200', ...extraQuery, ...(cursor ? { cursor } : {}) })
    const res = await fetch(`${coreBase()}${path}?${qs.toString()}`)
    if (!res.ok) throw new Error(`GET ${path} → ${res.status}`)
    const body = (await res.json()) as ItemsPage<unknown>
    if (parser) {
      for (const item of body.items) {
        const parsed = parser.safeParse(item)
        if (!parsed.success) throw new BadResponseError(path, z.prettifyError(parsed.error))
        all.push(parsed.data)
      }
    } else {
      all.push(...body.items)
    }
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

// ---- Discovered devices (plan 56 §4.3, §4.5) ----

/**
 * A phone adb has seen that nobody has admitted to the farm yet (plan 56
 * §3.3, §4.1). Deliberately not a `DeviceInfo` — it has no id, no status, no
 * cluster: there is no `devices` row behind it at all. Mirrors the WS
 * `device.discovered` payload plus the two timestamps only this REST
 * snapshot carries (`firstSeen` is what makes the tray a queue: longest
 * waiting first).
 */
export interface DiscoveredDevice {
  stableId: string
  serial: string
  /** `ro.product.model`, when the probe could read it. */
  label: string | null
  androidVersion: string | null
  /** Unix seconds. */
  firstSeen: number | null
  /** Unix seconds. */
  lastSeen: number | null
}

/** `GET /api/devices/discovered` — the core returns it longest-waiting first. */
export async function fetchDiscoveredDevices(): Promise<DiscoveredDevice[]> {
  const res = await fetch(`${coreBase()}/api/devices/discovered`)
  if (!res.ok) throw new Error(`GET /api/devices/discovered → ${res.status}`)
  const body = (await res.json()) as { discovered: DiscoveredDevice[] }
  return body.discovered
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

// ---- Guest agent (plan 44 §4.6, §5.8; widened plan 90 §3.8, §4.7) ----

/**
 * The on-device guest agent's install/reachability state, from
 * `GET /api/devices/:id/guest-agent`.
 *
 * `installed` and `ready` are kept as distinct states on purpose, the same
 * reason `declared` and `observed` stay distinct on the network side (plan
 * 44 §4.6): a package being present on the device says nothing about
 * whether its control socket actually answers, and collapsing the two would
 * report a broken device as healthy.
 *
 * `outdated`/`failed` (plan 90 §3.8, fixes F10/F11) are the states
 * `AgentProvisioner` computes and persists on `devices.agent` — mirrors
 * `GuestAgentStatusResponseSchema` (`@enkaku/protocol`) exactly, which is
 * the source of truth this type is kept in sync with by hand (this file
 * predates that schema and still reads the response with a raw cast rather
 * than `.parse()` — see `fetchGuestAgentStatus` below).
 */
export type GuestAgentState = 'not-installed' | 'installed' | 'ready' | 'unreachable' | 'unsupported' | 'outdated' | 'failed'

export interface GuestAgentStatus {
  state: GuestAgentState
  appVersion?: string
  androidSdkInt?: number
  capabilities?: string[]
  /** Why the device cannot run the agent at all — only meaningful when `state` is `unsupported`. */
  reason?: string
  /**
   * Plan 90 §4.7's stated extension to this endpoint — `AgentProvisioner`'s
   * own bookkeeping fields. Optional because the handler behind this
   * endpoint (`packages/core/src/api/guest-agent.ts`) is not wired onto
   * `AgentProvisioner.status()` yet (out of step 90.6's file allowlist —
   * see its own status note): these read `undefined` today, and
   * `AgentPanel` renders that absence honestly rather than a placeholder.
   */
  versionCode?: number | null
  /** Unix epoch seconds of the last completed provisioning pass. No producer on this endpoint yet — see `versionCode`'s comment. */
  checkedAt?: number | null
  attempts?: number
  nextAttemptAt?: number | null
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

/** Mirrors `RouteCheckIdSchema` in `@enkaku/protocol` (plan 51 §4.1). */
export type RouteCheckId = 'tunnel' | 'upstream' | 'egress' | 'geo' | 'dns' | 'leak'
export type RouteCheckState = 'pass' | 'fail' | 'skip' | 'unknown'

/** One named fact `health` was derived from — always present alongside `health`, even when every check is `unknown` (plan 51 §4.1, §5.8). */
export interface RouteCheck {
  id: RouteCheckId
  state: RouteCheckState
  detail?: string
  at: number | null
}

/**
 * Where an operator expects a route's exit to be (plan 55 §3.1, §4.1). Only `country` is
 * required — that is what ENABLES the `geo` check at all; everything else is optional, and the
 * check only ever compares fields actually declared here (plan 55 §3.3, "match at the narrowest
 * level declared").
 */
export interface GeoExpectation {
  country: string
  region?: string
  city?: string
  asn?: number
  isp?: string
}

/** What a geo lookup actually reported for one exit address (plan 55 §4.1) — every field but `address`/`at` nullable, an honest "unknown" per field rather than a guess. */
export interface GeoObservation {
  address: string
  country: string | null
  region: string | null
  city: string | null
  asn: number | null
  isp: string | null
  at: number
}

/** What a failed `geo` check should do to the route (plan 55 §3.5, §4.1, §5.6). */
export type OnGeoFail = 'report' | 'hold'

/** What was saved. Never carries a password — the API never returns one (plan 44 §4.5, acceptance criterion 8). */
export interface NetworkConfig {
  host: string
  port: number
  /**
   * Names the stored credential this route authenticates with (plan 52 §4.2). There is no
   * `username` here and there never was one to read: the API returns only the name, so a form
   * that seeds a username field off this config always seeded it BLANK, which then re-saved the
   * route without a credential. Show the name; make replacing it a deliberate act.
   */
  credentialRef?: string
  udpMode: NetworkUdpMode
  /** Plan 55 §3.1, §4.1 — undefined means no expectation stated; `geo` stays `skip` forever. */
  expect?: GeoExpectation
  /** Plan 55 §3.5, §4.1 — always concrete, never absent, so the form never has to guess a default. */
  onGeoFail: OnGeoFail
}

/**
 * The three states a route's TUN can actually be in (plan 54 §4.1) — `up` alone (a plain boolean)
 * cannot tell "held closed on purpose, deliberately blocking traffic" apart from "nothing
 * configured at all"; both used to read `up: false` identically. Optional: an older core/agent
 * pair never sends it, and `up` alone is the fallback reading in that case.
 */
export type NetworkRouteState = 'up' | 'held' | 'down'

/** What the device itself reported back, from its own `route.status` — not what was asked for. */
export interface NetworkObserved {
  up: boolean
  state?: NetworkRouteState
  upstream?: string
  stats?: number[]
}

/**
 * Bounded automatic route recovery's own live state (plan 90 §3.7 rule 5,
 * fixes F20) — mirrors `NetworkRecoveryStatusSchema` (`@enkaku/protocol`).
 * Null on `NetworkStatus.recovery` when no automatic recovery has ever been
 * needed for this device's current route.
 */
export interface NetworkRecoveryStatus {
  attempts: number
  maxAttempts: number
  nextAttemptAt: number | null
  exhausted: boolean
  reconnectCycles: number
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
  /**
   * Plan 54 §4.2, §5.6 — whether a failure holds the device closed (`true`, the default even for
   * a route saved before this existed) or falls back to the device's real address (`false`,
   * an explicit opt-out for debugging by hand). Always a concrete boolean, never absent.
   */
  failClosed: boolean
  /** Derived from `checks` (plan 51 §4.1) — never set directly. */
  health: NetworkHealth
  /** The named facts `health` was derived from — always present, even when every check is `unknown`. */
  checks: RouteCheck[]
  lastError: { code: string; message: string } | null
  /** Plan 55 §4.3, §5.5 — past exit observations, newest first, so a rotating pool is visible as a sequence rather than one current value. Always present (possibly empty). */
  exitHistory: GeoObservation[]
  /**
   * Plan 90 §3.7 rule 5, fixes F20 — null when no automatic recovery has
   * ever been needed for this device's current route, same reading
   * `exitHistory` gives an unconfigured geo provider.
   */
  recovery: NetworkRecoveryStatus | null
}

export async function fetchNetworkStatus(deviceId: string): Promise<NetworkStatus> {
  const res = await fetch(`${coreBase()}/api/devices/${encodeURIComponent(deviceId)}/network`)
  if (!res.ok) throw new Error(`GET /api/devices/${deviceId}/network → ${res.status}`)
  return (await res.json()) as NetworkStatus
}

async function postNetworkAction(deviceId: string, action: 'enable' | 'disable' | 'retry'): Promise<NetworkStatus> {
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

/**
 * Plan 90 §3.7 rule 4 — the honest version of the disable-then-enable
 * workaround (F17): clears the recovery bound and applies once, immediately,
 * without the teardown round trip. 409s with `E_NO_ROUTE_CONFIG` when there
 * is no enabled route to retry.
 */
export function retryNetworkRoute(deviceId: string): Promise<NetworkStatus> {
  return postNetworkAction(deviceId, 'retry')
}

// ---- Identity: timezone, locale, GPS (plan 58 §4.3, §5.7) ----

/** A spoofed GPS fix — mirrors `DeviceGpsSchema` in `@enkaku/protocol`. */
export interface DeviceGps {
  lat: number
  lng: number
  accuracy?: number
}

/**
 * What a device presents besides its network path. Every field optional: absent means "leave the
 * device's own value alone", never a guessed default — mirrors `DeviceIdentitySchema`.
 */
export interface DeviceIdentity {
  timezone?: string
  locale?: string
  gps?: DeviceGps
}

/**
 * What a PUT actually did to the device, field by field — distinct from what got PERSISTED
 * (`DeviceIdentity` itself): a declared GPS fix is always saved, but `gps` here can still read
 * `'unavailable'` when the guest agent could not carry it out. Mirrors `device-identity.ts`'s
 * `ApplyResult`.
 */
export interface IdentityApplyResult {
  timezone?: 'applied'
  locale?: 'applied'
  gps?: 'applied' | 'unavailable'
  /** Only present when `gps === 'unavailable'` — always says WHY in plain language (plan 58 §4's scoping note: never silence). */
  gpsDetail?: string
}

export async function fetchDeviceIdentity(deviceId: string): Promise<DeviceIdentity> {
  const res = await fetch(`${coreBase()}/api/devices/${encodeURIComponent(deviceId)}/identity`)
  if (!res.ok) throw new Error(`GET /api/devices/${deviceId}/identity → ${res.status}`)
  const body = (await res.json()) as { identity: DeviceIdentity }
  return body.identity
}

/** A full replace, not a merge (plan 58 §5.3): omitted fields are cleared, not left alone. Studio's form always sends the complete current state. */
export async function applyDeviceIdentity(
  deviceId: string,
  identity: DeviceIdentity,
): Promise<{ identity: DeviceIdentity; result: IdentityApplyResult }> {
  const res = await fetch(`${coreBase()}/api/devices/${encodeURIComponent(deviceId)}/identity`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(identity),
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: { code: string; message?: string } } | null
    throw Object.assign(
      new Error(body?.error?.message ?? `PUT /api/devices/${deviceId}/identity → ${res.status}`),
      { code: body?.error?.code },
    )
  }
  return (await res.json()) as { identity: DeviceIdentity; result: IdentityApplyResult }
}

/** Reverts timezone/locale to the device's own default and removes the mock location, then clears the stored settings. */
export async function clearDeviceIdentity(deviceId: string): Promise<void> {
  const res = await fetch(`${coreBase()}/api/devices/${encodeURIComponent(deviceId)}/identity`, { method: 'DELETE' })
  if (!res.ok) throw new Error(`DELETE /api/devices/${deviceId}/identity → ${res.status}`)
}

/** What the most recent geo observation suggests — a pre-fill, never applied on its own (plan 58 §3.4). */
export interface IdentitySyncSuggestion {
  suggestion: DeviceIdentity
  observedAt: number
  country: string | null
  city: string | null
}

/** 409s with `E_NO_GEO_OBSERVATION` when no route has ever observed an exit for this device. */
export async function syncDeviceIdentity(deviceId: string): Promise<IdentitySyncSuggestion> {
  const res = await fetch(`${coreBase()}/api/devices/${encodeURIComponent(deviceId)}/identity/sync`, { method: 'POST' })
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: { code: string; message?: string } } | null
    throw Object.assign(
      new Error(body?.error?.message ?? `POST /api/devices/${deviceId}/identity/sync → ${res.status}`),
      { code: body?.error?.code },
    )
  }
  return (await res.json()) as IdentitySyncSuggestion
}

// ---- Workflows (plan 99 / M64, step 99.9) ----

/**
 * Mirrors `WorkflowFinding` (`@enkaku/protocol`'s `workflow-check.ts`)
 * structurally — that file exports the TYPE (used below for `WorkflowFinding[]`),
 * never a Zod schema for it (`checkWorkflow`'s return value is produced, not
 * parsed, on the core side), so the wire shape is validated here the same
 * way every other ad-hoc core response in this file already is (`code` kept
 * as a plain `z.string()` rather than the closed `WorkflowFindingCode` union
 * so a finding code added by a newer core still round-trips instead of
 * failing `BadResponseError` on an unrecognised member).
 */
const WorkflowFindingSchema = z.object({
  path: z.string(),
  code: z.string(),
  message: z.string(),
  severity: z.enum(['error', 'warning']),
})
const WorkflowFindingsResponseSchema = z.array(WorkflowFindingSchema)

/** Thrown by `publishWorkflow` on a 400/409 — `findings` is populated only for `E_WORKFLOW_INVALID`/the `checkWorkflow` gate, so a caller can render the SAME inline finding list `validateWorkflow` produces instead of a bare toast. */
export class WorkflowPublishError extends Error {
  readonly code: string
  readonly findings: WorkflowFinding[]
  constructor(message: string, code: string, findings: WorkflowFinding[]) {
    super(message)
    this.name = 'WorkflowPublishError'
    this.code = code
    this.findings = findings
  }
}

/** `POST /api/workflows/validate` (plan 99 §4.5, §4.9) — the SAME `checkWorkflow` call the publish gate runs, so the editor's Validate button and Publish can never disagree (`workflow-check.ts`'s own module doc). A structurally invalid document (a bad node id, an empty node list) comes back as ordinary `E_WORKFLOW_INVALID` findings, never a thrown error. */
export async function validateWorkflow(doc: WorkflowDoc | Record<string, unknown>): Promise<WorkflowFinding[]> {
  const res = await fetch(`${coreBase()}/api/workflows/validate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ doc }),
  })
  const body = await res.json().catch(() => null)
  if (!res.ok) {
    const message = (body as { error?: { message?: string } } | null)?.error?.message ?? `POST /api/workflows/validate → ${res.status}`
    throw new Error(message)
  }
  const parsed = WorkflowFindingsResponseSchema.safeParse(body)
  if (!parsed.success) throw new BadResponseError('/api/workflows/validate', z.prettifyError(parsed.error))
  return parsed.data as WorkflowFinding[]
}

/** `POST /api/workflows` (plan 99 §4.5) — publishes a new `(name, version)` `scripts` row with `kind: 'workflow'`. Throws `WorkflowPublishError` on `E_WORKFLOW_INVALID`/`E_PARAMS_SCHEMA_INVALID` (carrying `findings` when the server sent them) or the plain `script_version_exists` conflict. */
export async function publishWorkflow(doc: WorkflowDoc | Record<string, unknown>): Promise<{ id: string; name: string; version: string }> {
  const res = await fetch(`${coreBase()}/api/workflows`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ doc }),
  })
  const body = await res.json().catch(() => null)
  if (!res.ok) {
    const err = (body as { error?: { code?: string; message?: string; findings?: unknown } } | null)?.error
    const findingsParsed = WorkflowFindingsResponseSchema.safeParse(err?.findings ?? [])
    throw new WorkflowPublishError(
      err?.message ?? `POST /api/workflows → ${res.status}`,
      err?.code ?? 'unknown',
      findingsParsed.success ? (findingsParsed.data as WorkflowFinding[]) : [],
    )
  }
  return (body as { script: { id: string; name: string; version: string } }).script
}

export interface WorkflowVersionOption {
  id: string
  version: string
  enabled: boolean
  createdAt: number | null
}

/** `GET /api/workflows/:name/versions` (plan 99 §4.9) — the editor's own "start from version" picker; a thin alias over the same query `GET /api/scripts/:name/versions` runs, kept as its own endpoint since a workflow name and a script name never legitimately collide. */
export async function fetchWorkflowVersions(name: string): Promise<WorkflowVersionOption[]> {
  const res = await fetch(`${coreBase()}/api/workflows/${encodeURIComponent(name)}/versions`)
  if (!res.ok) throw new Error(`GET /api/workflows/${name}/versions → ${res.status}`)
  const body = (await res.json()) as { items: WorkflowVersionOption[] }
  return body.items
}

// ---- Workflow duration estimate (plan 99 §3.11, §4.11, step 99.10) ----

/**
 * The "up to about" duration estimate for one device's run of a workflow
 * (plan 99 §4.11's consequence-sentence example: *"4 nodes, up to about 42
 * min per device"*) — the sum of every resolvable node's own declared
 * `runtime.timeoutMs` (plan 98 step 98.4's producer, the same fact
 * `E_WORKFLOW_BUDGET_IMPOSSIBLE`'s publish-time arithmetic reads). A gate
 * node costs nothing (§3.7 — evaluated in-process, no child, no device call).
 *
 * `unknownNodes` names every SCRIPT node whose timeout could not be counted
 * — either its ref could not be resolved against the scripts already known
 * to the caller, or the resolved script simply declares no `timeoutMs`
 * (optional metadata most scripts do not set). This is the SAME honest
 * distinction `checkWorkflow`'s `W_WORKFLOW_BUDGET_UNKNOWN` makes at publish
 * time (`packages/protocol/src/workflow-check.ts`): undeclared is UNKNOWN,
 * never silently zero. `totalMs` is the sum over every node that DID
 * resolve — `0` only when nothing resolved at all, which `unknownNodes`
 * (non-empty in that case) always explains.
 */
export interface WorkflowDurationEstimate {
  nodeCount: number
  totalMs: number
  unknownNodes: string[]
}

/**
 * Computes `WorkflowDurationEstimate` for `doc` (plan 99 §4.11). No endpoint
 * returns this number — `POST /api/workflows/validate`'s check 7 answers
 * "does this fit a budget", never "how long, roughly" — so it is computed
 * client-side: `resolveScriptId` turns a node's `name@version`/`name@latest`
 * ref into a concrete `scripts.id` (the caller already has the full scripts
 * list loaded for its own picker, so this never needs a network call), then
 * each DISTINCT resolved id's own row is fetched once
 * (`GET /api/scripts/:id`, deduped, in parallel) to read `runtime.timeoutMs`.
 * Never throws: a script that fails to resolve or fails to fetch is simply
 * added to `unknownNodes` — a duration estimate degrading is a UI nicety
 * going missing, not a run failing.
 */
export async function estimateWorkflowDuration(
  doc: WorkflowDoc,
  resolveScriptId: (ref: string) => string | null,
): Promise<WorkflowDurationEstimate> {
  const scriptNodeIds = new Map<string, string>() // document nodeId -> resolved scripts.id
  const unknownNodes: string[] = []
  for (const node of doc.nodes) {
    if (node.kind !== 'script') continue
    const id = resolveScriptId(node.script)
    if (id) scriptNodeIds.set(node.id, id)
    else unknownNodes.push(node.id)
  }

  const uniqueIds = [...new Set(scriptNodeIds.values())]
  const timeoutById = new Map<string, number | null>()
  await Promise.all(
    uniqueIds.map(async (id) => {
      try {
        const res = await fetch(`${coreBase()}/api/scripts/${id}`)
        if (!res.ok) {
          timeoutById.set(id, null)
          return
        }
        const body = (await res.json()) as { script?: { runtime?: { timeoutMs?: number | null } | null } }
        timeoutById.set(id, body.script?.runtime?.timeoutMs ?? null)
      } catch {
        timeoutById.set(id, null)
      }
    }),
  )

  let totalMs = 0
  for (const [nodeId, id] of scriptNodeIds) {
    const timeoutMs = timeoutById.get(id)
    if (timeoutMs === null || timeoutMs === undefined) unknownNodes.push(nodeId)
    else totalMs += timeoutMs
  }

  return { nodeCount: doc.nodes.length, totalMs, unknownNodes }
}

export type { JobNodeInfo }
