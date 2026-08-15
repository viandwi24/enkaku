import type { JsonSchemaNode } from '../api/json-schema'
import { SCHEMA_LIMITS } from './limits'
import type { SchemaCheckFinding } from './limits'
import { ENKAKU_META_KEY } from './vocabulary'

/**
 * Render-side defence for a `paramsSchema` ALREADY IN THE DATABASE from
 * before `checkDeclaredSchema` existed — or one that reached storage through
 * some other path entirely (plan 95 §3.8, §5 step 95.5): *"reject at
 * publish, clamp at render — a hostile schema is refused when someone tries
 * to publish it. But schemas are already in the database, so the renderer
 * must also survive one it never got to refuse: truncate, stop at the depth
 * cap, and show one line at the top of the form naming what was clamped —
 * silently rendering a mangled form is worse than saying so."*
 *
 * Deliberately narrower than `checkDeclaredSchema`'s own walk, and
 * complementary to it rather than a duplicate:
 *
 * - `$ref` cycles and excess depth are already handled, SAFELY, by the
 *   resolver itself (`packages/studio/src/components/schema-form/plan.ts`
 *   row 1's visited set and row 2's depth cap, added in plan 95 step 95.2 —
 *   verified by this package's own `clamp.test.ts` rather than assumed).
 *   Re-implementing that here would only be a second copy of a defence that
 *   already exists and is already tested; a `$ref` node is passed through
 *   untouched.
 * - What the resolver does NOT bound on its own is string length (a
 *   50 000-character description flows straight into a `PlannedField`'s
 *   `help` text) and total field/enum count (`Object.entries(properties)`
 *   and a `choice` control's `options` are both unbounded) — THOSE are what
 *   this function clamps, because nothing else in the render path does.
 *
 * Pure and total: never throws, and a schema so malformed it is not even a
 * plain object degrades to an empty (zero-field) schema rather than being
 * passed through — the SAME "totality" property `plan.ts`'s `planField`
 * documents for itself.
 */
export interface ClampedSchema {
  schema: JsonSchemaNode
  /** What was truncated or dropped, in traversal order — never empty AND
   *  silent: a caller with a non-empty `clamped` must say so (§3.8's "show
   *  one line at the top of the form naming what was clamped"). Reuses
   *  `SchemaCheckFinding`'s shape so `summarizeClamp` below and any UI that
   *  already knows how to read a `checkDeclaredSchema` finding can read this
   *  too, without a second type. */
  clamped: SchemaCheckFinding[]
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value
}

function joinPath(path: string, key: string): string {
  return path ? `${path}.${key}` : key
}

/**
 * Clamps a params schema to `SCHEMA_LIMITS` for safe rendering, regardless
 * of whether it would have passed `checkDeclaredSchema` at publish. Depth
 * starts at 0 for the root, matching `checkDeclaredSchema`'s own convention
 * (kept consistent WITHIN this package; `plan.ts`'s renderer starts at 1
 * for its own, unrelated reason — the two do not need to agree with each
 * other, only each with its own tests).
 */
