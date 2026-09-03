import type { AdbClient, TrackerEvent } from '@enkaku/adb'
import {
  DeviceIdentitySchema,
  DeviceInfoSchema,
  defaultDeviceSettings,
  type AgentState,
  type ConnectionMedium,
  type DeviceActivity,
  type DeviceConnection,
  type DeviceInfo,
  type DeviceReadiness,
  type DeviceSettings,
  type FarmDeviceDefaults,
  type LastControl,
  type Readiness,
} from '@enkaku/protocol'
import { and, eq, gte, ne, sql } from 'drizzle-orm'
import type { Db } from '../db'
import { clusters, devices, deviceEvents, discoveredDevices, type DeviceRow } from '../db/schema'
import type { DeviceStateMachine } from '../device/state-machine'
import { staticReadinessFallback } from '../device/readiness'
import { deriveGuestAgentPreparation } from '../device/preparation/guest-agent-status'
import type { Logger } from '../util/logger'
import { probeDeviceIdentity } from '@enkaku/session'
import type { WsHub } from '../server/ws'
import { loadDeviceTags } from './device-tags'
import { classify, recordSighting } from './admission'
import { formatDeviceLabel, loadDeviceNumbers, lookupDeviceNumber } from './device-number'
import type { EventRecorder } from '../events/recorder'
import type { EndpointStore } from './endpoints'

export interface DeviceRegistryDeps {
  client: AdbClient
  db: Db
  hub: WsHub
  log: Logger
  /** The device state machine (Plan 04) — every status transition goes through it. */
  states: DeviceStateMachine
  /** Device gone or offline → close any session still open (Plan 03). */
  onDeviceGone?: (deviceId: string) => void
  /**
   * Device became usable → kick the scheduler (Plan 04). Takes the device's
   * id (plan 52 §4.1, §5.3) so a caller can also restore any persisted
   * network route for exactly this device, probe-first.
   */
  onDeviceReady?: (deviceId: string) => void
  /** Main-stream device events: device.online / device.offline / device.unauthorized (Plan 18 §4.2). */
  record?: EventRecorder['record']
  /**
   * Farm defaults, applied to a device the first time it is enrolled.
   * Without this the Settings page would be decorative: the defaults were
   * never read, and new devices silently took the DB column defaults instead.
   * Typed `FarmDeviceDefaults` (`DeviceSettings` minus `identity`) — see the
   * comment on `defaultsForNewDevice` in `admission.ts` for why a farm-wide
   * default can no longer carry an `identity` block (docs/settings-audit.md #1).
   */
  deviceDefaults?: () => FarmDeviceDefaults
  /** `readiness.defaultDesired` (plan 43 §4.4) — see the comment on `defaultsForNewDevice` below for why this is a separate accessor from `deviceDefaults`. */
  defaultDesiredReadiness?: () => Readiness
  /**
   * The address book (plan 88 §3.2, §4.3). `onOnline`'s success path calls
   * `observe(stableId, serial)` for an admitted device — free, no extra adb
   * work, a no-op for a USB serial. Optional so every existing caller (tests,
   * orchestrator mode before this is wired in `daemon.ts`) keeps constructing
   * a registry exactly as before this plan.
   */
  endpoints?: EndpointStore
  /**
   * Farm networks (plan 88 §3.6, §4.1) — `discovery.networks`, read fresh on
   * every call, the same discipline `endpoints` above already follows.
   * Residual gap (found alongside `api/devices.ts`'s admit route and
   * `api/clusters.ts`'s device list — 88.5's own pass wired `daemon.ts`,
   * `capability/context.ts` and `api/topology.ts` but missed these three):
   * without this, this registry's own `device.added` broadcast (the "new
   * device registered" branch of `onOnline`, below) and `listDevices()`
   * could only ever read `mediumSource: 'unknown'`/`'declared'`, never
   * `'network'` — a device on a configured wired network could never badge
   * OTG on its own. Optional, like `endpoints`: every existing caller
   * (tests, orchestrator mode, and any caller that predates this field)
   * keeps constructing a registry unedited, with no network ever matched —
   * identical to passing `[]` explicitly.
   */
  networks?: () => FarmNetwork[]
}

