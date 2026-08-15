import { z } from 'zod'
import { JsonSchemaNodeSchema } from './json-schema'
import { pageSchema } from './pagination'
import { WorkflowDocSchema } from '../workflow'
import { RuntimeEnvelopeSchema } from '../runtime-envelope'

/**
 * `scripts.kind` (plan 99 §3.1, §4.5) — declared here structurally rather
 * than imported from `packages/core/src/db/schema.ts`'s `ScriptKind`, since
 * `@enkaku/protocol` never depends on `@enkaku/core` (the dependency runs
 * the other way). Kept in lockstep with that type by hand, the same way
 * `WorkflowNameSchema`/`WorkflowVersionSchema` (`workflow.ts`) already
 * duplicate half of `ScriptRefSchema`'s grammar rather than import it
 * across a boundary that cannot be crossed.
 */
export const ScriptKindSchema = z.enum(['script', 'workflow'])

/** `GET /api/scripts/:id` (`packages/core/src/scripts/routes.ts`). */
export const ScriptRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  version: z.string(),
  /** Plan 99 §3.1, §5 step 99.6 — present on every row; `'script'` for everything published before this plan. */
  kind: ScriptKindSchema,
  paramsSchema: JsonSchemaNodeSchema.nullable(),
  /**
   * Plan 97 §4.4, §4.7, §5 step 97.2 — the JSON Schema of what the script
   * declared its `run()` would produce, `null` for a row published before
   * this field existed. Present only on `GET /:id`, the same "detail only"
   * discipline `runtime`/`workflow` below already carry — a list payload
   * has no business paying for every row's own schema (see `hasResult` on
   * `ScriptListItemSchema` below for what the list gets instead).
   */
  resultSchema: JsonSchemaNodeSchema.nullable().optional(),
  enabled: z.boolean(),
  createdBy: z.string().nullable().optional(),
  source: z.string().nullable().optional(),
  createdAt: z.number().nullable(),
  /**
   * Plan 98 §3.1, §4.4, §5 step 98.4 — the script's own declared execution
   * envelope (`sdk`/`timeoutMs`/`retries`/`maxRssBytes`/`maxConcurrent`),
   * `null` for every row published before this field existed. Present only
   * on `GET /:id` (`ScriptListItemSchema` below omits it, matching
   * `source`/`workflow`) — a list payload has no business paying for every
   * row's full declaration.
   */
  runtime: RuntimeEnvelopeSchema.nullable().optional(),
  /**
   * Present only on `GET /:id` for a `kind: 'workflow'` row — the parsed
   * document, beside `source`'s pretty-printed text of the very same JSON
   * (plan 99 §4.5, §4.9: "a workflow row returns the parsed `WorkflowDoc`
   * in a `workflow` field beside `source`"). Never set for `kind: 'script'`,
   * and never sent on the list projections below (`ScriptListItemSchema`,
   * `ScriptGroupRowSchema`) — a workflow's full document has no business in
   * a list payload every row of which pays for it.
   */
  workflow: WorkflowDocSchema.nullable().optional(),
})
export const ScriptResponseSchema = z.object({ script: ScriptRowSchema })

/**
 * `GET /api/scripts` (the ungrouped, paginated list) — every field
 * `ScriptRowSchema` has except `source` (never selected by that route's own
 * projection, `packages/core/src/scripts/routes.ts`'s `GET /` handler) and
 * `workflow` (the detail route's own addition — see its doc comment above).
 * Plan 95 §5 step 95.5 (fixes F8): Studio's `fetchAllPages` used to read
 * this list through a bare `as` cast; this is what lets it validate
 * instead.
 */
export const ScriptListItemSchema = ScriptRowSchema.omit({ source: true, workflow: true, runtime: true, resultSchema: true }).extend({
  /** Plan 97 §4.7 — whether this version declares a `result` at all, without shipping the schema itself on every row of a list. */
  hasResult: z.boolean(),
})

/** `GET /api/scripts/:name/versions`. */
export const VersionOptionSchema = z.object({
  id: z.string(),
  version: z.string(),
  enabled: z.boolean(),
  createdAt: z.number().nullable(),
})
export const ScriptVersionsResponseSchema = z.object({ items: z.array(VersionOptionSchema) })

/** `GET /api/scripts?group=name` — one row per script name (plan 62 §3.5). */
export const ScriptGroupRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  latestVersion: z.string(),
  versionCount: z.number(),
  lastPublishedAt: z.number().nullable(),
  enabled: z.boolean(),
  /** Plan 99 §3.1, §5 step 99.6 — the `kind` of the version this group's `latestVersion` resolves to. */
  kind: ScriptKindSchema,
})
export const ScriptGroupsPageResponseSchema = pageSchema(ScriptGroupRowSchema)

/**
 * `PATCH /api/scripts/:id` (`packages/core/src/scripts/routes.ts`) — a
 * genuine mismatch plan 72's migration found: two Studio call sites had
 * independently declared this route returns a full `ScriptRowSchema`
 * (natural to assume — "toggle enabled" reads like "fetch the row back"),
 * but the route only ever echoes back `{id, enabled}`.
 */
export const ScriptToggleResponseSchema = z.object({ script: z.object({ id: z.string(), enabled: z.boolean() }) })

/** `DELETE /api/scripts/:id` — `{ok: true}`, not an empty 204 body. */
export const ScriptDeleteResponseSchema = z.object({ ok: z.literal(true) })

/**
 * A named parameter set (plan 95 §4.7, §5 step 95.8) — a convenience for a
 * human filling a form, keyed on the script NAME rather than one published
 * version, so it survives every publish. `params` is `z.unknown()`: like
 * `ScriptRow.paramsSchema`'s sibling columns (`jobs.params`,
 * `schedules.params`), it is validated against the SCHEMA it is about to
 * meet at the moment it is applied (`reconcileParams`), not against any
 * fixed shape here.
 */
export const ParamSetInfoSchema = z.object({
  id: z.string(),
  scriptName: z.string(),
  name: z.string(),
  params: z.unknown(),
  createdBy: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
})
export type ParamSetInfo = z.infer<typeof ParamSetInfoSchema>

/** `GET /api/scripts/:name/param-sets`. */
export const ParamSetListResponseSchema = z.object({ items: z.array(ParamSetInfoSchema) })

/** `POST`/`PATCH /api/scripts/:name/param-sets(/:id)` — both echo the full row back. */
export const ParamSetResponseSchema = z.object({ paramSet: ParamSetInfoSchema })

/** `DELETE /api/scripts/:name/param-sets/:id` — `{ok: true}`, not an empty 204 body. */
export const ParamSetDeleteResponseSchema = z.object({ ok: z.literal(true) })
