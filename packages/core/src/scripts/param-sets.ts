import { and, eq } from 'drizzle-orm'
import type { ParamSetInfo } from '@enkaku/protocol'
import type { Db } from '../db'
import { scriptParamSets, scripts, type ScriptParamSetRow } from '../db/schema'
import { EnkakuError } from '../util/errors'

/**
 * The plain read/write operations behind named parameter sets (plan 95 §4.7,
 * §4.8, §5 step 95.8) — kept separate from `service.ts` (which is script
 * CRUD) because this is a different table with its own lifecycle, mirroring
 * how `resolve.ts` (script REFERENCES) sits beside `service.ts` (script
 * ROWS) rather than inside it.
 *
 * A set belongs to a script NAME, never a `scripts.id` (§4.7's own doc
 * comment on the table) — every function here takes `scriptName`, and
 * reconciling a set against a particular version's schema is the CALLER's
 * job (`reconcileParams`, applied where a set is actually used), not this
 * file's.
 */

function toInfo(row: ScriptParamSetRow): ParamSetInfo {
  return {
    id: row.id,
    scriptName: row.scriptName,
    name: row.name,
    params: row.params,
    createdBy: row.createdBy,
    createdAt: Math.floor(row.createdAt.getTime() / 1000),
    updatedAt: Math.floor(row.updatedAt.getTime() / 1000),
  }
}

/** Throws `script_not_found` — a set cannot be filed against a name nothing has ever published. */
function assertScriptNameExists(db: Db, scriptName: string): void {
  const row = db.select().from(scripts).where(eq(scripts.name, scriptName)).get()
  if (!row) throw new EnkakuError('script_not_found', `no such script: ${scriptName}`)
}

/** Alphabetical by set name — a picker's own most useful order, and stable across reloads (unlike insertion order). */
export function listParamSets(db: Db, scriptName: string): ParamSetInfo[] {
  return db
    .select()
    .from(scriptParamSets)
    .where(eq(scriptParamSets.scriptName, scriptName))
    .all()
    .map(toInfo)
    .sort((a, b) => a.name.localeCompare(b.name))
}

export interface CreateParamSetInput {
  scriptName: string
  name: string
  params: unknown
  createdBy: string | null
}

/** Throws `script_not_found` (404) or `param_set_name_exists` (409, the unique index's own constraint, checked first so the error names the field rather than surfacing as a raw SQL failure). */
export function createParamSet(db: Db, input: CreateParamSetInput): ParamSetInfo {
  assertScriptNameExists(db, input.scriptName)
  const existing = db
    .select()
    .from(scriptParamSets)
    .where(and(eq(scriptParamSets.scriptName, input.scriptName), eq(scriptParamSets.name, input.name)))
    .get()
  if (existing) {
    throw new EnkakuError('param_set_name_exists', `a parameter set named "${input.name}" already exists for ${input.scriptName}`)
  }
  const id = crypto.randomUUID()
  const now = new Date()
  db.insert(scriptParamSets)
    .values({
      id,
      scriptName: input.scriptName,
      name: input.name,
      params: input.params ?? null,
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
    })
    .run()
  return toInfo({
    id,
    scriptName: input.scriptName,
    name: input.name,
    params: input.params ?? null,
    createdBy: input.createdBy,
    createdAt: now,
    updatedAt: now,
  })
}

export interface UpdateParamSetInput {
  name?: string
  params?: unknown
}

/** Throws `param_set_not_found` (404, also when `id` exists but under a DIFFERENT script name — the route param and the row must agree) or `param_set_name_exists` (409, only checked when the name is actually changing). */
export function updateParamSet(db: Db, scriptName: string, id: string, patch: UpdateParamSetInput): ParamSetInfo {
  const row = db
    .select()
    .from(scriptParamSets)
    .where(and(eq(scriptParamSets.id, id), eq(scriptParamSets.scriptName, scriptName)))
    .get()
  if (!row) throw new EnkakuError('param_set_not_found', 'no such parameter set')
  if (patch.name !== undefined && patch.name !== row.name) {
    const dup = db
      .select()
      .from(scriptParamSets)
      .where(and(eq(scriptParamSets.scriptName, scriptName), eq(scriptParamSets.name, patch.name)))
      .get()
    if (dup) throw new EnkakuError('param_set_name_exists', `a parameter set named "${patch.name}" already exists for ${scriptName}`)
  }
  const now = new Date()
  db.update(scriptParamSets)
    .set({
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.params !== undefined ? { params: patch.params } : {}),
      updatedAt: now,
    })
    .where(eq(scriptParamSets.id, id))
    .run()
  return toInfo({
    ...row,
    name: patch.name ?? row.name,
    params: patch.params !== undefined ? patch.params : row.params,
    updatedAt: now,
  })
}

/**
 * Throws `param_set_not_found` (404), same "route param and row must agree"
 * rule as `updateParamSet`. Returns the deleted row's own `name` — not void —
 * so the route's audit entry can name what was removed, matching
 * `script.delete`'s own `{ name, version }` meta instead of a target id alone.
 */
export function deleteParamSet(db: Db, scriptName: string, id: string): { name: string } {
  const row = db
    .select()
    .from(scriptParamSets)
    .where(and(eq(scriptParamSets.id, id), eq(scriptParamSets.scriptName, scriptName)))
    .get()
  if (!row) throw new EnkakuError('param_set_not_found', 'no such parameter set')
  db.delete(scriptParamSets).where(eq(scriptParamSets.id, id)).run()
  return { name: row.name }
}
