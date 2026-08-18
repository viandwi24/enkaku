import { SCHEMA_LIMITS, readHints } from '@enkaku/protocol'
import type { DurationUnit, EnforcementLevel, NumberKind, ParamHints, ParamKind, ParamSource, ShowWhen } from '@enkaku/protocol'
import { deref, humanize } from './resolve'
import type { JsonSchemaNode } from './types'

/**
 * The resolver (plan 95 §3.1, §3.3, §4.5) — the ONLY place in the product
 * that chooses a control. `planField` is a pure function from a JSON Schema
 * node to a widget descriptor: **total** (`json` is a terminal RESULT, never
 * a throw — an old script with a bare `z.number()`, an unknown hint from a
 * newer core, a shape nobody anticipated all land somewhere renderable),
 * **deterministic** (no fetching, no time, no randomness, no DOM — `source`
 * enrichment happens later, in the control, exactly as `useEnumOptions`
 * already does), and **DOM-free** (`plan.test.ts` imports no React and no
 * `@testing-library`, which is what keeps this file the one that survives a
 * Studio restyle).
 *
 * `@enkaku/protocol` never mentions `control` (plan 95 §3.1) — this file,
 * inside `packages/studio`, is the only one on that side of the boundary.
 *
 * ## The precedence table (plan 95 §3.3)
 *
 * Checked top to bottom; the FIRST row that matches wins. `planField`'s `if`
 * chain below is written in this exact order so the two can be diffed by
 * eye — if you are changing one, change the other.
 *
 * | # | Condition | Result | Kind of decision |
 * |---|---|---|---|
 * | 1 | `$ref` present | resolve against the root **with a visited set**; a cycle → `json` ("this parameter refers to itself") | structural |
 * | 2 | node depth > `SCHEMA_LIMITS.maxDepth` | `json` ("too deeply nested to render") | safety |
 * | 3 | `x-enkaku.kind` present **and valid for this node's structural type** | the control for that kind, from `planDeclaredKind`'s single lookup — a number control, a text control, a workspace path browser (`workspaceFolder`/`workspaceFile`, both string-only), or an artifact picker (`artifact`, string-only) | **declared** |
 * | 4 | `enum` or `const` present | `choice` (decorated by `labels`, then by `source`) | structural |
 * | 5 | `type: 'boolean'` | `toggle` | structural |
 * | 6 | `prefixItems` of length 2, both numeric | `pair` — `ordered` from `x-enkaku`, default `true`; each half planned by rows 3/9 | structural |
 * | 7 | `type: 'string'` and `format` in `{date-time, uri, email}` | the matching control | **JSON Schema's own semantics** |
 * | 8 | `type: 'string'` | `text` (`multiline` from `x-enkaku`, else from `maxLength > 200`) | structural |
 * | 9 | `type: 'number' \| 'integer'` | `number` — bounds from `minimum`/`maximum` **unless they are the `±MAX_SAFE_INTEGER` sentinels** (F5); `step` (the HTML validation attribute) is `multipleOf` when the schema states one, else `1` for `integer` and `'any'` for `number` (96.31); `increment` (the +/- button delta, always a real number — see `numberBounds`'s own doc comment) is `multipleOf` or `1` the same way, else a fixed `0.01` for an unconstrained float | structural |
 * | 10 | `type: 'array'` with object `items` | `table` — one planned column per property | structural |
 * | 11 | `type: 'array'` with scalar `items` | `list` of the planned item | structural |
 * | 12 | `type: 'object'` with a non-empty `properties` | `group`, children planned in declaration order | structural |
 * | 13 | `type: 'object'` with **no** `properties` (a `z.record`) | `json` ("this parameter is a free-form map") — **never** the empty card of F19 | structural |
 * | 14 | `anyOf`/`oneOf` where exactly one branch is non-`null` | plan that branch, WITH the wrapper's own hints threaded down as `inheritedHints` (nullable unwrapping — the branch's own hints win per key) | structural |
 * | 15 | `anyOf`/`oneOf` with several real branches | `json` ("this parameter can take several different shapes") | structural |
 * | 16 | anything else | `json` ("this parameter's type is not one the form can draw") | terminal |
 *
 * Two properties fall straight out of the table and are asserted as tests in
 * `plan.test.ts`: **row 16 is unreachable-by-failure** (it is a result, not
 * an error), and **every row above it degrades downward** — an invalid
 * row-3 hint simply does not match, so the node falls through to its
 * structural row. An older script with a bare `z.number()` therefore lands
 * on row 9 and renders exactly as well as it does today, which is the
 * compatibility floor (plan 95 §5 step 95.2's no-regression case).
 *
 * ## Hints on a nullable wrapper (96.3 fix, M60 report item 7)
 *
 * `z.toJSONSchema` renders `.nullable()` as `anyOf: [{ ...the real shape },
 * { type: 'null' }]`, and `.meta(ui({ ... }))` chained AFTER `.nullable()` —
 * the natural place to write it, and where every field in this repo does —
 * lands `x-enkaku` on that outer `anyOf` node, not on either branch. The
 * wrapper node has no `.type`, `.enum`, `.prefixItems`, or `.format` of its
 * own, so rows 3 through 13 can never match it on ANY hint (not just
 * `kind`); every nullable field falls straight through to row 14 regardless.
 * The fix therefore lives in row 14, not row 3: the wrapper's `hints` are
 * threaded into the recursive `planField` call as its (otherwise-unused)
 * third argument, `inheritedHints`, and merged there with whatever
 * `readHints` finds on the branch itself — not by writing a synthetic
 * `x-enkaku` back onto the branch node and reading it a second time (see
 * `planField`'s own doc comment for why THAT would silently re-break this
 * exact bug). This closes the gap for every hint row 14 can reach
 * (`kind`/`unit`, `multiline`, `ordered`, `source`, `labels`) in one place,
 * not just `kind` — the same wrapper-node blindness would otherwise
 * silently swallow any of them.
 *
 * A **rejected** alternative: teaching row 3 to peek inside a single-real-
 * branch `anyOf` itself. That would fix `kind` alone, leave rows 4/6/8
 * (`labels`/`source`, `ordered`, `multiline`) still blind to the same
 * wrapper on a nullable enum/pair/string, and would have to duplicate row
 * 14's own branch-selection logic to know which branch's bounds/enum/items
 * to read — two places doing one unwrap. Row 14 already owns "which branch
 * is the real one"; teaching it to also carry the wrapper's hints down is
 * the smaller, single-purpose change.
 *
 * If BOTH the wrapper and the branch carry `x-enkaku` — an unusual, doubly
 * annotated field — neither is silently dropped: the branch's own hints win
 * per KEY (`{ ...inheritedHints, ...readHints(node) }`, in `planField`
 * itself), because the branch's annotation already worked before this fix
 * and must keep working identically. A key only the wrapper sets (say
 * `source`, with the branch silent on it) still reaches the plan. The merge
 * is shallow, at the `ParamHints`-field level: if both sides set `labels`,
 * the branch's whole map REPLACES the wrapper's, not a per-member union —
 * see `plan.test.ts`'s "the merge is shallow" case.
 *
 * Other wrappers, checked against the same failure mode:
 *   - `.optional()` and `.default()` add no `anyOf` of their own — `z.toJSONSchema`
 *     merges their effect (dropping the key from `required`, adding a
 *     sibling `default` keyword) onto the SAME node the hint already sits
 *     on, so `readHints` already sees it today. No fix needed, and this
 *     resolver never even branches on `optional`/`default` (K2 seeds
 *     defaults separately, in the form layer — see `planForm`'s doc
 *     comment).
 *   - `.nullable().optional()` stacked is the identical single-`anyOf` shape
 *     as `.nullable()` alone (`optional` contributes nothing at the schema
 *     level) — covered by the same fix, no special case.
 *   - A union of **three or more members** (including a bare `z.union([A,
 *     B, z.null()])`) still reaches row 14, but with `real.length > 1`, so
 *     it falls to row 15's `json` fallback regardless of any hint — a
 *     `kind` cannot select among several genuinely different shapes, so
 *     row 15 never reads `hints` at all and there is nothing for this fix
 *     to forward. Out of scope on purpose, not by oversight.
 *   - A hint that sits beside a `$ref` (`{ $ref: '#/...', 'x-enkaku': {...}
 *     }`) is dropped by row 1, which reads only `.$ref` and discards
 *     siblings — true whether or not the `$ref` is inside a nullable
 *     `anyOf`. Pre-existing, general to row 1, and not something this fix
 *     changes: row 1's recursive call (`planField(resolved, { ...ctx, seen
 *     })`) intentionally does NOT pass `inheritedHints` on, matching the
 *     pre-96.3 behaviour for every OTHER sibling key `$ref` already
 *     discarded — a `$ref` branch is neither newly broken nor newly fixed.
 *
 * ## Where this refuses to infer (plan 95 §3.3)
 *
 * A `number` with `min 0, max 1` is NOT a chance (`gestureCurvature` is
 * `min(0).max(0.5)` and is not a probability) — `kind: 'chance'` must be
 * declared, and even then only takes row 3 when the bounds are exactly
 * `[0, 1]`; outside that domain it falls through to row 9's plain number,
 * on purpose. A field named `*Ms`/`*Sec` is never sniffed for `duration`
 * — annotating `settings.ts` (a later step) is the answer, not guessing
 * here. A `string` with a `pattern` is not validated by that pattern
 * (§3.8) — this file does not even read `pattern`.
 */

