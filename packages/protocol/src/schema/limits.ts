import type { JsonSchemaNode } from '../api/json-schema'
import { ENKAKU_META_KEY, ParamHintsSchema, readHints } from './vocabulary'

/**
 * Written limits on an untrusted params schema (plan 95 §3.8, §4.2). A
 * shared script's schema is author-controlled input rendered in the
 * operator's browser and stored in the operator's database — these bound
 * the size, depth, and field count of what a hostile or careless author can
 * publish, so no path (publish, or a schema already stored before this
 * plan) can hang a tab or the core.
 */
export const SCHEMA_LIMITS = {
  /** Serialised bytes. A 50-field schema with 200-character descriptions
   *  measures ~12.5 KB, so this is ~5x a generous real schema. */
  maxSchemaBytes: 64 * 1024,
  /** Device settings' deepest real nesting is 3 (`job.retry.backoffBaseMs`). */
  maxDepth: 5,
  maxFields: 200,
  maxEnumMembers: 200,
  maxTitleChars: 80,
  maxDescriptionChars: 300,
  maxLabelChars: 60,
  maxGroupChars: 40,
  /** Field names must be identifier-shaped — this is what makes declaration
   *  order a guarantee rather than an observation (plan 95 §3.5). */
  fieldNamePattern: /^[A-Za-z_][A-Za-z0-9_]*$/,
} as const

/**
 * Field names that ARE identifier-shaped (they pass `fieldNamePattern`
 * above) but are dangerous anyway, because a params schema is parsed JSON
 * and these are own-property names JavaScript treats specially — `target[k]
 * = v` on any of them can silently repoint an object's prototype instead of
 * setting a plain property (plan 95 §5 step 95.5's hostile fixture set, R5
 * territory: prototype pollution is a field-count-explosion cousin, not a
 * new category of harm, but it needs its own denylist since the identifier
 * regex alone cannot see it).
 *
 * Exported (plan 97 §3.8, V3) so `@enkaku/session`'s `child-entry.ts` can
 * apply the SAME set to a result VALUE, not just a schema's field names —
 * the identical hazard, one level down: a script's return value is JSON
 * that gets walked by `planResult` and by any consumer (plan 99's `{from:
 * …}` bindings included), so a `__proto__`/`constructor`/`prototype` key at
 * any depth is refused there too, using this exact set rather than a second
 * one that could drift from it.
 */
export const DANGEROUS_FIELD_NAMES = new Set(['__proto__', 'constructor', 'prototype'])

/**
 * A safety valve for the WALK itself, independent of `maxFields` (R5): a
 * schema can stay under 64 KiB and still explode combinatorially once `$ref`
 * reuse is expanded — e.g. five `$defs` entries, each with 50 sibling
 * properties that all `$ref` the next one, is ~2 KB of JSON but 50^5 node
 * visits. `maxFields` only catches this AFTER the walk finishes; this caps
 * the walk itself so `checkDeclaredSchema` cannot be made to hang by the very
 * schema it exists to refuse. Generous relative to `maxFields` (200) so no
 * honest schema — even a maximally wide, maximally deep one — ever reaches
 * it; an attacker aiming for reuse-amplification trips it almost instantly.
 */
const MAX_WALK_VISITS = 20_000

