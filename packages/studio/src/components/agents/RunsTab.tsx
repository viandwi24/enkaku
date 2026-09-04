'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import type { AgentRunStatus } from '@enkaku/protocol'
import { Badge, Button, EmptyState, ErrorState, LoadingRows, cn, duration, formatUsd, relativeTime } from '@enkaku/ui'
import { UsageBadge } from '@/components/agent/UsageBadge'
import { fetchAllRuns, type RunWithAgent } from '@/lib/agent-runs'

const CHIPS: { key: 'all' | AgentRunStatus; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'running', label: 'Running' },
  { key: 'queued', label: 'Queued' },
  { key: 'succeeded', label: 'Succeeded' },
  { key: 'failed', label: 'Failed' },
]

const DOT: Record<AgentRunStatus, string> = {
  queued: 'bg-fg-subtle',
  running: 'bg-led-warn animate-enkaku-pulse',
  paused: 'bg-led-warn',
  succeeded: 'bg-led-ok',
  failed: 'bg-led-danger',
  cancelled: 'bg-fg-subtle',
}

/**
 * The Agents page's Runs tab (plan 220 §4.10) — farm-wide, not per-agent
 * (today's `/agents/runs?agent=` was scoped to one agent). Layout borrowed
 * from the Jobs screen (§3.1): a 268px left list with wrapping filter chips
 * and a state-dot + name + indented sub-line row, a right detail panel with
 * a header meta line and a right-pushed button group. `?agent=` (from
 * `/agents/detail`'s own Runs link) pre-filters the list to one agent
 * without changing the tab's own farm-wide default.
 */
export function RunsTab() {
  const agentFilter = useSearchParams().get('agent')
  const [data, setData] = useState<{ runs: RunWithAgent[]; truncated: boolean } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<(typeof CHIPS)[number]['key']>('all')
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const load = () => {
    setError(null)
    fetchAllRuns()
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }
  useEffect(load, [])

  const scoped = useMemo(() => {
    const base = data?.runs ?? []
    const byAgent = agentFilter ? base.filter((r) => r.agentId === agentFilter) : base
    return filter === 'all' ? byAgent : byAgent.filter((r) => r.run.status === filter)
  }, [data, agentFilter, filter])

  const counts = useMemo(() => {
    const base = agentFilter ? (data?.runs ?? []).filter((r) => r.agentId === agentFilter) : data?.runs ?? []
    return CHIPS.map((c) => ({ ...c, n: c.key === 'all' ? base.length : base.filter((r) => r.run.status === c.key).length }))
  }, [data, agentFilter])

  const selected = scoped.find((r) => r.run.id === selectedId) ?? scoped[0] ?? null

  if (error) return <div className="px-5 py-4"><ErrorState message={error} onRetry={load} /></div>
  if (data === null) return <div className="px-5 py-4"><LoadingRows rows={4} /></div>

  return (
    <div className="flex h-full min-h-0">
      <div className="flex w-[268px] shrink-0 flex-col border-r border-line">
        <div className="flex flex-wrap gap-1.5 border-b border-line p-2.5">
          {counts.map((c) => (
            <button
              key={c.key}
              type="button"
              onClick={() => setFilter(c.key)}
              className={cn('rounded-lg px-2.5 py-1 text-[11.5px]', filter === c.key ? 'bg-accent-soft text-accent' : 'text-fg-muted hover:bg-surface-2')}
            >
              {c.label} <span className="readout">{c.n}</span>
            </button>
          ))}
        </div>
        {scoped.length === 0 ? (
          <div className="p-4"><EmptyState title="No runs" description="A run appears here once an agent has been sent a message, or a schedule has fired it." /></div>
        ) : (
          <ul className="min-h-0 flex-1 overflow-y-auto">
            {scoped.map((r) => (
              <li key={r.run.id}>
                <button
                  type="button"
                  onClick={() => setSelectedId(r.run.id)}
                  className={cn('flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left', selected?.run.id === r.run.id ? 'bg-accent-soft' : 'hover:bg-surface-2')}
                >
                  <span className="flex items-center gap-1.5">
                    <span className={cn('size-1.5 shrink-0 rounded-full', DOT[r.run.status])} aria-hidden />
                    <span className="readout text-[12px]">{r.agentName}</span>
                  </span>
                  <span className="pl-3 text-[11px] text-fg-subtle">
                    {r.run.status}
                    {r.run.stopReason ? ` · ${r.run.stopReason}` : ''} · {relativeTime(r.run.startedAt ?? 0)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        {selected === null ? (
          <EmptyState title="No run selected" description="Pick one from the list." />
        ) : (
          <div className="space-y-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="text-[15px] font-medium">{selected.agentName}</h2>
                  <Badge variant={selected.run.status === 'failed' ? 'destructive' : ['succeeded', 'cancelled'].includes(selected.run.status) ? 'secondary' : 'default'}>{selected.run.status}</Badge>
                </div>
                <p className="readout mt-0.5 text-[12px] text-fg-muted">
                  {selected.run.id} · {selected.run.steps} step{selected.run.steps === 1 ? '' : 's'} · {duration(selected.run.startedAt, selected.run.finishedAt)}
                </p>
              </div>
              <Button asChild size="sm">
                <Link href={`/agents/detail?id=${selected.agentId}&thread=${selected.run.threadId}`}>Open thread</Link>
              </Button>
            </div>
            {selected.run.stopReason && <p className="text-[12.5px] text-fg-muted">stop reason: {selected.run.stopReason}</p>}
            {selected.run.errorClass && <p className="text-[12.5px] text-led-danger">error: {selected.run.errorClass}</p>}
            {selected.run.usage && <UsageBadge usage={selected.run.usage} />}
            {selected.run.usage && <p className="text-[11.5px] text-fg-subtle">total {formatUsd(selected.run.usage.costUsd)}</p>}
          </div>
        )}
      </div>
    </div>
  )
}
