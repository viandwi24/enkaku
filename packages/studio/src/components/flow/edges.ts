import type { WorkflowNode } from '@enkaku/protocol'
import { edgeTargetOf, type EdgeKind } from './doc-edit'

/**
 * Plain-language edge descriptions (plan 99 §3.9, §4.11; rewritten for doc
 * v2's explicit edges by plan 301 §4.1; re-typed against `@enkaku/protocol`
 * directly by plan 305 §4.1, since `model.ts`'s draft types are gone — the
 * canvas IS the document now, plan 305 §3.3). Kept for plan 306's node
 * panel, which needs the same "then → jump to X" / "not wired yet" wording
 * this file already worked out.
 */

export interface EdgeLabel {
  kind: EdgeKind
  text: string
}

function titleOf(nodes: readonly WorkflowNode[], id: string): string {
  const node = nodes.find((n) => n.id === id)
  if (!node) return id
  return node.title.trim() ? `${node.title} (${id})` : id
}

/** One edge target in words — `undefined` means DANGLING, not wired yet. */
export function describeOutcome(target: string | undefined, nodes: readonly WorkflowNode[]): string {
  return target === undefined ? 'not wired yet' : `jump to ${titleOf(nodes, target)}`
}

const KIND_LABEL: Record<string, string> = { next: 'next', onFailure: 'on failure', then: 'then', else: 'else', default: 'default' }

function labelForKind(kind: EdgeKind): string {
  if (kind in KIND_LABEL) return KIND_LABEL[kind]!
  const m = /^case:(\d+)$/.exec(kind)
  return m ? `case ${Number(m[1]) + 1}` : kind
}

/** Every edge a node owns, described in words — a `finish` node (no edges) yields an empty list. */
export function edgeLabelsFor(node: WorkflowNode, nodes: readonly WorkflowNode[]): EdgeLabel[] {
  const kinds: EdgeKind[] =
    node.kind === 'switch'
      ? [...node.cases.map((_, i) => `case:${i}` as const), 'default']
      : node.kind === 'gate'
        ? ['then', 'else']
        : node.kind === 'script'
          ? ['next', 'onFailure']
          : node.kind === 'start' || node.kind === 'delay'
            ? ['next']
            : []
  return kinds.map((kind) => ({ kind, text: `${labelForKind(kind)} → ${describeOutcome(edgeTargetOf(node, kind), nodes)}` }))
}
