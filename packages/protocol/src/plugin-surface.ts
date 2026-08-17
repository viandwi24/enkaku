import { z } from 'zod'
import { JsonSchemaNodeSchema, type JsonSchemaNode } from './api/json-schema'
import { DANGEROUS_FIELD_NAMES } from './schema/limits'
import { ScriptRefSchema, type ScriptRef } from './script-ref'

/**
 * The declarative screen a plugin contributes to Studio (plan 108 §3.2,
 * §4.2) — a sidebar entry, a table, a form, and a closed set of actions,
 * with no browser JavaScript of the plugin's own in the default path.
 *
 * This module adds a LAYOUT vocabulary and deliberately **no field
 * vocabulary at all** (plan 108 §3.3, and `docs/design.md`'s one-resolver
 * rule): a column's or a form's appearance is stated as an ordinary JSON
 * Schema node (`JsonSchemaNodeSchema`, reused here, never redeclared) and
 * rendered through Studio's single `planField`/`formatValue` resolver, with
 * meaning carried by the existing `x-enkaku` vocabulary (`./schema/vocabulary.ts`).
 * Nothing in this file may ever name a control — the same refusal plan 95
 * §3.1 made for parameters applies verbatim to a plugin's screen.
 *
 * Everything here is data. There is no expression language, no string
 * interpolation, and no author-supplied code: see `BindingSchema` below,
 * which is the closed, non-Turing way an action reads a value out of the row
 * or the form it was invoked from (§3.4, the same doctrine as plan 99's
 * workflow gates).
 */

/**
 * Every numeric cap the surface vocabulary enforces, named once so a
 * refusal can quote the limit it hit rather than saying "too large" (plan
 * 108 §4.2's "Named limits, refused at verify with the limit in the
 * message"). Mirrors `SCHEMA_LIMITS` (`./schema/limits.ts`) — one const
 * object, one source of truth, read by both the author-time check
 * (`definePlugin`) and the farm-side re-validation.
 */
export const SURFACE_LIMITS = {
  /** Sidebar entries one plugin may contribute. */
  maxNav: 8,
  /** Distinct screens one plugin may declare. */
  maxViews: 16,
  /** Distinct actions one plugin may declare; also the cap on how many a single view may reference. */
  maxActions: 32,
  /** Columns in one table — a table wider than this is unreadable at any window size. */
  maxColumns: 12,
  /** The whole `surface` block, serialised. It is stored in `plugins.manifest` and shipped to every browser that opens the page. */
  maxSurfaceBytes: 256 * 1024,
  /** The tier-B `ui/` directory inside a `.enkaku` package (plan 108 §3.8, enforced by step 108.2's reader — named here so both halves quote one number). */
  maxUiBytes: 8 * 1024 * 1024,
} as const

/**
 * The icons a nav entry may name — lucide names in their kebab-case form,
 * every one of them present in the `lucide-react` build Studio already
 * bundles. Closed on purpose: the icon is rendered by Studio, so an
 * unrecognised name would be a blank square in the operator's sidebar with
 * nothing to point at. An author who needs one that is missing asks for it
 * to be added here, which is a protocol change with a review attached.
 */
export const ICON_NAMES = [
  'users',
  'database',
  'network',
  'globe',
  'shield',
  'activity',
  'box',
  'boxes',
  'layers',
  'list',
  'table',
  'settings',
  'wrench',
  'plug',
  'puzzle',
  'key',
  'lock',
  'server',
  'cloud',
  'terminal',
  'file-text',
  'folder',
  'search',
  'filter',
  'zap',
  'gauge',
  'bell',
  'tag',
  'link',
  'share',
  'download',
  'upload',
  'play',
  'pause',
  'refresh-cw',
  'plus',
  'minus',
  'check',
  'x',
  'info',
  'alert-triangle',
] as const
export type IconName = (typeof ICON_NAMES)[number]

export const IconNameSchema = z.enum(ICON_NAMES, {
  error: (issue) => `unknown icon "${String(issue.input)}" — not one of the ${ICON_NAMES.length} allowed lucide names`,
})

