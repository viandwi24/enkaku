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
 * The exact comment the operator's local-exception rule must carry (§3.2).
 * The plugin never creates or edits this rule — REST has no `move`, so it
 * could not position it correctly even if it wanted to — it only checks for
 * it and reports its absence.
 */
export const LOCAL_EXCEPTION_COMMENT = 'farm: local exception'

/**
 * The exact commands `doctor()` names when the local-exception rule is
 * missing, copied verbatim from plan 122 §3.2 (`<farm-subnet>` is a
 * placeholder the operator fills in themselves — the plugin has no way to
 * know the farm's own subnet, and must not guess one).
 */
export const LOCAL_EXCEPTION_FIX_COMMANDS = [
  '/routing rule add src-address=<farm-subnet> dst-address=192.168.0.0/16 \\',
  '    action=lookup table=main comment="farm: local exception"',
  '/routing rule move [find comment="farm: local exception"] destination=0',
] as const

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
