'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { Plus, Workflow as WorkflowIcon } from 'lucide-react'
import { JobsPageResponseSchema, ScriptGroupsPageResponseSchema, ScriptResponseSchema, type JobInfo } from '@enkaku/protocol'
import { PageHeader } from '@/components/layout/PageHeader'
import { PaginatedTable, type Page } from '@/components/PaginatedTable'
import { Button, TableCell, TableHead, api, relativeTime } from '@enkaku/ui'

/** One row per workflow NAME (`GET /api/scripts?group=name&kind=workflow`, plan 99 §4.11) — the same grouped shape the Scripts list already renders. */
interface WorkflowGroupRow {
  id: string
  name: string
  latestVersion: string
  versionCount: number
  lastPublishedAt: number | null
  enabled: boolean
}

/**
 * The Workflows list (plan 99 §4.11). A workflow is an ordinary `scripts`
 * row (`kind: 'workflow'`) — it already appears in the general Scripts list
 * and already runs from the general run dialog with no code written here;
 * this screen exists as the curated authoring surface, with the one action
 * that page has no room for: **New workflow**, straight into the editor.
 */
export default function WorkflowsPage() {
  const [nodeCounts, setNodeCounts] = useState<Record<string, number>>({})
  const [lastRun, setLastRun] = useState<Record<string, number>>({})
  const loadedNodeCounts = useRef(new Set<string>())

  // A bounded, one-time scan of recent jobs (the same "no per-script filter"
  // shape `scripts/detail/page.tsx`'s own `fetchRuns` already works around) —
  // matched by `scriptName`, so a run of an OLDER published version of a
  // workflow still counts as "last run" for its row, not just the latest.
  useEffect(() => {
    void (async () => {
      const latest: Record<string, number> = {}
      let cursor: string | null = null
      for (let page = 0; page < 5; page++) {
        const body: Page<JobInfo> = await api(`/api/jobs?limit=200${cursor ? `&cursor=${cursor}` : ''}`, JobsPageResponseSchema)
        for (const job of body.items) {
          if (!job.scriptName) continue
          if (!latest[job.scriptName] || job.createdAt > latest[job.scriptName]!) latest[job.scriptName] = job.createdAt
        }
        cursor = body.nextCursor
        if (!cursor) break
      }
      setLastRun(latest)
    })().catch(() => undefined)
  }, [])

  const loadNodeCount = (row: WorkflowGroupRow) => {
    if (loadedNodeCounts.current.has(row.id)) return
    loadedNodeCounts.current.add(row.id)
    void api(`/api/scripts/${row.id}`, ScriptResponseSchema)
      .then((b) => setNodeCounts((prev) => ({ ...prev, [row.id]: b.script.workflow?.nodes.length ?? 0 })))
      .catch(() => undefined)
  }

  return (
    <>
      <PageHeader
        title="Workflows"
        description="Pipelines of scripts on one device, under one job"
        actions={
          <Button asChild size="sm">
            <Link href="/workflows/editor">
              <Plus className="size-4" aria-hidden />
              New workflow
            </Link>
          </Button>
        }
      />

      <div className="space-y-4 px-5 py-4">
        <PaginatedTable<WorkflowGroupRow>
          fetchPage={(cursor) => api(`/api/scripts?group=name&kind=workflow${cursor ? `&cursor=${cursor}` : ''}`, ScriptGroupsPageResponseSchema)}
          rowKey={(w) => w.id}
          header={
            <>
              <TableHead className="w-[32%]">Name</TableHead>
              <TableHead>Latest</TableHead>
              <TableHead>Versions</TableHead>
              <TableHead>Nodes</TableHead>
              <TableHead>Last run</TableHead>
              <TableHead>Published</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </>
          }
          renderRow={(w) => {
            loadNodeCount(w)
            const count = nodeCounts[w.id]
            const ran = lastRun[w.name]
            return (
              <>
                <TableCell>
                  <Link href={`/workflows/editor?name=${encodeURIComponent(w.name)}`} className="font-medium hover:text-accent">
                    {w.name}
                  </Link>
                  {!w.enabled && <span className="readout ml-2 text-[10.5px] text-fg-subtle">disabled</span>}
                </TableCell>
                <TableCell className="readout text-[12px] text-fg-muted">{w.latestVersion}</TableCell>
                <TableCell className="readout text-[12px] text-fg-muted">
                  {w.versionCount} version{w.versionCount === 1 ? '' : 's'}
                </TableCell>
                <TableCell className="readout text-[12px] text-fg-muted">{count === undefined ? '…' : count}</TableCell>
                <TableCell className="readout text-[11.5px] text-fg-muted">{ran ? relativeTime(ran) : 'never'}</TableCell>
                <TableCell className="readout text-[11.5px] text-fg-muted">{relativeTime(w.lastPublishedAt)}</TableCell>
                <TableCell className="text-right">
                  <Button asChild size="sm" variant="secondary" className="h-7 text-[12px]">
                    <Link href={`/workflows/editor?name=${encodeURIComponent(w.name)}`}>Edit</Link>
                  </Button>
                </TableCell>
              </>
            )
          }}
          empty={{
            icon: <WorkflowIcon className="size-4" aria-hidden />,
            title: 'No workflows yet',
            description: 'A workflow is a pipeline of scripts on one device — build one in the editor.',
            action: (
              <Button asChild size="sm">
                <Link href="/workflows/editor">
                  <Plus className="size-4" aria-hidden />
                  New workflow
                </Link>
              </Button>
            ),
          }}
        />
      </div>
    </>
  )
}
