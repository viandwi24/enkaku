'use client'

import { Switch } from '@enkaku/ui'
import { FieldRow } from './shell'
import type { BaseControlProps } from './types'

/**
 * Today's `Switch`, unchanged (plan 95 §4.6) — a boolean's own on/off
 * position already IS the value, so this is the one control with nothing
 * to add in the label row (no `readout`, `FieldRow`'s `inline` mode).
 */
export function ToggleControl({ id, path, label, help, error, value, onChange, bare }: BaseControlProps) {
  const control = <Switch id={bare ? undefined : id} aria-label={bare ? label : undefined} checked={value === true} onCheckedChange={(v) => onChange(path, v)} />
  if (bare) return control
  return (
    <FieldRow id={id} label={label} help={help} error={error} inline>
      {control}
    </FieldRow>
  )
}