// `NumberKind` moved to `@enkaku/protocol` (plan 97 §4.1, step 97.1) —
// alongside `formatValue`, which is its only real consumer outside this
// file's own `FieldPlan['control: number']` variant below.

/** One planned choice-control option. `source`-driven enrichment (K4) is a
 *  control-time concern, not a planning-time one — see the module doc. */
export interface PlannedOption {
  value: string
  label: string
}

export type FieldPlan =
  | { control: 'toggle' }
  | { control: 'choice'; options: PlannedOption[]; source?: ParamSource }
  | {
      control: 'number'
      kind: NumberKind
      unit?: DurationUnit
      min?: number
      max?: number
      /**
       * The HTML `step` VALIDATION attribute (96.31) — never the +/- button
       * delta, see `increment` below. `'any'` is a real, valid HTML attribute
       * value ("no step constraint") but is not itself a number, which is
       * exactly why it cannot double as a button delta — see `NumberField`'s
       * own doc comment for the bug this split fixes.
       */
      step?: number | 'any'
      /**
       * The +/- stepper button delta (96.31) — always a real number, never
       * `'any'`. Deliberately a SEPARATE field from `step`: an HTML `<input
       * step="any">` is what makes a plain float like `gestureCurvature`
       * (0.08) pass browser validation, but `'any'` is meaningless as an
       * arithmetic increment — `Number('any')` is `NaN`, which would
       * silently disable both buttons if `NumberField` computed its delta
       * from `step` the way it used to. See `numberBounds`'s own doc comment
       * for how this is derived.
       */
      increment?: number
      /**
       * Plan 98 §3.5, §3.9, §4.3 — how hard THIS field's own limit is
       * actually enforced, straight off the schema's `x-enkaku.enforcement`
       * hint (never recomputed — this resolver only forwards what the
       * author declared). `undefined` (the vast majority of numeric fields,
       * which carry no `enforcement` at all) and `'hard'` both render no
       * badge: `'hard'` is the default expectation for a limit (refused or
       * clamped outright), so a badge would be noise on every ordinary
       * field. `'sampled'`/`'advisory'` are the two values that change what
       * an operator should believe about the number next to them, so those
       * are the only ones `NumberControl` draws a badge for (plan 98 §3.5:
       * "that phrase is not a disclaimer buried in a doc comment, it is a
       * machine-readable field").
       */
      enforcement?: EnforcementLevel
    }
  | { control: 'pair'; ordered: boolean; item: Extract<FieldPlan, { control: 'number' }> }
  | { control: 'text'; multiline: boolean; format?: 'uri' | 'email' | 'date-time'; maxLength?: number }
  | {
      /**
       * `kind: 'workspaceFolder'` / `kind: 'workspaceFile'` — one control
       * value for both, discriminated by `target`, because a folder browser
       * and a file browser over the same tree are the same widget with one
       * different answer to "what is clickable". `renderControl` therefore
       * still dispatches on `control` alone.
       *
       * The VALUE is a workspace path (`/videos`, `/captions.txt`) — always
       * absolute within the workspace, never a host filesystem path. A
       * folder is stored WITHOUT its trailing slash (`fs.list` returns
       * `/videos/`; `normaliseWorkspacePath` refuses that form), except the
       * workspace root, which is `/`.
       */
      control: 'workspacePath'
      target: 'folder' | 'file'
      /** `target: 'file'` only, and only when the author declared one —
       *  narrows what the browser OFFERS, never what it accepts. */
      extensions?: string[]
    }
  | {
      /**
       * `kind: 'artifact'` — the value is an artifact ID (`@enkaku/protocol`'s
       * own vocabulary comment), never a path, never a URL. Drawn by
       * `ArtifactControl`, which wraps the same `ArtifactPicker` the
       * bulk-transfer and install-batch dialogs already use (plan 93) rather
       * than a second picker.
       */
      control: 'artifact'
    }
  | { control: 'list'; item: FieldPlan }
  | { control: 'table'; columns: { key: string; label: string; plan: FieldPlan }[] }
  | { control: 'group'; heading?: string; children: PlannedField[] }
  | { control: 'json'; reason: string }