/**
 * A nav entry id, a view id, and an action id all share one shape.
 * Identifier-like on purpose: these are object KEYS in `views`/`actions`
 * and are looked up by name, so an id that collides with an
 * `Object.prototype` member would make `views['constructor']` answer with a
 * function for a view that was never declared. The regex alone cannot see
 * that (`constructor` is perfectly identifier-shaped), so the same
 * `DANGEROUS_FIELD_NAMES` set `./schema/limits.ts` keeps for a params
 * schema's field names is applied here too, rather than a second list that
 * could drift from it.
 */
export const SurfaceIdSchema = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/)
  .refine((id) => !DANGEROUS_FIELD_NAMES.has(id), {
    error: 'an id may not be `__proto__`, `constructor`, or `prototype` — they collide with `Object.prototype`',
  })

/**
 * Where a view's rows come from.
 *
 * The NAMESPACE is deliberately never declared. A data source can only ever
 * read the owning plugin's own KV namespace, which is the plugin's id — the
 * farm takes it from the `:name` path segment of `/api/plugins/:name/data/*`
 * (plan 108 §3.7), never from anything an author or a browser sends. There
 * is therefore no field here to spell it with, and no request shape that
 * could reach another plugin's data.
 */
export const DataSourceSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('kv.scan'),
      key: z.string().min(1).max(200),
      /** `entry` = one row per device. `items` = flatten `itemsAt` into one row per element, each carrying `$device`. */
      rows: z.enum(['entry', 'items']).default('entry'),
      /** Dot path inside the entry's value, read only when `rows: 'items'`. */
      itemsAt: z.string().max(200).default(''),
      /** Include devices with no entry, so "never synced" is visible rather than absent (plan 108 §4.2). */
      includeMissing: z.boolean().default(true),
    })
    .strict(),
  z
    .object({
      kind: z.literal('kv.list'),
      /** Only `global`: a device-scoped list with no device to scope it to is a `kv.scan`, above. */
      scope: z.literal('global'),
      prefix: z.string().max(200).default(''),
    })
    .strict(),
])
export type DataSource = z.infer<typeof DataSourceSchema>

/**
 * The device fields a binding may read — exactly the six-field allowlist of
 * plan 108 §3.6, never a seventh.
 *
 * `number` is the device's short, human-facing number (`device_numbers`,
 * plan 89 §3.1): the label an operator reads off the phone's own screen or
 * the sticker on its case. It joined the five originals because a plugin
 * screen that names devices needs the three an operator actually matches a
 * phone by — the unique id, the number, and the name — and the number was
 * the one of those three the allowlist could not reach. `null` for a device
 * with no reservation, which is a real state and not an error.
 */
export const BINDING_DEVICE_FIELDS = ['id', 'stableId', 'label', 'status', 'clusterId', 'number'] as const
export type BindingDeviceField = (typeof BINDING_DEVICE_FIELDS)[number]

/** The KV entry fields a binding may read — metadata only; the value itself is reached through `$row`. */
export const BINDING_ENTRY_FIELDS = ['key', 'version', 'updatedAt'] as const
export type BindingEntryField = (typeof BINDING_ENTRY_FIELDS)[number]

/**
 * How an action names a value it needs (plan 108 §3.4). Closed and
 * non-Turing: a literal, a dot path into the row, a dot path into the form,
 * one allowlisted device field, one allowlisted entry field, or an
 * object/array whose leaves are bindings. Nothing else — no operators, no
 * string interpolation, no calls, no regular expressions (the same refusal
 * plan 99 §3.7 and plan 95 §3.8 R2 already made).
 *
 * A bare `'username'` is NOT a binding: a literal is spelled `{ $literal:
 * 'username' }`, so "a value read from the row" and "a value written by the
 * author" can never be confused for one another by either the evaluator or
 * a reader of the manifest.
 */
