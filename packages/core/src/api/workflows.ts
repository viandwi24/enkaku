import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import {
  checkDeclaredSchema,
  checkWorkflow,
  compareSemver,
  compileWorkflowParams,
  defaultFarmSettings,
  WorkflowDocSchema,
  type ResolvedNodeScript,
  type ScriptRef,
  type WorkflowBudget,
  type WorkflowDoc,
  type WorkflowFinding,
} from '@enkaku/protocol'
import type { AuditLogger } from '../auth/audit'
import type { AuthEnv } from '../auth/middleware'
import { requirePermission } from '../auth/middleware'
import type { Db } from '../db'
import { scripts } from '../db/schema'
import type { ScriptRegistry } from '../scripts/registry'
import { publishScript } from '../scripts/service'
import { EnkakuError } from '../util/errors'

/**
 * `POST /`, `POST /validate`, `GET /:name/versions` (plan 99 §4.5, §4.9, §5
 * step 99.6) — mounted at `/api/workflows` in `server/http.ts`. Publishing a
 * workflow is deliberately its OWN route, not a branch inside
 * `scripts/routes.ts`'s `POST /api/scripts`, because the request BODY is a
 * different thing (`{ doc: WorkflowDoc }`, not `{ bundle, source,
 * paramsSchema }`) — but the WRITE at the end is the SAME `publishScript()`
 * every other publish path calls (§4.5: "so script_version_exists, the
 * (name, version) unique index, the audit entry and the mutation-token
 * guard are all inherited rather than reimplemented. One writer of `scripts`
 * rows, as today.").
 */

const DocBody = z.object({ doc: z.unknown() })

const ERROR_STATUS: Record<string, number> = {
  script_not_found: 404,
  script_version_not_found: 404,
  script_ref_unresolved: 400,
  script_disabled: 400,
  script_is_dev: 400,
  script_version_exists: 409,
  E_BAD_REQUEST: 400,
  E_WORKFLOW_INVALID: 400,
  E_PARAMS_SCHEMA_INVALID: 400,
}

function parseErrorFindings(issues: readonly { path: readonly PropertyKey[]; message: string }[]): WorkflowFinding[] {
  return issues.map((i) => ({ path: i.path.map(String).join('.'), code: 'E_WORKFLOW_INVALID' as const, message: i.message, severity: 'error' as const }))
}

/**
 * Resolves every node's (and `onFail`'s) script reference through the SAME
 * `ScriptRegistry.resolve()` every other resolution path uses (F17) — never
 * a second lookup, and never `allowDev` (a published workflow must not
 * depend on someone's ephemeral dev build, plan 82 §3.5). Collects EVERY
 * resolution failure rather than aborting on the first — the same "every
 * finding, not the first" rule `checkWorkflow` itself follows — each
 * reported as an `E_WORKFLOW_SCRIPT_UNRESOLVED` finding (this file's own
 * addition to the finding vocabulary; see `workflow-check.ts`'s doc comment
 * on that code) so an author sees every broken reference in one round trip,
 * not one 404 at a time.
 */