export interface PlannedField {
  /** The field's own key within its IMMEDIATE parent — never a dotted
   *  absolute path. `planForm`'s top-level results need no prefix (their
   *  parent is the schema's root); a caller descending into a `group`
   *  plan's `children` accumulates the full path itself while walking, the
   *  same way the current renderer already does (`SchemaForm.tsx`'s own
   *  `path` accumulation). */
  path: string
  label: string
  help?: string
  /** Section heading, from a run of equal `group` values (plan 95 §3.5). */
  group?: string
  advanced: boolean
  required: boolean
  showWhen?: ShowWhen
  plan: FieldPlan
}

export interface PlanContext {
  root: JsonSchemaNode
  depth: number
  seen: ReadonlySet<string>
}

const MAX_SAFE = Number.MAX_SAFE_INTEGER

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function baseType(node: JsonSchemaNode): string | undefined {
  return Array.isArray(node.type) ? (node.type as unknown[]).find((t) => t !== 'null') as string | undefined : (node.type as string | undefined)
}

function isNumericType(type: string | undefined): boolean {
  return type === 'number' || type === 'integer'
}

function isKnownFormat(format: unknown): format is 'date-time' | 'uri' | 'email' {
  return format === 'date-time' || format === 'uri' || format === 'email'
}

function numOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined
}

