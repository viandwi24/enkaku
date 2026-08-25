/**
 * Constants and read/write logic shared across the plugin's THREE halves —
 * `src/index.ts` and `src/service/**` (the core's Bun runtime) and
 * `src/ui/**` (a browser, since step 122.3) — kept in one place the way
 * `plugins/proxy-manager/src/shared.ts` keeps its own vocabulary in one place
 * so the service and the screen cannot drift into disagreeing. **This file
 * imports nothing**, for the same reason proxy-manager's own header gives:
 * a plugin's UI bundle would otherwise inline a schema library and a server
 * SDK into a module the browser downloads.
 *
 * Step 122.1 only needed two things out of the whole §4 design: the
 * write-scope comment prefix (§4.2), used here for a coarse managed/foreign
 * classification inside `doctor()`, and the local-exception rule's exact
 * comment and fix commands (§3.2). Step 122.2 added marker parse/serialise
 * (in `service/marker.ts`, not here — it needs no browser half). Step 122.3
 * adds the KV data model's `config`/`router` shapes (§4.9) — the read/write
 * pair each follows `plugins/proxy-manager/src/shared.ts`'s
 * `readProxyRecord`/`writeProxyRecord` discipline: a defensive reader that
 * degrades a junk KV value to defaults rather than throwing, and a writer
 * that is its exact inverse, both usable from either half.
 */

/**
 * Every rule this plugin ever creates, patches or deletes has a comment
 * starting with this. A rule whose comment does not start with it is
 * foreign and must never be touched (§3.1, §4.2, acceptance criterion 2).
 */
export const MANAGED_COMMENT_PREFIX = 'enkaku:mikrotik-routing:'

/**
 * The comment `buildLocalExceptionFixCommands` below suggests for a NEW
 * local-exception rule. It is a friendly default label only, since step
 * 122.12's fix (A) — reading `docs/plans/122-m87-mikrotik-routing.md` — is
 * exactly that DETECTING the rule may never rely on this text matching:
 * `local-exception.ts`'s `classifyLocalException` decides by behaviour
 * (action/table/disabled/inactive/address coverage/position), never by
 * comment. This constant is only ever used to WRITE a suggested comment into
 * the fix commands below, never to read one back.
 */
export const LOCAL_EXCEPTION_COMMENT = 'farm: local exception'

/**
 * The `/routing rule add` + `move` commands `local-exception.ts` suggests
 * when its local-exception check is not `ok` — plan 122 §5 step 122.12 fix
 * (4), replacing the old hardcoded `dst-address=192.168.0.0/16` +
 * `<farm-subnet>` placeholder this function used to be a static array of.
 * `srcAddress` and every `dstAddress` are DERIVED by the caller (from the
 * device addresses this plugin actually knows, and the core's own observed
 * — or RFC1918-fallback — address) rather than assumed here; this function
 * only ever formats them into the same command shape §3.2 always used. One
 * `add` per `dstAddress` (more than one only in the fallback case, where the
 * core's own address could not be observed and every RFC1918 block is
 * suggested instead of one guessed at), followed by a single `move` that
 * relies on RouterOS's `[find comment=...]` matching every rule this batch
 * just added.
 */
export function buildLocalExceptionFixCommands(srcAddress: string, dstAddresses: readonly string[]): readonly string[] {
  const lines: string[] = []
  for (const dstAddress of dstAddresses) {
    lines.push(`/routing rule add src-address=${srcAddress} dst-address=${dstAddress} \\`)
    lines.push(`    action=lookup table=main comment="${LOCAL_EXCEPTION_COMMENT}"`)
  }
  lines.push(`/routing rule move [find comment="${LOCAL_EXCEPTION_COMMENT}"] destination=0`)
  return lines
}

/**
 * The `router` connection is only acceptable on a trusted management
 * segment, and the router-side API user should be scoped narrowly — §4.10
 * says both plainly rather than assuming an operator already knows. Declared
 * here (imported by nothing that needs `zod` or `@enkaku/sdk`) so the
 * Settings tab and this pack's manifest description can never say it two
 * different ways.
 */
