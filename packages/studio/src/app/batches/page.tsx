'use client'

import { useEffect, useRef } from 'react'
import Link from 'next/link'
import { Boxes } from 'lucide-react'
import { BatchesPageResponseSchema, type BatchInfo } from '@enkaku/protocol'
import { PageHeader } from '@/components/layout/PageHeader'
import { PaginatedTable, type PaginatedTableHandle } from '@/components/PaginatedTable'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { TableCell, TableHead } from '@/components/ui/table'
import { api } from '@/lib/actions'
import { relativeTime } from '@/lib/format'
import { ws } from '@/lib/ws'

const STATUS_TONE: Record<BatchInfo['status'], string> = {
  queued: 'text-fg-muted border-line bg-transparent',
  running: 'text-led-active border-led-active/35 bg-led-active/10',
  // Plan 94 §3.9, §4.9, step 94.8 — a stop in progress: running members are
  // still being aborted and queued ones cancelled. Same tone family as
  // `running` (it is still "doing something"), one step toward the warn
  // color `cancelled` already uses, since that is where it is headed.
  stopping: 'text-led-warn border-led-warn/35 bg-led-warn/10',
  success: 'text-led-ok border-led-ok/35 bg-led-ok/10',
  failed: 'text-led-danger border-led-danger/40 bg-led-danger/10',
  cancelled: 'text-led-warn border-led-warn/35 bg-led-warn/10',
}

function BatchStatusBadge({ status }: { status: BatchInfo['status'] }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium leading-none whitespace-nowrap ${STATUS_TONE[status]}`}
    >
      <span className="size-1.5 rounded-full bg-current" aria-hidden />
      {status}
    </span>
  )
}

/** "7/10 · 1 failed" — the progress a batch row is judged by at a glance (plan 20 §4.8). */
function ProgressSummary({ counts }: { counts: BatchInfo['counts'] }) {
  const done = counts.success + counts.failed + counts.cancelled
  const pct = counts.total > 0 ? Math.round((done / counts.total) * 100) : 0
  return (
    <div className="min-w-[9rem] space-y-1">
      <Progress value={pct} className="h-1.5" />
      <p className="readout text-[11px] text-fg-muted">
        {done}/{counts.total}
        {counts.failed > 0 && <span className="text-led-danger"> · {counts.failed} failed</span>}
      </p>
    </div>
  )
}

export default function BatchesPage() {
  const tableRef = useRef<PaginatedTableHandle<BatchInfo>>(null)

  useEffect(() => {
    // `batch.status` only carries { batchId, status, counts } — not a full
    // BatchInfo — so this merges onto an already-loaded row rather than ever
    // prepending an incomplete one (plan 30 §3.5).
    const off = ws.on((m) => {
      if (m.type !== 'batch.status') return
      tableRef.current?.mergeLive(m.payload.batchId, { status: m.payload.status, counts: m.payload.counts })
    })
    return off
  }, [])

  return (
    <>
      <PageHeader title="Batches" description="One script run across a resolved set of devices" />

      <div className="space-y-4 px-5 py-4">
        <PaginatedTable<BatchInfo>
          ref={tableRef}
          fetchPage={(cursor) => api(`/api/batches?limit=50${cursor ? `&cursor=${cursor}` : ''}`, BatchesPageResponseSchema)}
          rowKey={(b) => b.id}
          sort={(list) =>
            [...list].sort((a, b) => {
              const rank = (x: BatchInfo) => (x.status === 'running' || x.status === 'stopping' ? 0 : x.status === 'queued' ? 1 : 2)
              return rank(a) - rank(b) || b.createdAt - a.createdAt
            })
          }
          header={
            <>
              <TableHead className="w-[30%]">Script</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Progress</TableHead>
              <TableHead>Mode</TableHead>
              <TableHead>Created</TableHead>
            </>
          }
          renderRow={(b) => (
            <>
              <TableCell>
                <Link href={`/batches/detail?id=${b.id}`} className="font-medium hover:text-accent">
                  {b.scriptName ? `${b.scriptName}${b.scriptVersion ? `@${b.scriptVersion}` : ''}` : b.scriptId}
                </Link>
              </TableCell>
              <TableCell>
                <BatchStatusBadge status={b.status} />
              </TableCell>
              <TableCell>
                <ProgressSummary counts={b.counts} />
              </TableCell>
              <TableCell className="text-[12px] text-fg-muted">
                {b.concurrency === 0 ? 'all at once' : b.concurrency === 1 ? `one at a time, ${b.order}` : `${b.concurrency} at a time, ${b.order}`}
              </TableCell>
              <TableCell className="readout text-[11.5px] text-fg-muted">{relativeTime(b.createdAt)}</TableCell>
            </>
          )}
          empty={{
            icon: <Boxes className="size-4" aria-hidden />,
            title: 'No batches yet',
            description: 'Run a script across a cluster or a multi-device selection from the Scripts page to see its report here.',
            action: (
              <Button asChild>
                <Link href="/scripts">Open Scripts</Link>
              </Button>
            ),
          }}
        />
      </div>
    </>
  )
}