function hasEnumOrConst(node: JsonSchemaNode): boolean {
  return (Array.isArray(node.enum) && node.enum.length > 0) || (node as Record<string, unknown>).const !== undefined
}

function isTextKind(kind: ParamKind): kind is 'text' | 'packageName' {
  return kind === 'text' || kind === 'packageName'
}

function isWorkspacePathKind(kind: ParamKind): kind is 'workspaceFolder' | 'workspaceFile' {
  return kind === 'workspaceFolder' || kind === 'workspaceFile'
}

function isArtifactKind(kind: ParamKind): kind is 'artifact' {
  return kind === 'artifact'
}

/**
 * Every kind whose value is a STRING — the ones row 3 checks against
 * `type: 'string'` rather than against a numeric type. Restated here rather
 * than imported because `@enkaku/protocol` exports the vocabulary itself,
 * not this predicate; the two cannot silently drift, because
 * `planKindNumber` below narrows to `Exclude<ParamKind, StringKind>` and
 * assigns it to `FieldPlan`'s `NumberKind`, which the protocol derives from
 * its OWN string-kind list. Forget a kind here and that assignment stops
 * typechecking.
 */
type StringKind = 'text' | 'packageName' | 'workspaceFolder' | 'workspaceFile' | 'artifact'

function isStringKind(kind: ParamKind): kind is StringKind {
  return isTextKind(kind) || isWorkspacePathKind(kind) || isArtifactKind(kind)
}

/**
 * Row 3's "valid for this node's structural type" test. Deliberately
 * excludes any node that ALSO carries an `enum`/`const`: a `kind` hint must
 * never displace a closed choice with a free-value control, because that
 * would make an invalid entry easy where the enum made it impossible — the
 * second half of §3.2's rule ("a wrong inference must not make an invalid
 * value easy to enter").
 */
function kindStructurallyValid(kind: ParamKind, node: JsonSchemaNode): boolean {
  if (hasEnumOrConst(node)) return false
  if (isStringKind(kind)) return baseType(node) === 'string'
  if (!isNumericType(baseType(node))) return false
  // `chance` additionally requires the domain the vocabulary promises
  // (plan 95 §3.2): "the resolver REQUIRES minimum: 0 and maximum: 1; a
  // chance outside that domain is a publish-time error and, at render,
  // degrades to a plain number box." A schema published before that
  // publish-time check existed must still degrade correctly here.
  if (kind === 'chance') return node.minimum === 0 && node.maximum === 1
  return true
}

/**
 * 96.31 — the fix for "Settings unsavable": HTML's own default `step` for
 * `type="number"` is `1` whenever the attribute is OMITTED, so a field like
 * `gestureCurvature` (`min(0).max(0.5).default(0.08)`, no `.multipleOf()`)
 * used to plan `step: undefined`, `NumberField` left the attribute off, and
 * the browser rejected its own stored `0.08` as "not a multiple of 1" — the
 * exact error the owner hit. The JSON-Schema-correct rule this restores:
 * `type: 'integer'` gets `step: 1`; `type: 'number'` gets `step: 'any'`
 * UNLESS `multipleOf` says otherwise. `multipleOf` wins over both when
 * present, on either type.
 *
 * `increment` is a second, deliberately separate value (see `FieldPlan`'s own
 * doc comment on why `step` cannot double as the button delta once `'any'`
 * is a possible `step`). It answers a different question — "what should one
 * click of + do?" — and is always a plain number:
 *   - `multipleOf`, when the schema states one — the same value as `step`,
 *     because a declared multiple IS the natural increment.
 *   - `1` for an `integer` with no `multipleOf` — unchanged from today.
 *   - `0.01` for a `number` with no `multipleOf` — a fixed constant, not
 *     derived from `min`/`max`, because every bounded float in this
 *     workspace (`gestureCurvature`: 0–0.5, exactly 50 clicks end to end;
 *     `lat`/`lng`: real-world coordinates, typed rather than clicked to a
 *     specific value) reads naturally at hundredths, and a bounds-derived
 *     increment would make the SAME field's click size depend on where its
 *     author happened to set `max` — a wrong guess for one field silently
 *     changing the increment on every other unrelated float. `1` (too coarse
 *     — jumps straight over `gestureCurvature`'s whole range) and `'any'`
 *     (not a number at all) are the two values §3.2's "a wrong inference
 *     must not cost the operator a valid value" rule already rules out.
 */