export interface SchemaCheckFinding {
  path: string
  /**
   * `'group'` findings are WARNINGS, not rejections (plan 95 §3.5: "95.5's
   * publish check WARNS about the non-consecutive repeat so the author can
   * reorder or accept it") — a caller deciding whether to refuse a publish
   * must filter them out first. Every other `limit` value blocks publish.
   */
  limit: keyof typeof SCHEMA_LIMITS | 'hints' | 'showWhen' | 'group' | '$ref' | 'pattern'
  message: string
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function joinPath(path: string, key: string): string {
  return path ? `${path}.${key}` : key
}

/** Resolves ONE `$ref` hop (`#`, or `#/a/b/...`) against `root` — the same
 *  general-path resolution `plan.ts`'s `resolveRef` uses (duplicated rather
 *  than shared: `@enkaku/protocol` cannot import from `packages/studio`,
 *  plan 95 §3.1's package-graph boundary runs the other way). Chain-following
 *  and cycle detection are the CALLER's job. */
function resolveRef(root: Record<string, unknown>, ref: string): unknown {
  if (ref === '#') return root
  const segments = ref.replace(/^#\/?/, '').split('/').filter(Boolean)
  let cur: unknown = root
  for (const segment of segments) {
    if (!isPlainObject(cur)) return undefined
    cur = cur[segment]
  }
  return cur
}

/**
 * Checks one node's own `title`/`description`/`enum`/`pattern` against their
 * limits, and its `x-enkaku` hints against `ParamHintsSchema` plus the
 * per-hint character limits — pushing any finding onto `findings`. Does not
 * recurse; callers own traversal so they can pass the right `path` and
 * sibling set.
 */
function checkNode(node: Record<string, unknown>, path: string, findings: SchemaCheckFinding[], siblingKeys?: ReadonlySet<string>): void {
  if (typeof node.title === 'string' && node.title.length > SCHEMA_LIMITS.maxTitleChars) {
    findings.push({
      path,
      limit: 'maxTitleChars',
      message: `title is ${node.title.length} characters, over the ${SCHEMA_LIMITS.maxTitleChars}-character limit`,
    })
  }
  if (typeof node.description === 'string' && node.description.length > SCHEMA_LIMITS.maxDescriptionChars) {
    findings.push({
      path,
      limit: 'maxDescriptionChars',
      message: `description is ${node.description.length} characters, over the ${SCHEMA_LIMITS.maxDescriptionChars}-character limit`,
    })
  }
  if (Array.isArray(node.enum) && node.enum.length > SCHEMA_LIMITS.maxEnumMembers) {
    findings.push({
      path,
      limit: 'maxEnumMembers',
      message: `${node.enum.length} enum members, over the ${SCHEMA_LIMITS.maxEnumMembers}-member limit`,
    })
  }
  // No author-supplied regular expression is EVER compiled or evaluated, in
  // the browser or in the core (plan 95 §3.8, R2) — not "not evaluated
  // safely", not evaluated at all. Rather than store a `pattern` nobody
  // will ever honour (a landmine for a future change to pick back up),
  // publish refuses it outright and the SDK guide points authors at a
  // semantic `kind`, `format`, or a length bound instead. A schema already
  // stored before this rule existed still renders it as help text
  // (`validate.ts`'s own doc comment) — this is the publish-time half only.
  if (typeof node.pattern === 'string') {
    findings.push({
      path,
      limit: 'pattern',
      message: 'pattern is never evaluated (no author-supplied regular expression is ever compiled, in the browser or the core) — use a semantic kind, format, or a length bound instead',
    })
  }

  const raw = node[ENKAKU_META_KEY]
  if (raw === undefined) return
  if (!isPlainObject(raw)) {
    findings.push({ path, limit: 'hints', message: `'${ENKAKU_META_KEY}' must be an object` })
    return
  }
  const parsed = ParamHintsSchema.safeParse(raw)
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      findings.push({ path, limit: 'hints', message: issue.message })
    }
    return
  }
  const hints = parsed.data
  if (hints.group !== undefined && hints.group.length > SCHEMA_LIMITS.maxGroupChars) {
    findings.push({
      path,
      limit: 'maxGroupChars',
      message: `group name is ${hints.group.length} characters, over the ${SCHEMA_LIMITS.maxGroupChars}-character limit`,
    })
  }
  if (hints.labels) {
    for (const [member, label] of Object.entries(hints.labels)) {
      if (label.length > SCHEMA_LIMITS.maxLabelChars) {
        findings.push({
          path,
          limit: 'maxLabelChars',
          message: `label for "${member}" is ${label.length} characters, over the ${SCHEMA_LIMITS.maxLabelChars}-character limit`,
        })
      }
    }
  }
  if (hints.showWhen && siblingKeys && !siblingKeys.has(hints.showWhen.field)) {
    findings.push({
      path,
      limit: 'showWhen',
      message: `showWhen refers to "${hints.showWhen.field}", which is not a sibling field`,
    })
  }
}

