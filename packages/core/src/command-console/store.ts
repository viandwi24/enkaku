import { and, asc, desc, eq, inArray, like, sql } from 'drizzle-orm'
import {
  COMMAND_MEMBER_STATUSES,
  COMMAND_RUN_STATUSES,
  CommandTargetSchema,
  type CommandCounts,
  type CommandMemberStatus,
  type CommandRunStatus,
  type CommandTarget,
} from '@enkaku/protocol'
import type { Db } from '../db'
import { commandRunMembers, commandRuns, type CommandRunMemberRow, type CommandRunRow } from '../db/schema'
import { EnkakuError } from '../util/errors'
import { decodeCursor, encodeCursor, keysetWhere, type Page } from '../api/pagination'

/**
 * Step 93.2's own storage layer for the command console (plan 93 §3.3,
 * §3.4, §4.2, §5 step 93.2) — `command_runs` + `command_run_members`, the
 * fleet command history. `saved_commands` gets its own store in step 93.6
 * (`command-console/saved.ts`, not this file); the runner (`runner.ts`,
 * step 93.3) and the REST surface (`api/command-runs.ts`, step 93.4) are
 * built on TOP of what is here, not part of it.
 *
 * **The target/status shapes are `@enkaku/protocol`'s, imported and
 * re-exported below.** They started out declared LOCALLY here, because at
 * step 93.2 `packages/protocol/src/command/` was step 93.1's/93.4's
 * directory and this step did not own it. Step 93.4 built the real copy
 * (`command/target.ts`) and this file was updated to import from it —
 * re-exporting the same names (`CommandTargetSchema`, `CommandTarget`,
 * `COMMAND_MEMBER_STATUSES`, `COMMAND_RUN_STATUSES`, `CommandCounts`,
 * `CommandMemberStatus`, `CommandRunStatus`) so every existing importer
 * (`runner.ts`, `store.test.ts`, `api/command-runs.ts`) keeps compiling
 * unchanged whether it reaches them through `./store` or `@enkaku/protocol`
 * directly.
 *
 * **Single writer, synchronous, no `await` inside a read-modify-write** —
 * the same argument `kv/store.ts` makes and this file inherits rather than
 * merely copies the shape of: every command-console call, from every WS
 * connection and every HTTP request, funnels through this one core process
 * over IPC/HTTP. There is no second writer touching this file, so a
 * "concurrent" caller within this process can never interleave mid-
 * operation, and plain sequential `db.<verb>(...).run()` calls (rather than
 * `db.transaction()`) are enough for the cascades below (`trimForUser`,
 * `sweepOrphans`, `deleteRun`) to behave atomically in practice — matching
 * `kv/store.ts`'s own choice not to wrap `delete`/`deleteNamespace` in a
 * transaction for the same reason.
 */

export { CommandTargetSchema, COMMAND_MEMBER_STATUSES, COMMAND_RUN_STATUSES }
export type { CommandTarget, CommandCounts, CommandMemberStatus, CommandRunStatus }

/** Non-terminal run statuses — what `sweepOrphans` (plan 93 §3.7) looks for at boot. */
const NON_TERMINAL_RUN_STATUSES: CommandRunStatus[] = ['running', 'awaiting-continue']
/** Non-terminal member statuses — cancelled alongside their run on an orphan sweep. */
const NON_TERMINAL_MEMBER_STATUSES: CommandMemberStatus[] = ['pending', 'running']

export interface CommandRunMemberInfo {
  deviceId: string
  seq: number
  stageIndex: number
  status: CommandMemberStatus
  exitCode: number | null
  durationMs: number | null
  stdout: string | null
  stderr: string | null
  truncated: boolean
  outputHash: string | null
  /** `checkInputAllowed`'s own code + message, verbatim (plan 93 §3.8). Null unless `status === 'skipped'`. */
  skip: { code: string; message: string } | null
  error: string | null
}

export interface CommandRunInfo {
  id: string
  cmd: string
  target: CommandTarget
  savedCommandId: string | null
  stageFirstN: number
  stage: number
  concurrency: number
  status: CommandRunStatus
  acknowledged: boolean
  createdBy: string | null
  startedAt: number
  finishedAt: number | null
  members: CommandRunMemberInfo[]
}