export function clampSchema(schemaIn: unknown): ClampedSchema {
  if (!isPlainObject(schemaIn)) {
    // Not a shape the renderer can use at all. An empty object plans to a
    // form with nothing in it (harmless) rather than throwing — totality
    // over "this should never happen in practice."
    return { schema: {}, clamped: [] }
  }

  const clamped: SchemaCheckFinding[] = []
  let fieldBudget = SCHEMA_LIMITS.maxFields
  let droppedFields = 0
  let droppedBranches = 0

  function clampNode(node: unknown, path: string, depth: number): JsonSchemaNode {
    if (!isPlainObject(node)) return {}

    // `$ref` is passed through untouched — see the module doc: the
    // resolver's own visited set and depth cap (plan 95 step 95.2) already
    // make this safe to render, and this function has no independent way
    // to resolve a `$ref` against `$defs` that would be worth duplicating
    // here (`checkDeclaredSchema` does, but that is a REPORT-only walk; this
    // one rebuilds the tree, which a naive `$ref` rewrite could easily get
    // subtly wrong in a way that changes what actually renders).
    if (typeof node.$ref === 'string') return node as JsonSchemaNode

    if (depth > SCHEMA_LIMITS.maxDepth) {
      droppedBranches++
      // A typed leaf, not a dropped key — the PARENT's `properties` loop
      // below still lists this field (so the operator sees it exists and
      // why it is unusable), it just cannot be edited past this point.
      return { type: 'string', title: typeof node.title === 'string' ? node.title : undefined, description: 'too deeply nested to render', readOnly: true }
    }

    const out: Record<string, unknown> = { ...node }

    if (typeof out.title === 'string' && out.title.length > SCHEMA_LIMITS.maxTitleChars) {
      out.title = truncate(out.title, SCHEMA_LIMITS.maxTitleChars)
      clamped.push({ path, limit: 'maxTitleChars', message: 'title was shortened' })
    }
    if (typeof out.description === 'string' && out.description.length > SCHEMA_LIMITS.maxDescriptionChars) {
      out.description = truncate(out.description, SCHEMA_LIMITS.maxDescriptionChars)
      clamped.push({ path, limit: 'maxDescriptionChars', message: 'description was shortened' })
    }
    if (Array.isArray(out.enum) && out.enum.length > SCHEMA_LIMITS.maxEnumMembers) {
      out.enum = out.enum.slice(0, SCHEMA_LIMITS.maxEnumMembers)
      clamped.push({ path, limit: 'maxEnumMembers', message: `choice list was shortened to ${SCHEMA_LIMITS.maxEnumMembers} options` })
    }

    const hints = out[ENKAKU_META_KEY]
    if (isPlainObject(hints)) {
      const nextHints: Record<string, unknown> = { ...hints }
      if (typeof nextHints.group === 'string' && nextHints.group.length > SCHEMA_LIMITS.maxGroupChars) {
        nextHints.group = truncate(nextHints.group, SCHEMA_LIMITS.maxGroupChars)
        clamped.push({ path, limit: 'maxGroupChars', message: 'section name was shortened' })
      }
      if (isPlainObject(nextHints.labels)) {
        const labels: Record<string, unknown> = {}
        let anyLabelTruncated = false
        for (const [k, v] of Object.entries(nextHints.labels)) {
          if (typeof v === 'string' && v.length > SCHEMA_LIMITS.maxLabelChars) {
            labels[k] = truncate(v, SCHEMA_LIMITS.maxLabelChars)
            anyLabelTruncated = true
          } else {
            labels[k] = v
          }
        }
        nextHints.labels = labels
        if (anyLabelTruncated) clamped.push({ path, limit: 'maxLabelChars', message: 'one or more option labels were shortened' })
      }
      out[ENKAKU_META_KEY] = nextHints
    }

    if (isPlainObject(out.properties)) {
      const nextProps: Record<string, unknown> = {}
      for (const [key, child] of Object.entries(out.properties)) {
        if (fieldBudget <= 0) {
          droppedFields++
          continue
        }
        fieldBudget--
        nextProps[key] = clampNode(child, joinPath(path, key), depth + 1)
      }
      out.properties = nextProps
      // A dropped field must not still be listed as `required` — an
      // operator can never satisfy a required field that was removed from
      // `properties` (F22-adjacent: a half-clamped schema must still be
      // internally consistent, never a form that cannot possibly submit).
      if (Array.isArray(out.required)) {
        out.required = (out.required as unknown[]).filter((k) => typeof k === 'string' && k in nextProps)
      }
    }
    if (Array.isArray(out.items)) {
      out.items = out.items.map((item, i) => clampNode(item, `${path}[${i}]`, depth + 1))
    } else if (out.items !== undefined) {
      out.items = clampNode(out.items, `${path}[]`, depth + 1)
    }
    if (Array.isArray(out.prefixItems)) {
      out.prefixItems = out.prefixItems.map((item, i) => clampNode(item, `${path}[${i}]`, depth + 1))
    }
    if (Array.isArray(out.anyOf)) {
      out.anyOf = out.anyOf.map((item, i) => clampNode(item, `${path}<${i}>`, depth + 1))
    }
    if (Array.isArray(out.oneOf)) {
      out.oneOf = out.oneOf.map((item, i) => clampNode(item, `${path}<${i}>`, depth + 1))
    }

    return out as JsonSchemaNode
  }

  const schema = clampNode(schemaIn, '', 0)
  if (droppedFields > 0) {
    clamped.push({
      path: '',
      limit: 'maxFields',
      message: `${droppedFields} field${droppedFields === 1 ? '' : 's'} were removed to stay under the ${SCHEMA_LIMITS.maxFields}-field limit`,
    })
  }
  if (droppedBranches > 0) {
    clamped.push({
      path: '',
      limit: 'maxDepth',
      message: `${droppedBranches} section${droppedBranches === 1 ? '' : 's'} were stopped past the ${SCHEMA_LIMITS.maxDepth}-level depth limit`,
    })
  }
  return { schema, clamped }
}

/** Labels for `summarizeClamp` — plain language, not the internal `limit` key. */
const CLAMP_LABELS: Partial<Record<SchemaCheckFinding['limit'], string>> = {
  maxTitleChars: 'title(s) shortened',
  maxDescriptionChars: 'description(s) shortened',
  maxEnumMembers: 'choice list(s) shortened',
  maxGroupChars: 'section name(s) shortened',
  maxLabelChars: 'option label(s) shortened',
  maxFields: 'field(s) removed',
  maxDepth: 'section(s) stopped for depth',
}

/**
 * The ONE line `RunScriptDialog`/`ScheduleEditorDialog` shows at the top of
 * a clamped form (plan 95 §3.8: "silently rendering a mangled form is worse
 * than saying so"). `null` when nothing was clamped — the common case, and
 * every script published through `checkDeclaredSchema` from now on.
 */
export function summarizeClamp(findings: SchemaCheckFinding[]): string | null {
  if (findings.length === 0) return null
  const counts = new Map<string, number>()
  for (const f of findings) {
    const label = CLAMP_LABELS[f.limit] ?? `${f.limit} adjusted`
    counts.set(label, (counts.get(label) ?? 0) + 1)
  }
  const parts = [...counts.entries()].map(([label, n]) => `${n} ${label}`)
  return `This form was adjusted to stay usable: ${parts.join(', ')}.`
}
