import { asc, eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import {
  IconNameSchema,
  RuntimeEnvelopeSchema,
  ScriptLastRunSchema,
  type IconName,
  type JsonSchemaNode,
  type RuntimeEnvelope,
  type ScriptLastRun,
  type ScriptListItem,
} from '@enkaku/protocol'
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
  plugin: { name: string; version: string; icon: IconName | null }
  paramsSchema: unknown
  resultSchema: unknown
  source: string | null
  createdBy: string | null
  createdAt: number | null
  runtime: RuntimeEnvelope | null
}

const toSec = (d: Date | null): number | null => (d ? Math.floor(d.getTime() / 1000) : null)

/** `plugins.icon` → a real `IconName`, or `null` — the same "validate on read" discipline `parseScriptRuntime` states, applied to a `text` column that could in principle hold anything (plan 310 §3.3, §4.1). */
function parsePluginIcon(value: string | null): IconName | null {
  if (value === null) return null
  const parsed = IconNameSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

/**
 * Just enough of `plugins.manifest` to name one member's title/description/
 * icon (plan 310 §3.3, §4.1) — the same lenient, `.optional()`-everywhere
 * projection `workflows/registry.ts`'s `ManifestNodeProjectionSchema` uses
 * for the same reason: this is a JSON column written by whatever core
 * version last activated the row, and a member that predates this plan (or
 * a manifest this build cannot read at all) degrades to "no title, no
 * description, no icon" rather than a throw on the way to the palette.
 */
const ManifestMemberMetaProjectionSchema = z.object({
  scripts: z
    // `icon` is a bare string here, not `IconNameSchema` — this projection
    // must not fail (and drop title/description with it) for a manifest
    // written by an OLDER core against a shorter `ICON_NAMES`. It is
    // narrowed to a real icon name, member by member, in `projectMemberMeta`
    // below, so an unrecognised name degrades to "no icon" alone rather than
    // "no metadata at all" for that member.
    .array(z.object({ id: z.string(), title: z.string().optional(), description: z.string().optional(), icon: z.string().optional() }))
    .optional(),
})

interface MemberMeta {
  title: string | null
  description: string | null
  icon: IconName | null
}

const NO_META: MemberMeta = { title: null, description: null, icon: null }

/** One `Map<exportId, MemberMeta>` per plugin version's manifest, parsed once and reused across every member row that plugin owns (a plugin with N members would otherwise re-parse the same manifest N times). */
function projectMemberMeta(manifest: unknown): Map<string, MemberMeta> {
  const out = new Map<string, MemberMeta>()
  const parsed = ManifestMemberMetaProjectionSchema.safeParse(manifest)
  if (!parsed.success) return out
  for (const s of parsed.data.scripts ?? []) {
    const icon = IconNameSchema.safeParse(s.icon)
    out.set(s.id, { title: s.title ?? null, description: s.description ?? null, icon: icon.success ? icon.data : null })
  }
  return out
}

/**
 * `GET /api/scripts` (plan 210 §4.2, §4.5) — one row per member of an
 * ACTIVE plugin, `lastRun` read off `jobs.script_name` (any plugin version's
 * run counts, MVP 03 §2.2 rule 1).
 */
export function listActiveScripts(db: Db): ScriptListItem[] {
  const rows = db
    .select({ s: scripts, pluginName: plugins.name, pluginVersion: plugins.version, pluginIcon: plugins.icon, manifest: plugins.manifest })
    .from(scripts)
    .innerJoin(plugins, eq(plugins.id, scripts.pluginId))
    .where(eq(plugins.status, 'active'))
    .orderBy(asc(scripts.name))
    .all()

  // Keyed on `pluginId` — a manifest is per PLUGIN VERSION, not per member,
  // so this parses each active plugin's manifest exactly once no matter how
  // many members it has (plan 310 §4.2's own reasoning for the palette's
  // single fetch, applied here to the query that feeds it).
  const metaByPlugin = new Map<string, Map<string, MemberMeta>>()

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

  return rows.map(({ s, pluginName, pluginVersion, pluginIcon, manifest }) => {
    const exportId = s.exportId ?? s.name.slice(s.name.indexOf('/') + 1)
    const pluginKey = s.pluginId ?? ''
    if (!metaByPlugin.has(pluginKey)) metaByPlugin.set(pluginKey, projectMemberMeta(manifest))
    const meta = metaByPlugin.get(pluginKey)?.get(exportId) ?? NO_META
    return {
      id: s.id,
      name: s.name,
      exportId,
      plugin: { name: pluginName, version: pluginVersion, icon: parsePluginIcon(pluginIcon) },
      paramsSchema: s.paramsSchema as JsonSchemaNode | null,
      hasResult: s.resultSchema != null,
      lastRun: lastByName.get(s.name) ?? null,
      title: meta.title,
      description: meta.description,
      icon: meta.icon,
    }
  })
}

/** `GET /api/scripts/:id` — any owned row, active or superseded (job history reads pinned rows here). */
export function getScriptDetail(db: Db, id: string): ScriptDetail | null {
  const row = db
    .select({ s: scripts, pluginName: plugins.name, pluginVersion: plugins.version, pluginIcon: plugins.icon })
    .from(scripts)
    .innerJoin(plugins, eq(plugins.id, scripts.pluginId))
    .where(eq(scripts.id, id))
    .get()
  if (!row) return null
  const { s, pluginName, pluginVersion, pluginIcon } = row
  return {
    id: s.id,
    name: s.name,
    exportId: s.exportId ?? s.name.slice(s.name.indexOf('/') + 1),
    plugin: { name: pluginName, version: pluginVersion, icon: parsePluginIcon(pluginIcon) },
    paramsSchema: s.paramsSchema,
    resultSchema: s.resultSchema,
    source: s.source,
    createdBy: s.createdBy,
    createdAt: toSec(s.createdAt),
    runtime: parseScriptRuntime(s.runtime),
  }
}
