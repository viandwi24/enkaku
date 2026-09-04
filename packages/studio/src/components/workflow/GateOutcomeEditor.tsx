'use client'

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@enkaku/ui'
import type { NodeOption } from './ValueExprEditor'

/**
 * A single edge field — `next` | `onFailure` | `then` | `else` — is a bare
 * node id or absent (plan 300 D1, plan 301 §4.1). Rewritten by plan 301 §5
 * step 301.6 from an outcome-ENUM picker (the v1 shape, a closed `go` union
 * plus an optional jump target) into a plain node picker: "not wired yet"
 * (absent, the dangling default) or "jump to <node>". The old outcome
 * vocabulary no longer exists as a value at all — an unwired edge already
 * carries the exact meaning that vocabulary used to spell out explicitly
 * (plan 301 §3.2), so there is nothing left to pick beyond "which node, if
 * any."
 */
export function GateOutcomeEditor({
  value,
  onChange,
  nodeOptions,
  label,
}: {
  /** The edge's target node id, or `undefined` when not wired yet (dangling). */
  value: string | undefined
  onChange(next: string | undefined): void
  nodeOptions: readonly NodeOption[]
  label?: string
}) {
  const NOT_WIRED = '__not_wired__'
  return (
    <div className="flex items-center gap-1.5">
      {label && <span className="w-16 shrink-0 text-[11.5px] text-fg-muted">{label}</span>}
      <Select value={value ?? NOT_WIRED} onValueChange={(next) => onChange(next === NOT_WIRED ? undefined : next)}>
        <SelectTrigger className="h-8 w-56 text-[12px]" aria-label={label ? `${label} target` : 'Target node'}>
          <SelectValue placeholder="Not wired yet" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NOT_WIRED}>Not wired yet</SelectItem>
          {nodeOptions.map((n) => (
            <SelectItem key={n.id} value={n.id}>
              jump to {n.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}
