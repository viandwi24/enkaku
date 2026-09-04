import { asc, eq, sql } from 'drizzle-orm'
import { RuntimeEnvelopeSchema, ScriptLastRunSchema, type JsonSchemaNode, type RuntimeEnvelope, type ScriptLastRun, type ScriptListItem } from '@enkaku/protocol'
import type { Db } from '../db'
import { jobs, plugins, scripts, type ScriptRow } from '../db/schema'

/**
 * A script row with no owning plugin (plan 210, MVP 03 §2.2): a script
 * published before "a script exists only inside a plugin" became true by
 * construction, or a row a boot step parked (`db/migrations/park-synthetic-
 * recordings.ts`). Nothing can create one any more — `writeScriptRows`
 * (`plugins/runtime.ts`) is the only writer of a `scripts` row, and it always
 * sets `pluginId`.
 *
 * The farm IGNORES them: they are not listed, not resolvable, and cannot be
 * run or scheduled. They are not deleted either — that is the operator's
 * call (`DELETE /api/scripts/:id`) — and the job history that references them
 * is untouched, because `jobs.script_name`/`script_version` are denormalised
 * for exactly this. `createScriptRegistry` counts them once at construction
 * and warns, so a farm never silently stops running something.
 */
export function isUnownedScriptRow(row: Pick<ScriptRow, 'pluginId'>): boolean {
  return row.pluginId == null
}

/** The SQL half of `isUnownedScriptRow` — the `where` every list query over `scripts` applies so the two can never disagree about which rows exist. */
export function ownedScriptsWhere() {
  return sql`${scripts.pluginId} is not null`
}

/**
 * The one place `scripts.runtime` is read off a raw row and turned into a
 * typed `RuntimeEnvelope` (plan 98 §4.4) — never an `as`-cast (00-overview
 * §4.2: a JSON DB column is Zod-validated on read). A parse failure can only
 * mean a row written before this column existed with some other shape,
 * which is not expected to occur (the column is nullable and every writer
 * validates before insert) but degrades to `null` rather than a 500.
 */
export function parseScriptRuntime(value: unknown): RuntimeEnvelope | null {
  const parsed = RuntimeEnvelopeSchema.nullable().safeParse(value ?? null)
  return parsed.success ? parsed.data : null
}

export interface ScriptDetail {
  id: string
  name: string
  exportId: string
  plugin: { name: string; version: string }
  paramsSchema: unknown
  resultSchema: unknown
  source: string | null
  createdBy: string | null
  createdAt: number | null
  runtime: RuntimeEnvelope | null
}

const toSec = (d: Date | null): number | null => (d ? Math.floor(d.getTime() / 1000) : null)

/**
 * `GET /api/scripts` (plan 210 §4.2, §4.5) — one row per member of an
 * ACTIVE plugin, `lastRun` read off `jobs.script_name` (any plugin version's
 * run counts, MVP 03 §2.2 rule 1).
 */
export function listActiveScripts(db: Db): ScriptListItem[] {
  const rows = db
    .select({ s: scripts, pluginName: plugins.name, pluginVersion: plugins.version })
    .from(scripts)
    .innerJoin(plugins, eq(plugins.id, scripts.pluginId))
    .where(eq(plugins.status, 'active'))
    .orderBy(asc(scripts.name))
    .all()

  const names = [...new Set(rows.map((r) => r.s.name))]
  const lastByName = new Map<string, ScriptLastRun>()
  if (names.length > 0) {
    // Plan 211 §3.2 decision 9 moved `status` and `finished_at` off `jobs` and
    // onto `job_runs`, reached through `jobs.latest_run_id`. This query kept
    // reading `j.status`, so `GET /api/scripts` threw `no such column:
    // j.status` on any farm that had ever run a script — the Scripts page AND
    // the Run script dialog's list, both blank with a 500 (field report,
    // 2026-09-04). It survived plan 211 because it is a raw SQL string:
    // typecheck cannot see inside one, and no test exercised this path.
    const last = db.all<{ id: string; script_name: string; status: string | null; created_at: number | null; finished_at: number | null }>(sql`
      SELECT j.id, j.script_name, r.status, j.created_at, r.finished_at
      FROM jobs j
      LEFT JOIN job_runs r ON r.id = j.latest_run_id
      WHERE j.script_name IN (${sql.join(names.map((n) => sql`${n}`), sql`, `)})
        AND j.created_at = (SELECT max(j2.created_at) FROM jobs j2 WHERE j2.script_name = j.script_name)
      ORDER BY j.created_at DESC
    `)
    for (const j of last) {
      if (lastByName.has(j.script_name)) continue
      const parsed = ScriptLastRunSchema.safeParse({
        jobId: j.id,
        status: j.status,
        createdAt: j.created_at ?? 0,
        finishedAt: j.finished_at,
      })
      if (parsed.success) lastByName.set(j.script_name, parsed.data)
    }
  }

  return rows.map(({ s, pluginName, pluginVersion }) => ({
    id: s.id,
    name: s.name,
    exportId: s.exportId ?? s.name.slice(s.name.indexOf('/') + 1),
    plugin: { name: pluginName, version: pluginVersion },
    paramsSchema: s.paramsSchema as JsonSchemaNode | null,
    hasResult: s.resultSchema != null,
    lastRun: lastByName.get(s.name) ?? null,
  }))
}

/** `GET /api/scripts/:id` — any owned row, active or superseded (job history reads pinned rows here). */
export function getScriptDetail(db: Db, id: string): ScriptDetail | null {
  const row = db
    .select({ s: scripts, pluginName: plugins.name, pluginVersion: plugins.version })
    .from(scripts)
    .innerJoin(plugins, eq(plugins.id, scripts.pluginId))
    .where(eq(scripts.id, id))
    .get()
  if (!row) return null
  const { s, pluginName, pluginVersion } = row
  return {
    id: s.id,
    name: s.name,
    exportId: s.exportId ?? s.name.slice(s.name.indexOf('/') + 1),
    plugin: { name: pluginName, version: pluginVersion },
    paramsSchema: s.paramsSchema,
    resultSchema: s.resultSchema,
    source: s.source,
    createdBy: s.createdBy,
    createdAt: toSec(s.createdAt),
    runtime: parseScriptRuntime(s.runtime),
  }
}