export const PLAIN_HTTP_WARNING =
  'Plain HTTP is only acceptable on a trusted management segment — this connection is not encrypted unless TLS is on. Scope the router-side API user with address= to the controller’s own subnet, and give it write access to /routing/rule only.'

/**
 * What the Settings tab says beside the connection form, once and reused
 * rather than written twice (step 122.3).
 */
export const NO_REVEAL_HINT =
  'These fields are stored as one secret entry and are never read back — not by this screen, not by any API this plugin serves (§4.10). Saving overwrites all five together, so re-enter every field each time you change one. An operator who genuinely needs the password back uses the core’s own admin-only, audited reveal route, never this screen.'

// ---------------------------------------------------------------------------
// The KV data model (§4.9) — step 122.3's slice of it: `config` and `router`.
// `inventory`/`health`/`group:<id>`/`assignment` belong to later steps
// (122.5–122.9), which is why they are not named here yet.
// ---------------------------------------------------------------------------

/** Farm-wide, non-secret — reconcile cadence and the two apply-safety switches (§4.9). */
export const CONFIG_KEY = 'config'

/**
 * Farm-wide, **secret** — the whole router connection in one KV row,
 * `{ baseUrl, username, password, tls, timeoutMs }`, exactly as §4.9's table
 * names it. One row rather than a split (password separate from the rest, the
 * way `proxy-manager`'s upstream host/port stays plain while only its
 * password is secret) because that is the shape the plan's own data model
 * declares for this key — and unlike a proxy upstream, a router's address is
 * not a fact an operator benefits from seeing in a plain list; the whole
 * connection is one credential.
 */
export const ROUTER_KEY = 'router'

/** The plugin's own apply-safety and reconcile-cadence preferences (§4.9). */
export interface PluginConfig {
  /** §4.7: "a self-rescheduling setTimeout ... default 60 s". */
  reconcileIntervalSec: number
  /** §4.4: "Studio requires confirmation (config.requireConfirm, default on)". */
  requireConfirm: boolean
  /** §4.7: "autoRepair is opt-in and covers only missing/wrong-path". Default off. */
  autoRepair: boolean
}

export const DEFAULT_RECONCILE_INTERVAL_SEC = 60
export const MIN_RECONCILE_INTERVAL_SEC = 5
export const MAX_RECONCILE_INTERVAL_SEC = 3600

export const DEFAULT_PLUGIN_CONFIG: PluginConfig = {
  reconcileIntervalSec: DEFAULT_RECONCILE_INTERVAL_SEC,
  requireConfirm: true,
  autoRepair: false,
}

/** The router connection, exactly `MikrotikRestConfig`'s own shape (`service/rest-client.ts`) — kept as a plain interface here, not imported, so this file still imports nothing (this header's own rule). */
export interface RouterConfig {
  /** Host, or host:port — no scheme (§4.1, §5 step 122.1). */
  baseUrl: string
  username: string
  password: string
  tls: boolean
  timeoutMs: number
}

export const DEFAULT_ROUTER_TIMEOUT_MS = 5_000
export const MIN_ROUTER_TIMEOUT_MS = 500
export const MAX_ROUTER_TIMEOUT_MS = 60_000

export const DEFAULT_ROUTER_CONFIG: RouterConfig = {
  baseUrl: '',
  username: '',
  password: '',
  tls: false,
  timeoutMs: DEFAULT_ROUTER_TIMEOUT_MS,
}

// ---------------------------------------------------------------------------
// Reading a stored value — the same defensive-reader discipline
// `plugins/proxy-manager/src/shared.ts`'s `readProxyRecord` uses: a KV
// namespace is the plugin's own scratch space, so a junk value must read as
// blanks/defaults rather than throw inside a form or a service handler.
// ---------------------------------------------------------------------------

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function str(source: Record<string, unknown>, key: string, fallback = ''): string {
  const value = source[key]
  return typeof value === 'string' ? value : fallback
}

function bool(source: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = source[key]
  return typeof value === 'boolean' ? value : fallback
}

function boundedInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) return fallback
  return value < min || value > max ? fallback : value
}

