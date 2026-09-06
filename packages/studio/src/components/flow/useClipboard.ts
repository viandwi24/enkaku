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
  /** Set only when the payload came from a WHOLE document (Export/Import): the node its `start` pointed at, so a paste can join it to the editor's own start. */
  docEntry?: string
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
/**
 * Rewrite `$nodes.<id>` references to follow the ids a paste just assigned.
 *
 * `remapForPaste` renamed the nodes and rewired the edges, and stopped there.
 * Every expression that named a node kept naming the OLD one — so a document
 * exported and imported back produced copies still bound to the originals,
 * and the checker refused it with "binds to node X's output, but X can only
 * run AFTER it (or never)". Six errors on the owner's own
 * `tiktok-random-order`, and the Save button is disabled while any error
 * stands: import worked, and nothing could be saved (owner, 2026-09-06).
 *
 * Only `expr` strings are touched. `$nodes.x` means nothing anywhere else, and
 * a `const` that happens to contain the text is a value, not a reference.
 *
 * One pass over each expression, never one pass per renamed id: sequential
 * replacement would let a → b followed by b → c rewrite the same reference
 * twice.
 */
const NODE_REF = /\$nodes\.([A-Za-z0-9_$-]+)/g

export function remapNodeRefs<T>(value: T, idMap: ReadonlyMap<string, string>): T {
  if (Array.isArray(value)) return value.map((v) => remapNodeRefs(v, idMap)) as unknown as T
  if (value === null || typeof value !== 'object') return value
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] =
      k === 'expr' && typeof v === 'string'
        ? v.replace(NODE_REF, (whole, id: string) => (idMap.has(id) ? `$nodes.${idMap.get(id)}` : whole))
        : remapNodeRefs(v, idMap)
  }
  return out as T
}

/**
 * The id a pasted node takes: its own, when that is free.
 *
 * This used to be `freshNodeId(n.title || n.id, taken)` — seeded from the
 * TITLE. Two things went wrong with that, and both only bite a node other
 * nodes refer to.
 *
 * It renamed every node on every paste, even into an empty canvas: importing
 * a workflow turned `pick` into `draw-one-unused`, because that is its title.
 * Keeping the id is both friendlier and the whole reason an import into a
 * blank editor now needs no reference rewriting at all.
 *
 * And the name it produced could not be referenced. `WorkflowNodeIdSchema`
 * allows hyphens and forbids `_`; the expression parser's identifier allows
 * `_` and forbids hyphens. The two grammars are disjoint on exactly that
 * character, so `$nodes.draw-one-unused` parses as `draw - one - unused` and
 * the document reports "bare identifier 'one' is only legal as a function
 * call" (owner's own `tiktok-random-order`, 2026-09-06).
 *
 * The collision suffix is digits, never `-2`, for the same reason.
 */
function pasteId(id: string, taken: ReadonlySet<string>): string {
  if (!taken.has(id)) return id
  for (let i = 2; i < 10_000; i++) {
    const candidate = `${id}${i}`
    if (!taken.has(candidate)) return candidate
  }
  return freshNodeId(id, taken)
}

function remapForPaste(payload: FlowClipboardPayload, existing: ReadonlySet<string>): { nodes: WorkflowNode[]; edges: { from: string; kind: EdgeKind; to: string }[]; idMap: ReadonlyMap<string, string> } {
  const idMap = new Map<string, string>()
  const taken = new Set(existing)
  for (const n of payload.nodes) {
    const id = pasteId(n.id, taken)
    taken.add(id)
    idMap.set(n.id, id)
  }
  // Every copied node's OWN edge fields are cleared here — `doc-edit.ts`'s
  // `paste` case is what re-wires them, from `edges` below, so a node never
  // arrives carrying a stale (un-remapped) target of its own.
  const nodes = payload.nodes.map((n) => {
    const id = idMap.get(n.id)!
    const ui = { x: n.ui.x + 24, y: n.ui.y + 24 }
    let cleared: WorkflowNode = { ...remapNodeRefs(n, idMap), id, ui }
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
  return { nodes, edges, idMap }
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
  /** Set only when the payload came from a WHOLE document: the node its `start` pointed at. */
  docEntry: z.string().optional(),
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
  const selection = serializeSelection(doc.data, new Set(doc.data.nodes.map((n) => n.id)))
  if (!selection) return null
  /*
    A whole document's `start` is deliberately not copied — an editor already
    has one. But dropping it silently dropped the only edge INTO the graph,
    so importing a workflow into a fresh editor produced a start that went
    nowhere and seven nodes reachable from nothing. Every one of them raised
    an error, and Save is disabled while any error stands: import succeeded
    and could never be saved (owner, 2026-09-06).

    Carrying the node that start pointed at is what lets `applyPayload` join
    the two back up.
  */
  const start = doc.data.nodes.find((n) => n.kind === 'start')
  const entry = start ? edgeTargetOf(start, edgeKindsOf(start)[0] ?? 'next') : undefined
  return entry === undefined ? selection : { ...selection, docEntry: entry }
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
      const { nodes, edges, idMap } = remapForPaste(payload, nodeIdsOf(history.doc))
      if (nodes.length === 0) return false
      /*
        A whole document arriving into an editor whose start goes nowhere is
        an import, and it should land connected. Without this the imported
        graph is reachable from nothing, every node raises an error, and Save
        stays disabled — the shape the owner met.

        Only when the start is FREE. A start already wired belongs to a
        document the operator is building, and repointing it would silently
        detach their own graph; there the payload lands beside it to be wired
        by hand, which is what pasting a selection has always meant.
      */
      const start = history.doc.nodes.find((n) => n.kind === 'start')
      const startKind = start ? (edgeKindsOf(start)[0] ?? 'next') : null
      const entry = payload.docEntry ? idMap.get(payload.docEntry) : undefined
      const joined =
        start && startKind && entry && edgeTargetOf(start, startKind) === undefined
          ? [...edges, { from: start.id, kind: startKind, to: entry }]
          : edges
      history.dispatch({ t: 'paste', nodes, edges: joined })
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
