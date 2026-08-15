'use client'

import type { ChangeEvent } from 'react'
import { Textarea } from '@/components/ui/textarea'
import type { FieldPlan } from '../plan'
import { FieldRow } from './shell'
import type { BaseControlProps } from './types'

/**
 * Today's textarea escape hatch, kept — but now carrying WHY instead of the
 * old generic "No dedicated editor for this type yet" (plan 95 §3.3):
 * `plan.reason` names the actual cause ("this parameter refers to itself",
 * "this parameter is a free-form map", "this parameter can take several
 * different shapes", ...), closing F19 and F20 legibly rather than leaving
 * an unexplained blank card or bare textarea.
 */
export function JsonControl({
  id,
  path,
  label,
  help,
  error,
  value,
  onChange,
  plan,
  bare,
}: BaseControlProps & { plan: Extract<FieldPlan, { control: 'json' }> }) {
  const text = value === undefined ? '' : JSON.stringify(value)
  const handleChange = (e: ChangeEvent<HTMLTextAreaElement>) => {
    try {
      onChange(path, JSON.parse(e.target.value))
    } catch {
      onChange(path, e.target.value)
    }
  }

  const field = (
    <Textarea
      id={bare ? undefined : id}
      aria-label={bare ? label : undefined}
      rows={3}
      className="readout text-[12px]"
      aria-invalid={Boolean(error)}
      value={text}
      onChange={handleChange}
    />
  )

  if (bare) return field
  return (
    <FieldRow id={id} label={label} help={help} error={error}>
      {field}
      <p className="text-[11px] text-fg-subtle">{plan.reason} — enter it as JSON.</p>
    </FieldRow>
  )
}
