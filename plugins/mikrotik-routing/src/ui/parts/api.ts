import { api, z } from '@enkaku/ui'
import {
  ASSIGNMENT_KEY,
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
  type StoredAssignment,
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

/**
 * `CoreAddressResult` (`service/core-address.ts`) — which path derived the
 * address the device reaches the core at, so the Settings tab can say so
 * (§5 step 122.12 fix 2) rather than silently assuming a subnet.
 */
const CoreAddressResultSchema = z.union([z.looseObject({ kind: z.literal('derived'), address: z.string() }), z.looseObject({ kind: z.literal('rfc1918-fallback'), reason: z.string() })])
export type CoreAddressResult = z.infer<typeof CoreAddressResultSchema>

/**
 * `LocalExceptionReport` (`service/local-exception.ts`) — the corrected,
 * behaviour-based, per-device §3.2 check (step 122.12), replacing the old
 * `{ present, rule }` shape that matched on comment text alone. Three
 * states, not two (fix 3): `missing` (no candidate rule at all), `partial`
 * (a candidate exists but leaves devices uncovered or mis-positioned — the
 * state that LOOKS safe and is not), `ok`.
 */
const ProtectedDeviceSchema = z.looseObject({ id: z.string(), label: z.string(), address: z.string() })
const LocalExceptionResultSchema = z.looseObject({
  status: z.union([z.literal('missing'), z.literal('partial'), z.literal('ok')]),
  message: z.string(),
  uncoveredDevices: z.array(ProtectedDeviceSchema),
  suggestedFixCommands: z.array(z.string()),
  coreAddress: CoreAddressResultSchema,
})
export type LocalExceptionResult = z.infer<typeof LocalExceptionResultSchema>

const DoctorReportSchema = z.looseObject({
  ok: z.literal(true),
  reachable: z.boolean(),
  authenticated: z.boolean(),
  restVersion: z.string().nullable(),
  managedRuleCount: z.number(),
  foreignRuleCount: z.number(),
  errors: z.array(z.string()),
  localException: LocalExceptionResultSchema,
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

// ---------------------------------------------------------------------------
// Reconcile — step 122.9. `reconcile.ts`'s `Drift` union has six shapes; kept
// loose here (`.looseObject`, only `kind` pinned) rather than a full
// discriminated union, the same trade `DeviceLanAddressSchema` above makes —
// this screen only ever RENDERS a drift item (via its own `kind`-keyed
// switch, mirroring `reconcile.ts`'s own `describeDrift`), it never branches
// server-side logic on it, so a field this build does not yet know about
// must never break the whole tab.
// ---------------------------------------------------------------------------

const DriftSchema = z.looseObject({ kind: z.string() })
export type Drift = z.infer<typeof DriftSchema>

const RepairOutcomeSchema = z.looseObject({ outcome: z.string(), message: z.string().optional() })

const ReconcileOkSchema = z.looseObject({
  ok: z.literal(true),
  drifts: z.array(DriftSchema),
  newDrifts: z.array(DriftSchema),
  autoRepaired: z.array(RepairOutcomeSchema),
  localException: LocalExceptionResultSchema,
  deviceLabels: z.record(z.string(), z.string()),
  checkedAt: z.number(),
})
export const ReconcileResultSchema = z.union([ReconcileOkSchema, RefusalSchema])
export type ReconcileResult = z.infer<typeof ReconcileResultSchema>

/** The "Reconcile now" path (§4.7, §5 step 122.9) — one tick, run right now rather than waiting for the interval. Shares the running loop's own single-flight guard and notify-dedup state (`reconcile.ts`'s own header) — this is not a second, disconnected pass. */
export async function runReconcileNow(): Promise<ReconcileResult> {
  return api(`${ROUTER_HTTP_API}/reconcile`, ReconcileResultSchema, { method: 'POST', json: {} })
}

// ---------------------------------------------------------------------------
// Assignments — step 122.6. The `fleet`/`plan`/`apply` routes
// (`service/apply-routes.ts`), plus the assignment KV note itself, written
// straight from the browser (never touching the router — see `apply.ts`'s
// own header for why that is the right split).
// ---------------------------------------------------------------------------

const StoredAssignmentSchema = z.looseObject({
  pathId: z.string(),
  groupId: z.string(),
  lanIp: z.string(),
  lanIpSource: z.string(),
  leaseKind: z.string(),
  since: z.number(),
})

/** `identity-bridge.ts`'s `DeviceLanAddress` — a discriminated union on `state`, mirrored here loosely (`.passthrough()`) so an added field never breaks this screen. */
const DeviceLanAddressSchema = z.union([
  z.looseObject({
    deviceId: z.string(),
    stableId: z.string(),
    label: z.string(),
    state: z.literal('resolved'),
    lanIp: z.string(),
    lanIpSource: z.string(),
    leaseKind: z.string(),
  }),
  z.looseObject({ deviceId: z.string(), stableId: z.string(), label: z.string(), state: z.literal('needs-address') }),
])
export type DeviceLanAddress = z.infer<typeof DeviceLanAddressSchema>

const FleetDeviceRowSchema = z.looseObject({
  deviceId: z.string(),
  stableId: z.string(),
  label: z.string(),
  lan: DeviceLanAddressSchema,
  assignment: StoredAssignmentSchema,
})
export type FleetDeviceRow = z.infer<typeof FleetDeviceRowSchema>

const FleetStateSchema = z.looseObject({
  devices: z.array(FleetDeviceRowSchema),
  paths: z.array(PathSchema),
  health: z.array(PathHealthSchema),
})

export const FleetResultSchema = z.union([z.looseObject({ ok: z.literal(true), fleet: FleetStateSchema }), RefusalSchema])
export type FleetResult = z.infer<typeof FleetResultSchema>

/**
 * One row of `planner.ts`'s `PlanRow` — a five-kind discriminated union with
 * different fields per kind. Modelled loosely (every field optional except
 * `kind`) rather than the full union: this screen only ever reads a handful
 * of fields to render one line per row, and a `.passthrough()` per-kind
 * schema would buy nothing a plain read cannot already do safely.
 */
const PlanRowSchema = z.looseObject({
  kind: z.union([z.literal('create'), z.literal('update'), z.literal('delete'), z.literal('skip'), z.literal('foreign')]),
  endpointKey: z.string().nullable().optional(),
  pathId: z.string().nullable().optional(),
  fromPathId: z.string().optional(),
  toPathId: z.string().optional(),
  groupId: z.string().nullable().optional(),
  groupName: z.string().optional(),
  reason: z.string().optional(),
  rule: z.looseObject({ '.id': z.string(), comment: z.string() }).optional(),
})
export type PlanRow = z.infer<typeof PlanRowSchema>

const BlockedAssignmentSchema = z.looseObject({ deviceId: z.string(), label: z.string(), reason: z.string() })
export type BlockedAssignment = z.infer<typeof BlockedAssignmentSchema>

const PlanPreviewOkSchema = z.looseObject({ ok: z.literal(true), rows: z.array(PlanRowSchema), localException: LocalExceptionResultSchema, blocked: z.array(BlockedAssignmentSchema) })
export const PlanPreviewResultSchema = z.union([PlanPreviewOkSchema, RefusalSchema])
export type PlanPreviewResult = z.infer<typeof PlanPreviewResultSchema>

const RowOutcomeSchema = z.looseObject({ row: PlanRowSchema, outcome: z.union([z.literal('applied'), z.literal('error')]), message: z.string().optional() })

const ApplyOkSchema = z.looseObject({
  ok: z.literal(true),
  rows: z.array(PlanRowSchema),
  outcomes: z.array(RowOutcomeSchema),
  localException: LocalExceptionResultSchema,
  blocked: z.array(BlockedAssignmentSchema),
})
const ApplyRefusalSchema = z.looseObject({ ok: z.literal(false), code: z.string(), message: z.string(), localException: LocalExceptionResultSchema.optional() })
export const ApplyResultSchema = z.union([ApplyOkSchema, ApplyRefusalSchema])
export type ApplyResult = z.infer<typeof ApplyResultSchema>

export async function fetchFleet(): Promise<FleetResult> {
  return api(`${ROUTER_HTTP_API}/fleet`, FleetResultSchema)
}

export async function previewApplyPlan(): Promise<PlanPreviewResult> {
  return api(`${ROUTER_HTTP_API}/plan`, PlanPreviewResultSchema, { method: 'POST', json: {} })
}

export async function runApply(): Promise<ApplyResult> {
  return api(`${ROUTER_HTTP_API}/apply`, ApplyResultSchema, { method: 'POST', json: {} })
}

/**
 * The `assignment` note itself — a plain (non-secret), device-scoped KV
 * write straight from the browser through the core's generic
 * `PUT .../data/entry?scope=device&...` route, the same door
 * `plugins/proxy-manager`'s own Assignments tab writes its `assigned` note
 * through. This changes nothing on the router: `apply.ts`'s own header
 * explains why the note and the write are deliberately two different acts.
 */
// ---------------------------------------------------------------------------
// Groups — step 122.8. `service/groups-routes.ts`'s five routes, and the
// `Group`/`GroupEntry` shape (§4.9) mirrored loosely (`.looseObject`) the
// same way every other server shape on this page is — this screen only ever
// reads a handful of fields, and a `.passthrough()`-equivalent schema never
// breaks on a field this build does not yet know about.
// ---------------------------------------------------------------------------

const GroupEntrySchema = z.looseObject({ deviceId: z.string(), lanIp: z.string(), pathId: z.string() })
export type GroupEntry = z.infer<typeof GroupEntrySchema>

const OnDeactivateSchema = z.union([z.literal('remove-rules'), z.literal('disable-rules')])
const FailoverPolicySchema = z.union([z.literal('none'), z.literal('substitute')])

const GroupSchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  note: z.string(),
  entries: z.array(GroupEntrySchema),
  active: z.boolean(),
  onDeactivate: OnDeactivateSchema,
  failoverPolicy: FailoverPolicySchema,
  updatedAt: z.number(),
})
export type Group = z.infer<typeof GroupSchema>
export type GroupOnDeactivate = z.infer<typeof OnDeactivateSchema>
export type GroupFailoverPolicy = z.infer<typeof FailoverPolicySchema>

export const GroupsListResultSchema = z.union([z.looseObject({ ok: z.literal(true), items: z.array(GroupSchema) }), RefusalSchema])
export type GroupsListResult = z.infer<typeof GroupsListResultSchema>

export const SaveGroupResultSchema = z.union([z.looseObject({ ok: z.literal(true), group: GroupSchema }), RefusalSchema])
export type SaveGroupResult = z.infer<typeof SaveGroupResultSchema>

export const DeleteGroupResultSchema = z.union([z.looseObject({ ok: z.literal(true) }), RefusalSchema])
export type DeleteGroupResult = z.infer<typeof DeleteGroupResultSchema>

const GroupConflictSchema = z.looseObject({ group: GroupSchema, overlappingDeviceIds: z.array(z.string()) })
export type GroupConflict = z.infer<typeof GroupConflictSchema>

/**
 * `ActivationDecision` (`service/groups.ts`) — §4.6 steps 1-3's outcome,
 * mirrored here for the non-mutating preview (`group-activate-preview`,
 * the gap fix, 2026-08-21).
 */
const ActivationDecisionSchema = z.union([
  z.looseObject({ kind: z.literal('clean') }),
  z.looseObject({ kind: z.literal('refuse'), conflicts: z.array(GroupConflictSchema) }),
  z.looseObject({ kind: z.literal('force'), toDeactivate: z.array(GroupConflictSchema) }),
])
export type ActivationDecision = z.infer<typeof ActivationDecisionSchema>

const DeactivateOutcomeSchema = z.looseObject({ deviceId: z.string(), action: z.union([z.literal('deleted'), z.literal('disabled'), z.literal('left-alone')]), reason: z.string().optional() })
export type DeactivateOutcome = z.infer<typeof DeactivateOutcomeSchema>

const ActivateOkSchema = z.looseObject({
  ok: z.literal(true),
  group: GroupSchema,
  deactivated: z.array(z.looseObject({ group: GroupSchema, outcomes: z.array(DeactivateOutcomeSchema) })),
  apply: z.looseObject({ ok: z.literal(true), rows: z.array(PlanRowSchema), outcomes: z.array(RowOutcomeSchema) }),
})
export type ActivateOk = z.infer<typeof ActivateOkSchema>

const ActivateConflictSchema = z.looseObject({ ok: z.literal(false), code: z.literal('E_GROUP_CONFLICT'), message: z.string(), conflicts: z.array(GroupConflictSchema) })
export type ActivateConflict = z.infer<typeof ActivateConflictSchema>

export const ActivateResultSchema = z.union([ActivateOkSchema, ActivateConflictSchema, RefusalSchema])
export type ActivateResult = z.infer<typeof ActivateResultSchema>

/**
 * A proper type predicate, rather than a plain `'conflicts' in result` check
 * at the call site — the zod-inferred union (every branch a `.looseObject`,
 * hence an index signature) does not narrow a later field's type through a
 * structural `in` check alone; TypeScript trusts an explicit `result is T`
 * annotation regardless, so this is the one place that check needs writing.
 */
export function isGroupConflict(result: ActivateResult): result is ActivateConflict {
  return !result.ok && result.code === 'E_GROUP_CONFLICT'
}

export const DeactivateResultSchema = z.union([z.looseObject({ ok: z.literal(true), group: GroupSchema, outcomes: z.array(DeactivateOutcomeSchema) }), RefusalSchema])
export type DeactivateResult = z.infer<typeof DeactivateResultSchema>

export async function fetchGroups(): Promise<GroupsListResult> {
  return api(`${ROUTER_HTTP_API}/groups`, GroupsListResultSchema)
}

export interface SaveGroupInput {
  id: string
  name: string
  note: string
  entries: GroupEntry[]
  onDeactivate: GroupOnDeactivate
  failoverPolicy: GroupFailoverPolicy
}

export async function saveGroupApi(input: SaveGroupInput): Promise<SaveGroupResult> {
  return api(`${ROUTER_HTTP_API}/group-save`, SaveGroupResultSchema, { method: 'PUT', json: input })
}

export async function deleteGroupApi(id: string): Promise<DeleteGroupResult> {
  return api(`${ROUTER_HTTP_API}/group-delete?id=${encodeURIComponent(id)}`, DeleteGroupResultSchema, { method: 'DELETE' })
}

/**
 * `ActivatePreviewOk` (`service/groups-service.ts`) — the gap fix: the exact
 * §4.4 plan `group-activate` would execute, the `decideActivation` outcome,
 * and the §3.2 local-exception state, computed with zero writes. `plan`
 * mirrors `PlanRowSchema` loosely, exactly as `PlanPreviewOkSchema` above
 * does for the Assignments tab's own preview.
 */
const ActivatePreviewOkSchema = z.looseObject({
  ok: z.literal(true),
  group: GroupSchema,
  decision: ActivationDecisionSchema,
  plan: z.array(PlanRowSchema),
  localException: LocalExceptionResultSchema,
  blocked: z.array(BlockedAssignmentSchema),
})
export const ActivatePreviewResultSchema = z.union([ActivatePreviewOkSchema, RefusalSchema])
export type ActivatePreviewResult = z.infer<typeof ActivatePreviewResultSchema>

export async function previewActivateGroupApi(id: string, force: boolean): Promise<ActivatePreviewResult> {
  return api(`${ROUTER_HTTP_API}/group-activate-preview`, ActivatePreviewResultSchema, { method: 'POST', json: { id, force } })
}

export async function activateGroupApi(id: string, force: boolean): Promise<ActivateResult> {
  return api(`${ROUTER_HTTP_API}/group-activate`, ActivateResultSchema, { method: 'POST', json: { id, force } })
}

export async function deactivateGroupApi(id: string): Promise<DeactivateResult> {
  return api(`${ROUTER_HTTP_API}/group-deactivate`, DeactivateResultSchema, { method: 'POST', json: { id } })
}

export async function saveAssignment(stableId: string, assignment: StoredAssignment): Promise<void> {
  await api(`${PLUGIN_API}/data/entry`, IgnoredSchema, {
    method: 'PUT',
    json: { scope: 'device', stableId, key: ASSIGNMENT_KEY, value: assignment, secret: false },
  })
}

export async function clearAssignment(stableId: string): Promise<void> {
  await api(`${PLUGIN_API}/data/entry?scope=device&stableId=${encodeURIComponent(stableId)}&key=${encodeURIComponent(ASSIGNMENT_KEY)}`, IgnoredSchema, { method: 'DELETE' })
}

export type { StoredAssignment }
