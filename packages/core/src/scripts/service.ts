import { and, eq } from 'drizzle-orm'
import { compareSemver, isPrereleaseVersion, RuntimeEnvelopeSchema, type RuntimeEnvelope } from '@enkaku/protocol'
import type { Db } from '../db'
import { scripts, type ScriptKind, type ScriptRow } from '../db/schema'
import { EnkakuError } from '../util/errors'

/**
 * The one place `scripts.runtime` is read off a raw row and turned into a
 * typed `RuntimeEnvelope` (plan 98 §4.4) — never an `as`-cast (00-overview
 * §4.2: a JSON DB column is Zod-validated on read). A parse failure can only
 * mean a row written before this column existed with some other shape,
 * which is not expected to occur (the column is nullable and every writer
 * validates before insert) but is handled the same way
 * `packages/core/src/scripts/routes.ts`'s `workflow` field handles its own
 * equivalent case: `null` rather than a 500.
 */
export function parseScriptRuntime(value: unknown): RuntimeEnvelope | null {
  const parsed = RuntimeEnvelopeSchema.nullable().safeParse(value ?? null)
  return parsed.success ? parsed.data : null
}

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
  /** Plan 99 §3.1, §5 step 99.6 — carried straight from the "latest" row, never compared against here (§3.1's containment: `service.ts` is not one of the three sanctioned readers, so it must only ever CARRY this value, the same discipline `scripts/registry.ts`'s `rowToEntry` already holds). */
  kind: ScriptKind
}

export interface ScriptDetail {
  id: string
  name: string
  version: string
  kind: ScriptKind
  paramsSchema: unknown
  /**
   * Plan 97 §4.4, §4.7, step 97.2 — what the script declared its `run()`
   * would produce, `null` for a row published before this column existed
   * (or one that still declares nothing). Mirrors `paramsSchema` exactly:
   * read straight off the row, never re-derived, never validated again on
   * this path (the child already did that, at publish, in `checkAndReport-
   * ResultSchema`/`verify-child-entry.ts`).
   */
  resultSchema: unknown
  source: string | null
  enabled: boolean
  createdBy: string | null
  createdAt: number | null
  /**
   * Plan 98 §3.1, §4.4 — the script's own declared execution envelope,
   * `null` for a row published before this column existed. This is what
   * makes a node script's declared `timeoutMs` readable by any caller
   * holding only a `scriptId` (plan 99's downstream need, recorded in plan
   * 98 §5 step 98.4) — no waiting for a child's `ready` message.
   */
  runtime: RuntimeEnvelope | null
}

export interface PublishScriptInput {
  name: string
  version: string
  bundle: string
  source?: string
  paramsSchema?: unknown
  /**
   * Plan 97 §4.4, §4.7, step 97.2 — already `checkDeclaredSchema`-gated by
   * the caller (`routes.ts`'s `POST /`, `sdk/src/cli/publish.ts` locally,
   * or the plugin verify child), the same discipline `paramsSchema` above
   * already has. `null`/absent means "declared nothing".
   */
  resultSchema?: unknown
  /** Plan 98 §3.1, §4.4, §4.5 — the script's own declared execution envelope, already schema-validated by the caller (`routes.ts`'s `POST /`) before this is ever called. `null`/absent means "declared nothing", identical to a pre-plan-98 row. */
  runtime?: RuntimeEnvelope | null
  /**
   * Plan 99 §4.5 — defaults to `'script'`, exactly matching the column's own
   * `NOT NULL DEFAULT 'script'` (`db/schema.ts`), so every pre-existing
   * caller (the script `POST /` route, the CLI, plugin publishing) that
   * never sets this keeps writing exactly what it always wrote. The workflow
   * publish route (`packages/core/src/api/workflows.ts`, plan 99 §4.5's
   * sanctioned "publish route") is the only caller that ever passes
   * `'workflow'`.
   */
  kind?: ScriptKind
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
        kind: latest.kind,
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** `q.kind`, when given, filters the underlying ROWS before grouping (plan 99 §4.9, §5 step 99.6) — a `?kind=workflow` request never sees a script-kind row's name collide into its group. */
export function listScriptGroups(db: Db, q?: { kind?: ScriptKind }): ScriptGroupInfo[] {
  const rows = q?.kind ? db.select().from(scripts).where(eq(scripts.kind, q.kind)).all() : db.select().from(scripts).all()
  return groupScriptsByName(rows)
}

export function getScriptDetail(db: Db, id: string): ScriptDetail | null {
  const row = db.select().from(scripts).where(eq(scripts.id, id)).get()
  if (!row) return null
  return {
    id: row.id,
    name: row.name,
    version: row.version,
    kind: row.kind,
    paramsSchema: row.paramsSchema,
    resultSchema: row.resultSchema,
    source: row.source,
    enabled: row.enabled ?? true,
    createdBy: row.createdBy,
    createdAt: row.createdAt ? Math.floor(row.createdAt.getTime() / 1000) : null,
    runtime: parseScriptRuntime(row.runtime),
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
      kind: input.kind ?? 'script',
      bundle: input.bundle,
      source: input.source ?? null,
      paramsSchema: input.paramsSchema ?? null,
      resultSchema: input.resultSchema ?? null,
      runtime: input.runtime ?? null,
      enabled: true,
      createdAt: new Date(),
    })
    .run()
  return { id, name: input.name, version: input.version }
}