function numberBounds(node: JsonSchemaNode): { min?: number; max?: number; step?: number | 'any'; increment?: number } {
  const rawMin = numOrUndefined(node.minimum) ?? numOrUndefined((node as Record<string, unknown>).exclusiveMinimum)
  const rawMax = numOrUndefined(node.maximum) ?? numOrUndefined((node as Record<string, unknown>).exclusiveMaximum)
  const multipleOf = numOrUndefined((node as Record<string, unknown>).multipleOf)
  const isInteger = baseType(node) === 'integer'
  return {
    min: rawMin === -MAX_SAFE ? undefined : rawMin,
    max: rawMax === MAX_SAFE ? undefined : rawMax,
    step: multipleOf ?? (isInteger ? 1 : 'any'),
    increment: multipleOf ?? (isInteger ? 1 : 0.01),
  }
}

function planKindNumber(node: JsonSchemaNode, kind: Exclude<ParamKind, StringKind>, hints: ParamHints): Extract<FieldPlan, { control: 'number' }> {
  return { control: 'number', kind, unit: kind === 'duration' ? hints.unit : undefined, enforcement: hints.enforcement, ...numberBounds(node) }
}

function planPlainNumber(node: JsonSchemaNode): Extract<FieldPlan, { control: 'number' }> {
  return { control: 'number', kind: 'plain', ...numberBounds(node) }
}

function planTextPlain(node: JsonSchemaNode, hints: ParamHints): Extract<FieldPlan, { control: 'text' }> {
  const maxLength = numOrUndefined(node.maxLength)
  const multiline = hints.multiline ?? (typeof maxLength === 'number' && maxLength > 200)
  return { control: 'text', multiline, maxLength }
}

function planWorkspacePath(kind: 'workspaceFolder' | 'workspaceFile', hints: ParamHints): Extract<FieldPlan, { control: 'workspacePath' }> {
  return {
    control: 'workspacePath',
    target: kind === 'workspaceFolder' ? 'folder' : 'file',
    // A folder has nothing to filter, so a stray `extensions` on one is
    // dropped here rather than carried into a control that would ignore it
    // (`ParamHintsSchema` already refuses the combination at publish; this
    // is the render-time half, for a schema stored before it did).
    ...(kind === 'workspaceFile' && hints.extensions ? { extensions: hints.extensions } : {}),
  }
}

/**
 * Row 3's whole body: ONE lookup from a declared, structurally-valid `kind`
 * to the control that draws it. Every kind goes through here — adding one is
 * a case in this function, never a new `if` in `planField` (which is what
 * keeps the precedence table diffable against the `if` chain by eye).
 */
function planDeclaredKind(node: JsonSchemaNode, kind: ParamKind, hints: ParamHints): FieldPlan {
  if (isWorkspacePathKind(kind)) return planWorkspacePath(kind, hints)
  if (isArtifactKind(kind)) return { control: 'artifact' }
  if (isTextKind(kind)) return planTextPlain(node, hints)
  return planKindNumber(node, kind, hints)
}

function planChoice(node: JsonSchemaNode, hints: ParamHints): FieldPlan {
  const constValue = (node as Record<string, unknown>).const
  const raw: unknown[] = Array.isArray(node.enum) && node.enum.length > 0 ? node.enum : constValue !== undefined ? [constValue] : []
  const options: PlannedOption[] = raw.map((member) => {
    const value = String(member)
    return { value, label: hints.labels?.[value] ?? value }
  })
  return { control: 'choice', options, source: hints.source }
}

function isPairNode(node: JsonSchemaNode, root: JsonSchemaNode): boolean {
  if (!Array.isArray(node.prefixItems) || node.prefixItems.length !== 2) return false
  return (node.prefixItems as JsonSchemaNode[]).every((item) => isNumericType(baseType(deref(item, root))))
}

/**
 * `x-enkaku` lives on the TUPLE (`ordered`, and any `kind`/`unit` meant for
 * the pair as a whole — §3.2, §3.9), never on either half individually, so
 * the item is planned from the PAIR's own hints applied to one
 * representative half — "each half planned by rows 3/9" (§3.3) collapses
 * to one shared shape because, in every real schema this repo has, both
 * halves agree.
 */
