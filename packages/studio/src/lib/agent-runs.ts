import { ListThreadsResponseSchema, RunResponseSchema, ThreadMessagesResponseSchema, type AgentRun } from '@enkaku/protocol'
import { api } from '@enkaku/ui'

/**
 * Shared helpers for the client-side compositions in `agent-approvals.ts`,
 * `agent-holders.ts`, `agent-usage.ts`, and `/agents/runs` — none of Plans
 * 65–68's endpoints lists runs for a thread directly, but every message
 * carries its own `runId`, so a thread's run ids are recoverable from the
 * message history that already has to be fetched anyway.
 */
export async function latestRunId(threadId: string): Promise<string | null> {
  const { messages } = await api(`/api/v1/threads/${threadId}/messages`, ThreadMessagesResponseSchema)
  let best: { seq: number; runId: string } | null = null
  for (const m of messages) {
    if (m.runId && (!best || m.seq > best.seq)) best = { seq: m.seq, runId: m.runId }
  }
  return best?.runId ?? null
}

/** Every unique, non-null `runId` referenced by a thread's messages. */
async function runIdsForThread(threadId: string): Promise<string[]> {
  const { messages } = await api(`/api/v1/threads/${threadId}/messages`, ThreadMessagesResponseSchema)
  return [...new Set(messages.map((m) => m.runId).filter((id): id is string => id !== null))]
}

/**
 * Run history for one agent (plan 69 §4.1's `/agents/runs?agent=` — status,
 * stop reason, steps, duration, cost). Bounded to `maxThreads` most
 * recently updated threads, same reasoning as `agent-usage.ts`: there is no
 * "list runs for an agent" endpoint, so this is O(threads) HTTP calls
 * rather than one query.
 */
export async function fetchRecentRuns(agentId: string, opts?: { maxThreads?: number }): Promise<{ runs: AgentRun[]; truncated: boolean }> {
  const maxThreads = opts?.maxThreads ?? 25
  const { threads } = await api(`/api/v1/threads?agentId=${agentId}`, ListThreadsResponseSchema)
  const sorted = [...threads].sort((a, b) => b.updatedAt - a.updatedAt)
  const bounded = sorted.slice(0, maxThreads)

  const runIdLists = await Promise.all(bounded.map((t) => runIdsForThread(t.id).catch(() => [])))
  const runIds = [...new Set(runIdLists.flat())]
  const runs = await Promise.all(
    runIds.map((id) =>
      api(`/api/v1/runs/${id}`, RunResponseSchema)
        .then((b) => b.run)
        .catch(() => null),
    ),
  )
  const found = runs.filter((r): r is AgentRun => r !== null)
  found.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))

  return { runs: found, truncated: bounded.length < sorted.length }
}