export interface DeviceRegistry {
  start(): Promise<void>
  stop(): Promise<void>
  listDevices(): DeviceInfo[]
  deviceCount(): number
  /**
   * A device was just admitted from the Discovered tray (plan 56). If that
   * phone is connected right now, bring it online immediately instead of
   * waiting for the next tracker event — which, for a phone that never gets
   * unplugged, may never come.
   */
  admitted(stableId: string): void
  /**
   * Runs the normal probe → enroll/discover path for a serial adb currently
   * reports as `device` (plan 85 §3.3, §4.4) — exposed (rather than staying
   * a module-private closure, as it was before this plan) so the
   * `DeviceReconciler` can adopt a device the tracker's own event stream
   * missed, through the EXACT same path a live `add` event already uses.
   * Dedupes internally against a probe already in flight for the same
   * serial, so the reconciler calling this for a serial the tracker is
   * already probing is a safe no-op, not a double probe.
   */
  onOnline(serial: string): Promise<void>
  /**
   * Marks a serial's device offline (plan 85 §3.3, §4.4) — exposed for the
   * same reason as `onOnline` above: the `DeviceReconciler`'s safety net for
   * a `remove` the tracker's event stream missed.
   */
  onRemove(serial: string): void
  /**
   * Every serial the registry currently associates with a device (plan 85
   * §3.3, §4.4): the tracker's live view (`serialToStableId`) UNIONED with
   * every enrolled device's last-known serial (the `devices` table) — a
   * device can be enrolled but currently disconnected and still needs to
   * count as "known" so the reconciler's `onRemove` safety net, not its
   * adopt path, is what notices it is gone. The `DeviceReconciler` diffs
   * adb's own `host:devices-l` truth against this set.
   */
  knownSerials(): Set<string>
  /**
   * How many serials currently have a scheduled probe-retry backoff pending
   * (plan 85 §3.3 point 7, §5 step 85.2) — surfaced verbatim in
   * `ReconcileReport.retriesPending` so a human watching Rescan can see F9's
   * fix actually working, not just trust that it is.
   */
  pendingRetryCount(): number
}

/**
 * Every device's owning cluster resolved by name, in one query total (plan
 * 22.0 §4.4, acceptance #10 — never one query per device). A device with no
 * cluster looks it up as `undefined` and `rowToDeviceInfo` renders that as
 * `null`, same as an empty map would.
 */
export function loadClusterNames(db: Db): Map<string, string> {
  return new Map(db.select({ id: clusters.id, name: clusters.name }).from(clusters).all().map((c) => [c.id, c.name]))
}

/** The single-device counterpart to `loadClusterNames` — one extra query, only when the device has a cluster. */
export function clusterRefFor(db: Db, clusterId: string | null): { id: string; name: string } | null {
  if (!clusterId) return null
  const row = db.select({ name: clusters.name }).from(clusters).where(eq(clusters.id, clusterId)).get()
  return row ? { id: clusterId, name: row.name } : null
}

/**
 * `host:port` shape adb itself uses for a TCP transport — confirmed by
 * `AdbTcpTransport`'s own comment ("serial adb-tcp = host:port",
 * `packages/drivers/src/transport/adb-transport.ts`). A USB serial (e.g.
 * `ZP2222RMBS`, or a 16-hex device id) never contains a colon, so this split
 * is purely observational (plan 88 §3.1) — no guessing which one a device
 * is. `host` may be bracketed IPv6 (`[::1]:5555`) or a bare hostname/IPv4;
 * only IPv4 participates in `ipInCidr` below.
 */
const TCP_SERIAL_RE = /^(\[[0-9a-fA-F:]+\]|[^\s:]+):(\d{1,5})$/

function parseIPv4(host: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (!m) return null
  const octets = [m[1]!, m[2]!, m[3]!, m[4]!].map(Number)
  if (octets.some((o) => o > 255)) return null
  return (((octets[0]! << 24) | (octets[1]! << 16) | (octets[2]! << 8) | octets[3]!) >>> 0) >>> 0
}

/**
 * Whether the IPv4 dotted-quad `host` falls inside `cidr` ('10.20.0.0/24').
 * A hostname or IPv6 host, or a malformed `cidr`, never matches — nobody has
 * configured a network wide enough to say what those are (plan 88 §3.6
 * configures IPv4 ranges only), and a non-match just means `mediumSource`
 * stays `'unknown'` rather than guessing.
 */
function ipInCidr(host: string, cidr: string): boolean {
  const slash = cidr.indexOf('/')
  if (slash < 0) return false
  const bits = Number(cidr.slice(slash + 1))
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false
  const hostInt = parseIPv4(host)
  const baseInt = parseIPv4(cidr.slice(0, slash))
  if (hostInt === null || baseInt === null) return false
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0
  return (hostInt & mask) === (baseInt & mask)
}

/**
 * A farm network (plan 88 §3.6) — the shape `discovery.networks` will have
 * once step 88.3 adds it to `packages/protocol/src/settings.ts`. Declared
 * here, ahead of that settings field, so `deriveConnection` below has
 * something concrete to accept; every call site passes `[]` until 88.3
 * wires real configuration through, which is then a settings change, not a
 * rewrite of this function.
 */
export interface FarmNetwork {
  cidr: string
  label: string
  medium: ConnectionMedium
  scan: boolean
}

/**
 * What `rowToDeviceInfo`/`listDevicesWithTags` need to fill `DeviceInfo.activities`/
 * `.lastControl` (plan 205 §4.10) — the single accessor that replaced the two
 * separate per-holder and secondary-operator parameters this file carried before that plan.
 * `activities` and `lastControl` come from the SAME `ActivityRegistry`, so they can
 * never disagree about whether a device is currently controlled.
 */
