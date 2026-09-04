import { z } from 'zod'
import { JsonSchemaNodeSchema, type JsonSchemaNode } from './api/json-schema'
import { DANGEROUS_FIELD_NAMES } from './schema/limits'
import { ScriptRefSchema, type ScriptRef } from './script-ref'

/**
 * The screen a plugin contributes to Studio (plan 108 §3.2, §4.2; plan 111
 * §4.1) — a sidebar entry and a set of views, each drawn either by declaring
 * a table (tier A: no build step, no JavaScript of the plugin's own) or by
 * naming a React module the plugin ships (tier C), plus a closed set of
 * actions either kind may invoke.
 *
 * Everything below describes tier A's vocabulary. A tier-C view states
 * `react` and draws itself, so none of it constrains what a React view may
 * render — deliberately, that is the whole point of plan 111.
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
  /** The `ui/` directory inside a `.enkaku` package (plan 108 §3.8, enforced by step 108.2's reader — named here so both halves quote one number). */
  maxUiBytes: 8 * 1024 * 1024,
} as const

/**
 * The `@enkaku/ui` contract major THIS build ships (plan 111 §3.5). A view
 * that renders React states the major it was built against
 * (`ViewSpec.react.apiVersion`), and verify refuses anything else with a
 * message naming both numbers — the same shape `runtime.sdk` already has for
 * a script bundle (`SCRIPT_RUNTIME_MAJOR`, plan 98 §3.3 S1), and for the same
 * reason: a known, checked incompatibility beats a component that renders
 * blank in an operator's face.
 *
 * The number lives HERE, in the protocol, and deliberately **not** in
 * `packages/ui/package.json`. Three reasons, in order of weight:
 *
 * 1. `@enkaku/ui` is `private: true` at `0.0.1` — it is never published to a
 *    registry, so its semver is a workspace placeholder rather than a release
 *    identity anyone consumes. Deriving the contract from its major would make
 *    every plugin declare `apiVersion: 0` and leave no way to signal a break
 *    without first leaving 0.x for reasons that have nothing to do with the
 *    component API.
 * 2. The core could not read that file at runtime in any case: a release is a
 *    `bun build --compile` binary and `packages/ui/package.json` is not inside
 *    it. A check that only works from a source checkout is not a check.
 * 3. Both halves must quote ONE number — the SDK scaffold that writes
 *    `apiVersion` into a new plugin (`enkaku init`) and the farm that refuses a
 *    mismatch at verify. `@enkaku/protocol` is the only package both already
 *    depend on, and `@enkaku/ui` is not a dependency of either.
 *
 * Bumped by hand, as a protocol change with a review attached, when a breaking
 * change lands in what `@enkaku/ui` exports.
 */
export const PLUGIN_UI_API_VERSION = 1

/**
 * The icons a nav entry may name, as stable kebab-case ids. Studio maps each
 * id to a Phosphor component (`packages/studio/src/lib/plugin-icons.ts`);
 * the ids predate that mapping and never change with the icon library.
 * Closed on purpose: the icon is rendered by Studio, so an unrecognised name
 * would be a blank square in the operator's sidebar with nothing to point
 * at. An author who needs one that is missing asks for it to be added here,
 * which is a protocol change with a review attached.
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
  error: (issue) => `unknown icon "${String(issue.input)}": not one of the ${ICON_NAMES.length} allowed icon names`,
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
  /**
   * Plan 109 §3.1, §4.6, step 109.6 — rows assembled by the plugin's own code.
   *
   * The two `kv.*` members above read the plugin's stored data in the shape it
   * was stored in. A table that joins that data with live farm state has no
   * single place to read from, so something has to assemble it; `name` is a
   * `ctx.onQuery` handler id, reached at `GET /api/plugins/:name/query/:name`.
   *
   * **This member is the only data source that can be DOWN.** A `kv.scan`
   * fails only if the farm does; a handler source fails whenever the plugin's
   * service is stopped, starting, failed, or disabled by the error budget — and
   * a view that answers an empty table in that case is telling the operator
   * their data is gone, which is a different and much worse thing. The route
   * answers a coded refusal per state and Studio names the plugin and offers
   * Restart (criterion 21).
   *
   * There is no `input` member. A declarative view has nowhere to get one from
   * — no form, no row, nothing bound — so a field for it would only ever hold a
   * literal the handler could just as well have written itself.
   */
  z
    .object({
      kind: z.literal('handler'),
      name: SurfaceIdSchema,
    })
    .strict(),
])
export type DataSource = z.infer<typeof DataSourceSchema>

