import { eq, inArray, isNull, like } from 'drizzle-orm'
import { compareSemver, WorkflowDocSchema, type WorkflowDoc } from '@enkaku/protocol'
import type { Logger } from '../../util/logger'
import type { Db } from '../index'
import { jobs, migrationMarkers, schedules, scripts, workflows } from '../schema'

/**
 * The migration this step must run strictly after: the one that creates
 * `workflows`/`jobs.workflow_doc` and drops the `scripts` table's old
 * kind-discriminator column (plan 210 §4.1). By the time this step runs,
 * that column no longer exists, so a workflow row is recognised
 * STRUCTURALLY instead (plan 210 §3.2 item 7): `plugin_id IS NULL` and
 * `bundle` parses as a `WorkflowDoc` once its `version` key is removed — an
 * ESM bundle (an ordinary unowned script row) never parses as JSON at all.
 */
export const WORKFLOWS_TABLE_TAG = '0068_milky_tiger_shark'

export const MARKER_ID = 'workflows-from-scripts-210'

export interface WorkflowsFromScriptsReport {
  ranAt: string
  /** One name per workflow copied into the `workflows` table. */
  migrated: string[]
  /** `name@version` of every older version not carried. */
  droppedVersions: string[]
  /** `name@version (id)` rows that looked like workflows but did not parse; left in place. */
  unreadable: string[]
  /** Jobs (any status) whose `script_id` named a deleted row. */
  jobsPinnedToDropped: number
  /** Schedule names whose `script_ref` names a migrated workflow. */
  schedulesNamingWorkflow: string[]
}

interface CandidateRow {
  id: string
  name: string
  version: string
  createdBy: string | null
  createdAt: Date | null
  doc: WorkflowDoc
}

export function migrateWorkflowsFromScripts(db: Db, deps: { log: Logger }): WorkflowsFromScriptsReport | null {
  const marker = db.select().from(migrationMarkers).where(eq(migrationMarkers.id, MARKER_ID)).get()
  if (marker) return null

  return db.transaction((tx) => {
    const unownedRows = tx.select().from(scripts).where(isNull(scripts.pluginId)).all()

    const candidates: CandidateRow[] = []
    const unreadable: string[] = []
    for (const row of unownedRows) {
      let parsed: unknown
      try {
        parsed = JSON.parse(row.bundle)
      } catch {
        continue // an ordinary unowned ESM bundle — not a workflow row
      }
      if (parsed === null || typeof parsed !== 'object') continue
      const { version: _version, ...withoutVersion } = parsed as Record<string, unknown>
      const doc = WorkflowDocSchema.safeParse(withoutVersion)
      if (!doc.success) {
        unreadable.push(`${row.name}@${row.version} (${row.id})`)
        continue
      }
      candidates.push({ id: row.id, name: row.name, version: row.version, createdBy: row.createdBy, createdAt: row.createdAt, doc: doc.data })
    }

    const byName = new Map<string, CandidateRow[]>()
    for (const c of candidates) {
      const list = byName.get(c.name)
      if (list) list.push(c)
      else byName.set(c.name, [c])
    }

    const migrated: string[] = []
    const droppedVersions: string[] = []
    const allWorkflowIds: string[] = []

    for (const [name, group] of byName) {
      const sorted = [...group].sort((a, b) => compareSemver(b.version, a.version))
      const winner = sorted[0] as CandidateRow
      for (const c of sorted) allWorkflowIds.push(c.id)
      for (const dropped of sorted.slice(1)) droppedVersions.push(`${dropped.name}@${dropped.version}`)

      const already = tx.select().from(workflows).where(eq(workflows.name, name)).get()
      if (!already) {
        const now = winner.createdAt ?? new Date()
        tx.insert(workflows)
          .values({ id: crypto.randomUUID(), name, doc: winner.doc, createdBy: winner.createdBy, createdAt: now, updatedAt: now })
          .run()
      }
      migrated.push(name)
    }

    const jobsPinnedToDropped = allWorkflowIds.length > 0 ? tx.select().from(jobs).where(inArray(jobs.scriptId, allWorkflowIds)).all().length : 0

    const schedulesNamingWorkflow: string[] = []
    for (const name of migrated) {
      const rows = tx.select().from(schedules).where(like(schedules.scriptRef, `${name}@%`)).all()
      for (const s of rows) schedulesNamingWorkflow.push(s.name)
    }

    if (allWorkflowIds.length > 0) {
      tx.delete(scripts).where(inArray(scripts.id, allWorkflowIds)).run()
    }

    tx.insert(migrationMarkers).values({ id: MARKER_ID, appliedAt: new Date() }).run()

    if (migrated.length > 0) {
      const droppedClause = droppedVersions.length > 0 ? `; dropped ${droppedVersions.length} older version(s): ${droppedVersions.join(', ')}` : ''
      deps.log.info(`workflows-from-scripts: moved ${migrated.length} workflow(s) into the workflows table: ${migrated.join(', ')}${droppedClause}`)
    }
    if (unreadable.length > 0) {
      deps.log.warn(`workflows-from-scripts: ${unreadable.length} row(s) looked like a workflow but did not parse and were left in place: ${unreadable.join(', ')}`)
    }
    if (jobsPinnedToDropped > 0) {
      deps.log.warn(
        `workflows-from-scripts: ${jobsPinnedToDropped} job(s) reference a workflow row that no longer exists; their history reads back through jobs.script_name and they cannot be re-run until plan 211 lands`,
      )
    }
    if (schedulesNamingWorkflow.length > 0) {
      deps.log.warn(
        `workflows-from-scripts: schedule(s) ${schedulesNamingWorkflow.join(', ')} fire against a script reference that no longer resolves and will record a failed fire until plan 211 retargets them`,
      )
    }

    return { ranAt: new Date().toISOString(), migrated, droppedVersions, unreadable, jobsPinnedToDropped, schedulesNamingWorkflow }
  })
}
