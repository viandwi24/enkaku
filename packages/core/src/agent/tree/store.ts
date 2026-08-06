import { and, eq, isNull } from 'drizzle-orm'
import type { Db } from '../../db'
import { agentInbox, agentSpawnGrants, type AgentInboxRow } from '../../db/schema'

/**
 * The run tree's message channel and spawn grants (plan 67 §4.1). The inbox
 * is a TABLE, not an in-memory queue, so a message survives a restart and an
 * undelivered one is inspectable when an agent appears stuck (§3.3). Spawn
 * grants are a table rather than a JSON column because "which agents may
 * spawn this one" is worth asking from both directions (§3.4).
 */

export interface InboxItem {
  id: string
  targetRunId: string
  fromRunId: string | null
  kind: 'message' | 'child-result'
  body: unknown
  deliveredAt: number | null
  createdAt: number
}

function toSeconds(d: Date | null): number {
  return d ? Math.floor(d.getTime() / 1000) : 0
}

function rowToItem(row: AgentInboxRow): InboxItem {
  return {
    id: row.id,
    targetRunId: row.targetRunId,
    fromRunId: row.fromRunId,
    kind: row.kind as 'message' | 'child-result',
    body: row.body,
    deliveredAt: row.deliveredAt ? toSeconds(row.deliveredAt) : null,
    createdAt: toSeconds(row.createdAt),
  }
}

export function createTreeStore(db: Db) {
  /** `agent.send`/`agent.reply`/a detached child's completion (plan 67 §3.3) — append and
   * enqueue for injection. This is the ONLY way a message enters the inbox. */
  function enqueue(input: { targetRunId: string; fromRunId: string | null; kind: 'message' | 'child-result'; body: unknown }): InboxItem {
    const row: AgentInboxRow = {
      id: crypto.randomUUID(),
      targetRunId: input.targetRunId,
      fromRunId: input.fromRunId,
      kind: input.kind,
      body: input.body,
      deliveredAt: null,
      createdAt: new Date(),
    }
    db.insert(agentInbox).values(row).run()
    return rowToItem(row)
  }

  /** Drains every undelivered item for a run and marks it delivered — the ONLY place messages
   * enter a run (plan 67 §3.3, §4.3). Called ONLY from the loop's top-of-iteration drain step. */
  function drain(targetRunId: string): InboxItem[] {
    const rows = db
      .select()
      .from(agentInbox)
      .where(and(eq(agentInbox.targetRunId, targetRunId), isNull(agentInbox.deliveredAt)))
      .all()
    if (rows.length === 0) return []
    const deliveredAt = new Date()
    for (const row of rows) {
      db.update(agentInbox).set({ deliveredAt }).where(eq(agentInbox.id, row.id)).run()
    }
    return rows.map((row) => rowToItem({ ...row, deliveredAt }))
  }

  /** Everything still queued for a run — what makes an undelivered message visible in Studio
   * rather than looking like a lost one (plan 67 criterion 17). */
  function undeliveredFor(targetRunId: string): InboxItem[] {
    return db
      .select()
      .from(agentInbox)
      .where(and(eq(agentInbox.targetRunId, targetRunId), isNull(agentInbox.deliveredAt)))
      .all()
      .map(rowToItem)
  }

  /**
   * Re-addresses every UNDELIVERED item still queued for `fromRunId` to `toRunId` (plan 67 §3.3) —
   * a message queued for a run that has already finished has nowhere to be drained by: draining
   * only ever happens from a run's OWN loop, and a finished run's loop will never run again. When
   * `wakeOnMessage` starts a fresh run on the same thread, that new run is what continues the
   * thread, so any items still waiting for the old (now-terminal) run belong to it instead — this
   * is what makes them actually reach the model rather than sitting undelivered forever even though
   * the thread visibly woke up.
   */
  function retarget(fromRunId: string, toRunId: string): void {
    db.update(agentInbox).set({ targetRunId: toRunId }).where(and(eq(agentInbox.targetRunId, fromRunId), isNull(agentInbox.deliveredAt))).run()
  }

  function grantSpawn(parentAgentId: string, childAgentId: string): void {
    db.insert(agentSpawnGrants).values({ parentAgentId, childAgentId }).onConflictDoNothing().run()
  }

  function revokeSpawn(parentAgentId: string, childAgentId: string): void {
    db.delete(agentSpawnGrants).where(and(eq(agentSpawnGrants.parentAgentId, parentAgentId), eq(agentSpawnGrants.childAgentId, childAgentId))).run()
  }

  /** An agent may spawn only agents named in its `canSpawn` list — default NONE (plan 67 §3.4). */
  function canSpawn(parentAgentId: string, childAgentId: string): boolean {
    const row = db
      .select({ childAgentId: agentSpawnGrants.childAgentId })
      .from(agentSpawnGrants)
      .where(and(eq(agentSpawnGrants.parentAgentId, parentAgentId), eq(agentSpawnGrants.childAgentId, childAgentId)))
      .get()
    return row !== undefined
  }

  function listSpawnable(parentAgentId: string): string[] {
    return db
      .select({ childAgentId: agentSpawnGrants.childAgentId })
      .from(agentSpawnGrants)
      .where(eq(agentSpawnGrants.parentAgentId, parentAgentId))
      .all()
      .map((r) => r.childAgentId)
  }

  return { enqueue, drain, undeliveredFor, retarget, grantSpawn, revokeSpawn, canSpawn, listSpawnable }
}

export type TreeStore = ReturnType<typeof createTreeStore>
