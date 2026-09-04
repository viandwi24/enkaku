import type { Predicate, WorkflowDoc, WorkflowNode, WorkflowPoint } from '@enkaku/protocol'

/**
 * Plan 305 §3.3, §4.2 — the ONE reducer every structural edit to the
 * document goes through. `applyDocEdit(doc, edit)` is pure: it never
 * touches React state, `@xyflow/react`, or the network — `useHistory.ts`
 * wraps it with undo/redo, `FlowEditor.tsx` is the only caller.
 *
 * A `DocEdit` is closed (plan 305 §4.2) so G4's own acceptance criterion
 * ("every mutation site, and no `setDraft(` that builds a document by
 * hand") is provable by reading this one file.
 */

/** Which field on a node carries an edge, and — for `switch` — which case. A `switch` case is addressed as `case:<index>`; every other kind owns a fixed field name. */
export type EdgeKind = 'next' | 'onFailure' | 'then' | 'else' | 'default' | `case:${number}`

export type DocEdit =
  | { t: 'add-node'; node: WorkflowNode; connectFrom?: { id: string; edge: EdgeKind } }
  | { t: 'insert-on-edge'; edge: { from: string; kind: EdgeKind }; node: WorkflowNode }
  | { t: 'remove-nodes'; ids: string[] }
  | { t: 'move-nodes'; positions: Record<string, WorkflowPoint> }
  | { t: 'set-edge'; from: string; kind: EdgeKind; to: string | undefined }
  | { t: 'update-node'; id: string; patch: Partial<WorkflowNode> }
  | { t: 'paste'; nodes: WorkflowNode[]; edges: { from: string; kind: EdgeKind; to: string }[] }
  | { t: 'auto-arrange' }
  /**
   * NOT in plan 305 §4.2's own `DocEdit` block — added because the document
   * needs a name/title/description/step-budget/params SOMEWHERE and nothing
   * else in the union can express it (there is no node to `update-node`
   * against). Recorded as a discrepancy in §11 rather than silently
   * expanding the union without a trace. Still goes through this ONE
   * reducer, so G4's "no `setDraft(` that builds a document by hand"
   * criterion holds.
   */
  | { t: 'set-meta'; patch: Partial<Pick<WorkflowDoc, 'name' | 'title' | 'description' | 'maxSteps' | 'params'>> }

/** The edge kinds a node actually owns — a `start`/`script`/`delay` node has `next` (script also `onFailure`), a `gate` has `then`/`else`, a `switch` has one `case:<i>` per declared case plus `default`, and `finish` is a sink with none. */
export function edgeKindsOf(node: WorkflowNode): EdgeKind[] {
  switch (node.kind) {
    case 'start':
    case 'delay':
      return ['next']
    case 'script':
      return ['next', 'onFailure']
    case 'gate':
      return ['then', 'else']
    case 'switch':
      return [...node.cases.map((_, i) => `case:${i}` as const), 'default']
    case 'finish':
      return []
  }
}

/** Reads the current target of one edge kind off a node, or `undefined` when it is not wired (or the node does not own that kind). */
export function edgeTargetOf(node: WorkflowNode, kind: EdgeKind): string | undefined {
  if (node.kind === 'switch') {
    if (kind === 'default') return node.default
    const m = /^case:(\d+)$/.exec(kind)
    if (!m) return undefined
    return node.cases[Number(m[1])]?.to
  }
  if (kind === 'next' && (node.kind === 'start' || node.kind === 'script' || node.kind === 'delay')) return node.next
  if (kind === 'onFailure' && node.kind === 'script') return node.onFailure
  if (kind === 'then' && node.kind === 'gate') return node.then
  if (kind === 'else' && node.kind === 'gate') return node.else
  return undefined
}

/** The exact inverse of `edgeTargetOf` — writes `to` into the field `kind` names, returning a NEW node (never mutating). A no-op (returns `node` unchanged) when the node does not own `kind`. */
export function setEdgeField(node: WorkflowNode, kind: EdgeKind, to: string | undefined): WorkflowNode {
  if (node.kind === 'switch') {
    if (kind === 'default') return { ...node, default: to }
    const m = /^case:(\d+)$/.exec(kind)
    if (!m) return node
    const i = Number(m[1])
    if (!node.cases[i]) return node
    const cases = node.cases.map((c, idx) => (idx === i ? { ...c, to } : c))
    return { ...node, cases }
  }
  if (kind === 'next' && (node.kind === 'start' || node.kind === 'script' || node.kind === 'delay')) return { ...node, next: to }
  if (kind === 'onFailure' && node.kind === 'script') return { ...node, onFailure: to }
  if (kind === 'then' && node.kind === 'gate') return { ...node, then: to }
  if (kind === 'else' && node.kind === 'gate') return { ...node, else: to }
  return node
}

