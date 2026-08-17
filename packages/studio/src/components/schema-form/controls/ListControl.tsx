'use client'

import { Plus, X } from 'lucide-react'
import { Button } from '@enkaku/ui'
import type { FieldPlan } from '../plan'
import { emptyItem } from './empty'
import { renderControl } from './index'
import { FieldRow } from './shell'
import type { BaseControlProps } from './types'

/**
 * An array of scalars. Each row is rendered through `renderControl` on the
 * item's OWN plan (`bare: true`) instead of `String(item ?? '')` — a list
 * of numbers gets a real stepper per row, a list of choices gets a real
 * dropdown, not the text box every item used to become. The label row's
 * `N items` readout is the one thing worth restating here — the items
 * themselves are already fully visible below, unlike a slider's position.
 */
export function ListControl({
  id,
  path,
  label,
  help,
  error,
  value,
  onChange,
  plan,
  bare,
}: BaseControlProps & { plan: Extract<FieldPlan, { control: 'list' }> }) {
  const arr = Array.isArray(value) ? value : []
  const readout = `${arr.length} item${arr.length === 1 ? '' : 's'}`

  const body = (
    <div className="space-y-1.5">
      {arr.map((item, i) => (
        <div key={i} className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            {renderControl(plan.item, {
              id: `${id}-${i}`,
              path: `${path}[${i}]`,
              label: `${label} ${i + 1}`,
              value: item,
              bare: true,
              onChange: (_p, next) => onChange(path, arr.map((v, j) => (j === i ? next : v))),
            })}
          </div>
          <Button type="button" variant="ghost" size="icon-sm" aria-label={`Remove ${label} ${i + 1}`} onClick={() => onChange(path, arr.filter((_, j) => j !== i))}>
            <X className="size-3.5" />
          </Button>
        </div>
      ))}
      <Button type="button" variant="outline" size="sm" onClick={() => onChange(path, [...arr, emptyItem(plan.item)])}>
        <Plus className="size-3.5" /> Add
      </Button>
    </div>
  )

  if (bare) return body
  return (
    <FieldRow id={id} label={label} help={help} error={error} readout={readout}>
      {body}
    </FieldRow>
  )
}
