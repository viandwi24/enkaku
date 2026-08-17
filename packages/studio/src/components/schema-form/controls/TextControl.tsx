'use client'

import type { ChangeEvent } from 'react'
import { Input, Textarea } from '@enkaku/ui'
import type { FieldPlan } from '../plan'
import { FieldRow } from './shell'
import type { BaseControlProps } from './types'

/**
 * `text`/`packageName`, and any plain string (rows 7/8 of the precedence
 * table): `Input` or `Textarea` per `plan.multiline`. The label-row readout
 * is a character count when `plan.maxLength` is set — the one case a
 * string's own value is worth restating, because "how much room is left"
 * is not otherwise visible until the box is full.
 *
 * `pattern` is deliberately never read here, and never will be (plan 95
 * §3.8 R2) — no author-supplied regular expression is evaluated in Studio.
 */
export function TextControl({
  id,
  path,
  label,
  help,
  error,
  value,
  onChange,
  plan,
  bare,
}: BaseControlProps & { plan: Extract<FieldPlan, { control: 'text' }> }) {
  const str = value === undefined || value === null ? '' : String(value)
  const readout = plan.maxLength !== undefined ? `${str.length}/${plan.maxLength}` : undefined
  const handleChange = (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => onChange(path, e.target.value)

  const field = plan.multiline ? (
    <Textarea
      id={bare ? undefined : id}
      aria-label={bare ? label : undefined}
      rows={3}
      maxLength={plan.maxLength}
      aria-invalid={Boolean(error)}
      value={str}
      onChange={handleChange}
    />
  ) : (
    <Input
      id={bare ? undefined : id}
      aria-label={bare ? label : undefined}
      maxLength={plan.maxLength}
      aria-invalid={Boolean(error)}
      value={str}
      onChange={handleChange}
    />
  )

  if (bare) return field
  return (
    <FieldRow id={id} label={label} help={help} error={error} readout={readout}>
      {field}
    </FieldRow>
  )
}
