import type { JsonSchemaNode } from '@enkaku/protocol'

/**
 * A sample value for a node whose real output is not known yet (plan 309
 * §3.2, §4.2) — the middle of `simulateWorkflow`'s three-source precedence:
 * a pin, then a sample derived from `resultSchema`, then an author-written
 * mock. A pure function over `JsonSchemaNode`, bounded so a pathological or
 * recursive-looking schema (a plugin author's mistake, not malice — this
 * schema was written by whoever wrote the script, not by whoever is
 * simulating) cannot hang the simulation or blow the stack.
 *
 * Honours `default`, `examples[0]`, `enum[0]` and `const` when present, in
 * that order, before falling back to the per-type placeholder — an author
 * who documented their schema gets their own examples back, not `"text"`.
 */

export const SIMULATE_LIMITS = {
  maxDepth: 6,
  maxNodes: 500,
  maxArrayLength: 1,
} as const

interface SampleState {
  nodes: number
}

function isSchemaObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** The schema's own declared type — `type` may be a string or an array of strings (JSON Schema's own "union of primitive types" form); the first entry wins here, which is enough for a sample. */
function declaredType(schema: Record<string, unknown>): string | undefined {
  const t = schema.type
  if (typeof t === 'string') return t
  if (Array.isArray(t) && typeof t[0] === 'string') return t[0]
  return undefined
}

function placeholderFor(type: string | undefined): unknown {
  switch (type) {
    case 'string':
      return 'text'
    case 'number':
    case 'integer':
      return 0
    case 'boolean':
      return false
    case 'array':
      return []
    case 'object':
      return {}
    case 'null':
      return null
    default:
      return null
  }
}

/**
 * Walks one JSON Schema node, bounded by `SIMULATE_LIMITS`. TOTAL: never
 * throws, on any input, including a schema this repo did not author (a
 * plugin's own `resultSchema`) — `undefined`/non-object input, a cyclic-
 * looking `$ref` (never followed; this repo's `z.toJSONSchema` output never
 * emits one, and following one is exactly the hang this function must not
 * risk), and a bottomless `maxDepth`/`maxNodes` walk all degrade to the
 * type's own placeholder rather than recursing further.
 */
export function sampleFromSchema(schemaValue: unknown, state: SampleState = { nodes: 0 }, depth = 0): unknown {
  state.nodes += 1
  if (!isSchemaObject(schemaValue) || depth >= SIMULATE_LIMITS.maxDepth || state.nodes > SIMULATE_LIMITS.maxNodes) {
    return isSchemaObject(schemaValue) ? placeholderFor(declaredType(schemaValue)) : null
  }
  const schema = schemaValue as JsonSchemaNode

  if ('const' in schema) return schema.const
  if (Object.prototype.hasOwnProperty.call(schema, 'default')) return schema.default
  if (Array.isArray(schema.examples) && schema.examples.length > 0) return schema.examples[0]
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0]

  const type = declaredType(schema)

  if (type === 'array' || (type === undefined && isSchemaObject(schema.items))) {
    const items = schema.items
    if (SIMULATE_LIMITS.maxArrayLength <= 0) return []
    const out: unknown[] = []
    for (let i = 0; i < SIMULATE_LIMITS.maxArrayLength; i++) {
      out.push(sampleFromSchema(items, state, depth + 1))
    }
    return out
  }

  if (type === 'object' || (type === undefined && isSchemaObject(schema.properties))) {
    const properties = isSchemaObject(schema.properties) ? schema.properties : {}
    const out: Record<string, unknown> = {}
    for (const [key, propSchema] of Object.entries(properties)) {
      if (state.nodes > SIMULATE_LIMITS.maxNodes) break
      out[key] = sampleFromSchema(propSchema, state, depth + 1)
    }
    return out
  }

  return placeholderFor(type)
}
