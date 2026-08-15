'use client'

import { useEffect, useState } from 'react'
import { CommandRunsPageResponseSchema, type ClusterInfo, type CommandRunSummary, type CommandTarget, type DeviceInfo } from '@enkaku/protocol'
import { api } from '@/lib/actions'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/states'
import { relativeTime } from '@/lib/format'
import { describeCommandTarget } from './target-preview'

/**
 * Plan 93 §3.9, §3.16, step 93.7 — "history is durable, per-user, browsable,
 * and re-runnable — the same record whether the command went to one device
 * or a hundred, so there is one history, not two." Reads `GET
 * /api/command-runs?mine=1`, the same store `TerminalPane`'s own arrow-up
 * recall already seeds from (step 93.5) — this panel is the browsable form
 * of the identical record.
 *
 * Best-effort, exactly like `TerminalPane`'s own history fetch: a failed or
 * missing route never becomes an error banner — history is a convenience.
 */
export function CommandHistory({
  devices,
  clusters,
  reloadKey,
  onRunAgain,
  onRunAgainOn,
}: {
  devices: DeviceInfo[]
  clusters: ClusterInfo[]
  /** Bumped by the console page after a new run starts, so it appears here without a manual refresh. */
  reloadKey: number
  onRunAgain: (cmd: string, target: CommandTarget) => void
  onRunAgainOn: (cmd: string) => void
}) {
  const [items, setItems] = useState<CommandRunSummary[]>([])
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    let cancelled = false
    api('/api/command-runs?mine=1&limit=20', CommandRunsPageResponseSchema)
      .then((page) => {
        if (!cancelled) setItems(page.items)
      })
      .catch(() => {
        // See the file doc comment — silently leave history empty.
      })
      .finally(() => {
        if (!cancelled) setLoaded(true)
      })
    return () => {
      cancelled = true
    }
  }, [reloadKey])

  if (!loaded) return null
  if (items.length === 0) {
    return <EmptyState title="No commands run yet" description="Commands you run — one device or many — appear here." />
  }

  return (
    <ul className="space-y-1.5">
      {items.map((r) => (
        <li key={r.id} className="rounded-md border bg-surface p-2 text-[12px]">
          <code className="readout block truncate">{r.cmd}</code>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-fg-muted">
            <span>{describeCommandTarget(r.target, devices, clusters)}</span>
            <span>· {relativeTime(r.startedAt)}</span>
            <OutcomeChip counts={r.counts} status={r.status} />
          </div>
          <div className="mt-1 flex gap-2">
            <Button size="sm" variant="ghost" className="h-6 px-1.5 text-[11px]" onClick={() => onRunAgain(r.cmd, r.target)}>
              Run again
            </Button>
            <Button size="sm" variant="ghost" className="h-6 px-1.5 text-[11px]" onClick={() => onRunAgainOn(r.cmd)}>
              Run again on…
            </Button>
          </div>
        </li>
      ))}
    </ul>
  )
}

function OutcomeChip({ counts, status }: { counts: CommandRunSummary['counts']; status: CommandRunSummary['status'] }) {
  if (status === 'running' || status === 'awaiting-continue') return <Badge variant="outline">running</Badge>
  if (counts.failed > 0) return <Badge variant="destructive">{counts.failed} failed</Badge>
  if (counts.skipped > 0) return <Badge variant="outline">{counts.skipped} skipped</Badge>
  if (status === 'cancelled') return <Badge variant="outline">cancelled</Badge>
  return <Badge variant="secondary">ok</Badge>
}
