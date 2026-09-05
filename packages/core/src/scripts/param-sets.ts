import { and, eq } from 'drizzle-orm'
import type { ParamPresetInfo, PresetKind } from '@enkaku/protocol'
import type { Db } from '../db'
import { paramPresets, scripts, type ParamPresetRow } from '../db/schema'
import { EnkakuError } from '../util/errors'

/**
 * The plain read/write operations behind named parameter presets (plan 95
 * §4.7, §4.8, §5 step 95.8; generalised to workflows by plan 311 §3.3,
 * §4.1) — kept separate from `service.ts` (which is script CRUD) because
 * this is a different table with its own lifecycle, mirroring how
 * `resolve.ts` (script REFERENCES) sits beside `service.ts` (script ROWS)
 * rather than inside it.
 *
 * A preset belongs to a `(kind, ownerName)` pair, never a `scripts.id`/
 * workflow row id (the table's own doc comment in `schema.ts`) — every
 * function here takes both, and reconciling a preset against a particular
 * schema is the CALLER's job (`reconcileParams`, applied where a preset is
 * actually used), not this file's.
 */

function toInfo(row: ParamPresetRow): ParamPresetInfo {
  return {
    id: row.id,
    kind: row.kind as PresetKind,
    ownerName: row.ownerName,
    name: row.name,
    params: row.params,
    createdBy: row.createdBy,
    createdAt: Math.floor(row.createdAt.getTime() / 1000),
    updatedAt: Math.floor(row.updatedAt.getTime() / 1000),
  }
}

/**
 * Throws `script_not_found` — a preset cannot be filed against a script name
 * nothing has ever published. Only checked for `kind === 'script'`: a
 * workflow preset has no equivalent registry to check against here, and
 * `store.get(name)` (the workflow store) is not a dependency of this file
 * (plan 311 §4.1 keeps the two route families independent).
 */
function assertOwnerExists(db: Db, kind: PresetKind, ownerName: string): void {
  if (kind !== 'script') return
  const row = db.select().from(scripts).where(eq(scripts.name, ownerName)).get()
  if (!row) throw new EnkakuError('script_not_found', `no such script: ${ownerName}`)
}

/** Alphabetical by preset name — a picker's own most useful order, and stable across reloads (unlike insertion order). */
export function listParamPresets(db: Db, kind: PresetKind, ownerName: string): ParamPresetInfo[] {
  return db
    .select()
    .from(paramPresets)
    .where(and(eq(paramPresets.kind, kind), eq(paramPresets.ownerName, ownerName)))
    .all()
    .map(toInfo)
    .sort((a, b) => a.name.localeCompare(b.name))
}

export interface CreateParamPresetInput {
  kind: PresetKind
  ownerName: string
  name: string
  params: unknown
  createdBy: string | null
}

/** Throws `script_not_found` (404, `kind === 'script'` only) or `param_set_name_exists` (409, the unique index's own constraint, checked first so the error names the field rather than surfacing as a raw SQL failure). */
export function createParamPreset(db: Db, input: CreateParamPresetInput): ParamPresetInfo {
  assertOwnerExists(db, input.kind, input.ownerName)
  const existing = db
    .select()
    .from(paramPresets)
    .where(and(eq(paramPresets.kind, input.kind), eq(paramPresets.ownerName, input.ownerName), eq(paramPresets.name, input.name)))
    .get()
  if (existing) {
    throw new EnkakuError('param_set_name_exists', `a preset named "${input.name}" already exists for ${input.ownerName}`)
  }
  const id = crypto.randomUUID()
  const now = new Date()
  db.insert(paramPresets)
    .values({
      id,
      kind: input.kind,
      ownerName: input.ownerName,
      name: input.name,
      params: input.params ?? null,
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
    })
    .run()
  return toInfo({
    id,
    kind: input.kind,
    ownerName: input.ownerName,
    name: input.name,
    params: input.params ?? null,
    createdBy: input.createdBy,
    createdAt: now,
    updatedAt: now,
  })
}

export interface UpdateParamPresetInput {
  name?: string
  params?: unknown
}

/** Throws `param_set_not_found` (404, also when `id` exists but under a DIFFERENT owner/kind — the route params and the row must agree) or `param_set_name_exists` (409, only checked when the name is actually changing). */
export function updateParamPreset(db: Db, kind: PresetKind, ownerName: string, id: string, patch: UpdateParamPresetInput): ParamPresetInfo {
  const row = db
    .select()
    .from(paramPresets)
    .where(and(eq(paramPresets.id, id), eq(paramPresets.kind, kind), eq(paramPresets.ownerName, ownerName)))
    .get()
  if (!row) throw new EnkakuError('param_set_not_found', 'no such preset')
  if (patch.name !== undefined && patch.name !== row.name) {
    const dup = db
      .select()
      .from(paramPresets)
      .where(and(eq(paramPresets.kind, kind), eq(paramPresets.ownerName, ownerName), eq(paramPresets.name, patch.name)))
      .get()
    if (dup) throw new EnkakuError('param_set_name_exists', `a preset named "${patch.name}" already exists for ${ownerName}`)
  }
  const now = new Date()
  db.update(paramPresets)
    .set({
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.params !== undefined ? { params: patch.params } : {}),
      updatedAt: now,
    })
    .where(eq(paramPresets.id, id))
    .run()
  return toInfo({
    ...row,
    name: patch.name ?? row.name,
    params: patch.params !== undefined ? patch.params : row.params,
    updatedAt: now,
  })
}

/**
 * Throws `param_set_not_found` (404), same "route params and row must
 * agree" rule as `updateParamPreset`. Returns the deleted row's own `name`
 * — not void — so the route's audit entry can name what was removed,
 * matching `script.delete`'s own `{ name, version }` meta instead of a
 * target id alone.
 */
export function deleteParamPreset(db: Db, kind: PresetKind, ownerName: string, id: string): { name: string } {
  const row = db
    .select()
    .from(paramPresets)
    .where(and(eq(paramPresets.id, id), eq(paramPresets.kind, kind), eq(paramPresets.ownerName, ownerName)))
    .get()
  if (!row) throw new EnkakuError('param_set_not_found', 'no such preset')
  db.delete(paramPresets).where(eq(paramPresets.id, id)).run()
  return { name: row.name }
}