export interface DeviceActivityState {
  activities: DeviceActivity[]
  lastControl: LastControl | null
}

const NO_ACTIVITY: DeviceActivityState = { activities: [], lastControl: null }

/**
 * The ONE place a device's connection is computed (plan 88 §3.1, §4.1) —
 * `kind` from adb's own serial shape (OBSERVED), `medium` from either an
 * operator's DECLARATION (the endpoint store's `source: 'declared'` rows,
 * plan 88 §3.2/§4.3 — `PATCH /:id/connection` and the cutover wizard, §5
 * step 88.5, both write there) or, failing that, whether a `tcp` address
 * falls inside a configured farm network (INFERRED, `mediumSource:
 * 'network'`). Declared always wins (§3.1: "neither is ever overwritten by
 * the other silently: a declaration wins") — closing the gap step 88.4's own
 * report flagged: a declaration used to be reflected only in that route's
 * immediate response, never on a later `GET /api/devices`/`GET /:id`, which
 * re-derived `medium` from `networks` alone and could never produce
 * `mediumSource: 'declared'`. Called from `rowToDeviceInfo`, so the list,
 * the wall, the card, the device page and every WS broadcast agree — no
 * caller re-derives this itself.
 */
export function deriveConnection(
  serial: string,
  networks: FarmNetwork[],
  /**
   * The endpoint store's declared medium for THIS EXACT `host:port` address
   * (plan 88 §3.2/§4.3), resolved by the caller via `loadDeclaredMedia`
   * below — `undefined` when no declaration exists for this address (fall
   * through to the network match), `null` when an operator explicitly
   * declared "unknown" (still wins over a network guess), a value when they
   * declared a medium outright.
   */
  declaredMedium?: ConnectionMedium | null,
): DeviceConnection {
  const match = TCP_SERIAL_RE.exec(serial)
  if (!match) {
    return { kind: 'usb', medium: null, mediumSource: 'unknown', address: null, port: null, networkLabel: null }
  }
  const hostRaw = match[1]!
  const host = hostRaw.startsWith('[') ? hostRaw.slice(1, -1) : hostRaw
  const port = Number(match[2])
  const network = networks.find((n) => ipInCidr(host, n.cidr))
  if (declaredMedium !== undefined) {
    return { kind: 'tcp', medium: declaredMedium, mediumSource: 'declared', address: host, port, networkLabel: network?.label || null }
  }
  return {
    kind: 'tcp',
    medium: network?.medium ?? null,
    mediumSource: network ? 'network' : 'unknown',
    address: host,
    port,
    networkLabel: network?.label || null,
  }
}

/**
 * The chip-only agent state for `DeviceInfoSchema.agent` (plan 90 §3.8, §4.3,
 * §4.7; docs/plans/96-m61-hotfixes.md's Gap 1 fix; repointed by plan 106 §5
 * step 106.5) — reads `devices.preparation['guest-agent']`, the authoritative
 * store since 106.5, via `deriveGuestAgentPreparation` (`device/preparation/
 * guest-agent-status.ts`) — the SAME function `agent-provisioner.ts`'s own
 * `readCached` uses, so there is exactly one place that knows how to read
 * this fact (including its legacy `devices.agent` fallback for a
 * pre-migration row). Deliberately NOT a `rowToDeviceInfo` parameter
 * threaded by each caller (unlike `readiness`/`activityState`/`networks`, which
 * come from managers external to the row): `preparation`/`agent` are
 * columns on `devices`, already present on every `DeviceRow` this file's
 * callers select in full (`db.select().from(devices)`, never a partial
 * projection) — so reading them here, once, inside the one function every
 * list/broadcast/detail response already funnels through, reaches every
 * caller automatically and removes the "one call site was missed" failure
 * mode entirely, rather than adding a fourth accessor a future caller could
 * forget to pass. A corrupt or never-provisioned value reads as `'absent'`
 * (never a 500), the same fallback `readCached` gives.
 */
export function deriveAgentState(row: Pick<DeviceRow, 'agent' | 'preparation'>): AgentState {
  return deriveGuestAgentPreparation(row).state
}

/**
 * Declared medium per `stableId` + exact address (plan 88 §3.1, §3.2, §4.3)
 * — the endpoint store's `source: 'declared'` rows only, keyed
 * `stableId address` so `deriveConnection` can look up THIS device's
 * CURRENT serial in one map hit. Resolved once for the whole device list
 * (`endpoints.allWithEndpoints()` already reads every row for the restart
 * flow's reattach list, §3.10) — the same N+1 discipline
 * `loadClusterNames`/`loadRecentCrashes` above already use, extended to
 * `connection.medium`.
 */
