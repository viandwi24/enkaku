import { api, z } from '@enkaku/ui'
import {
  CONFIG_KEY,
  DEFAULT_PLUGIN_CONFIG,
  DEFAULT_ROUTER_CONFIG,
  ROUTER_KEY,
  isRouterConfigured,
  readPluginConfig,
  readRouterConfig,
  writePluginConfig,
  writeRouterConfig,
  type PluginConfig,
  type RouterConfig,
} from '../../shared'

/**
 * The farm, from the browser (plan 111 §3.4) — the same `api()`/`coreBase()`
 * shape `plugins/proxy-manager/src/ui/parts/api.ts` documents at length; see
 * that file's own header for why this is only thirty-odd lines rather than a
 * hand-written `fetch` wrapper. What is left here is what genuinely belongs
 * to this pack: the shapes it reads and the read/write pair for `config` and
 * `router`.
 */

/** This plugin's own doors: its KV namespace and its assets. The namespace is taken from this path server-side and can never be another plugin's. */
export const PLUGIN_API = '/api/plugins/mikrotik-routing'

/**
 * This pack's OWN service handlers (`ctx.onRequest`, plan 109 step 109.6,
 * `service/handlers.ts`), mounted by the core at
 * `/api/plugins/mikrotik-routing/http/*` with the core's auth, TLS, CORS,
 * rate limiting and audit applying unchanged. Reads only, this step —
 * `inventory`, `rules`, `doctor`.
 */
export const ROUTER_HTTP_API = `${PLUGIN_API}/http`

// ---------------------------------------------------------------------------
// KV — `config` (plain) and `router` (secret, never read back)
// ---------------------------------------------------------------------------

/**
 * Declared here rather than imported from `@enkaku/protocol` — that package
 * is not external to a plugin's build, so importing its barrel would pull the
 * farm's whole schema catalogue into this pack's `ui/index.js` (the same
 * reasoning `plugins/proxy-manager/src/ui/parts/api.ts` gives for its
 * identical `KvEntrySchema`).
 */
const KvEntrySchema = z.looseObject({
  key: z.string(),
  value: z.unknown(),
  secret: z.boolean(),
  version: z.number(),
  updatedAt: z.number(),
})
export type KvEntry = z.infer<typeof KvEntrySchema>

export const KvPageSchema = z.looseObject({ items: z.array(KvEntrySchema), nextCursor: z.string().nullable() })
export type KvPage = z.infer<typeof KvPageSchema>

/** The schema for a write whose body this screen does not read — `api()` makes the schema a required argument, so "I do not care" is written down rather than defaulted into. */
export const IgnoredSchema = z.unknown()

/**
 * `GET .../data?scope=global&prefix=<key>&limit=1` for an exact-key read —
 * the same trick `plugins/proxy-manager`'s own catalogue read uses for a
 * whole prefix, narrowed to one row because `config`/`router` are each a
 * single key, not a family of them. Returns `null` when nothing has ever
 * been saved.
 */
export async function readEntry(key: string): Promise<KvEntry | null> {
  const page = await api(`${PLUGIN_API}/data?scope=global&prefix=${encodeURIComponent(key)}&limit=1`, KvPageSchema)
  return page.items.find((entry) => entry.key === key) ?? null
}

/** The plugin's own reconcile-cadence and apply-safety preferences (§4.9). `null` entry (nothing saved yet) reads as the plan's own stated defaults. */
export async function loadPluginConfig(): Promise<PluginConfig> {
  const entry = await readEntry(CONFIG_KEY)
  return entry ? readPluginConfig(entry.value) : DEFAULT_PLUGIN_CONFIG
}

/** Non-secret — `secret: false` matches `plugins/proxy-manager`'s own rule that a field which is not a credential must not be marked one, or the row's own value would be redacted right back at the screen that just wrote it. */
export async function savePluginConfig(config: PluginConfig): Promise<void> {
  await api(`${PLUGIN_API}/data/entry`, IgnoredSchema, {
    method: 'PUT',
    json: { scope: 'global', key: CONFIG_KEY, value: writePluginConfig(config), secret: false },
  })
}

/**
 * Whether a `router` entry exists at all — the ONLY thing the browser can
 * ever learn about it (§4.10: no reveal route, and `secret: true` means the
 * generic `GET .../data` route answers this key's `value` as `null` even to
 * an operator holding `plugin.data`). Carries `updatedAt` so the Settings tab
 * can say when the connection was last saved without pretending to show what
 * it is.
 */
export interface RouterPresence {
  saved: boolean
  updatedAt: number | null
}

export async function loadRouterPresence(): Promise<RouterPresence> {
  const entry = await readEntry(ROUTER_KEY)
  return { saved: entry !== null, updatedAt: entry?.updatedAt ?? null }
}

