'use client'

import type { FieldPlan } from '../plan'
import { NumberField } from './NumberField'
import { FieldRow } from './shell'
import type { BaseControlProps } from './types'
import { formatValue, type EnforcementLevel } from '@enkaku/protocol'

/**
 * Plan 98 §3.5, §3.9 — `sampled`/`advisory` get a small marker next to the
 * label naming how the field's own limit is actually enforced; `undefined`
 * and `'hard'` render nothing (§3.5: hard is the default expectation, and a
 * badge on every ordinary numeric field would be noise, not signal). This is
 * information ABOUT the field, never a control the operator can flip — the
 * enforcement mode itself is chosen elsewhere (`job.memory.enforce`, its own
 * schema field), not here.
 */
function EnforcementBadge({ enforcement }: { enforcement: EnforcementLevel | undefined }) {
  if (enforcement !== 'sampled' && enforcement !== 'advisory') return null
  const title =
    enforcement === 'sampled'
      ? 'Enforced by sampling: a breach is caught on the next check, not prevented instantly.'
      : 'Recorded, but nothing acts on a breach of this field today.'
  return (
    <span
      className="rounded bg-surface-3 px-1.5 py-0.5 text-[10px] tracking-wide text-fg-subtle uppercase"
      title={title}
    >
      {enforcement}
    </span>
  )
}

/**
 * Every numeric kind except `chance` (`ChanceControl` owns that one — a
 * probability gets a slider, not a stepper, per the vocabulary's own §3.2
 * reasoning). A count, a duration, a byte size, a bitrate, a pixel length,
 * a temperature and a plain unlabelled number all land here; what
 * differs is only the label-row readout, which `formatValue` computes from
 * `plan.kind`/`plan.unit` — this component itself does not branch on kind
 * at all (plan 95 §4.6).
 */
export function NumberControl({
  id,
  path,
  label,
  help,
  error,
  value,
  onChange,
  plan,
  bare,
}: BaseControlProps & { plan: Extract<FieldPlan, { control: 'number' }> }) {
  const num = typeof value === 'number' ? value : undefined
  const field = (
    <NumberField
      id={bare ? undefined : id}
      ariaLabel={label}
      value={num}
      min={plan.min}
      max={plan.max}
      step={plan.step}
      increment={plan.increment}
      error={Boolean(error)}
      onChange={(next) => onChange(path, next)}
    />
  )
  if (bare) return field
  return (
    <FieldRow
      id={id}
      label={label}
      help={help}
      error={error}
      readout={formatValue(plan.kind, plan.unit, num)}
      badge={<EnforcementBadge enforcement={plan.enforcement} />}
    >
      {field}
    </FieldRow>
  )
}
