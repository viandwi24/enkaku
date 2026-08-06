import type { AgentTreeNode } from '@enkaku/protocol'

/**
 * Every descendant of `rootId`, at any depth, from a flat tree node list
 * (plan 67 §4.4, §4.5) — the API returns the whole tree flat; the client
 * reconstructs parent/child edges from `parentRunId`. Shared by the
 * workbench (the Cancel confirmation's subtree count) and `ChildRunCard`'s
 * caller.
 */
export function subtreeOf(nodes: AgentTreeNode[], rootId: string): AgentTreeNode[] {
  const byParent = new Map<string, AgentTreeNode[]>()
  for (const n of nodes) {
    if (!n.parentRunId) continue
    const list = byParent.get(n.parentRunId) ?? []
    list.push(n)
    byParent.set(n.parentRunId, list)
  }
  const out: AgentTreeNode[] = []
  const queue = [...(byParent.get(rootId) ?? [])]
  while (queue.length > 0) {
    const n = queue.shift()!
    out.push(n)
    queue.push(...(byParent.get(n.runId) ?? []))
  }
  return out
}
