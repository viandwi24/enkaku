import { and, asc, desc, eq, gt, gte, inArray, sql } from 'drizzle-orm'
import {
  AgentMessageSchema,
  AgentRunSchema,
  AgentThreadSchema,
  AgentUsageSchema,
  type AgentContentBlock,
  type AgentMessage,
  type AgentMessageRole,
  type AgentRun,
  type AgentRunStatus,
  type AgentStopReason,
  type AgentErrorClass,
  type AgentThread,
  type AgentThreadOrigin,
  type AgentUsage,
} from '@enkaku/protocol'
import type { Db } from '../../db'
import { agentApprovals, agentInbox, agentMessages, agentRuns, agentThreads, type AgentMessageRow, type AgentRunRow, type AgentThreadRow } from '../../db/schema'
import { EnkakuError } from '../../util/errors'

/**
 * Threads, runs, and append-only messages (plan 66 §3.1, §4.1). Messages are
 * NEVER rewritten in place — compaction (`loop/compaction.ts`) builds a VIEW
 * for the provider at request time and never calls into this store to edit a
 * row. The unique `(threadId, seq)` index (schema) is what makes a double
 * `appendMessage` produce an error instead of two rows at one seq; this
 * store additionally serialises seq assignment behind a single retry loop
 * so a collision is corrected rather than surfaced to the caller.
 */

function toSeconds(d: Date | null): number {
  return d ? Math.floor(d.getTime() / 1000) : 0
}

function rowToThread(row: AgentThreadRow): AgentThread {
  return AgentThreadSchema.parse({
    id: row.id,
    agentId: row.agentId,
    title: row.title,
    origin: row.origin,
    onApprovalRequired: row.onApprovalRequired ?? 'pause',
    deviceScope: row.deviceScope ?? null,
    createdBy: row.createdBy,
    createdAt: toSeconds(row.createdAt),
    updatedAt: toSeconds(row.updatedAt),
  })
}

function rowToRun(row: AgentRunRow): AgentRun {
  return AgentRunSchema.parse({
    id: row.id,
    threadId: row.threadId,
    status: row.status,
    stopReason: row.stopReason,
    errorClass: row.errorClass,
    error: row.error,
    steps: row.steps,
    usage: row.usage ? AgentUsageSchema.parse(row.usage) : null,
    startedAt: row.startedAt ? toSeconds(row.startedAt) : null,
    finishedAt: row.finishedAt ? toSeconds(row.finishedAt) : null,
    parentRunId: row.parentRunId,
    rootRunId: row.rootRunId,
    depth: row.depth,
    awaited: row.awaited,
    deviceGrantsOverride: row.deviceGrantsOverride ?? null,
  })
}

function rowToMessage(row: AgentMessageRow): AgentMessage {
  return AgentMessageSchema.parse({
    id: row.id,
    threadId: row.threadId,
    runId: row.runId,
    seq: row.seq,
    role: row.role,
    content: row.content,
    createdAt: toSeconds(row.createdAt),
  })
}

export interface RunPatch {
  status?: AgentRunStatus
  stopReason?: AgentStopReason | null
  errorClass?: AgentErrorClass | null
  error?: string | null
  steps?: number
  usage?: AgentUsage | null
  startedAt?: Date | null
  finishedAt?: Date | null
}

