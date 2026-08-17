'use client'

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@enkaku/ui'
import type { FieldPlan } from '../plan'
import { useEnumOptions } from '../useEnumSource'
import { FieldRow } from './shell'
import type { BaseControlProps } from './types'

/**
 * Today's `EnumField`, unchanged in spirit (K4 kept whole): an unavailable
 * option is shown, disabled, WITH its reason, rather than hidden — so an
 * operator can tell "not ready yet" from "does not exist". `plan.options`
 * already carries the author's own `labels` decoration (plan 95 §3.2);
 * `useEnumOptions` layers the registry's display name and availability on
 * top when `plan.source` names one (§3.4), falling back to the plan's own
 * label — never the bare enum value — everywhere the registry has nothing
 * to say.
 *
 * DELIBERATE DEVIATION from §4.6's table, which lists this control's
 * label-row readout as "the selected label": Radix's `Select.Value`
 * already renders the selected option's label INSIDE the closed trigger —
 * confirmed by rendering it (no interaction needed) — so a second copy in
 * the label row is not the reference UI's second property (a value that is
 * otherwise invisible until interacted with, e.g. a slider's exact
 * percentage); it is a duplicate, and duplicating the same string twice in
 * one field is clutter, not clarity. No `readout` is passed here.
 */
export function ChoiceControl({
  id,
  path,
  label,
  help,
  error,
  value,
  onChange,
  plan,
  bare,
}: BaseControlProps & { plan: Extract<FieldPlan, { control: 'choice' }> }) {
  const enriched = useEnumOptions(
    plan.options.map((o) => o.value),
    plan.source,
  )
  const options = enriched.map((o, i) => ({
    ...o,
    label: o.label === o.value ? (plan.options[i]?.label ?? o.label) : o.label,
  }))
  const selected = options.find((o) => o.value === String(value ?? ''))

  const control = (
    <Select value={String(value ?? '')} onValueChange={(v) => onChange(path, v)}>
      {/* Fixed width: dropdowns that size to their content leave the form's
          right edge ragged and hard to scan. */}
      <SelectTrigger id={bare ? undefined : id} aria-label={bare ? label : undefined} className="w-full max-w-96" aria-invalid={Boolean(error)}>
        <SelectValue placeholder="Select…" />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) =>
          o.available ? (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ) : (
            <Tooltip key={o.value}>
              <TooltipTrigger asChild>
                <div>
                  <SelectItem value={o.value} disabled>
                    {o.label}
                    <span className="ml-2 text-[10px] text-fg-subtle">not available</span>
                  </SelectItem>
                </div>
              </TooltipTrigger>
              <TooltipContent side="right">{o.reason ?? 'This engine is not available yet'}</TooltipContent>
            </Tooltip>
          ),
        )}
      </SelectContent>
    </Select>
  )

  if (bare) return control
  return (
    <FieldRow id={id} label={label} help={help} error={error}>
      {control}
      {selected && !selected.available && (
        <p className="text-[11.5px] text-led-warn">
          This engine is not available{selected.reason ? ` — ${selected.reason}` : ''}. The device will use a fallback.
        </p>
      )}
    </FieldRow>
  )
}