/**
 * The write half — the ONE place this pack writes the router connection, so
 * the two flags that make it safe cannot be right on one path and forgotten
 * on another (the same reason `plugins/proxy-manager/src/ui/parts/
 * catalogue.tsx`'s `putSecret` is a function and not two lines at each call
 * site). `secret: true, hint: false` together: `hint` defaults to `true` on
 * the store, which would put a display fragment of the JSON-stringified
 * connection (password included) on the row for anyone holding `plugin.data`
 * to read — exactly the leak `hint: false` exists to decline.
 *
 * Always writes the WHOLE object — there is no partial update, because a
 * `RouterConfig` this screen cannot read back cannot be merged with what is
 * already saved. The caller (`SettingsTab`) is what refuses to call this with
 * an incomplete `RouterConfig` in the first place.
 */
export async function saveRouterConfig(config: RouterConfig): Promise<void> {
  await api(`${PLUGIN_API}/data/entry`, IgnoredSchema, {
    method: 'PUT',
    json: { scope: 'global', key: ROUTER_KEY, value: writeRouterConfig(config), secret: true, hint: false },
  })
}

export { DEFAULT_PLUGIN_CONFIG, DEFAULT_ROUTER_CONFIG, isRouterConfigured, readRouterConfig }
export type { PluginConfig, RouterConfig }

// ---------------------------------------------------------------------------
// The router's own state — inventory, rules, doctor (`service/handlers.ts`)
// ---------------------------------------------------------------------------

/** What every one of the three routes answers with when it could not even reach a driver, or when the driver's own call threw — the one refusal shape, always `200`. */
const RefusalSchema = z.looseObject({ ok: z.literal(false), code: z.string(), message: z.string() })
export type Refusal = z.infer<typeof RefusalSchema>

const PathSchema = z.looseObject({ id: z.string(), table: z.string(), gateway: z.string().nullable(), hasDefaultRoute: z.boolean() })
const PathHealthSchema = z.looseObject({ pathId: z.string(), up: z.boolean(), checkedAt: z.number() })
const IfaceSchema = z.looseObject({ id: z.string(), name: z.string(), type: z.string().nullable(), running: z.boolean(), disabled: z.boolean() })
const LeaseSchema = z.looseObject({ id: z.string(), address: z.string().nullable(), macAddress: z.string().nullable(), dynamic: z.boolean(), status: z.string().nullable() })

export const InventoryResultSchema = z.union([
  z.looseObject({
    ok: z.literal(true),
    inventory: z.looseObject({
      paths: z.array(PathSchema),
      interfaces: z.array(IfaceSchema),
      health: z.array(PathHealthSchema),
      leases: z.array(LeaseSchema),
    }),
  }),
  RefusalSchema,
])
export type InventoryResult = z.infer<typeof InventoryResultSchema>
export type Path = z.infer<typeof PathSchema>
export type PathHealth = z.infer<typeof PathHealthSchema>
export type Iface = z.infer<typeof IfaceSchema>

const MarkerSchema = z.looseObject({ groupId: z.string(), endpointKey: z.string() })
const RuleRowSchema = z.looseObject({
  id: z.string(),
  comment: z.string(),
  srcAddress: z.string().nullable(),
  table: z.string().nullable(),
  disabled: z.boolean(),
  inactive: z.boolean(),
  managed: z.boolean(),
  marker: MarkerSchema.nullable(),
  markerIssue: z.string().nullable(),
  isLocalException: z.boolean(),
})
export type RuleRow = z.infer<typeof RuleRowSchema>

export const RulesResultSchema = z.union([z.looseObject({ ok: z.literal(true), items: z.array(RuleRowSchema) }), RefusalSchema])
export type RulesResult = z.infer<typeof RulesResultSchema>

const DoctorReportSchema = z.looseObject({
  ok: z.literal(true),
  reachable: z.boolean(),
  authenticated: z.boolean(),
  restVersion: z.string().nullable(),
  localException: z.looseObject({ present: z.boolean(), rule: z.unknown().nullable() }),
  managedRuleCount: z.number(),
  foreignRuleCount: z.number(),
  fixCommands: z.array(z.string()),
  errors: z.array(z.string()),
})
export const DoctorResultSchema = z.union([DoctorReportSchema, RefusalSchema])
export type DoctorResult = z.infer<typeof DoctorResultSchema>

export function isRefusal(result: { ok: boolean }): result is Refusal {
  return result.ok === false
}

export async function fetchInventory(): Promise<InventoryResult> {
  return api(`${ROUTER_HTTP_API}/inventory`, InventoryResultSchema)
}

export async function fetchRules(): Promise<RulesResult> {
  return api(`${ROUTER_HTTP_API}/rules`, RulesResultSchema)
}

export async function runDoctor(): Promise<DoctorResult> {
  return api(`${ROUTER_HTTP_API}/doctor`, DoctorResultSchema, { method: 'POST', json: {} })
}
