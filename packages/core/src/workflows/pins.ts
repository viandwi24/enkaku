import { and, eq } from 'drizzle-orm'
import { WORKFLOW_LIMITS } from '@enkaku/protocol'
import type { Db } from '../db'
import { workflowPins, type WorkflowPinRow } from '../db/schema'
import { EnkakuError } from '../util/errors'

/**
 * Pinned node outputs (plan 300 P10, plan 304 §3.3) — authoring state, kept
 * in its OWN table, outside `workflows.doc` and therefore outside
 * `jobs.workflow_doc`: publishing a workflow never publishes someone's mock
 * data, and a queued job cannot acquire a pin after it was enqueued. A
 * pin is scoped to `(workflowName, nodeId)` — a workflow may be deleted and
 * recreated under the same name; its old pins are gone with it (`removeAll`
 * is called by `WorkflowStore.remove`, not here).
 */

export interface PinListItem {
  nodeId: string
  updatedAt: number
  bytes: number
}

export interface PinStore {
  /** Every pin on this workflow, never the data itself (it can be 256 KB) — `GET /api/workflows/:name/pins`. */
  list(workflowName: string): PinListItem[]
  /** `null` when absent. */
  get(workflowName: string, nodeId: string): { data: unknown; updatedAt: number } | null
  /**
   * Every pin on this workflow, keyed by node id, data included — the ONLY
   * form the executor reads (plan 304 §3.3, §4.2). Never called for a
   * `schedule` or `batch` trigger (`jobs/executors/workflow.ts`'s own guard);
   * calling it from a second place is a defect this plan's §6 grep catches.
   */
  readPins(workflowName: string): ReadonlyMap<string, unknown>
  /** Throws `E_PIN_TOO_LARGE` over `WORKFLOW_LIMITS.maxNodeOutputBytes`. Upserts. */
  set(workflowName: string, nodeId: string, data: unknown, createdBy: string | null): PinListItem
  /** `false` when absent. */
  remove(workflowName: string, nodeId: string): boolean
  /** Every pin on this workflow — called when the workflow itself is deleted. */
  removeAll(workflowName: string): number
}

function byteSize(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value ?? null)).length
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

const toSec = (d: Date): number => Math.floor(d.getTime() / 1000)

function toItem(row: WorkflowPinRow): PinListItem {
  return { nodeId: row.nodeId, updatedAt: toSec(row.updatedAt), bytes: byteSize(row.data) }
}

export function createPinStore(db: Db): PinStore {
  const rowFor = (workflowName: string, nodeId: string): WorkflowPinRow | undefined =>
    db.select().from(workflowPins).where(and(eq(workflowPins.workflowName, workflowName), eq(workflowPins.nodeId, nodeId))).get()

  return {
    list(workflowName) {
      return db.select().from(workflowPins).where(eq(workflowPins.workflowName, workflowName)).all().map(toItem)
    },

    get(workflowName, nodeId) {
      const row = rowFor(workflowName, nodeId)
      if (!row) return null
      return { data: row.data, updatedAt: toSec(row.updatedAt) }
    },

    readPins(workflowName) {
      const rows = db.select().from(workflowPins).where(eq(workflowPins.workflowName, workflowName)).all()
      return new Map(rows.map((r) => [r.nodeId, r.data]))
    },

    set(workflowName, nodeId, data, createdBy) {
      const bytes = byteSize(data)
      if (bytes > WORKFLOW_LIMITS.maxNodeOutputBytes) {
        throw new EnkakuError('E_PIN_TOO_LARGE', `pin data is ${bytes} bytes, over the ${WORKFLOW_LIMITS.maxNodeOutputBytes}-byte cap (WORKFLOW_LIMITS.maxNodeOutputBytes)`)
      }
      const now = new Date()
      const existing = rowFor(workflowName, nodeId)
      if (existing) {
        db.update(workflowPins).set({ data, updatedAt: now, createdBy }).where(and(eq(workflowPins.workflowName, workflowName), eq(workflowPins.nodeId, nodeId))).run()
      } else {
        db.insert(workflowPins).values({ workflowName, nodeId, data, updatedAt: now, createdBy }).run()
      }
      const row = rowFor(workflowName, nodeId)
      if (!row) throw new EnkakuError('E_DB', 'pin insert did not persist')
      return toItem(row)
    },

    remove(workflowName, nodeId) {
      const existing = rowFor(workflowName, nodeId)
      if (!existing) return false
      db.delete(workflowPins).where(and(eq(workflowPins.workflowName, workflowName), eq(workflowPins.nodeId, nodeId))).run()
      return true
    },

    removeAll(workflowName) {
      const rows = db.select().from(workflowPins).where(eq(workflowPins.workflowName, workflowName)).all()
      if (rows.length === 0) return 0
      db.delete(workflowPins).where(eq(workflowPins.workflowName, workflowName)).run()
      return rows.length
    },
  }
}
