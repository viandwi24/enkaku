'use client'

import { Progress } from '@/components/ui/progress'

/**
 * Plan 93 §3.15, §4.8, H3, step 93.11 — the one three-part summary line every
 * bulk surface in Studio now shares: ok / failed / skipped, against the
 * total. Before this component, F15 named three unrelated bulk patterns
 * side by side (`BulkForgetDialog`'s per-device list, `InstallBatchDialog`'s
 * "navigate away and show nothing", `wakeOrSleepSelected`'s anonymous toast)
 * — this is the single shape all of them converge on instead of a fourth.
 *
 * Deliberately dumb: it renders counts, nothing more. Naming the DEVICES
 * behind a count — the actual substance of F15 — is `SkippedGroups`'
 * job, right below it. A summary without that sibling is a regression back
 * to "6 failed" with no way to find which six.
 */
export interface OutcomeCounts {
  ok: number
  failed: number
  skipped: number
  total: number
}

export function OutcomeSummary({ counts, label }: { counts: OutcomeCounts; label?: string }) {
  const settled = counts.ok + counts.failed + counts.skipped
  const percent = counts.total > 0 ? Math.round((settled / counts.total) * 100) : 0
  return (
    <div className="space-y-1.5" data-testid="outcome-summary">
      <Progress value={percent} aria-label={label ?? 'Outcome progress'} />
      <p className="text-[11.5px] text-fg-muted">
        {counts.ok} ok · {counts.failed} failed · {counts.skipped} skipped ({settled}/{counts.total})
      </p>
    </div>
  )
}
