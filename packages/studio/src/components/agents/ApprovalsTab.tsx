'use client'

import { TrayIcon } from '@enkaku/ui'
import { ApprovalResponseSchema } from '@enkaku/protocol'
import { EmptyState, ErrorState, LoadingRows, api, useAction } from '@enkaku/ui'
import { ApprovalCard } from '@/components/agent/ApprovalCard'
import type { ApprovalWithContext } from '@/lib/agent-approvals'

/**
 * The Agents page's Approvals tab (plan 220 §4.5, moved from
 * `app/agents/approvals/page.tsx` — plan 69 §3.3, step 69.6). Every pending
 * approval across every agent, findable without knowing which thread it is
 * in. `approvals`/`error`/`reload` (with its 20s poll) come from `AgentsPage`
 * so the tab-strip count and this list never disagree.
 *
 * Criterion 7's hard requirement: the input is shown COMPLETE, never
 * truncated — `ApprovalCard` scrolls a long input inside its own box rather
 * than eliding it, because an elided argument is exactly where a prompt
 * injection hides.
 */
export function ApprovalsTab({
  approvals: items,
  error,
  reload,
}: {
  approvals: ApprovalWithContext[] | null
  error: string | null
  reload(): void
}) {
  const { run: doAction, isPending } = useAction()

  const decide = (item: ApprovalWithContext, decision: 'approve' | 'deny') => {
    void doAction(`decide-${item.approval.id}-${decision}`, () => api(`/api/v1/approvals/${item.approval.id}`, ApprovalResponseSchema, { method: 'POST', json: { decision } }), {
      success: decision === 'approve' ? 'Approved — the run resumes' : 'Denied',
      failure: 'Could not record the decision',
      onSuccess: reload,
    })
  }

  return (
    <div className="mx-auto max-w-2xl space-y-3 px-5 py-4">
      {error ? (
        <ErrorState message={error} onRetry={reload} />
      ) : items === null ? (
        <LoadingRows rows={3} />
      ) : items.length === 0 ? (
        <EmptyState icon={<TrayIcon className="size-4" aria-hidden />} title="Nothing pending" description="A paused destructive call will appear here the moment it is requested, wherever it happens." />
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
  )
}
