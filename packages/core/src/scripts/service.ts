import { and, eq } from 'drizzle-orm'
import { compareSemver, isPrereleaseVersion } from '@enkaku/protocol'
import type { Db } from '../db'
import { scripts, type ScriptRow } from '../db/schema'
import { EnkakuError } from '../util/errors'

/**
 * The plain read/write operations behind script CRUD, pulled out of
 * `routes.ts` (plan 63 §4.3, §6.9) so `script.list`/`script.get`/
 * `script.publish` (`capability/script.ts`) delegate to the SAME functions
 * the REST route calls, rather than a second copy of the same three
 * queries. `routes.ts` keeps its own request/response shaping (query
 * params, the mutation-token guard, HTTP status mapping) — only the DB
 * logic moved.
 */

export interface ScriptGroupInfo {
  id: string
  name: string
  latestVersion: string
  versionCount: number
  lastPublishedAt: number | null
  enabled: boolean
}

export interface ScriptDetail {
  id: string
  name: string
  version: string
  paramsSchema: unknown
  source: string | null
  enabled: boolean
  createdBy: string | null
  createdAt: number | null
}

export interface PublishScriptInput {
  name: string
  version: string
  bundle: string
  source?: string
  paramsSchema?: unknown
}

/**
 * One entry per script NAME, not per published version (plan 62 §3.5, §4.4).
 * `latestVersion` mirrors exactly what `@latest` resolves to (`resolve.ts`):
 * the highest ENABLED, NON-PRERELEASE semver, never the most recently
 * published one. Falls back to the newest version overall only when nothing
 * qualifies, so a script never disappears from its own list.
 */
export function groupScriptsByName(rows: ScriptRow[]): ScriptGroupInfo[] {
  const byName = new Map<string, ScriptRow[]>()
  for (const row of rows) {
    const list = byName.get(row.name)
    if (list) list.push(row)
    else byName.set(row.name, [row])
  }
  return [...byName.entries()]
    .map(([name, versions]) => {
      const byVersionDesc = [...versions].sort((a, b) => compareSemver(b.version, a.version))
      const resolvable = byVersionDesc.find((v) => (v.enabled ?? true) && !isPrereleaseVersion(v.version))
      const latest = resolvable ?? (byVersionDesc[0] as ScriptRow)
      const lastPublishedAt = versions.reduce<number | null>((max, v) => {
        if (!v.createdAt) return max
        const t = Math.floor(v.createdAt.getTime() / 1000)
        return max === null || t > max ? t : max
      }, null)
      return {
        id: latest.id,
        name,
        latestVersion: latest.version,
        versionCount: versions.length,
        lastPublishedAt,
        enabled: latest.enabled ?? true,
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name))
}

export function listScriptGroups(db: Db): ScriptGroupInfo[] {
  return groupScriptsByName(db.select().from(scripts).all())
}

export function getScriptDetail(db: Db, id: string): ScriptDetail | null {
  const row = db.select().from(scripts).where(eq(scripts.id, id)).get()
  if (!row) return null
  return {
    id: row.id,
    name: row.name,
    version: row.version,
    paramsSchema: row.paramsSchema,
    source: row.source,
    enabled: row.enabled ?? true,
    createdBy: row.createdBy,
    createdAt: row.createdAt ? Math.floor(row.createdAt.getTime() / 1000) : null,
  }
}

/** Throws `script_version_exists` (409) exactly like the route did inline. */
export function publishScript(db: Db, input: PublishScriptInput): { id: string; name: string; version: string } {
  const existing = db
    .select()
    .from(scripts)
    .where(and(eq(scripts.name, input.name), eq(scripts.version, input.version)))
    .get()
  if (existing) {
    throw new EnkakuError('script_version_exists', `${input.name}@${input.version} already exists`)
  }
  const id = crypto.randomUUID()
  db.insert(scripts)
    .values({
      id,
      name: input.name,
      version: input.version,
      bundle: input.bundle,
      source: input.source ?? null,
      paramsSchema: input.paramsSchema ?? null,
      enabled: true,
      createdAt: new Date(),
    })
    .run()
  return { id, name: input.name, version: input.version }
}
