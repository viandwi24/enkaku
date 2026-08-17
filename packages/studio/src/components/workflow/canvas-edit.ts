import type { GateOutcome } from '@enkaku/protocol'
import type { EdgeKind } from './derive-graph'
import { updateNode, type WorkflowDocDraft, type WorkflowNodeDraft } from './model'

/**
 * Plan 102 (M67) §3.3, §4.1, §4.2, step 102.5 — the exact inverse of
 * `derive-graph.ts`. That file turns `next`/`onFailure`/`then`/`else` INTO
 * edges for rendering; this one turns a canvas edge interaction BACK into
 * the same fields. There is still no `edges` array anywhere (G4) — an edit
 * here is always a patch to one node's own outcome field, through the SAME
 * `updateNode` the list editor's `NodeCard` already calls, never a write to
 * a second, independent structure.
 *
 * Pure, no React, no `@xyflow/react` value import (only its `Connection`
 * shape, structurally, as a parameter type) — testable the same way
 * `derive-graph.test.ts`/`compute-layout.test.ts` already are, without a
 * renderer or a simulated drag (plan 102 §4.1: "no component test ever has
 * to assert on graph maths" — the same reasoning extends to "or on drag
 * maths").
 */

/** True when `kind` is a field `node` actually carries — a script node has no `then`/`else`, a gate has no `next`/`onFailure` (`packages/protocol/src/workflow.ts`'s discriminated union). */
function ownsEdgeKind(node: WorkflowNodeDraft, kind: EdgeKind): boolean {
  return node.kind === 'script' ? kind === 'next' || kind === 'onFailure' : kind === 'then' || kind === 'else'
}

/**
 * Retargets one edge to `targetId` — dragging a connection from a node's
 * `next`/`onFailure`/`then`/`else` handle onto another node (§3.3, §4.2).
 * `next` is a bare node id; the other three kinds hold a `GateOutcome`, so
 * retargeting one always produces `{ go: 'goto', node: targetId }` — the
 * identical shape `GateOutcomeEditor`'s own "Jump to a node…" option
 * writes, so the canvas and the list can never disagree about what a
 * retarget MEANS, only about how it was drawn.
 *
 * `targetId` may name an EARLIER node — a backward `goto` (plan 102 G5).
 * Nothing here restricts direction, matching `WorkflowNodeIdSchema` itself,
 * which does not either; a cycle is a valid document, just one `Validate`
 * may warn about.
 *
 * A no-op (returns `draft` unchanged) when `nodeId` does not name a node in
 * this document, when that node does not own `kind` (defensive — the
 * canvas only ever renders a handle for a kind the node actually has), or
 * when `targetId` does not name a node in this document either — a
 * connection cannot complete onto anything the canvas did not itself
 * render as a node, so this is a belt-and-braces guard against a caller
 * bug, never a path a real drag can reach.
 */
export function retargetEdge(draft: WorkflowDocDraft, nodeId: string, kind: EdgeKind, targetId: string): WorkflowDocDraft {
  const index = draft.nodes.findIndex((n) => n.id === nodeId)
  if (index === -1) return draft
  const node = draft.nodes[index]!
  if (!ownsEdgeKind(node, kind)) return draft
  if (!draft.nodes.some((n) => n.id === targetId)) return draft

  if (kind === 'next') return updateNode(draft, index, { next: targetId })
  const outcome: GateOutcome = { go: 'goto', node: targetId }
  if (kind === 'onFailure') return updateNode(draft, index, { onFailure: outcome })
  if (kind === 'then') return updateNode(draft, index, { then: outcome })
  return updateNode(draft, index, { else: outcome }) // kind === 'else'
}

/**
 * Removes one edge — deleting it on the canvas (selecting it, then
 * Backspace/Delete). Each kind reverts to the SAME default
 * `model.ts`'s `newScriptNode`/`newGateNode` already give a freshly-added
 * node, so "delete the edge" and "never drew one" are byte-identical —
 * exactly the round-trip property plan 102 H3 asks for, extended to
 * deletion rather than only retargeting.
 */
export function clearEdge(draft: WorkflowDocDraft, nodeId: string, kind: EdgeKind): WorkflowDocDraft {
  const index = draft.nodes.findIndex((n) => n.id === nodeId)
  if (index === -1) return draft
  const node = draft.nodes[index]!
  if (!ownsEdgeKind(node, kind)) return draft

  if (kind === 'next') return updateNode(draft, index, { next: undefined })
  if (kind === 'onFailure') return updateNode(draft, index, { onFailure: { go: 'fail' } })
  if (kind === 'then') return updateNode(draft, index, { then: { go: 'continue' } })
  return updateNode(draft, index, { else: { go: 'stop' } }) // kind === 'else'
}

/** The bare shape of `@xyflow/react`'s `Connection` this module needs — spelled out structurally rather than imported as a value, so this file stays free of a React Flow runtime dependency (only `WorkflowCanvas.tsx` imports the library itself). */
export interface EdgeConnectionLike {
  source: string | null
  sourceHandle: string | null
  target: string | null
}

/** One canvas edge edit, source-agnostic: a retarget (`targetId` a real node id) or a deletion (`targetId: null`, `clearEdge`'s job). The one shape both `WorkflowCanvas`'s wiring and `WorkflowBuilder`'s `applyEdgeChange` call below share. */
export interface EdgeChange {
  nodeId: string
  kind: EdgeKind
  targetId: string | null
}

/** Applies one `EdgeChange` — the single entry point `WorkflowBuilder` calls, so it never has to decide for itself whether an edit is a retarget or a clear. */
export function applyEdgeChange(draft: WorkflowDocDraft, change: EdgeChange): WorkflowDocDraft {
  return change.targetId === null ? clearEdge(draft, change.nodeId, change.kind) : retargetEdge(draft, change.nodeId, change.kind, change.targetId)
}

const EDGE_KINDS: readonly EdgeKind[] = ['next', 'onFailure', 'then', 'else']

/**
 * Translates one library `Connection` (from `onConnect`/`onReconnect`) into
 * the `{nodeId, kind, targetId}` `applyEdgeChange` understands. `sourceHandle`
 * is always one of `EDGE_KINDS` — `WorkflowCanvas` gives every source
 * `Handle` exactly that id, so this needs no lookup table. `null` for
 * anything incomplete (a connection dragged and released over empty
 * canvas, never actually landing on a target).
 */
export function connectionToEdgeChange(connection: EdgeConnectionLike): EdgeChange | null {
  const { source, sourceHandle, target } = connection
  if (!source || !target || !sourceHandle) return null
  if (!(EDGE_KINDS as readonly string[]).includes(sourceHandle)) return null
  return { nodeId: source, kind: sourceHandle as EdgeKind, targetId: target }
}
