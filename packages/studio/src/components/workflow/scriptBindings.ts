import type { JsonSchemaNode } from '@/components/schema-form/types'
import { groupScriptsByName, type ScriptOption } from './ScriptPicker'

/** Shared between `NodeCard.tsx` (a node's own `params`) and `WorkflowBuilder.tsx` (`onFail.params`) — both bind a `ScriptRef`'s declared parameters through the same `ValueExprEditor` list. */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function paramProperties(schema: JsonSchemaNode | null | undefined): { key: string; node: JsonSchemaNode; required: boolean }[] {
  if (!schema || !isRecord(schema.properties)) return []
  const required = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : [])
  return Object.entries(schema.properties as Record<string, JsonSchemaNode>).map(([key, node]) => ({ key, node, required: required.has(key) }))
}

/** The concrete `ScriptOption` a `ScriptRef` string currently resolves to — `latest` resolves to the newest version this picker knows about (`groupScriptsByName`'s own sort), the same approximation `ScriptPicker` renders next to its "latest" option. `undefined` before a script is picked, or if its name is not (yet) in `scripts`. */
export function resolveScriptOption(ref: string, scripts: readonly ScriptOption[]): ScriptOption | undefined {
  const at = ref.lastIndexOf('@')
  if (at <= 0) return undefined
  const name = ref.slice(0, at)
  const version = ref.slice(at + 1)
  const group = groupScriptsByName(scripts).find((g) => g.name === name)
  if (!group) return undefined
  return version === 'latest' ? group.versions[0] : group.versions.find((v) => v.version === version)
}
