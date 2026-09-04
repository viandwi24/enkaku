import type { WorkflowDocDraft, WorkflowNodeDraft } from './model'

/**
 * Plan 102 (M67) §3.2, §3.3, §4.1, step 102.1 — the canvas's data half, a
 * PURE function with no React and no rendering, testable without a
 * component (the same shape `packages/studio/src/components/wall/
 * tile-identity.ts` already uses). Rewritten for doc v2's explicit edges by
 * plan 301 §4.1, §5 step 301.6: every edge is a node id field on the node
 * itself (`next`/`onFailure`/`then`/`else`) — array order carries no control
 * meaning any more (plan 300 D1), so this function reads edges straight off
 * each node, never off array adjacency.
 *
 * An edge is NEVER written back from here — it is a projection of `next`/
 * `onFailure`/`then`/`else`, never independent state (plan 102 §3.3). A
 * dangling target (an edge field absent, or naming an id absent from the
 * document) is silently not drawn rather than thrown on — `checkWorkflow`
 * (`workflow-check.ts`) is the place that already flags that as a
 * validation finding; this function's job is only to describe the graph the
 * EXECUTOR would actually walk, which stops at that same dangling edge.
 */

export type GraphNodeKind = WorkflowNodeDraft['kind']

export interface GraphNode {
  id: string
  kind: GraphNodeKind
  /** The node's title if it has one, else its id — the same fallback `edges.ts`'s `titleOf` already uses. */
  label: string
}

/** Which field on the source node produced this edge. */
export type EdgeKind = 'next' | 'onFailure' | 'then' | 'else'

export interface GraphEdge {
  from: string
  to: string
  kind: EdgeKind
  /**
   * True when `to` sorts at or before `from` in document (array) order —
   * only possible via an edge that names an earlier-or-equal node id (plan
   * 102 G5: an edge may point backward, so the graph is not a DAG). This is
   * the single most valuable thing the canvas shows that the list cannot
   * (plan 102 §4.2), so it is a field on the edge, not something a renderer
   * has to re-derive from node positions.
   */
  backward: boolean
}

export interface DerivedGraph {
  nodes: GraphNode[]
  edges: GraphEdge[]
  /**
   * Node ids no edge (from any other node) targets, excluding `doc.entry`
   * (the one `start` node, which needs nothing pointing at it to be
   * reachable). A real authoring bug the list editor cannot surface (plan
   * 102 §4.3) — `Validate` reads this SAME field rather than
   * reimplementing reachability, so the canvas's markers and the list
   * editor's Validate button can never disagree about which nodes are
   * unreachable.
   */
  unreachable: string[]
}

function labelOf(node: WorkflowNodeDraft): string {
  return node.title.trim() || node.id
}

export function deriveGraph(draft: WorkflowDocDraft): DerivedGraph {
  const nodes = draft.nodes
  const indexOf = new Map(nodes.map((n, i) => [n.id, i]))
  const graphNodes: GraphNode[] = nodes.map((n) => ({ id: n.id, kind: n.kind, label: labelOf(n) }))
  const edges: GraphEdge[] = []

  function addEdge(fromId: string, fromIndex: number, to: string | undefined, kind: EdgeKind): void {
    if (to === undefined) return
    const toIndex = indexOf.get(to)
    if (toIndex === undefined) return // a dangling reference — not this function's job to flag (see module doc)
    edges.push({ from: fromId, to, kind, backward: toIndex <= fromIndex })
  }

  nodes.forEach((node, index) => {
    if (node.kind === 'start') {
      addEdge(node.id, index, node.next, 'next')
    } else if (node.kind === 'script') {
      addEdge(node.id, index, node.next, 'next')
      addEdge(node.id, index, node.onFailure, 'onFailure')
    } else if (node.kind === 'gate') {
      addEdge(node.id, index, node.then, 'then')
      addEdge(node.id, index, node.else, 'else')
    }
    // `finish` is a sink — no outgoing edge.
  })

  const targeted = new Set(edges.map((e) => e.to))
  const unreachable = nodes.filter((n) => n.id !== draft.entry && !targeted.has(n.id)).map((n) => n.id)

  return { nodes: graphNodes, edges, unreachable }
}
