'use client'

import type { FieldPlan } from '../plan'
import { NumberField } from './NumberField'
import { FieldRow } from './shell'
import type { BaseControlProps } from './types'
import { formatValue } from '@enkaku/protocol'

/**
 * A 2-number tuple, arity from structure (K3, plan 95 §3.3 row 6) — `kind`
 * and `unit` describe each half (`plan.item`), `ordered` says which end
 * comes first (default `true`, §3.2). Two bare `NumberField`s so the pair's
 * OWN label ("Watch time range") is not repeated per half; the label row's
 * `5 s ~ 20 s` readout is `formatValue` applied to the pair itself, no
 * separate formatter needed (§4.6).
 */
export function PairControl({
  id,
  path,
  label,
  help,
  error,
  value,
  onChange,
  plan,
  bare,
}: BaseControlProps & { plan: Extract<FieldPlan, { control: 'pair' }> }) {
  const arr = Array.isArray(value) ? value : [undefined, undefined]
  const lo = typeof arr[0] === 'number' ? arr[0] : undefined
  const hi = typeof arr[1] === 'number' ? arr[1] : undefined
  const { item } = plan

  // Clamp ON EDIT: moving the low end past the high one carries the high
  // end along with it, and vice versa (plan 95 §3.2, §4.4) — the pair can
  // never be entered backwards, rather than entered backwards and then
  // rejected by a validator the operator has to go read.
  const setLo = (next: number | undefined) => {
    const nextHi = plan.ordered && next !== undefined && hi !== undefined && next > hi ? next : hi
    onChange(path, [next, nextHi])
  }
  const setHi = (next: number | undefined) => {
    const nextLo = plan.ordered && next !== undefined && lo !== undefined && next < lo ? next : lo
    onChange(path, [nextLo, next])
  }

  const body = (
    <div className="flex items-center gap-2">
      <NumberField id={bare ? undefined : id} ariaLabel={`${label} minimum`} value={lo} min={item.min} max={item.max} step={item.step} error={Boolean(error)} onChange={setLo} />
      <span className="text-[11px] text-fg-subtle">~</span>
      <NumberField ariaLabel={`${label} maximum`} value={hi} min={item.min} max={item.max} step={item.step} error={Boolean(error)} onChange={setHi} />
    </div>
  )
  if (bare) return body
  return (
    <FieldRow id={id} label={label} help={help} error={error} readout={formatValue(item.kind, item.unit, [lo, hi])}>
      {body}
    </FieldRow>
  )
}