export function loadDeclaredMedia(endpoints: Pick<EndpointStore, 'allWithEndpoints'>): Map<string, ConnectionMedium | null> {
  const map = new Map<string, ConnectionMedium | null>()
  for (const { stableId, candidates } of endpoints.allWithEndpoints()) {
    for (const ep of candidates) {
      if (ep.source === 'declared') map.set(`${stableId} ${ep.address}`, ep.medium)
    }
  }
  return map
}

export function rowToDeviceInfo(
  row: DeviceRow,
  tags: string[] = [],
  cluster: { id: string; name: string } | null = null,
  /** Populated only by `listDevicesWithTags` (plan 37 §4.5) — see `DeviceInfoSchema.lastCrashAt`. */
  lastCrashAt: number | null = null,
  /**
   * Readiness (plan 43 §4.1) — the live `ReadinessManager.get()` result from
   * every production call site. Falls back to `staticReadinessFallback`
   * (offline-aware, but session-blind) ONLY when no manager was threaded
   * through, which today is orchestrator mode (no local readiness manager
   * exists there at all) and tests that construct a row directly.
   */
  readiness: DeviceReadiness | null = null,
  /**
   * The device's live activities plus its last-control tail (MVP 04 §1.1,
   * §1.2, plan 205 §4.10) — the single accessor that replaced Plan 71's own
   * holder field and Plan 91's secondary-operators field. Empty/`null` when nobody has threaded
   * an `ActivityRegistry` through (orchestrator mode, most tests), same as
   * those two defaulted before this plan.
   */
  activityState: DeviceActivityState = NO_ACTIVITY,
  /**
   * Farm networks (plan 88 §3.6) — used only to infer `connection.medium`
   * for a `tcp` serial. Defaulted to `[]` (every network match then misses,
   * so `mediumSource` reads `'unknown'`) until a caller threads
   * `discovery.networks` through; every existing caller keeps parsing
   * unchanged in the meantime.
   */
  networks: FarmNetwork[] = [],
  /**
   * Declared medium per `stableId`+address (plan 88 §3.1, §3.2, §4.3, §5
   * step 88.5) — `loadDeclaredMedia`'s own return shape, resolved ONCE by
   * the caller (same N+1 discipline as `networks`/`tags`/`cluster` above),
   * not re-queried per row. Defaulted to an empty map so every existing
   * caller (tests, orchestrator mode, call sites that predate this
   * parameter) keeps parsing exactly as before — `mediumSource` then simply
   * never reads `'declared'`, falling through to the network match same as
   * always.
   */
  declaredMedia: Map<string, ConnectionMedium | null> = new Map(),
  /**
   * The device's short number (plan 89 §3.1, §3.2, §4.3) — a lookup against
   * `device_numbers`, keyed by `stableId`, NEVER a column on `row` (§3.2: the
   * reservation must survive a Forget that deletes this very row). Defaulted
   * to `null` so every existing caller (tests, and any call site not yet
   * threading it) keeps parsing exactly as before this plan, reading a device
   * as numberless rather than throwing.
   */
  number: number | null = null,
): DeviceInfo {
  return DeviceInfoSchema.parse({
    id: row.id,
    stableId: row.stableId,
    serial: row.serial,
    label: row.label,
    androidVersion: row.androidVersion,
    apiLevel: row.apiLevel,
    screenW: row.screenW,
    screenH: row.screenH,
    density: row.density,
    status: row.status ?? 'offline',
    lastSeen: row.lastSeen ? Math.floor(row.lastSeen.getTime() / 1000) : null,
    battery: row.battery ?? null,
    quarantineReason: row.quarantineReason ?? null,
    tags,
    cluster,
    lastCrashAt,
    readiness: readiness ?? staticReadinessFallback(row),
    activities: activityState.activities,
    lastControl: activityState.lastControl,
    connection: deriveConnection(row.serial, networks, declaredMedia.get(`${row.stableId} ${row.serial}`)),
    agent: deriveAgentState(row),
    number,
  })
}

/**
 * Devices that crashed at least once in the last hour (plan 37 §4.5's device
 * card badge) — ONE aggregate query regardless of fleet size, not a
 * per-device lookup, keyed off the same `idx_device_events_tail
 * (deviceId, stream, at)` index the Logs tab already relies on.
 */
export function loadRecentCrashes(db: Db, sinceEpochSec: number): Map<string, number> {
  const rows = db
    .select({ deviceId: deviceEvents.deviceId, lastAt: sql<number>`max(${deviceEvents.at})` })
    .from(deviceEvents)
    .where(and(eq(deviceEvents.kind, 'app.crashed'), gte(deviceEvents.at, new Date(sinceEpochSec * 1000))))
    .groupBy(deviceEvents.deviceId)
    .all()
  // `max(at)` is a raw SQL aggregate over the underlying INTEGER column — it
  // returns the stored unix-seconds value directly, NOT a Drizzle-mapped
  // Date (that mapping only applies to plain column selects), so this is
  // just a number, already in the repo-wide unix-seconds convention.
  return new Map(rows.map((r) => [r.deviceId, Math.floor(Number(r.lastAt))]))
}

