import { and, eq, isNotNull, or, type SQL } from 'drizzle-orm'
import { compareSemver, isPrereleaseVersion, RuntimeEnvelopeSchema, type RuntimeEnvelope } from '@enkaku/protocol'
import type { Db } from '../db'
import { scripts, type ScriptKind, type ScriptRow } from '../db/schema'
import { EnkakuError } from '../util/errors'

/**
 * A `kind: 'script'` row with no owning plugin — a script published before a
 * script had to be a member of a plugin (plan 110 §3.2). Nothing can create
 * one any more (`publishScript` below refuses), but a farm that upgraded into
 * the rule still has them on disk.
 *
 * The farm IGNORES them: they are not listed, not grouped, not resolvable, and
 * cannot be run or scheduled. They are not deleted either — that is the
 * operator's call (plan 110 §3.5) — and the job history that references them is
 * untouched, because `jobs.script_name`/`script_version` are denormalised for
 * exactly this. `createScriptRegistry` counts them once at construction and
 * warns, so a farm never silently stops running something.
 *
 * A `kind: 'workflow'` row also carries no `pluginId` (§3.3: its bundle is a
 * WorkflowDoc, so there is no plugin for it to be a member of) and is NOT one
 * of these — it lists, groups and resolves exactly as it always has. That
 * exception is the only reason this file compares against `kind` at all, and it
 * is kept HERE, beside `publishScript`'s own `kind` checks, so no other reader
 * of a `ScriptRow` grows a branch of its own (`db/schema.ts`'s containment note
 * on the column).
 */
export function isUnownedScriptRow(row: Pick<ScriptRow, 'kind' | 'pluginId'>): boolean {
  return row.kind === 'script' && row.pluginId == null
}

/** The SQL half of `isUnownedScriptRow` — the `where` every list query over `scripts` applies so the two can never disagree about which rows exist. */
export function ownedScriptsWhere(): SQL | undefined {
  return or(isNotNull(scripts.pluginId), eq(scripts.kind, 'workflow'))
}

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
  /**
   * Plan 110 §3.2, §4.1 — the owning plugin (`plugins.id`) and which member
   * of its bundle this row is. Set TOGETHER or not at all, exactly as
   * `db/schema.ts` says of the two columns themselves ("set together, both
   * null, or both non-null").
   *
   * A `kind: 'script'` row is only ever written WITH them (decision A: "tidak
   * ada script yang define independen berdiri sendiri"); a `kind: 'workflow'`
   * row is only ever written WITHOUT them (§3.3). Both halves are enforced
   * below rather than at any route, so a fifth caller appearing later gets
   * the rule for free rather than having to be told about it.
   */
  pluginId?: string | null
  exportId?: string | null
}

/**
 * Plan 110 §3.2, §4.1, §5 step 110.1 — the one refusal behind the one rule.
 *
 * The wording carries three things deliberately, because this string IS the
 * documentation an author meets at the moment they hit the rule: what the
 * rule is, what to write instead, and why a workflow does not have to satisfy
 * it. The third is not politeness — "a workflow is exempt" reads like an
 * oversight unless the message shows the exemption falling out of the rule's
 * own wording (§3.3: the rule is "a `kind: 'script'` row is only ever written
 * with a `pluginId`", so a workflow is outside it by construction, not by
 * carve-out).
 */
export function scriptNeedsPluginMessage(subject: string): string {
  return (
    `${subject} has no owning plugin. A script cannot be published outside a plugin (plan 110 §3.2): ` +
    `the farm only ever writes a kind:'script' row WITH a pluginId, so publish a plugin — ` +
    `definePlugin({ id, version, scripts: [ … ] }) — and the member is published as "<plugin>/<script>". ` +
    `A workflow does not have to satisfy this, and not because it was granted an exemption: the rule is ` +
    `written as "a kind:'script' row is only ever written with a pluginId", and a workflow's bundle is a ` +
    `WorkflowDoc rather than an ESM bundle — no run(), no members, nothing to share by import — so there is ` +
    `no plugin for it to be a member of.`
  )
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

/**
 * `q.kind`, when given, filters the underlying ROWS before grouping (plan 99
 * §4.9, §5 step 99.6) — a `?kind=workflow` request never sees a script-kind
 * row's name collide into its group.
 *
 * A row with no owning plugin is never listed (`isUnownedScriptRow`): the
 * script list is the members of this farm's plugins, plus its workflows, and
 * nothing else. Offering an operator a Run button for something that cannot
 * resolve is worse than not showing it.
 */
export function listScriptGroups(db: Db, q?: { kind?: ScriptKind }): ScriptGroupInfo[] {
  const owned = ownedScriptsWhere()
  const rows = db
    .select()
    .from(scripts)
    .where(q?.kind ? and(eq(scripts.kind, q.kind), owned) : owned)
    .all()
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

/**
 * The ONE writer of a `scripts` row outside the plugin pipeline (plan 110
 * §3.2, A2) — and therefore the one place the rule "a script cannot exist
 * outside a plugin" is enforced. Every publish path in the farm (`POST
 * /api/scripts`, the `script.publish` capability, workflow publish, recording
 * publish) reaches this function, so none of them has to know the rule and
 * none of them can be the exception that was forgotten.
 *
 * Throws `E_SCRIPT_NEEDS_PLUGIN` for a plugin-less `kind: 'script'` row, and
 * `script_version_exists` (409) for a duplicate `(name, version)` exactly like
 * the route did inline.
 */
export function publishScript(db: Db, input: PublishScriptInput): { id: string; name: string; version: string } {
  const kind = input.kind ?? 'script'
  const ref = `${input.name}@${input.version}`
  const hasPluginId = input.pluginId != null && input.pluginId !== ''
  const hasExportId = input.exportId != null && input.exportId !== ''
  if (hasPluginId !== hasExportId) {
    throw new EnkakuError(
      'E_SCRIPT_NEEDS_PLUGIN',
      `${ref}: pluginId and exportId are written together — both set, or neither (db/schema.ts) — got pluginId=${hasPluginId ? 'set' : 'null'}, exportId=${hasExportId ? 'set' : 'null'}. A half-owned row would resolve as a plugin member whose member id nothing can select.`,
    )
  }
  if (kind === 'script' && !hasPluginId) {
    throw new EnkakuError('E_SCRIPT_NEEDS_PLUGIN', scriptNeedsPluginMessage(ref))
  }
  if (kind === 'workflow' && hasPluginId) {
    throw new EnkakuError(
      'E_BAD_REQUEST',
      `${ref} is a workflow and never has an owning plugin (plan 110 §3.3): its bundle is a WorkflowDoc, not a plugin member's ESM bundle, so there is no member for exportId to select.`,
    )
  }
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
      kind,
      bundle: input.bundle,
      source: input.source ?? null,
      paramsSchema: input.paramsSchema ?? null,
      resultSchema: input.resultSchema ?? null,
      runtime: input.runtime ?? null,
      enabled: true,
      createdAt: new Date(),
      // Plan 110 §4.1 — checked above, never guessed here.
      pluginId: input.pluginId ?? null,
      exportId: input.exportId ?? null,
    })
    .run()
  return { id, name: input.name, version: input.version }
}
