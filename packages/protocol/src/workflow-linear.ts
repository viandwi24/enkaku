import type { WorkflowDoc, WorkflowNode } from './workflow'

/**
 * The Sequential Mode recogniser (plan 313 §3.3, S2).
 *
 * Sequential Mode is a LENS over an ordinary doc v2 graph, never a second
 * document format (S1): there is one executor, one checker, one run view and
 * one job snapshot, and the list editor writes the same documents the canvas
 * does. What makes that safe is that a document's *shape* is computed, here,
 * rather than claimed by a stored flag — `doc.ui.editor` says which editor to
 * OPEN, and this function says which editor CAN open it.
 *
 * The consequence that matters to an author: the switch is not one-way. Add a
 * gate on the canvas and Sequential Mode becomes unavailable and says why;
 * delete the gate and it comes back. A stored `mode: 'sequential'` could not
 * do that — it would go on asserting a shape the document no longer has,
 * which is exactly the drift plan 300 D1 removed from `nodes[]`.
 */

/** One row of the sequence, in run order. */
export interface LinearStep {
  node: WorkflowNode
  /**
   * The `delay` node that sits between the PREVIOUS step and this one and was
   * authored by the sequence editor's own "delay between actions" control —
   * `null` when the steps are adjacent. Held on the step it precedes so a
   * reorder moves the gap with the action.
   */
  delayBefore: WorkflowNode | null
}

export interface LinearView {
  /** The one `start` node. */
  start: WorkflowNode
  /** The actions, in the order they run. Never includes `start`, `finish`, or a gap `delay`. */
  steps: LinearStep[]
  /** The document's single `finish`, when it has one. */
  finish: WorkflowNode | null
  /**
   * The gap every pair of adjacent steps shares, in milliseconds, or `null`
   * when the gaps disagree or there are none. This is what the editor's one
   * "delay between each action" control binds to; disagreeing gaps mean the
   * control shows nothing rather than silently rewriting them.
   */
  uniformDelay: { minMs: number; maxMs: number } | null
}

/** Why a document cannot be shown as a list — phrased for an author, not a log. */
export type LinearRefusal =
  | { code: 'branches'; nodeId: string; message: string }
  | { code: 'joins'; nodeId: string; message: string }
  | { code: 'unreachable'; nodeId: string; message: string }
  | { code: 'multiple-finish'; nodeId: string; message: string }

export type LinearResult = { ok: true; view: LinearView } | { ok: false; refusal: LinearRefusal }

/** The successor a node in the canonical linear shape has, or `undefined` for a kind that cannot be in one. */
function linearNext(node: WorkflowNode): string | undefined | null {
  switch (node.kind) {
    case 'start':
    case 'script':
    case 'delay':
    case 'set':
      return node.next
    case 'shuffle':
      return node.next
    case 'finish':
      return null
    // A gate or a switch IS a branch — the thing a list cannot draw.
    default:
      return undefined
  }
}

/**
 * A `delay` node the sequence editor itself authored as the gap between two
 * actions: its `ms` is either a literal, or the exact `min + $random * span`
 * expression `gapExpr` below writes. A delay an author wrote by hand (any
 * other expression, or a bound value) is NOT a gap — it is an action in its
 * own right, and the editor shows it as its own row rather than folding it
 * into the global control it cannot faithfully represent.
 */
export function readGap(node: WorkflowNode): { minMs: number; maxMs: number } | null {
  if (node.kind !== 'delay') return null
  const ms = node.ms as Record<string, unknown>

  const range = ((): { minMs: number; maxMs: number } | null => {
    if ('const' in ms && typeof ms.const === 'number') return { minMs: ms.const, maxMs: ms.const }
    if ('expr' in ms && typeof ms.expr === 'string') {
      const match = /^(\d+) \+ \$random \* (\d+)$/.exec(ms.expr)
      if (!match) return null
      const min = Number(match[1])
      return { minMs: min, maxMs: min + Number(match[2]) }
    }
    return null
  })()
  if (range === null) return null

  // `maxMs` is the executor's own hard clamp, so a node whose ceiling
  // disagrees with its expression does NOT run the range the expression
  // describes — a `1000 + $random * 9000` with `maxMs: 3000` waits at most
  // three seconds. Reporting that as a 1–10 s gap would put a number on the
  // screen that the run does not honour, so it is not an editor-authored gap
  // at all: it stays its own row, where what it says is what it does.
  if (node.maxMs !== range.maxMs) return null
  return range
}

/** The `ms` expression a gap of `[minMs, maxMs]` is written as — the one form `readGap` reads back. */
export function gapExpr(minMs: number, maxMs: number): { const: number } | { expr: string } {
  if (maxMs <= minMs) return { const: minMs }
  return { expr: `${minMs} + $random * ${maxMs - minMs}` }
}

