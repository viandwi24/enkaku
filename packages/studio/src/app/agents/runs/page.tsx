'use client'

import { Suspense, useEffect, useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'
import type { AgentRun } from '@enkaku/protocol'
import { AgentResponseSchema } from '@enkaku/protocol'
import { PageHeader } from '@/components/layout/PageHeader'
import { EmptyState, ErrorState, LoadingRows } from '@/components/states'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { api } from '@/lib/actions'
import type { Agent } from '@/lib/agents'
import { fetchRecentRuns } from '@/lib/agent-runs'
import { duration, formatUsd, relativeTime } from '@/lib/format'

/**
 * Run history for one agent (plan 69 §4.1: `/agents/runs?agent=` — status,
 * stop reason, steps, duration, cost). Composed from existing endpoints —
 * see `lib/agent-runs.ts`'s `fetchRecentRuns` for the backend gap this
 * works around (no "list runs for an agent" endpoint exists).
 */
function RunHistory() {
  const params = useSearchParams()
  const agentId = params.get('agent')
  const [agent, setAgent] = useState<Agent | null>(null)
  const [runs, setRuns] = useState<AgentRun[] | null>(null)
  const [truncated, setTruncated] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = () => {
    if (!agentId) return
    setError(null)
    void api(`/api/agents/${agentId}`, AgentResponseSchema).then((b) => setAgent(b.agent))
    fetchRecentRuns(agentId)
      .then((r) => {
        setRuns(r.runs)
        setTruncated(r.truncated)
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }
  useEffect(load, [agentId])

  if (!agentId) return <ErrorState message="No agent specified." />

  return (
    <>
      <PageHeader
        title={agent ? `Runs — ${agent.name}` : 'Runs'}
        description="Status, stop reason, steps, duration, and cost — most recent first"
        meta={
          <Button asChild variant="ghost" size="sm">
            <Link href={`/agents/detail?id=${agentId}`}>
              <ArrowLeft className="size-3.5" aria-hidden />
              Back to agent
            </Link>
          </Button>
        }
      />

      <div className="px-5 py-4">
        {error ? (
          <ErrorState message={error} onRetry={load} />
        ) : runs === null ? (
          <LoadingRows rows={4} />
        ) : runs.length === 0 ? (
          <EmptyState title="No runs yet" description="A run appears here once this agent has been sent a message, or a schedule has fired it." />
        ) : (
          <div className="overflow-hidden rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Status</TableHead>
                  <TableHead>Stop reason</TableHead>
                  <TableHead>Steps</TableHead>
                  <TableHead>Duration</TableHead>
                  <TableHead>Cost</TableHead>
                  <TableHead>Started</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {runs.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell>
                      <Badge variant={r.status === 'failed' ? 'destructive' : ['succeeded', 'cancelled'].includes(r.status) ? 'secondary' : 'default'}>{r.status}</Badge>
                    </TableCell>
                    <TableCell className="readout text-[12px] text-fg-muted">{r.stopReason ?? '—'}</TableCell>
                    <TableCell className="readout text-[12.5px]">{r.steps}</TableCell>
                    <TableCell className="readout text-[12px] text-fg-muted">{duration(r.startedAt, r.finishedAt)}</TableCell>
                    <TableCell className="readout text-[12.5px]">{r.usage ? formatUsd(r.usage.costUsd) : '—'}</TableCell>
                    <TableCell className="readout text-[11.5px] text-fg-muted">{relativeTime(r.startedAt)}</TableCell>
                    <TableCell className="text-right">
                      <Link href={`/agents/detail?id=${agentId}&thread=${r.threadId}`} className="text-[12px] text-accent hover:underline">
                        Open thread
                      </Link>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
        {truncated && <p className="mt-2 text-[11px] text-fg-subtle">Showing this agent's most recently active threads — not its full history.</p>}
      </div>
    </>
  )
}

export default function AgentRunsPage() {
  return (
    <Suspense fallback={<div className="px-5 py-4"><LoadingRows rows={4} /></div>}>
      <RunHistory />
    </Suspense>
  )
}
