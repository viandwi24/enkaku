import { inArray, lt, sql } from 'drizzle-orm'
import { changedRows } from '../../db'
import type { Db } from '../../db'
import { agentBlobs } from '../../db/schema'
import type { FarmSettingsStore } from '../../settings/farm-settings'
import type { Logger } from '../../util/logger'

/**
 * Retention for `agent_blobs` (spec §18's "artifact retention and GC", the
 * shape `maintenance/retention.ts` already applies to `artifacts` and
 * `device_events`) — the one case that policy could not just be reused for,
 * because a blob is content-addressed and shared across threads
 * (`agent/blob/store.ts`'s dedupe, `agent/thread/store.ts`'s `deleteThread`
 * comment: "Blobs ... are deliberately NOT touched ... That is the retention
 * GC's problem, not this one"). A blob still referenced by ANY message,
 * anywhere, is never a deletion candidate regardless of age — only a blob no
 * message references (an orphan) is ever swept, and only once it has sat
 * unreferenced past a grace window (protocol's `retention.blobOrphanGraceHours`).
 *
 * This deliberately does NOT bound a blob still referenced by a long-lived,
 * never-deleted thread — every screenshot an active agent thread's tool
 * calls capture stays live for as long as that thread exists, by design
 * (deleting one a live thread renders would be worse than the growth this
 * sweep is meant to fix). Bounding *that* growth needs either a product
 * decision to let old in-scrollback images expire (a placeholder UI change,
 * out of this module's scope) or moving bytes out of the database entirely;
 * this sweep only reclaims the part that is safe to reclaim unconditionally:
 * dead rows nothing points at any more.
 */

export interface BlobGc {
  start(): void
  stop(): void
  sweepOnce(): { deleted: number; freedBytes: number }
}

/**
 * Every blob id referenced by an image content block anywhere in
 * `agent_messages.content` — a top-level block (a person's own attachment,
 * `agent/runner.ts`'s `attachmentBlocks`) or nested inside a `tool_result`
 * block's own `content` array (an agent's screenshot, `agent/harness/
 * run.ts`'s image-output handling). `agent_inbox.body` is never scanned: it
 * only ever carries plain text (`{ text, fromAgentName }` for `agent.send`/
 * `agent.reply`, or `extractFinalText`'s string for a detached child's
 * result) — traced at `agent/runner.ts`'s two `tree.enqueue` call sites —
 * so a blob can never be reachable ONLY through an undelivered inbox item.
 *
 * One JSON1 query rather than parsing every row's `content` in JS: cheaper,
 * and consistent with `bun:sqlite` shipping JSON1 built in.
 */
function referencedBlobIds(db: Db): Set<string> {
  const rows = db.all<{ blobId: string }>(sql`
    SELECT DISTINCT blob_id AS blobId FROM (
      SELECT json_extract(elem.value, '$.blobId') AS blob_id
      FROM agent_messages, json_each(agent_messages.content) AS elem
      WHERE json_extract(elem.value, '$.type') = 'image'
      UNION ALL
      SELECT json_extract(inner_elem.value, '$.blobId') AS blob_id
      FROM agent_messages, json_each(agent_messages.content) AS elem, json_each(elem.value, '$.content') AS inner_elem
      WHERE json_extract(elem.value, '$.type') = 'tool_result' AND json_extract(inner_elem.value, '$.type') = 'image'
    )
    WHERE blob_id IS NOT NULL
  `)
  return new Set(rows.map((r) => r.blobId))
}

export function createBlobGc(deps: {
  db: Db
  settings: FarmSettingsStore
  log: Logger
  intervalMinutes: number
  onSwept?: (result: { deleted: number; freedBytes: number }) => void
}): BlobGc {
  let timer: ReturnType<typeof setInterval> | null = null

  function sweepOnce(): { deleted: number; freedBytes: number } {
    const graceHours = deps.settings.get().retention.blobOrphanGraceHours
    const cutoff = new Date(Date.now() - graceHours * 60 * 60 * 1000)

    // Old enough to be a candidate at all — the common case (a screenshot from minutes ago,
    // referenced or not) never even reaches the referenced-id check below.
    const candidates = deps.db.select({ id: agentBlobs.id, bytes: agentBlobs.bytes }).from(agentBlobs).where(lt(agentBlobs.createdAt, cutoff)).all()
    if (candidates.length === 0) return { deleted: 0, freedBytes: 0 }

    const referenced = referencedBlobIds(deps.db)
    const orphaned = candidates.filter((row) => !referenced.has(row.id))
    if (orphaned.length === 0) return { deleted: 0, freedBytes: 0 }

    const ids = orphaned.map((row) => row.id)
    const freedBytes = orphaned.reduce((sum, row) => sum + row.bytes, 0)
    const deleted = changedRows(deps.db.delete(agentBlobs).where(inArray(agentBlobs.id, ids)).run())

    if (deleted > 0) {
      deps.log.info(`blob retention: deleted ${deleted} unreferenced screenshot blob(s) (${(freedBytes / 1024 ** 2).toFixed(1)} MB)`)
      deps.onSwept?.({ deleted, freedBytes })
    }
    return { deleted, freedBytes }
  }

  return {
    start() {
      if (timer) return
      timer = setInterval(() => void sweepOnce(), deps.intervalMinutes * 60_000)
      sweepOnce()
    },
    stop() {
      if (timer) clearInterval(timer)
      timer = null
    },
    sweepOnce,
  }
}
