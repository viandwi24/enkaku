import type { JsonSchemaNode } from './types'

/**
 * A schema narrowed to a subset of its top-level `properties` keys. The
 * value and `onChange` stay the same — this only changes what is visible,
 * so one settings object can be split into named sections without touching
 * the underlying data (the pattern the farm Settings page established,
 * shared with the device Settings tab in plan 46 §4.2/§4.3).
 */
export function narrowSchema(schema: JsonSchemaNode, keys: readonly string[]): JsonSchemaNode {
  return {
    ...schema,
    properties: Object.fromEntries(
      keys.flatMap((k) => {
        const child = schema.properties?.[k]
        return child ? [[k, child] as const] : []
      }),
    ),
  }
}