export type Binding =
  | { $row: string }
  | { $form: string }
  | { $device: BindingDeviceField }
  | { $entry: BindingEntryField }
  | { $literal: unknown }
  | { [key: string]: Binding }
  | Binding[]

/**
 * A key of the OBJECT form of a binding. `$` is reserved: without this, an
 * author reaching for an operator the language does not have
 * (`{ $concat: [...] }`, `{ $if: ... }`) would silently parse as a perfectly
 * valid map with one oddly-named key, and the evaluator would hand the
 * action a literal object instead of refusing. Refusing `$` at the boundary
 * turns that into an author-time error naming the key, and keeps the marker
 * namespace free for a future one.
 */
const BindingKeySchema = z
  .string()
  .min(1)
  .max(64)
  .refine((key) => !key.startsWith('$'), {
    error: '`$`-prefixed keys are reserved for the binding markers — an object binding cannot invent an operator',
  })
  .refine((key) => !DANGEROUS_FIELD_NAMES.has(key), {
    error: 'a binding may not build a `__proto__`, `constructor`, or `prototype` key',
  })

/**
 * Annotated with the SAME type on both sides (`ZodType<Binding, Binding>`)
 * rather than the one-parameter form, which would leave the INPUT side as
 * `unknown` — and `unknown` on the input side propagates: every schema that
 * embeds a binding would stop type-checking an author's `params`/`key`/
 * `value` at the call site, which is most of what the author-time contract
 * is for. A binding declares no defaults, so the two sides are genuinely
 * identical.
 */
export const BindingSchema: z.ZodType<Binding, Binding> = z.lazy(() =>
  z.union([
    z.object({ $row: z.string().min(1).max(200) }).strict(),
    z.object({ $form: z.string().min(1).max(200) }).strict(),
    z.object({ $device: z.enum(BINDING_DEVICE_FIELDS) }).strict(),
    z.object({ $entry: z.enum(BINDING_ENTRY_FIELDS) }).strict(),
    z.object({ $literal: z.unknown() }).strict(),
    // Array BEFORE record: `z.record` would otherwise accept an array and
    // hand back an object keyed by its indices, silently turning a list
    // binding into a map one.
    z.array(BindingSchema),
    z.record(BindingKeySchema, BindingSchema),
  ]),
)

/**
 * What a toolbar button or a row action does. Every kind dispatches through
 * a path the farm already has — `job` and `batch` through the same
 * enqueue/create functions `POST /api/jobs` and `POST /api/batches` call,
 * `kv.set`/`kv.delete` through `KvStore` — so a plugin action can never
 * reach anything a declared, permission-checked route could not (plan 108
 * §4.5).
 *
 * `form` is the recursive one, and it is what makes CRUD free: it opens
 * `SchemaForm` on an ordinary JSON Schema node and then runs `then` with
 * `$form.*` bound. It nests through `z.lazy` rather than being a
 * second, form-shaped copy of every other kind.
 */
export type ActionSpec =
  | { kind: 'job'; label: string; script: ScriptRef; params?: Binding; device: 'row' | 'picker'; confirm?: string }
  | { kind: 'batch'; label: string; script: ScriptRef; params?: Binding; target: 'selection' | 'picker' | 'all'; confirm?: string }
  | { kind: 'kv.set'; label: string; scope: 'global' | 'device'; key: Binding; value: Binding; secret: boolean }
  | { kind: 'kv.delete'; label: string; scope: 'global' | 'device'; key: Binding; confirm?: string }
  | { kind: 'form'; label: string; schema: JsonSchemaNode; prefill?: Binding; submitLabel: string; then: ActionSpec }

/**
 * The same union as the author WRITES it, before Zod applies the four
 * defaults (`device`, `target`, `secret`, `submitLabel`). Hand-written for
 * the one reason `ActionSpec` is: the union is recursive through
 * `form.then`, so its schema needs an explicit type annotation, and an
 * annotation naming only the output type would erase the input side to
 * `unknown` (see `BindingSchema`'s note).
 *
 * `schema` is `unknown` here, not `JsonSchemaNode`: `JsonSchemaNodeSchema`
 * is itself declared as a one-parameter `z.ZodType`, so its input side is
 * `unknown` and this must match it. Nothing is lost — a JSON Schema node is
 * an unconstrained `Record<string, unknown>`, so there was never anything
 * for the compiler to check there.
 */
