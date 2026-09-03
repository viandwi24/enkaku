'use client'

import { Progress, fileSize } from '@enkaku/ui'
import type { OperationTransfer } from '@/lib/operations'

/**
 * Plan 107 §3.6, step 107.5 — the same byte-progress shape `FilesPanel.tsx`'s
 * own `ProgressBar` already renders for a single-device install/push,
 * reused here (not re-invented) for a re-attached ephemeral transfer inside
 * `InstallBatchDialog`/`BulkTransferDialog`, and for a transfer row inside
 * the farm-wide operations tray (deleted by plan 213 §3.6 with the rest of
 * the old shell's floating surfaces; this component itself stays, owned by
 * plan 216).
 */
export function TransferProgressBar({ transfer, label }: { transfer: OperationTransfer; label: string }) {
  const pct = transfer.total ? Math.min(100, Math.round((transfer.sent / transfer.total) * 100)) : null
  return (
    <div className="space-y-1">
      <Progress value={pct ?? undefined} aria-label={label} />
      <p className="text-[11.5px] text-fg-subtle">
        {label} — {fileSize(transfer.sent)}
        {transfer.total ? ` / ${fileSize(transfer.total)}` : ''}
        {pct !== null ? ` (${pct}%)` : ''}
      </p>
    </div>
  )
}
