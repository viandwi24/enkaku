import type { WorkflowDoc, WorkflowNode } from './workflow'
import { foldGaps, type LinearStep } from './workflow-linear'

/**
 * The Grouped Mode recogniser — Sequential Mode's second lens.
 *
 * The brief behind it: "20 devices, split 5 and 5 and 5 and 5, each share
 * doing different actions" (owner, 2026-09-07). The ENGINE has done that
 * since plan 301 — the owner's own `tiktok-four-way-split` runs it today as a
 * `switch` on `$run.index % 4`, one case per share. What nobody could do was
 * WRITE one without opening a canvas and typing that expression by hand.
 *
 * So, exactly like `readLinear`, this is a lens and not a format. A grouped
 * workflow is an ordinary v2 document:
 *
 *     start ─▶ switch ($run.index % G)
 *                ├ case 0 ─▶ ...share 0's actions... ─▶ finish
 *                ├ case 1 ─▶ ...share 1's actions... ─▶ finish
 *                └ case G-1 ─▶ ...                   ─▶ finish
 *
 * One executor, one checker, one run view — and the canvas can open it, edit
 * it, and hand it back. The shape is computed here rather than stored on the
 * document, so adding a gate on the canvas withdraws the mode and deleting it
 * restores it, the same non-one-way switch plan 313 §3.3 argued for.
 *
 * `$run.index` is the device's position in the batch, assigned at dispatch —
 * so "which phone lands in which share" is decided by the run's device order
 * (`order: 'random'` in the Run dialog), not by anything stored here. That is
 * why this file has nothing to say about staggering or shuffling devices:
 * those are pacing, and pacing already belongs to the batch.
 */

/** One share of the fleet, and the actions it runs. */
export interface GroupView {
  /** 0-based: this is the `$run.index % G == index` case. */
  index: number
  /** The case's own label, for the editor's section heading. Empty when the author never named it. */
  label: string
  /** The actions this share runs, in order — same rows, same gap folding, as a linear view. */
  steps: LinearStep[]
  /** The gap every adjacent pair in THIS share shares, or `null` when they disagree. */
  uniformDelay: { minMs: number; maxMs: number } | null
  /** The node the case points at — `undefined` for a share with no actions yet. */
  headId: string | undefined
}

export interface GroupedView {
  start: WorkflowNode
  /** The `switch` that does the splitting. */
  split: WorkflowNode
  /** How many shares the fleet is cut into — always `groups.length`. */
  groupCount: number
  groups: GroupView[]
  /**
   * The `delay` between `start` and the split, when there is one — "hold each
   * device a random moment before it begins", so twenty phones do not all
   * start on the same second. `null` when the split follows `start` directly.
   */
  stagger: { node: WorkflowNode; minMs: number; maxMs: number } | null
  /** Every `finish` the shares end at. Grouped documents may have one each, or one shared. */
  finishes: WorkflowNode[]
}

export type GroupedRefusal =
  | { code: 'not-grouped'; nodeId: string; message: string }
  | { code: 'branches'; nodeId: string; message: string }
  | { code: 'joins'; nodeId: string; message: string }
  | { code: 'unreachable'; nodeId: string; message: string }

export type GroupedResult = { ok: true; view: GroupedView } | { ok: false; refusal: GroupedRefusal }

/**
 * The one expression a group split is written as, and the only one read back.
 *
 * `%` over the batch position gives exact shares for any fleet size: with
 * G = 4, twenty devices land 5/5/5/5 and twenty-one land 6/5/5/5. Writing it
 * in one place is what lets the editor round-trip a document it did not
 * author, and stops a hand-typed variant from being silently adopted as a
 * group split it does not behave like.
 */
export function groupSplitExpr(groupCount: number): string {
  return `$run.index % ${groupCount}`
}

/**
 * The `[min, max]` a leading stagger delay describes.
 *
 * Two written forms are accepted, because two already exist in the wild: the
 * `min + $random * span` the sequence editor emits (`gapExpr`), and the
 * `floor($random * n)` an author writes by hand for a plain 0-to-n hold —
 * the owner's `tiktok-split-staggered` is the second kind. Refusing to read
 * the second would have meant the editor could not open a document the engine
 * runs correctly today.
 *
 * As everywhere else, the declared ceiling must agree with the expression: a
 * range the executor would clamp is not the range on screen, so it is not
 * reported as one.
 */
export function readStagger(node: WorkflowNode): { minMs: number; maxMs: number } | null {
  if (node.kind !== 'delay') return null
  const v = node.ms as Record<string, unknown>
  const range = ((): { minMs: number; maxMs: number } | null => {
    if (v !== null && typeof v === 'object' && 'const' in v && typeof v.const === 'number') return { minMs: v.const, maxMs: v.const }
    if (v === null || typeof v !== 'object' || typeof v.expr !== 'string') return null
    const spread = /^(\d+) \+ \$random \* (\d+)$/.exec(v.expr)
    if (spread) {
      const min = Number(spread[1])
      return { minMs: min, maxMs: min + Number(spread[2]) }
    }
    const fromZero = /^floor\(\$random \* (\d+)\)$/.exec(v.expr)
    if (fromZero) return { minMs: 0, maxMs: Number(fromZero[1]) }
    return null
  })()
  if (range === null || node.maxMs !== range.maxMs) return null
  return range
}

