import { eq } from 'drizzle-orm'
import type { Logger } from '../../util/logger'
import type { Db } from '../index'
import { migrationMarkers, schedules } from '../schema'

/**
 * The `target` migration (plan 68 §4.1: "the `target` migration converts
 * every existing schedule to `{kind: 'script', ref, params}` under a
 * `migration_markers` guard, the Plan 22.0 pattern, which Plan 62 also
 * used"). Every schedule created before this plan is a script schedule —
 * `schedules/runner.ts`'s dispatcher treats "no `schedule_agent_targets`
 * row" as `{kind: 'script', ref: scriptRef, params}` (see `db/schema.ts`'s
 * `scheduleAgentTargets` doc comment for why the agent target lives in a
 * companion table rather than new columns on `schedules` itself: a column
 * addition there breaks `schedules/runner.test.ts`'s and `api/schedules.
 * test.ts`'s literal `ScheduleRow` construction, which acceptance
 * criterion 2 forbids editing).
 *
 * Because "script" is the ABSENCE of a companion row rather than a stored
 * value, there is nothing to physically convert — every pre-existing row
 * already reads as a script target with zero data movement. This pass is
 * still guarded by a marker, exactly like `materialiseClusters` (plan 22.0
 * §4.1) and `backfillScheduleScriptRefs` (plan 62 §4.3), purely as the
 * explicit, auditable record that the conversion was considered and is a
 * no-op — a report line, like both of those, so "did the 68 migration run"
 * is answerable without reading source.
 */
export const MARKER_ID = 'schedule-target-backfill-68'

export interface ScheduleTargetBackfillReport {
  ranAt: string
  totalSchedules: number
}

export function backfillScheduleTargets(db: Db, deps: { log: Logger }): ScheduleTargetBackfillReport | null {
  const marker = db.select().from(migrationMarkers).where(eq(migrationMarkers.id, MARKER_ID)).get()
  if (marker) return null

  const total = db.select().from(schedules).all().length
  if (total > 0) {
    deps.log.info(`schedule-target-backfill: ${total} pre-existing schedule(s) already read as {kind: 'script'} — no data to convert`)
  }

  db.insert(migrationMarkers).values({ id: MARKER_ID, appliedAt: new Date() }).run()

  return { ranAt: new Date().toISOString(), totalSchedules: total }
}
