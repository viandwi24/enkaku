import type { FieldPlan } from '../plan'

/**
 * A fresh row/item is never itself blank (F18's `[object Object]` was
 * exactly a missing case of this): `ListControl`'s "Add" and
 * `TableControl`'s "Add row" seed every new entry from its OWN plan, not
 * from `undefined`, so the control that renders it immediately has
 * something legible to show.
 */
export function emptyItem(plan: FieldPlan): unknown {
  switch (plan.control) {
    case 'toggle':
      return false
    case 'number':
      return plan.min ?? 0
    case 'pair':
      return [plan.item.min ?? 0, plan.item.min ?? 0]
    case 'choice':
      return plan.options[0]?.value ?? ''
    case 'text':
      return ''
    // Nothing picked yet. There is no "first path" to seed — a workspace
    // path has to name something that exists, and this control's own empty
    // readout ("Nothing selected") is already the legible version of that.
    case 'workspacePath':
      return ''
    // Same reasoning as `workspacePath` above: there is no "first artifact"
    // to seed, and the empty readout already says "Nothing selected".
    case 'artifact':
      return ''
    case 'list':
      return []
    case 'table':
      return []
    case 'group':
    case 'json':
      return {}
  }
}

export function emptyRow(columns: { key: string; plan: FieldPlan }[]): Record<string, unknown> {
  const row: Record<string, unknown> = {}
  for (const column of columns) row[column.key] = emptyItem(column.plan)
  return row
}