/**
 * The `cases` array a G-way split is written as — the one shape `readGrouped`
 * reads back, and the only place that shape is spelled out.
 *
 * The editor needs it in three places (creating a split, changing the group
 * count, renaming a group) and the reader needs to recognise it. Four
 * hand-rolled copies of the same predicate is exactly how a writer and its
 * reader stop agreeing, so both sides call this and a round-trip test holds
 * them together.
 *
 * Note every case is rebuilt whenever `groupCount` changes: the divisor is
 * part of each predicate, so going from three shares to four rewrites all of
 * them, not just the new one.
 */
export function groupSplitCases(
  groupCount: number,
  shares: readonly { to?: string | undefined; label?: string }[],
): { when: { left: { expr: string }; op: 'eq'; right: { const: number } }; to?: string; label: string }[] {
  return Array.from({ length: groupCount }, (_, i) => {
    const share = shares[i]
    return {
      when: { left: { expr: groupSplitExpr(groupCount) }, op: 'eq' as const, right: { const: i } },
      ...(share?.to === undefined ? {} : { to: share.to }),
      label: share?.label || `Group ${i + 1}`,
    }
  })
}

/** `true` when this case is exactly the `index`-th share of a `groupCount`-way split. */
function isShareCase(when: unknown, index: number, groupCount: number): boolean {
  if (when === null || typeof when !== 'object') return false
  const p = when as Record<string, unknown>
  if (p.op !== 'eq') return false
  const left = p.left as Record<string, unknown> | undefined
  const right = p.right as Record<string, unknown> | undefined
  if (!left || !right) return false
  if (typeof left.expr !== 'string' || left.expr !== groupSplitExpr(groupCount)) return false
  return typeof right === 'object' && 'const' in right && right.const === index
}

/** The successor a node in a share's chain has, or `undefined` for a kind that cannot be in one. */
function chainNext(node: WorkflowNode): string | undefined | null {
  switch (node.kind) {
    case 'start':
    case 'script':
    case 'delay':
    case 'set':
    case 'shuffle':
      return node.next
    case 'finish':
      return null
    default:
      // A gate or a nested switch is a branch inside a share, which is a graph
      // again — the thing neither lens can draw.
      return undefined
  }
}

/**
 * Reads `doc` as G shares of a fleet, or explains why it is not one.
 *
 * The recognised shape, checked in this order:
 *
 * 1. one `start`, and its `next` is a `switch`;
 * 2. that switch is in `predicate` mode, has no `default`, and its cases are
 *    exactly `$run.index % G == 0 … G-1` in order, where G is the case count;
 * 3. no other `gate` or `switch` anywhere — one split, not a tree;
 * 4. each case walks `next` only, ending at a `finish` or a dangling edge;
 * 5. a `script`'s `onFailure` may end the run or continue down its own share,
 *    the same two shapes `readLinear` allows;
 * 6. nothing is reached twice, and nothing is left unreachable.
 */