/**
 * Reads `doc` as an ordered list of actions, or explains why it cannot be one.
 *
 * The canonical linear shape (§3.3):
 *
 * 1. exactly one `start` (already a document invariant);
 * 2. every node has exactly one inbound edge, except `start`, which has none —
 *    a shuffle's members are exempt, since the shuffle owns them;
 * 3. the only outgoing edge used is `next`, except that a `script` node's
 *    `onFailure` may point at the document's single `finish`, or be absent;
 * 4. no `gate` and no `switch` anywhere;
 * 5. at most one `finish`, and it is terminal.
 */
export function readLinear(doc: WorkflowDoc): LinearResult {
  const byId = new Map(doc.nodes.map((n) => [n.id, n]))
  const start = doc.nodes.find((n) => n.kind === 'start')
  if (start === undefined) {
    return { ok: false, refusal: { code: 'unreachable', nodeId: doc.entry, message: 'this workflow has no start node' } }
  }

  const finishes = doc.nodes.filter((n) => n.kind === 'finish')
  if (finishes.length > 1) {
    return {
      ok: false,
      refusal: { code: 'multiple-finish', nodeId: finishes[1]?.id ?? '', message: 'this workflow ends in more than one place, so it is not a single sequence' },
    }
  }
  const finish = finishes[0] ?? null

  // Rule 4, checked over the WHOLE document rather than only the walked path,
  // so a branch parked off to one side is reported rather than silently
  // dropped when the list is written back.
  const branch = doc.nodes.find((n) => n.kind === 'gate' || n.kind === 'switch')
  if (branch !== undefined) {
    return {
      ok: false,
      refusal: { code: 'branches', nodeId: branch.id, message: `"${branch.title || branch.id}" is a ${branch.kind}, and a list cannot show a branch` },
    }
  }

  // Walk `next` from `start`. A node seen twice is a join or a loop; either
  // way the document is a graph, not a list.
  const ordered: WorkflowNode[] = []
  const seen = new Set<string>([start.id])
  let cursor = linearNext(start)
  while (cursor !== undefined && cursor !== null) {
    const node = byId.get(cursor)
    if (node === undefined) break
    if (seen.has(node.id)) {
      return { ok: false, refusal: { code: 'joins', nodeId: node.id, message: `"${node.title || node.id}" is reached more than once, so this is a loop rather than a sequence` } }
    }
    seen.add(node.id)
    if (node.kind === 'finish') break
    ordered.push(node)
    // Rule 3 — an `onFailure` is allowed only when it points at the finish.
    if (node.kind === 'script' && node.onFailure !== undefined && node.onFailure !== finish?.id) {
      return {
        ok: false,
        refusal: { code: 'branches', nodeId: node.id, message: `"${node.title || node.id}" has a failure branch that does not end the run, and a list cannot show it` },
      }
    }
    cursor = linearNext(node)
  }

  // Rule 2 — anything the walk did not reach. A shuffle's members are reached
  // BY the shuffle rather than by a `next` edge, so they are accounted for
  // here rather than treated as orphans.
  const ownedByShuffle = new Set<string>()
  for (const n of doc.nodes) {
    if (n.kind !== 'shuffle') continue
    for (const m of n.members) ownedByShuffle.add(m)
  }
  const orphan = doc.nodes.find((n) => !seen.has(n.id) && !ownedByShuffle.has(n.id))
  if (orphan !== undefined) {
    return { ok: false, refusal: { code: 'unreachable', nodeId: orphan.id, message: `"${orphan.title || orphan.id}" is not connected to the sequence` } }
  }

  // Fold the editor-authored gaps out of the run order and onto the step each
  // one precedes.
  const steps: LinearStep[] = []
  let pendingGap: WorkflowNode | null = null
  for (const node of ordered) {
    const gap = readGap(node)
    // A gap only counts as one BETWEEN two actions: a delay before the first
    // action, or two in a row, is an action in its own right.
    if (gap !== null && steps.length > 0 && pendingGap === null) {
      pendingGap = node
      continue
    }
    steps.push({ node, delayBefore: pendingGap })
    pendingGap = null
  }
  // A trailing gap has no step to belong to; it stays an action.
  if (pendingGap !== null) steps.push({ node: pendingGap, delayBefore: null })

  const gaps = steps.map((s) => (s.delayBefore ? readGap(s.delayBefore) : null)).filter((g): g is { minMs: number; maxMs: number } => g !== null)
  const uniformDelay = gaps.length > 0 && gaps.every((g) => g.minMs === gaps[0]?.minMs && g.maxMs === gaps[0]?.maxMs) ? (gaps[0] ?? null) : null

  return { ok: true, view: { start, steps, finish, uniformDelay } }
}

/** Whether Sequential Mode can open this document at all. */
export function isLinear(doc: WorkflowDoc): boolean {
  return readLinear(doc).ok
}
