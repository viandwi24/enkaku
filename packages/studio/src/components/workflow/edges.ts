import type { GateOutcome } from '@enkaku/protocol'
import type { WorkflowDocDraft, WorkflowNodeDraft } from './model'

/**
 * The branch rail's pure half (plan 99 §3.9, §4.11) — "array order is the
 * spine... any deviation is a stated edge." This computes, for one node, the
 * transitions worth drawing: only the ones that are NOT "the boring
 * default" (continue to the next row, fail the workflow on error) — a rail
 * that annotated every single row identically would be noise, not a map.
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

/** One `GateOutcome` in words — the same vocabulary the job detail page's own verdict sentence uses (plan 99 §3.7). */
export function describeOutcome(outcome: GateOutcome, nodes: readonly WorkflowNodeDraft[]): string {
  switch (outcome.go) {
    case 'continue':
      return 'continue to the next node'
    case 'stop':
      return 'stop the workflow — success'
    case 'fail':
      return 'stop the workflow — failed'
    case 'goto':
      return `jump to ${titleOf(nodes, outcome.node)}`
  }
}

function isDefaultOnFailure(outcome: GateOutcome): boolean {
  return outcome.go === 'fail'
}

/** The node immediately after `index` in array order, or `undefined` at the end of the document. */
function arrayNextId(nodes: readonly WorkflowNodeDraft[], index: number): string | undefined {
  return nodes[index + 1]?.id
}

/**
 * The rail's content for one row — empty for a node that behaves exactly as
 * its position implies (a script node with no explicit `next`/`onFailure`
 * override). A gate ALWAYS produces two lines: its whole reason for existing
 * is the branch (plan 99 §3.7).
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

  if (node.next !== undefined && node.next !== arrayNextId(nodes, index)) {
    labels.push({ kind: 'next', text: `next → ${titleOf(nodes, node.next)}` })
  }
  if (!isDefaultOnFailure(node.onFailure)) {
    labels.push({ kind: 'onFailure', text: `on failure → ${describeOutcome(node.onFailure, nodes)}` })
  }
  return labels
}

/** True when ANY node in the document has a rail-worthy edge — lets the editor skip rendering an empty rail column entirely. */
export function hasAnyExplicitEdges(draft: WorkflowDocDraft): boolean {
  return draft.nodes.some((_, i) => edgeLabelsFor(draft.nodes, i).length > 0)
}