function resolveDocRefs(registry: ScriptRegistry, doc: WorkflowDoc): { resolved: Map<ScriptRef, ResolvedNodeScript>; findings: WorkflowFinding[] } {
  const pathsByRef = new Map<string, string[]>()
  const addRef = (ref: string, path: string) => {
    const list = pathsByRef.get(ref)
    if (list) list.push(path)
    else pathsByRef.set(ref, [path])
  }
  doc.nodes.forEach((node, i) => {
    if (node.kind === 'script') addRef(node.script, `nodes[${i}].script`)
  })
  if (doc.onFail) addRef(doc.onFail.script, 'onFail.script')

  const resolved = new Map<ScriptRef, ResolvedNodeScript>()
  const findings: WorkflowFinding[] = []
  for (const [ref, paths] of pathsByRef) {
    try {
      const entry = registry.resolve(ref as ScriptRef)
      resolved.set(ref as ScriptRef, {
        name: entry.name,
        version: entry.version,
        kind: entry.kind,
        paramsSchema: (entry.paramsSchema as ResolvedNodeScript['paramsSchema']) ?? null,
        // Plan 97 (§0.2 assumption A1) has not landed — no script anywhere
        // declares an output schema yet, so this is always null today.
        // `checkWorkflow` degrades every output-shaped check to
        // `W_WORKFLOW_UNCHECKED_BINDING` for exactly this reason (see its
        // own module doc comment).
        outputSchema: null,
        // Plan 99 §4.3 check 7, unblocked by plan 98 §4.4 step 98.4:
        // `ScriptEntry.runtime` is read straight off `scripts.runtime`
        // (`ScriptRegistry.resolve`, `packages/core/src/scripts/registry.ts`)
        // — `null` for a pre-plan-98 row or a script that declared no
        // `runtime.timeoutMs`, which `checkWorkflow` treats as UNKNOWN, never
        // zero (its own doc comment on `ResolvedNodeScript.timeoutMs`).
        timeoutMs: entry.runtime?.timeoutMs ?? null,
      })
    } catch (err) {
      const message = err instanceof EnkakuError ? err.message : String(err)
      for (const path of paths) findings.push({ path, code: 'E_WORKFLOW_SCRIPT_UNRESOLVED', message, severity: 'error' })
    }
  }
  return { resolved, findings }
}

function errorFindingsMessage(findings: readonly WorkflowFinding[]): string {
  return findings.map((f) => (f.path ? `${f.path}: ${f.message}` : f.message)).join('; ')
}

/**
 * `deps.settings` is OPTIONAL for the same reason `jobs/executors/workflow.ts`'s
 * own doc comment gives for `daemon.ts` not being wired yet: it is outside this step's file
 * list (a concurrent worker holds it), so `daemon.ts`'s existing
 * `createWorkflowRoutes({ db, registry: scriptRegistry, audit })` call site
 * cannot be updated here to pass one. When it is absent, `budgetFor` falls
 * back to `workflow.maxTotalMs`'s own SCHEMA default
 * (`defaultFarmSettings()`, `packages/protocol/src/settings.ts`) rather than
 * skipping check 7 outright — an operator who has never touched the setting
 * sees the exact same number either way, and check 7 stays USEFUL today
 * instead of silently inert until `daemon.ts`'s one-line follow-up lands
 * (see `jobs/executors/workflow.ts`'s own doc comment on that same gap). The
 * one honest cost: until that follow-up lands, a farm that HAS customised
 * `workflow.maxTotalMs` from Studio sees the publish-time check honour their
 * number (this route reads `deps.settings` once wired) while THIS fallback
 * only ever sees the schema default when `deps.settings` is never passed at
 * all — recorded here so the gap is exactly where a reader would look for it.
 */
function budgetFor(deps: { settings?: () => WorkflowBudget }): WorkflowBudget {
  return deps.settings ? deps.settings() : { maxTotalMs: defaultFarmSettings().workflow.maxTotalMs }
}

