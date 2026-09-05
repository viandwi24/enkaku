'use client'

import { useCallback, useRef } from 'react'
import { WorkflowDocSchema, WorkflowNodeSchema, type WorkflowDoc, type WorkflowNode } from '@enkaku/protocol'
import { z } from 'zod'
import { edgeKindsOf, edgeTargetOf, freshNodeId, nodeIdsOf, setEdgeField, type EdgeKind } from './doc-edit'
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

/**
 * What a paste is allowed to contain, validated rather than trusted.
 *
 * The text comes off the SYSTEM clipboard, which means it came from anywhere
 * — a chat message, a text file, another app. CLAUDE.md's rule about
 * external input is the whole reason this schema exists instead of a cast:
 * the worst outcome of a malformed paste must be "nothing was pasted, and
 * here is why", never a canvas holding a node the rest of the editor cannot
 * reason about.
 */
const ClipboardEnvelopeSchema = z.object({
  v: z.literal(CLIPBOARD_MIME),
  nodes: z.array(WorkflowNodeSchema),
  edges: z.array(z.object({ from: z.string(), kind: z.string(), to: z.string() })),
})

/**
 * Read a payload out of arbitrary JSON text — either envelope.
 *
 * `enkaku/flow-nodes@1` is what `copy` writes: a few selected nodes. A whole
 * `WorkflowDoc` is what Export writes, and what one operator actually sends
 * another ("user 1 export, user 2 paste", owner 2026-09-05) — so a document
 * pastes too, as every node it holds except its `start`. One code path
 * either way: the same id remap, the same edge rewiring, the same offset.
 *
 * `null` means "this is not ours", and the caller says so rather than
 * pasting something it half-understood.
 */
export function payloadFromJson(text: string): FlowClipboardPayload | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  const envelope = ClipboardEnvelopeSchema.safeParse(parsed)
  if (envelope.success) return envelope.data as FlowClipboardPayload

  const doc = WorkflowDocSchema.safeParse(parsed)
  if (!doc.success) return null
  return serializeSelection(
    doc.data,
    new Set(doc.data.nodes.map((n) => n.id)),
  )
}

/** A whole document, ready to hand to a file download (Export). */
export function docToJson(doc: WorkflowDoc): string {
  return `${JSON.stringify(doc, null, 2)}\n`
}

export interface UseClipboardResult {
  copy(selectedIds: ReadonlySet<string>): void
  cut(selectedIds: ReadonlySet<string>): void
  /** Reads the system clipboard first, falling back to this tab's own memory. Resolves `false` when there was nothing this editor could use. */
  paste(): Promise<boolean>
  /** The same paste, from text the caller already has — the file import, and anywhere else a payload arrives without the clipboard. */
  pasteJson(text: string): boolean
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

  const applyPayload = useCallback(
    (payload: FlowClipboardPayload): boolean => {
      const { nodes, edges } = remapForPaste(payload, nodeIdsOf(history.doc))
      if (nodes.length === 0) return false
      history.dispatch({ t: 'paste', nodes, edges })
      return true
    },
    [history],
  )

  const pasteJson = useCallback((text: string): boolean => {
    const payload = payloadFromJson(text)
    return payload ? applyPayload(payload) : false
  }, [applyPayload])

  /*
   * The SYSTEM clipboard first, this tab's memory second.
   *
   * `copy` has always written the payload out to the system clipboard, and
   * `paste` has always read only `memory.current` — so copying in one tab and
   * pasting in another did nothing, and a graph someone sent you over chat
   * could not be pasted at all. The JSON was on the clipboard the whole time
   * and nothing ever read it back (owner, 2026-09-05).
   *
   * The read can fail for reasons that are not this editor's business
   * (permission refused, an insecure context, a browser that has no
   * `readText`), and the in-memory copy still works in every one of them, so
   * a failure here falls through rather than surfacing.
   */
  const paste = useCallback(async (): Promise<boolean> => {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.readText) {
      try {
        const text = await navigator.clipboard.readText()
        const payload = payloadFromJson(text)
        if (payload) return applyPayload(payload)
      } catch {
        // fall through to memory
      }
    }
    return memory.current ? applyPayload(memory.current) : false
  }, [applyPayload])

  const hasClipboard = useCallback(() => memory.current !== null, [])

  return { copy, cut, paste, pasteJson, hasClipboard }
}