export function createThreadStore(db: Db) {
  function createThread(input: {
    agentId: string
    title?: string | null
    origin?: AgentThreadOrigin
    /** Plan 68 §3.5 — set from the firing schedule's own setting for a `'schedule'`-origin thread; every other origin defaults to `'pause'` (a human in a chat is already watching). */
    onApprovalRequired?: 'pause' | 'deny'
    /** Plan 73 §4.6 — "Ask an agent" from a device page; applied to every run this thread starts. */
    deviceScope?: string[] | null
    createdBy?: string | null
  }): AgentThread {
    const now = new Date()
    const row: AgentThreadRow = {
      id: crypto.randomUUID(),
      agentId: input.agentId,
      title: input.title ?? null,
      origin: input.origin ?? 'chat',
      onApprovalRequired: input.onApprovalRequired ?? 'pause',
      deviceScope: input.deviceScope ?? null,
      createdBy: input.createdBy ?? null,
      createdAt: now,
      updatedAt: now,
    }
    db.insert(agentThreads).values(row).run()
    return rowToThread(row)
  }

  function getThread(id: string): AgentThread | null {
    const row = db.select().from(agentThreads).where(eq(agentThreads.id, id)).get()
    return row ? rowToThread(row) : null
  }

  function mustGetThread(id: string): AgentThread {
    const thread = getThread(id)
    if (!thread) throw new EnkakuError('thread_not_found', `no such thread: ${id}`)
    return thread
  }

  function touchThread(id: string): void {
    db.update(agentThreads).set({ updatedAt: new Date() }).where(eq(agentThreads.id, id)).run()
  }

  function listThreads(opts?: { agentId?: string }): AgentThread[] {
    if (opts?.agentId) {
      return db.select().from(agentThreads).where(eq(agentThreads.agentId, opts.agentId)).orderBy(desc(agentThreads.createdAt), desc(agentThreads.id)).all().map(rowToThread)
    }
    return db.select().from(agentThreads).orderBy(desc(agentThreads.createdAt), desc(agentThreads.id)).all().map(rowToThread)
  }

  /**
   * Creates a run (plan 66 §3.1) — plain by default (a root of a tree of
   * size one). Plan 67's `agent.spawn` passes `parentRunId`/`rootRunId`/
   * `depth`/`awaited` to place it correctly in a tree (§4.1): `rootRunId`
   * defaults to the new run's OWN id (it IS the root) when no parent is
   * given, `depth` defaults to 1 (a root), matching §3.6's table.
   */
  function createRun(
    threadId: string,
    tree?: { parentRunId?: string | null; rootRunId?: string; depth?: number; awaited?: boolean; deviceGrantsOverride?: string[] | null },
  ): AgentRun {
    const id = crypto.randomUUID()
    const row: AgentRunRow = {
      id,
      threadId,
      status: 'queued',
      stopReason: null,
      errorClass: null,
      error: null,
      steps: 0,
      usage: null,
      startedAt: null,
      finishedAt: null,
      parentRunId: tree?.parentRunId ?? null,
      rootRunId: tree?.rootRunId ?? id,
      depth: tree?.depth ?? 1,
      awaited: tree?.awaited ?? false,
      deviceGrantsOverride: tree?.deviceGrantsOverride ?? null,
    }
    db.insert(agentRuns).values(row).run()
    return rowToRun(row)
  }

  function getRun(id: string): AgentRun | null {
    const row = db.select().from(agentRuns).where(eq(agentRuns.id, id)).get()
    return row ? rowToRun(row) : null
  }

  function mustGetRun(id: string): AgentRun {
    const run = getRun(id)
    if (!run) throw new EnkakuError('run_not_found', `no such run: ${id}`)
    return run
  }

  function listRuns(threadId: string): AgentRun[] {
    return db.select().from(agentRuns).where(eq(agentRuns.threadId, threadId)).orderBy(desc(agentRuns.startedAt), desc(agentRuns.id)).all().map(rowToRun)
  }

  /** Direct children of a run (plan 67 §3.5's cascade, §3.7's tree-lease-holder queries). */
  function listChildRuns(parentRunId: string): AgentRun[] {
    return db.select().from(agentRuns).where(eq(agentRuns.parentRunId, parentRunId)).all().map(rowToRun)
  }

  /** Every run in a tree, for its lifetime — the run-count cap (plan 67 §3.6) and the shared token
   * budget (§3.6) both read this; also the ONE indexed query the tree's own shape is built from
   * (`idx_agent_runs_root`, plan 67 §4.1). */
  function listRunsForRoot(rootRunId: string): AgentRun[] {
    return db.select().from(agentRuns).where(eq(agentRuns.rootRunId, rootRunId)).all().map(rowToRun)
  }

  /** Every field is optional — only what is passed is patched (plan 66 §3.2, §3.7, §3.8). */
  function updateRun(id: string, patch: RunPatch): AgentRun {
    mustGetRun(id)
    const dbPatch: Partial<AgentRunRow> = {}
    if (patch.status !== undefined) dbPatch.status = patch.status
    if (patch.stopReason !== undefined) dbPatch.stopReason = patch.stopReason
    if (patch.errorClass !== undefined) dbPatch.errorClass = patch.errorClass
    if (patch.error !== undefined) dbPatch.error = patch.error
    if (patch.steps !== undefined) dbPatch.steps = patch.steps
    if (patch.usage !== undefined) dbPatch.usage = patch.usage
    if (patch.startedAt !== undefined) dbPatch.startedAt = patch.startedAt
    if (patch.finishedAt !== undefined) dbPatch.finishedAt = patch.finishedAt
    if (Object.keys(dbPatch).length > 0) db.update(agentRuns).set(dbPatch).where(eq(agentRuns.id, id)).run()
    return mustGetRun(id)
  }

  /**
   * The next seq for a thread. Fully synchronous, no `await` between the
   * read and the caller's insert — Bun's SQLite driver and the single-
   * threaded event loop mean nothing else can interleave inside one
   * synchronous call, and the DB's unique index (schema) is the backstop
   * if this is ever called from two processes.
   */
  function nextSeq(threadId: string): number {
    const row = db
      .select({ maxSeq: sql<number | null>`max(${agentMessages.seq})` })
      .from(agentMessages)
      .where(eq(agentMessages.threadId, threadId))
      .get()
    return (row?.maxSeq ?? 0) + 1
  }

  /**
   * Appends one message (plan 66 §3.1, §4.1) — append-only, never an update.
   * Retries the seq assignment a bounded number of times on a unique-index
   * collision (`idx_agent_messages_seq`) rather than surfacing a transient
   * error to a caller that did nothing wrong; the index itself is what
   * makes a genuine double submit produce exactly one winner (criterion 15).
   */
  function appendMessage(input: { threadId: string; runId: string | null; role: AgentMessageRole; content: AgentContentBlock[] }): AgentMessage {
    mustGetThread(input.threadId)
    const MAX_ATTEMPTS = 5
    let lastErr: unknown
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const seq = nextSeq(input.threadId)
      const row: AgentMessageRow = {
        id: crypto.randomUUID(),
        threadId: input.threadId,
        runId: input.runId,
        seq,
        role: input.role,
        content: input.content,
        createdAt: new Date(),
      }
      try {
        db.insert(agentMessages).values(row).run()
        touchThread(input.threadId)
        return rowToMessage(row)
      } catch (err) {
        lastErr = err
        const msg = err instanceof Error ? err.message : String(err)
        if (!msg.includes('UNIQUE constraint failed')) throw err
        // Another append won the same seq — loop and try the next one.
      }
    }
    throw new EnkakuError('E_SEQ_CONFLICT', `could not assign a unique seq to a message in thread ${input.threadId} after ${MAX_ATTEMPTS} attempts: ${String(lastErr)}`)
  }

  function listMessages(threadId: string, opts?: { after?: number }): AgentMessage[] {
    mustGetThread(threadId)
    const where = opts?.after !== undefined ? and(eq(agentMessages.threadId, threadId), gt(agentMessages.seq, opts.after)) : eq(agentMessages.threadId, threadId)
    return db.select().from(agentMessages).where(where).orderBy(asc(agentMessages.seq)).all().map(rowToMessage)
  }

  function messagesForRun(runId: string): AgentMessage[] {
    return db.select().from(agentMessages).where(eq(agentMessages.runId, runId)).orderBy(asc(agentMessages.seq)).all().map(rowToMessage)
  }

  /**
   * Restart recovery (plan 66 §4.3, criterion 9): a run left `running` did
   * not survive the crash/restart that stopped the process running its
   * loop — it is marked `failed` / `interrupted`, never silently resumed.
   * A `paused` run (waiting on an approval) is left exactly as it is: that
   * is what an approval row exists to survive.
   */
  function recoverInterruptedRuns(): AgentRun[] {
    const stuck = db.select().from(agentRuns).where(eq(agentRuns.status, 'running')).all()
    const recovered: AgentRun[] = []
    for (const row of stuck) {
      recovered.push(updateRun(row.id, { status: 'failed', stopReason: 'error', errorClass: null, error: 'interrupted by a core restart', finishedAt: new Date() }))
    }
    return recovered
  }

  /**
   * Plan 68 §3.3 — farm-wide count of SCHEDULED-origin runs currently
   * active (queued, running, or paused) — the scheduled-concurrency
   * ceiling. Joins on `agentThreads.origin === 'schedule'` rather than a
   * per-run flag: a thread's origin is fixed at creation (`runScheduled
   * Firing` always creates/reuses a `'schedule'`-origin thread), so this
   * one query correctly counts across every schedule farm-wide, whatever
   * `threadMode` each used.
   */
  function countActiveScheduledRuns(): number {
    return db
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .innerJoin(agentThreads, eq(agentRuns.threadId, agentThreads.id))
      .where(and(eq(agentThreads.origin, 'schedule'), inArray(agentRuns.status, ['queued', 'running', 'paused'])))
      .all().length
  }

  /**
   * Plan 68 §3.3 — farm-wide output tokens spent by SCHEDULED-origin runs
   * that STARTED within the rolling window ending `now` — the spend cap.
   * A run counts toward the window it began in (not when it finishes),
   * matching "a rolling 24h ceiling" as a spend-RATE control rather than a
   * per-run total. Deliberately reads only `agentThreads.origin ===
   * 'schedule'` runs — an interactive chat run's usage NEVER contributes
   * to this sum, which is what makes the cap structurally incapable of
   * blocking one (plan 68 §3.3, criterion 7): the interactive path
   * (`postMessage`) never even calls this function.
   */
  function spentOutputTokensLast24h(windowStart: Date): number {
    const rows = db
      .select({ usage: agentRuns.usage })
      .from(agentRuns)
      .innerJoin(agentThreads, eq(agentRuns.threadId, agentThreads.id))
      .where(and(eq(agentThreads.origin, 'schedule'), gte(agentRuns.startedAt, windowStart)))
      .all()
    let total = 0
    for (const row of rows) {
      const parsed = AgentUsageSchema.safeParse(row.usage)
      if (parsed.success) total += parsed.data.outputTokens
    }
    return total
  }

  /** How many messages and runs a thread carries — used both to preview a delete (plan 83 §3.6,
   * criterion 16: "the confirm names how many messages and runs will be deleted") and as the
   * summary `deleteThread` itself returns, so the two numbers can never drift apart. */
  function countsForThread(id: string): { messages: number; runs: number } {
    mustGetThread(id)
    const messages = db.select({ id: agentMessages.id }).from(agentMessages).where(eq(agentMessages.threadId, id)).all().length
    const runs = db.select({ id: agentRuns.id }).from(agentRuns).where(eq(agentRuns.threadId, id)).all().length
    return { messages, runs }
  }

  /**
   * Deletes a thread and everything that points at it — its runs, its
   * messages, its approvals, and its tree nodes (the run tree IS
   * `agentRuns`/`agentInbox`, keyed by `parentRunId`/`rootRunId` and
   * `targetRunId`/`fromRunId` — there is no separate "tree node" table) —
   * in ONE transaction, the same discipline `device/lifecycle.ts` already
   * applies to a forgotten device (plan 83 §3.6).
   *
   * Refused, not force-killed, while any run is still active (`queued` /
   * `running` / `paused`): cancel first, then delete. A delete that
   * silently aborts an agent mid-tool-call is the kind of surprise that
   * costs an operator a device left in a strange state.
   *
   * Blobs (plan 70) are deliberately NOT touched — they are content-
   * addressed and may be shared across threads; deleting them here would
   * risk breaking another thread's transcript. That is the retention GC's
   * problem, not this one.
   */
  function deleteThread(id: string): { messages: number; runs: number } {
    mustGetThread(id)
    const activeRuns = db
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(and(eq(agentRuns.threadId, id), inArray(agentRuns.status, ['queued', 'running', 'paused'])))
      .all()
    if (activeRuns.length > 0) {
      throw new EnkakuError('E_THREAD_RUN_ACTIVE', `thread ${id} has an active run — cancel it before deleting the thread`)
    }

    const counts = countsForThread(id)
    const runIds = db.select({ id: agentRuns.id }).from(agentRuns).where(eq(agentRuns.threadId, id)).all().map((r) => r.id)

    db.transaction((tx) => {
      if (runIds.length > 0) {
        tx.delete(agentApprovals).where(inArray(agentApprovals.runId, runIds)).run()
        tx.delete(agentInbox).where(inArray(agentInbox.targetRunId, runIds)).run()
        tx.delete(agentInbox).where(inArray(agentInbox.fromRunId, runIds)).run()
      }
      tx.delete(agentMessages).where(eq(agentMessages.threadId, id)).run()
      tx.delete(agentRuns).where(eq(agentRuns.threadId, id)).run()
      tx.delete(agentThreads).where(eq(agentThreads.id, id)).run()
    })

    return counts
  }

  return {
    createThread,
    getThread,
    mustGetThread,
    listThreads,
    createRun,
    getRun,
    mustGetRun,
    listRuns,
    listChildRuns,
    listRunsForRoot,
    updateRun,
    appendMessage,
    listMessages,
    messagesForRun,
    recoverInterruptedRuns,
    countActiveScheduledRuns,
    spentOutputTokensLast24h,
    countsForThread,
    deleteThread,
  }
}

export type ThreadStore = ReturnType<typeof createThreadStore>