export function createWorkflowRoutes(deps: { db: Db; registry: ScriptRegistry; audit?: AuditLogger; settings?: () => WorkflowBudget }): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>()
  const { db, registry } = deps
  const actorId = (c: { get(k: 'user'): { id: string } | undefined }): string | null => c.get('user')?.id ?? null

  // Registered before `POST /` (a one-segment vs. a bare-root match — no
  // collision either way, matching `scripts/routes.ts`'s own precedent of
  // keeping every two-segment route visually grouped near the top).
  app.post('/validate', requirePermission('script.view'), async (c) => {
    const body = DocBody.safeParse(await c.req.json().catch(() => null))
    if (!body.success) return c.json({ error: { code: 'E_BAD_REQUEST', message: body.error.issues.map((i) => i.message).join('; ') } }, 400)

    const parsedDoc = WorkflowDocSchema.safeParse(body.data.doc)
    if (!parsedDoc.success) {
      return c.json(parseErrorFindings(parsedDoc.error.issues))
    }
    const doc = parsedDoc.data
    const { resolved, findings: refFindings } = resolveDocRefs(registry, doc)
    const findings: WorkflowFinding[] = [...refFindings, ...checkWorkflow(doc, resolved, budgetFor(deps))]
    return c.json(findings)
  })

  // The version list for the editor's "start from" picker (plan 99 §4.9) —
  // a THIN alias over the exact query `scripts/routes.ts`'s own
  // `/:name/versions` runs, deliberately NOT filtered by `kind`: a workflow
  // and a script never legitimately share a name (the same `(name,
  // version)` uniqueness both publish paths write through), and filtering
  // here would be a fourth `kind` comparison this file has no sanctioned
  // reason to make (plan 99 §3.1's containment — this route is not the
  // publish path).
  app.get('/:name/versions', requirePermission('script.view'), (c) => {
    const name = c.req.param('name')
    const rows = db.select().from(scripts).where(eq(scripts.name, name)).all()
    const items = [...rows]
      .sort((a, b) => compareSemver(b.version, a.version))
      .map((r) => ({ id: r.id, version: r.version, enabled: r.enabled ?? true, createdAt: r.createdAt ? Math.floor(r.createdAt.getTime() / 1000) : null }))
    return c.json({ items })
  })

  app.post('/', requirePermission('script.publish'), async (c) => {
    const body = DocBody.safeParse(await c.req.json().catch(() => null))
    if (!body.success) return c.json({ error: { code: 'E_BAD_REQUEST', message: body.error.issues.map((i) => i.message).join('; ') } }, 400)

    const parsedDoc = WorkflowDocSchema.safeParse(body.data.doc)
    if (!parsedDoc.success) {
      const findings = parseErrorFindings(parsedDoc.error.issues)
      return c.json({ error: { code: 'E_WORKFLOW_INVALID', message: errorFindingsMessage(findings), findings } }, 400)
    }
    const doc = parsedDoc.data

    const { resolved, findings: refFindings } = resolveDocRefs(registry, doc)
    const checkFindings = checkWorkflow(doc, resolved, budgetFor(deps))
    const allFindings = [...refFindings, ...checkFindings]
    const blocking = allFindings.filter((f) => f.severity === 'error')
    if (blocking.length > 0) {
      return c.json({ error: { code: 'E_WORKFLOW_INVALID', message: errorFindingsMessage(blocking), findings: allFindings } }, 400)
    }

    // Compiles the workflow's OWN parameter declarations to the same JSON
    // Schema a hand-written Zod object would produce (plan 99 §3.8, §4.2),
    // then holds it to the SAME limits every other publish path already
    // enforces (F24) — a workflow-declared schema is exactly as
    // author-controlled and untrusted as a hand-written one.
    const paramsSchema = compileWorkflowParams(doc.params)
    const schemaFindings = checkDeclaredSchema(paramsSchema).filter((f) => f.limit !== 'group')
    if (schemaFindings.length > 0) {
      return c.json(
        {
          error: {
            code: 'E_PARAMS_SCHEMA_INVALID',
            message: schemaFindings.map((f) => (f.path ? `${f.path}: ${f.message}` : f.message)).join('; '),
            issues: schemaFindings.map((f) => ({ path: f.path, message: f.message })),
          },
        },
        400,
      )
    }

    // §4.5: "bundle holds the canonical WorkflowDoc JSON ... source holds
    // the same document pretty-printed — which is exactly what source's
    // stated purpose already is". `pluginId`/`exportId` stay null (the
    // column defaults), exactly as §4.5 also specifies.
    const script = publishScript(db, {
      name: doc.name,
      version: doc.version,
      bundle: JSON.stringify(doc),
      source: JSON.stringify(doc, null, 2),
      paramsSchema,
      kind: 'workflow',
    })
    deps.audit?.record({ userId: actorId(c), action: 'script.publish', target: script.id, meta: { name: script.name, version: script.version, kind: 'workflow' } })
    return c.json({ script }, 201)
  })

  app.onError((err, c) => {
    if (err instanceof EnkakuError) return c.json(err.toJSON(), (ERROR_STATUS[err.code] ?? 500) as 400)
    throw err
  })

  return app
}