/**
 * Plan 109 step 109.6 — a surface whose view reads `{ kind: 'handler' }` needs
 * the plugin to declare a `service`, because `ctx.onQuery` exists nowhere else.
 *
 * Refused at VERIFY rather than left to fail at render, on the same reasoning
 * `unsupportedIsolationMessage` and `unknownPluginEventTypesMessage` follow:
 * criterion 21's error state exists for a service that is DOWN, which is an
 * operational fact an operator can act on. A plugin that could never have
 * served the view in the first place is an authoring mistake, and rendering it
 * as "the service is not running, press Restart" would send the operator to
 * press a button that cannot help.
 *
 * Returns the refusal message, or `null` when the surface is coherent.
 */
export function handlerViewsWithoutServiceMessage(surface: PluginSurface, hasService: boolean): string | null {
  if (hasService) return null
  const views = Object.entries(surface.views)
    .filter(([, view]) => view?.data?.kind === 'handler')
    .map(([id]) => id)
  if (views.length === 0) return null
  return (
    `view${views.length === 1 ? '' : 's'} ${views.map((v) => `"${v}"`).join(', ')} read rows from a \`{ kind: 'handler' }\` data source, ` +
    `but this plugin declares no \`service\` — \`ctx.onQuery\` is registered by \`defineService({ setup })\` and exists nowhere else, ` +
    `so nothing would ever answer that view (docs/plans/109-m74-plugin-runtime.md §3.1, §4.6).`
  )
}

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
export const BINDING_DEVICE_FIELDS = ['id', 'stableId', 'label', 'status', 'groupId', 'number'] as const
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
 * components with no build step at all; tier C states `react` and is an ES
 * module out of the package's `ui/` directory, loaded into Studio's own tree
 * with Studio's own React (plan 111 §3.1, §3.2). The two are mutually
 * exclusive, and exactly one is required — checked by
 * `validatePluginSurface` below rather than here, so the refusal can name
 * the offending view id, which a schema-level refinement cannot see (the id
 * is the record KEY one level up).
 *
 * Plan 108's tier B — a sandboxed iframe, spelled `frame` — was REMOVED by
 * plan 111 §3.6 rather than deprecated (00-overview §4.3): once React with
 * full page access exists, nobody would choose a frame that cannot even
 * `fetch`, and a weaker parallel path kept "for one release" is exactly what
 * that rule forbids. There is no compatibility alias; a manifest still
 * naming `frame` fails the `.strict()` parse.
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
    /**
     * Tier C (plan 111 §3.1, §4.1) — an ES module inside the package's `ui/`
     * directory, injected as a `<script type="module">` and expected to
     * `window.__enkaku__.register(viewId, Component)`.
     *
     * `entry` is a path RELATIVE to `ui/`, exactly the shape
     * `PluginPackageAsset.path` uses; what may legally be there is already
     * governed by the `.enkaku` allowlist (`packages/core/src/plugins/package.ts`),
     * so nothing is re-stated here. It is not resolved at parse time on
     * purpose: a surface is validated by `definePlugin` on the author's own
     * machine, where there is no package yet to look inside.
     *
     * `apiVersion` is the `@enkaku/ui` major the module was BUILT against.
     * Required, not defaulted: `react` is new in plan 111, so there is no
     * older view for a default to be kind to, and a silent default would be a
     * guess about the one fact the check exists to establish. Verify compares
     * it against `PLUGIN_UI_API_VERSION` and refuses a mismatch naming both
     * (§3.5) — the bound here is only the coarse shape check, so a plainly
     * absurd number is a schema error rather than a version report.
     */
    react: z
      .object({ entry: z.string().min(1).max(200), apiVersion: z.number().int().min(1).max(999) })
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
    /**
     * Defaulted to `{}` by plan 111 step 111.4, and this is a real consequence
     * of tier C rather than a convenience.
     *
     * Under tier A the declared actions WERE the plugin's write path — a table
     * mutates only through one, evaluated server-side against the verified
     * surface — so requiring the key made an author state, even as `{}`, that
     * their screen does nothing. A React view has no such gap to close: it runs
     * in Studio's document with the operator's session and calls `fetch`
     * directly (§3.4), so a perfectly complete tier-C plugin declares no
     * actions at all. That is the shape `enkaku init` scaffolds, and demanding
     * `actions: {}` from it would be exactly the ceremony `enkaku init` exists
     * to remove.
     *
     * Nothing downstream changes: `.default({})` applies at PARSE, so every
     * consumer of a `PluginSurface` — the registry, the executor, Studio —
     * still reads a present record, and only the author-facing
     * `PluginSurfaceInput` gains an optional key.
     */
    actions: z.record(SurfaceIdSchema, ActionSpecSchema).default({}),
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
 * does not exist, a duplicate nav id, and the `table`/`react` renderer
 * exclusivity (plan 111 §4.1). The `react.apiVersion` compatibility check is
 * deliberately NOT here: this function answers "is this surface well
 * formed?", which is the same answer everywhere, while whether a given
 * `@enkaku/ui` major is supported is a property of the BUILD doing the
 * asking — so it lives in the verify parent (`verify-child.ts`), which is the
 * farm's own half. Existence of a `script` a `job`/`batch` action names is NOT checked
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
    // Exactly one RENDERER — `table` (tier A) or `react` (tier C) — but `data`
    // belongs to either.
    //
    // An earlier reading made `data` part of the tier-A half and refused it
    // beside the other renderer, which left that view with nothing it could
    // legally read: `data.query` had no declared source and answered
    // `no_data_source` forever, so the tier could only ever hold static
    // markup (plan 108 §9 Q4 corrected this). The correction stands verbatim
    // for `react`, and plan 111 §3.4 restates it: a React view may declare a
    // source and read it through `/api/plugins/:name/data/*`, exactly as a
    // table does.
    //
    // What HAS changed with tier C is that `data` is no longer the only thing
    // the view can reach. A React view runs in Studio's own document with the
    // operator's session and can `fetch` anything that session may reach —
    // deliberately (plan 111 §0.1, §2: isolation is a non-goal). So declaring
    // a source is now a convenience, not a boundary, and nothing here should
    // be read as one.
    if (view.react !== undefined && view.table !== undefined) {
      errors.push(`view "${viewId}" declares both \`table\` and \`react\` — a view has one renderer, never two`)
    }
    if (view.react === undefined && view.table === undefined) {
      errors.push(`view "${viewId}" declares neither \`table\` nor \`react\` — a view needs one renderer`)
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

// ---------------------------------------------------------------------------
// What a React view is HANDED (plan 111 §9 Q2; published here by the 111.7
// follow-up)
// ---------------------------------------------------------------------------

/**
 * Everything in the page's query string that Studio has NOT claimed.
 *
 * Studio claims exactly two keys — `name` and `view` — because those are what
 * `/plugins/view?name=…&view=…` resolves the screen from. Every other key is
 * the plugin's, handed over as-is with no interpretation.
 */
export type PluginViewParams = Readonly<Record<string, string>>

/**
 * Writes the unclaimed query keys back. **Patch semantics**: a key present in
 * `patch` is set, a key mapped to `null` is removed, and a key absent from
 * `patch` is left exactly as it was — so a plugin with two independent
 * URL-backed controls never has to know about the other one's key.
 *
 * `name` and `view` are ignored if a plugin passes them: they address the
 * screen, and a plugin rewriting them would navigate itself somewhere else
 * mid-render.
 */
export type SetPluginViewParams = (patch: Readonly<Record<string, string | null>>) => void

/**
 * The props a plugin's view component receives. Deliberately minimal: a
 * plugin owns its own screen and fetches its own data with the operator's
 * session (§3.4), so there is nothing the host must hand it except which
 * view of which plugin it is being asked to be — enough for one module to
 * register one component under several view ids — plus the query passthrough
 * of §9 Q2.
 *
 * **Why this lives in the protocol rather than in Studio.** It is a contract
 * between two codebases that never link: Studio renders the component, an
 * author writes it, and until this moved here the shape existed only in
 * `packages/studio/src/lib/plugin-host.ts` — importable by nothing an author
 * could reach. The first tier-C pack therefore hand-copied it into its own
 * `enkaku-host.d.ts`, where nothing would ever have checked it against the
 * host's (recorded in plan 111's status block).
 *
 * It carries **no React type**, which is what makes this package the right
 * home: `PluginViewProps` is four strings and a function, and the only React
 * type in the neighbourhood — `ComponentType<PluginViewProps>` — belongs to
 * whoever renders or registers the component, not to the props themselves.
 * `@enkaku/protocol` has zero React dependency and keeps it. `@enkaku/ui`
 * re-exports these three names for the author's convenience, because that is
 * the package a React plugin already has installed.
 */
export interface PluginViewProps {
  plugin: string
  version: string
  viewId: string
  params: PluginViewParams
  setParams: SetPluginViewParams
}
