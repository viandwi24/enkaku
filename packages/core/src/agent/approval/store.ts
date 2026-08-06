import { and, desc, eq, lt } from 'drizzle-orm'
import { AgentApprovalSchema, type AgentApproval } from '@enkaku/protocol'
import type { Db } from '../../db'
import { agentApprovals, agentRuns, type AgentApprovalRow } from '../../db/schema'
import { EnkakuError } from '../../util/errors'

/**
 * Create, resolve, expire (plan 66 §3.6, §4.3). A row, not memory — a
 * `pending` approval survives a core restart exactly as it is (criterion 9);
 * only `expire()` (called from the SAME reaper timer the job queue already
 * uses — see `queue/expiry.ts`'s `sweepApprovals` hook, not a second
 * scheduler) ever moves a `pending` row forward on its own.
 */

const nowSec = (): number => Math.floor(Date.now() / 1000)

function toSeconds(d: Date | null): number {
  return d ? Math.floor(d.getTime() / 1000) : 0
}

function rowToApproval(row: AgentApprovalRow, threadId: string): AgentApproval {
  return AgentApprovalSchema.parse({
    id: row.id,
    runId: row.runId,
    threadId,
    capabilityId: row.capabilityId,
    toolCallId: row.toolCallId,
    input: row.input,
    status: row.status,
    decidedBy: row.decidedBy,
    decidedAt: row.decidedAt ? toSeconds(row.decidedAt) : null,
    expiresAt: row.expiresAt,
    createdAt: toSeconds(row.createdAt),
  })
}

export interface ApprovalStoreDeps {
  db: Db
  /** Default 1 hour (plan 66 §3.6). A function so tests can shrink it without a real wait. */
  ttlSec?: number
}

export function createApprovalStore(deps: ApprovalStoreDeps) {
  const { db } = deps
  const ttlSec = deps.ttlSec ?? 3600

  function threadIdOf(runId: string): string {
    const run = db.select({ threadId: agentRuns.threadId }).from(agentRuns).where(eq(agentRuns.id, runId)).get()
    if (!run) throw new EnkakuError('run_not_found', `no such run: ${runId}`)
    return run.threadId
  }

  function create(input: { runId: string; capabilityId: string; toolCallId: string; input: unknown }): AgentApproval {
    const row: AgentApprovalRow = {
      id: crypto.randomUUID(),
      runId: input.runId,
      capabilityId: input.capabilityId,
      toolCallId: input.toolCallId,
      input: input.input,
      status: 'pending',
      decidedBy: null,
      decidedAt: null,
      expiresAt: nowSec() + ttlSec,
      createdAt: new Date(),
    }
    db.insert(agentApprovals).values(row).run()
    return rowToApproval(row, threadIdOf(input.runId))
  }

  function get(id: string): AgentApproval | null {
    const row = db.select().from(agentApprovals).where(eq(agentApprovals.id, id)).get()
    return row ? rowToApproval(row, threadIdOf(row.runId)) : null
  }

  function mustGet(id: string): AgentApprovalRow {
    const row = db.select().from(agentApprovals).where(eq(agentApprovals.id, id)).get()
    if (!row) throw new EnkakuError('approval_not_found', `no such approval: ${id}`)
    return row
  }

  function listForRun(runId: string): AgentApproval[] {
    return db.select().from(agentApprovals).where(eq(agentApprovals.runId, runId)).orderBy(desc(agentApprovals.createdAt)).all().map((r) => rowToApproval(r, threadIdOf(runId)))
  }

  /** The one pending approval for a run, if any — a run pauses on at most one call at a time. */
  function pendingForRun(runId: string): AgentApproval | null {
    const row = db
      .select()
      .from(agentApprovals)
      .where(and(eq(agentApprovals.runId, runId), eq(agentApprovals.status, 'pending')))
      .get()
    return row ? rowToApproval(row, threadIdOf(runId)) : null
  }

  /**
   * The approval row for one exact tool call, if any (plan 66 §3.2, §3.6) —
   * `run.ts`'s resume path uses this to unambiguously find the decision for
   * the specific `tool_use.id` it is about to process, rather than
   * assuming "the most recent approval" when a step can carry more than
   * one gated call.
   */
  function findByToolCallId(runId: string, toolCallId: string): AgentApproval | null {
    const row = db
      .select()
      .from(agentApprovals)
      .where(and(eq(agentApprovals.runId, runId), eq(agentApprovals.toolCallId, toolCallId)))
      .get()
    return row ? rowToApproval(row, threadIdOf(runId)) : null
  }

  /** Approve or deny (plan 66 §3.6). Deciding an already-decided approval is refused, not silently overwritten. */
  function decide(id: string, decision: 'approve' | 'deny', decidedBy: string | null): AgentApproval {
    const row = mustGet(id)
    if (row.status !== 'pending') throw new EnkakuError('E_ALREADY_DECIDED', `approval ${id} was already ${row.status}`)
    db.update(agentApprovals)
      .set({ status: decision === 'approve' ? 'approved' : 'denied', decidedBy, decidedAt: new Date() })
      .where(eq(agentApprovals.id, id))
      .run()
    return get(id)!
  }

  /**
   * Expires every overdue `pending` approval into `denied` (plan 66 §3.6,
   * criterion 10 — "an approval left undecided expires into a denial with a
   * truthful `tool_result`"). Called from the shared reaper cadence
   * (`queue/expiry.ts`), never its own timer.
   */
  function sweepExpired(): AgentApprovalRow[] {
    const overdue = db
      .select()
      .from(agentApprovals)
      .where(and(eq(agentApprovals.status, 'pending'), lt(agentApprovals.expiresAt, nowSec())))
      .all()
    for (const row of overdue) {
      db.update(agentApprovals).set({ status: 'expired', decidedAt: new Date() }).where(eq(agentApprovals.id, row.id)).run()
    }
    return overdue
  }

  return { create, get, mustGet, listForRun, pendingForRun, findByToolCallId, decide, sweepExpired }
}

export type ApprovalStore = ReturnType<typeof createApprovalStore>
