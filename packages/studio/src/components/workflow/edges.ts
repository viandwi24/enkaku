import type { WorkflowDocDraft, WorkflowNodeDraft } from './model'

/**
 * The branch rail's pure half (plan 99 §3.9, §4.11; rewritten for doc v2's
 * explicit edges by plan 301 §4.1, §5 step 301.6) — "array order is the
 * spine... any deviation is a stated edge." This computes, for one node, the
 * transitions worth drawing: only the ones that are NOT "the boring
 * default" (continue to the next row) — a rail that annotated every single
 * row identically would be noise, not a map. Every edge field is a bare node
 * id or absent (dangling) now (plan 300 D1) — there is no outcome enum left
 * to describe.
 */

export interface EdgeLabel {
  /** `'then' | 'else' | 'next' | 'onFailure'` — which outcome this describes. */
  kind: 'then' | 'else' | 'next' | 'onFailure'
  text: string
}

function titleOf(nodes: readonly WorkflowNodeDraft[], id: string): string {
  const node = nodes.find((n) => n.id === id)
  if (!node) return id
  return node.title.trim() ? `${node.title} (${id})` : id
}

/** One edge target in words (plan 99 §3.7, rewritten by plan 301 §4.1) — `undefined` means DANGLING, not wired yet. */
export function describeOutcome(target: string | undefined, nodes: readonly WorkflowNodeDraft[]): string {
  return target === undefined ? 'not wired yet' : `jump to ${titleOf(nodes, target)}`
}

/** The node immediately after `index` in array order — used only to decide whether an explicit `next` is worth calling out on the rail (a `next` equal to the array's own next node is the boring default and stays silent). Array order carries no CONTROL meaning any more (plan 300 D1); this is purely a display heuristic. */
function arrayNextId(nodes: readonly WorkflowNodeDraft[], index: number): string | undefined {
  return nodes[index + 1]?.id
}

/**
 * The rail's content for one row — empty for a `start`/`finish` node (no
 * branch to show) and for a script node that behaves exactly as its
 * position implies (an explicit `next` equal to the array's own next node,
 * and no `onFailure` wired at all). A gate ALWAYS produces two lines: its
 * whole reason for existing is the branch (plan 99 §3.7).
 */
export function edgeLabelsFor(nodes: readonly WorkflowNodeDraft[], index: number): EdgeLabel[] {
  const node = nodes[index]
  if (!node) return []
  const labels: EdgeLabel[] = []

  if (node.kind === 'gate') {
    labels.push({ kind: 'then', text: `then → ${describeOutcome(node.then, nodes)}` })
    labels.push({ kind: 'else', text: `else → ${describeOutcome(node.else, nodes)}` })
    return labels
  }

  if (node.kind !== 'script') return labels // 'start' / 'finish' — no branch to show

  if (node.next !== undefined && node.next !== arrayNextId(nodes, index)) {
    labels.push({ kind: 'next', text: `next → ${titleOf(nodes, node.next)}` })
  }
  if (node.onFailure !== undefined) {
    labels.push({ kind: 'onFailure', text: `on failure → ${describeOutcome(node.onFailure, nodes)}` })
  }
  return labels
}

/** True when ANY node in the document has a rail-worthy edge — lets the editor skip rendering an empty rail column entirely. */
export function hasAnyExplicitEdges(draft: WorkflowDocDraft): boolean {
  return draft.nodes.some((_, i) => edgeLabelsFor(draft.nodes, i).length > 0)
}
