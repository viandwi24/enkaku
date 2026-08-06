import { ListAgentsResponseSchema, ListThreadsResponseSchema, RunResponseSchema, ThreadMessagesResponseSchema, type AgentThread, type AgentUsage } from '@enkaku/protocol'
import { api } from './actions'

/**
 * Usage aggregation, composed client-side from endpoints Plans 65/66/68
 * already ship (plan 69 §2 — no new backend capability).
 *
 * THE GAP, RECORDED RATHER THAN WORKED AROUND SILENTLY: no plan through 68
 * ever added a "list runs for an agent" or "list runs for a thread" REST
 * endpoint, and no endpoint anywhere returns an OBSERVED spend figure (only
 * `FarmSettings.scheduledAgents`'s CAP is exposed, via `/api/settings`). The
 * only way to learn a run's `usage` is `GET /api/v1/runs/:id`, and the only
 * way to learn a run's id at all is a message's own `runId` field. So this
 * walks agent → threads → (bounded) messages → unique run ids → run usage,
 * which is real data, not a guess, but it is O(threads × messages) HTTP
 * calls rather than one aggregate query. It is bounded below (recent threads
 * only, deduped run ids) to keep that honest on a busy farm.
 *
 * A proper fix belongs in a future plan: an aggregate endpoint (e.g.
 * `GET /api/agents/:id/usage` and a farm-wide equivalent) would make this
 * exact AND cheap. Recorded here and in this plan's final report rather
 * than added quietly, per `CLAUDE.md`'s "no new backend capability" rule.
 */

export interface DailyUsage {
  /** `YYYY-MM-DD`, local to the browser. */
  day: string
  usage: AgentUsage
}

function emptyUsage(): AgentUsage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 }
}

function addUsage(a: AgentUsage, b: AgentUsage): AgentUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    costUsd: (a.costUsd ?? 0) + (b.costUsd ?? 0),
  }
}

function dayKey(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString().slice(0, 10)
}

/** Every unique, non-null `runId` referenced by a bounded window of a thread's messages. */
async function recentRunIdsForThread(threadId: string, sinceEpochSec: number): Promise<string[]> {
  const { messages } = await api(`/api/v1/threads/${threadId}/messages`, ThreadMessagesResponseSchema)
  const ids = new Set<string>()
  for (const m of messages) {
    if (m.runId && m.createdAt >= sinceEpochSec) ids.add(m.runId)
  }
  return [...ids]
}

/**
 * The last `windowDays` of usage for one agent, bucketed by day, plus a
 * total — for the agent card's sparkline (plan 69 §3.4). Bounded to the
 * `maxThreads` most recently updated threads so an agent with a long history
 * does not turn one card into hundreds of requests.
 */
export async function fetchAgentUsage(agentId: string, opts?: { windowDays?: number; maxThreads?: number }): Promise<{ days: DailyUsage[]; total: AgentUsage; truncated: boolean }> {
  const windowDays = opts?.windowDays ?? 14
  const maxThreads = opts?.maxThreads ?? 15
  const since = Math.floor(Date.now() / 1000) - windowDays * 86400

  const { threads } = await api(`/api/v1/threads?agentId=${agentId}`, ListThreadsResponseSchema)
  const recentThreads = threads.filter((t) => t.updatedAt >= since).slice(0, maxThreads)
  const truncated = threads.filter((t) => t.updatedAt >= since).length > recentThreads.length

  const runIdLists = await Promise.all(recentThreads.map((t) => recentRunIdsForThread(t.id, since).catch(() => [])))
  const runIds = [...new Set(runIdLists.flat())]

  const runs = await Promise.all(
    runIds.map((id) =>
      api(`/api/v1/runs/${id}`, RunResponseSchema)
        .then((b) => b.run)
        .catch(() => null),
    ),
  )

  const byDay = new Map<string, AgentUsage>()
  let total = emptyUsage()
  for (const run of runs) {
    if (!run || !run.usage) continue
    const at = run.finishedAt ?? run.startedAt
    if (!at || at < since) continue
    const key = dayKey(at)
    byDay.set(key, addUsage(byDay.get(key) ?? emptyUsage(), run.usage))
    total = addUsage(total, run.usage)
  }

  const days: DailyUsage[] = []
  for (let i = windowDays - 1; i >= 0; i--) {
    const key = dayKey(Math.floor(Date.now() / 1000) - i * 86400)
    days.push({ day: key, usage: byDay.get(key) ?? emptyUsage() })
  }

  return { days, total, truncated }
}

/**
 * Farm-wide output tokens spent by SCHEDULED runs in the last 24 hours —
 * the SAME metric `FarmSettings.scheduledAgents.spendCapOutputTokensPer24h`
 * caps (`schedules/runner.ts`'s `fireAgentOnce`, counted only over
 * `agent_threads.origin = 'schedule'`), so the Settings → Spend section can
 * show the cap beside the number it is actually capping (plan 69 §3.4: "so
 * a cap can be set against an observed number rather than a guess").
 *
 * Composed the same way as `fetchAgentUsage` (see this file's own doc for
 * the backend gap) — bounded to each agent's most recently updated
 * schedule-origin threads.
 */
export async function fetchScheduledSpendLast24h(): Promise<{ outputTokens: number; truncated: boolean }> {
  const since = Math.floor(Date.now() / 1000) - 86400
  const { agents } = await api('/api/agents', ListAgentsResponseSchema)

  let outputTokens = 0
  let truncated = false

  await Promise.all(
    agents.map(async (agent) => {
      const { threads } = await api(`/api/v1/threads?agentId=${agent.id}`, ListThreadsResponseSchema).catch(() => ({ threads: [] as AgentThread[] }))
      const scheduled = threads.filter((t) => t.origin === 'schedule' && t.updatedAt >= since)
      const bounded = scheduled.slice(0, 15)
      if (bounded.length < scheduled.length) truncated = true

      const runIdLists = await Promise.all(bounded.map((t) => recentRunIdsForThread(t.id, since).catch(() => [])))
      const runIds = [...new Set(runIdLists.flat())]
      const runs = await Promise.all(
        runIds.map((id) =>
          api(`/api/v1/runs/${id}`, RunResponseSchema)
            .then((b) => b.run)
            .catch(() => null),
        ),
      )
      for (const run of runs) {
        const at = run?.finishedAt ?? run?.startedAt
        if (run?.usage && at && at >= since) outputTokens += run.usage.outputTokens
      }
    }),
  )

  return { outputTokens, truncated }
}