/** The list-page shape — no member bodies (§3.6: full output is fetched per device, on demand, never inline for all N). */
export interface CommandRunSummary {
  id: string
  cmd: string
  target: CommandTarget
  savedCommandId: string | null
  stageFirstN: number
  stage: number
  concurrency: number
  status: CommandRunStatus
  acknowledged: boolean
  createdBy: string | null
  startedAt: number
  finishedAt: number | null
  counts: CommandCounts
}

export interface CreateCommandRunInput {
  cmd: string
  target: CommandTarget
  savedCommandId?: string | null
  stageFirstN?: number
  concurrency?: number
  acknowledged?: boolean
  createdBy: string | null
  /** Dispatch order is array order — `seq` is assigned from the index unless a member gives its own. */
  members: { deviceId: string; seq?: number; stageIndex?: number }[]
  startedAt?: Date
}

export interface UpdateCommandRunMemberInput {
  status?: CommandMemberStatus
  exitCode?: number | null
  durationMs?: number | null
  stdout?: string | null
  stderr?: string | null
  truncated?: boolean
  outputHash?: string | null
  skipCode?: string | null
  skipMessage?: string | null
  error?: string | null
  stageIndex?: number
}

export interface FinishCommandRunInput {
  status: CommandRunStatus
  finishedAt?: Date
}

export interface ListCommandRunsQuery {
  /** Exact match on `createdBy` — the `?mine=1` filter (plan 93 §3.9). */
  createdBy?: string | null
  /** Only runs that targeted this device (a member row exists for it), regardless of that member's own outcome. */
  deviceId?: string | null
  /** Substring match over `cmd`, case-sensitive (SQLite `LIKE` is case-insensitive for ASCII only — matching `device-events.ts`'s own `like()` use, not a new convention). */
  q?: string | null
  status?: CommandRunStatus | null
  cursor: string | null
  limit: number
}

export interface CommandRunStore {
  create(input: CreateCommandRunInput): CommandRunInfo
  /**
   * Step 93.5's addition — plan 93 §3.3's collapse of two concepts into one:
   * "a single-device terminal command is a run with ONE member". Convenience
   * over `create` + `updateMember`, not a second code path: builds a
   * `{ deviceIds: [deviceId] }` target, a one-member run, and moves that
   * member straight to `running` — `ws-handlers.ts`'s `shell.exec` case calls
   * this only AFTER its own lease check already passed (F18), so unlike the
   * runner's `runOneMember` there is no `admit`/`skipped` branch to record
   * here; the member either runs or the caller never reaches this call.
   * Returns the created run so the caller finishes it with `updateMember` +
   * `finish` once the exec settles, exactly as any other member would be.
   */
  recordSingle(input: { cmd: string; deviceId: string; actor: string | null }): CommandRunInfo
  /** Throws `command_run_member_not_found` if the (runId, deviceId) pair does not exist. */
  updateMember(runId: string, deviceId: string, patch: UpdateCommandRunMemberInput): void
  /** Throws `run_not_found` if the run does not exist. */
  finish(runId: string, input: FinishCommandRunInput): void
  /**
   * Step 93.3's addition — the two NON-terminal status transitions a staged
   * run makes (plan 93 §3.7): `running` → `awaiting-continue` after stage 1,
   * and `awaiting-continue` → `running` when the operator continues.
   * Deliberately separate from `finish()`, which stamps `finishedAt` and is
   * for the four TERMINAL statuses only (`ok`/`failed`/`cancelled`, plus the
   * degenerate never-really-used `running`-as-terminal case `finish` also
   * accepts) — `awaiting-continue` is a pause, not an end, and must not look
   * finished on the history list while an operator is still deciding whether
   * to continue it. Throws `run_not_found` if the run does not exist.
   */
  setStage(runId: string, input: { status: 'running' | 'awaiting-continue'; stage: number }): void
  get(runId: string): CommandRunInfo | null
  listPage(query: ListCommandRunsQuery): Page<CommandRunSummary>
  /** Deletes the oldest runs (and their members) for `createdBy` beyond `cap`, oldest-first (plan 93 §3.9's `commandRunsPerUser`). Returns the number of runs deleted. */
  trimForUser(createdBy: string, cap: number): number
  /** Boot sweep, mirroring `failOrphanRunning` (plan 93 §3.7, F29): every non-terminal run becomes `cancelled`, and every `pending`/`running` member of it becomes `cancelled` with `error: 'the core restarted'`. Returns the number of runs swept. */
  sweepOrphans(): number
  /** Deletes a run and cascades its members. Returns false if the run did not exist. */
  deleteRun(runId: string): boolean
}

