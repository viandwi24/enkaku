'use client'

import { useCallback, useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { ListAgentsResponseSchema } from '@enkaku/protocol'
import { api } from '@enkaku/ui'
import { EntityTabs, type EntityTab } from '@/components/layout/EntityTabs'
import type { Agent } from '@/lib/agents'
import { fetchPendingApprovals, type ApprovalWithContext } from '@/lib/agent-approvals'
import { RosterTab } from './RosterTab'
import { RunsTab } from './RunsTab'
import { ApprovalsTab } from './ApprovalsTab'
import { FilesTab } from './FilesTab'
import { SettingsTab } from './SettingsTab'

const TABS: EntityTab[] = [
  { key: 'roster', label: 'Roster' },
  { key: 'runs', label: 'Runs' },
  { key: 'approvals', label: 'Approvals' },
  { key: 'files', label: 'Files' },
  { key: 'settings', label: 'Settings' },
]

/**
 * `/agents` (plan 220) — Roster, Runs, Approvals, Files, and Settings on one
 * page, replacing `/agents` (roster only), `/agents/approvals`,
 * `/agents/runs`, `/agents/thread` (a redirect), and `/workspace`
 * (MVP 13 A.6). `/agents/detail?id=` is a SEPARATE, unaffected route — this
 * page is the roster and the farm-wide surfaces around it, not the per-agent
 * workbench.
 *
 * The tab strip is the page header (§3.1 — borrowed from the Jobs screen,
 * README:326-328): no `PageHeader`, no "Agents / N total" title. Roster and
 * Approvals carry a live count (agents on the farm; approvals pending right
 * now) fetched ONCE here and passed down, so the badge and the tab body never
 * disagree and never double the O(agents) / O(agents × threads) query cost
 * `lib/agents.ts` and `lib/agent-approvals.ts` already document.
 */
function AgentsScreen() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const requestedTab = searchParams.get('tab')
  const tab = TABS.some((t) => t.key === requestedTab) ? (requestedTab as string) : 'roster'

  const [agents, setAgents] = useState<Agent[] | null>(null)
  const [agentsError, setAgentsError] = useState<string | null>(null)
  const loadAgents = useCallback(() => {
    setAgentsError(null)
    api('/api/agents', ListAgentsResponseSchema)
      .then((b) => setAgents(b.agents))
      .catch((e) => setAgentsError(e instanceof Error ? e.message : String(e)))
  }, [])
  useEffect(loadAgents, [loadAgents])

  const [approvals, setApprovals] = useState<ApprovalWithContext[] | null>(null)
  const [approvalsError, setApprovalsError] = useState<string | null>(null)
  const loadApprovals = useCallback(() => {
    setApprovalsError(null)
    fetchPendingApprovals()
      .then(setApprovals)
      .catch((e) => setApprovalsError(e instanceof Error ? e.message : String(e)))
  }, [])
  useEffect(() => {
    loadApprovals()
    // Same 20s cadence as today's `/agents/approvals` (no farm-wide event exists — see
    // `lib/agent-approvals.ts`'s own doc comment for the backend gap this works around).
    const id = setInterval(loadApprovals, 20_000)
    return () => clearInterval(id)
  }, [loadApprovals])

  const tabs: EntityTab[] = TABS.map((t) =>
    t.key === 'roster' ? { ...t, count: agents?.length ?? null } : t.key === 'approvals' ? { ...t, count: approvals?.length ?? null } : t,
  )

  return (
    <div className="flex h-full min-h-0 flex-col">
      <EntityTabs tabs={tabs} active={tab} hrefFor={(k) => (k === 'roster' ? '/agents' : `/agents?tab=${k}`)} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {tab === 'roster' && <RosterTab agents={agents} error={agentsError} reload={loadAgents} onNavigate={(href) => router.push(href)} />}
        {tab === 'runs' && <RunsTab />}
        {tab === 'approvals' && <ApprovalsTab approvals={approvals} error={approvalsError} reload={loadApprovals} />}
        {tab === 'files' && <FilesTab />}
        {tab === 'settings' && <SettingsTab />}
      </div>
    </div>
  )
}

export default function AgentsPage() {
  return <AgentsScreen />
}
