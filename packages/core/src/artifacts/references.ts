import { eq, inArray } from 'drizzle-orm'
import type { ArtifactInfo, ArtifactReference } from '@enkaku/protocol'
import type { Db } from '../db'
import { artifacts, batches, jobRuns, jobs, kvEntries, paramPresets, schedules, workflows, type ArtifactRow } from '../db/schema'

/**
 * Who still names an artifact (owner request 2026-09-16: "files keep piling
 * up" — and cleaning them must not silently break the work that uses them).
 *
 * Generic on purpose. Nothing here knows the Social Media Manager exists: an
 * artifact id is a UUID, and a UUID that appears verbatim in a job's params, a
 * batch's params, a schedule, a saved workflow, a preset, or ANY plugin KV
 * row's key or value is a reference. That is how SMM's `post:<videoArtifactId>`
 * rows are found, and how the next plugin's rows will be found without anyone
 * editing this file.
 *
 * What it deliberately cannot see, and says so rather than implying coverage:
 * - a SECRET KV value — encrypted at rest, so there is nothing to search;
 * - anything a plugin keeps outside the farm's KV store;
 * - an id stored in some transformed form (split, hashed, base64'd).
 */

/** A batch still able to start (or repeat) members. `stopping` still has running members. */
const ACTIVE_BATCH_STATUSES = ['queued', 'running', 'stopping']

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi

export function artifactRowToInfo(r: ArtifactRow): ArtifactInfo {
  return {
    id: r.id,
    runId: r.runId,
    deviceId: r.deviceId,
    kind: r.kind as ArtifactInfo['kind'],
    label: r.label,
    path: r.path,
    sizeBytes: r.sizeBytes,
    createdAt: r.createdAt ? Math.floor(r.createdAt.getTime() / 1000) : 0,
    pinned: r.pinned,
    mimeType: r.mimeType,
    width: r.width,
    height: r.height,
    durationMs: r.durationMs,
  }
}

/** One artifact by id, or null. The read `artifact.get` answers with. */
export function getArtifactInfo(db: Db, id: string): ArtifactInfo | null {
  const row = db.select().from(artifacts).where(eq(artifacts.id, id)).get()
  return row ? artifactRowToInfo(row) : null
}

/**
 * Which of `ids` occur in a piece of text. UUID-shaped ids are found in ONE
 * regex pass over the text (so a farm with a large KV table costs a scan per
 * row, not a scan per row per id); anything else falls back to `includes`.
 */
function matcherFor(ids: readonly string[]): (text: string) => string[] {
  const uuidIds = new Set<string>()
  const otherIds: string[] = []
  for (const id of ids) {
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) uuidIds.add(id.toLowerCase())
    else otherIds.push(id)
  }
  const byLower = new Map<string, string>()
  for (const id of ids) byLower.set(id.toLowerCase(), id)
  return (text) => {
    const found = new Set<string>()
    if (uuidIds.size > 0) {
      for (const m of text.matchAll(UUID)) {
        const lower = m[0].toLowerCase()
        if (uuidIds.has(lower)) found.add(byLower.get(lower) as string)
      }
    }
    for (const id of otherIds) if (text.includes(id)) found.add(id)
    return [...found]
  }
}

const json = (value: unknown): string => (value === null || value === undefined ? '' : typeof value === 'string' ? value : JSON.stringify(value))

/**
 * Every reference to each of `ids`, blocking ones first. An id with no
 * reference is absent from the map.
 */
export function findArtifactReferences(db: Db, ids: readonly string[], nowSec: number = Math.floor(Date.now() / 1000)): Map<string, ArtifactReference[]> {
  const out = new Map<string, ArtifactReference[]>()
  if (ids.length === 0) return out
  const idsIn = matcherFor(ids)
  const add = (text: string, ref: ArtifactReference): void => {
    for (const id of idsIn(text)) {
      const list = out.get(id) ?? []
      list.push(ref)
      out.set(id, list)
    }
  }

  // 1. Jobs with a queued or running run — work happening now. A workflow
  //    job's own document carries its steps' params, so it is scanned too.
  const activeRuns = db
    .select({ jobId: jobs.id, name: jobs.scriptName, params: jobs.params, workflowDoc: jobs.workflowDoc, status: jobRuns.status })
    .from(jobRuns)
    .innerJoin(jobs, eq(jobRuns.jobId, jobs.id))
    .where(inArray(jobRuns.status, ['queued', 'running']))
    .all()
  const seenJobs = new Map<string, (typeof activeRuns)[number]>()
  for (const row of activeRuns) {
    const prev = seenJobs.get(row.jobId)
    if (!prev || row.status === 'running') seenJobs.set(row.jobId, row)
  }
  for (const row of seenJobs.values()) {
    add(`${json(row.params)}\n${json(row.workflowDoc)}`, {
      kind: 'job',
      blocking: true,
      jobId: row.jobId,
      name: row.name,
      status: row.status === 'running' ? 'running' : 'queued',
    })
  }

  // 2. Batches that can still start members from their own params.
  for (const row of db.select({ id: batches.id, params: batches.params, status: batches.status }).from(batches).where(inArray(batches.status, ACTIVE_BATCH_STATUSES)).all()) {
    add(json(row.params), { kind: 'batch', blocking: true, batchId: row.id, status: row.status })
  }

  // 3. Enabled schedules — their next firing would push a file that is gone.
  for (const row of db.select({ id: schedules.id, name: schedules.name, params: schedules.params }).from(schedules).where(eq(schedules.enabled, true)).all()) {
    add(json(row.params), { kind: 'schedule', blocking: false, scheduleId: row.id, name: row.name })
  }

  // 4. Saved workflows and parameter presets — a default someone picked.
  for (const row of db.select({ id: workflows.id, name: workflows.name, doc: workflows.doc }).from(workflows).all()) {
    add(json(row.doc), { kind: 'workflow', blocking: false, workflowId: row.id, name: row.name })
  }
  for (const row of db.select({ id: paramPresets.id, ownerName: paramPresets.ownerName, name: paramPresets.name, params: paramPresets.params }).from(paramPresets).all()) {
    add(json(row.params), { kind: 'preset', blocking: false, presetId: row.id, ownerName: row.ownerName, name: row.name })
  }

  // 5. Plugin (and script) KV data — key AND value, since a plugin may key a
  //    row by the id itself (`post:<artifactId>`). Secret rows are encrypted
  //    and cannot be searched; expired rows are already invisible to every read.
  for (const row of db
    .select({ namespace: kvEntries.namespace, key: kvEntries.key, value: kvEntries.value, scope: kvEntries.scope, expiresAt: kvEntries.expiresAt })
    .from(kvEntries)
    .where(eq(kvEntries.secret, false))
    .all()) {
    if (row.expiresAt !== null && row.expiresAt <= nowSec) continue
    add(`${row.key}\n${row.value}`, {
      kind: 'plugin-data',
      blocking: false,
      namespace: row.namespace,
      key: row.key,
      scope: row.scope === 'device' ? 'device' : 'global',
    })
  }

  for (const list of out.values()) list.sort((a, b) => Number(b.blocking) - Number(a.blocking))
  return out
}
