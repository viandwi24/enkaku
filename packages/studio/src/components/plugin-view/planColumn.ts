import type { JsonSchemaNode as WireJsonSchemaNode } from '@enkaku/protocol'
import { formatFieldValue } from '@/lib/format'
import { planField, type FieldPlan } from '../schema-form/plan'
import type { JsonSchemaNode } from '../schema-form/types'

/**
 * Plan 108 §3.3, §4.2, §5 step 108.7 — one table CELL, planned.
 *
 * This is an **adapter, not a resolver**. It defines no field types of its
 * own, reads no `x-enkaku` key itself, and makes no structural decision:
 * every one of those comes from `planField` (`../schema-form/plan.ts`), the
 * single resolver `docs/design.md`'s one-resolver rule names, called here
 * exactly as `planResult` calls it. The only thing this file adds is the two
 * facts a table cell has that a form field does not — the value already
 * exists, and there is one line of space to put it in.
 *
 * ## The three rules
 *
 * | # | Case | What happens |
 * |---|---|---|
 * | C1 | The column declares a `schema` | `planField` plans it; the cell renders that plan against the value |
 * | C2 | The column declares **no** `schema` (plan §4.2: "Absent = plain text") | no plan at all — the value renders through the SAME formatter, as `kind: 'plain'` |
 * | C3 | The value's shape does not match its declared plan | the raw JSON, flagged `raw` — never blank, never dropped |
 *
 * C3 is `planResult`'s R3 discipline applied one level down: *"a row failing
 * its column schema renders raw rather than disappearing"* (plan 108 §8's own
 * risk row). A column declared `{ type: 'boolean' }` over a value that turns
 * out to be `{ ok: true }` is a plugin whose stored shape has drifted from
 * what it declared — the operator needs to SEE that, and an empty cell is the
 * one rendering that hides it.
 *
 * Pure, total and DOM-free, like both of its neighbours: `planColumn.test.ts`
 * imports no React and no `@testing-library`. The only impurity anywhere near
 * it is the clock `formatFieldValue` reads for `kind: 'timestamp'`, which is
 * why `now` is a parameter rather than a `Date.now()` buried in a branch.
 */

/** What a cell renders. `plan` is `null` for C2 — a bare column has no plan
 *  because nothing was declared to plan, which is a different fact from
 *  "planned, and the plan was the `json` escape hatch". */
export interface PlannedColumn {
  /** Straight from `planField`; `null` when the column declared no schema (C2). */
  plan: FieldPlan | null
  /** The text to draw. Never empty — an absent value reads `'—'`. */
  text: string
  /** C3 — the value did not fit its declared plan, so `text` is raw JSON. */
  raw: boolean
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** The C3 fallback, and the `list`/`table`/`group`/`json` terminal. Total:
 *  a circular or unserialisable value still produces text. */
function jsonText(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

function raw(plan: FieldPlan | null, value: unknown): PlannedColumn {
  return { plan, text: jsonText(value), raw: true }
}

function text(plan: FieldPlan | null, value: string): PlannedColumn {
  return { plan, text: value, raw: false }
}

/**
 * C2 — no declared schema. `plain` is `NumberKind`'s own "nothing more
 * specific was said" member, so a bare number still reads through
 * `formatFieldValue` rather than through a second `String(n)` that could
 * one day disagree with it. A string is its own text; a boolean reads the
 * same `Yes`/`No` a planned `toggle` reads, so two columns over the same
 * fact do not word it differently depending on whether one of them was
 * annotated.
 */
function planBare(value: unknown, now: number): PlannedColumn {
  if (typeof value === 'string') return text(null, value.length > 0 ? value : '—')
  if (typeof value === 'boolean') return text(null, value ? 'Yes' : 'No')
  if (typeof value === 'number') return text(null, formatFieldValue('plain', undefined, value, now))
  return raw(null, value)
}

/**
 * C1/C3 — the value, rendered against the plan `planField` produced for it.
 * One branch per `FieldPlan` control, each answering the same question: is
 * this value the shape the plan expects? If yes, the plan's own rendering; if
 * no, C3.
 */
function planAgainst(plan: FieldPlan, value: unknown, now: number): PlannedColumn {
  switch (plan.control) {
    case 'toggle':
      return typeof value === 'boolean' ? text(plan, value ? 'Yes' : 'No') : raw(plan, value)

    case 'choice': {
      // A scalar outside the declared enum is NOT C3: it is legible as
      // itself, and the raw JSON of a bare string would only add quotes. A
      // non-scalar is, because an object was never a member of any enum.
      if (typeof value === 'object' && value !== null) return raw(plan, value)
      const match = plan.options.find((option) => option.value === String(value))
      return text(plan, match ? match.label : String(value))
    }

    case 'number':
      return typeof value === 'number' && Number.isFinite(value) ? text(plan, formatFieldValue(plan.kind, plan.unit, value, now)) : raw(plan, value)

    case 'pair':
      return Array.isArray(value) && value.length === 2 && value.every((half) => typeof half === 'number')
        ? text(plan, formatFieldValue(plan.item.kind, plan.item.unit, value, now))
        : raw(plan, value)

    case 'text':
    // A workspace path is a string that reads as itself in one line — the
    // same case as `text`, never the quoted JSON of the fallback below.
    case 'workspacePath':
      return typeof value === 'string' ? text(plan, value.length > 0 ? value : '—') : raw(plan, value)

    // `list`, `table`, `group` and `json` are all shapes `planField` plans as
    // a BLOCK — a nested editor, a row editor, a card, a labelled escape
    // hatch. None of the four fits one line of a table, so all four render as
    // their raw JSON, which is exactly what `ResultView.renderCell` already
    // does for the same four inside a nested table.
    default:
      return raw(plan, value)
  }
}

/**
 * `planColumn(schema, value, now?)` — the whole cell.
 *
 * `schema` is the column's own optional `JsonSchemaNodeSchema` from the
 * verified surface (`ViewSpec.table.columns[].schema`); `value` is whatever
 * the row actually holds at that column's `field` path, already extracted by
 * the caller (`ViewRenderer` knows about `$device`/`$entry`; this file does
 * not, and must not — a context lookup is a row-shape concern, not a
 * rendering one).
 */
export function planColumn(schema: WireJsonSchemaNode | undefined, value: unknown, now: number = Date.now()): PlannedColumn {
  // `@enkaku/protocol`'s `JsonSchemaNode` is a bare index signature and this
  // package's own is the narrower, keyword-aware twin — the SAME
  // reconciliation `JobResultSection` and `RunScriptDialog` already document
  // at their own boundary, done once here so no call site has to. `planField`
  // is total over anything, so a node that does not fit the narrower shape
  // lands on its `json` terminal rather than misbehaving.
  const node = schema !== undefined && isPlainObject(schema) ? (schema as JsonSchemaNode) : undefined
  const plan = node ? planField(node, { root: node, depth: 1, seen: new Set() }) : null

  // An absent value is absent under every plan — a device that has never
  // synced, a key the entry does not carry. `'—'` before any rendering, so
  // the C3 flag is never raised for a row that is simply empty.
  if (value === undefined || value === null) return { plan, text: '—', raw: false }

  // The column's schema IS the root for its own `$ref`s — a column node is
  // handed to Studio whole, detached from whatever document it was authored
  // in, exactly as `planResult` treats a result schema.
  return plan === null ? planBare(value, now) : planAgainst(plan, value, now)
}
