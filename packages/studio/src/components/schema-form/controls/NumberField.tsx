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
 *
 * `step` and `increment` are deliberately TWO props, not one (96.31). They
 * used to be the same value, which was the bug: `step` is the HTML
 * VALIDATION attribute (passed straight through to `<input step=...>`, where
 * `'any'` is a real, meaningful value — "no constraint"), while `increment`
 * is what one click of + or - actually adds, which must always be a real
 * number. Deriving the button delta from `step` broke both jobs at once —
 * `step="any"` (needed so a stored `0.08` for `gestureCurvature` passes
 * native validation) would have made `Number('any')` a `NaN` delta, silently
 * disabling both buttons. See `plan.ts`'s `numberBounds` for how each is
 * computed from a JSON Schema node.
 */
export function NumberField({
  id,
  ariaLabel,
  value,
  min,
  max,
  step,
  increment,
  error,
  onChange,
}: {
  id?: string
  ariaLabel: string
  value: number | undefined
  min?: number
  max?: number
  /** The HTML `step` validation attribute — a number, or `'any'` for "no
   *  constraint". Never used as the button delta; see `increment`. */
  step?: number | 'any'
  /** The +/- button delta. Always a plain number — defaults to `1`, exactly
   *  as before this field existed separately from `step`. */
  increment?: number
  error?: boolean
  onChange(next: number | undefined): void
}) {
  const clamp = (n: number): number => {
    let next = n
    if (min !== undefined) next = Math.max(min, next)
    if (max !== undefined) next = Math.min(max, next)
    return next
  }
  const delta = increment ?? 1
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
