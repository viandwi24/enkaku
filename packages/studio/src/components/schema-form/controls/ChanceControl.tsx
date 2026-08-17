'use client'

import { Slider } from '@enkaku/ui'
import { FieldRow } from './shell'
import type { BaseControlProps } from './types'
import { formatValue } from '@enkaku/protocol'

/**
 * `kind: 'chance'` — a probability evaluated at runtime, domain fixed to
 * [0, 1] by the vocabulary (plan 95 §3.2). The slider itself works in whole
 * percentage points (0–100, step 1) purely as an input convenience; what is
 * SUBMITTED is always divided back down to [0, 1] — `ctx.params.saveChance`
 * is a probability, never a percentage, all the way to the script.
 */
export function ChanceControl({ id, path, label, help, error, value, onChange, bare }: BaseControlProps) {
  const num = typeof value === 'number' ? value : undefined
  const percent = num === undefined ? 0 : Math.round(num * 100)
  const handleChange = ([next]: number[]) => onChange(path, (next ?? 0) / 100)

  if (bare) {
    return (
      <div className="flex w-full max-w-56 items-center gap-3">
        <Slider aria-label={label} min={0} max={100} step={1} value={[percent]} aria-invalid={Boolean(error)} onValueChange={handleChange} />
        <span className="readout w-9 shrink-0 text-right text-[11px] text-fg-muted">{percent}%</span>
      </div>
    )
  }

  return (
    <FieldRow id={id} label={label} help={help} error={error} readout={formatValue('chance', undefined, num)}>
      <Slider id={id} min={0} max={100} step={1} value={[percent]} aria-invalid={Boolean(error)} onValueChange={handleChange} />
    </FieldRow>
  )
}
