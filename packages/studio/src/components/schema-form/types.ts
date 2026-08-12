import type { ParamHints } from '@enkaku/protocol'

export interface JsonSchemaNode {
  // An index signature, matching @enkaku/protocol's own (looser) JsonSchemaNode
  // (`api/json-schema.ts`) — required so this type stays structurally
  // assignable to it, which is what lets `readHints()` (the ONE place that
  // reads `x-enkaku`) take a node straight from this renderer with no cast.
  [key: string]: unknown
  type?: string | string[]
  title?: string
  description?: string
  default?: unknown
  enum?: unknown[]
  properties?: Record<string, JsonSchemaNode>
  required?: string[]
  items?: JsonSchemaNode | JsonSchemaNode[]
  prefixItems?: JsonSchemaNode[]
  minimum?: number
  maximum?: number
  minLength?: number
  maxLength?: number
  pattern?: string
  additionalProperties?: unknown
  anyOf?: JsonSchemaNode[]
  /** From `.meta(ui({ ... }))` in `@enkaku/protocol` (plan 95 §3.2, §4.1) — read
   *  it with `readHints()`, never this key directly, so a malformed or
   *  newer-vocabulary value degrades to `{}` instead of reaching a control. */
  'x-enkaku'?: ParamHints
  $ref?: string
  $defs?: Record<string, JsonSchemaNode>
}

export type FieldKind =
  | 'string'
  | 'number'
  | 'boolean'
  | 'enum'
  | 'range-tuple'
  | 'object'
  | 'array'
  | 'unsupported'

export interface FieldProps {
  schema: JsonSchemaNode
  /** Dot-notation path, used for server errors and tests. */
  path: string
  label: string
  value: unknown
  errors: Record<string, string>
  onChange(path: string, value: unknown): void
}
