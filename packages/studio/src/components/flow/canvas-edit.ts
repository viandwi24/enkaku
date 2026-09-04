import type { EdgeKind } from './doc-edit'

/**
 * Plan 102 §3.3/§4.2, step 102.5 — translates a `@xyflow/react` `Connection`
 * (from `onConnect`/`onReconnect`) into the `{ from, kind, to }` shape
 * `doc-edit.ts`'s `set-edge` understands. Rewritten by plan 305 §4.1: the
 * actual EDIT is now `applyDocEdit(doc, { t: 'set-edge', ... })`, issued by
 * `FlowEditor.tsx` through `useHistory`, never a bespoke draft mutation —
 * this file's only remaining job is the pure translation, so it stays free
 * of both a React Flow runtime dependency (only `FlowCanvas.tsx` imports
 * the library itself) and of any document-mutation logic of its own.
 */

/** The bare shape of `@xyflow/react`'s `Connection` this module needs, spelled out structurally rather than imported as a value. */
export interface EdgeConnectionLike {
  source: string | null
  sourceHandle: string | null
  target: string | null
}

/** One canvas edge edit, source-agnostic: a retarget (`targetId` a real node id) or a deletion (`targetId: null`). */
export interface EdgeChange {
  nodeId: string
  kind: EdgeKind
  targetId: string | null
}

const EDGE_KIND_RE = /^(next|onFailure|then|else|default|case:\d+)$/

/**
 * Translates one library `Connection` (from `onConnect`/`onReconnect`) into
 * the `{nodeId, kind, targetId}` shape a caller turns into a `set-edge`
 * `DocEdit`. `sourceHandle` is always one `EdgeKind` string —
 * `FlowCanvas` gives every source `Handle` exactly that id. `null` for
 * anything incomplete (a connection dragged and released over empty
 * canvas, never actually landing on a target).
 */
export function connectionToEdgeChange(connection: EdgeConnectionLike): EdgeChange | null {
  const { source, sourceHandle, target } = connection
  if (!source || !target || !sourceHandle) return null
  if (!EDGE_KIND_RE.test(sourceHandle)) return null
  return { nodeId: source, kind: sourceHandle as EdgeKind, targetId: target }
}
