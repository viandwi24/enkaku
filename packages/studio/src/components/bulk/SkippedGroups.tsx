'use client'

import { useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { Badge, Collapsible, CollapsibleContent, CollapsibleTrigger, cn } from '@enkaku/ui'

/**
 * Plan 93 §3.15, §4.8, F15, H3, step 93.11 — "no count without names".
 * `OutcomeSummary` (beside this file) says HOW MANY failed or were skipped;
 * this component is what makes every one of those counts openable into the
 * actual device list, grouped by the exact reason text rather than flattened
 * into one undifferentiated pile — the same instinct `RunReport.tsx`'s own
 * `run-grouping.ts` already applies to a command run, generalised here for
 * every OTHER bulk surface (a batch, a bulk wake/sleep) that is not a
 * command run and therefore cannot reuse that file directly (it is keyed on
 * `CommandMember`, not a generic device outcome).
 */
export interface NamedOutcome {
  deviceId: string
  label: string
  /** Why this device failed or was skipped, verbatim — never invented or paraphrased (plan 93 §3.15). */
  reason: string
}

export interface OutcomeGroup {
  key: string
  kind: 'failed' | 'skipped'
  reason: string
  entries: NamedOutcome[]
}

/** Pure, and exported for its own test — groups by (kind, exact reason text), preserving first-seen order. */
export function groupOutcomes(kind: 'failed' | 'skipped', entries: readonly NamedOutcome[]): OutcomeGroup[] {
  const order: string[] = []
  const byReason = new Map<string, NamedOutcome[]>()
  for (const e of entries) {
    if (!byReason.has(e.reason)) {
      byReason.set(e.reason, [])
      order.push(e.reason)
    }
    byReason.get(e.reason)?.push(e)
  }
  return order.map((reason) => ({ key: `${kind}:${reason}`, kind, reason, entries: byReason.get(reason) ?? [] }))
}

const KIND_TONE: Record<OutcomeGroup['kind'], string> = {
  failed: 'text-led-danger',
  skipped: 'text-led-warn',
}

export function SkippedGroups({ failed, skipped }: { failed: readonly NamedOutcome[]; skipped: readonly NamedOutcome[] }) {
  const groups = [...groupOutcomes('failed', failed), ...groupOutcomes('skipped', skipped)]
  if (groups.length === 0) return null
  return (
    <ul className="space-y-1.5" data-testid="skipped-groups">
      {groups.map((g) => (
        <GroupRow key={g.key} group={g} />
      ))}
    </ul>
  )
}

function GroupRow({ group }: { group: OutcomeGroup }) {
  const [open, setOpen] = useState(false)
  return (
    <li className="rounded-md border">
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger asChild>
          <button type="button" className="flex w-full items-start gap-2 px-2.5 py-2 text-left hover:bg-surface-2/60">
            {open ? (
              <ChevronDown className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            ) : (
              <ChevronRight className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            )}
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className={cn('text-[12.5px] font-medium capitalize', KIND_TONE[group.kind])}>{group.kind}</span>
                <span className="text-[11.5px] text-fg-muted">{group.reason}</span>
                <Badge variant="outline">
                  {group.entries.length} device{group.entries.length === 1 ? '' : 's'}
                </Badge>
              </div>
              {!open && (
                <p className="mt-0.5 truncate text-[11px] text-fg-subtle">{group.entries.map((e) => e.label).join(', ')}</p>
              )}
            </div>
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <ul className="space-y-1 border-t px-2.5 py-2 text-[11.5px]">
            {group.entries.map((e) => (
              <li key={e.deviceId} className="truncate">
                {e.label}
              </li>
            ))}
          </ul>
        </CollapsibleContent>
      </Collapsible>
    </li>
  )
}
