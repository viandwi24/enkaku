import type { WorkflowDoc, WorkflowNode } from '@enkaku/protocol'
import { edgeKindsOf, edgeTargetOf, type EdgeKind } from './doc-edit'

/**
 * The canvas's data half (plan 102 §3.2/§3.3/§4.1; rewritten for doc v2's
 * explicit edges by plan 301 §4.1; extended by plan 305 §4.1 to cover all
 * six node kinds — `switch`'s `case:<i>`/`default` and `delay`'s `next`,
 * which plan 303 added after this file was first written). A PURE function,
 * no React, no rendering.
 *
 * An edge is NEVER written back from here — it is a projection of the
 * node's own edge fields, never independent state (plan 102 §3.3). A
 * dangling target (an edge field absent, or naming an id absent from the
 * document) is silently not drawn rather than thrown on — `checkWorkflow`
 * is the place that already flags that as a validation finding.
 */

export type GraphNodeKind = WorkflowNode['kind']

export interface GraphNode {
  id: string
  kind: GraphNodeKind
  label: string
  node: WorkflowNode
}

export interface GraphEdge {
  from: string
  to: string
  kind: EdgeKind
  /** True when `to` sorts at or before `from` in document (array) order — an edge may point backward (plan 102 G5), so the graph is not a DAG. */
  backward: boolean
}

export interface DerivedGraph {
  nodes: GraphNode[]
  edges: GraphEdge[]
  /** Node ids no edge targets, excluding `doc.entry` (the one `start` node). */
  unreachable: string[]
}

function labelOf(node: WorkflowNode): string {
  return node.title.trim() || node.id
}

export function deriveGraph(doc: WorkflowDoc): DerivedGraph {
  const nodes = doc.nodes
  const indexOf = new Map(nodes.map((n, i) => [n.id, i]))
  const graphNodes: GraphNode[] = nodes.map((n) => ({ id: n.id, kind: n.kind, label: labelOf(n), node: n }))
  const edges: GraphEdge[] = []

  nodes.forEach((node, index) => {
    for (const kind of edgeKindsOf(node)) {
      const to = edgeTargetOf(node, kind)
      if (to === undefined) continue
      const toIndex = indexOf.get(to)
      if (toIndex === undefined) continue // dangling — not this function's job to flag
      edges.push({ from: node.id, to, kind, backward: toIndex <= index })
    }
  })

  const targeted = new Set(edges.map((e) => e.to))
  const unreachable = nodes.filter((n) => n.id !== doc.entry && !targeted.has(n.id)).map((n) => n.id)

  return { nodes: graphNodes, edges, unreachable }
}
