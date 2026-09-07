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
/**
 * The `[min, max]` a `ValueExpr` plus a declared ceiling describes, or `null`
 * when it is not one this editor wrote (plan 313 §4.5).
 *
 * ONE definition, used for both places a range is stored: a `delay` node's
 * `ms`/`maxMs` and a `shuffle`'s `between`/`betweenMaxMs`. They were read by
 * two different pieces of code once, and the second one dropped the minimum —
 * a 5-10 s shuffle came back as 0-10 s the moment it was unwrapped.
 */
function readRange(value: unknown, ceilingMs: number): { minMs: number; maxMs: number } | null {
  const v = value as Record<string, unknown>
  const range = ((): { minMs: number; maxMs: number } | null => {
    if (v !== null && typeof v === 'object' && 'const' in v && typeof v.const === 'number') return { minMs: v.const, maxMs: v.const }
    if (v !== null && typeof v === 'object' && 'expr' in v && typeof v.expr === 'string') {
      const match = /^(\d+) \+ \$random \* (\d+)$/.exec(v.expr)
      if (!match) return null
      const min = Number(match[1])
      return { minMs: min, maxMs: min + Number(match[2]) }
    }
    return null
  })()
  if (range === null) return null

  // The ceiling is the executor's own hard clamp, so a value whose ceiling
  // disagrees with its expression does NOT run the range the expression
  // describes — `1000 + $random * 9000` under a 3000 ms ceiling waits at most
  // three seconds. Reporting that as a 1-10 s range would put a number on the
  // screen that the run does not honour.
  if (ceilingMs !== range.maxMs) return null
  return range
}

/**
 * The gap a `delay` node describes, when the sequence editor itself wrote it
 * — a literal, or the exact `min + $random * span` form `gapExpr` emits. A
 * delay an author wrote by hand (any other expression, or a bound value) is
 * NOT a gap: it is an action in its own right, and the editor shows it as its
 * own row rather than folding it into a global control it cannot faithfully
 * represent.
 */
export function readGap(node: WorkflowNode): { minMs: number; maxMs: number } | null {
  if (node.kind !== 'delay') return null
  return readRange(node.ms, node.maxMs)
}

/** The same, for a `shuffle`'s wait between members — so wrapping and unwrapping a sequence round-trips the author's range rather than half of it. */
export function readBetween(node: WorkflowNode): { minMs: number; maxMs: number } | null {
  if (node.kind !== 'shuffle') return null
  return readRange(node.between, node.betweenMaxMs)
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
 *    `onFailure` may point at the document's single `finish`, at whatever
 *    `next` points at (failure continues down the same line), or be absent;
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
    /*
      Rule 3 — an `onFailure` is allowed when it REJOINS the line it is on:
      either it ends the run (points at the finish), or it goes exactly where
      `next` already goes.

      That second case is not a branch at all — both edges land on the same
      node, so the drawing is still a straight line. It is also the single
      most common sequential shape there is: "if this action fails, carry on
      with the next one". The owner's own `tiktok-sequential` is written that
      way from end to end, and refusing it meant Sequential Mode rejected the
      one workflow most literally named for it (field report, 2026-09-07).
    */
    if (node.kind === 'script' && node.onFailure !== undefined && node.onFailure !== finish?.id && node.onFailure !== linearNext(node)) {
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

  const { steps, uniformDelay } = foldGaps(ordered)
  return { ok: true, view: { start, steps, finish, uniformDelay } }
}

/**
 * Fold the editor-authored gaps out of a run order and onto the step each one
 * precedes, and report the range they all share when they agree.
 *
 * Exported because Grouped Mode reads the same shape once per branch
 * (`workflow-groups.ts`) — the two lenses must agree about what counts as a
 * gap and what counts as an action, or the same `delay` node would be a row
 * in one editor and a number in the other.
 */
export function foldGaps(ordered: readonly WorkflowNode[]): { steps: LinearStep[]; uniformDelay: { minMs: number; maxMs: number } | null } {
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
  return { steps, uniformDelay }
}

/** Whether Sequential Mode can open this document at all. */
export function isLinear(doc: WorkflowDoc): boolean {
  return readLinear(doc).ok
}

/**
 * Given a linear view and the order its actions should end up in, the chain
 * of node ids to wire `start -> … -> finish` through, and the gap nodes that
 * no longer belong anywhere (plan 313 §4.5).
 *
 * Pure, and here rather than in the editor, following this repo's own
 * `promote.ts` precedent — "the pure half of that, no React, so it is
 * testable with no DOM". It is the part of the sequence editor most able to
 * lose an author's work, and Studio has no tests of its own, so this is where
 * that logic can actually be held to something.
 *
 * Two rules it exists to get right:
 *
 * - A gap belongs BETWEEN two actions, so the action now in first place
 *   loses the wait that used to precede it.
 * - A gap dropped that way must be reported as `stranded`, because a delay
 *   node left in the document with nothing pointing at it is an orphan, and
 *   an orphan makes `readLinear` refuse the document — which would eject the
 *   author from the editor by a reorder.
 */
export function planSequence(view: { steps: readonly LinearStep[] }, order: readonly WorkflowNode[]): { chain: string[]; stranded: string[] } {
  const gapOf = new Map(view.steps.map((s) => [s.node.id, s.delayBefore]))
  const chain: string[] = []
  order.forEach((node, i) => {
    const gap = gapOf.get(node.id)
    if (gap && i > 0) chain.push(gap.id)
    chain.push(node.id)
  })
  const inChain = new Set(chain)
  const stranded = view.steps
    .map((s) => s.delayBefore)
    .filter((d): d is WorkflowNode => d !== null && !inChain.has(d.id))
    .map((d) => d.id)
  return { chain, stranded }
}
