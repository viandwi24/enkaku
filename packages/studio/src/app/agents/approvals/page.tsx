'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { ArrowLeft, Inbox } from 'lucide-react'
import { ApprovalResponseSchema } from '@enkaku/protocol'
import { PageHeader } from '@/components/layout/PageHeader'
import { EmptyState, ErrorState, LoadingRows, Button, api, useAction } from '@enkaku/ui'
import { ApprovalCard } from '@/components/agent/ApprovalCard'
import { fetchPendingApprovals, type ApprovalWithContext } from '@/lib/agent-approvals'

/**
 * The approvals inbox (plan 69 §3.3, step 69.6) — every pending approval
 * across every agent, findable without knowing which thread it is in.
 * Plan 66 renders an approval inline in its own thread, which is right when
 * you are watching; this is for the three that paused an hour ago in
 * threads nobody has open.
 *
 * Composed from existing endpoints (`lib/agent-approvals.ts` — see its own
 * doc comment for the backend gap this works around: no endpoint lists
 * pending approvals farm-wide). Because that composition cannot subscribe
 * to a live event either, this page polls rather than streams.
 *
 * Criterion 7's hard requirement: the input is shown COMPLETE, never
 * truncated — `ApprovalCard` scrolls a long input inside its own box rather
 * than eliding it, because an elided argument is exactly where a prompt
 * injection hides.
 */
export default function ApprovalsInboxPage() {
  const [items, setItems] = useState<ApprovalWithContext[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const { run: doAction, isPending } = useAction()

  const load = useCallback(() => {
    setError(null)
    fetchPendingApprovals()
      .then(setItems)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }, [])

  useEffect(() => {
    load()
    // No farm-wide event exists for "an approval was requested" (see the module doc) — polled
    // every 20s, which is frequent enough for a queue whose entries live up to an hour (the
    // approval TTL) without hammering the composition's O(agents × threads) cost.
    const id = setInterval(load, 20_000)
    return () => clearInterval(id)
  }, [load])

  const decide = (item: ApprovalWithContext, decision: 'approve' | 'deny') => {
    void doAction(`decide-${item.approval.id}-${decision}`, () => api(`/api/v1/approvals/${item.approval.id}`, ApprovalResponseSchema, { method: 'POST', json: { decision } }), {
      success: decision === 'approve' ? 'Approved — the run resumes' : 'Denied',
      failure: 'Could not record the decision',
      onSuccess: () => setItems((prev) => (prev ? prev.filter((p) => p.approval.id !== item.approval.id) : prev)),
    })
  }

  return (
    <>
      <PageHeader
        title="Approvals"
        description="Every pending approval, across every agent, in one place"
        meta={
          <Button asChild variant="ghost" size="sm">
            <Link href="/agents">
              <ArrowLeft className="size-3.5" aria-hidden />
              Agents
            </Link>
          </Button>
        }
      />

      <div className="mx-auto max-w-2xl space-y-3 px-5 py-4">
        {error ? (
          <ErrorState message={error} onRetry={load} />
        ) : items === null ? (
          <LoadingRows rows={3} />
        ) : items.length === 0 ? (
          <EmptyState icon={<Inbox className="size-4" aria-hidden />} title="Nothing pending" description="A paused destructive call will appear here the moment it is requested, wherever it happens." />
        ) : (
          items.map((item) => (
            <ApprovalCard
              key={item.approval.id}
              approval={item.approval}
              context={{ agentName: item.agent.name, agentColour: item.agent.colour, threadTitle: item.thread.title }}
              onDecide={(decision) => decide(item, decision)}
              pendingDecision={isPending(`decide-${item.approval.id}-approve`) ? 'approve' : isPending(`decide-${item.approval.id}-deny`) ? 'deny' : null}
            />
          ))
        )}
      </div>
    </>
  )
}
