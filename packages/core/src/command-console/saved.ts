import { and, asc, eq, ne } from 'drizzle-orm'
import { CommandTargetSchema, type CommandTarget } from '@enkaku/protocol'
import type { Db } from '../db'
import { savedCommands, type SavedCommandRow } from '../db/schema'
import { EnkakuError } from '../util/errors'

/**
 * CRUD for `saved_commands` (plan 93 §3.10, §4.2, §4.4, step 93.6) — a
 * farm-scoped, OWNED saved command, "a team asset, not a personal
 * bookmark" (§3.10), on the same shape `clusters` and `scripts` already
 * use: visible to everyone, editable and deletable by the owner or an
 * admin, `name` unique per farm.
 *
 * Sibling to `command-console/store.ts` (`command_runs`/
 * `command_run_members`) but deliberately its OWN file, matching that
 * file's own doc comment ("`saved_commands` gets its own store in step
 * 93.6 (`command-console/saved.ts`, not this file)") and `scripts/
 * param-sets.ts`'s precedent for the same reason: a different table with
 * its own lifecycle, no run history to manage, no member rows to cascade.
 *
 * Permission (owner-or-admin on edit/delete, `canUseShell` on create) is
 * enforced by the CALLER (`api/saved-commands.ts`), not here — exactly how
 * `command-console/store.ts` leaves lease/role checks to `runner.ts` and
 * `api/command-runs.ts`. This file only knows about names, the cap, and
 * rows.
 *
 * No `dangerous` column and no `dangerous`-adjacent field here either
 * (§3.10): whether a command is high-consequence is derived fresh from its
 * text by the shared guard (`@enkaku/protocol`'s `isHighConsequence`) at
 * render and run time, never stored, so an edited command cannot go stale
 * against a cached boolean.
 */

export interface SavedCommandInfo {
  id: string
  name: string
  description: string | null
  cmd: string
  defaultTarget: CommandTarget | null
  createdBy: string | null
  createdAt: number
  updatedAt: number
  sortOrder: number
}

function toSeconds(d: Date): number {
  return Math.floor(d.getTime() / 1000)
}

function parseDefaultTarget(row: SavedCommandRow): CommandTarget | null {
  if (row.defaultTarget == null) return null
  const result = CommandTargetSchema.safeParse(row.defaultTarget)
  if (!result.success) {
    // Every row is written by `createSavedCommand`/`updateSavedCommand`
    // below, through the same schema — a parse failure here means
    // on-disk corruption, matching `command-console/store.ts`'s own
    // `parseTarget` reasoning for `command_runs.target`.
    throw new EnkakuError('E_DB', `saved_commands row ${row.id} has an invalid defaultTarget JSON payload`)
  }
  return result.data
}

function toInfo(row: SavedCommandRow): SavedCommandInfo {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? null,
    cmd: row.cmd,
    defaultTarget: parseDefaultTarget(row),
    createdBy: row.createdBy ?? null,
    createdAt: toSeconds(row.createdAt),
    updatedAt: toSeconds(row.updatedAt),
    sortOrder: row.sortOrder,
  }
}

/** Alphabetical by name once ordered by `sortOrder` — stable across reloads (matching `listParamSets`'s own "not insertion order" reasoning). There is no reorder UI yet (§3.10: "no folder tree"), so every row's `sortOrder` is 0 today and this degrades to a plain alphabetical list. */
export function listSavedCommands(db: Db): SavedCommandInfo[] {
  return db.select().from(savedCommands).orderBy(asc(savedCommands.sortOrder), asc(savedCommands.name)).all().map(toInfo)
}

export function getSavedCommand(db: Db, id: string): SavedCommandInfo | null {
  const row = db.select().from(savedCommands).where(eq(savedCommands.id, id)).get()
  return row ? toInfo(row) : null
}

export interface CreateSavedCommandInput {
  name: string
  description?: string | null
  cmd: string
  defaultTarget?: CommandTarget | null
  createdBy: string | null
}

