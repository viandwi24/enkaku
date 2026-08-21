import { z } from 'zod'

/**
 * The group model and the conflict algebra — plan 122 §4.6 (groups, the
 * exclusivity invariant, the activation transaction) and §4.9 (the
 * `group:<id>` KV shape). Step 122.7's PURE LOGIC portion only: everything
 * below takes plain values in and returns plain values out — no
 * `ctx.storage`, no `RouterDriver`, no network call anywhere in this file.
 *
 * ## What this file gives the wiring step
 *
 * 1. **The `group:<id>` value's shape** (§4.9) — `GroupSchema` (Zod, the
 *    boundary declaration, the same role `plugins/proxy-manager/src/record.ts`'s
 *    `ProxyRecordSchema` plays for that pack) plus `readGroup`/`writeGroup`,
 *    the same read-time-default discipline `plugins/proxy-manager/src/shared.ts`'s
 *    `readProxyRecord`/`writeProxyRecord` established: a row written by an
 *    older shape of this plugin, or hand-edited through `kv.manage`, reads as
 *    sane defaults instead of throwing inside whatever renders it.
 * 2. **The conflict predicate** (§4.6): `conflict(A, B) ⇔ devices(A) ∩
 *    devices(B) ≠ ∅`, plus `overlappingDeviceIds`, the same intersection with
 *    the actual ids kept — the plan is explicit that "conflict" alone is not
 *    actionable and the exact overlapping devices are ("Jadwal-2 conflicts
 *    with active Jadwal-1 on flip4-03, flip4-04").
 * 3. **The activation decision**, `decideActivation` — §4.6's `activate()`
 *    pseudocode steps 1-3: resolve the candidate's device set, compute
 *    conflicts against every group CURRENTLY active, and either clear the
 *    way, refuse by naming the conflicts, or — under `force` — name exactly
 *    which active groups would be deactivated first, before anything
 *    happens.
 *
 * ## Deliberately NOT here — left for the wiring step
 *
 * - **Actually reading/writing `group:<id>` rows.** Nothing in this file
 *   imports `@enkaku/sdk`; `readGroup`/`writeGroup` convert between a `Group`
 *   and the plain object a caller hands to/reads from `ctx.storage`, they do
 *   not call it.
 * - **§4.6 steps 4-7** — building the desired rule set, running §4.4's plan,
 *   applying it through `RouterDriver`, marking the group active, and
 *   writing the per-device `assignment` KV. All of those touch the router or
 *   KV. §4.4's planner is itself a separate pure module assigned to a
 *   concurrent worker (step 122.5) — this file does not attempt it.
 * - **Group CRUD beyond the shape itself** — minting a new group's `id`,
 *   refusing an empty name at save time, and so on are validation/UI/service
 *   concerns, not this file. One thing worth flagging rather than guessing
 *   at: a within-group duplicate `deviceId` (the same device named twice
 *   inside ONE group's own `entries`, assigned to two different paths at
 *   once) is a data-quality question about a single group, not the
 *   cross-group exclusivity invariant this file exists to prove — `devicesOf`
 *   below already de-duplicates for the purposes of conflict detection, but
 *   nothing here refuses a group that carries such a duplicate. That refusal,
 *   if wanted, belongs in the CRUD/validation layer.
 * - **Interpreting `onDeactivate`** — removing or disabling the group's rules
 *   is a router write. This file only carries the field.
 */

// ---------------------------------------------------------------------------
// The `group:<id>` KV key (§4.9)
// ---------------------------------------------------------------------------

/** Every group row lives under this prefix, one key per group — `group:jadwal-1`. */
export const GROUP_KEY_PREFIX = 'group:'

/** `group:jadwal-1` → `jadwal-1`; `null` for a key that is not a group row. */
export function groupIdFromKey(key: string): string | null {
  if (!key.startsWith(GROUP_KEY_PREFIX)) return null
  const id = key.slice(GROUP_KEY_PREFIX.length)
  return id.length > 0 ? id : null
}

/** `jadwal-1` → `group:jadwal-1`. */
export function groupKeyFor(id: string): string {
  return `${GROUP_KEY_PREFIX}${id}`
}

// ---------------------------------------------------------------------------
// The shape (§4.9)
// ---------------------------------------------------------------------------

/**
 * What happens to a group's managed rules when it deactivates (§4.6).
 * `remove-rules` is the default; `disable-rules` keeps the rule with
 * `disabled: true` set — cheaper to re-activate, visible in Winbox.
 */
export const GROUP_ON_DEACTIVATE = ['remove-rules', 'disable-rules'] as const
export type GroupOnDeactivate = (typeof GROUP_ON_DEACTIVATE)[number]

