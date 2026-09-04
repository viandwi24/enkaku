'use client'

import { useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { Badge, Collapsible, CollapsibleContent, CollapsibleTrigger, DeviceName, cn, formatDeviceName } from '@enkaku/ui'

/**
 * Plan 93 §3.15, §4.8, F15, H3, step 93.11 — "no count without names".
 * `OutcomeSummary` (beside this file) says HOW MANY failed or were skipped;
 * this component is what makes every one of those counts openable into the
 * actual device list, grouped by the exact reason text rather than flattened
 * into one undifferentiated pile — the same instinct `RunReport.tsx`'s own
 * `run-grouping.ts` already applied to the deleted fleet command surface's own runs, generalised here for
 * every OTHER bulk surface (a batch, a bulk wake/sleep) that is not a
 * that deleted surface's own runs and therefore cannot reuse that file directly (it is keyed on
 * `CommandMember`, not a generic device outcome).
 */
export interface NamedOutcome {
  deviceId: string
  /**
   * The device's number (plan 89 §3.1) — `null` when it has none, which is a
   * real state and not an error.
   *
   * Plan 124 §4.4, step 124.3 — **required, not optional**, and that is the
   * whole point of adding it here rather than at each of the eight producers.
   * "No count without names" (plan 93 §3.15) is only true if the name
   * actually identifies a phone: on a rack of forty-five `SM-F721U1`, a
   * skipped-group preview reading `SM-F721U1, SM-F721U1, SM-F721U1` names
   * nothing at all. Making the field required means a new producer cannot
   * quietly reintroduce that — it fails to typecheck instead, which is the
   * mechanical half of §3.8's "the rule must not drift a third time".
   *
   * It is kept SEPARATE from `label` (never pre-composed into it) for the
   * reason plan 124 §3.1 gives: the number is presentation, composed at the
   * render site, and `<DeviceName>` below needs the two halves apart so the
   * number can be dimmed. Pre-baking it would also have made the collapsed
   * preview and the expanded rows disagree the moment one of them changed.
   */
  number: number | null
  /** The device's own label, BARE — never with `#N` already folded into it (see `number` above). */
  label: string
  /** Why this device failed or was skipped, verbatim — never invented or paraphrased (plan 93 §3.15). */
  reason: string
}

/**
 * The minimum a bulk dialog's own device pool has to expose for the two
 * lookups below. Structural rather than `DeviceInfo` for the reason
 * `@enkaku/ui`'s `device-name.ts` gives at length: a real `DeviceInfo`
 * satisfies it for free, and nothing here reads the other forty fields.
 */
type PoolDevice = { id: string; number: number | null; label: string }

/**
 * The naming half of a `NamedOutcome`, looked up by device id in a pool the
 * caller already holds.
 *
 * Plan 124 step 124.3 — four bulk dialogs (`BulkPrepDialog`,
 * `BulkTransferDialog`, `InstallBatchDialog`, `network/BulkProxyDialog`) each
 * had their own `const deviceLabel = (id) => pool.find(...)?.label ?? id`,
 * and every one of them dropped the number. They share this instead of each
 * growing a second near-copy, so the fallback rule — **a device that has left
 * the pool is named by its bare id, with no number invented for it** — has
 * one definition. That fallback matters more than it looks: a batch report
 * can outlive the device row it names (a forget mid-batch), and inventing a
 * `#` there would be a lie about identity, which is exactly what plan 124
 * exists to stop.
 */
export function deviceNameIn(pool: readonly PoolDevice[], id: string): { number: number | null; label: string } {
  const d = pool.find((x) => x.id === id)
  return d ? { number: d.number, label: d.label } : { number: null, label: id }
}

/**
 * The same lookup, composed into the single `string` the prose contexts need —
 * `ReattachBanner`'s joined list, a toast, an inline sentence (plan 124 §3.2's
 * "two symbols because there are two contexts"). Derived from `deviceNameIn`
 * rather than reimplemented so the composed and uncomposed forms of the same
 * device can never disagree.
 */
export function deviceLabelIn(pool: readonly PoolDevice[], id: string): string {
  const n = deviceNameIn(pool, id)
  return formatDeviceName(n.number, n.label)
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
                // The collapsed preview is a single joined STRING, so it is
                // `formatDeviceName` and not `<DeviceName>` (plan 124 §3.2 —
                // two symbols because there are two contexts). Every name in
                // it carries its number for the same reason the expanded rows
                // below do: this line is what an operator reads first, and
                // most of the time it is the only one they read.
                <p className="mt-0.5 truncate text-[11px] text-fg-subtle">
                  {group.entries.map((e) => formatDeviceName(e.number, e.label)).join(', ')}
                </p>
              )}
            </div>
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <ul className="space-y-1 border-t px-2.5 py-2 text-[11.5px]">
            {group.entries.map((e) => (
              // An expanded row has room for the two-span form, so the number
              // reads as the quiet identifier beside the name rather than as
              // part of it (plan 124 §3.2). `min-w-0` on the flex wrapper is
              // what lets `<DeviceName>`'s inner `truncate` still engage.
              <li key={e.deviceId} className="flex min-w-0">
                <DeviceName number={e.number} label={e.label} />
              </li>
            ))}
          </ul>
        </CollapsibleContent>
      </Collapsible>
    </li>
  )
}