function toSeconds(d: Date): number {
  return Math.floor(d.getTime() / 1000)
}

function parseTarget(row: CommandRunRow): CommandTarget {
  const result = CommandTargetSchema.safeParse(row.target)
  if (!result.success) {
    // Every row is written by `create()` below, through the same schema —
    // a parse failure here means on-disk corruption, not a possible input
    // shape this store ever needs to degrade gracefully for (unlike a
    // nullable, optionally-absent field elsewhere in the schema).
    throw new EnkakuError('E_DB', `command_runs row ${row.id} has an invalid target JSON payload`)
  }
  return result.data
}

function toMemberInfo(row: CommandRunMemberRow): CommandRunMemberInfo {
  return {
    deviceId: row.deviceId,
    seq: row.seq,
    stageIndex: row.stageIndex,
    status: row.status as CommandMemberStatus,
    exitCode: row.exitCode ?? null,
    durationMs: row.durationMs ?? null,
    stdout: row.stdout ?? null,
    stderr: row.stderr ?? null,
    truncated: row.truncated,
    outputHash: row.outputHash ?? null,
    skip: row.skipCode ? { code: row.skipCode, message: row.skipMessage ?? '' } : null,
    error: row.error ?? null,
  }
}

function toRunInfo(row: CommandRunRow, members: CommandRunMemberRow[]): CommandRunInfo {
  return {
    id: row.id,
    cmd: row.cmd,
    target: parseTarget(row),
    savedCommandId: row.savedCommandId ?? null,
    stageFirstN: row.stageFirstN,
    stage: row.stage,
    concurrency: row.concurrency,
    status: row.status as CommandRunStatus,
    acknowledged: row.acknowledged,
    createdBy: row.createdBy ?? null,
    startedAt: toSeconds(row.startedAt),
    finishedAt: row.finishedAt ? toSeconds(row.finishedAt) : null,
    members: members.map(toMemberInfo),
  }
}

function emptyCounts(): CommandCounts {
  return { total: 0, pending: 0, running: 0, ok: 0, failed: 0, skipped: 0, cancelled: 0 }
}

/** Group members by run and roll up per-status counts, for the runIds given — never the whole table (plan 30's own "no unbounded fetch" rule, applied to a page's worth of runs at a time). */
function countsForRuns(db: Db, runIds: string[]): Map<string, CommandCounts> {
  const out = new Map<string, CommandCounts>()
  if (runIds.length === 0) return out
  const rows = db
    .select({ runId: commandRunMembers.runId, status: commandRunMembers.status, n: sql<number>`count(*)`.as('n') })
    .from(commandRunMembers)
    .where(inArray(commandRunMembers.runId, runIds))
    .groupBy(commandRunMembers.runId, commandRunMembers.status)
    .all()
  for (const row of rows) {
    const counts = out.get(row.runId) ?? emptyCounts()
    const status = row.status as CommandMemberStatus
    if (status in counts) (counts as unknown as Record<string, number>)[status] = row.n
    counts.total += row.n
    out.set(row.runId, counts)
  }
  return out
}

function toSummary(row: CommandRunRow, counts: CommandCounts): CommandRunSummary {
  return {
    id: row.id,
    cmd: row.cmd,
    target: parseTarget(row),
    savedCommandId: row.savedCommandId ?? null,
    stageFirstN: row.stageFirstN,
    stage: row.stage,
    concurrency: row.concurrency,
    status: row.status as CommandRunStatus,
    acknowledged: row.acknowledged,
    createdBy: row.createdBy ?? null,
    startedAt: toSeconds(row.startedAt),
    finishedAt: row.finishedAt ? toSeconds(row.finishedAt) : null,
    counts,
  }
}

