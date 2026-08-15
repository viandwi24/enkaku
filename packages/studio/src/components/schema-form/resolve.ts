import { SCHEMA_LIMITS } from '@enkaku/protocol'
import type { FieldKind, JsonSchemaNode } from './types'

/**
 * Resolve a local `$ref` (`#/$defs/Name`, or `#` for the whole document)
 * against the root schema, following a chain of `$ref`s to its end.
 *
 * `seen` guards against a `$ref` chain that points back at something
 * already on the current path (plan 95 §3.8 R1, F21) — e.g. two `$defs`
 * entries that `$ref` each other with no object in between, which would
 * otherwise recurse forever inside this one call. Such a schema is
 * representable (`z.lazy`), so this is a reachable failure, not a
 * theoretical one: today it hangs the tab. On a cycle this returns the
 * unresolved `$ref` node itself — safe (callers already treat "still has a
 * `$ref`" as "give up gracefully"), never a throw.
 */
export function deref(node: JsonSchemaNode, root: JsonSchemaNode, seen: ReadonlySet<string> = new Set()): JsonSchemaNode {
  if (!node.$ref) return node
  if (seen.has(node.$ref)) return node
  const path = node.$ref.replace(/^#\/?/, '').split('/').filter(Boolean)
  let cur: unknown = root
  for (const seg of path) {
    cur = (cur as Record<string, unknown> | undefined)?.[seg]
    if (cur === undefined) return node
  }
  return deref(cur as JsonSchemaNode, root, new Set(seen).add(node.$ref))
}

const typeOf = (node: JsonSchemaNode): string | undefined =>
  Array.isArray(node.type) ? node.type.find((t) => t !== 'null') : node.type

export function getNodeKind(node: JsonSchemaNode, root: JsonSchemaNode): FieldKind {
  const n = deref(node, root)
  if (n.enum && n.enum.length > 0) return 'enum'
  // Tuple [min, max] renders as a single range field.
  if (n.prefixItems?.length === 2 && n.prefixItems.every((p) => typeOf(deref(p, root)) === 'number')) {
    return 'range-tuple'
  }
  const t = typeOf(n)
  if (t === 'object' || (n.properties && Object.keys(n.properties).length > 0)) return 'object'
  if (t === 'array') return 'array'
  if (t === 'string') return 'string'
  if (t === 'number' || t === 'integer') return 'number'
  if (t === 'boolean') return 'boolean'
  if (n.anyOf) {
    const first = n.anyOf.map((a) => deref(a, root)).find((a) => typeOf(a) !== 'null')
    if (first) return getNodeKind(first, root)
  }
  return 'unsupported'
}

/**
 * Recursively fill in the schema's `default` wherever the value is
 * undefined. `depth` is bounded by `SCHEMA_LIMITS.maxDepth` (plan 95 §3.8
 * R1, F21): a self-referential object schema (`z.lazy`) has no `$ref` node
 * that this function itself would trip on, but its OWN recursion into
 * `n.properties` never terminates without a cap — this is the second half
 * of the same defect `deref`'s visited set closes. Past the cap, whatever
 * value is already there is kept as-is rather than descended into further.
 */
export function applyDefaults(node: JsonSchemaNode, value: unknown, root: JsonSchemaNode, depth = 0): unknown {
  if (depth > SCHEMA_LIMITS.maxDepth) return value
  const n = deref(node, root)
  if (value === undefined) {
    if (n.default !== undefined) return structuredClone(n.default)
    if (getNodeKind(n, root) !== 'object') return undefined
  }
  if (getNodeKind(n, root) === 'object' && n.properties) {
    const base = (typeof value === 'object' && value !== null ? { ...(value as object) } : {}) as Record<string, unknown>
    for (const [key, child] of Object.entries(n.properties)) {
      if (UNSAFE_KEYS.has(key)) continue
      const filled = applyDefaults(child, base[key], root, depth + 1)
      if (filled !== undefined) base[key] = filled
    }
    return base
  }
  return value
}

/**
 * Property names that must never be written through a computed key.
 *
 * A parameter schema is untrusted input: a shared script's author picks every
 * field name in it. `obj['__proto__'] = x` does not create an own property —
 * it reaches `Object.prototype`'s inherited setter and replaces *that object's*
 * prototype with attacker-chosen data. It is not global pollution (a fresh `{}`
 * elsewhere is unaffected, verified), but the params object being edited ends
 * up with a prototype the schema author controls, which is enough to make
 * `getAtPath` and every downstream reader answer with values nobody stored.
 *
 * `checkDeclaredSchema` now refuses these names at publish (plan 95 §4.9), so a
 * schema carrying one cannot be added today. This guard exists for the schemas
 * already in the database, which were never offered to that gate — the same
 * "reject at publish, clamp at render" split the rest of §3.7 uses.
 */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

/** `tapJitterMs` → "Tap Jitter Ms". */
export function humanize(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[-_]+/g, ' ')
    .replace(/^./, (c) => c.toUpperCase())
}

export function getAtPath(obj: unknown, path: string): unknown {
  if (path === '') return obj
  let cur: unknown = obj
  for (const seg of path.split('.')) {
    if (typeof cur !== 'object' || cur === null) return undefined
    cur = (cur as Record<string, unknown>)[seg]
  }
  return cur
}

export function setAtPath<T>(obj: T, path: string, value: unknown): T {
  if (path === '') return value as T
  const segs = path.split('.')
  // A field named `__proto__` cannot be written safely through a computed key,
  // and no legitimate parameter is called that — refuse the whole write rather
  // than half-applying it. See `UNSAFE_KEYS`.
  if (segs.some((seg) => UNSAFE_KEYS.has(seg))) return obj
  const clone = (typeof obj === 'object' && obj !== null ? { ...(obj as object) } : {}) as Record<string, unknown>
  let cur = clone
  for (let i = 0; i < segs.length - 1; i++) {
    const seg = segs[i]!
    const next = cur[seg]
    cur[seg] = typeof next === 'object' && next !== null ? { ...(next as object) } : {}
    cur = cur[seg] as Record<string, unknown>
  }
  const lastKey = segs[segs.length - 1]!
  // `JSON.stringify` drops an `undefined` property (F22) — assigning it
  // here would silently no-op a "clear this optional field" edit all the
  // way to the server. Deleting the key is the only way "cleared" actually
  // travels.
  if (value === undefined) {
    delete cur[lastKey]
  } else {
    cur[lastKey] = value
  }
  return clone as T
}
