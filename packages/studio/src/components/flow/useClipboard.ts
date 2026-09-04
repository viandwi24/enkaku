'use client'

import { useCallback, useRef } from 'react'
import type { WorkflowDoc, WorkflowNode } from '@enkaku/protocol'
import { applyDocEdit, edgeKindsOf, edgeTargetOf, freshNodeId, nodeIdsOf, setEdgeField, type EdgeKind } from './doc-edit'
import type { UseHistoryResult } from './useHistory'

/**
 * Plan 305 §3.4 (P4) — copy, cut, and paste, with id remapping. Copying
 * serialises the selected nodes plus the edges BETWEEN them into
 * `application/json` on the system clipboard under an
 * `enkaku/flow-nodes@1` envelope; pasting remaps every id, rewires the
 * internal edges to the new ids, drops edges pointing outside the
 * selection, and offsets positions by +24/+24. Pasting into a DIFFERENT
 * workflow works on purpose — it is how an author reuses a pattern.
 *
 * The `start` node is never copied: a document has exactly ONE (plan 301
 * §3.4, `WorkflowDocSchema`'s own invariant), so it is not a thing a
 * selection can duplicate — `serializeSelection` silently drops it from
 * whatever was selected, the same way `remove-nodes` silently refuses to
 * delete it.
 */

const CLIPBOARD_MIME = 'enkaku/flow-nodes@1'

export interface FlowClipboardPayload {
  v: typeof CLIPBOARD_MIME
  nodes: WorkflowNode[]
  edges: { from: string; kind: EdgeKind; to: string }[]
}

function serializeSelection(doc: WorkflowDoc, selectedIds: ReadonlySet<string>): FlowClipboardPayload | null {
  const nodes = doc.nodes.filter((n) => selectedIds.has(n.id) && n.kind !== 'start')
  if (nodes.length === 0) return null
  const ids = new Set(nodes.map((n) => n.id))
  const edges: FlowClipboardPayload['edges'] = []
  for (const n of nodes) {
    for (const kind of edgeKindsOf(n)) {
      const to = edgeTargetOf(n, kind)
      if (to !== undefined && ids.has(to)) edges.push({ from: n.id, kind, to })
    }
  }
  return { v: CLIPBOARD_MIME, nodes, edges }
}

/** Remaps every copied node's id against `existing`, rewires internal edges to the new ids, drops edges pointing outside the copied selection (already true of `serializeSelection`'s own output, kept here as the inverse's own guarantee), and offsets every position by +24/+24. */
function remapForPaste(payload: FlowClipboardPayload, existing: ReadonlySet<string>): { nodes: WorkflowNode[]; edges: { from: string; kind: EdgeKind; to: string }[] } {
  const idMap = new Map<string, string>()
  const taken = new Set(existing)
  for (const n of payload.nodes) {
    const id = freshNodeId(n.title || n.id, taken)
    taken.add(id)
    idMap.set(n.id, id)
  }
  // Every copied node's OWN edge fields are cleared here — `doc-edit.ts`'s
  // `paste` case is what re-wires them, from `edges` below, so a node never
  // arrives carrying a stale (un-remapped) target of its own.
  const nodes = payload.nodes.map((n) => {
    const id = idMap.get(n.id)!
    const ui = { x: n.ui.x + 24, y: n.ui.y + 24 }
    let cleared: WorkflowNode = { ...n, id, ui }
    for (const kind of edgeKindsOf(cleared)) cleared = setEdgeField(cleared, kind, undefined)
    return cleared
  })
  const edges = payload.edges
    .map((e) => {
      const from = idMap.get(e.from)
      const to = idMap.get(e.to)
      return from && to ? { from, kind: e.kind, to } : null
    })
    .filter((e): e is { from: string; kind: EdgeKind; to: string } => e !== null)
  return { nodes, edges }
}

export interface UseClipboardResult {
  copy(selectedIds: ReadonlySet<string>): void
  cut(selectedIds: ReadonlySet<string>): void
  paste(): void
  hasClipboard(): boolean
}

export function useClipboard(history: UseHistoryResult): UseClipboardResult {
  // A `navigator.clipboard` write can fail silently (permission, insecure
  // context) — an in-memory fallback is what makes copy/paste inside ONE
  // tab always work even when the browser clipboard is unavailable.
  const memory = useRef<FlowClipboardPayload | null>(null)

  const writeClipboard = useCallback((payload: FlowClipboardPayload) => {
    memory.current = payload
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(JSON.stringify(payload)).catch(() => {})
    }
  }, [])

  const copy = useCallback(
    (selectedIds: ReadonlySet<string>) => {
      const payload = serializeSelection(history.doc, selectedIds)
      if (payload) writeClipboard(payload)
    },
    [history.doc, writeClipboard],
  )

  const cut = useCallback(
    (selectedIds: ReadonlySet<string>) => {
      const payload = serializeSelection(history.doc, selectedIds)
      if (!payload) return
      writeClipboard(payload)
      history.dispatch({ t: 'remove-nodes', ids: payload.nodes.map((n) => n.id) })
    },
    [history, writeClipboard],
  )

  const paste = useCallback(() => {
    const payload = memory.current
    if (!payload) return
    const { nodes, edges } = remapForPaste(payload, nodeIdsOf(history.doc))
    if (nodes.length === 0) return
    history.dispatch({ t: 'paste', nodes, edges })
  }, [history])

  const hasClipboard = useCallback(() => memory.current !== null, [])

  return { copy, cut, paste, hasClipboard }
}

// Re-exported so `FlowEditor.tsx` can build a `move-nodes`-shaped duplicate
// (cmd+d) from the same reducer without a second code path.
export { applyDocEdit }