/**
 * How a group behaves when one of its assigned paths is down (§4.5).
 * `none` (default) reports and stops; `substitute` assigns the healthiest
 * least-loaded up path and marks the assignment as substituted.
 */
export const GROUP_FAILOVER_POLICIES = ['none', 'substitute'] as const
export type GroupFailoverPolicy = (typeof GROUP_FAILOVER_POLICIES)[number]

/** One device's claim inside a group — `{ deviceId, lanIp, pathId }`, exactly §4.9's shape. */
export const GroupEntrySchema = z.object({
  deviceId: z.string().min(1).describe('The device this entry claims. The set of every entry’s deviceId, deduplicated, is the group’s "device set" for the §4.6 exclusivity invariant.'),
  /** The identity bridge's own concern (§3.4, step 122.4) — carried here, not re-derived, and not required non-empty: a group may hold an entry for a device whose address is not yet known. */
  lanIp: z.string().default('').describe('The device’s LAN IP as of when this entry was written, per the §3.4 identity bridge. Not re-derived here.'),
  pathId: z.string().min(1).describe('The egress path (RouterOS routing-table name) this device is assigned to while the group is active.'),
})
export type GroupEntry = z.infer<typeof GroupEntrySchema>

/**
 * One group, as this plugin stores it under `group:<id>` — global KV (§4.9:
 * "a group is a farm-level object that outlives any device").
 */
export const GroupSchema = z.object({
  id: z.string().min(1).describe('Matches the `group:<id>` KV key this row is stored under.'),
  name: z.string().max(80).default('').describe('What an operator calls this group — shown in the conflict matrix and in a refusal ("Jadwal-2 conflicts with active Jadwal-1 on …").'),
  note: z.string().max(300).default(''),
  entries: z.array(GroupEntrySchema).default([]).describe('The devices this group claims and where each is assigned. Empty is a valid, if useless, group.'),
  /**
   * INTENT/OBSERVATION together, the one exception to the `enabled`-vs-
   * `running` split `plugins/proxy-manager`'s `ProxyRecord.enabled` draws —
   * a group's `active` flag is not "should be active", it IS the record of
   * whether the last activation transaction (§4.6 steps 4-7, the wiring
   * step) actually completed. `decideActivation` below reads it as-is: it
   * does not re-derive activeness from the router.
   */
  active: z.boolean().default(false),
  onDeactivate: z.enum(GROUP_ON_DEACTIVATE).default('remove-rules'),
  failoverPolicy: z.enum(GROUP_FAILOVER_POLICIES).default('none'),
  /** Unix seconds, matching every other plugin KV timestamp in this codebase (e.g. `plugins/proxy-manager`'s `ProxyProbeResult.at`). */
  updatedAt: z.number().int().nonnegative().default(0),
})
export type Group = z.infer<typeof GroupSchema>

// ---------------------------------------------------------------------------
// Reading a stored value — the read-time default discipline (mirrors
// `plugins/proxy-manager/src/shared.ts`'s `readProxyRecord`)
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

function oneOf<T extends string>(allowed: readonly T[], value: unknown, fallback: T): T {
  return allowed.find((v) => v === value) ?? fallback
}

function nonNegativeInt(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : fallback
}

/** One stored entry → `GroupEntry`, or `null` when it names no device or no path — dropped rather than kept as a landmine that would silently widen (or corrupt) the device set the conflict algebra reasons about. */
function readEntry(value: unknown): GroupEntry | null {
  const source = asObject(value)
  const deviceId = str(source, 'deviceId')
  const pathId = str(source, 'pathId')
  if (deviceId === '' || pathId === '') return null
  return { deviceId, lanIp: str(source, 'lanIp'), pathId }
}

/** A stored value → the ordered entry list. Not an array at all (absent, `null`, junk) reads as empty rather than throwing. */
function readEntries(value: unknown): GroupEntry[] {
  if (!Array.isArray(value)) return []
  const out: GroupEntry[] = []
  for (const item of value) {
    const entry = readEntry(item)
    if (entry !== null) out.push(entry)
  }
  return out
}

/**
 * A stored KV value → a `Group`, defensively. `id` is taken from the caller,
 * never read off the value: the KV KEY is the identity (`groupIdFromKey`),
 * so a value whose own `id` field disagrees with the key it is filed under
 * can never win.
 *
 * A `group:<id>` row is this plugin's own scratch space and an operator with
 * `kv.manage` can put anything under it, so a junk value renders as an empty,
 * inactive group rather than throwing inside whatever renders it — the exact
 * property `plugins/proxy-manager/src/shared.ts`'s `readProxyRecord` states
 * for itself and that `record.test.ts` asserts by round-tripping arbitrary
 * junk through it.
 */
