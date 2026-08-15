'use client'

import { Minus, Plus } from 'lucide-react'
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '@/components/ui/input-group'

/**
 * The bare numeric stepper (plan 95 §4.6, F31): `InputGroup` plus two
 * `InputGroupButton`s IS the stepper anatomy already in the design system —
 * "a control with a button at either end" — so no new dependency is needed
 * for this one. No label, no readout, no help: `NumberControl` and
 * `PairControl` each wrap this with their OWN label row, so a pair does not
 * repeat "Interval" twice.
 */
export function NumberField({
  id,
  ariaLabel,
  value,
  min,
  max,
  step,
  error,
  onChange,
}: {
  id?: string
  ariaLabel: string
  value: number | undefined
  min?: number
  max?: number
  step?: number
  error?: boolean
  onChange(next: number | undefined): void
}) {
  const clamp = (n: number): number => {
    let next = n
    if (min !== undefined) next = Math.max(min, next)
    if (max !== undefined) next = Math.min(max, next)
    return next
  }
  const delta = step ?? 1
  const adjust = (by: number) => onChange(clamp(Number(((value ?? min ?? 0) + by).toFixed(6))))
  const atMin = value !== undefined && min !== undefined && value <= min
  const atMax = value !== undefined && max !== undefined && value >= max

  return (
    <InputGroup className="w-full max-w-40">
      <InputGroupAddon align="inline-start">
        <InputGroupButton type="button" aria-label={`Decrease ${ariaLabel}`} onClick={() => adjust(-delta)} disabled={atMin}>
          <Minus />
        </InputGroupButton>
      </InputGroupAddon>
      <InputGroupInput
        id={id}
        type="number"
        aria-label={id ? undefined : ariaLabel}
        className="readout text-center"
        min={min}
        max={max}
        step={step}
        aria-invalid={error}
        value={value === undefined ? '' : String(value)}
        onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
      />
      <InputGroupAddon align="inline-end">
        <InputGroupButton type="button" aria-label={`Increase ${ariaLabel}`} onClick={() => adjust(delta)} disabled={atMax}>
          <Plus />
        </InputGroupButton>
      </InputGroupAddon>
    </InputGroup>
  )
}