/**
 * Every device plus its tags and its cluster, in exactly three queries
 * regardless of how many devices there are (plan 19 §4.3 and plan 22.0
 * §4.4, acceptance #7 and #10 — never N+1).
 */
export function listDevicesWithTags(
  db: Db,
  /** Readiness (plan 43 §4.1) — omitted call sites fall back to `staticReadinessFallback` per-row, same as `rowToDeviceInfo` itself. */
  readinessOf?: (deviceId: string, row: DeviceRow) => DeviceReadiness,
  /** Live activities plus last-control tail (plan 205 §4.10) — omitted call sites fall back to `NO_ACTIVITY`, same as `rowToDeviceInfo` itself. */
  activitiesOf?: (deviceId: string) => DeviceActivityState,
  /**
   * Farm networks (plan 88 §3.6), resolved ONCE for the whole list — the
   * same N+1 discipline this function already applies to tags, clusters and
   * crashes above, extended to `connection.medium`. `rowToDeviceInfo` NEVER
   * re-resolves this per row.
   */
  networks: FarmNetwork[] = [],
  /**
   * The address book's declared media (plan 88 §3.1, §3.2, §4.3, §5 step
   * 88.5), also resolved ONCE for the whole list — `loadDeclaredMedia`'s own
   * return shape. `undefined` (the default) means no endpoint store was
   * available to this caller (orchestrator mode, most tests): every device
   * then falls through to the network match exactly as before this
   * parameter existed.
   */
  declaredMedia?: Map<string, ConnectionMedium | null>,
): DeviceInfo[] {
  const rows = db.select().from(devices).all()
  const tagMap = loadDeviceTags(db)
  const clusterNames = loadClusterNames(db)
  // The device card crash badge (plan 37 §4.5) — one query for the whole
  // fleet, not one per device.
  const recentCrashes = loadRecentCrashes(db, Math.floor(Date.now() / 1000) - 3600)
  // The number (plan 89 §4.3) — one query for the whole fleet, joining the
  // existing ones (F25's "never one query per device" rule), never resolved
  // per row.
  const numbers = loadDeviceNumbers(db)
  return rows.map((r) =>
    rowToDeviceInfo(
      r,
      tagMap.get(r.id) ?? [],
      r.clusterId ? { id: r.clusterId, name: clusterNames.get(r.clusterId) ?? r.clusterId } : null,
      recentCrashes.get(r.id) ?? null,
      readinessOf?.(r.id, r) ?? null,
      activitiesOf?.(r.id) ?? NO_ACTIVITY,
      networks,
      declaredMedia ?? new Map(),
      numbers.get(r.stableId) ?? null,
    ),
  )
}

/**
 * Orkestrasi tracker → probe → upsert-by-stableId → broadcast (plan 01 §4.5).
 * - state 'device'       → probe → upsert → broadcast added|status idle
 * - state 'unauthorized' → log.warn saja (wizard = Plan 03)
 * - remove               → status offline + broadcast device.status
 */
