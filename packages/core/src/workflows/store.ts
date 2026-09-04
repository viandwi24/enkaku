import { asc, eq } from 'drizzle-orm'
import { WorkflowDocSchema, type WorkflowDoc } from '@enkaku/protocol'
import type { Db } from '../db'
import { workflows, type WorkflowRow } from '../db/schema'
import { EnkakuError } from '../util/errors'

export interface WorkflowRecord {
  id: string
  name: string
  doc: WorkflowDoc
  createdBy: string | null
  /** Unix seconds. */
  createdAt: number
  updatedAt: number
}

export interface WorkflowStore {
  /** Every workflow, by name ascending. A row whose `doc` no longer parses is left out (see `get`). */
  list(): WorkflowRecord[]
  /** `null` when absent. Throws `workflow_corrupt` for a row whose `doc` no longer parses. */
  get(name: string): WorkflowRecord | null
  /** Throws `workflow_name_exists`. `doc` is already validated by the route (schema, refs, checks). */
  create(input: { doc: WorkflowDoc; createdBy: string | null }): WorkflowRecord
  /** Replaces `doc`, bumps `updatedAt`. Throws `workflow_not_found`. */
  update(name: string, input: { doc: WorkflowDoc }): WorkflowRecord
  /** `false` when absent. */
  remove(name: string): boolean
  /**
   * The document a job copies onto `jobs.workflow_doc` at enqueue (MVP 03
   * §2.2 rule 4). A fresh parse of the stored row, never a shared object, so
   * nothing the caller does to it reaches the table. Throws
   * `workflow_not_found`. Called by plan 211's enqueue; no caller in plan 210.
   */
  snapshotForJob(name: string): WorkflowDoc
}

/**
 * The one reader of a stored workflow document (`workflows.doc`,
 * `jobs.workflow_doc`): Zod-validated, never an `as`-cast (00-overview §4.2),
 * `null` on a parse failure so a caller decides between "skip" (`list`) and
 * "name it" (`get`).
 */
export function parseWorkflowDoc(value: unknown): WorkflowDoc | null {
  const parsed = WorkflowDocSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

const toSec = (d: Date): number => Math.floor(d.getTime() / 1000)

function toRecord(row: WorkflowRow): WorkflowRecord | null {
  const doc = parseWorkflowDoc(row.doc)
  if (!doc) return null
  return { id: row.id, name: row.name, doc, createdBy: row.createdBy, createdAt: toSec(row.createdAt), updatedAt: toSec(row.updatedAt) }
}

export function createWorkflowStore(db: Db): WorkflowStore {
  const rowByName = (name: string): WorkflowRow | undefined => db.select().from(workflows).where(eq(workflows.name, name)).get()
  const getOrThrow = (name: string): WorkflowRecord => {
    const rec = store.get(name)
    if (!rec) throw new EnkakuError('workflow_not_found', `no workflow named "${name}"`)
    return rec
  }
  const store: WorkflowStore = {
    list: () =>
      db
        .select()
        .from(workflows)
        .orderBy(asc(workflows.name))
        .all()
        .map(toRecord)
        .filter((r): r is WorkflowRecord => r !== null),
    get(name) {
      const row = rowByName(name)
      if (!row) return null
      const rec = toRecord(row)
      if (!rec) throw new EnkakuError('workflow_corrupt', `workflow "${name}" (id ${row.id}) holds a document this build cannot read; DELETE /api/workflows/${name} removes it`)
      return rec
    },
    create({ doc, createdBy }) {
      if (rowByName(doc.name)) throw new EnkakuError('workflow_name_exists', `a workflow named "${doc.name}" already exists; edit it with PUT /api/workflows/${doc.name}`)
      const now = new Date()
      const row: WorkflowRow = { id: crypto.randomUUID(), name: doc.name, doc, createdBy, createdAt: now, updatedAt: now }
      db.insert(workflows).values(row).run()
      return getOrThrow(doc.name)
    },
    update(name, { doc }) {
      getOrThrow(name)
      db.update(workflows).set({ doc, updatedAt: new Date() }).where(eq(workflows.name, name)).run()
      return getOrThrow(name)
    },
    remove(name) {
      const row = rowByName(name)
      if (!row) return false
      db.delete(workflows).where(eq(workflows.id, row.id)).run()
      return true
    },
    snapshotForJob: (name) => WorkflowDocSchema.parse(JSON.parse(JSON.stringify(getOrThrow(name).doc))),
  }
  return store
}