export type ActionSpecInput =
  | { kind: 'job'; label: string; script: ScriptRef; params?: Binding; device?: 'row' | 'picker'; confirm?: string }
  | { kind: 'batch'; label: string; script: ScriptRef; params?: Binding; target?: 'selection' | 'picker' | 'all'; confirm?: string }
  | { kind: 'kv.set'; label: string; scope: 'global' | 'device'; key: Binding; value: Binding; secret?: boolean }
  | { kind: 'kv.delete'; label: string; scope: 'global' | 'device'; key: Binding; confirm?: string }
  | { kind: 'form'; label: string; schema: unknown; prefill?: Binding; submitLabel?: string; then: ActionSpecInput }

export const ActionSpecSchema: z.ZodType<ActionSpec, ActionSpecInput> = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('job'),
      label: z.string().min(1).max(80),
      /** `name@version` or `name@latest` — the EXISTING reference grammar, resolved server-side (plan 108 §4.5). */
      script: ScriptRefSchema,
      params: BindingSchema.optional(),
      device: z.enum(['row', 'picker']).default('row'),
      confirm: z.string().max(300).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('batch'),
      label: z.string().min(1).max(80),
      script: ScriptRefSchema,
      params: BindingSchema.optional(),
      target: z.enum(['selection', 'picker', 'all']).default('picker'),
      confirm: z.string().max(300).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('kv.set'),
      label: z.string().min(1).max(80),
      scope: z.enum(['global', 'device']),
      key: BindingSchema,
      value: BindingSchema,
      secret: z.boolean().default(false),
    })
    .strict(),
  z
    .object({
      kind: z.literal('kv.delete'),
      label: z.string().min(1).max(80),
      scope: z.enum(['global', 'device']),
      key: BindingSchema,
      confirm: z.string().max(300).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('form'),
      label: z.string().min(1).max(80),
      /** Rendered by `SchemaForm` — the run dialog's own renderer, not a second one (plan 108 §3.3). */
      schema: JsonSchemaNodeSchema,
      prefill: BindingSchema.optional(),
      submitLabel: z.string().min(1).max(40).default('Save'),
      then: z.lazy(() => ActionSpecSchema),
    })
    .strict(),
])

/**
 * One screen. Tier A states `data` + `table` and is rendered by Studio's own
 * components; tier B states `frame` and is a sandboxed iframe over the
 * package's `ui/` directory (plan 108 §3.2, §4.4). The two are mutually
 * exclusive, and exactly one is required — checked by
 * `validatePluginSurface` below rather than here, so the refusal can name
 * the offending view id, which a schema-level refinement cannot see (the id
 * is the record KEY one level up).
 */
export const ViewSpecSchema = z
  .object({
    title: z.string().min(1).max(80),
    description: z.string().max(300).optional(),
    data: DataSourceSchema.optional(),
    table: z
      .object({
        rowKey: z.string().min(1).max(200),
        columns: z
          .array(
            z
              .object({
                field: z.string().min(1).max(200),
                header: z.string().min(1).max(80),
                /** Rendered by `planField`/`formatValue`. Absent = plain text. No new field vocabulary (plan 108 §3.3). */
                schema: JsonSchemaNodeSchema.optional(),
                width: z.enum(['auto', 'narrow', 'wide']).default('auto'),
              })
              .strict(),
          )
          .min(1)
          .max(SURFACE_LIMITS.maxColumns, {
            error: `a table declares at most ${SURFACE_LIMITS.maxColumns} columns (maxColumns)`,
          }),
        selectable: z.boolean().default(false),
      })
      .strict()
      .optional(),
    /** Tier B — an entry file inside the package's `ui/` directory. */
    frame: z
      .object({ entry: z.string().min(1).max(200), height: z.enum(['fill', 'auto']).default('fill') })
      .strict()
      .optional(),
    toolbar: z
      .array(SurfaceIdSchema)
      .max(SURFACE_LIMITS.maxActions, { error: `a toolbar references at most ${SURFACE_LIMITS.maxActions} actions (maxActions)` })
      .default([]),
    rowActions: z
      .array(SurfaceIdSchema)
      .max(SURFACE_LIMITS.maxActions, { error: `a row references at most ${SURFACE_LIMITS.maxActions} actions (maxActions)` })
      .default([]),
    empty: z.object({ title: z.string().min(1).max(80), hint: z.string().max(300).optional() }).strict().optional(),
  })
  .strict()
