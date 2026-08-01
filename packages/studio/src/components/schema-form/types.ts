export interface JsonSchemaNode {
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
  /** Path titik-notasi, dipakai untuk error server & test. */
  path: string
  label: string
  value: unknown
  errors: Record<string, string>
  onChange(path: string, value: unknown): void
}
