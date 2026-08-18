'use client'

import type { ReactNode } from 'react'
import { Label } from '@enkaku/ui'

/**
 * The label row every control shares (plan 95 §4.6 — the reference UI's
 * SECOND property): the field's name on the left, its CURRENT VALUE
 * right-aligned on the same row, formatted and monospaced so it lines up
 * like every other measurement in Studio (`.readout`, docs/design.md) — the
 * form reads top to bottom without focusing anything. Help text sits below
 * the label (the reference UI's THIRD property: what the parameter DOES at
 * runtime, not what type it is), the control itself below that, and a
 * field-level error last.
 *
 * `ToggleControl` is the one control with nothing worth restating here —
 * the switch's own position already IS the value — so it renders `inline`
 * instead: label (and help) on the left, the switch on the right, one row.
 */
export function FieldRow({
  id,
  label,
  help,
  error,
  readout,
  badge,
  children,
  inline,
}: {
  id: string
  label: string
  help?: string
  error?: string
  /** The current value, already formatted — rendered right-aligned in the
   *  label row. Omitted (not merely empty) when a control has nothing to
   *  add beyond what it already shows (`ToggleControl`, `inline` below). */
  readout?: ReactNode
  /**
   * Plan 98 §3.5, §3.9 — a small marker naming how a field's own limit is
   * actually enforced (`NumberControl`'s `enforcement` badge). Sits right
   * next to the label, never the readout: this describes the FIELD, not its
   * current value, so it belongs beside the name, not the number. Omitted
   * for every field that does not declare one (the common case).
   */
  badge?: ReactNode
  children: ReactNode
  inline?: boolean
}) {
  if (inline) {
    return (
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <Label htmlFor={id} className="text-[13px] font-normal">
            {label}
          </Label>
          {help && <p className="mt-0.5 text-[11.5px] leading-relaxed text-fg-muted">{help}</p>}
        </div>
        <div className="shrink-0">{children}</div>
      </div>
    )
  }

  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-3">
        {/* `min-w-0`: the readout beside it is `shrink-0`, so without this a
            long field name cannot give ground and the two collide instead of
            the name wrapping. */}
        <div className="flex min-w-0 items-baseline gap-1.5">
          <Label htmlFor={id} className="text-[13px] font-normal">
            {label}
          </Label>
          {badge}
        </div>
        {readout != null && <span className="readout shrink-0 text-[12px] text-fg-muted">{readout}</span>}
      </div>
      {help && <p className="text-[11.5px] leading-relaxed text-fg-muted">{help}</p>}
      {children}
      {error && <p className="text-[11.5px] text-led-danger">{error}</p>}
    </div>
  )
}
