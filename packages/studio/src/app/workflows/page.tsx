'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Plus, Workflow as WorkflowIcon } from 'lucide-react'
import { JobsPageResponseSchema, type JobInfo } from '@enkaku/protocol'
import { PageHeader } from '@/components/layout/PageHeader'
import { PaginatedTable, type Page } from '@/components/PaginatedTable'
import { Button, TableCell, TableHead, api, relativeTime } from '@enkaku/ui'
import { listWorkflows, type WorkflowInfo } from '@/lib/api'

/**
 * The Workflows list (plan 210 §4.9). A workflow is its own table now, no
 * version — this screen exists as the curated authoring surface, with the
 * one action a script's own list has no room for: **New workflow**, straight
 * into the editor.
 */
export default function WorkflowsPage() {
  const [lastRun, setLastRun] = useState<Record<string, number>>({})

  // A bounded, one-time scan of recent jobs (the same "no per-script filter"
  // shape `scripts/detail/page.tsx`'s own `fetchRuns` already works around) —
  // matched by `scriptName`, so a run of an OLDER edit of a workflow still
  // counts as "last run" for its row.
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

  return (
    <>
      <PageHeader
        title="Workflows"
        description="Pipelines of scripts on one device"
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
        <PaginatedTable<WorkflowInfo>
          fetchPage={() => listWorkflows().then((items) => ({ items, nextCursor: null, total: items.length }))}
          rowKey={(w) => w.id}
          header={
            <>
              <TableHead className="w-[32%]">Name</TableHead>
              <TableHead>Steps</TableHead>
              <TableHead>Last run</TableHead>
              <TableHead>Updated</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </>
          }
          renderRow={(w) => {
            const ran = lastRun[w.name]
            return (
              <>
                <TableCell>
                  <Link href={`/workflows/editor?name=${encodeURIComponent(w.name)}`} className="font-medium hover:text-accent">
                    {w.name}
                  </Link>
                </TableCell>
                <TableCell className="readout text-[12px] text-fg-muted">{w.doc.nodes.length}</TableCell>
                <TableCell className="readout text-[11.5px] text-fg-muted">{ran ? relativeTime(ran) : 'never'}</TableCell>
                <TableCell className="readout text-[11.5px] text-fg-muted">{relativeTime(w.updatedAt)}</TableCell>
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