export function readGrouped(doc: WorkflowDoc): GroupedResult {
  const byId = new Map(doc.nodes.map((n) => [n.id, n]))
  const start = doc.nodes.find((n) => n.kind === 'start')
  if (start === undefined || start.kind !== 'start') {
    return { ok: false, refusal: { code: 'unreachable', nodeId: doc.entry, message: 'this workflow has no start node' } }
  }

  /*
    One `delay` is allowed between `start` and the split, and read as the
    per-device stagger rather than as an action. It is the shape the owner's
    `tiktok-split-staggered` already uses, and the one the brief asks for in
    words: "one device starts at second 1, another at second 20".
  */
  const afterStart = start.next === undefined ? undefined : byId.get(start.next)
  const staggerRange = afterStart === undefined ? null : readStagger(afterStart)
  const stagger = afterStart !== undefined && staggerRange !== null ? { node: afterStart, ...staggerRange } : null
  const splitId = stagger !== null && stagger.node.kind === 'delay' ? stagger.node.next : start.next
  const split = splitId === undefined ? undefined : byId.get(splitId)
  if (split === undefined || split.kind !== 'switch') {
    return { ok: false, refusal: { code: 'not-grouped', nodeId: start.id, message: 'this workflow does not split the fleet into groups' } }
  }
  if (split.mode !== 'predicate') {
    return { ok: false, refusal: { code: 'not-grouped', nodeId: split.id, message: `"${split.title || split.id}" draws its branch at random rather than splitting the fleet` } }
  }
  /*
    A `default` is allowed when it ends the run, and refused when it does work.

    With cases `0 … G-1` over `% G` the default is mathematically unreachable,
    so an author who writes one is being defensive, not describing behaviour —
    and the owner's own `tiktok-four-way-split` does exactly that
    (`default: 'failed'`). Refusing it would have made the editor demand that a
    correct document be rewritten to suit the lens, which is backwards: the
    lens exists to read the documents the engine already runs. A default that
    points at real work IS a fifth path, and that is a graph again.
  */
  const defaultTarget = split.default === undefined ? null : byId.get(split.default)
  if (split.default !== undefined && defaultTarget?.kind !== 'finish') {
    return {
      ok: false,
      refusal: { code: 'branches', nodeId: split.id, message: `"${split.title || split.id}" has a fallback branch that does more than end the run` },
    }
  }
  const groupCount = split.cases.length
  if (groupCount < 2) {
    return { ok: false, refusal: { code: 'not-grouped', nodeId: split.id, message: 'a group split needs at least two groups' } }
  }
  for (let i = 0; i < groupCount; i++) {
    if (!isShareCase(split.cases[i]?.when, i, groupCount)) {
      return {
        ok: false,
        refusal: { code: 'not-grouped', nodeId: split.id, message: `"${split.title || split.id}" branches on something other than an even split of the fleet` },
      }
    }
  }

  // Rule 3, over the WHOLE document rather than only the walked shares, so a
  // branch parked off to one side is reported rather than silently dropped.
  const otherBranch = doc.nodes.find((n) => (n.kind === 'gate' || n.kind === 'switch') && n.id !== split.id)
  if (otherBranch !== undefined) {
    return {
      ok: false,
      refusal: { code: 'branches', nodeId: otherBranch.id, message: `"${otherBranch.title || otherBranch.id}" is a ${otherBranch.kind}, and a group list cannot show a branch` },
    }
  }

  const seen = new Set<string>([start.id, split.id])
  if (stagger !== null) seen.add(stagger.node.id)
  if (defaultTarget != null) seen.add(defaultTarget.id)
  const finishes: WorkflowNode[] = []
  const groups: GroupView[] = []

  for (let i = 0; i < groupCount; i++) {
    const head = split.cases[i]?.to
    const ordered: WorkflowNode[] = []
    let cursor: string | undefined | null = head
    while (cursor !== undefined && cursor !== null) {
      const node: WorkflowNode | undefined = byId.get(cursor)
      if (node === undefined) break
      /*
        A `finish` is a sink, so every share is expected to arrive at the same
        one — that is the ordinary shape, not a join. Only a node that does
        WORK for two shares makes them dependent on each other, and that is
        what this refusal is about.
      */
      if (node.kind === 'finish') {
        if (!finishes.some((f) => f.id === node.id)) finishes.push(node)
        seen.add(node.id)
        break
      }
      if (seen.has(node.id)) {
        return {
          ok: false,
          refusal: { code: 'joins', nodeId: node.id, message: `"${node.title || node.id}" is reached by more than one group, so the shares are not independent` },
        }
      }
      seen.add(node.id)
      // A gate or a nested switch cannot be reached here: rule 3 above already
      // refused any branch other than the split itself, and the split is
      // already in `seen`, so meeting it again is reported as a join.
      const next: string | undefined | null = chainNext(node)
      ordered.push(node)
      // Rule 5 — the same two failure shapes a list can hold.
      if (node.kind === 'script' && node.onFailure !== undefined && node.onFailure !== node.next && !doc.nodes.some((f) => f.kind === 'finish' && f.id === node.onFailure)) {
        return {
          ok: false,
          refusal: { code: 'branches', nodeId: node.id, message: `"${node.title || node.id}" has a failure branch that neither ends the run nor continues its group` },
        }
      }
      cursor = next
    }
    const { steps, uniformDelay } = foldGaps(ordered)
    groups.push({ index: i, label: split.cases[i]?.label ?? '', steps, uniformDelay, headId: head })
  }

  // Rule 6 — anything no share reached. A shuffle's members are reached BY the
  // shuffle rather than by a `next` edge, so they are accounted for here.
  const ownedByShuffle = new Set<string>()
  for (const n of doc.nodes) {
    if (n.kind !== 'shuffle') continue
    for (const m of n.members) ownedByShuffle.add(m)
  }
  const orphan = doc.nodes.find((n) => !seen.has(n.id) && !ownedByShuffle.has(n.id))
  if (orphan !== undefined) {
    return { ok: false, refusal: { code: 'unreachable', nodeId: orphan.id, message: `"${orphan.title || orphan.id}" belongs to no group` } }
  }

  return { ok: true, view: { start, split, groupCount, groups, stagger, finishes } }
}

/** Whether the grouped editor can open this document — the companion to `canUseSequence`. */
export function canUseGroups(doc: WorkflowDoc): boolean {
  return readGrouped(doc).ok
}
