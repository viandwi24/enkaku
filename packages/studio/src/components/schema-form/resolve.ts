import type { FieldKind, JsonSchemaNode } from './types'

/** Resolve a local `$ref` (`#/$defs/Name`) against the root schema. */
export function deref(node: JsonSchemaNode, root: JsonSchemaNode): JsonSchemaNode {
  if (!node.$ref) return node
  const path = node.$ref.replace(/^#\//, '').split('/')
  let cur: unknown = root
  for (const seg of path) {
    cur = (cur as Record<string, unknown> | undefined)?.[seg]
    if (cur === undefined) return node
  }
  return deref(cur as JsonSchemaNode, root)
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

/** Recursively fill in the schema's `default` wherever the value is undefined. */
export function applyDefaults(node: JsonSchemaNode, value: unknown, root: JsonSchemaNode): unknown {
  const n = deref(node, root)
  if (value === undefined) {
    if (n.default !== undefined) return structuredClone(n.default)
    if (getNodeKind(n, root) !== 'object') return undefined
  }
  if (getNodeKind(n, root) === 'object' && n.properties) {
    const base = (typeof value === 'object' && value !== null ? { ...(value as object) } : {}) as Record<string, unknown>
    for (const [key, child] of Object.entries(n.properties)) {
      const filled = applyDefaults(child, base[key], root)
      if (filled !== undefined) base[key] = filled
    }
    return base
  }
  return value
}

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
  const clone = (typeof obj === 'object' && obj !== null ? { ...(obj as object) } : {}) as Record<string, unknown>
  let cur = clone
  for (let i = 0; i < segs.length - 1; i++) {
    const seg = segs[i]!
    const next = cur[seg]
    cur[seg] = typeof next === 'object' && next !== null ? { ...(next as object) } : {}
    cur = cur[seg] as Record<string, unknown>
  }
  cur[segs[segs.length - 1]!] = value
  return clone as T
}
