import { and, eq, isNull } from 'drizzle-orm'
import type { Logger } from '../../util/logger'
import { changedRows, type Db } from '../index'
import { migrationMarkers, plugins, scripts } from '../schema'

/**
 * Plan 210 (MVP 03 §2.2 rule 7) — the synthetic `recordings` plugin
 * (`plugins/owner.ts`'s old `resolveRecordingsOwner`: name `recordings`,
 * version `0.0.0`, `verifiedAt: null`, `manifest: null`) is deleted, and its
 * member rows become ordinary unowned rows: not listed, not resolvable,
 * refused with `script_not_found`, and named once per boot by the script
 * registry's own `warnUnownedRows`. No new predicate, no new status — this
 * is the exact shape the boot warning already handles.
 *
 * Idempotent and guarded by a `migration_markers` row, the same pattern
 * every prior boot data step in this directory uses.
 */
export const MARKER_ID = 'park-synthetic-recordings-210'

export interface ParkSyntheticRecordingsReport {
  ranAt: string
  ownerFound: boolean
  rowsUnowned: number
}

export function parkSyntheticRecordingsOwner(db: Db, deps: { log: Logger }): ParkSyntheticRecordingsReport | null {
  const marker = db.select().from(migrationMarkers).where(eq(migrationMarkers.id, MARKER_ID)).get()
  if (marker) return null

  return db.transaction((tx) => {
    const owner = tx
      .select()
      .from(plugins)
      .where(and(eq(plugins.name, 'recordings'), eq(plugins.version, '0.0.0'), isNull(plugins.verifiedAt), isNull(plugins.manifest)))
      .get()

    let rowsUnowned = 0
    if (owner) {
      const result = tx.update(scripts).set({ pluginId: null, exportId: null }).where(eq(scripts.pluginId, owner.id)).run()
      rowsUnowned = changedRows(result)
      tx.delete(plugins).where(eq(plugins.id, owner.id)).run()
      deps.log.info(
        `park-synthetic-recordings: the farm-owned "recordings" plugin is gone; ${rowsUnowned} published recording row(s) are now unowned and ignored ` +
          '(see the script registry\'s own warning for their names). Recordings are parked for the MVP (docs/mvp/06-feature-scope.md §2).',
      )
    }

    tx.insert(migrationMarkers).values({ id: MARKER_ID, appliedAt: new Date() }).run()
    return { ranAt: new Date().toISOString(), ownerFound: owner != null, rowsUnowned }
  })
}
