import type { ScriptListItem } from '@enkaku/protocol'
import type { ScriptRow } from '@/components/RunScriptDialog'

/**
 * Plan 210 §3.2 item 11: the run dialog still thinks in versions; the wire no
 * longer carries one. A list item becomes a dialog row with the plugin's
 * version. Deleted with the dialog by plan 217.
 */
export function toScriptRow(item: ScriptListItem): ScriptRow {
  return { id: item.id, name: item.name, version: item.plugin.version, paramsSchema: item.paramsSchema, enabled: true, createdAt: null, pluginName: item.plugin.name }
}