/** A stored value → `PluginConfig`, defaulting a missing/junk field rather than throwing. */
export function readPluginConfig(value: unknown): PluginConfig {
  const source = asObject(value)
  return {
    reconcileIntervalSec: boundedInt(source.reconcileIntervalSec, MIN_RECONCILE_INTERVAL_SEC, MAX_RECONCILE_INTERVAL_SEC, DEFAULT_RECONCILE_INTERVAL_SEC),
    requireConfirm: bool(source, 'requireConfirm', true),
    autoRepair: bool(source, 'autoRepair', false),
  }
}

/** The exact object `config` is stored as — the write half of `readPluginConfig`. */
export function writePluginConfig(config: PluginConfig): Record<string, unknown> {
  return {
    reconcileIntervalSec: config.reconcileIntervalSec,
    requireConfirm: config.requireConfirm,
    autoRepair: config.autoRepair,
  }
}

/** A stored value → `RouterConfig`, defaulting a missing/junk field rather than throwing — used only server-side (§4.10: the browser never reads this key's value back). */
export function readRouterConfig(value: unknown): RouterConfig {
  const source = asObject(value)
  return {
    baseUrl: str(source, 'baseUrl'),
    username: str(source, 'username'),
    password: str(source, 'password'),
    tls: bool(source, 'tls', false),
    timeoutMs: boundedInt(source.timeoutMs, MIN_ROUTER_TIMEOUT_MS, MAX_ROUTER_TIMEOUT_MS, DEFAULT_ROUTER_TIMEOUT_MS),
  }
}

/** The exact object `router` is stored as — the write half of `readRouterConfig`. */
export function writeRouterConfig(config: RouterConfig): Record<string, unknown> {
  return {
    baseUrl: config.baseUrl,
    username: config.username,
    password: config.password,
    tls: config.tls,
    timeoutMs: config.timeoutMs,
  }
}

/** Whether a `RouterConfig` has enough to attempt a connection at all — the three fields a `MikrotikRestClient` cannot do without. */
export function isRouterConfigured(config: RouterConfig): boolean {
  return config.baseUrl.trim().length > 0 && config.username.trim().length > 0 && config.password.length > 0
}

// ---------------------------------------------------------------------------
// The per-device `assignment` KV (§4.9) — step 122.6. Device-scoped via
// `storage.forDevice`, so Forget deletes it for free in the same transaction
// (§3.5, verified against `lifecycle.ts:278`).
//
// A single assignment made from the Assignments tab (this step) is modelled
// as living in the IMPLICIT group named `default` (§9 Q1: "standalone
// assignments live in an implicit group named `default`, so one invariant
// covers both cases with no special-casing"). No `group:default` KV row is
// ever created for this — `default` is simply the marker `groupId` these
// rules carry until named groups (122.7's algebra, 122.8's CRUD) exist to
// supersede it.
// ---------------------------------------------------------------------------

export const ASSIGNMENT_KEY = 'assignment'

export const DEFAULT_GROUP_ID = 'default'
export const DEFAULT_GROUP_NAME = 'Default'

/**
 * The plugin's own per-device record. `lanIpSource`/`leaseKind` are kept as
 * plain strings rather than importing `identity-bridge.ts`'s unions — this
 * file imports nothing (this file's own header) so the UI bundle never
 * inlines service code. Values are `identity-bridge.ts`'s own spellings
 * (`'transport' | 'probe' | 'manual'` and `'static' | 'dynamic' | 'none'`), or
 * `''` when nothing has been resolved yet.
 */
export interface StoredAssignment {
  /** The routing table (egress path) this device is assigned to. `''` means "no path chosen yet" — a device can carry a noted LAN IP with no path, or nothing at all. */
  pathId: string
  /** Always {@link DEFAULT_GROUP_ID} until named groups (122.8) exist to be assigned instead. `''` for an empty/never-written record. */
  groupId: string
  /** The device's LAN IP, per §3.4's identity bridge. `''` when none is known. */
  lanIp: string
  lanIpSource: string
  leaseKind: string
  /** Unix seconds — when this assignment was first noted. Sticky: an edit that changes the path or the LAN IP does not reset it. */
  since: number
  /**
   * Unix seconds — when `verify-egress` (122.10) last successfully observed
   * this device's own public IP. `0`/absent means never verified. Optional
   * (unlike `since` above) so every EXISTING `StoredAssignment` literal —
   * `groups-service.ts`'s `overridesFor`, the Assignments tab's own writes —
   * stays valid without naming a field it has no reason to know about;
   * `readAssignment` below still always returns a concrete value (`0`).
   */
  lastVerifiedAt?: number
  /** The public IP `verify-egress` (122.10) last observed for this device, whatever path it was assigned to at the time. `''`/absent means never verified. Optional for the same reason as `lastVerifiedAt` above. */
  lastPublicIp?: string
}