/**
 * The non-consecutive-`group` warning (plan 95 §3.5, §5 step 95.5): a
 * section is a maximal RUN of adjacent fields sharing a `group`. `A, A, B,
 * A` is legible (three sections) but is almost certainly not what the
 * author meant, so publish warns about the interrupted repeat — it does
 * NOT refuse the publish (`limit: 'group'` is filtered out by every caller
 * that decides pass/fail; see `SchemaCheckFinding`'s doc comment). Reads
 * `x-enkaku.group` through `readHints`, which degrades a malformed or
 * future-vocabulary hint to `{}` rather than throwing — this warning is
 * best-effort, not the enforcement point (`checkNode` above already flags a
 * genuinely malformed hint on its own).
 */
function checkGroupOrder(properties: Record<string, unknown>, keys: string[], path: string, findings: SchemaCheckFinding[]): void {
  const seenGroups = new Set<string>()
  let lastGroup: string | undefined
  for (const key of keys) {
    const child = properties[key]
    const group = isPlainObject(child) ? readHints(child as JsonSchemaNode).group : undefined
    if (group === undefined) {
      lastGroup = undefined
      continue
    }
    if (group !== lastGroup) {
      if (seenGroups.has(group)) {
        findings.push({
          path: joinPath(path, key),
          limit: 'group',
          message: `group "${group}" is not consecutive — it already appeared earlier and is interrupted by a different group, so it will render as two separate sections`,
        })
      }
      seenGroups.add(group)
      lastGroup = group
    }
  }
}

/**
 * Publish-time gate (plan 95 §3.8, §4.2). Returns every finding, not the
 * first — an author fixing a schema should get one list, not one error per
 * round trip. `null`/`undefined` (no params schema at all) finds nothing.
 *
 * Follows `$ref` against the schema's own `$defs` (unlike 95.1's first cut,
 * which never looked at `$ref`/`$defs` at all) with a PATH-SENSITIVE visited
 * set — R1: a self-referential or mutually-referential `$ref` chain is
 * refused, naming the cycle, while a `$ref` reused in two unrelated places
 * (legitimate — the same reason `deref`'s visited set in the resolver is
 * per-branch, not global) is not falsely flagged. `MAX_WALK_VISITS` bounds
 * the walk itself so a non-cyclic but combinatorially-reused `$ref` cannot
 * make this FUNCTION hang while it is trying to refuse the schema that
 * would have hung the renderer.
 */