export function createDeviceRegistry(deps: DeviceRegistryDeps): DeviceRegistry {
  const { client, db, hub, log } = deps
  /** serial → stableId, so a remove event resolves without a query. */
  /**
   * Farm defaults → the columns the session builder reads, plus the settings
   * JSON. Both are written from ONE source so they cannot disagree.
   *
   * `identity` is always filled from `DeviceIdentitySchema`'s own empty
   * default, never from `deps.deviceDefaults` (which cannot carry one — see
   * `admission.ts`'s `defaultsForNewDevice` for the full reasoning,
   * docs/settings-audit.md #1) — so a device enrolled through THIS path
   * (the live adb tracker, distinct from the admission-tray `admitDevice`
   * path `admission.ts` itself covers) gets a valid, empty identity too.
   */
  const defaultsForNewDevice = () => {
    const base = deps.deviceDefaults?.() ?? defaultDeviceSettings()
    const s: DeviceSettings = { ...base, identity: DeviceIdentitySchema.parse({}) }
    return {
      transport: s.engines.transport,
      display: s.engines.display,
      input: s.engines.input,
      inspection: s.engines.inspection,
      settings: s,
      // Readiness (plan 43 §4.4) — `readiness.defaultDesired` on
      // `FarmSettings` is a separate top-level block from `DeviceSettings`
      // (unlike engines/prep/timing above, which ARE nested inside it), so
      // it needs its own accessor. `null` (the omitted-accessor default)
      // reads as `asleep` everywhere `desiredReadiness` is consulted — the
      // schema's own default, so a host that does not wire this keeps
      // enrolling devices exactly as before this plan.
      desiredReadiness: deps.defaultDesiredReadiness?.() ?? null,
    }
  }

  const serialToStableId = new Map<string, string>()
  /** Dedupe probes per serial (a flapping wireless device causes an event storm). */
  const probesInFlight = new Set<string>()
  let unsubscribe: (() => void) | null = null

  /**
   * Backoff schedule for a probe that keeps failing (plan 85 §3.3 point 7,
   * §5 step 85.2) — 1s, 2s, 5s, 15s, 30s, and then nothing further: once
   * exhausted, the periodic `DeviceReconciler`
   * (`packages/core/src/registry/reconcile.ts`) picks it back up on its own
   * cadence with no special-casing needed here — a serial that never
   * successfully probes never enters `serialToStableId`, so it never stops
   * looking "unknown" to `knownSerials()`, and the reconciler's ordinary
   * adopt path retries it every tick.
   */
  const PROBE_RETRY_BACKOFF_MS = [1_000, 2_000, 5_000, 15_000, 30_000]
  /** serial → the scheduled retry timer, so a device that disappears can cancel it before it fires a stale probe. */
  const pendingProbeRetries = new Map<string, ReturnType<typeof setTimeout>>()
  /** serial → how many backoff steps have already been used; reset to 0 the moment a probe succeeds. */
  const probeRetryAttempt = new Map<string, number>()

  function cancelProbeRetry(serial: string): void {
    const timer = pendingProbeRetries.get(serial)
    if (timer) {
      clearTimeout(timer)
      pendingProbeRetries.delete(serial)
    }
    probeRetryAttempt.delete(serial)
  }

  function scheduleProbeRetry(serial: string): void {
    const attempt = probeRetryAttempt.get(serial) ?? 0
    if (attempt >= PROBE_RETRY_BACKOFF_MS.length) {
      // Backoff exhausted — from here the reconciler's own tick is the
      // retry mechanism (F9's fix): see the comment on the constant above.
      return
    }
    const delayMs = PROBE_RETRY_BACKOFF_MS[attempt]!
    probeRetryAttempt.set(serial, attempt + 1)
    const timer = setTimeout(() => {
      pendingProbeRetries.delete(serial)
      void onOnline(serial)
    }, delayMs)
    pendingProbeRetries.set(serial, timer)
  }

  async function onOnline(serial: string): Promise<void> {
    if (probesInFlight.has(serial)) return
    probesInFlight.add(serial)
    try {
      let probe
      try {
        probe = await probeDeviceIdentity(client, serial)
      } catch (err) {
        // Retry once after a delay — a device is sometimes not shell-ready the instant it appears.
        log.debug(`probe of ${serial} failed, retrying once in 1s`, { err: String(err) })
        await Bun.sleep(1000)
        probe = await probeDeviceIdentity(client, serial)
      }
      // It answered — any scheduled backoff retry for this serial is moot,
      // and the next failure (a later disconnect/reconnect cycle) starts
      // the schedule fresh rather than continuing where a stale one left off.
      cancelProbeRetry(serial)
      if (probe.stableId.startsWith('serial:')) {
        log.warn(`using the tertiary stableId fallback for ${serial} (ro.serialno and android_id are both invalid)`)
      }
      // Block check (plan 47 §3.3, §4.2): keyed on `stableId`, never the
      // serial — a blocked device is skipped BEFORE it is ever inserted, so
      // blocking is free at steady state and survives a different USB port
      // or a switch to adb-tcp, both of which change only the serial. Logged
      // once at `debug` (not `info`) since a blocked device reappearing is
      // expected, ongoing behaviour, not a noteworthy event.
      //
      // Admission (plan 56 §4.2) folds that block check into one decision, so
      // the three outcomes live in a single place rather than as separate
      // guards that could drift apart.
      const admission = classify(db, probe.stableId)
      if (admission === 'blocked') {
        log.debug(`skipping blocked device ${probe.stableId} (serial ${serial}) — not probing further`)
        return
      }
      if (admission === 'discovered') {
        // Seen, identified, and deliberately NOT enrolled: no `devices` row
        // means nothing to schedule, nothing to control, and nothing for the
        // wall to draw. It waits in the tray until someone admits it.
        const firstSighting = !db
          .select({ stableId: discoveredDevices.stableId })
          .from(discoveredDevices)
          .where(eq(discoveredDevices.stableId, probe.stableId))
          .get()
        recordSighting(db, {
          stableId: probe.stableId,
          serial,
          label: probe.model ?? null,
          androidVersion: probe.androidVersion ?? null,
        })
        serialToStableId.set(serial, probe.stableId)
        hub.broadcast({
          type: 'device.discovered',
          payload: {
            stableId: probe.stableId,
            serial,
            label: probe.model ?? null,
            androidVersion: probe.androidVersion ?? null,
          },
        })
        // `info` on the first sighting only. A phone that is plugged in daily
        // and never admitted should not narrate itself into the log forever.
        if (firstSighting) {
          log.info(`device discovered, awaiting admission: ${probe.model ?? probe.stableId} (${probe.stableId}) via ${serial}`)
        } else {
          log.debug(`device ${probe.stableId} seen again, still awaiting admission`)
        }
        return
      }
      const now = new Date()
      const existing = db.select().from(devices).where(eq(devices.stableId, probe.stableId)).get()
      db.insert(devices)
        .values({
          id: crypto.randomUUID(),
          stableId: probe.stableId,
          serial,
          label: probe.model ?? probe.stableId,
          androidVersion: probe.androidVersion,
          apiLevel: probe.apiLevel,
          screenW: probe.screenW,
          screenH: probe.screenH,
          density: probe.density,
          status: 'online',
          lastSeen: now,
          // First enrollment copies the farm defaults; the conflict branch below
          // deliberately leaves them alone so a device keeps its own settings.
          ...(existing ? {} : defaultsForNewDevice()),
        })
        .onConflictDoUpdate({
          target: devices.stableId,
          // id, label, and status are NOT touched here — status only moves via
          // the state machine (DEVICE_CONNECTED), which keeps `quarantined` sticky.
          set: {
            serial,
            androidVersion: probe.androidVersion,
            apiLevel: probe.apiLevel,
            screenW: probe.screenW,
            screenH: probe.screenH,
            density: probe.density,
            lastSeen: now,
          },
        })
        .run()
      serialToStableId.set(serial, probe.stableId)
      const row = db.select().from(devices).where(eq(devices.stableId, probe.stableId)).get()
      if (!row) return
      // The address book's whole cost (plan 88 §3.2, §4.3, fixes F10): free,
      // because this probe already ran for an ordinary reason.
      deps.endpoints?.observe(probe.stableId, serial)
      // The number (plan 89 §1, §5 step 89.4) — an operator matching a
      // browser row to a phone in their hand needs it in the SAME log line
      // that already names the label, not just in the database.
      const number = lookupDeviceNumber(db, row.stableId)
      if (existing) {
        // The official transition (offline→idle; quarantined stays quarantined).
        deps.states.apply(row.id, 'DEVICE_CONNECTED')
        log.info(`device online: ${formatDeviceLabel(number, row.label)} (${probe.stableId}) via ${serial}`)
      } else {
        // A `declare` this early is unusual (a device nobody has enrolled yet
        // cannot have been declared through) but not impossible — a
        // forget/re-admit cycle keeps the endpoint store's rows (F15) — so
        // this reads the same declared-medium map every other broadcast does
        // rather than a bare `[]`.
        hub.broadcast({
          type: 'device.added',
          payload: rowToDeviceInfo(
            row,
            [],
            null,
            null,
            null,
            NO_ACTIVITY,
            deps.networks?.() ?? [],
            deps.endpoints ? loadDeclaredMedia(deps.endpoints) : undefined,
            number,
          ),
        })
        log.info(`new device registered: ${formatDeviceLabel(number, row.label)} (${probe.stableId}) via ${serial}`)
      }
      deps.record?.({ deviceId: row.id, stream: 'main', kind: 'device.online', meta: { serial, transport: row.transport ?? 'adb-usb', number } })
      deps.onDeviceReady?.(row.id)
    } catch (err) {
      // Used to be a dead end (F9): the device stayed invisible until
      // physically unplugged and replugged, because no next tracker event
      // was coming. Now it gets a bounded backoff retry, and once that is
      // exhausted the periodic `DeviceReconciler` keeps trying every tick —
      // see `scheduleProbeRetry`'s own comment for why no further
      // bookkeeping is needed to make that happen.
      log.warn(`probe of ${serial} failed — retrying with backoff`, { err: String(err) })
      scheduleProbeRetry(serial)
    } finally {
      probesInFlight.delete(serial)
    }
  }

  function onRemove(serial: string): void {
    // Cancel BEFORE the early returns below (plan 85 §5 step 85.2's "the
    // retry is cancelled when the device disappears") — a serial can be
    // mid-backoff with no `devices` row at all (every probe has failed so
    // far), and it must still stop retrying the instant adb says it is gone.
    cancelProbeRetry(serial)
    const stableId = serialToStableId.get(serial)
    serialToStableId.delete(serial)
    const row = stableId
      ? db.select().from(devices).where(eq(devices.stableId, stableId)).get()
      : db.select().from(devices).where(eq(devices.serial, serial)).get()
    if (!row || row.status === 'offline') return
    // The same device may still be online over another transport (USB plus WiFi).
    for (const [s, sid] of serialToStableId) {
      if (sid === row.stableId && s !== serial) {
        log.debug(`device ${row.stableId} is still online via ${s} — not marking it offline`)
        return
      }
    }
    db.update(devices).set({ lastSeen: new Date() }).where(eq(devices.id, row.id)).run()
    // Any running job on this device is failed and its session closed by the caller.
    deps.onDeviceGone?.(row.id)
    deps.states.apply(row.id, 'DEVICE_DISCONNECTED')
    const number = lookupDeviceNumber(db, row.stableId)
    deps.record?.({ deviceId: row.id, stream: 'main', kind: 'device.offline', meta: { reason: 'disconnected', number } })
    log.info(`device offline: ${formatDeviceLabel(number, row.label)} (${row.stableId})`)
  }

  function onTrackerEvent(ev: TrackerEvent): void {
    if (ev.kind === 'remove') {
      onRemove(ev.serial)
      return
    }
    if (ev.state === 'device') {
      void onOnline(ev.serial)
    } else if (ev.state === 'unauthorized') {
      log.warn(`device ${ev.serial} is unauthorized — accept the USB debugging dialog on the phone's screen`)
      hub.broadcast({ type: 'device.unauthorized', payload: { serial: ev.serial } })
      // Only recorded if we already know this device (a previous session's
      // stableId) — an unenrolled device has no row and no Logs tab to show it on.
      const stableId = serialToStableId.get(ev.serial)
      const knownRow = stableId ? db.select().from(devices).where(eq(devices.stableId, stableId)).get() : null
      if (knownRow) deps.record?.({ deviceId: knownRow.id, stream: 'main', kind: 'device.unauthorized', meta: {} })
    } else if (ev.state === 'offline' || ev.state === 'authorizing') {
      // Not acted on here (plan 85 §3.3, fixes F10): a single tracker event
      // is not enough signal — `offline`/`authorizing` are exactly the
      // states a Windows host shows for a phone plugged in before the adb
      // server finished USB enumeration, and they often resolve themselves
      // within a second or two. The `DeviceReconciler`
      // (`packages/core/src/registry/reconcile.ts`) is what watches these
      // over TIME (`discovery.offlineGraceSec`) and issues the one bounded
      // `host:reconnect-offline` recovery if the state persists — it
      // re-derives its own view straight from `host:devices-l` on every
      // tick, so nothing here needs to feed it directly.
      log.debug(`device ${ev.serial} state=${ev.state} — the discovery reconciler recovers it if it persists`)
    } else {
      log.debug(`device ${ev.serial} state=${ev.state} — unrecognised adb state, ignored`)
    }
  }

  return {
    async start() {
      // Crash recovery: online → offline (quarantined stays sticky);
      // the tracker's first snapshot brings back whatever is really there.
      db
        .update(devices)
        .set({ status: 'offline' })
        .where(and(ne(devices.status, 'offline'), ne(devices.status, 'quarantined')))
        .run()
      const tracker = client.trackDevices()
      unsubscribe = tracker.on(onTrackerEvent)
      await tracker.start()
    },
    async stop() {
      unsubscribe?.()
      unsubscribe = null
      // Every process this registry started is dead on stop (00-overview §7)
      // — a pending backoff timer left running would fire `onOnline` against
      // a client that may already be disposed.
      for (const timer of pendingProbeRetries.values()) clearTimeout(timer)
      pendingProbeRetries.clear()
      probeRetryAttempt.clear()
      await client.trackDevices().stop()
    },
    listDevices() {
      // Wired for consistency with `listDevicesWithTags`'s other production
      // call sites (`daemon.ts`, `capability/context.ts`, `api/topology.ts`,
      // `api/devices.ts`) even though this method itself has no production
      // caller today (`DeviceRegistry.listDevices` — every real list route
      // goes through `listDevicesWithTags`/`rowToDeviceInfo` directly, with
      // its own live accessors) — leaving it hardcoded to `[]` would be a
      // second dark corner the moment a caller is added, and the fix is a
      // one-line reuse of the same accessor `onOnline`'s broadcast just above
      // was given.
      return listDevicesWithTags(db, undefined, undefined, deps.networks?.() ?? [], deps.endpoints ? loadDeclaredMedia(deps.endpoints) : undefined)
    },
    deviceCount() {
      return db.select().from(devices).all().length
    },
    onOnline,
    onRemove,
    knownSerials() {
      const serials = new Set(serialToStableId.keys())
      for (const row of db.select({ serial: devices.serial }).from(devices).all()) {
        if (row.serial) serials.add(row.serial)
      }
      return serials
    },
    pendingRetryCount() {
      return pendingProbeRetries.size
    },
    admitted(stableId) {
      // A phone admitted from the tray (plan 56) is usually plugged in RIGHT
      // NOW — but the tracker only speaks on change, so without this the new
      // device would sit there reading `disconnected` until someone unplugged
      // and replugged it. A card that says disconnected about a phone on the
      // desk is worse than no card.
      //
      // `serialToStableId` is the live view of what adb currently reports, so
      // it answers "is this phone actually here?" without a probe. Re-running
      // `onOnline` then takes the ordinary enrolment path, which now upserts
      // and transitions rather than discovering, because the row exists.
      for (const [serial, sid] of serialToStableId) {
        if (sid === stableId) {
          void onOnline(serial)
          return
        }
      }
    },
  }
}