function planPair(node: JsonSchemaNode, hints: ParamHints, root: JsonSchemaNode): FieldPlan {
  const half = deref((node.prefixItems as JsonSchemaNode[])[0]!, root)
  const item =
    hints.kind && !isStringKind(hints.kind) && kindStructurallyValid(hints.kind, half) ? planKindNumber(half, hints.kind, hints) : planPlainNumber(half)
  return { control: 'pair', ordered: hints.ordered ?? true, item }
}

function hasNonEmptyProperties(node: JsonSchemaNode): boolean {
  return isRecord(node.properties) && Object.keys(node.properties).length > 0
}

function itemsSchema(node: JsonSchemaNode): JsonSchemaNode | undefined {
  // JSON Schema's `items` is a single schema for a homogeneous array (the
  // only shape `z.array(T)` produces); an `items` ARRAY is the older
  // positional-tuple dialect, which this repo's `prefixItems`-based pair
  // (row 6) already covers for the one case that occurs — so an array
  // `items` here is simply not a shape this resolver plans a list/table
  // from.
  return Array.isArray(node.items) ? undefined : (node.items as JsonSchemaNode | undefined)
}

function isObjectItemsArray(node: JsonSchemaNode, root: JsonSchemaNode): boolean {
  const items = itemsSchema(node)
  return items !== undefined && hasNonEmptyProperties(deref(items, root))
}

function labelFor(node: JsonSchemaNode, root: JsonSchemaNode, key: string): string {
  const resolved = deref(node, root)
  return typeof resolved.title === 'string' ? resolved.title : humanize(key)
}

function planTable(node: JsonSchemaNode, ctx: PlanContext): FieldPlan {
  const items = itemsSchema(node)
  const resolved = items ? deref(items, ctx.root) : undefined
  const properties = resolved && isRecord(resolved.properties) ? (resolved.properties as Record<string, JsonSchemaNode>) : {}
  const nextCtx: PlanContext = { ...ctx, depth: ctx.depth + 1 }
  const columns = Object.entries(properties).map(([key, child]) => ({
    key,
    label: labelFor(child, ctx.root, key),
    plan: planField(child, nextCtx),
  }))
  return { control: 'table', columns }
}

function planList(node: JsonSchemaNode, ctx: PlanContext): FieldPlan {
  const items = itemsSchema(node)
  const nextCtx: PlanContext = { ...ctx, depth: ctx.depth + 1 }
  const item: FieldPlan = items ? planField(items, nextCtx) : { control: 'json', reason: "this parameter's type is not one the form can draw" }
  return { control: 'list', item }
}

function planGroup(node: JsonSchemaNode, ctx: PlanContext): FieldPlan {
  const children = planObjectChildren(node, { ...ctx, depth: ctx.depth + 1 })
  return { control: 'group', heading: typeof node.title === 'string' ? node.title : undefined, children }
}

function unionBranches(node: JsonSchemaNode): JsonSchemaNode[] | undefined {
  if (Array.isArray(node.anyOf) && node.anyOf.length > 0) return node.anyOf
  const oneOf = (node as Record<string, unknown>).oneOf
  if (Array.isArray(oneOf) && oneOf.length > 0) return oneOf as JsonSchemaNode[]
  return undefined
}

/** Resolves exactly ONE `$ref` hop (`#`, or `#/a/b/...`) against `root`.
 *  Chain-following and cycle detection are the CALLER's job (row 1, via
 *  `ctx.seen`) — this only ever looks at the node it is given. */