export function checkDeclaredSchema(schema: unknown): SchemaCheckFinding[] {
  if (schema === null || schema === undefined) return []

  const findings: SchemaCheckFinding[] = []

  let serialized: string | undefined
  try {
    serialized = JSON.stringify(schema)
  } catch {
    findings.push({ path: '', limit: 'maxSchemaBytes', message: 'schema is not serialisable to JSON' })
  }
  if (serialized !== undefined) {
    const bytes = byteLength(serialized)
    if (bytes > SCHEMA_LIMITS.maxSchemaBytes) {
      findings.push({
        path: '',
        limit: 'maxSchemaBytes',
        message: `schema is ${bytes} bytes, over the ${SCHEMA_LIMITS.maxSchemaBytes}-byte limit`,
      })
    }
  }

  if (!isPlainObject(schema)) {
    findings.push({ path: '', limit: 'maxFields', message: 'schema must be a JSON Schema object' })
    return findings
  }
  // Re-bound to a plain local so `resolveRef` inside the nested `walk`
  // below sees the narrowed type — TS does not carry a parameter's
  // narrowing into a nested function DECLARATION (as opposed to an inline
  // callback), since a hoisted declaration could in principle be called
  // before the narrowing runs.
  const root: Record<string, unknown> = schema

  let fieldCount = 0
  let visits = 0
  let walkBudgetExceeded = false

  // `siblingKeys` is the enclosing object's OWN property names — what a
  // `showWhen.field` on `node` is allowed to name. It comes from the
  // PARENT's `properties`, not `node`'s own (a node's children are never
  // its siblings). `refPath` is the set of `$ref` strings already followed
  // ON THIS BRANCH — per-branch, not global, so a `$ref` legitimately
  // reused in two unrelated places is never mistaken for a cycle.
  function walk(node: unknown, path: string, depth: number, siblingKeys: ReadonlySet<string> | undefined, refPath: ReadonlySet<string>): void {
    if (!isPlainObject(node)) return

    visits++
    if (visits > MAX_WALK_VISITS) {
      if (!walkBudgetExceeded) {
        walkBudgetExceeded = true
        findings.push({
          path,
          limit: '$ref',
          message: 'schema is too large to check safely once $ref reuse is expanded — simplify it or remove shared references',
        })
      }
      return
    }

    if (typeof node.$ref === 'string') {
      if (refPath.has(node.$ref)) {
        findings.push({ path, limit: '$ref', message: `schema contains a self-referential $ref cycle at "${node.$ref}"` })
        return
      }
      const resolved = resolveRef(root, node.$ref)
      if (resolved === undefined) return // an unresolvable $ref — nothing more can safely be checked
      const nextRefPath = new Set(refPath)
      nextRefPath.add(node.$ref)
      walk(resolved, path, depth, siblingKeys, nextRefPath)
      return
    }

    if (depth > SCHEMA_LIMITS.maxDepth) {
      findings.push({ path, limit: 'maxDepth', message: `nested past the ${SCHEMA_LIMITS.maxDepth}-level depth limit` })
      return
    }

    checkNode(node, path, findings, siblingKeys)

    const properties = isPlainObject(node.properties) ? (node.properties as Record<string, JsonSchemaNode>) : undefined
    if (properties) {
      const keys = Object.keys(properties)
      fieldCount += keys.length
      checkGroupOrder(properties, keys, path, findings)
      const keySet = new Set(keys)
      for (const key of keys) {
        if (DANGEROUS_FIELD_NAMES.has(key)) {
          findings.push({
            path: joinPath(path, key),
            limit: 'fieldNamePattern',
            message: `field name "${key}" is a reserved JavaScript property name and cannot be used as a parameter name (prototype-pollution risk)`,
          })
        } else if (!SCHEMA_LIMITS.fieldNamePattern.test(key)) {
          findings.push({
            path: joinPath(path, key),
            limit: 'fieldNamePattern',
            message: `field name "${key}" must match ${SCHEMA_LIMITS.fieldNamePattern} to keep declaration order a guarantee`,
          })
        }
        walk(properties[key], joinPath(path, key), depth + 1, keySet, refPath)
      }
    }

    if (Array.isArray(node.items)) {
      node.items.forEach((item, i) => walk(item, `${path}[${i}]`, depth + 1, undefined, refPath))
    } else if (node.items !== undefined) {
      walk(node.items, `${path}[]`, depth + 1, undefined, refPath)
    }
    if (Array.isArray(node.prefixItems)) {
      node.prefixItems.forEach((item, i) => walk(item, `${path}[${i}]`, depth + 1, undefined, refPath))
    }
  }

  walk(schema, '', 0, undefined, new Set())

  if (fieldCount > SCHEMA_LIMITS.maxFields) {
    findings.push({ path: '', limit: 'maxFields', message: `${fieldCount} fields, over the ${SCHEMA_LIMITS.maxFields}-field limit` })
  }

  return findings
}