export type ViewSpec = z.infer<typeof ViewSpecSchema>

export const NavEntrySchema = z
  .object({
    id: SurfaceIdSchema,
    label: z.string().min(1).max(40),
    icon: IconNameSchema,
    /** A key of `views` — checked by `validatePluginSurface`, which can see both halves. */
    view: SurfaceIdSchema,
  })
  .strict()
export type NavEntry = z.infer<typeof NavEntrySchema>

const PluginSurfaceShapeSchema = z
  .object({
    nav: z.array(NavEntrySchema).max(SURFACE_LIMITS.maxNav, {
      error: `a plugin contributes at most ${SURFACE_LIMITS.maxNav} nav entries (maxNav)`,
    }),
    views: z.record(SurfaceIdSchema, ViewSpecSchema),
    actions: z.record(SurfaceIdSchema, ActionSpecSchema),
  })
  .strict()

/**
 * Everything a plugin contributes to Studio. The two record caps are
 * enforced here rather than by a `z.record` option because Zod has none —
 * and because the message has to name the limit it hit (`maxViews`,
 * `maxActions`), which is the whole point of `SURFACE_LIMITS`.
 */
export const PluginSurfaceSchema = PluginSurfaceShapeSchema.superRefine((surface, ctx) => {
  const viewCount = Object.keys(surface.views).length
  if (viewCount > SURFACE_LIMITS.maxViews) {
    ctx.addIssue({
      code: 'custom',
      message: `declares ${viewCount} views, over the limit of ${SURFACE_LIMITS.maxViews} (maxViews)`,
      path: ['views'],
    })
  }
  const actionCount = Object.keys(surface.actions).length
  if (actionCount > SURFACE_LIMITS.maxActions) {
    ctx.addIssue({
      code: 'custom',
      message: `declares ${actionCount} actions, over the limit of ${SURFACE_LIMITS.maxActions} (maxActions)`,
      path: ['actions'],
    })
  }
})
/** A surface as every CONSUMER sees it — parsed, with every default applied, so a renderer never has to re-state one. */
export type PluginSurface = z.infer<typeof PluginSurfaceSchema>

/**
 * A surface as its AUTHOR writes it — every defaulted field optional. This,
 * not `PluginSurface`, is what `PluginDefinition.surface` (`@enkaku/sdk`)
 * is typed as: a plugin author writing the plan's own worked example
 * (§4.3), which omits `width` on four of five columns, must not be told to
 * spell out a default the schema exists to supply.
 */
export type PluginSurfaceInput = z.input<typeof PluginSurfaceSchema>

export type PluginSurfaceValidation = { ok: true; value: PluginSurface } | { ok: false; errors: string[] }

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length
}

/**
 * Serialised size of an already-parsed surface. `$literal` holds an
 * arbitrary value that Zod passed through by reference, so this can still
 * meet a circular object or one too deep for `JSON.stringify` — both are
 * refusals, never a crash.
 */
function serialisedBytes(surface: PluginSurface): number | null {
  try {
    return byteLength(JSON.stringify(surface))
  } catch {
    return null
  }
}