function resolveRef(ref: string, root: JsonSchemaNode): JsonSchemaNode | undefined {
  if (ref === '#') return root
  const segments = ref.replace(/^#\/?/, '').split('/').filter(Boolean)
  let cur: unknown = root
  for (const segment of segments) {
    if (!isRecord(cur)) return undefined
    cur = cur[segment]
  }
  return isRecord(cur) ? (cur as JsonSchemaNode) : undefined
}

/**
 * Total, deterministic, DOM-free. Plan 95 §3.3's table, in order — see the
 * module doc comment for the full table and the reasoning behind each row.
 *
 * `inheritedHints` (96.3, M60 report item 7) is ONLY ever passed by row 14's
 * own recursive call, forwarding the hints that sat on a nullable wrapper's
 * `anyOf` node down onto the single real branch it unwraps — see the module
 * doc comment's "Hints on a nullable wrapper" section. Every other call site
 * in this file (row 1's `$ref` resolution, `planTable`, `planList`,
 * `planGroup`/`planObjectChildren`/`planPlannedField`, and every external
 * caller) calls `planField` with two arguments, which is exactly the
 * pre-96.3 behaviour: a hint never leaks from one field into an unrelated
 * one just because this parameter exists.
 */
export function planField(node: JsonSchemaNode, ctx: PlanContext, inheritedHints: ParamHints = {}): FieldPlan {
  // A hostile or merely malformed value that is not itself an object
  // cannot be inspected safely (and `null.$ref` would throw) — total means
  // this never happens, not "usually doesn't".
  if (!isRecord(node)) {
    return { control: 'json', reason: "this parameter's type is not one the form can draw" }
  }

  // Row 1 — $ref, resolved with a visited set (R1, F21): a cycle is
  // representable (`z.lazy`) and is a reachable hang, not a hypothetical.
  if (typeof node.$ref === 'string') {
    if (ctx.seen.has(node.$ref)) {
      return { control: 'json', reason: 'this parameter refers to itself' }
    }
    const resolved = resolveRef(node.$ref, ctx.root)
    if (resolved === undefined) {
      return { control: 'json', reason: "this parameter's type is not one the form can draw" }
    }
    const seen = new Set(ctx.seen)
    seen.add(node.$ref)
    return planField(resolved, { ...ctx, seen })
  }

  // Row 2 — a depth cap independent of row 1: plain nested objects, no
  // $ref anywhere, can still nest past anything a person should read.
  if (ctx.depth > SCHEMA_LIMITS.maxDepth) {
    return { control: 'json', reason: 'too deeply nested to render' }
  }

  // Merged, not re-validated: `inheritedHints` and `readHints(node)` were
  // each already checked against `ParamHintsSchema` independently (at
  // authoring time, wherever each was written); combining them here as
  // typed values — rather than writing a synthetic `x-enkaku` blob back
  // onto the node and reading it a second time — matters, because the
  // combination of two independently-valid hint objects is not always
  // itself a valid one (e.g. an inherited `unit: 'ms'` surviving next to a
  // branch's own `kind: 'bytes'`, which alone would fail
  // `ParamHintsSchema`'s cross-field check). A second `readHints` pass over
  // that combination would reject the whole object and silently drop BOTH
  // sides — the exact failure mode this fix exists to close, reintroduced
  // one level down. `readHints(node)` wins key by key, matching "the
  // branch's own hints win" from the module doc comment.
  const hints: ParamHints = { ...inheritedHints, ...readHints(node) }

  // Row 3 — a DECLARED kind, valid for this node's own structural type.
  // An invalid combination (wrong type, an enum/const present, `chance`
  // outside [0,1]) simply does not match and falls through — see
  // `kindStructurallyValid`'s doc comment for the reasoning.
  if (hints.kind && kindStructurallyValid(hints.kind, node)) {
    return planDeclaredKind(node, hints.kind, hints)
  }

  // Row 4 — enum or const: a closed choice, decorated by `labels` now and
  // by `source` later, in the control (K4) — never by fetching here.
  if (hasEnumOrConst(node)) {
    return planChoice(node, hints)
  }

  const type = baseType(node)

  // Row 5 — boolean.
  if (type === 'boolean') {
    return { control: 'toggle' }
  }

  // Row 6 — a 2-number tuple is an interval BY STRUCTURE (K3); `ordered`
  // only says which end comes first, never whether it is one.
  if (isPairNode(node, ctx.root)) {
    return planPair(node, hints, ctx.root)
  }

  // Row 7 — JSON Schema's own string formats: reading a standard, not
  // guessing one.
  if (type === 'string' && isKnownFormat(node.format)) {
    return { control: 'text', multiline: false, format: node.format, maxLength: numOrUndefined(node.maxLength) }
  }

  // Row 8 — a plain string; `multiline` from the hint, else inferred from
  // length (a textarea and an input accept the same strings, so a wrong
  // guess here costs nothing but taste — §3.3's one allowed inference).
  if (type === 'string') {
    return planTextPlain(node, hints)
  }

  // Row 9 — a plain number/integer.
  if (isNumericType(type)) {
    return planPlainNumber(node)
  }

  // Rows 10/11 — an array. Object items become a row editor (closes F18,
  // the `[object Object]` text-input defect); anything else becomes a list
  // of the planned item.
  if (type === 'array') {
    return isObjectItemsArray(node, ctx.root) ? planTable(node, ctx) : planList(node, ctx)
  }

  // Rows 12/13 — an object. Non-empty `properties` is a group of planned
  // children, in declaration order (H2). Empty `properties` on a
  // `type: 'object'` node is a `z.record` — a free-form map, closed as a
  // labelled escape hatch rather than F19's empty card.
  if (hasNonEmptyProperties(node)) {
    return planGroup(node, ctx)
  }
  if (type === 'object') {
    return { control: 'json', reason: 'this parameter is a free-form map' }
  }

  // Rows 14/15 — anyOf/oneOf. Exactly one non-null branch is a nullable
  // wrapper (unwrap it, K3) — the wrapper's own hints (`hints`, read above,
  // already merged with whatever THIS call itself inherited) are passed as
  // `inheritedHints` into the recursive call, so the branch's own hints
  // (read fresh inside that call) can win key by key over them (96.3: see
  // the module doc comment's "Hints on a nullable wrapper" section).
  // Without this, `z.toJSONSchema` lands `.meta()` chained after
  // `.nullable()` on THIS node, never on either branch, and rows 3-13 above
  // never match a bare `anyOf` wrapper on any hint — every one of them
  // would be silently lost, not just `kind`. More than one real branch is a
  // genuine conditional shape this plan does not attempt to flatten (closes
  // F20 — a labelled reason instead of a bare, unexplained textarea).
  const branches = unionBranches(node)
  if (branches) {
    const real = branches.filter((b) => baseType(deref(b, ctx.root)) !== 'null')
    if (real.length === 1) {
      return planField(real[0]!, ctx, hints)
    }
    return { control: 'json', reason: 'this parameter can take several different shapes' }
  }

  // Row 16 — a RESULT, not an error: unreachable by failure, reached only
  // when an author writes a shape none of the rows above name.
  return { control: 'json', reason: "this parameter's type is not one the form can draw" }
}

function planObjectChildren(node: JsonSchemaNode, ctx: PlanContext): PlannedField[] {
  const properties = isRecord(node.properties) ? (node.properties as Record<string, JsonSchemaNode>) : {}
  const required = new Set(Array.isArray(node.required) ? (node.required as string[]) : [])
  return Object.entries(properties).map(([key, child]) => planPlannedField(key, child, required.has(key), ctx))
}

function planPlannedField(key: string, child: JsonSchemaNode, required: boolean, ctx: PlanContext): PlannedField {
  const resolved = deref(child, ctx.root)
  const hints = readHints(resolved)
  return {
    path: key,
    label: labelFor(child, ctx.root, key),
    help: typeof resolved.description === 'string' ? resolved.description : undefined,
    group: hints.group,
    advanced: hints.advanced ?? false,
    required,
    showWhen: hints.showWhen,
    plan: planField(child, ctx),
  }
}

/**
 * The whole form: declaration order preserved (H2 — `Object.entries` walks
 * a JS object in insertion order, and `z.toJSONSchema` emits `properties`
 * in declaration order, so no ordering key is needed at all), defaults
 * seeded separately (K2 — `applyDefaults`, run once against the current
 * value before first paint; this function does not take a value, so it has
 * none to seed). Consecutive-run grouping into visible sections is a
 * presentation step layered on top of this flat, ordered, per-field `group`
 * (plan 95 §3.5, §5 step 95.4) — deliberately not done here, so that step
 * stays a pure reduction over what this one already guarantees.
 *
 * One call per schema; the caller (a future `SchemaForm`) is expected to
 * memoise it on the schema's identity, never recompute it per keystroke.
 */
export function planForm(schema: JsonSchemaNode): PlannedField[] {
  return planObjectChildren(schema, { root: schema, depth: 1, seen: new Set() })
}

/** One section of a rendered form: a run of fields sharing a heading, or —
 *  when `heading` is `undefined` — a run of fields declaring no `group` at
 *  all, rendered with no heading (plan 95 §3.5). */
export interface FormSection {
  heading?: string
  fields: PlannedField[]
}

/**
 * Groups an already-planned, already-ordered field list into sections — a
 * pure reduction over `planForm`'s own output, exactly as that function's
 * doc comment promises (plan 95 §3.5, §5 step 95.4). A section is a MAXIMAL
 * CONSECUTIVE RUN of fields sharing the same `PlannedField.group` (`readHints`
 * already put that value there while planning each field — this function
 * only regroups, it never re-reads a schema node). `undefined` is its own
 * group value like any other: a run of ungrouped fields renders with no
 * heading, exactly where they fall in declaration order — commonly first,
 * because that is where an author who has not assigned a group yet tends to
 * write them, but never MOVED there by this function.
 *
 * This is the same "consecutive run" reduction `groupByPlugin`
 * (`RunScriptDialog.tsx`) and `SectionNav`'s own grouped headings already
 * use, so a field with no group repeated later in the same object forms a
 * SECOND, separate ungrouped run rather than merging with the first — "A, A,
 * B, A" is three sections, not two (§3.5): the legible reading of the
 * author's own declaration order, never a reordering to make headings tidier.
 *
 * Purely additive: a schema where no field declares `group` produces exactly
 * one section with `heading: undefined` holding every field, which a caller
 * renders identically to today's flat list — the same "byte-identical when
 * nothing opts in" property `SectionNav`'s own grouping already keeps.
 */
export function sectionFields(fields: PlannedField[]): FormSection[] {
  const sections: FormSection[] = []
  for (const field of fields) {
    const last = sections[sections.length - 1]
    if (last && last.heading === field.group) {
      last.fields.push(field)
    } else {
      sections.push({ heading: field.group, fields: [field] })
    }
  }
  return sections
}
