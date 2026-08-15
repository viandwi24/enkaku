'use client'

import type { GateOutcome } from '@enkaku/protocol'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import type { NodeOption } from './ValueExprEditor'

/**
 * `{ go: 'continue' | 'stop' | 'fail' } | { go: 'goto', node }` (plan 99
 * §3.7) — shared by a gate's `then`/`else` and a script node's `onFailure`,
 * since both are the SAME closed outcome vocabulary (`GateOutcomeSchema`).
 */
export function GateOutcomeEditor({
  value,
  onChange,
  nodeOptions,
  label,
}: {
  value: GateOutcome
  onChange(next: GateOutcome): void
  nodeOptions: readonly NodeOption[]
  label?: string
}) {
  return (
    <div className="flex items-center gap-1.5">
      {label && <span className="w-16 shrink-0 text-[11.5px] text-fg-muted">{label}</span>}
      <Select
        value={value.go}
        onValueChange={(go) => {
          if (go === 'goto') onChange({ go: 'goto', node: nodeOptions[0]?.id ?? '' })
          else onChange({ go: go as 'continue' | 'stop' | 'fail' })
        }}
      >
        <SelectTrigger className="h-8 w-40 text-[12px]" aria-label={label ? `${label} outcome` : 'Outcome'}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="continue">Continue to the next node</SelectItem>
          <SelectItem value="stop">Stop the workflow — success</SelectItem>
          <SelectItem value="fail">Stop the workflow — failed</SelectItem>
          <SelectItem value="goto">Jump to a node…</SelectItem>
        </SelectContent>
      </Select>
      {value.go === 'goto' && (
        <Select value={value.node} onValueChange={(node) => onChange({ go: 'goto', node })}>
          <SelectTrigger className="h-8 w-40 text-[12px]" aria-label="Jump target">
            <SelectValue placeholder="Pick a node" />
          </SelectTrigger>
          <SelectContent>
            {nodeOptions.map((n) => (
              <SelectItem key={n.id} value={n.id}>
                {n.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </div>
  )
}
