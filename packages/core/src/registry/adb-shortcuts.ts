import { asc, eq, sql } from 'drizzle-orm'
import { normalizeAdbCommand, type AdbShortcut } from '@enkaku/protocol'
import type { Db } from '../db'
import { adbShortcuts, type AdbShortcutRow } from '../db/schema'
import { ADB_SHORTCUTS_MAX } from '../config/constants'
import { EnkakuError } from '../util/errors'

/**
 * The farm's saved adb commands (`db/schema.ts`'s own note says why they are
 * here rather than in a browser).
 *
 * Every write normalises the command through `normalizeAdbCommand` — the
 * SAME function the `adb` verb runs on the request — so what is stored is
 * what will run, and `adb shell pm list packages` and `pm list packages`
 * cannot both be saved as different shortcuts.
 */

const NAME_MAX = 80

function toSec(d: Date | null): number {
  return d ? Math.floor(d.getTime() / 1000) : 0
}

function toShortcut(row: AdbShortcutRow): AdbShortcut {
  return { id: row.id, name: row.name, cmd: row.cmd, position: row.position, createdAt: toSec(row.createdAt) }
}

/** The stored form of a command, or a refusal in the normaliser's own words. */
function canonical(cmd: string): string {
  const parsed = normalizeAdbCommand(cmd)
  if (!parsed.ok) throw new EnkakuError('E_BAD_REQUEST', parsed.error)
  return parsed.cmd
}

function cleanName(name: string): string {
  const trimmed = name.trim().slice(0, NAME_MAX)
  if (trimmed.length === 0) throw new EnkakuError('E_BAD_REQUEST', 'a shortcut needs a name')
  return trimmed
}

export function listAdbShortcuts(db: Db): AdbShortcut[] {
  return db.select().from(adbShortcuts).orderBy(asc(adbShortcuts.position), asc(adbShortcuts.id)).all().map(toShortcut)
}

export function getAdbShortcut(db: Db, id: string): AdbShortcut {
  const row = db.select().from(adbShortcuts).where(eq(adbShortcuts.id, id)).get()
  if (!row) throw new EnkakuError('shortcut_not_found', `no adb shortcut ${id}`)
  return toShortcut(row)
}

/**
 * Save `cmd` under `name`.
 *
 * A command that is already saved is RENAMED rather than saved twice — the
 * rule the browser store this replaces already had, and the one the unique
 * index on `cmd` enforces. Without it a list of twenty shortcuts ends up with
 * "Clear Chrome" and "clear chrome (new)" running the identical line, and
 * nobody can say which one the farm actually means.
 */
export function createAdbShortcut(db: Db, input: { name: string; cmd: string; userId: string | null }): AdbShortcut {
  const name = cleanName(input.name)
  const cmd = canonical(input.cmd)

  const existing = db.select().from(adbShortcuts).where(eq(adbShortcuts.cmd, cmd)).get()
  if (existing) {
    db.update(adbShortcuts).set({ name }).where(eq(adbShortcuts.id, existing.id)).run()
    return toShortcut({ ...existing, name })
  }

  const count = db.select({ n: sql<number>`count(*)` }).from(adbShortcuts).get()?.n ?? 0
  if (count >= ADB_SHORTCUTS_MAX) {
    throw new EnkakuError('E_LIMIT', `this farm already has ${ADB_SHORTCUTS_MAX} adb shortcuts — delete one first`)
  }

  const max = db.select({ p: sql<number | null>`max(${adbShortcuts.position})` }).from(adbShortcuts).get()?.p ?? -1
  const row: AdbShortcutRow = {
    id: crypto.randomUUID(),
    name,
    cmd,
    position: max + 1,
    createdBy: input.userId,
    createdAt: new Date(),
  }
  db.insert(adbShortcuts).values(row).run()
  return toShortcut(row)
}

/** Rename one, or point it at a different command. Both are optional; neither is a way to create one. */
export function updateAdbShortcut(db: Db, id: string, patch: { name?: string; cmd?: string }): AdbShortcut {
  const row = db.select().from(adbShortcuts).where(eq(adbShortcuts.id, id)).get()
  if (!row) throw new EnkakuError('shortcut_not_found', `no adb shortcut ${id}`)

  const next: Partial<AdbShortcutRow> = {}
  if (patch.name !== undefined) next.name = cleanName(patch.name)
  if (patch.cmd !== undefined) {
    const cmd = canonical(patch.cmd)
    const clash = db.select().from(adbShortcuts).where(eq(adbShortcuts.cmd, cmd)).get()
    if (clash && clash.id !== id) throw new EnkakuError('shortcut_exists', `“${clash.name}” already runs that command`)
    next.cmd = cmd
  }
  if (Object.keys(next).length === 0) return toShortcut(row)

  db.update(adbShortcuts).set(next).where(eq(adbShortcuts.id, id)).run()
  return toShortcut({ ...row, ...next })
}

export function deleteAdbShortcut(db: Db, id: string): AdbShortcut {
  const shortcut = getAdbShortcut(db, id)
  db.delete(adbShortcuts).where(eq(adbShortcuts.id, id)).run()
  return shortcut
}