export function createCommandRunStore(db: Db): CommandRunStore {
  const getRunRow = (id: string): CommandRunRow | null => db.select().from(commandRuns).where(eq(commandRuns.id, id)).get() ?? null

  const getMemberRows = (runId: string): CommandRunMemberRow[] =>
    db.select().from(commandRunMembers).where(eq(commandRunMembers.runId, runId)).orderBy(asc(commandRunMembers.seq)).all()

  const deleteCascade = (runIds: string[]): void => {
    if (runIds.length === 0) return
    db.delete(commandRunMembers).where(inArray(commandRunMembers.runId, runIds)).run()
    db.delete(commandRuns).where(inArray(commandRuns.id, runIds)).run()
  }

  // A `const` bound to the object being built, not `return { ... }` directly
  // — `recordSingle` below is a convenience over `create` + `updateMember`
  // and calls them back through this binding. Safe: `recordSingle` only
  // dereferences `store` when a caller invokes it, by which time this
  // declaration has long finished initialising (an ordinary JS closure, not
  // a self-reference at construction time).
  const store: CommandRunStore = {
    create(input) {
      const id = crypto.randomUUID()
      const startedAt = input.startedAt ?? new Date()
      db.insert(commandRuns)
        .values({
          id,
          cmd: input.cmd,
          target: input.target,
          savedCommandId: input.savedCommandId ?? null,
          stageFirstN: input.stageFirstN ?? 0,
          stage: 1,
          concurrency: input.concurrency ?? 0,
          status: 'running',
          acknowledged: input.acknowledged ?? false,
          createdBy: input.createdBy,
          startedAt,
          finishedAt: null,
        })
        .run()

      if (input.members.length > 0) {
        db.insert(commandRunMembers)
          .values(
            input.members.map((m, i) => ({
              runId: id,
              deviceId: m.deviceId,
              seq: m.seq ?? i,
              status: 'pending' as const,
              stageIndex: m.stageIndex ?? 1,
              truncated: false,
            })),
          )
          .run()
      }

      const row = getRunRow(id)
      if (!row) throw new EnkakuError('E_DB', `command_runs row ${id} vanished immediately after insert`)
      return toRunInfo(row, getMemberRows(id))
    },

    recordSingle(input) {
      const run = store.create({
        cmd: input.cmd,
        target: { deviceIds: [input.deviceId] },
        createdBy: input.actor,
        members: [{ deviceId: input.deviceId }],
      })
      // `create` always writes a member as `pending` (it has no other caller
      // that would want otherwise). This one call site's member is about to
      // execute immediately — the lease check already passed — so it moves
      // straight to `running`, matching the runner's own `runOneMember`
      // (`command-console/runner.ts`) rather than inventing a second
      // in-between state nothing else uses.
      store.updateMember(run.id, input.deviceId, { status: 'running' })
      // `run` above was captured before the update — its one member still
      // reads `pending`. Re-fetched so the caller (`ws-handlers.ts`) sees
      // the true post-update shape, the same freshness `updateMember` gives
      // every other caller (it never returns the row itself).
      return store.get(run.id) ?? run
    },

    updateMember(runId, deviceId, patch) {
      const existing = db
        .select()
        .from(commandRunMembers)
        .where(and(eq(commandRunMembers.runId, runId), eq(commandRunMembers.deviceId, deviceId)))
        .get()
      if (!existing) throw new EnkakuError('command_run_member_not_found', `no member ${deviceId} on run ${runId}`)

      const set: Partial<typeof commandRunMembers.$inferInsert> = {}
      if (patch.status !== undefined) set.status = patch.status
      if (patch.exitCode !== undefined) set.exitCode = patch.exitCode
      if (patch.durationMs !== undefined) set.durationMs = patch.durationMs
      if (patch.stdout !== undefined) set.stdout = patch.stdout
      if (patch.stderr !== undefined) set.stderr = patch.stderr
      if (patch.truncated !== undefined) set.truncated = patch.truncated
      if (patch.outputHash !== undefined) set.outputHash = patch.outputHash
      if (patch.skipCode !== undefined) set.skipCode = patch.skipCode
      if (patch.skipMessage !== undefined) set.skipMessage = patch.skipMessage
      if (patch.error !== undefined) set.error = patch.error
      if (patch.stageIndex !== undefined) set.stageIndex = patch.stageIndex

      if (Object.keys(set).length === 0) return
      db.update(commandRunMembers)
        .set(set)
        .where(and(eq(commandRunMembers.runId, runId), eq(commandRunMembers.deviceId, deviceId)))
        .run()
    },

    finish(runId, input) {
      const existing = getRunRow(runId)
      if (!existing) throw new EnkakuError('run_not_found', `no such command run: ${runId}`)
      db.update(commandRuns)
        .set({ status: input.status, finishedAt: input.finishedAt ?? new Date() })
        .where(eq(commandRuns.id, runId))
        .run()
    },

    setStage(runId, input) {
      const existing = getRunRow(runId)
      if (!existing) throw new EnkakuError('run_not_found', `no such command run: ${runId}`)
      db.update(commandRuns).set({ status: input.status, stage: input.stage }).where(eq(commandRuns.id, runId)).run()
    },

    get(runId) {
      const row = getRunRow(runId)
      if (!row) return null
      return toRunInfo(row, getMemberRows(runId))
    },

    listPage(query) {
      const conds = []
      if (query.createdBy) conds.push(eq(commandRuns.createdBy, query.createdBy))
      if (query.status) conds.push(eq(commandRuns.status, query.status))
      if (query.q) conds.push(like(commandRuns.cmd, `%${query.q}%`))
      if (query.deviceId) {
        const memberRunIds = db
          .selectDistinct({ runId: commandRunMembers.runId })
          .from(commandRunMembers)
          .where(eq(commandRunMembers.deviceId, query.deviceId))
          .all()
          .map((r) => r.runId)
        // An empty match set must still produce zero rows, not "no filter at
        // all" — `inArray` with an empty array already does that correctly.
        conds.push(inArray(commandRuns.id, memberRunIds))
      }

      const cursor = decodeCursor(query.cursor)
      const keyset = keysetWhere(cursor ? { value: new Date(cursor.sortValue * 1000), id: cursor.id } : null, commandRuns.startedAt, commandRuns.id)
      if (keyset) conds.push(keyset)

      const page = db
        .select()
        .from(commandRuns)
        .where(conds.length > 0 ? and(...conds) : undefined)
        .orderBy(desc(commandRuns.startedAt), desc(commandRuns.id))
        .limit(query.limit + 1)
        .all()

      const hasMore = page.length > query.limit
      const rows = hasMore ? page.slice(0, query.limit) : page
      const last = rows[rows.length - 1]
      const nextCursor = hasMore && last ? encodeCursor(toSeconds(last.startedAt), last.id) : null

      const counts = countsForRuns(
        db,
        rows.map((r) => r.id),
      )
      return {
        items: rows.map((r) => toSummary(r, counts.get(r.id) ?? emptyCounts())),
        nextCursor,
        // Deliberately null, matching `device-events.ts`'s own reasoning
        // (plan 30 §8 risks) — counting a per-user history on every page is
        // not cheap enough to be worth it for a value nothing here needs.
        total: null,
      }
    },

    trimForUser(createdBy, cap) {
      const rows = db
        .select({ id: commandRuns.id })
        .from(commandRuns)
        .where(eq(commandRuns.createdBy, createdBy))
        .orderBy(asc(commandRuns.startedAt), asc(commandRuns.id))
        .all()
      const excess = rows.length - cap
      if (excess <= 0) return 0
      const idsToDelete = rows.slice(0, excess).map((r) => r.id)
      deleteCascade(idsToDelete)
      return idsToDelete.length
    },

    sweepOrphans() {
      const orphaned = db.select({ id: commandRuns.id }).from(commandRuns).where(inArray(commandRuns.status, NON_TERMINAL_RUN_STATUSES)).all()
      if (orphaned.length === 0) return 0
      const runIds = orphaned.map((r) => r.id)
      const now = new Date()

      db.update(commandRunMembers)
        .set({ status: 'cancelled', error: 'the core restarted' })
        .where(and(inArray(commandRunMembers.runId, runIds), inArray(commandRunMembers.status, NON_TERMINAL_MEMBER_STATUSES)))
        .run()

      db.update(commandRuns)
        .set({ status: 'cancelled', finishedAt: now })
        .where(inArray(commandRuns.id, runIds))
        .run()

      return runIds.length
    },

    deleteRun(runId) {
      const existing = getRunRow(runId)
      if (!existing) return false
      deleteCascade([runId])
      return true
    },
  }
  return store
}
