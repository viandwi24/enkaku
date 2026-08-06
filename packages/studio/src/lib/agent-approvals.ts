import { ApprovalsResponseSchema, ListAgentsResponseSchema, ListThreadsResponseSchema, type AgentApproval, type AgentThread } from '@enkaku/protocol'
import { api } from './actions'
import type { Agent } from './agents'
import { latestRunId } from './agent-runs'

/**
 * The approvals inbox's data source (plan 69 §3.3, step 69.6) — composed
 * client-side from endpoints Plans 65–67 already ship (plan 69 §2 — no new
 * backend capability).
 *
 * THE GAP, RECORDED RATHER THAN WORKED AROUND SILENTLY: Plan 66 built
 * `GET /runs/:id/approvals` (scoped to one run you already know the id of)
 * and a per-thread WS broadcast (`agent.approval.requested`, delivered only
 * to a connection that has `agent.subscribe`d that exact thread). Neither
 * one answers "what is pending, anywhere, right now" — there is no
 * `GET /api/v1/approvals?status=pending` and no farm-wide broadcast. So this
 * walks agent → threads → (bounded) messages → latest run id → that run's
 * approvals, which is real, current data, but it costs one HTTP round trip
 * PER THREAD rather than one query, and it cannot update itself live (no
 * global event to listen for) — the page polls instead.
 *
 * A proper fix belongs in a future plan: a `pendingApprovals()` query on
 * `ApprovalStore` (trivial — it already has every other shape of this query)
 * plus a REST route and a farm-wide broadcast would make this exact, cheap,
 * and live. Recorded here and in this plan's final report rather than added
 * quietly, per `CLAUDE.md`'s "no new backend capability" rule.
 */

export interface ApprovalWithContext {
  approval: AgentApproval
  agent: Agent
  thread: AgentThread
}

/**
 * Every pending approval across every agent (plan 69 §3.3, criterion 7).
 * Bounded to threads updated within `windowHours` — an approval's own TTL is
 * one hour by default (`agent/approval/store.ts`), so a thread that pending
 * approval belongs to was, by construction, touched at least that recently.
 */
export async function fetchPendingApprovals(opts?: { windowHours?: number; maxThreadsPerAgent?: number }): Promise<ApprovalWithContext[]> {
  const windowHours = opts?.windowHours ?? 6
  const maxThreadsPerAgent = opts?.maxThreadsPerAgent ?? 20
  const since = Math.floor(Date.now() / 1000) - windowHours * 3600

  const { agents } = await api('/api/agents', ListAgentsResponseSchema)
  const out: ApprovalWithContext[] = []

  await Promise.all(
    agents.map(async (agent) => {
      const { threads } = await api(`/api/v1/threads?agentId=${agent.id}`, ListThreadsResponseSchema).catch(() => ({ threads: [] as AgentThread[] }))
      const recent = threads.filter((t) => t.updatedAt >= since).slice(0, maxThreadsPerAgent)

      await Promise.all(
        recent.map(async (thread) => {
          const runId = await latestRunId(thread.id).catch(() => null)
          if (!runId) return
          const { approvals } = await api(`/api/v1/runs/${runId}/approvals`, ApprovalsResponseSchema).catch(() => ({ approvals: [] as AgentApproval[] }))
          for (const approval of approvals) {
            if (approval.status === 'pending') out.push({ approval, agent, thread })
          }
        }),
      )
    }),
  )

  return out.sort((a, b) => a.approval.createdAt - b.approval.createdAt)
}