export function readGroup(id: string, value: unknown): Group {
  const source = asObject(value)
  return {
    id,
    name: str(source, 'name'),
    note: str(source, 'note'),
    entries: readEntries(source.entries),
    active: bool(source, 'active', false),
    onDeactivate: oneOf(GROUP_ON_DEACTIVATE, source.onDeactivate, 'remove-rules'),
    failoverPolicy: oneOf(GROUP_FAILOVER_POLICIES, source.failoverPolicy, 'none'),
    updatedAt: nonNegativeInt(source.updatedAt, 0),
  }
}

/**
 * The exact object a group is STORED as — the write half of `readGroup`. One
 * function rather than an object literal at each call site, so a future
 * caller cannot silently write a shape `readGroup` does not expect back.
 */
export function writeGroup(group: Group): Record<string, unknown> {
  return {
    id: group.id,
    name: group.name,
    note: group.note,
    entries: group.entries.map((e) => ({ deviceId: e.deviceId, lanIp: e.lanIp, pathId: e.pathId })),
    active: group.active,
    onDeactivate: group.onDeactivate,
    failoverPolicy: group.failoverPolicy,
    updatedAt: group.updatedAt,
  }
}

// ---------------------------------------------------------------------------
// The conflict algebra (§4.6)
// ---------------------------------------------------------------------------

/**
 * A group's device set, deduplicated — the thing two groups either share or
 * do not. Takes anything with an `entries` array, not just a full `Group`,
 * so a caller mid-CRUD (a group not yet saved) can be checked the same way.
 */
export function devicesOf(group: Pick<Group, 'entries'>): Set<string> {
  return new Set(group.entries.map((e) => e.deviceId))
}

/**
 * The exact device ids two groups both claim, sorted for a stable,
 * deterministic, testable order. Empty when the two groups are disjoint.
 */
export function overlappingDeviceIds(a: Pick<Group, 'entries'>, b: Pick<Group, 'entries'>): string[] {
  const bDevices = devicesOf(b)
  const overlap: string[] = []
  for (const id of devicesOf(a)) if (bDevices.has(id)) overlap.push(id)
  return overlap.sort()
}

/**
 * §4.6's invariant, stated as code: `conflict(A, B) ⇔ devices(A) ∩
 * devices(B) ≠ ∅`. Per DEVICE, not global — two groups with entirely
 * disjoint device sets do not conflict and may both be active at once, which
 * is what makes groups usable across ~45 devices instead of one farm-wide
 * switch (this is the property the worked example in this file's own test
 * exists to prove in both directions).
 */
export function conflict(a: Pick<Group, 'entries'>, b: Pick<Group, 'entries'>): boolean {
  return overlappingDeviceIds(a, b).length > 0
}

// ---------------------------------------------------------------------------
// The activation decision (§4.6 `activate()`, steps 1-3)
// ---------------------------------------------------------------------------

/** One other active group the candidate conflicts with, and the exact devices both claim. */
export interface GroupConflict {
  group: Group
  overlappingDeviceIds: string[]
}

export type ActivationDecision =
  /** No active group claims any device this candidate claims — steps 4-7 (the wiring step) may proceed. */
  | { kind: 'clean' }
  /** `force` was false and at least one active group conflicts — steps 4-7 must not run. */
  | { kind: 'refuse'; conflicts: GroupConflict[] }
  /** `force` was true — these active groups would be deactivated FIRST, in the same operation, before the candidate's own rules are written. */
  | { kind: 'force'; toDeactivate: GroupConflict[] }

/**
 * §4.6's `activate()` pseudocode, steps 1-3, pure: resolve the candidate's
 * device set, compute conflicts against every group CURRENTLY active, and
 * decide the outcome — never touches a router or KV.
 *
 * `activeGroups` is meant to be exactly the groups the caller currently
 * believes are active; this function still filters to `g.active` itself
 * (and always excludes the candidate from conflicting with itself, so
 * re-activating an already-active group — a no-op — is never reported as a
 * conflict against its own prior activation) so a caller that forgot to
 * pre-filter cannot manufacture a spurious refusal.
 *
 * `force` exists because the common case — switching Jadwal-1 → Jadwal-2 on
 * the same devices — is *by definition* a conflicting activation (§4.6): the
 * candidate is the same devices, a different assignment. Doing it in two
 * steps (deactivate, then activate) would open a window where those devices
 * have no assignment at all, which is exactly what `force`'s single
 * operation avoids. This function does not decide whether an operation
 * SHOULD use `force` — that is an operator or a scheduled script's call
 * (§4.8's `activate-group`); it only computes what `force` would do.
 */
