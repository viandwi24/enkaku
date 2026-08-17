'use client'

import type { ReattachResult } from '@/lib/operations'

/**
 * Plan 107 §3.6, step 107.5 — the "partial overlap must be stated, never
 * merged silently" half of dialog re-attach. `InstallBatchDialog`/
 * `BulkTransferDialog` render this whenever `findReattach` finds SOME
 * overlap that is not the single clean "re-attach silently" case (that case
 * replaces the whole form instead — see either dialog's own doc comment).
 * Two situations reach here, worded the same way because the operator's
 * choice is identical either way — narrow the target or wait:
 *
 * - `overlap === 'partial'` — some, not all, of the selected devices already
 *   have one of these running.
 * - `overlap === 'full'` but covered by MORE THAN ONE running operation —
 *   every device is already busy, just not under one single operation this
 *   dialog could point at as "the" running one.
 */
export function ReattachBanner({
  reattach,
  deviceLabel,
  verb,
}: {
  reattach: ReattachResult
  deviceLabel: (id: string) => string
  /** e.g. "installing", "pushing", "pulling" — the ongoing-tense verb this banner names. */
  verb: string
}) {
  if (reattach.overlap === 'none') return null
  if (reattach.overlap === 'full' && reattach.operation) return null // the dialog re-attaches silently instead — nothing to warn about.

  const names = [...new Set(reattach.overlapping.flatMap((op) => op.deviceIds))].map(deviceLabel)
  const whole = reattach.overlap === 'full'

  return (
    <div role="alert" className="rounded-lg border border-led-warn/35 bg-led-warn/5 px-3 py-2.5 text-[12.5px]">
      <p className="font-medium text-led-warn">
        {whole ? 'Already running on every selected device' : `Already running on ${names.length} of the selected devices`}
      </p>
      <p className="mt-1 text-fg-muted">
        {names.join(', ')} {names.length === 1 ? 'is' : 'are'} already {verb} in {reattach.overlapping.length === 1 ? 'another operation' : 'other operations'}.{' '}
        {whole
          ? 'Close this dialog and check the operations tray instead of starting a second one.'
          : 'Remove them from the target, or wait for it to finish, before starting a new one.'}{' '}
        Starting anyway risks two transfers racing on the same device.
      </p>
    </div>
  )
}
