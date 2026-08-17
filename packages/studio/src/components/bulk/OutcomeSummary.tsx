'use client'

import { Progress } from '@enkaku/ui'

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
      {/*
       * `counts.total === 0` means there is nothing to show progress OF —
       * every real caller of this component (a batch, a command run) has at
       * least one member when it is genuinely in flight, so reaching zero
       * here is either a not-yet-hydrated fixture or the exact core defect
       * `docs/plans/96-m61-hotfixes.md` §96.30 fixed (every member deleted
       * out from under a still-open batch). Either way, a bar has nothing
       * true to say about "0 of 0" — `Progress value={0}` already renders
       * its indicator fully hidden (see `components/ui/progress.tsx`'s own
       * `translateX`), but the track underneath it (`bg-primary/20`, itself
       * a full-width, always-visible pill) still reads as a bar with
       * something to show. Omitting it entirely, rather than trusting a
       * value of 0 to look "empty enough", is the fix the owner's own
       * screenshot asked for: zero work renders no bar at all.
       */}
      {counts.total > 0 && <Progress value={percent} aria-label={label ?? 'Outcome progress'} />}
      <p className="text-[11.5px] text-fg-muted">
        {counts.ok} ok · {counts.failed} failed · {counts.skipped} skipped ({settled}/{counts.total})
      </p>
    </div>
  )
}