/**
 * The one gate a surface passes, wherever it is checked: `definePlugin` on
 * the author's own machine (plan 108 §4.1), the verify child, and the
 * parent's independent re-validation (§3.9). Pure — no I/O, no database, no
 * DOM — for the same reason `checkWorkflow` is: the author-time check and
 * the farm-side check must be incapable of disagreeing about what is wrong.
 *
 * Runs the Zod parse first, then the checks a schema structurally cannot
 * make because they span two branches of the document: a nav entry naming a
 * view that does not exist, a toolbar or row action naming an action that
 * does not exist, a duplicate nav id, and the tier-A/tier-B exclusivity of
 * §3.2. Existence of a `script` a `job`/`batch` action names is NOT checked
 * — a pack may reference a script published separately, and the action
 * reports `script_not_found` at click time, the same failure the run dialog
 * already gives (§3.9).
 */
export function validatePluginSurface(surface: unknown): PluginSurfaceValidation {
  const parsed = PluginSurfaceSchema.safeParse(surface)
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((issue) => {
        const path = issue.path.map((segment) => String(segment)).join('.')
        return path === '' ? issue.message : `${path}: ${issue.message}`
      }),
    }
  }

  const value = parsed.data
  const errors: string[] = []

  const bytes = serialisedBytes(value)
  if (bytes === null) {
    errors.push('the surface cannot be serialised to JSON — a `$literal` holds a circular or unserialisable value')
  } else if (bytes > SURFACE_LIMITS.maxSurfaceBytes) {
    errors.push(`the surface serialises to ${bytes} bytes, over the limit of ${SURFACE_LIMITS.maxSurfaceBytes} (maxSurfaceBytes)`)
  }

  const seenNavIds = new Set<string>()
  for (const entry of value.nav) {
    if (seenNavIds.has(entry.id)) {
      errors.push(`duplicate nav id "${entry.id}" — nav ids must be unique within one surface`)
    }
    seenNavIds.add(entry.id)
    if (!Object.hasOwn(value.views, entry.view)) {
      errors.push(`nav entry "${entry.id}" names view "${entry.view}", which this surface does not declare`)
    }
  }

  for (const [viewId, view] of Object.entries(value.views)) {
    // Exactly one RENDERER — `table` (tier A) or `frame` (tier B) — but `data`
    // belongs to either.
    //
    // An earlier reading made `data` part of the tier-A half and refused it
    // beside a frame, which left a frame view with nothing it could legally
    // read: `data.query` had no declared source and answered `no_data_source`
    // forever, so tier B could only ever hold static markup. That defeats its
    // whole purpose — tier B exists for a LAYOUT the vocabulary cannot draw
    // (plan 108 §3.2), never for a plugin that has nothing to show.
    //
    // The authority story is unchanged, and is the reason `data` can be shared
    // safely: a frame reads through the SAME declared source a table would, over
    // the RPC, and can reach nothing else (its CSP sets `connect-src 'none'`, so
    // it has no fetch of its own at all). Declaring a source widens what the
    // frame may READ to exactly what the author wrote down — which is the whole
    // contract.
    if (view.frame !== undefined && view.table !== undefined) {
      errors.push(`view "${viewId}" declares both \`table\` and \`frame\` — a view has one renderer, never two`)
    }
    if (view.frame === undefined && view.table === undefined) {
      errors.push(`view "${viewId}" declares neither \`table\` nor \`frame\` — a view needs one renderer`)
    }
    if (view.table !== undefined && view.data === undefined) {
      errors.push(`view "${viewId}" declares \`table\` but no \`data\` — a table view needs both`)
    }

    const slots: ReadonlyArray<readonly ['toolbar' | 'rowActions', readonly string[]]> = [
      ['toolbar', view.toolbar],
      ['rowActions', view.rowActions],
    ]
    for (const [slot, ids] of slots) {
      ids.forEach((id, index) => {
        if (!Object.hasOwn(value.actions, id)) {
          errors.push(`view "${viewId}" \`${slot}[${index}]\` names action "${id}", which this surface does not declare`)
        }
      })
    }
  }

  return errors.length === 0 ? { ok: true, value } : { ok: false, errors }
}