export const EMPTY_ASSIGNMENT: StoredAssignment = { pathId: '', groupId: '', lanIp: '', lanIpSource: '', leaseKind: '', since: 0, lastVerifiedAt: 0, lastPublicIp: '' }

function nonNegativeIntOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0
}

/** A stored value → `StoredAssignment`, defaulting a missing/junk field rather than throwing — this is the plugin's own scratch space, the same discipline `readRouterConfig`/`readPluginConfig` above already use. */
export function readAssignment(value: unknown): StoredAssignment {
  const source = asObject(value)
  return {
    pathId: str(source, 'pathId'),
    groupId: str(source, 'groupId'),
    lanIp: str(source, 'lanIp'),
    lanIpSource: str(source, 'lanIpSource'),
    leaseKind: str(source, 'leaseKind'),
    since: nonNegativeIntOrZero(source.since),
    lastVerifiedAt: nonNegativeIntOrZero(source.lastVerifiedAt),
    lastPublicIp: str(source, 'lastPublicIp'),
  }
}

/** The exact object `assignment` is stored as — the write half of `readAssignment`. A pre-122.10 caller's literal (missing the two verification fields, both optional on `StoredAssignment`) still writes cleanly: `?? 0`/`?? ''` supply the same concrete defaults `readAssignment` would produce for an absent key, so a round trip through an old call site never loses the "never verified" meaning. */
export function writeAssignment(assignment: StoredAssignment): Record<string, unknown> {
  return {
    pathId: assignment.pathId,
    groupId: assignment.groupId,
    lanIp: assignment.lanIp,
    lanIpSource: assignment.lanIpSource,
    leaseKind: assignment.leaseKind,
    since: assignment.since,
    lastVerifiedAt: assignment.lastVerifiedAt ?? 0,
    lastPublicIp: assignment.lastPublicIp ?? '',
  }
}

/** Whether a `StoredAssignment` carries nothing worth showing — an empty/never-written record. */
export function isAssignmentEmpty(assignment: StoredAssignment): boolean {
  return assignment.pathId === '' && assignment.lanIp === ''
}

// ---------------------------------------------------------------------------
// Naming a device (plan 124 §3.1, §4.1)
// ---------------------------------------------------------------------------

/**
 * `#7 SM-F721U1`, or the bare label when the device has no number.
 *
 * **This is the service half's copy of `@enkaku/ui`'s `formatDeviceName`, and
 * the duplication is deliberate rather than an oversight.** Plan 124 §4.1 put
 * the one browser-side definition in `@enkaku/ui` precisely so Studio and
 * every plugin screen compose a name with the same code — but `@enkaku/ui` is
 * a React package that this plugin lists as a *dev* dependency and that
 * `packages/sdk/src/cli/build-ui.ts`'s `UI_EXTERNALS` supplies to the UI
 * bundle at runtime. `src/service/**` runs in the core's Bun process, where
 * importing it would pull React and 30 components into a module that renders
 * nothing. The core's own `formatDeviceLabel`
 * (`packages/core/src/registry/device-number.ts`) is equally out of reach:
 * a plugin may not import `@enkaku/core`.
 *
 * So this file — the one module both halves already share, and which by its
 * own header imports nothing — carries the third copy of a five-token rule.
 * All three must agree character for character, because the same device is
 * named by a core log line, by this plugin's local-exception report and by
 * the Assignments tab within seconds of each other, and an operator reading
 * all three has to see one string.
 *
 * `null` and `undefined` are both "no number" and both render the bare label:
 * a device whose reservation was released is a legitimate state, never an
 * error, and must never print `#null` (plan 124 criterion 7).
 */
export function deviceNameWithNumber(number: number | null | undefined, label: string): string {
  return number == null ? label : `#${number} ${label}`
}
