import type { ScriptListItem } from '@enkaku/protocol'
import type { JsonSchemaNode } from '@/components/schema-form/types'

/** Shared by `FlowEditor.tsx`'s `NodeInspector` (a node's own `params`) — binds a `ScriptRef`'s declared parameters through the same `ValueExprEditor` list. */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function paramProperties(schema: JsonSchemaNode | null | undefined): { key: string; node: JsonSchemaNode; required: boolean }[] {
  if (!schema || !isRecord(schema.properties)) return []
  const required = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : [])
  return Object.entries(schema.properties as Record<string, JsonSchemaNode>).map(([key, node]) => ({ key, node, required: required.has(key) }))
}

/**
 * The `ScriptListItem` a `ScriptRef` string currently resolves to (plan 310
 * §3.4, §4.6 — a version is a fact, not a choice). `GET /api/scripts` lists
 * only ACTIVE plugin members, so there is exactly one row per script NAME —
 * a pinned `name@1.4.0` and a stale `name@1.0.0` both resolve to the SAME
 * row, which is what lets the node panel's `versionNotice` compare the
 * pinned version against the active one and still show the member's
 * current title/icon/params either way. `undefined` before a script is
 * picked, or if its name is not (yet) in `scripts` at all (the plugin was
 * removed, disabled, or never installed on this farm).
 */
export function resolveScriptOption(ref: string, scripts: readonly ScriptListItem[]): ScriptListItem | undefined {
  const at = ref.lastIndexOf('@')
  const name = at > 0 ? ref.slice(0, at) : ref
  return scripts.find((s) => s.name === name)
}