function replaceNode(doc: WorkflowDoc, id: string, fn: (node: WorkflowNode) => WorkflowNode): WorkflowDoc {
  const index = doc.nodes.findIndex((n) => n.id === id)
  if (index === -1) return doc
  const nodes = doc.nodes.map((n, i) => (i === index ? fn(n) : n))
  return { ...doc, nodes }
}

/** A closed, trivially-true placeholder condition for a freshly-added gate/switch case (plan 99 §3.7) — `true == true`. */
export function placeholderPredicate(): Predicate {
  return { left: { const: true }, op: 'eq', right: { const: true } }
}

const SLUG_RE = /[^a-z0-9-]+/g

/** `Auto-Scroll the Feed!` → `auto-scroll-the-feed` — `WorkflowNodeIdSchema`'s grammar (lowercase, digits, hyphens, starting with one of the first two). */
function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(SLUG_RE, '')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug.length > 0 ? slug.slice(0, 48) : 'node'
}

/** A fresh, unique node id derived from a human-readable seed — never typed by the operator directly. Appends `-2`, `-3`, ... on collision. */
export function freshNodeId(seed: string, existing: ReadonlySet<string>): string {
  const base = slugify(seed)
  if (!existing.has(base)) return base
  for (let i = 2; i < 10_000; i++) {
    const candidate = `${base}-${i}`
    if (!existing.has(candidate)) return candidate
  }
  return `${base}-${crypto.randomUUID().slice(0, 8)}`
}

export function nodeIdsOf(doc: WorkflowDoc): Set<string> {
  return new Set(doc.nodes.map((n) => n.id))
}

/** Applies exactly one `DocEdit`, returning a NEW `WorkflowDoc` — never mutating `doc`. The one function every structural edit in the flow editor goes through (plan 305 §3.3, G4's own acceptance criterion). */
export function applyDocEdit(doc: WorkflowDoc, edit: DocEdit): WorkflowDoc {
  switch (edit.t) {
    case 'add-node': {
      let next: WorkflowDoc = { ...doc, nodes: [...doc.nodes, edit.node] }
      if (edit.connectFrom) {
        next = replaceNode(next, edit.connectFrom.id, (n) => setEdgeField(n, edit.connectFrom!.edge, edit.node.id))
      }
      return next
    }

    case 'insert-on-edge': {
      const fromNode = doc.nodes.find((n) => n.id === edit.edge.from)
      if (!fromNode) return doc
      const existingTarget = edgeTargetOf(fromNode, edit.edge.kind)
      let next: WorkflowDoc = { ...doc, nodes: [...doc.nodes, edit.node] }
      next = replaceNode(next, edit.edge.from, (n) => setEdgeField(n, edit.edge.kind, edit.node.id))
      if (existingTarget !== undefined) {
        // The new node inherits whatever the edge used to point at, on its own primary outgoing edge kind.
        const primary = edgeKindsOf(edit.node)[0]
        if (primary) next = replaceNode(next, edit.node.id, (n) => setEdgeField(n, primary, existingTarget))
      }
      return next
    }

    case 'remove-nodes': {
      const removing = new Set(edit.ids)
      // `start` is undeletable (plan 301 §3.4) — never removed even if named.
      const startId = doc.entry
      removing.delete(startId)
      if (removing.size === 0) return doc
      const nodes = doc.nodes
        .filter((n) => !removing.has(n.id))
        .map((n) => {
          let out = n
          for (const kind of edgeKindsOf(out)) {
            const target = edgeTargetOf(out, kind)
            if (target !== undefined && removing.has(target)) out = setEdgeField(out, kind, undefined)
          }
          return out
        })
      return { ...doc, nodes }
    }

    case 'move-nodes': {
      const nodes = doc.nodes.map((n) => {
        const p = edit.positions[n.id]
        return p ? { ...n, ui: p } : n
      })
      return { ...doc, nodes }
    }

    case 'set-edge':
      return replaceNode(doc, edit.from, (n) => setEdgeField(n, edit.kind, edit.to))

    case 'update-node':
      return replaceNode(doc, edit.id, (n) => ({ ...n, ...edit.patch }) as WorkflowNode)

    case 'paste': {
      const nodes = [...doc.nodes, ...edit.nodes]
      let next: WorkflowDoc = { ...doc, nodes }
      for (const e of edit.edges) {
        next = replaceNode(next, e.from, (n) => setEdgeField(n, e.kind, e.to))
      }
      return next
    }

    case 'set-meta':
      return { ...doc, ...edit.patch }

    case 'auto-arrange':
      // Applied by the caller (`layout.ts`'s `computeLayout` result folded
      // into a `move-nodes` edit) — this case exists so `auto-arrange` is
      // still ONE history entry (plan 305 §4.5's own acceptance criterion),
      // never so this reducer computes a layout itself.
      return doc
  }
}
