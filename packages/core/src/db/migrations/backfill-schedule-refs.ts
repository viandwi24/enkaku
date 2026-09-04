import { eq } from 'drizzle-orm'
import type { Logger } from '../../util/logger'
import type { Db } from '../index'
import { migrationMarkers, schedules, scripts } from '../schema'

/**
 * The generated migration that renames `schedules.script_id` to
 * `schedules.script_ref` (plan 62 §4.3) — a plain `RENAME COLUMN`, so every
 * pre-existing row keeps its data, just under the new column name. Exported
 * so a test can stop `runMigrationsUpTo` here and seed pre-plan-62 data
 * (a raw `scripts.id`) before applying the rename.
 */
export const SCHEDULE_SCRIPT_REF_RENAME_TAG = '0024_rename_schedules_script_ref'

const MARKER_ID = 'schedule-script-ref-backfill-62'

export interface ScheduleRefBackfillReport {
  ranAt: string
  converted: number
  /** A schedule whose old `scriptId` no longer names any script — left untouched rather than guessed at. */
  unresolved: { scheduleId: string; scheduleName: string; oldScriptId: string }[]
}

/**
 * One-shot: `RENAME COLUMN` (above) moves the data but not its SHAPE — every
 * pre-existing row still holds a raw `scripts.id` where `name@version`
 * belongs. This converts each one to the exact version it was already
 * pinned to (plan 62 §4.3, acceptance #9): **never** to `@latest` — silently
 * making an existing schedule float would change what it runs on its very
 * next firing, which is precisely the invisible drift this plan exists to
 * end. Anyone who wants floating behaviour edits the schedule and sees
 * themselves do it.
 *
 * Guarded by a marker row so a second core start is a no-op (same pattern as
 * `materialise-0014.ts`, plan 22.0 §4.1) — verified by this file's test:
 * running it twice changes nothing on the second pass.
 */
export function backfillScheduleScriptRefs(db: Db, deps: { log: Logger }): ScheduleRefBackfillReport | null {
  const marker = db.select().from(migrationMarkers).where(eq(migrationMarkers.id, MARKER_ID)).get()
  if (marker) return null

  const rows = db.select().from(schedules).all()
  const unresolved: ScheduleRefBackfillReport['unresolved'] = []
  let converted = 0

  for (const row of rows) {
    const raw = row.scriptRef
    // Already a reference (a fresh database, or a schedule created after the
    // API switched to accepting `scriptRef` — plan 62 §4.4) — never touched.
    if (raw.includes('@')) continue

    const script = db.select().from(scripts).where(eq(scripts.id, raw)).get()
    if (!script) {
      unresolved.push({ scheduleId: row.id, scheduleName: row.name, oldScriptId: raw })
      deps.log.warn(
        `schedule ${row.id} (${row.name}): its script (${raw}) no longer exists — left unconverted, it will fail to resolve at its next firing`,
      )
      continue
    }

    db.update(schedules)
      .set({ scriptRef: `${script.name}@${script.version}` })
      .where(eq(schedules.id, row.id))
      .run()
    converted++
  }

  if (rows.length > 0) {
    deps.log.info(`schedule-script-ref-backfill: converted ${converted}/${rows.length} schedule(s) to a pinned reference`)
  }

  db.insert(migrationMarkers).values({ id: MARKER_ID, appliedAt: new Date() }).run()

  return { ranAt: new Date().toISOString(), converted, unresolved }
}