export function decideActivation(group: Group, activeGroups: readonly Group[], force: boolean): ActivationDecision {
  const others = activeGroups.filter((g) => g.active && g.id !== group.id)
  const conflicts: GroupConflict[] = []
  for (const other of others) {
    const overlap = overlappingDeviceIds(group, other)
    if (overlap.length > 0) conflicts.push({ group: other, overlappingDeviceIds: overlap })
  }
  if (conflicts.length === 0) return { kind: 'clean' }
  return force ? { kind: 'force', toDeactivate: conflicts } : { kind: 'refuse', conflicts }
}

/**
 * The exact sentence §4.6 quotes as the bar for "actionable": *"Jadwal-2
 * conflicts with active Jadwal-1 on flip4-03, flip4-04"* is useful; *"conflict"*
 * is not. Joins multiple simultaneous conflicts with `; ` so a candidate that
 * overlaps more than one active group still reads as one sentence rather
 * than a list a caller has to format itself.
 */
export function describeConflicts(candidateName: string, conflicts: readonly GroupConflict[]): string {
  const clauses = conflicts.map((c) => `active ${c.group.name} on ${c.overlappingDeviceIds.join(', ')}`)
  return `${candidateName} conflicts with ${clauses.join('; ')}`
}

// ---------------------------------------------------------------------------
// Minting a `group:<id>` id from an operator-typed name — step 122.8's CRUD.
// Mirrors `plugins/proxy-manager/src/shared.ts`'s `slugifyProxyName`/
// `deriveProxyKey` exactly (same charset, same collision-suffix rule): the
// plan's own worked examples (`jadwal-1`, `jadwal-2`, `Jadwal-2`) are slugs of
// an operator-chosen name, not opaque ids, and duplicating a pattern this
// codebase already ships beats inventing a second one for the same problem.
// Pure — the wiring step (`groups-service.ts`) supplies `taken` from a real
// `listGroups()` read.
// ---------------------------------------------------------------------------

export const GROUP_ID_MAX = 60
export const UNTITLED_GROUP_ID = 'untitled'

/**
 * A name → the `group:<id>` id's own half (the caller adds `GROUP_KEY_PREFIX`
 * via `groupKeyFor`). Output charset `[a-z0-9-]`, a strict subset of the KV
 * key charset, so a derived id can never be refused by the store for its
 * shape. `̀-ͯ` is the combining-marks block NFKD splits accents
 * into (`Köln` → `koln`, not `k-ln`) — the same range
 * `slugifyProxyName` strips, written here as an escape rather than the
 * literal combining characters to keep the source unambiguous to read.
 */
export function slugifyGroupName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, GROUP_ID_MAX)
    .replace(/-+$/g, '')
}

/**
 * A name → a `group:<id>` id nothing in `taken` already holds — `jadwal-1`,
 * then `jadwal-1-2`, `jadwal-1-3`, … on a collision, mirroring
 * `deriveProxyKey`'s own suffix rule. An empty/unslugifiable name (all
 * punctuation, or empty) falls back to {@link UNTITLED_GROUP_ID} rather than
 * minting an empty key.
 */
export function deriveGroupId(name: string, taken: Iterable<string>): string {
  const base = slugifyGroupName(name) || UNTITLED_GROUP_ID
  const used = new Set(taken)
  let candidate = base
  for (let n = 2; used.has(candidate) && n < 10_000; n += 1) candidate = `${base}-${n}`
  return candidate
}

// ---------------------------------------------------------------------------
// Save-time validation — acceptance criterion 12, the gap 122.7 found and
// deliberately left unfixed ("Assigned to 122.8's group-CRUD/validation
// work"). Pure, so the CRUD wiring step and its tests can check a candidate
// `entries` array with no I/O — the same reason every other function in this
// file takes plain values.
// ---------------------------------------------------------------------------

/**
 * Every `deviceId` that appears more than once in `entries`, each named
 * ONCE, sorted for a stable, testable, human-readable order. Empty when
 * every device in `entries` claims at most one entry in this group.
 *
 * This is a DIFFERENT question from the cross-group exclusivity invariant
 * `conflict`/`overlappingDeviceIds` answer above: those compare TWO groups;
 * this checks ONE group's own `entries` for an internal contradiction — the
 * same device claimed at two different paths inside a single group, which
 * would otherwise surface only at apply time as §4.3's `duplicate` refusal
 * (two managed rules for one endpoint) instead of here, at save time, where
 * it is both earlier and easier to read.
 */
export function duplicateDeviceIds(entries: readonly GroupEntry[]): string[] {
  const seen = new Set<string>()
  const dupes = new Set<string>()
  for (const entry of entries) {
    if (seen.has(entry.deviceId)) dupes.add(entry.deviceId)
    seen.add(entry.deviceId)
  }
  return [...dupes].sort()
}