/**
 * Throws `saved_command_name_exists` (409, the unique index's own
 * constraint, checked first so the error names the field rather than
 * surfacing as a raw SQL failure — `param-sets.ts`'s own precedent) or
 * `E_SAVED_COMMAND_LIMIT` (409) once the farm already holds `limit`
 * saved commands (`shell.savedCommandLimit`, plan 93 §3.10). `limit` is
 * passed in by the caller's own CURRENT settings value rather than read
 * here, so this file never reaches into `FarmSettings` directly — the
 * same separation `command-console/runner.ts`'s `settings` dep keeps.
 */
export function createSavedCommand(db: Db, input: CreateSavedCommandInput, limit: number): SavedCommandInfo {
  const existing = db.select().from(savedCommands).where(eq(savedCommands.name, input.name)).get()
  if (existing) {
    throw new EnkakuError('saved_command_name_exists', `a saved command named "${input.name}" already exists`)
  }

  const count = db.select({ id: savedCommands.id }).from(savedCommands).all().length
  if (count >= limit) {
    throw new EnkakuError('E_SAVED_COMMAND_LIMIT', `this farm already has ${count} saved commands, at its limit of ${limit}`)
  }

  const id = crypto.randomUUID()
  const now = new Date()
  db.insert(savedCommands)
    .values({
      id,
      name: input.name,
      description: input.description ?? null,
      cmd: input.cmd,
      defaultTarget: input.defaultTarget ?? null,
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
      sortOrder: 0,
    })
    .run()
  const row = db.select().from(savedCommands).where(eq(savedCommands.id, id)).get()
  if (!row) throw new EnkakuError('E_DB', `saved_commands row ${id} vanished immediately after insert`)
  return toInfo(row)
}

export interface UpdateSavedCommandInput {
  name?: string
  description?: string | null
  cmd?: string
  defaultTarget?: CommandTarget | null
}

/** Throws `saved_command_not_found` (404) or `saved_command_name_exists` (409, only checked when the name is actually changing). */
export function updateSavedCommand(db: Db, id: string, patch: UpdateSavedCommandInput): SavedCommandInfo {
  const row = db.select().from(savedCommands).where(eq(savedCommands.id, id)).get()
  if (!row) throw new EnkakuError('saved_command_not_found', 'no such saved command')
  if (patch.name !== undefined && patch.name !== row.name) {
    const dup = db
      .select()
      .from(savedCommands)
      .where(and(eq(savedCommands.name, patch.name), ne(savedCommands.id, id)))
      .get()
    if (dup) throw new EnkakuError('saved_command_name_exists', `a saved command named "${patch.name}" already exists`)
  }
  const now = new Date()
  const updated: SavedCommandRow = {
    ...row,
    name: patch.name ?? row.name,
    description: patch.description !== undefined ? patch.description : row.description,
    cmd: patch.cmd ?? row.cmd,
    defaultTarget: patch.defaultTarget !== undefined ? patch.defaultTarget : row.defaultTarget,
    updatedAt: now,
  }
  db.update(savedCommands)
    .set({
      name: updated.name,
      description: updated.description,
      cmd: updated.cmd,
      defaultTarget: updated.defaultTarget,
      updatedAt: now,
    })
    .where(eq(savedCommands.id, id))
    .run()
  return toInfo(updated)
}

/** Throws `saved_command_not_found` (404). Returns the deleted row's own `name` — not void — matching `deleteParamSet`'s own "audit needs a name" reasoning. */
export function deleteSavedCommand(db: Db, id: string): { name: string } {
  const row = db.select().from(savedCommands).where(eq(savedCommands.id, id)).get()
  if (!row) throw new EnkakuError('saved_command_not_found', 'no such saved command')
  db.delete(savedCommands).where(eq(savedCommands.id, id)).run()
  return { name: row.name }
}
